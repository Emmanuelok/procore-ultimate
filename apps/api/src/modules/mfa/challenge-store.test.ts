import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { companyMemberships, mfaChallenges, userMfa } from "@constructos/db";
import type { BuiltApp } from "../../app.js";
import { buildTestApp } from "../../test/helpers.js";
import { base32Decode, totpForStep, totpStep, type TotpParams } from "./totp.js";
import { consumeChallenge, liveChallengeCount, sweepExpiredChallenges } from "./challenge-store.js";

/**
 * A CHALLENGE IS SINGLE-USE, AND REVOCABLE IN FLIGHT.
 *
 * `challenge.ts` used to say, in its own header, that within the token's
 * ten-minute life the same token could be presented more than once and that
 * there was no way to revoke one. Both statements were true and both are now
 * false; these are the tests that keep them false.
 *
 * The interesting case is the LAST one: a challenge that was never registered
 * — the shape `identity`'s own /auth/login mints, in a module this package
 * does not own — must still be single-use, because consumption is an upsert on
 * the token's jti rather than a lookup.
 */

/**
 * Booting PGlite and replaying every migration is minutes of CPU on a shared
 * machine — five minutes here for the same reason the neighbouring suites
 * allow three: a suite that goes red when the machine is busy teaches people
 * to ignore red, which is the expensive failure.
 */
const HOOK_TIMEOUT_MS = 900_000; /* TEMP-VERIFY */
const PASSWORD = "scaffold-tower-brick";
let counter = 0;

interface Actor {
  userId: string;
  email: string;
  companyId: string;
  headers: Record<string, string>;
}

async function signUp(app: FastifyInstance): Promise<Actor> {
  counter += 1;
  const email = `chal${counter}-${Date.now()}@test.dev`;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email,
      password: PASSWORD,
      name: `Challenge User ${counter}`,
      companyName: `Challenge Co ${counter}`,
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { user: { id: string }; company: { id: string }; accessToken: string };
  return {
    userId: body.user.id,
    email,
    companyId: body.company.id,
    headers: {
      authorization: `Bearer ${body.accessToken}`,
      "x-company-id": body.company.id,
    },
  };
}

function paramsFor(secret: string): TotpParams {
  return { secret: base32Decode(secret), algorithm: "SHA1", digits: 6, periodSeconds: 30 };
}
function codeFor(secret: string, offsetSteps = 0): string {
  return totpForStep(paramsFor(secret), totpStep(Date.now(), 30) + offsetSteps);
}

async function enrolAndConfirm(app: FastifyInstance, actor: Actor): Promise<string> {
  const enrolled = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mfa/enrol",
    headers: actor.headers,
    payload: {},
  });
  expect(enrolled.statusCode).toBe(201);
  const secret = (enrolled.json() as { secret: string }).secret;
  const confirmed = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mfa/enrol/confirm",
    headers: actor.headers,
    payload: { code: codeFor(secret) },
  });
  expect(confirmed.statusCode).toBe(200);
  return secret;
}

describe("MFA challenges are single-use", () => {
  let built: BuiltApp;
  let app: FastifyInstance;

  beforeAll(async () => {
    built = await buildTestApp();
    app = built.app;
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await built.close();
  });

  it("registers a row when the login route mints a challenge", async () => {
    const actor = await signUp(app);
    await enrolAndConfirm(app, actor);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/login",
      payload: { email: actor.email, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const { challengeId } = login.json() as { challengeId: string };
    const [row] = await app.db
      .select()
      .from(mfaChallenges)
      .where(eq(mfaChallenges.id, challengeId));
    expect(row?.userId).toBe(actor.userId);
    expect(row?.origin).toBe("password");
    expect(row?.consumedAt).toBeNull();
    expect(await liveChallengeCount(app.db, actor.userId, Date.now())).toBeGreaterThanOrEqual(1);
  });

  it("refuses a second exchange of the same challenge token", async () => {
    const actor = await signUp(app);
    const secret = await enrolAndConfirm(app, actor);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/login",
      payload: { email: actor.email, password: PASSWORD },
    });
    const { challengeToken, challengeId } = login.json() as {
      challengeToken: string;
      challengeId: string;
    };

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge",
      payload: { challengeToken, code: codeFor(secret, 1) },
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { accessToken?: string }).accessToken).toBeTruthy();

    const [row] = await app.db
      .select()
      .from(mfaChallenges)
      .where(eq(mfaChallenges.id, challengeId));
    expect(row?.consumedAt).not.toBeNull();

    // A replay with a DIFFERENT, still-valid code: the code is not what stops
    // it, the spent challenge is.
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge",
      payload: { challengeToken, code: codeFor(secret, 2) },
    });
    expect(replay.statusCode).toBe(401);
    expect((replay.json() as { message: string }).message).toContain("already been used");
  });

  it("an administrator's MFA reset cuts every challenge in flight", async () => {
    const owner = await signUp(app);
    const victim = await signUp(app);
    await app.db.insert(companyMemberships).values({
      id: `cm-chal-${counter}-${Date.now()}`,
      companyId: owner.companyId,
      userId: victim.userId,
      role: "member",
    });
    const secret = await enrolAndConfirm(app, victim);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/login",
      payload: { email: victim.email, password: PASSWORD },
    });
    const { challengeToken } = login.json() as { challengeToken: string };

    const reset = await app.inject({
      method: "POST",
      url: `/api/v1/company/security/users/${victim.userId}/mfa/reset`,
      headers: owner.headers,
    });
    expect(reset.statusCode).toBe(200);
    expect((reset.json() as { challengesRevoked: number }).challengesRevoked).toBeGreaterThanOrEqual(
      1,
    );

    const after = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge",
      payload: { challengeToken, code: codeFor(secret, 1) },
    });
    expect(after.statusCode).toBe(401);
  });

  it("refuses to provision an enrolment seed against a spent challenge", async () => {
    const actor = await signUp(app);
    // Tenant policy forces enrolment: the login returns an `enrol` challenge.
    const policy = await app.inject({
      method: "PUT",
      url: "/api/v1/auth/mfa/policy",
      headers: actor.headers,
      payload: { required: true },
    });
    expect(policy.statusCode).toBe(200);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/login",
      payload: { email: actor.email, password: PASSWORD },
    });
    const { challengeToken, challengeId, scope } = login.json() as {
      challengeToken: string;
      challengeId: string;
      scope: string;
    };
    expect(scope).toBe("enrol");

    // Provisioning does NOT spend the challenge: the same one has to confirm.
    const provisioned = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge/enrol",
      payload: { challengeToken },
    });
    expect(provisioned.statusCode).toBe(201);
    const [stillLive] = await app.db
      .select()
      .from(mfaChallenges)
      .where(eq(mfaChallenges.id, challengeId));
    expect(stillLive?.consumedAt).toBeNull();

    // Spend it by hand, then ask for another seed: refused.
    await consumeChallenge(
      app.db,
      { jti: challengeId, uid: actor.userId, scope: "enrol", exp: Date.now() + 600_000 },
      Date.now(),
    );
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge/enrol",
      payload: { challengeToken },
    });
    expect(again.statusCode).toBe(401);
  });

  it("makes an UNREGISTERED challenge single-use too", async () => {
    // The shape another module mints: nothing was ever written at mint time.
    const jti = `mch_unregistered_${Date.now()}`;
    const claims = { jti, uid: "u_someone", scope: "verify" as const, exp: Date.now() + 600_000 };
    const first = await consumeChallenge(app.db, claims, Date.now());
    expect(first.ok).toBe(true);
    const second = await consumeChallenge(app.db, claims, Date.now());
    expect(second.ok).toBe(false);
    expect(second.code).toBe("replayed");
  });

  it("sweeps expired challenges past the grace window and registers the job", async () => {
    const names = app.scheduler.list().map((j) => j.name);
    expect(names).toContain("mfa.challenge-sweep");

    const id = `mch_old_${Date.now()}`;
    await app.db.insert(mfaChallenges).values({
      id,
      userId: "u_old",
      scope: "verify",
      origin: "password",
      expiresAt: new Date(Date.now() - 7 * 3600_000).toISOString(),
    });
    const deleted = await sweepExpiredChallenges(app.db, Date.now());
    expect(deleted).toBeGreaterThanOrEqual(1);
    const rows = await app.db.select().from(mfaChallenges).where(eq(mfaChallenges.id, id));
    expect(rows.length).toBe(0);
  });

  it("records the tenant MFA policy change in the security trail under its own kind", async () => {
    const actor = await signUp(app);
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/auth/mfa/policy",
      headers: actor.headers,
      payload: { required: true },
    });
    expect(res.statusCode).toBe(200);
    const { authSecurityEvents } = await import("@constructos/db");
    const rows = await app.db
      .select({ kind: authSecurityEvents.kind, reason: authSecurityEvents.reason })
      .from(authSecurityEvents)
      .where(
        and(
          eq(authSecurityEvents.companyId, actor.companyId),
          eq(authSecurityEvents.kind, "mfa_policy_changed"),
        ),
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.reason).toContain("required");
  });

  it("tells the account holder when a second factor is enrolled", async () => {
    const actor = await signUp(app);
    await enrolAndConfirm(app, actor);
    const { emailDispatches } = await import("@constructos/db");
    const rows = await app.db
      .select({ template: emailDispatches.template, toEmail: emailDispatches.toEmail })
      .from(emailDispatches)
      .where(eq(emailDispatches.userId, actor.userId));
    const templates = rows.map((r) => r.template);
    expect(templates).toContain("mfa_enrolled");
    // Only a factor row confirms it — the message must not be the proof.
    const factors = await app.db.select().from(userMfa).where(eq(userMfa.userId, actor.userId));
    expect(factors[0]?.status).toBe("active");
  });
});
