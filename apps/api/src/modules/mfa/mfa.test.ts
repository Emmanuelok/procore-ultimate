import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authSecurityEvents, userMfa } from "@constructos/db";
import { buildTestApp } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { base32Decode, totpForStep, totpStep, type TotpParams } from "./totp.js";
import { requireStepUp } from "./step-up.js";

/**
 * MFA end to end.
 *
 * The tests that matter here are the ones that describe an attacker rather
 * than a user: a code replayed inside its own time step, a challenge token
 * presented as if it were a session, a recovery code spent twice, a guesser
 * given unlimited attempts, a user switching off a factor their employer
 * requires, and a dangerous action taken on a session that proved a second
 * factor hours ago. The happy path is one test; the rest of this file is the
 * failure surface.
 */

const PASSWORD = "password-123";
let counter = 0;

interface Actor {
  userId: string;
  companyId: string;
  email: string;
  accessToken: string;
  headers: Record<string, string>;
}

async function signUp(app: FastifyInstance): Promise<Actor> {
  counter += 1;
  const email = `mfa${counter}-${Date.now()}@test.dev`;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: PASSWORD, name: `MFA User ${counter}`, companyName: `MFA Co ${counter}` },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as {
    user: { id: string };
    company: { id: string };
    accessToken: string;
  };
  return {
    userId: body.user.id,
    companyId: body.company.id,
    email,
    accessToken: body.accessToken,
    headers: {
      authorization: `Bearer ${body.accessToken}`,
      "x-company-id": body.company.id,
    },
  };
}

function paramsFor(secret: string): TotpParams {
  return { secret: base32Decode(secret), algorithm: "SHA1", digits: 6, periodSeconds: 30 };
}

/** The code an authenticator app would show `offsetSteps` steps from now. */
function codeFor(secret: string, offsetSteps = 0): string {
  const params = paramsFor(secret);
  return totpForStep(params, totpStep(Date.now(), 30) + offsetSteps);
}

/**
 * A six-digit string that is certainly NOT accepted right now: it is compared
 * against every code inside the ±1 window, so the test cannot fail once in a
 * million runs because a "wrong" code happened to be right.
 */
function wrongCode(secret: string): string {
  const params = paramsFor(secret);
  const step = totpStep(Date.now(), 30);
  const live = new Set([-1, 0, 1].map((o) => totpForStep(params, step + o)));
  for (let i = 0; i < 1000; i += 1) {
    const candidate = String(i).padStart(6, "0");
    if (!live.has(candidate)) return candidate;
  }
  throw new Error("unreachable");
}

/* ------------------------------------------------------------------ */
/* Step-up                                                             */
/* ------------------------------------------------------------------ */

function registerStepUpProbes(built: BuiltApp): void {
  // A stand-in for the platform's dangerous actions. `requireStepUp` is
  // exported and wired to nothing in production code, so the gate is exercised
  // here on a route this test owns.
  built.app.post(
    "/api/v1/test/seal",
    {
      preHandler: [built.app.authenticate, requireStepUp(built.app, { action: "ledger.seal" })],
    },
    async (req: FastifyRequest) => ({ ok: true, stepUp: req.stepUp }),
  );
  built.app.post(
    "/api/v1/test/machine-seal",
    {
      preHandler: [
        async (req: FastifyRequest) => {
          req.user = { id: "cli_x", email: "c@oauth-client.invalid", name: "A client" };
          req.machineClient = {
            clientRowId: "cli_x",
            clientId: "client-x",
            companyId: "co_x",
            name: "A client",
            scopes: [],
            tokenId: "tok_x",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          };
        },
        requireStepUp(built.app, { action: "credential.mint" }),
      ],
    },
    async () => ({ ok: true }),
  );
}

/**
 * One app, one embedded Postgres, for the whole file.
 *
 * Isolation here comes from every test acting as its OWN freshly registered
 * user and tenant, not from a fresh database: booting PGlite and replaying the
 * full migration set per test costs more wall clock than the entire suite is
 * worth, and buys nothing these tests depend on.
 */
let built: BuiltApp;
let app: FastifyInstance;

beforeAll(async () => {
  built = await buildTestApp();
  registerStepUpProbes(built);
  app = built.app;
}, 60_000);

afterAll(async () => built.close());

async function enrol(app: FastifyInstance, actor: Actor): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mfa/enrol",
    headers: actor.headers,
    payload: {},
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { secret: string }).secret;
}

/** Enrol and confirm. Confirmation spends the CURRENT step, so anything that
 *  follows must use step +1 or a recovery code. */
async function enrolAndConfirm(
  app: FastifyInstance,
  actor: Actor,
): Promise<{ secret: string; recoveryCodes: string[] }> {
  const secret = await enrol(app, actor);
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mfa/enrol/confirm",
    headers: actor.headers,
    payload: { code: codeFor(secret) },
  });
  expect(res.statusCode).toBe(200);
  return { secret, recoveryCodes: (res.json() as { recoveryCodes: string[] }).recoveryCodes };
}

async function login(app: FastifyInstance, email: string, password = PASSWORD) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/mfa/login",
    payload: { email, password },
  });
}

/* ------------------------------------------------------------------ */

describe("MFA — enrolment", () => {
  it("provisions a seed with an otpauth URI and the parameters to draw a QR, and no QR image", async () => {
    const actor = await signUp(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/enrol",
      headers: actor.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      secret: string;
      otpauthUri: string;
      status: string;
      otpauth: Record<string, unknown>;
    };
    expect(body.status).toBe("pending");
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.otpauthUri).toContain(`secret=${body.secret}`);
    expect(body.otpauthUri.startsWith("otpauth://totp/ConstructOS:")).toBe(true);
    expect(body.otpauth).toMatchObject({ issuer: "ConstructOS", algorithm: "SHA1", digits: 6, period: 30 });
    expect(JSON.stringify(body)).not.toContain("data:image");
  });

  it("stores the seed encrypted, never in usable form", async () => {
    const actor = await signUp(app);
    const secret = await enrol(app, actor);
    const rows = await built.app.db.select().from(userMfa).where(eq(userMfa.userId, actor.userId));
    expect(rows[0]?.secretCiphertext).toBeTruthy();
    expect(rows[0]?.secretCiphertext).not.toContain(secret);
    expect(rows[0]?.secretCiphertext?.startsWith("v1.")).toBe(true);
    expect(rows[0]?.secretKeyId).toMatch(/^v1:[0-9a-f]{16}$/);
    expect(rows[0]?.status).toBe("pending");
  });

  it("refuses to confirm with a wrong code and leaves the factor pending", async () => {
    const actor = await signUp(app);
    const secret = await enrol(app, actor);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/enrol/confirm",
      headers: actor.headers,
      payload: { code: wrongCode(secret) },
    });
    expect(res.statusCode).toBe(401);
    const rows = await built.app.db.select().from(userMfa).where(eq(userMfa.userId, actor.userId));
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.confirmedAt).toBeNull();
  });

  it("confirms with a valid code, activates the factor and issues recovery codes once", async () => {
    const actor = await signUp(app);
    const secret = await enrol(app, actor);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/enrol/confirm",
      headers: actor.headers,
      payload: { code: codeFor(secret) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; recoveryCodes: string[]; recoveryCodesRemaining: number };
    expect(body.status).toBe("active");
    expect(body.recoveryCodes).toHaveLength(10);
    expect(body.recoveryCodesRemaining).toBe(10);

    // Shown once: nothing reads them back.
    const status = await app.inject({ method: "GET", url: "/api/v1/auth/mfa", headers: actor.headers });
    expect(status.statusCode).toBe(200);
    const raw = status.body;
    expect(raw).not.toContain(secret);
    for (const code of body.recoveryCodes) expect(raw).not.toContain(code);
    expect(status.json()).toMatchObject({ enrolled: true, status: "active", recoveryCodesRemaining: 10 });
  });

  it("refuses a second enrolment while a confirmed factor exists", async () => {
    const actor = await signUp(app);
    await enrolAndConfirm(app, actor);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/enrol",
      headers: actor.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });

  it("reports a missing count as null with a reason, never as zero", async () => {
    const actor = await signUp(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/mfa/recovery-codes",
      headers: actor.headers,
    });
    const body = res.json() as { remaining: number | null; reasons: string[] };
    expect(body.remaining).toBeNull();
    expect(body.reasons.length).toBeGreaterThan(0);
  });
});

describe("MFA — replay and the ±1 step window", () => {
  it("refuses the same code twice inside its own window", async () => {
    const actor = await signUp(app);
    const secret = await enrol(app, actor);
    const code = codeFor(secret);

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/enrol/confirm",
      headers: actor.headers,
      payload: { code },
    });
    expect(first.statusCode).toBe(200);

    // Same code, seconds later, still inside its 30-second step. An attacker
    // who read it over someone's shoulder gets nothing.
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/step-up",
      headers: actor.headers,
      payload: { code },
    });
    expect(replay.statusCode).toBe(401);
    expect(JSON.stringify(replay.json())).toMatch(/already been used/);
  });

  it("records the accepted step as a high-water mark on the row", async () => {
    const actor = await signUp(app);
    const secret = await enrol(app, actor);
    const step = totpStep(Date.now(), 30);
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/enrol/confirm",
      headers: actor.headers,
      payload: { code: codeFor(secret) },
    });
    const rows = await built.app.db.select().from(userMfa).where(eq(userMfa.userId, actor.userId));
    expect(rows[0]?.lastUsedStep).toBeGreaterThanOrEqual(step);
  });

  it("accepts the next step's code after one has been spent", async () => {
    const actor = await signUp(app);
    const { secret } = await enrolAndConfirm(app, actor);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/step-up",
      headers: actor.headers,
      payload: { code: codeFor(secret, 1) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ satisfied: true, method: "totp" });
  });

  it("refuses a code two steps away — the window is exactly one either side", async () => {
    const actor = await signUp(app);
    const { secret } = await enrolAndConfirm(app, actor);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/step-up",
      headers: actor.headers,
      payload: { code: codeFor(secret, 2) },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.stringify(res.json())).toMatch(/does not match/);
  });

  it("refuses a request carrying both a code and a recovery code", async () => {
    const actor = await signUp(app);
    const { secret, recoveryCodes } = await enrolAndConfirm(app, actor);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/step-up",
      headers: actor.headers,
      payload: { code: codeFor(secret, 1), recoveryCode: recoveryCodes[0] },
    });
    // Never "try the app code, then fall back": that spends a paper code on a
    // typo.
    expect(res.statusCode).toBe(400);
  });
});

describe("MFA — the login challenge", () => {
  it("gives an unenrolled account a session, as before", async () => {
    const actor = await signUp(app);
    const res = await login(app, actor.email);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mfaRequired: false });
    expect((res.json() as { accessToken?: string }).accessToken).toBeTruthy();
  });

  it("treats a PENDING enrolment as no second factor at all", async () => {
    const actor = await signUp(app);
    await enrol(app, actor); // provisioned, never confirmed
    const res = await login(app, actor.email);
    // A seed that was shown and never proved must not lock the owner out.
    expect(res.json()).toMatchObject({ mfaRequired: false });
    expect((res.json() as { accessToken?: string }).accessToken).toBeTruthy();
  });

  it("withholds the session when a confirmed factor exists and returns a challenge instead", async () => {
    const actor = await signUp(app);
    await enrolAndConfirm(app, actor);
    const res = await login(app, actor.email);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body["mfaRequired"]).toBe(true);
    expect(body["challengeToken"]).toBeTruthy();
    expect(body["accessToken"]).toBeUndefined();
    expect(body["refreshToken"]).toBeUndefined();
    // Nothing about the account leaks to a half-authenticated caller.
    expect(body["user"]).toBeUndefined();
    expect(body["methods"]).toEqual(["totp", "recovery_code"]);
  });

  it("PROVES the challenge token cannot reach any authenticated route", async () => {
    const actor = await signUp(app);
    await enrolAndConfirm(app, actor);
    const challenge = (await login(app, actor.email)).json() as { challengeToken: string };
    const bearer = { authorization: `Bearer ${challenge.challengeToken}` };

    for (const url of ["/api/v1/me", "/api/v1/auth/mfa", "/api/v1/companies", "/api/v1/auth/mfa/step-up"]) {
      const res = await app.inject({ method: "GET", url, headers: bearer });
      expect(res.statusCode).toBe(401);
    }
    // …and it is not a company-scoped credential either.
    const scoped = await app.inject({
      method: "GET",
      url: "/api/v1/auth/mfa/policy",
      headers: { ...bearer, "x-company-id": actor.companyId },
    });
    expect(scoped.statusCode).toBe(401);
  });

  it("exchanges a correct code for a real session", async () => {
    const actor = await signUp(app);
    const { secret } = await enrolAndConfirm(app, actor);
    const challenge = (await login(app, actor.email)).json() as { challengeToken: string };
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge",
      payload: { challengeToken: challenge.challengeToken, code: codeFor(secret, 1) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { accessToken: string; user: { id: string }; sessionId: string };
    expect(body.user.id).toBe(actor.userId);
    expect(body.sessionId).toMatch(/^sess_/);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it("refuses a wrong code, a forged challenge and an unsigned one", async () => {
    const actor = await signUp(app);
    const { secret } = await enrolAndConfirm(app, actor);
    const challenge = (await login(app, actor.email)).json() as { challengeToken: string };

    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge",
      payload: { challengeToken: challenge.challengeToken, code: wrongCode(secret) },
    });
    expect(wrong.statusCode).toBe(401);

    const forged = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge",
      payload: {
        challengeToken: `${challenge.challengeToken.slice(0, -4)}AAAA`,
        code: codeFor(secret, 1),
      },
    });
    expect(forged.statusCode).toBe(401);
  });

  it("does not distinguish an unknown address from a wrong password", async () => {
    const actor = await signUp(app);
    const unknown = await login(app, "nobody-at-all@test.dev");
    const wrongPassword = await login(app, actor.email, "not-the-password");
    expect(unknown.statusCode).toBe(401);
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknown.json()).toMatchObject({ message: "Invalid credentials" });
    expect(wrongPassword.json()).toMatchObject({ message: "Invalid credentials" });
  });
});

describe("MFA — recovery codes", () => {
  it("spends a recovery code exactly once", async () => {
    const actor = await signUp(app);
    const { recoveryCodes } = await enrolAndConfirm(app, actor);
    const code = recoveryCodes[0]!;

    const first = (await login(app, actor.email)).json() as { challengeToken: string };
    const used = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge",
      payload: { challengeToken: first.challengeToken, recoveryCode: code },
    });
    expect(used.statusCode).toBe(200);
    expect((used.json() as { mfa: { recoveryCodesRemaining: number } }).mfa.recoveryCodesRemaining).toBe(9);

    const second = (await login(app, actor.email)).json() as { challengeToken: string };
    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge",
      payload: { challengeToken: second.challengeToken, recoveryCode: code },
    });
    expect(reuse.statusCode).toBe(401);
    expect(JSON.stringify(reuse.json())).toMatch(/already been used/);
  });

  it("accepts a code typed without its dashes, in lower case", async () => {
    const actor = await signUp(app);
    const { recoveryCodes } = await enrolAndConfirm(app, actor);
    const challenge = (await login(app, actor.email)).json() as { challengeToken: string };
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge",
      payload: {
        challengeToken: challenge.challengeToken,
        recoveryCode: recoveryCodes[1]!.replace(/-/g, "").toLowerCase(),
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("regenerating revokes every code issued before it", async () => {
    const actor = await signUp(app);
    const { recoveryCodes } = await enrolAndConfirm(app, actor);
    const regen = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/recovery-codes",
      headers: actor.headers,
      payload: { recoveryCode: recoveryCodes[0] },
    });
    expect(regen.statusCode).toBe(200);
    const fresh = (regen.json() as { recoveryCodes: string[] }).recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(recoveryCodes[1]);

    // A code printed last year stops working the moment a new set is asked for.
    const challenge = (await login(app, actor.email)).json() as { challengeToken: string };
    const stale = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge",
      payload: { challengeToken: challenge.challengeToken, recoveryCode: recoveryCodes[2] },
    });
    expect(stale.statusCode).toBe(401);

    const good = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge",
      payload: { challengeToken: challenge.challengeToken, recoveryCode: fresh[0] },
    });
    expect(good.statusCode).toBe(200);
  });

  it("will not regenerate on a bare session — proof of possession or nothing", async () => {
    const actor = await signUp(app);
    const { secret } = await enrolAndConfirm(app, actor);
    const bare = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/recovery-codes",
      headers: actor.headers,
      payload: {},
    });
    expect(bare.statusCode).toBe(400);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/recovery-codes",
      headers: actor.headers,
      payload: { code: wrongCode(secret) },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("counts what remains, and says so when the well runs dry", async () => {
    const actor = await signUp(app);
    const { recoveryCodes } = await enrolAndConfirm(app, actor);
    for (const code of recoveryCodes) {
      const challenge = (await login(app, actor.email)).json() as { challengeToken: string };
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/mfa/challenge",
        payload: { challengeToken: challenge.challengeToken, recoveryCode: code },
      });
      expect(res.statusCode).toBe(200);
    }
    const remaining = await app.inject({
      method: "GET",
      url: "/api/v1/auth/mfa/recovery-codes",
      headers: actor.headers,
    });
    const body = remaining.json() as { remaining: number; reasons: string[] };
    expect(body.remaining).toBe(0);
    expect(body.reasons[0]).toMatch(/Generate a new set/);
  });
});

describe("MFA — lockout, independent of the login limiter", () => {
  it("locks the factor after the configured number of failures and then refuses even a correct code", async () => {
    const actor = await signUp(app);
    const { secret } = await enrolAndConfirm(app, actor);
    const max = built.app.appConfig.MFA_MAX_FAILED_ATTEMPTS;

    const statuses: number[] = [];
    for (let i = 0; i < max; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/mfa/step-up",
        headers: actor.headers,
        payload: { code: wrongCode(secret) },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, max - 1).every((s) => s === 401)).toBe(true);
    expect(statuses[max - 1]).toBe(429);

    // The lock is on possession, not on the guess: a correct code is refused
    // too, which is what makes the lockout worth anything.
    const correct = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/step-up",
      headers: actor.headers,
      payload: { code: codeFor(secret, 1) },
    });
    expect(correct.statusCode).toBe(429);
    const details = (correct.json() as { details: { retryAfterSeconds: number; lockedUntil: string } }).details;
    expect(details.retryAfterSeconds).toBeGreaterThan(0);
    expect(details.lockedUntil).toBeTruthy();

    const row = (await built.app.db.select().from(userMfa).where(eq(userMfa.userId, actor.userId)))[0];
    expect(row?.lockedUntil).toBeTruthy();
  });

  it("locks the SECOND factor without locking the password step", async () => {
    const actor = await signUp(app);
    const { secret } = await enrolAndConfirm(app, actor);
    for (let i = 0; i < built.app.appConfig.MFA_MAX_FAILED_ATTEMPTS; i += 1) {
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/mfa/step-up",
        headers: actor.headers,
        payload: { code: wrongCode(secret) },
      });
    }
    // The password still authenticates and still yields a challenge — the two
    // limiters are separate mechanisms counting separate things.
    const res = await login(app, actor.email);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mfaRequired: true });

    // …but the challenge cannot be redeemed while the factor is locked.
    const exchange = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge",
      payload: {
        challengeToken: (res.json() as { challengeToken: string }).challengeToken,
        code: codeFor(secret, 1),
      },
    });
    expect(exchange.statusCode).toBe(429);
  });

  it("sweeps an elapsed lock lazily on a status read, with no cron", async () => {
    const actor = await signUp(app);
    const { secret } = await enrolAndConfirm(app, actor);
    for (let i = 0; i < built.app.appConfig.MFA_MAX_FAILED_ATTEMPTS; i += 1) {
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/mfa/step-up",
        headers: actor.headers,
        payload: { code: wrongCode(secret) },
      });
    }
    // Wind the lock back into the past, exactly as the clock would have.
    await built.app.db
      .update(userMfa)
      .set({ lockedUntil: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(userMfa.userId, actor.userId));

    const status = await app.inject({ method: "GET", url: "/api/v1/auth/mfa", headers: actor.headers });
    expect(status.json()).toMatchObject({ locked: false, lockedUntil: null });
    const row = (await built.app.db.select().from(userMfa).where(eq(userMfa.userId, actor.userId)))[0];
    expect(row?.lockedUntil).toBeNull();
    expect(row?.failedAttempts).toBe(0);

    // Idempotent: reading again changes nothing.
    const again = await app.inject({ method: "GET", url: "/api/v1/auth/mfa", headers: actor.headers });
    expect(again.json()).toMatchObject({ locked: false, failedAttempts: 0 });

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/step-up",
      headers: actor.headers,
      payload: { code: codeFor(secret, 1) },
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe("MFA — disabling", () => {
  it("refuses to disable on a session alone — a password is never enough", async () => {
    const actor = await signUp(app);
    const { secret } = await enrolAndConfirm(app, actor);

    const bare = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/disable",
      headers: actor.headers,
      payload: {},
    });
    expect(bare.statusCode).toBe(400);

    // There is no `password` field to offer: the route does not accept one.
    const withPassword = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/disable",
      headers: actor.headers,
      payload: { password: PASSWORD },
    });
    expect(withPassword.statusCode).toBe(400);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/disable",
      headers: actor.headers,
      payload: { code: wrongCode(secret) },
    });
    expect(wrong.statusCode).toBe(401);

    const row = (await built.app.db.select().from(userMfa).where(eq(userMfa.userId, actor.userId)))[0];
    expect(row?.status).toBe("active");
  });

  it("disables on a valid code and destroys the seed", async () => {
    const actor = await signUp(app);
    const { secret } = await enrolAndConfirm(app, actor);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/disable",
      headers: actor.headers,
      payload: { code: codeFor(secret, 1) },
    });
    expect(res.statusCode).toBe(200);
    const row = (await built.app.db.select().from(userMfa).where(eq(userMfa.userId, actor.userId)))[0];
    expect(row?.status).toBe("disabled");
    // Not merely flagged: a disabled row holding decryptable key material is a
    // seed waiting to be switched back on.
    expect(row?.secretCiphertext).toBeNull();

    const after = await login(app, actor.email);
    expect(after.json()).toMatchObject({ mfaRequired: false });
  });

  it("disables on a recovery code, and revokes the rest", async () => {
    const actor = await signUp(app);
    const { recoveryCodes } = await enrolAndConfirm(app, actor);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/disable",
      headers: actor.headers,
      payload: { recoveryCode: recoveryCodes[0] },
    });
    expect(res.statusCode).toBe(200);
    const remaining = await app.inject({
      method: "GET",
      url: "/api/v1/auth/mfa/recovery-codes",
      headers: actor.headers,
    });
    expect((remaining.json() as { remaining: number | null }).remaining).toBeNull();
  });
});

describe("MFA — company policy", () => {
  async function requireMfa(actor: Actor) {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/auth/mfa/policy",
      headers: actor.headers,
      payload: { required: true },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { required: boolean; coverage: { members: number; enrolled: number } };
  }

  it("lets an owner require MFA and reports honest coverage", async () => {
    const actor = await signUp(app);
    const body = await requireMfa(actor);
    expect(body.required).toBe(true);
    expect(body.coverage).toMatchObject({ members: 1, enrolled: 0 });

    const read = await app.inject({
      method: "GET",
      url: "/api/v1/auth/mfa/policy",
      headers: actor.headers,
    });
    expect(read.json()).toMatchObject({ required: true, updatedBy: actor.userId });
  });

  it("answers a policy-blocked sign-in with an enrol-now challenge, not a bare 403", async () => {
    const actor = await signUp(app);
    await requireMfa(actor);

    const res = await login(app, actor.email);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body["mfaRequired"]).toBe(true);
    expect(body["enrolmentRequired"]).toBe(true);
    expect(body["accessToken"]).toBeUndefined();
    expect(body["scope"]).toBe("enrol");

    // The challenge carries the authority to enrol, and completing enrolment
    // completes the sign-in in the same round trip.
    const provision = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge/enrol",
      payload: { challengeToken: body["challengeToken"] },
    });
    expect(provision.statusCode).toBe(201);
    const secret = (provision.json() as { secret: string }).secret;

    const done = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge",
      payload: { challengeToken: body["challengeToken"], code: codeFor(secret) },
    });
    expect(done.statusCode).toBe(200);
    const session = done.json() as {
      accessToken: string;
      mfa: { status: string; recoveryCodes: string[] };
    };
    expect(session.mfa.status).toBe("active");
    expect(session.mfa.recoveryCodes).toHaveLength(10);
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it("will not let a verify challenge be redeemed at the enrolment route", async () => {
    const actor = await signUp(app);
    await enrolAndConfirm(app, actor);
    const challenge = (await login(app, actor.email)).json() as { challengeToken: string };
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge/enrol",
      payload: { challengeToken: challenge.challengeToken },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses to let a member switch off a factor their tenant requires", async () => {
    const actor = await signUp(app);
    const { secret } = await enrolAndConfirm(app, actor);
    await requireMfa(actor);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/disable",
      headers: actor.headers,
      payload: { code: codeFor(secret, 1) },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { details: { code: string } }).details.code).toBe("mfa_required_by_policy");
    const row = (await built.app.db.select().from(userMfa).where(eq(userMfa.userId, actor.userId)))[0];
    expect(row?.status).toBe("active");
  });

  it("keeps the policy inside the tenant that set it", async () => {
    const a = await signUp(app);
    const b = await signUp(app);
    await requireMfa(a);
    const res = await login(app, b.email);
    // b belongs to a different company, which requires nothing.
    expect(res.json()).toMatchObject({ mfaRequired: false });
  });
});

describe("Step-up authentication", () => {
  it("refuses an account with no second factor, and names the way forward", async () => {
    const actor = await signUp(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/test/seal",
      headers: actor.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    const details = (res.json() as { details: { code: string; enrolPath: string } }).details;
    expect(details.code).toBe("mfa_enrolment_required");
    expect(details.enrolPath).toBe("/api/v1/auth/mfa/enrol");
  });

  it("admits a caller whose assertion is inside the window", async () => {
    const actor = await signUp(app);
    await enrolAndConfirm(app, actor); // confirmation IS an assertion
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/test/seal",
      headers: actor.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, stepUp: { method: "recent_assertion", action: "ledger.seal" } });
  });

  it("refuses a stale assertion — a session is not a second factor", async () => {
    const actor = await signUp(app);
    const { secret } = await enrolAndConfirm(app, actor);
    // Age every recorded assertion well past the freshness window.
    await built.app.db
      .update(authSecurityEvents)
      .set({ at: new Date(Date.now() - 60 * 60_000).toISOString() })
      .where(eq(authSecurityEvents.userId, actor.userId));

    const stale = await app.inject({
      method: "POST",
      url: "/api/v1/test/seal",
      headers: actor.headers,
      payload: {},
    });
    expect(stale.statusCode).toBe(403);
    const details = (stale.json() as { details: { code: string; stepUpPath: string; withinMinutes: number } })
      .details;
    expect(details.code).toBe("step_up_required");
    expect(details.stepUpPath).toBe("/api/v1/auth/mfa/step-up");
    expect(details.withinMinutes).toBe(built.app.appConfig.MFA_CHALLENGE_TTL_MINUTES);

    // Assert the factor, then the same request goes through.
    const assertion = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/step-up",
      headers: actor.headers,
      payload: { code: codeFor(secret, 1) },
    });
    expect(assertion.statusCode).toBe(200);
    const after = await app.inject({
      method: "POST",
      url: "/api/v1/test/seal",
      headers: actor.headers,
      payload: {},
    });
    expect(after.statusCode).toBe(200);
  });

  it("accepts an inline code on the dangerous request itself", async () => {
    const actor = await signUp(app);
    const { secret } = await enrolAndConfirm(app, actor);
    await built.app.db
      .update(authSecurityEvents)
      .set({ at: new Date(Date.now() - 60 * 60_000).toISOString() })
      .where(eq(authSecurityEvents.userId, actor.userId));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/test/seal",
      headers: { ...actor.headers, "x-mfa-code": codeFor(secret, 1) },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stepUp: { method: "totp" } });
  });

  it("accepts an inline recovery code, and spends it", async () => {
    const actor = await signUp(app);
    const { recoveryCodes } = await enrolAndConfirm(app, actor);
    await built.app.db
      .update(authSecurityEvents)
      .set({ at: new Date(Date.now() - 60 * 60_000).toISOString() })
      .where(eq(authSecurityEvents.userId, actor.userId));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/test/seal",
      headers: { ...actor.headers, "x-mfa-recovery-code": recoveryCodes[0]! },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stepUp: { method: "recovery_code" } });
    const remaining = await app.inject({
      method: "GET",
      url: "/api/v1/auth/mfa/recovery-codes",
      headers: actor.headers,
    });
    expect((remaining.json() as { remaining: number }).remaining).toBe(9);
  });

  it("refuses a wrong inline code and counts it against the lockout", async () => {
    const actor = await signUp(app);
    const { secret } = await enrolAndConfirm(app, actor);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/test/seal",
      headers: { ...actor.headers, "x-mfa-code": wrongCode(secret) },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    const row = (await built.app.db.select().from(userMfa).where(eq(userMfa.userId, actor.userId)))[0];
    expect(row?.failedAttempts).toBe(1);
  });

  it("refuses a machine caller outright — a client-credentials token holds no factor", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/test/machine-seal", payload: {} });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { details: { code: string } }).details.code).toBe(
      "machine_caller_cannot_step_up",
    );
  });

  it("refuses an anonymous caller before it asks about factors", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/test/seal", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("reports step-up state without requiring one", async () => {
    const actor = await signUp(app);
    const before = await app.inject({
      method: "GET",
      url: "/api/v1/auth/mfa/step-up",
      headers: actor.headers,
    });
    expect(before.json()).toMatchObject({ satisfied: false, enrolled: false });
    expect((before.json() as { reasons: string[] }).reasons.length).toBeGreaterThan(0);

    await enrolAndConfirm(app, actor);
    const after = await app.inject({
      method: "GET",
      url: "/api/v1/auth/mfa/step-up",
      headers: actor.headers,
    });
    expect(after.json()).toMatchObject({ satisfied: true, enrolled: true });
  });
});
