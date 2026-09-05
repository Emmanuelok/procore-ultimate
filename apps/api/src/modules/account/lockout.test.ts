import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { authSecurityEvents } from "@constructos/db";
import type { BuiltApp } from "../../app.js";
import { buildTestApp } from "../../test/helpers.js";

/**
 * How long a suite may take to boot its own embedded Postgres.
 *
 * `buildTestApp()` starts PGlite (WASM) and replays every migration from 0000,
 * which is seconds of CPU on an idle machine and a great deal more on a shared
 * one. Vitest's 30-second default hook timeout therefore fails these suites for
 * a reason that has nothing to do with the code under test — and a suite that
 * fails when the machine is busy teaches people to ignore red, which is the
 * expensive failure. The assertions are unaffected: a hook that is going to
 * succeed still succeeds, it is simply allowed to take longer.
 */
const HOOK_TIMEOUT_MS = 180_000;


/**
 * Lockout, through the real login route.
 *
 * Each scope gets its own app because the counters are derived from the trail
 * and every request in a test file arrives from the same address: an IP lock
 * armed by one test would be a hidden dependency for the next. The arithmetic
 * — thresholds, expiry, the sliding window — is tested as arithmetic in
 * password.test.ts; what is tested here is that the ROUTE applies it, and that
 * being locked out never reveals whether the account exists.
 */

const PASSWORD = "scaffold-tower-brick";
let counter = 0;

async function signUp(app: FastifyInstance) {
  counter += 1;
  const email = `lock${counter}-${Date.now()}@test.dev`;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: PASSWORD, name: `Lock User ${counter}`, companyName: `Lock Co ${counter}` },
  });
  expect(res.statusCode).toBe(201);
  return { email, userId: (res.json() as { user: { id: string } }).user.id };
}

const attempt = (app: FastifyInstance, email: string, password: string) =>
  app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });

describe("account lockout", () => {
  let built: BuiltApp;
  let app: FastifyInstance;

  beforeAll(async () => {
    built = await buildTestApp();
    app = built.app;
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await built.close();
  });

  it("locks at the fifth failure and then refuses even the correct password", async () => {
    const { email } = await signUp(app);
    for (let i = 0; i < 4; i += 1) {
      const res = await attempt(app, email, `wrong-password-${i}`);
      expect(res.statusCode, `attempt ${i + 1}`).toBe(401);
    }
    // the fifth failure is still answered as a failure — and arms the lock
    expect((await attempt(app, email, "wrong-password-5")).statusCode).toBe(401);

    const locked = await attempt(app, email, PASSWORD);
    expect(locked.statusCode).toBe(429);
    const body = locked.json() as {
      message: string;
      details: { retryAfterSeconds: number; scope: string };
    };
    expect(body.message).toContain("Too many failed sign-in attempts");
    expect(body.details.scope).toBe("account");
    expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
    // the message says nothing about the account it protects
    expect(body.message).not.toContain(email);

    const events = await app.db
      .select()
      .from(authSecurityEvents)
      .where(and(eq(authSecurityEvents.email, email), eq(authSecurityEvents.kind, "account_locked")));
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("blocked");
    expect(events[0]!.metadata).toMatchObject({ attempts: 5 });

    // a refusal by policy is recorded apart from a guess
    const blocked = await app.db
      .select()
      .from(authSecurityEvents)
      .where(
        and(
          eq(authSecurityEvents.email, email),
          eq(authSecurityEvents.kind, "login_blocked_locked"),
        ),
      );
    expect(blocked.length).toBeGreaterThanOrEqual(1);
  });

  it("answers a wrong password and an unknown address identically", async () => {
    const { email } = await signUp(app);
    const wrong = await attempt(app, email, "definitely-not-the-password");
    const nobody = await attempt(app, `nobody-${Date.now()}@test.dev`, "definitely-not-the-password");
    expect(wrong.statusCode).toBe(401);
    expect(nobody.statusCode).toBe(401);
    expect(wrong.body).toBe(nobody.body);
  });

  it("a successful sign-in clears the run of failures", async () => {
    const { email } = await signUp(app);
    for (let i = 0; i < 4; i += 1) {
      expect((await attempt(app, email, `wrong-${i}`)).statusCode).toBe(401);
    }
    expect((await attempt(app, email, PASSWORD)).statusCode).toBe(200);
    // four more failures must not tip a counter that was reset
    for (let i = 0; i < 4; i += 1) {
      expect((await attempt(app, email, `wrong-again-${i}`)).statusCode).toBe(401);
    }
    expect((await attempt(app, email, PASSWORD)).statusCode).toBe(200);
  });
});

describe("per-IP lockout", () => {
  let built: BuiltApp;
  let app: FastifyInstance;

  beforeAll(async () => {
    built = await buildTestApp();
    app = built.app;
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await built.close();
  });

  it("throttles an address spraying many accounts, even one it has never touched", async () => {
    const victim = await signUp(app);
    // Twenty failures (5 × the account threshold), each against a DIFFERENT
    // address, so no account counter is anywhere near its own limit.
    for (let i = 0; i < 20; i += 1) {
      const res = await attempt(app, `spray${i}-${Date.now()}@test.dev`, "one-common-password");
      expect(res.statusCode).toBe(401);
    }
    const blocked = await attempt(app, victim.email, PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect((blocked.json() as { details: { scope: string } }).details.scope).toBe("ip");

    // and the untouched account was never locked in its own right
    const accountLocks = await app.db
      .select()
      .from(authSecurityEvents)
      .where(
        and(
          eq(authSecurityEvents.email, victim.email),
          eq(authSecurityEvents.kind, "account_locked"),
        ),
      );
    expect(accountLocks).toHaveLength(0);
  });
});
