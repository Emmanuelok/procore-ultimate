import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  authSecurityEvents,
  authSessions,
  companies,
  companyMemberships,
  emailDispatches,
  emailVerifications,
  projectMemberships,
  projects,
  securityWebhookDeliveries,
  userIdentities,
  userInvitations,
  userMfa,
  users,
} from "@constructos/db";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized,
} from "../../lib/errors.js";
import { isExpired } from "../../lib/time.js";
import { emailTransportFor } from "./mailer.js";
import { addSecurityEventHook, recordAuthEvent, recordLegacyAuthEvent } from "./events.js";
import {
  hashPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
} from "./password.js";
import {
  issueUserSession,
  listLiveSessions,
  loadSession,
  requestContext,
  requireLiveSession,
  revokeAllUserSessions,
  revokeSessions,
  sessionIdFromRequest,
  sweepExpiredSessions,
} from "./sessions.js";
import {
  invitationCreatedAccount,
  invitationUsable,
  invitationView,
  loadInvitationByToken,
  sendInvitation,
  sweepExpiredInvitations,
} from "./invitations.js";
import { completePasswordReset, requestPasswordReset } from "./reset.js";
import {
  consumeVerificationToken,
  startEmailVerification,
  verificationStatus,
  VERIFICATION_MAX_PER_HOUR,
} from "./verification.js";
import { mintToken } from "./tokens.js";
import {
  assessPasswordWithPolicy,
  effectivePolicyForUser,
  loadCompanyPolicy,
  policyRules,
  resolvePolicies,
  PLATFORM_DEFAULT_POLICY,
  type ResolvedSecurityPolicy,
} from "./policy.js";
import { isPasswordReused, recordPasswordHistory } from "./password-history.js";
import { applyRetention } from "./retention.js";
import { registerSecurityRoutes } from "./security-routes.js";
import { registerScimRoutes } from "./scim.js";
import { enqueueSecurityEvent, sweepSecurityWebhooks } from "./webhooks.js";

/**
 * Account self-service: email verification, password reset and change, the
 * device list with "sign out everywhere", the account-security feed, and the
 * invitation accept flow.
 *
 * ROUTE OWNERSHIP. `/account/*` and the unauthenticated `/auth/verify-email`,
 * `/auth/password-reset*` and `/auth/invitations/*`, plus the administrator's
 * `/company/invitations*`. `/auth/login`, `/auth/register`, `/auth/refresh`
 * and `/auth/logout` belong to the identity module; `/auth/sso/*` to SSO;
 * `/auth/mfa/*` to MFA. Nothing here re-implements those.
 *
 * THE FIVE RULES THIS MODULE KEEPS, each of which has a test named after it:
 *
 *  1. Every token is minted once, stored as `sha256(token)`, shown exactly
 *     once, and single-use through a CONDITIONAL update.
 *  2. Password reset answers identically for an address that exists and one
 *     that does not — the response depends on the server's configuration, not
 *     on the account. And it never returns the link.
 *  3. Completing a reset destroys every session and every refresh token,
 *     because a reset is the moment you must assume the attacker holds one.
 *  4. A revoked session is refused on its NEXT request, not at the next
 *     refresh — see `requireLiveSession` in sessions.ts.
 *  5. Nothing claims to have sent a message it did not send. Every route that
 *     composes mail returns `deliveryReport(...)`, and when no transport is
 *     configured it says so and names the environment variable.
 */

const emailSchema = z.string().email().toLowerCase().max(320);
const passwordSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH);
const tokenSchema = z.string().min(20).max(512);

export const accountModule: FastifyPluginAsync = async (app) => {
  const liveSession = requireLiveSession(app);
  const signedIn = [app.authenticate, liveSession];
  const companyAdmin = [
    app.authenticate,
    liveSession,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];

  /** Stricter per-IP limits on the unauthenticated credential endpoints. */
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

  /* ================================================================ */
  /* Password policy — published so a form can apply it before asking  */
  /* ================================================================ */

  /**
   * The rules a form must apply before it asks.
   *
   * UNAUTHENTICATED, deliberately — the register and accept-invitation pages
   * need it before anybody has a token. A signed-in caller (bearer present)
   * gets the rules their own tenants actually impose (#25); an anonymous one
   * gets the platform floor, because resolving a tenant policy from an email
   * address supplied by a stranger would turn this into an oracle for "does
   * this company require twenty characters", which is a fingerprint of the
   * tenant, not of the caller.
   */
  app.get("/account/password-policy", async (req) => {
    let policy: ResolvedSecurityPolicy = PLATFORM_DEFAULT_POLICY;
    let scope: "platform" | "tenant" = "platform";
    const header = req.headers.authorization;
    if (typeof header === "string" && header.startsWith("Bearer ")) {
      try {
        // `authenticate` takes the reply for its declared signature; it never
        // touches it on the path this route cares about (it either sets
        // `req.user` or throws).
        await app.authenticate(req, undefined as never);
        if (req.user) {
          policy = await effectivePolicyForUser(app.db, req.user.id);
          scope = "tenant";
        }
      } catch {
        /* an unusable token simply gets the platform floor */
      }
    }
    return {
      minLength: policy.passwordMinLength,
      maxLength: PASSWORD_MAX_LENGTH,
      requireComplexity: policy.passwordRequireComplexity,
      historyDepth: policy.passwordHistoryDepth,
      maxAgeDays: policy.passwordMaxAgeDays,
      platformMinLength: PASSWORD_MIN_LENGTH,
      scope,
      rules: policyRules(policy),
    };
  });

  /* ================================================================ */
  /* Email verification                                                */
  /* ================================================================ */

  app.get("/account/verification", { preHandler: signedIn }, async (req) => {
    const [row] = await app.db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, req.user!.id))
      .limit(1);
    if (!row) throw unauthorized("Unknown user");
    const status = await verificationStatus(app.db, req.user!.id, row.email);
    const transport = emailTransportFor(app);
    return {
      ...status,
      resendsPerHour: VERIFICATION_MAX_PER_HOUR,
      policy: {
        // Stated explicitly so the restriction is a documented decision rather
        // than a surprise 403 — see the header of verification.ts.
        enforced: transport.dispatches,
        unverifiedMay: [
          "sign in",
          "read everything their permissions allow",
          "change their own password",
          "manage their own sessions",
        ],
        unverifiedMayNot: [
          "invite other people (a message would be sent in the company's name)",
          "resend an invitation",
        ],
        note: transport.dispatches
          ? "Verification is enforced: this deployment can send mail."
          : "Verification is NOT enforced: this deployment has no mail transport, so " +
            "nobody could verify an address. Set EMAIL_PROVIDER to enforce it.",
      },
    };
  });

  app.post("/account/verification/resend", { preHandler: signedIn }, async (req, reply) => {
    const [row] = await app.db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, req.user!.id))
      .limit(1);
    if (!row) throw unauthorized("Unknown user");
    const status = await verificationStatus(app.db, req.user!.id, row.email);
    if (status.verified) {
      return reply.status(200).send({
        status: "already_verified",
        email: row.email,
        verifiedAt: status.verifiedAt,
        delivery: null,
      });
    }
    const sent = await startEmailVerification(app, requestContext(req), {
      userId: req.user!.id,
      email: row.email,
      name: row.name,
    });
    if (sent.status === "throttled") {
      return reply.status(429).send({
        statusCode: 429,
        error: "TooManyRequests",
        message: sent.reasons[0] ?? "Too many verification messages.",
        details: { retryAfterSeconds: sent.retryAfterSeconds },
      });
    }
    return reply.status(202).send({
      status: "sent",
      email: row.email,
      expiresAt: sent.expiresAt,
      delivery: sent.delivery,
      // present only when nothing was dispatched — see verification.ts
      verifyUrl: sent.verifyUrl,
    });
  });

  app.post("/auth/verify-email", authLimited, async (req) => {
    const body = z.object({ token: tokenSchema }).parse(req.body);
    const consumed = await consumeVerificationToken(app, body.token, requestContext(req));
    return {
      verified: true,
      email: consumed.email,
      purpose: consumed.purpose,
      // The page says "the address change is now in force" for an
      // `email_change` token; it may only say so when this is true.
      emailChanged: consumed.emailChanged,
    };
  });

  /* ================================================================ */
  /* Password reset                                                    */
  /* ================================================================ */

  /**
   * ALWAYS 202, ALWAYS the same body. Whether the address has an account,
   * whether it is locked, whether it was throttled, whether the message was
   * dispatched — none of it is observable here. The only thing the response
   * reports is a property of the SERVER: can this deployment send mail at all.
   */
  app.post("/auth/password-reset", authLimited, async (req, reply) => {
    const body = z.object({ email: emailSchema }).parse(req.body);
    await requestPasswordReset(app, requestContext(req), body.email);
    const transport = emailTransportFor(app);
    return reply.status(202).send({
      status: "accepted",
      message:
        "If an account exists for that address, a password reset link has been sent to it. " +
        "The link can be used once and expires shortly.",
      transport: {
        configured: transport.dispatches,
        kind: transport.kind,
        reasons: transport.dispatches ? [] : [transport.describe()],
      },
    });
  });

  app.post("/auth/password-reset/complete", authLimited, async (req) => {
    const body = z
      .object({ token: tokenSchema, password: passwordSchema })
      .parse(req.body);
    const done = await completePasswordReset(app, requestContext(req), body);
    return {
      ok: true,
      email: done.email,
      sessionsRevoked: done.sessionsRevoked,
      message: "Password changed. Every other device has been signed out.",
    };
  });

  /* ================================================================ */
  /* Password change (signed in)                                       */
  /* ================================================================ */

  app.post("/account/password", { preHandler: signedIn }, async (req) => {
    const body = z
      .object({
        currentPassword: passwordSchema,
        newPassword: passwordSchema,
        /** default true: a password change usually means "and lock them out" */
        signOutOtherDevices: z.boolean().default(true),
      })
      .parse(req.body);
    const ctx = requestContext(req);
    const [user] = await app.db
      .select()
      .from(users)
      .where(eq(users.id, req.user!.id))
      .limit(1);
    if (!user) throw unauthorized("Unknown user");

    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      await recordAuthEvent(app.db, {
        kind: "password_changed",
        outcome: "failure",
        userId: user.id,
        email: user.email,
        sessionId: req.accountSessionId ?? null,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        reason: "current_password_incorrect",
      });
      throw unauthorized("Current password is incorrect");
    }
    if (body.newPassword === body.currentPassword) {
      throw badRequest("The new password must be different from the current one.");
    }
    // #25 — the tenant's rules on top of the platform's, strictest across
    // every company this account belongs to.
    const policy = await effectivePolicyForUser(app.db, user.id);
    const assessment = assessPasswordWithPolicy(
      body.newPassword,
      { email: user.email, name: user.name },
      policy,
    );
    if (!assessment.ok) {
      throw badRequest("Password does not meet the password policy.", {
        reasons: assessment.reasons,
      });
    }
    const reuse = await isPasswordReused(
      app.db,
      user.id,
      body.newPassword,
      policy.passwordHistoryDepth,
      user.passwordHash,
    );
    if (reuse.reused) {
      await recordAuthEvent(app.db, {
        kind: "password_reuse_refused",
        outcome: "blocked",
        userId: user.id,
        email: user.email,
        sessionId: req.accountSessionId ?? null,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        reason: reuse.reason,
        metadata: { checked: reuse.checked, depth: policy.passwordHistoryDepth },
      });
      throw badRequest("Password does not meet the password policy.", {
        reasons: [reuse.reason ?? "That password has been used on this account before."],
      });
    }

    // Retain the hash being replaced BEFORE replacing it — afterwards it is
    // gone and the history is a hash short for ever.
    await recordPasswordHistory(
      app.db,
      user.id,
      user.passwordHash,
      "changed",
      policy.passwordHistoryDepth,
    );
    await app.db
      .update(users)
      .set({
        passwordHash: await hashPassword(app.appConfig, body.newPassword),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(users.id, user.id));

    let sessionsRevoked = 0;
    if (body.signOutOtherDevices) {
      sessionsRevoked = await revokeAllUserSessions(app.db, user.id, {
        reason: "password_changed",
        byUser: true,
        actorId: user.id,
        exceptSessionId: req.accountSessionId ?? null,
        includeOrphanTokens: true,
      });
    }
    await recordAuthEvent(app.db, {
      kind: "password_changed",
      userId: user.id,
      email: user.email,
      sessionId: req.accountSessionId ?? null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { sessionsRevoked, signOutOtherDevices: body.signOutOtherDevices },
    });
    await recordLegacyAuthEvent(app.db, {
      userId: user.id,
      email: user.email,
      kind: "password_change",
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return {
      ok: true,
      signedOutOtherDevices: body.signOutOtherDevices,
      sessionsRevoked,
    };
  });

  /* ================================================================ */
  /* Sessions and devices                                              */
  /* ================================================================ */

  app.get("/account/sessions", { preHandler: signedIn }, async (req) => {
    // Lazy, idempotent sweep on the read — the house rule. Anything past its
    // absolute lifetime is marked here rather than by a scheduler.
    const sweptExpired = await sweepExpiredSessions(app.db, req.user!.id);
    const current = req.accountSessionId ?? sessionIdFromRequest(req);
    const items = await listLiveSessions(app.db, req.user!.id, current);
    return {
      items,
      sweptExpired,
      // An honest caveat rather than a silent one: tokens minted by another
      // sign-in path carry no session id, so "current" cannot be marked.
      currentSessionKnown: Boolean(current),
    };
  });

  app.delete("/account/sessions/:sessionId", { preHandler: signedIn }, async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    const session = await loadSession(app.db, sessionId);
    // A session that is not yours is "not found", never "forbidden": the
    // difference would confirm that an id exists.
    if (!session || session.userId !== req.user!.id) throw notFound("Session not found");
    const isCurrent = session.id === req.accountSessionId;
    const revoked = await revokeSessions(app.db, [session.id], {
      reason: isCurrent ? "user_signed_out" : "user_signed_out",
      byUser: true,
      actorId: req.user!.id,
    });
    await recordAuthEvent(app.db, {
      kind: "session_revoked",
      userId: req.user!.id,
      email: req.user!.email,
      sessionId: session.id,
      ...requestContext(req),
      metadata: { current: isCurrent, revoked },
    });
    return { ok: true, revoked, wasCurrentSession: isCurrent };
  });

  app.post("/account/sessions/revoke-others", { preHandler: signedIn }, async (req) => {
    const current = req.accountSessionId ?? null;
    const revoked = await revokeAllUserSessions(app.db, req.user!.id, {
      reason: "user_signed_out_everywhere",
      byUser: true,
      actorId: req.user!.id,
      exceptSessionId: current,
      includeOrphanTokens: true,
    });
    await recordAuthEvent(app.db, {
      kind: "sessions_revoked_all",
      userId: req.user!.id,
      email: req.user!.email,
      sessionId: current,
      ...requestContext(req),
      metadata: { revoked, keptCurrent: Boolean(current) },
    });
    return { ok: true, revoked, keptCurrentSession: Boolean(current) };
  });

  /* ================================================================ */
  /* The account-security feed                                         */
  /* ================================================================ */

  app.get("/account/security-events", { preHandler: signedIn }, async (req) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query);
    const rows = await app.db
      .select()
      .from(authSecurityEvents)
      .where(eq(authSecurityEvents.userId, req.user!.id))
      .orderBy(desc(authSecurityEvents.at))
      .limit(q.limit);
    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        outcome: row.outcome,
        at: row.at,
        ip: row.ip,
        userAgent: row.userAgent,
        sessionId: row.sessionId,
        companyId: row.companyId,
        reason: row.reason,
        metadata: row.metadata,
      })),
    };
  });

  /**
   * §0.2 #45 — THE DATA-SUBJECT EXPORT.
   *
   * Everything this platform's authentication layer holds about the caller, in
   * one JSON document they can keep: the account row, the tenants they belong
   * to, every device session, every linked identity provider, the second-factor
   * state, the full security trail, the messages sent to them and any
   * invitation issued to their address.
   *
   * WHAT IS DELIBERATELY NOT IN IT, and why saying so matters more than the
   * omission: no password hash, no TOTP seed, no recovery-code hash, no
   * refresh token and no session token. An export is a document that will be
   * mailed to somebody and left in a downloads folder; putting a credential in
   * it would turn a transparency feature into a second copy of the thing the
   * platform hashes everything to avoid holding.
   *
   * It is a READ, and it is ledgered as one in every company the caller
   * belongs to: an export is the moment an account's whole history leaves the
   * platform, and that is precisely the kind of access the chain exists to
   * record.
   */
  app.get("/account/export", { preHandler: signedIn }, async (req) => {
    const actor = req.user!;
    const nowIso = new Date().toISOString();
    const [account] = await app.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        isActive: users.isActive,
        title: users.title,
        phone: users.phone,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(eq(users.id, actor.id))
      .limit(1);

    // Address verification lives in `email_verifications`, not in a column on
    // `users` — the proof is the row, and an export that invented a
    // `verifiedAt` field would be asserting something the schema does not
    // hold. Only what was proved and when; never the token.
    const verifications = await app.db
      .select({
        email: emailVerifications.email,
        purpose: emailVerifications.purpose,
        createdAt: emailVerifications.createdAt,
        consumedAt: emailVerifications.consumedAt,
        expiresAt: emailVerifications.expiresAt,
      })
      .from(emailVerifications)
      .where(eq(emailVerifications.userId, actor.id))
      .orderBy(desc(emailVerifications.createdAt))
      .limit(100);

    const memberships = await app.db
      .select({
        companyId: companyMemberships.companyId,
        role: companyMemberships.role,
        createdAt: companyMemberships.createdAt,
        companyName: companies.name,
      })
      .from(companyMemberships)
      .leftJoin(companies, eq(companies.id, companyMemberships.companyId))
      .where(eq(companyMemberships.userId, actor.id));

    const sessions = await app.db
      .select({
        id: authSessions.id,
        createdAt: authSessions.createdAt,
        lastSeenAt: authSessions.lastSeenAt,
        expiresAt: authSessions.expiresAt,
        revokedAt: authSessions.revokedAt,
        revokedReason: authSessions.revokedReason,
        ip: authSessions.ip,
        userAgent: authSessions.userAgent,
        deviceLabel: authSessions.deviceLabel,
        authMethod: authSessions.authMethod,
      })
      .from(authSessions)
      .where(eq(authSessions.userId, actor.id))
      .orderBy(desc(authSessions.createdAt))
      .limit(500);

    const identities = await app.db
      .select({
        id: userIdentities.id,
        providerId: userIdentities.providerId,
        externalSubject: userIdentities.externalSubject,
        emailAtLink: userIdentities.emailAtLink,
        linkedAt: userIdentities.linkedAt,
        lastLoginAt: userIdentities.lastLoginAt,
      })
      .from(userIdentities)
      .where(eq(userIdentities.userId, actor.id));

    const factors = await app.db
      .select({
        id: userMfa.id,
        method: userMfa.method,
        status: userMfa.status,
        confirmedAt: userMfa.confirmedAt,
        disabledAt: userMfa.disabledAt,
        lastUsedAt: userMfa.lastUsedAt,
      })
      .from(userMfa)
      .where(eq(userMfa.userId, actor.id));

    const trail = await app.db
      .select()
      .from(authSecurityEvents)
      .where(eq(authSecurityEvents.userId, actor.id))
      .orderBy(desc(authSecurityEvents.at))
      .limit(2000);

    const messages = await app.db
      .select({
        id: emailDispatches.id,
        template: emailDispatches.template,
        toEmail: emailDispatches.toEmail,
        subject: emailDispatches.subject,
        status: emailDispatches.status,
        transport: emailDispatches.transport,
        dispatchedAt: emailDispatches.dispatchedAt,
        createdAt: emailDispatches.createdAt,
      })
      .from(emailDispatches)
      .where(eq(emailDispatches.userId, actor.id))
      .orderBy(desc(emailDispatches.createdAt))
      .limit(500);

    const invitations = account
      ? await app.db
          .select({
            id: userInvitations.id,
            companyId: userInvitations.companyId,
            role: userInvitations.role,
            status: userInvitations.status,
            createdAt: userInvitations.createdAt,
            expiresAt: userInvitations.expiresAt,
            acceptedAt: userInvitations.acceptedAt,
          })
          .from(userInvitations)
          .where(eq(userInvitations.email, account.email))
          .limit(200)
      : [];

    for (const membership of memberships) {
      await appendLedger(app.db, {
        companyId: membership.companyId,
        actorId: actor.id,
        action: "access",
        objectType: "account_export",
        objectId: actor.id,
        payload: {
          at: nowIso,
          sessions: sessions.length,
          trailRows: trail.length,
          messages: messages.length,
        },
        storePayload: true,
      });
    }
    await recordAuthEvent(app.db, {
      kind: "account_export",
      userId: actor.id,
      email: account?.email ?? actor.email,
      ...requestContext(req),
      reason: "The account holder exported everything the authentication layer holds about them.",
      metadata: { trailRows: trail.length, sessions: sessions.length },
    });

    return {
      generatedAt: nowIso,
      subject: account ?? null,
      memberships,
      sessions,
      identities,
      emailVerifications: verifications,
      mfaFactors: factors,
      securityTrail: trail.map((row) => ({
        id: row.id,
        kind: row.kind,
        outcome: row.outcome,
        at: row.at,
        companyId: row.companyId,
        ip: row.ip,
        userAgent: row.userAgent,
        reason: row.reason,
        metadata: row.metadata,
      })),
      messages,
      invitations,
      excluded: [
        "Password hashes, TOTP seeds and recovery-code hashes are never exported: they are credentials, not records about you.",
        "Session and refresh tokens are not exported; the session list describes the devices, not the tokens.",
        "Records outside authentication — projects, documents, financials — are exported by the company data export, not this one.",
      ],
      truncated: {
        securityTrail: trail.length === 2000,
        sessions: sessions.length === 500,
        messages: messages.length === 500,
      },
    };
  });

  /* ================================================================ */
  /* Invitations — the public accept flow                              */
  /* ================================================================ */

  /**
   * What an invitation link points at, without spending it. The token is the
   * only secret; whoever holds it may see who invited them and to what.
   */
  app.post("/auth/invitations/preview", authLimited, async (req) => {
    const body = z.object({ token: tokenSchema }).parse(req.body);
    const invitation = await loadInvitationByToken(app, body.token);
    const check = invitationUsable(invitation);
    if (!invitation) return { valid: false, reasons: check.reasons, invitation: null };

    // Lazy sweep: a link read after its expiry writes the state back.
    if (!check.usable && invitation.status === "pending") {
      await sweepExpiredInvitations(app, invitation.companyId);
    }
    const [company] = await app.db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, invitation.companyId))
      .limit(1);
    const [inviter] = await app.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, invitation.invitedBy))
      .limit(1);
    const [existing] = await app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, invitation.email))
      .limit(1);
    const claimable = await invitationCreatedAccount(app, invitation);
    return {
      valid: check.usable,
      reasons: check.reasons,
      invitation: {
        email: invitation.email,
        name: invitation.name,
        role: invitation.role,
        companyName: company?.name ?? null,
        inviterName: inviter?.name ?? null,
        message: invitation.message,
        expiresAt: invitation.expiresAt,
        status: invitation.status,
      },
      // What the accept form must ask for.
      requires:
        existing && !claimable
          ? { currentPassword: true, newPassword: false }
          : { currentPassword: false, newPassword: true },
    };
  });

  /**
   * Accept.
   *
   * TWO SHAPES, and the difference is the security of the whole flow:
   *
   *  - the invitation CREATED the account (a new hire): the invitee sets their
   *    own password here, every session opened with the temporary password the
   *    administrator was handed is destroyed, and they are signed in.
   *  - the address ALREADY had an account: the invitation may not set a
   *    password. The current one must be presented. Otherwise an administrator
   *    holding an undispatched accept link could take over a stranger's
   *    account by inviting them — see invitations.ts.
   */
  app.post("/auth/invitations/accept", authLimited, async (req, reply) => {
    const body = z
      .object({
        token: tokenSchema,
        password: passwordSchema.optional(),
        name: z.string().min(1).max(200).optional(),
      })
      .parse(req.body);
    const ctx = requestContext(req);
    const nowMs = Date.now();

    const invitation = await loadInvitationByToken(app, body.token);
    const check = invitationUsable(invitation, nowMs);
    if (!invitation || !check.usable) {
      if (invitation && invitation.status === "pending") {
        await sweepExpiredInvitations(app, invitation.companyId, nowMs);
      }
      await recordAuthEvent(app.db, {
        kind: "invitation_accepted",
        outcome: "failure",
        companyId: invitation?.companyId ?? null,
        email: invitation?.email ?? null,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        reason: check.reasons[0] ?? "invalid_token",
        metadata: { invitationId: invitation?.id ?? null },
      });
      throw badRequest("This invitation cannot be accepted.", { reasons: check.reasons });
    }

    const [existing] = await app.db
      .select()
      .from(users)
      .where(eq(users.email, invitation.email))
      .limit(1);

    // The segregation rule: nobody accepts their own invitation into a role.
    if (existing && existing.id === invitation.invitedBy) {
      throw forbidden("The person who sent this invitation cannot accept it.");
    }

    /*
     * ORDER OF OPERATIONS — the whole point of this rewrite.
     *
     * The original wrote the user row, the company membership and every
     * project membership FIRST, and spent the invitation LAST. Two clicks on
     * one link therefore both got as far as inserting a user: the second
     * violated `users_email_uq` and surfaced as a 500 instead of the intended
     * 409, and for an existing account the membership was created even when
     * the claim then failed — leaving a membership attached to an invitation
     * the register shows as accepted by somebody else.
     *
     * So: everything expensive and refusable (the password policy, the reuse
     * check, the bcrypt hash) happens BEFORE the transaction, and the
     * transaction CLAIMS THE INVITATION FIRST. A loser of the race changes
     * nothing at all, because its conditional UPDATE matches no row and the
     * whole transaction rolls back.
     */
    const claimable = !existing || (await invitationCreatedAccount(app, invitation));
    const nowIso = new Date(nowMs).toISOString();

    let userId: string;
    let userName: string;
    let userEmail = invitation.email;
    let passwordSet = false;
    let newPasswordHash: string | null = null;
    let previousHash: string | null = null;
    let historyDepth = 0;

    if (claimable) {
      const target = existing ?? null;
      if (!body.password) {
        throw badRequest("Choose a password to accept this invitation.", {
          reasons: ["password is required"],
        });
      }
      // #25 — the inviting company's policy governs the password the invitee
      // chooses. For an account that already exists, every company it belongs
      // to has a say; strictest wins.
      const policy = target
        ? await effectivePolicyForUser(app.db, target.id)
        : resolvePolicies([await loadCompanyPolicy(app.db, invitation.companyId)]);
      const assessment = assessPasswordWithPolicy(
        body.password,
        {
          email: target?.email ?? invitation.email,
          name: body.name ?? target?.name ?? invitation.name,
        },
        policy,
      );
      if (!assessment.ok) {
        throw badRequest("Password does not meet the password policy.", {
          reasons: assessment.reasons,
        });
      }
      if (target) {
        const reuse = await isPasswordReused(
          app.db,
          target.id,
          body.password,
          policy.passwordHistoryDepth,
          target.passwordHash,
        );
        if (reuse.reused) {
          throw badRequest("Password does not meet the password policy.", {
            reasons: [reuse.reason ?? "That password has been used on this account before."],
          });
        }
        previousHash = target.passwordHash;
        historyDepth = policy.passwordHistoryDepth;
      }
      newPasswordHash = await hashPassword(app.appConfig, body.password);
      passwordSet = true;
      userId = target?.id ?? newId("u");
      userName = body.name ?? target?.name ?? invitation.name ?? invitation.email;
      userEmail = target?.email ?? invitation.email;
    } else {
      // Pre-existing account: prove it before it joins anything.
      if (!body.password || !(await verifyPassword(body.password, existing!.passwordHash))) {
        await recordAuthEvent(app.db, {
          kind: "invitation_accepted",
          outcome: "failure",
          companyId: invitation.companyId,
          userId: existing!.id,
          email: existing!.email,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          reason: "existing_account_password_required",
          metadata: { invitationId: invitation.id },
        });
        throw unauthorized(
          "This address already has an account. Provide its current password to accept.",
        );
      }
      userId = existing!.id;
      userName = existing!.name;
      userEmail = existing!.email;
    }

    const boundProjects: string[] = [];
    try {
      await app.db.transaction(async (tx) => {
        // 1. SPEND THE INVITATION. The conditional update on `status =
        //    pending` is the lock: exactly one concurrent accept changes a row.
        const claimed = await tx
          .update(userInvitations)
          .set({
            status: "accepted",
            acceptedAt: nowIso,
            acceptedUserId: userId,
            updatedAt: nowIso,
          })
          .where(
            and(eq(userInvitations.id, invitation.id), eq(userInvitations.status, "pending")),
          )
          .returning({ id: userInvitations.id });
        if (claimed.length === 0) {
          throw conflict("This invitation has already been accepted.");
        }

        // 2. The account.
        if (!existing) {
          await tx.insert(users).values({
            id: userId,
            email: invitation.email,
            name: userName,
            passwordHash: newPasswordHash!,
          });
        } else if (newPasswordHash) {
          await tx
            .update(users)
            .set({ passwordHash: newPasswordHash, name: userName, updatedAt: nowIso })
            .where(eq(users.id, userId));
        }

        // 3. The company membership and the role the invitation carries.
        const [membership] = await tx
          .select()
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, invitation.companyId),
              eq(companyMemberships.userId, userId),
            ),
          )
          .limit(1);
        if (membership) {
          if (membership.role !== invitation.role) {
            await tx
              .update(companyMemberships)
              .set({ role: invitation.role })
              .where(eq(companyMemberships.id, membership.id));
          }
        } else {
          await tx.insert(companyMemberships).values({
            id: newId("cm"),
            companyId: invitation.companyId,
            userId,
            role: invitation.role,
          });
        }

        // 4. Project access, when the invitation named projects and a template.
        const templateKey = invitation.templateKey;
        if (templateKey && invitation.projectIds.length > 0) {
          for (const projectId of invitation.projectIds) {
            const [project] = await tx
              .select({ id: projects.id })
              .from(projects)
              .where(and(eq(projects.id, projectId), eq(projects.companyId, invitation.companyId)))
              .limit(1);
            if (!project) continue;
            const [pm] = await tx
              .select({ id: projectMemberships.id })
              .from(projectMemberships)
              .where(
                and(
                  eq(projectMemberships.projectId, projectId),
                  eq(projectMemberships.userId, userId),
                ),
              )
              .limit(1);
            if (pm) continue;
            await tx.insert(projectMemberships).values({
              id: newId("pm"),
              companyId: invitation.companyId,
              projectId,
              userId,
              templateKey,
            });
            boundProjects.push(projectId);
          }
        }
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      // A unique violation from a genuinely concurrent registration of the
      // same address is a conflict, not an internal error.
      const message = err instanceof Error ? err.message : String(err);
      if (/unique|duplicate/i.test(message)) {
        throw conflict(
          "That address was registered while this invitation was being accepted. Sign in instead.",
        );
      }
      throw err;
    }

    if (previousHash && newPasswordHash) {
      await recordPasswordHistory(app.db, userId, previousHash, "invitation", historyDepth);
    }
    if (existing && newPasswordHash) {
      // The administrator was handed a temporary password for this account.
      // Setting a real one is the moment that credential stops working, so
      // anything already signed in with it is cut off here.
      await revokeAllUserSessions(app.db, userId, {
        reason: "password_changed",
        byUser: true,
        actorId: userId,
        includeOrphanTokens: true,
        nowMs,
      });
    }
    await appendLedger(app.db, {
      companyId: invitation.companyId,
      actorId: userId,
      action: "update",
      objectType: "user_invitation",
      objectId: invitation.id,
      payload: {
        acceptedUserId: userId,
        role: invitation.role,
        projects: boundProjects,
        passwordSet,
      },
      storePayload: true,
    });
    await recordAuthEvent(app.db, {
      kind: "invitation_accepted",
      companyId: invitation.companyId,
      userId,
      email: userEmail,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: {
        invitationId: invitation.id,
        role: invitation.role,
        invitedBy: invitation.invitedBy,
        passwordSet,
      },
    });

    const issued = await issueUserSession(app, ctx, {
      user: { id: userId, email: userEmail, name: userName },
      authMethod: "invitation",
      companyId: invitation.companyId,
    });
    const [company] = await app.db
      .select({ id: companies.id, name: companies.name, slug: companies.slug })
      .from(companies)
      .where(eq(companies.id, invitation.companyId))
      .limit(1);

    return reply.status(200).send({
      user: { id: userId, email: userEmail, name: userName },
      company: company ? { ...company, role: invitation.role } : null,
      invitation: { id: invitation.id, status: "accepted", role: invitation.role },
      projects: boundProjects,
      passwordSet,
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresIn: issued.expiresIn,
      session: issued.session,
    });
  });

  /* ================================================================ */
  /* Invitations — administration                                      */
  /* ================================================================ */

  app.get("/company/invitations", { preHandler: companyAdmin }, async (req) => {
    const q = z
      .object({
        status: z.enum(["pending", "accepted", "revoked", "expired"]).optional(),
      })
      .parse(req.query);
    const sweptExpired = await sweepExpiredInvitations(app, req.companyId!);
    const rows = await app.db
      .select()
      .from(userInvitations)
      .where(
        and(
          eq(userInvitations.companyId, req.companyId!),
          q.status ? eq(userInvitations.status, q.status) : undefined,
        ),
      )
      .orderBy(desc(userInvitations.createdAt));
    return { items: rows.map(invitationView), sweptExpired };
  });

  app.post("/company/invitations/:id/resend", { preHandler: companyAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const [invitation] = await app.db
      .select()
      .from(userInvitations)
      .where(
        and(eq(userInvitations.id, id), eq(userInvitations.companyId, req.companyId!)),
      )
      .limit(1);
    if (!invitation) throw notFound("Invitation not found");
    if (invitation.status !== "pending" || isExpired(invitation.expiresAt)) {
      throw conflict(
        `Only a pending invitation can be resent (this one is ${
          isExpired(invitation.expiresAt) ? "expired" : invitation.status
        }).`,
      );
    }

    // Resending REPLACES the link: the old token stops working the moment a
    // new one is minted, so a forwarded old message cannot be used later.
    const token = mintToken();
    const nowIso = new Date().toISOString();
    const [rotated] = await app.db
      .update(userInvitations)
      .set({
        tokenHash: token.hash,
        tokenPrefix: token.prefix,
        expiresAt: new Date(
          Date.now() + app.appConfig.INVITATION_TTL_DAYS * 24 * 3600 * 1000,
        ).toISOString(),
        updatedAt: nowIso,
      })
      .where(eq(userInvitations.id, invitation.id))
      .returning();

    const [company] = await app.db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, invitation.companyId))
      .limit(1);
    await appendLedger(app.db, {
      companyId: invitation.companyId,
      actorId: req.user!.id,
      action: "update",
      objectType: "user_invitation",
      objectId: invitation.id,
      payload: { resent: true, email: invitation.email, tokenRotated: true },
    });
    const createdAccount = await invitationCreatedAccount(app, invitation);
    const sent = await sendInvitation(app, requestContext(req), {
      invitation: rotated ?? invitation,
      rawToken: token.raw,
      inviterName: req.user!.name,
      companyName: company?.name ?? "your company",
      createdAccount,
    });
    return {
      invitation: invitationView(sent.invitation),
      delivery: sent.delivery,
      // Only for an account this invitation created, and only when nothing was
      // dispatched — see the accept route.
      acceptUrl: !sent.delivery.dispatched && createdAccount ? sent.acceptUrl : null,
    };
  });

  app.post("/company/invitations/:id/revoke", { preHandler: companyAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const [invitation] = await app.db
      .select()
      .from(userInvitations)
      .where(
        and(eq(userInvitations.id, id), eq(userInvitations.companyId, req.companyId!)),
      )
      .limit(1);
    if (!invitation) throw notFound("Invitation not found");
    if (invitation.status === "accepted") {
      throw conflict(
        "This invitation has already been accepted. Remove the membership instead.",
      );
    }
    const nowIso = new Date().toISOString();
    const [revoked] = await app.db
      .update(userInvitations)
      .set({
        status: "revoked",
        revokedAt: nowIso,
        revokedBy: req.user!.id,
        updatedAt: nowIso,
      })
      .where(eq(userInvitations.id, invitation.id))
      .returning();
    await appendLedger(app.db, {
      companyId: invitation.companyId,
      actorId: req.user!.id,
      action: "update",
      objectType: "user_invitation",
      objectId: invitation.id,
      payload: { status: "revoked", email: invitation.email },
    });
    await recordAuthEvent(app.db, {
      kind: "invitation_revoked",
      companyId: invitation.companyId,
      userId: req.user!.id,
      email: invitation.email,
      ...requestContext(req),
      metadata: { invitationId: invitation.id },
    });
    return { invitation: invitationView(revoked ?? invitation) };
  });

  /* ================================================================ */
  /* Changing the address on the account                               */
  /* ================================================================ */

  /**
   * Start an email change.
   *
   * `EMAIL_VERIFICATION_PURPOSES` has advertised `email_change` since the
   * table was written, and `VerifyEmailPage` told the user "the address change
   * on this account is now in force" — while nothing minted such a token and
   * nothing changed an address. The page asserted a change that had not
   * happened. This route is the missing half; `consumeVerificationToken` now
   * applies it (see verification.ts).
   *
   * THE ORDER MATTERS: `users.email` is not touched here. The new address is
   * proved first and applied on consumption, so a typo cannot lock anybody out
   * of their own account — which is exactly why `email_verifications.email`
   * holds the address BEING PROVED rather than the account's current one.
   */
  app.post("/account/email", { preHandler: signedIn }, async (req, reply) => {
    const body = z.object({ email: emailSchema, password: passwordSchema }).parse(req.body);
    const ctx = requestContext(req);
    const [user] = await app.db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
    if (!user) throw unauthorized("Unknown user");
    // The current password, because an address is the recovery channel: a
    // hijacked session that could move it owns the account for ever.
    if (!(await verifyPassword(body.password, user.passwordHash))) {
      await recordAuthEvent(app.db, {
        kind: "email_change_requested",
        outcome: "failure",
        userId: user.id,
        email: user.email,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        reason: "current_password_incorrect",
      });
      throw unauthorized("Current password is incorrect");
    }
    if (body.email === user.email) {
      throw badRequest("That is already the address on this account.");
    }
    const [taken] = await app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);
    if (taken) {
      // Deliberately explicit: the caller has already proved they hold THIS
      // account with a password, so this is not an enumeration oracle a
      // stranger can reach, and "your change silently did nothing" is worse.
      throw conflict("Another account already uses that address.");
    }
    const started = await startEmailVerification(app, ctx, {
      userId: user.id,
      email: body.email,
      name: user.name,
      purpose: "email_change",
    });
    return reply.status(202).send({
      status: started.status,
      pendingEmail: body.email,
      currentEmail: user.email,
      expiresAt: started.expiresAt,
      delivery: started.delivery,
      verifyUrl: started.verifyUrl,
      reasons: [
        "The address on the account does not change until the link in that message is opened.",
        ...started.reasons,
      ],
    });
  });

  /** What change, if any, is waiting to be proved. */
  app.get("/account/email/pending", { preHandler: signedIn }, async (req) => {
    const nowMs = Date.now();
    const rows = await app.db
      .select()
      .from(emailVerifications)
      .where(
        and(
          eq(emailVerifications.userId, req.user!.id),
          eq(emailVerifications.purpose, "email_change"),
        ),
      )
      .orderBy(desc(emailVerifications.createdAt))
      .limit(5);
    const live = rows.find((r) => !r.consumedAt && !isExpired(r.expiresAt, nowMs));
    return {
      pending: live ? { email: live.email, expiresAt: live.expiresAt, requestedAt: live.createdAt } : null,
      history: rows.map((r) => ({
        email: r.email,
        requestedAt: r.createdAt,
        consumedAt: r.consumedAt,
        expiresAt: r.expiresAt,
      })),
    };
  });

  /* ================================================================ */
  /* Company security administration and SCIM                          */
  /* ================================================================ */

  registerSecurityRoutes(app);
  registerScimRoutes(app);

  /* ================================================================ */
  /* Scheduled work                                                    */
  /*                                                                   */
  /* Everything here used to happen only when somebody opened the page  */
  /* that called the sweep. A platform whose product is the durability  */
  /* of its record cannot leave session expiry to a browser tab.        */
  /* ================================================================ */

  // The trail feeds the tenant's SIEM. Registered here rather than at module
  // scope so the subscription belongs to this app instance's lifetime.
  const removeHook = addSecurityEventHook(async (db, event) => {
    await enqueueSecurityEvent(db, {
      id: event.id,
      kind: event.kind,
      outcome: event.outcome ?? "success",
      at: event.at,
      companyId: event.companyId ?? null,
      userId: event.userId ?? null,
      email: event.email ?? null,
      sessionId: event.sessionId ?? null,
      providerId: event.providerId ?? null,
      ip: event.ip ?? null,
      userAgent: event.userAgent ?? null,
      reason: event.reason ?? null,
      metadata: event.metadata ?? {},
    });
  });
  app.addHook("onClose", async () => {
    removeHook();
  });

  app.scheduler.register({
    name: "account.session-sweep",
    description:
      "Mark sessions past their absolute lifetime as expired, and expire invitations nobody accepted",
    everyMs: 15 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => {
      const nowMs = now.getTime();
      const { authSessions } = await import("@constructos/db");
      const { isNull, lte: lteOp } = await import("drizzle-orm");
      const stale = await db
        .select({ id: authSessions.id })
        .from(authSessions)
        .where(
          and(isNull(authSessions.revokedAt), lteOp(authSessions.expiresAt, now.toISOString())),
        )
        .limit(5000);
      const sessions = await revokeSessions(db, stale.map((r) => r.id), {
        reason: "expired",
        byUser: false,
        actorId: null,
        nowMs,
      });
      const invitations = await forEachCompanySweep(async (companyId) =>
        sweepExpiredInvitations(app, companyId, nowMs),
      );
      return { sessionsExpired: sessions, invitationsExpired: invitations };
    },
  });

  app.scheduler.register({
    name: "account.security-webhooks",
    description: "Deliver queued security events to tenant SIEM endpoints, with backoff",
    everyMs: 60_000,
    run: async () => sweepSecurityWebhooks(app, { limit: 200 }),
  });

  app.scheduler.register({
    name: "account.trail-retention",
    description:
      "Apply each tenant's authentication-record retention policy: pseudonymise the trail, delete the message log, skip anyone on legal hold",
    everyMs: 24 * 3600_000,
    run: async ({ db, now }) => {
      const rows = await db.select({ id: companies.id }).from(companies);
      let pseudonymised = 0;
      let deleted = 0;
      let held = 0;
      for (const row of rows) {
        try {
          const outcome = await applyRetention(db, row.id, { nowMs: now.getTime() });
          if (outcome.skipped) {
            held += 1;
            continue;
          }
          pseudonymised += outcome.securityEventsPseudonymised;
          deleted += outcome.emailDispatchesDeleted;
        } catch {
          /* one tenant's retention must not stop the rest */
        }
      }
      return { pseudonymised, deleted, skipped: held };
    },
  });

  app.scheduler.register({
    name: "account.webhook-retention",
    description: "Drop security-webhook delivery records older than 30 days",
    everyMs: 24 * 3600_000,
    run: async ({ db, now }) => {
      const cutoff = new Date(now.getTime() - 30 * 24 * 3600_000).toISOString();
      const { lte: lteOp } = await import("drizzle-orm");
      const doomed = await db
        .select({ id: securityWebhookDeliveries.id })
        .from(securityWebhookDeliveries)
        .where(lteOp(securityWebhookDeliveries.createdAt, cutoff))
        .limit(5000);
      if (doomed.length === 0) return { deleted: 0 };
      const { inArray: inArrayOp } = await import("drizzle-orm");
      await db
        .delete(securityWebhookDeliveries)
        .where(inArrayOp(securityWebhookDeliveries.id, doomed.map((d) => d.id)));
      return { deleted: doomed.length };
    },
  });

  /** Run `fn` for every company, summing what each returns. */
  async function forEachCompanySweep(fn: (companyId: string) => Promise<number>): Promise<number> {
    const rows = await app.db.select({ id: companies.id }).from(companies);
    let total = 0;
    for (const row of rows) {
      try {
        total += await fn(row.id);
      } catch {
        /* one tenant's sweep must not stop the rest */
      }
    }
    return total;
  }
};
