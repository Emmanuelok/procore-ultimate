import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { authSecurityEvents, authSessions, users } from "@constructos/db";
import bcrypt from "bcryptjs";
import type { BuiltApp } from "../../app.js";
import { buildTestApp } from "../../test/helpers.js";

/**
 * REGRESSION — POST /auth/mfa/login is the route the SPA calls, and it used to
 * go around every defence /auth/login has.
 *
 * The audit finding, in full: the handler ran `bcrypt.compare` and recorded a
 * `login_failure` row, and never called `guardLoginAttempt` or
 * `noteLoginFailure`. So an attacker could guess passwords against one address
 * indefinitely — no account lockout, no per-IP lockout, no doubling delay, no
 * `account_locked` event — while `/auth/login`, which no browser used, had all
 * of them. It also skipped `completeLogin`, so a sign-in through the SPA got
 * no transparent bcrypt rehash, no new-device message and no `newDevice`
 * metadata in the trail.
 *
 * Every test below fails against the old handler.
 */

const PASSWORD = "scaffold-tower-brick";
let counter = 0;

async function signUp(app: FastifyInstance): Promise<{ email: string; userId: string }> {
  counter += 1;
  const email = `mfalock${counter}-${Date.now()}@test.dev`;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email,
      password: PASSWORD,
      name: `MFA Lock ${counter}`,
      companyName: `MFA Lock Co ${counter}`,
    },
  });
  expect(res.statusCode).toBe(201);
  return { email, userId: (res.json() as { user: { id: string } }).user.id };
}

const attempt = (app: FastifyInstance, email: string, password: string) =>
  app.inject({ method: "POST", url: "/api/v1/auth/mfa/login", payload: { email, password } });

describe("POST /auth/mfa/login obeys the lockout engine", () => {
  let built: BuiltApp;
  let app: FastifyInstance;

  beforeAll(async () => {
    built = await buildTestApp();
    app = built.app;
  });
  afterAll(async () => {
    await built.close();
  });

  it("locks the account at the fifth failure and then refuses the CORRECT password", async () => {
    const { email } = await signUp(app);
    for (let i = 0; i < 5; i += 1) {
      expect((await attempt(app, email, `wrong-${i}`)).statusCode, `attempt ${i + 1}`).toBe(401);
    }
    const locked = await attempt(app, email, PASSWORD);
    expect(locked.statusCode).toBe(429);
    const body = locked.json() as {
      message: string;
      details: { retryAfterSeconds: number; scope: string };
    };
    expect(body.message).toContain("Too many failed sign-in attempts");
    expect(body.details.scope).toBe("account");
    // The refusal names no account — a locked address and a locked unknown
    // address answer identically.
    expect(body.message).not.toContain(email);
  });

  it("writes account_locked, and keeps a policy refusal apart from a guess", async () => {
    const { email } = await signUp(app);
    for (let i = 0; i < 5; i += 1) await attempt(app, email, `wrong-${i}`);
    await attempt(app, email, PASSWORD);

    const locked = await app.db
      .select()
      .from(authSecurityEvents)
      .where(
        and(eq(authSecurityEvents.email, email), eq(authSecurityEvents.kind, "account_locked")),
      );
    expect(locked).toHaveLength(1);
    expect(locked[0]!.outcome).toBe("blocked");
    expect(locked[0]!.metadata).toMatchObject({ attempts: 5 });

    const blocked = await app.db
      .select()
      .from(authSecurityEvents)
      .where(
        and(
          eq(authSecurityEvents.email, email),
          eq(authSecurityEvents.kind, "login_blocked_locked"),
        ),
      );
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0]!.outcome).toBe("blocked");
  });

  it("an unknown address is locked out exactly like a known one", async () => {
    const unknown = `nobody-${Date.now()}@test.dev`;
    for (let i = 0; i < 5; i += 1) {
      expect((await attempt(app, unknown, `wrong-${i}`)).statusCode).toBe(401);
    }
    const locked = await attempt(app, unknown, "anything-at-all");
    expect(locked.statusCode).toBe(429);
  });

  it("honours the tenant's own lockout threshold", async () => {
    const { email } = await signUp(app);
    // Sign in to read the company id, then tighten the policy to three.
    const login = await attempt(app, email, PASSWORD);
    expect(login.statusCode).toBe(200);
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${(login.json() as { accessToken: string }).accessToken}` },
    });
    const companyId = (me.json() as { companies: Array<{ companyId: string }> }).companies[0]!
      .companyId;
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: {
        authorization: `Bearer ${(login.json() as { accessToken: string }).accessToken}`,
        "x-company-id": companyId,
      },
      payload: { lockoutMaxAttempts: 3 },
    });
    expect(put.statusCode).toBe(200);

    for (let i = 0; i < 3; i += 1) {
      expect((await attempt(app, email, `bad-${i}`)).statusCode).toBe(401);
    }
    // Three, not five: the tenant said so.
    expect((await attempt(app, email, PASSWORD)).statusCode).toBe(429);
  });
});

describe("POST /auth/mfa/login runs completeLogin", () => {
  let built: BuiltApp;
  let app: FastifyInstance;

  beforeAll(async () => {
    built = await buildTestApp();
    app = built.app;
  });
  afterAll(async () => {
    await built.close();
  });

  it("upgrades a stale bcrypt hash on a correct sign-in", async () => {
    const { email, userId } = await signUp(app);
    // Rewrite the stored hash at an obsolete work factor, as an account
    // created years ago would carry.
    await app.db
      .update(users)
      .set({ passwordHash: await bcrypt.hash(PASSWORD, 6) })
      .where(eq(users.id, userId));

    const res = await attempt(app, email, PASSWORD);
    expect(res.statusCode).toBe(200);
    const [row] = await app.db.select().from(users).where(eq(users.id, userId));
    expect(bcrypt.getRounds(row!.passwordHash)).toBeGreaterThan(6);
  });

  it("records the sign-in with newDevice metadata and opens a session row", async () => {
    const { email, userId } = await signUp(app);
    const res = await attempt(app, email, PASSWORD);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessionId: string; session: { id: string } };
    expect(body.session.id).toBe(body.sessionId);

    const [session] = await app.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, body.sessionId));
    expect(session?.userId).toBe(userId);
    expect(session?.authMethod).toBe("password");

    const successes = await app.db
      .select()
      .from(authSecurityEvents)
      .where(
        and(
          eq(authSecurityEvents.userId, userId),
          eq(authSecurityEvents.kind, "login_success"),
          eq(authSecurityEvents.outcome, "success"),
        ),
      );
    expect(successes.length).toBeGreaterThan(0);
    expect(successes.some((e) => "newDevice" in (e.metadata as Record<string, unknown>))).toBe(true);
  });

  it("refuses a deactivated account and records it as blocked, not as a guess", async () => {
    const { email, userId } = await signUp(app);
    await app.db.update(users).set({ isActive: false }).where(eq(users.id, userId));
    const res = await attempt(app, email, PASSWORD);
    expect(res.statusCode).toBe(401);
    const rows = await app.db
      .select()
      .from(authSecurityEvents)
      .where(
        and(
          eq(authSecurityEvents.userId, userId),
          eq(authSecurityEvents.kind, "login_blocked_inactive"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("blocked");
  });
});
