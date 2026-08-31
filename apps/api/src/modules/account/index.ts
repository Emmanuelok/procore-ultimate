import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  authSecurityEvents,
  companies,
  companyMemberships,
  projectMemberships,
  projects,
  userInvitations,
  users,
} from "@constructos/db";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../../lib/errors.js";
import { isExpired } from "../../lib/time.js";
import { emailTransportFor } from "./mailer.js";
import { recordAuthEvent, recordLegacyAuthEvent } from "./events.js";
import {
  assessPassword,
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

  app.get("/account/password-policy", async () => ({
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    rules: [
      `At least ${PASSWORD_MIN_LENGTH} characters.`,
      "Not one of the most commonly used passwords.",
      "Must not contain the local part of your email address.",
      "Must not be your own name.",
    ],
  }));

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
    return { verified: true, email: consumed.email, purpose: consumed.purpose };
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
    const assessment = assessPassword(body.newPassword, {
      email: user.email,
      name: user.name,
    });
    if (!assessment.ok) {
      throw badRequest("Password does not meet the password policy.", {
        reasons: assessment.reasons,
      });
    }

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
    const claimable = !existing || (await invitationCreatedAccount(app, invitation));

    // The segregation rule: nobody accepts their own invitation into a role.
    if (existing && existing.id === invitation.invitedBy) {
      throw forbidden("The person who sent this invitation cannot accept it.");
    }

    let userId: string;
    let userName: string;
    let userEmail = invitation.email;
    let passwordSet = false;

    if (!existing) {
      if (!body.password) {
        throw badRequest("Choose a password to accept this invitation.", {
          reasons: ["password is required"],
        });
      }
      const assessment = assessPassword(body.password, {
        email: invitation.email,
        name: body.name ?? invitation.name,
      });
      if (!assessment.ok) {
        throw badRequest("Password does not meet the password policy.", {
          reasons: assessment.reasons,
        });
      }
      userId = newId("u");
      userName = body.name ?? invitation.name ?? invitation.email;
      await app.db.insert(users).values({
        id: userId,
        email: invitation.email,
        name: userName,
        passwordHash: await hashPassword(app.appConfig, body.password),
      });
      passwordSet = true;
    } else if (claimable) {
      if (!body.password) {
        throw badRequest("Choose a password to accept this invitation.", {
          reasons: ["password is required"],
        });
      }
      const assessment = assessPassword(body.password, {
        email: existing.email,
        name: body.name ?? existing.name,
      });
      if (!assessment.ok) {
        throw badRequest("Password does not meet the password policy.", {
          reasons: assessment.reasons,
        });
      }
      userId = existing.id;
      userName = body.name ?? existing.name;
      userEmail = existing.email;
      await app.db
        .update(users)
        .set({
          passwordHash: await hashPassword(app.appConfig, body.password),
          name: userName,
          updatedAt: new Date(nowMs).toISOString(),
        })
        .where(eq(users.id, existing.id));
      passwordSet = true;
      // The administrator was handed a temporary password for this account.
      // Setting a real one is the moment that credential stops working, so
      // anything already signed in with it is cut off here.
      await revokeAllUserSessions(app.db, existing.id, {
        reason: "password_changed",
        byUser: true,
        actorId: existing.id,
        includeOrphanTokens: true,
        nowMs,
      });
    } else {
      // Pre-existing account: prove it before it joins anything.
      if (!body.password || !(await verifyPassword(body.password, existing.passwordHash))) {
        await recordAuthEvent(app.db, {
          kind: "invitation_accepted",
          outcome: "failure",
          companyId: invitation.companyId,
          userId: existing.id,
          email: existing.email,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          reason: "existing_account_password_required",
          metadata: { invitationId: invitation.id },
        });
        throw unauthorized(
          "This address already has an account. Provide its current password to accept.",
        );
      }
      userId = existing.id;
      userName = existing.name;
      userEmail = existing.email;
    }

    // Bind the membership and the role the invitation carries.
    const [membership] = await app.db
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
        await app.db
          .update(companyMemberships)
          .set({ role: invitation.role })
          .where(eq(companyMemberships.id, membership.id));
      }
    } else {
      await app.db.insert(companyMemberships).values({
        id: newId("cm"),
        companyId: invitation.companyId,
        userId,
        role: invitation.role,
      });
    }

    // Project access, when the invitation named projects and a template.
    const boundProjects: string[] = [];
    if (invitation.templateKey && invitation.projectIds.length > 0) {
      for (const projectId of invitation.projectIds) {
        const [project] = await app.db
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(eq(projects.id, projectId), eq(projects.companyId, invitation.companyId)),
          )
          .limit(1);
        if (!project) continue;
        const [pm] = await app.db
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
        await app.db.insert(projectMemberships).values({
          id: newId("pm"),
          companyId: invitation.companyId,
          projectId,
          userId,
          templateKey: invitation.templateKey,
        });
        boundProjects.push(projectId);
      }
    }

    // Single use, enforced by the update itself: two simultaneous clicks
    // cannot both win, because only one of them changes a pending row.
    const claimed = await app.db
      .update(userInvitations)
      .set({
        status: "accepted",
        acceptedAt: new Date(nowMs).toISOString(),
        acceptedUserId: userId,
        updatedAt: new Date(nowMs).toISOString(),
      })
      .where(
        and(eq(userInvitations.id, invitation.id), eq(userInvitations.status, "pending")),
      )
      .returning({ id: userInvitations.id });
    if (claimed.length === 0) {
      throw conflict("This invitation has already been accepted.");
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
};
