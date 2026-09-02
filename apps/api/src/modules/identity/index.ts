import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  companies,
  companyMemberships,
  permissionTemplates,
  refreshTokens,
  users,
} from "@constructos/db";
import { BUILTIN_PERMISSION_TEMPLATES, type AuthMethod } from "@constructos/shared";
import { sha256Hex } from "@constructos/ledger";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, unauthorized } from "../../lib/errors.js";
import { isExpired } from "../../lib/time.js";
import type { Db } from "../../lib/db.js";
// Phase 8 — account lifecycle and session security. These four imports are the
// whole of what this module borrows from `modules/account`: the password
// policy and hashing, the lockout guard, the session-bearing token mint, and
// the verification message a registration now sends. The logic lives there so
// that this file — the platform's front door — changes as little as possible.
// See modules/account/index.ts for the routes that complete each flow.
import {
  assessPassword,
  hashPassword,
  equalizeVerifyTiming,
  verifyPassword,
} from "../account/password.js";
import {
  completeLogin,
  guardLoginAttempt,
  noteLoginFailure,
} from "../account/login.js";
import {
  issueUserSession,
  requestContext,
  revokeAllUserSessions,
  revokeSessions,
  sessionIdForRefreshToken,
} from "../account/sessions.js";
import { recordAuthEvent, recordLegacyAuthEvent } from "../account/events.js";
import { startEmailVerification } from "../account/verification.js";
// Phase 8 — the second factor. `POST /auth/login` used to hand out a full
// session to an account with a confirmed factor, so any client that kept
// calling this route bypassed MFA completely while POST /auth/mfa/login (the
// identical request body) challenged correctly. Both routes now speak one
// protocol and redeem at the same POST /auth/mfa/challenge.
import { activeFactor, companiesRequiringMfa } from "../mfa/service.js";
// Tenant "require SSO" policy. It lives in the SSO module and is enforced
// here, at the password front door, because that is the door it is about.
import { isPasswordLoginAllowedForUser } from "../sso/index.js";
import { challengeEnvelope, mintChallengeToken } from "../mfa/challenge.js";

// The length floor lives in the password policy (modules/account/password.ts),
// not in this schema: a bare `.min(8)` here was the whole of the platform's
// password policy, and a zod message cannot explain WHY a password was
// refused. `assessPassword` returns every reason at once and the route answers
// with all of them.
const registerSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  companyName: z.string().min(1).max(200).optional(),
});

const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
});

const refreshSchema = z.object({ refreshToken: z.string().min(20) });

/** Seed the built-in permission templates into a new tenant. */
export async function seedCompanyDefaults(db: Db, companyId: string): Promise<void> {
  for (const template of BUILTIN_PERMISSION_TEMPLATES) {
    await db.insert(permissionTemplates).values({
      id: newId("ptpl"),
      companyId,
      key: template.key,
      name: template.name,
      description: template.description,
      tools: template.tools as Record<string, string>,
      isBuiltin: true,
    });
  }
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "company"
  );
}

export const identityModule: FastifyPluginAsync = async (app) => {
  /** Stricter per-IP limits on credential endpoints (brute-force guard). */
  const authLimited =
    app.appConfig.RATE_LIMIT_ENABLED && app.appConfig.NODE_ENV !== "test"
      ? {
          config: {
            rateLimit: {
              max: app.appConfig.AUTH_RATE_LIMIT_MAX_PER_MINUTE,
              timeWindow: "1 minute",
            },
          },
        }
      : {};

  /**
   * Issue the token pair AND the `auth_sessions` row behind it.
   *
   * Previously this minted a refresh token and nothing else, so a sign-in was
   * an anonymous credential: "which devices are signed in to my account?" had
   * no answer, and "sign this one out" had nothing to act on. The session row
   * is that answer, and the access token now names it (`sid`) so a revoked
   * session is refused on its next request rather than an hour later.
   *
   * `sessionId` is passed on refresh so rotation REPOINTS the existing session
   * instead of opening a second device for the same browser.
   */
  async function issueTokens(
    user: { id: string; email: string; name?: string | null },
    req: FastifyRequest,
    options: { authMethod?: AuthMethod; sessionId?: string | null } = {},
  ) {
    const issued = await issueUserSession(app, requestContext(req), {
      user,
      authMethod: options.authMethod ?? "password",
      sessionId: options.sessionId ?? null,
    });
    return {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresIn: issued.expiresIn,
      session: issued.session,
    };
  }

  async function createCompany(name: string, ownerId: string) {
    const companyId = newId("co");
    const base = slugify(name);
    /*
     * Check-then-insert races: two people registering "Acme" at the same
     * moment both saw the slug free, and the loser's request died on the
     * unique constraint as an unhandled 500 — after their user row had
     * already been created. Retry on the constraint instead, with a random
     * suffix, and give up with a clear error rather than looping.
     */
    let slug = base;
    let inserted = false;
    for (let attempt = 0; attempt < 5 && !inserted; attempt += 1) {
      if (attempt > 0) slug = `${base}-${newId().slice(0, 6)}`;
      try {
        await app.db.insert(companies).values({ id: companyId, name, slug });
        inserted = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/unique|duplicate/i.test(message)) throw err;
      }
    }
    if (!inserted) throw conflict("Could not allocate a unique company slug; try a different name");
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId,
      userId: ownerId,
      role: "owner",
    });
    await seedCompanyDefaults(app.db, companyId);
    await appendLedger(app.db, {
      companyId,
      actorId: ownerId,
      action: "create",
      objectType: "company",
      objectId: companyId,
      payload: { name, slug },
      storePayload: true,
    });
    return { id: companyId, name, slug };
  }

  app.post("/auth/register", authLimited, async (req, reply) => {
    const body = registerSchema.parse(req.body);
    // Policy first, before an account exists to half-create.
    const assessment = assessPassword(body.password, { email: body.email, name: body.name });
    if (!assessment.ok) {
      throw badRequest("Password does not meet the password policy.", {
        reasons: assessment.reasons,
      });
    }
    const existing = await app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);
    if (existing[0]) throw conflict("An account with this email already exists");

    const userId = newId("u");
    const passwordHash = await hashPassword(app.appConfig, body.password);
    await app.db.insert(users).values({
      id: userId,
      email: body.email,
      name: body.name,
      passwordHash,
    });

    let company: { id: string; name: string; slug: string } | null = null;
    if (body.companyName) {
      company = await createCompany(body.companyName, userId);
    }

    const ctx = requestContext(req);
    await recordLegacyAuthEvent(app.db, {
      userId,
      email: body.email,
      kind: "register",
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    await recordAuthEvent(app.db, {
      kind: "register",
      userId,
      companyId: company?.id ?? null,
      email: body.email,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    // Prove the address. The message is composed and RECORDED whether or not a
    // transport is configured; when there is none the link comes back in this
    // response (to the person who just typed the address, and nobody else) so
    // that a development deployment can still complete the flow.
    const verification = await startEmailVerification(app, ctx, {
      userId,
      email: body.email,
      name: body.name,
      purpose: "signup",
      companyId: company?.id ?? null,
    });

    const tokens = await issueTokens({ id: userId, email: body.email, name: body.name }, req);
    return reply.status(201).send({
      user: { id: userId, email: body.email, name: body.name },
      company,
      ...tokens,
      verification: {
        status: verification.status,
        expiresAt: verification.expiresAt,
        delivery: verification.delivery,
        verifyUrl: verification.verifyUrl,
      },
    });
  });

  /**
   * Sign in.
   *
   * The shape to keep: every refusal answers the same way. An address with no
   * account, a wrong password, a deactivated account and a locked account are
   * indistinguishable from outside — same status, same message — and an
   * address with no account still spends a bcrypt comparison
   * (`equalizeVerifyTiming`) so the CLOCK does not answer the question the body
   * refuses to. The lockout guard runs before the password is looked at, and
   * everything after a correct password (rehash to the current work factor,
   * the session row, the trail, the new-device message) lives in
   * modules/account/login.ts.
   */
  app.post("/auth/login", authLimited, async (req) => {
    const body = loginSchema.parse(req.body);
    await guardLoginAttempt(app, req, body.email);

    const rows = await app.db.select().from(users).where(eq(users.email, body.email)).limit(1);
    const user = rows[0];
    const ok = user
      ? await verifyPassword(body.password, user.passwordHash)
      : await equalizeVerifyTiming(body.password, app.appConfig);

    const ctx = requestContext(req);

    /*
     * The legacy trail is written AFTER every refusal, not before.
     *
     * It used to record `kind: ok ? "login_success" : "login_failure"` at
     * this point — before the isActive check and before the MFA branch — so
     * `GET /company/auth-events` (the only trail an admin can see) showed a
     * deactivated account presenting a correct password as a COMPLETED
     * SIGN-IN, and showed a password-only success that was still awaiting a
     * second factor the same way. An audit trail that reports refused
     * sign-ins as successes is worse than no trail.
     */
    if (!user || !ok || !user.isActive) {
      const reason = !user ? "unknown_address" : !ok ? "invalid_password" : "account_inactive";
      await recordLegacyAuthEvent(app.db, {
        userId: user?.id ?? null,
        email: body.email,
        kind: reason === "account_inactive" ? "login_blocked_inactive" : "login_failure",
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      await noteLoginFailure(app, req, {
        email: body.email,
        userId: user?.id ?? null,
        reason,
      });
      throw unauthorized("Invalid credentials");
    }

    /*
     * Tenant policy: a company that requires SSO (`allowPasswordLogin:
     * false`) must not be reachable with a password.
     *
     * `isPasswordLoginAllowedForUser` has existed in the SSO module since it
     * was written, with a comment asking the identity module to call it —
     * and nothing did. The SPA merely hid the password form, so a direct POST
     * with a valid password signed in, and `login_blocked_password_disabled`
     * was never written anywhere. The refusal is the same uniform 401 as
     * every other, with the real reason in the trail rather than the body.
     */
    if (!(await isPasswordLoginAllowedForUser(app.db, user.id))) {
      await recordLegacyAuthEvent(app.db, {
        userId: user.id,
        email: body.email,
        kind: "login_blocked_password_disabled",
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      await recordAuthEvent(app.db, {
        kind: "login_failure",
        outcome: "failure",
        userId: user.id,
        email: user.email,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        reason: "A company this account belongs to requires single sign-on",
      });
      throw unauthorized("Invalid credentials");
    }

    // THE SECOND FACTOR, before any token is minted. A confirmed factor — or a
    // tenant policy that demands one from a member who has not enrolled — turns
    // this into a challenge: no access token, no refresh token, no session row,
    // and no identity beyond the fact that a challenge is outstanding. The
    // caller redeems it at POST /auth/mfa/challenge exactly as it would a
    // challenge from POST /auth/mfa/login.
    const factor = await activeFactor(app.db, user.id);
    const requiredBy = await companiesRequiringMfa(app.db, user.id);
    if (factor || requiredBy.length > 0) {
      const minted = mintChallengeToken(app.appConfig, {
        userId: user.id,
        scope: factor ? "verify" : "enrol",
        ttlMinutes: app.appConfig.MFA_CHALLENGE_TTL_MINUTES,
      });
      await recordLegacyAuthEvent(app.db, {
        userId: user.id,
        email: body.email,
        kind: "login_challenge",
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      // The same trail POST /auth/mfa/login writes for the same event: the
      // password WAS correct, and the sign-in is pending a second factor.
      await recordAuthEvent(app.db, {
        kind: "login_success",
        outcome: "pending",
        userId: user.id,
        email: user.email,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        reason: factor
          ? "Password accepted; awaiting second factor"
          : "Password accepted; tenant policy requires enrolling a second factor",
        metadata: { challengeId: minted.claims.jti, scope: minted.claims.scope },
      });
      // 200, not 401 — the password was right. The absence of any token in
      // this body is the answer: there is no session yet, and no user id,
      // email or name either, because the caller has not finished proving who
      // they are.
      return {
        mfaRequired: true,
        ...challengeEnvelope(minted),
        policy:
          requiredBy.length > 0
            ? {
                required: true,
                companies: requiredBy.map((r) => ({ companyId: r.companyId, name: r.name })),
              }
            : { required: false, companies: [] },
        reasons: [
          factor
            ? "This account has a confirmed second factor."
            : "A company this account belongs to requires multi-factor authentication.",
        ],
      };
    }

    await app.db
      .update(users)
      .set({ lastLoginAt: new Date().toISOString() })
      .where(eq(users.id, user.id));
    await recordLegacyAuthEvent(app.db, {
      userId: user.id,
      email: body.email,
      kind: "login_success",
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    const completed = await completeLogin(app, req, { user, password: body.password });
    return {
      user: { id: user.id, email: user.email, name: user.name },
      accessToken: completed.accessToken,
      refreshToken: completed.refreshToken,
      expiresIn: completed.expiresIn,
      session: completed.session,
    };
  });

  app.post("/auth/refresh", authLimited, async (req) => {
    const body = refreshSchema.parse(req.body);
    const hash = sha256Hex(body.refreshToken);
    const rows = await app.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hash))
      .limit(1);
    const token = rows[0];
    const now = new Date().toISOString();

    /*
     * A refresh token is single use. Presenting one that has ALREADY been
     * spent is not a stale client, it is the signature of a stolen copy being
     * replayed — the legitimate holder has the rotated token, so only an
     * attacker still holds this one. The whole family is revoked and the
     * trail records it; `token_reuse_detected` existed in the enum and was
     * never written by anything before this.
     */
    if (token && token.revokedAt) {
      await revokeAllUserSessions(app.db, token.userId, {
        reason: "token_reuse_detected",
        byUser: false,
        actorId: null,
        includeOrphanTokens: true,
      });
      await recordAuthEvent(app.db, {
        kind: "refresh_reuse_detected",
        outcome: "failure",
        userId: token.userId,
        reason: "Refresh token reuse detected; every session for this account was revoked",
        ...requestContext(req),
      });
      throw unauthorized("Invalid refresh token");
    }

    // Instant comparison, not string comparison — see lib/time.ts. Postgres
    // returns "2026-09-24 23:00:00+00" while `now` is "…T10:00:00.000Z", and a
    // space sorts before "T": on a token's expiry day every refresh was
    // rejected from midnight onwards, logging people out a day early.
    if (!token || isExpired(token.expiresAt, Date.now())) {
      throw unauthorized("Invalid refresh token");
    }
    /*
     * ROTATION IS A CLAIM, NOT AN UPDATE.
     *
     * The previous code read the row, checked `revokedAt` in memory, then
     * updated unconditionally. Two concurrent refreshes with the same token —
     * a client retry, or a stolen copy racing the owner — both passed, both
     * minted new tokens and both repointed the same session; the loser's
     * refresh token stayed valid but was no longer referenced by
     * `auth_sessions.refresh_token_id`, so "sign this device out" could not
     * revoke it. A replay of an already-rotated token got a plain 401 and the
     * family survived: `token_reuse_detected` was in the enum and was never
     * written by anything.
     *
     * A conditional UPDATE ... RETURNING makes the claim atomic. Zero rows
     * back means somebody else already spent this token — which, for a
     * single-use credential, is the definition of reuse. The whole family is
     * revoked and the trail records it.
     */
    const claimed = await app.db
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(and(eq(refreshTokens.id, token.id), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    if (!claimed[0]) {
      await revokeAllUserSessions(app.db, token.userId, {
        reason: "token_reuse_detected",
        byUser: false,
        actorId: null,
        includeOrphanTokens: true,
      });
      await recordAuthEvent(app.db, {
        kind: "refresh_reuse_detected",
        outcome: "failure",
        userId: token.userId,
        reason: "Refresh token reuse detected; every session for this account was revoked",
        ...requestContext(req),
      });
      throw unauthorized("Invalid refresh token");
    }
    const userRows = await app.db
      .select()
      .from(users)
      .where(eq(users.id, token.userId))
      .limit(1);
    const user = userRows[0];
    if (!user || !user.isActive) throw unauthorized("Unknown or deactivated user");
    // Repoint the session this token belonged to rather than opening a second
    // one: rotation replaces the credential, not the device. A revoked session
    // never reaches here — revoking one revokes its refresh token, which the
    // check above already refused.
    const sessionId = await sessionIdForRefreshToken(app.db, token.id);
    const tokens = await issueTokens(user, req, { sessionId });
    await recordAuthEvent(app.db, {
      kind: "refresh_success",
      userId: user.id,
      email: user.email,
      sessionId: tokens.session.id,
      ...requestContext(req),
    });
    return { user: { id: user.id, email: user.email, name: user.name }, ...tokens };
  });

  app.post("/auth/logout", async (req) => {
    const body = refreshSchema.parse(req.body);
    const hash = sha256Hex(body.refreshToken);
    const [token] = await app.db
      .select({ id: refreshTokens.id, userId: refreshTokens.userId })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hash))
      .limit(1);
    await app.db
      .update(refreshTokens)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(refreshTokens.tokenHash, hash));
    // Sign the DEVICE out, not just the token: leaving the session row live
    // would keep the access token working until it expired, and would leave a
    // signed-out device sitting in the account's device list.
    if (token) {
      const sessionId = await sessionIdForRefreshToken(app.db, token.id);
      if (sessionId) {
        await revokeSessions(app.db, [sessionId], {
          reason: "user_signed_out",
          byUser: true,
          actorId: token.userId,
        });
        await recordAuthEvent(app.db, {
          kind: "logout",
          userId: token.userId,
          sessionId,
          ...requestContext(req),
        });
      }
    }
    await recordLegacyAuthEvent(app.db, {
      userId: token?.userId ?? null,
      kind: "logout",
      ip: req.ip,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    });
    return { ok: true };
  });

  app.get("/me", { preHandler: [app.authenticate] }, async (req) => {
    const memberships = await app.db
      .select({
        companyId: companyMemberships.companyId,
        role: companyMemberships.role,
        name: companies.name,
        slug: companies.slug,
      })
      .from(companyMemberships)
      .innerJoin(companies, eq(companies.id, companyMemberships.companyId))
      .where(eq(companyMemberships.userId, req.user!.id));
    return {
      ...req.user,
      companies: memberships.map((m) => ({
        id: m.companyId,
        name: m.name,
        slug: m.slug,
        role: m.role,
      })),
    };
  });

  app.post("/companies", { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = z.object({ name: z.string().min(1).max(200) }).parse(req.body);
    const company = await createCompany(body.name, req.user!.id);
    return reply.status(201).send(company);
  });

  app.get("/companies", { preHandler: [app.authenticate] }, async (req) => {
    const rows = await app.db
      .select({
        id: companies.id,
        name: companies.name,
        slug: companies.slug,
        role: companyMemberships.role,
      })
      .from(companyMemberships)
      .innerJoin(companies, eq(companies.id, companyMemberships.companyId))
      .where(eq(companyMemberships.userId, req.user!.id));
    return { items: rows };
  });

  app.get(
    "/companies/:companyId",
    { preHandler: [app.authenticate] },
    async (req) => {
      const { companyId } = req.params as { companyId: string };
      const member = await app.db
        .select({ role: companyMemberships.role })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.userId, req.user!.id),
          ),
        )
        .limit(1);
      // 403, not 400: an authorisation refusal that answers "malformed
      // request" makes every machine caller's error handling wrong.
      if (!member[0]) throw forbidden("Not a member of this company");
      const rows = await app.db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      return rows[0];
    },
  );
};
