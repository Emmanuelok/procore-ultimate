import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
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
import { badRequest, conflict, unauthorized } from "../../lib/errors.js";
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
    let slug = slugify(name);
    const existing = await app.db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.slug, slug))
      .limit(1);
    if (existing[0]) slug = `${slug}-${newId().slice(0, 6)}`;
    await app.db.insert(companies).values({ id: companyId, name, slug });
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
    await recordLegacyAuthEvent(app.db, {
      userId: user?.id ?? null,
      email: body.email,
      kind: ok ? "login_success" : "login_failure",
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    if (!user || !ok || !user.isActive) {
      await noteLoginFailure(app, req, {
        email: body.email,
        userId: user?.id ?? null,
        reason: !user ? "unknown_address" : !ok ? "invalid_password" : "account_inactive",
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
    // Instant comparison, not string comparison — see lib/time.ts. Postgres
    // returns "2026-09-24 23:00:00+00" while `now` is "…T10:00:00.000Z", and a
    // space sorts before "T": on a token's expiry day every refresh was
    // rejected from midnight onwards, logging people out a day early.
    if (!token || token.revokedAt || isExpired(token.expiresAt, Date.now())) {
      throw unauthorized("Invalid refresh token");
    }
    // rotate: revoke old, issue new
    await app.db
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(eq(refreshTokens.id, token.id));
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
      if (!member[0]) throw badRequest("Not a member of this company");
      const rows = await app.db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      return rows[0];
    },
  );
};
