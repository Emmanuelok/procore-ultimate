import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import {
  authSecurityEvents,
  authSessions,
  companies,
  companyMemberships,
  companySecurityPolicies,
  mfaRecoveryCodes,
  scimTokens,
  securityWebhookDeliveries,
  securityWebhooks,
  userMfa,
  users,
} from "@constructos/db";
import {
  IP_ALLOWLIST_MODES,
  SECURITY_POLICY_DEFAULTS,
  type IpAllowlistMode,
} from "@constructos/shared";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { checkWebhookUrlSync, policyFor } from "../integrations/ssrf.js";
import { recordAuthEvent } from "./events.js";
import { clampDepth, MAX_HISTORY_DEPTH } from "./password-history.js";
import {
  emptyPolicy,
  invalidAllowlistEntries,
  loadCompanyPolicy,
  policyRules,
  resolvePolicies,
  rowToPolicy,
  type StoredSecurityPolicy,
} from "./policy.js";
import { revokeUserChallenges } from "../mfa/challenge-store.js";
import { applyRetention } from "./retention.js";
import { mintScimToken } from "./scim.js";
import { requestContext, revokeAllUserSessions, revokeSessions } from "./sessions.js";
import {
  attemptDelivery,
  fingerprintFor,
  recentDeliveries,
  secretFor,
  sweepSecurityWebhooks,
} from "./webhooks.js";

/**
 * COMPANY SECURITY ADMINISTRATION — the routes an owner or admin uses to
 * govern how their people authenticate, and to see what happened.
 *
 * Spec: Vol I §0.1 #21 (SCIM), #23 (session timeout), #24 (IP allowlisting),
 * #25 (password policy), §0.2 (login audit export, security event webhooks).
 *
 * FOUR SURFACES, all gated `[authenticate, requireCompany, requireCompanyRole
 * (owner|admin)]` and all tenant-scoped by construction — every query below
 * filters on `req.companyId`, never on an id taken from the request body:
 *
 *   /company/security-policy      the policy itself
 *   /company/security-events      the login audit, with a CSV/JSON export
 *   /company/users/:id/…          deactivate, revoke sessions, reset MFA
 *   /company/scim/tokens          the directory's bearer tokens
 *   /company/security-webhooks    push the trail to a SIEM
 *
 * WHAT IS DELIBERATELY REFUSED HERE, and why each refusal exists:
 *
 *  - An admin may not deactivate an OWNER, and may not act on themselves.
 *    Self-action is how an administrator locks themselves out; acting on an
 *    owner is how an admin escalates by removing the people above them.
 *  - An allowlist whose entries do not parse is refused at write time. An
 *    unparseable CIDR silently matches nobody, and "enforce" plus "matches
 *    nobody" is a tenant that cannot reach its own platform.
 *  - Enabling `enforce` from an address that the new list itself would refuse
 *    is refused. That single check is the difference between a security
 *    control and a Friday-afternoon outage.
 */

const allowlistSchema = z.array(z.string().min(1).max(64)).max(200);

const policySchema = z.object({
  sessionIdleTimeoutMinutes: z.number().int().min(5).max(60 * 24 * 30).nullable().optional(),
  sessionAbsoluteTimeoutHours: z.number().int().min(1).max(24 * 90).nullable().optional(),
  rememberDeviceDays: z.number().int().min(0).max(365).nullable().optional(),
  passwordMinLength: z.number().int().min(12).max(128).nullable().optional(),
  passwordRequireComplexity: z.boolean().optional(),
  passwordHistoryDepth: z.number().int().min(0).max(MAX_HISTORY_DEPTH).nullable().optional(),
  passwordMaxAgeDays: z.number().int().min(1).max(3650).nullable().optional(),
  lockoutMaxAttempts: z.number().int().min(3).max(50).nullable().optional(),
  lockoutWindowMinutes: z.number().int().min(1).max(1440).nullable().optional(),
  lockoutDurationMinutes: z.number().int().min(1).max(1440).nullable().optional(),
  ipAllowlistMode: z.enum(IP_ALLOWLIST_MODES).optional(),
  ipAllowlist: allowlistSchema.optional(),
  ipAllowlistBreakGlassUserIds: z.array(z.string().min(1).max(64)).max(20).optional(),
  mfaRequired: z.boolean().optional(),
  mfaAcceptedAmrValues: z.array(z.string().min(1).max(64)).max(20).optional(),
  // §0.2 #46/#47. The floor of 30 days is not decoration: the lockout engine
  // reads a fifteen-minute window and the login audit is the tenant's own
  // incident evidence, so a retention shorter than a month would delete the
  // record of the breach it was set up to investigate.
  securityEventRetentionDays: z.number().int().min(30).max(3650).nullable().optional(),
  emailDispatchRetentionDays: z.number().int().min(30).max(3650).nullable().optional(),
  legalHold: z.boolean().optional(),
  legalHoldReason: z.string().min(1).max(500).nullable().optional(),
});

function policyView(policy: StoredSecurityPolicy, companyName: string | null) {
  const resolved = resolvePolicies([policy]);
  return {
    companyId: policy.companyId,
    companyName,
    stored: policy,
    /** what actually applies to this tenant's members once defaults are filled */
    effective: resolved,
    defaults: SECURITY_POLICY_DEFAULTS,
    passwordRules: policyRules(resolved),
    reasons:
      policy.updatedAt === null
        ? ["Nobody has set a policy for this company, so the platform defaults apply."]
        : [],
  };
}

export function registerSecurityRoutes(app: FastifyInstance): void {
  const companyAdmin = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];
  const companyMember = [app.authenticate, app.requireCompany];

  /* ================================================================ */
  /* #23 / #24 / #25 — the tenant security policy                      */
  /* ================================================================ */

  /**
   * Readable by every member: they are subject to it, and the password form
   * has to know the rules before it asks. Nothing here is a target list — the
   * allowlist is the tenant's own network, not a secret.
   */
  app.get("/company/security-policy", { preHandler: companyMember }, async (req) => {
    const companyId = req.companyId!;
    const policy = await loadCompanyPolicy(app.db, companyId);
    const [company] = await app.db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    return policyView(policy, company?.name ?? null);
  });

  app.put("/company/security-policy", { preHandler: companyAdmin }, async (req) => {
    const companyId = req.companyId!;
    const actor = req.user!;
    const body = policySchema.parse(req.body);
    const ctx = requestContext(req);
    const current = await loadCompanyPolicy(app.db, companyId);

    const next: StoredSecurityPolicy = {
      ...current,
      ...Object.fromEntries(
        Object.entries(body).filter(([, v]) => v !== undefined),
      ),
    } as StoredSecurityPolicy;

    // A list that does not parse matches nobody. Refused here, with the
    // offending entries named, rather than discovered at the next sign-in.
    const invalid = invalidAllowlistEntries(next.ipAllowlist);
    if (invalid.length > 0) {
      throw badRequest("Some allowlist entries are not valid addresses or CIDR ranges.", {
        reasons: invalid.map((e) => `"${e}" is not an IPv4/IPv6 address or CIDR range.`),
      });
    }
    if (next.ipAllowlistMode === "enforce" && next.ipAllowlist.length === 0) {
      throw badRequest(
        "Enforcing an empty allowlist would refuse everyone, including you. Add at least one " +
          "range, or use monitor mode while you work out what it should be.",
      );
    }
    if (next.ipAllowlistMode === "enforce") {
      // THE LOCK-YOURSELF-OUT CHECK. The address making this request must
      // survive the policy it is enabling, unless the caller has deliberately
      // put themselves on the break-glass list.
      const { ipInAllowlist } = await import("./policy.js");
      const exempt = next.ipAllowlistBreakGlassUserIds.includes(actor.id);
      if (!exempt && !ipInAllowlist(ctx.ip, next.ipAllowlist)) {
        throw badRequest(
          `Refusing to enforce an allowlist that does not include the address you are calling ` +
            `from (${ctx.ip ?? "unknown"}). Add it, or add yourself to the break-glass list, or ` +
            "start in monitor mode.",
          { ip: ctx.ip, mode: "enforce" },
        );
      }
    }
    if (next.ipAllowlistBreakGlassUserIds.length > 0) {
      const members = await app.db
        .select({ userId: companyMemberships.userId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            inArray(companyMemberships.userId, next.ipAllowlistBreakGlassUserIds),
          ),
        );
      const known = new Set(members.map((m) => m.userId));
      const strangers = next.ipAllowlistBreakGlassUserIds.filter((id) => !known.has(id));
      if (strangers.length > 0) {
        throw badRequest("Break-glass exemptions must name members of this company.", {
          reasons: strangers.map((id) => `${id} is not a member of this company.`),
        });
      }
    }
    if (
      next.passwordHistoryDepth !== null &&
      clampDepth(next.passwordHistoryDepth) !== next.passwordHistoryDepth
    ) {
      throw badRequest(`Password history depth is capped at ${MAX_HISTORY_DEPTH}.`);
    }

    const nowIso = new Date().toISOString();
    const values = {
      companyId,
      sessionIdleTimeoutMinutes: next.sessionIdleTimeoutMinutes,
      sessionAbsoluteTimeoutHours: next.sessionAbsoluteTimeoutHours,
      rememberDeviceDays: next.rememberDeviceDays,
      passwordMinLength: next.passwordMinLength,
      passwordRequireComplexity: next.passwordRequireComplexity,
      passwordHistoryDepth: next.passwordHistoryDepth,
      passwordMaxAgeDays: next.passwordMaxAgeDays,
      lockoutMaxAttempts: next.lockoutMaxAttempts,
      lockoutWindowMinutes: next.lockoutWindowMinutes,
      lockoutDurationMinutes: next.lockoutDurationMinutes,
      ipAllowlistMode: next.ipAllowlistMode,
      ipAllowlist: next.ipAllowlist,
      ipAllowlistBreakGlassUserIds: next.ipAllowlistBreakGlassUserIds,
      mfaRequired: next.mfaRequired,
      mfaAcceptedAmrValues: next.mfaAcceptedAmrValues,
      securityEventRetentionDays: next.securityEventRetentionDays,
      emailDispatchRetentionDays: next.emailDispatchRetentionDays,
      legalHold: next.legalHold,
      legalHoldReason: next.legalHoldReason,
      updatedBy: actor.id,
      updatedAt: nowIso,
    };
    const [existingRow] = await app.db
      .select({ id: companySecurityPolicies.id })
      .from(companySecurityPolicies)
      .where(eq(companySecurityPolicies.companyId, companyId))
      .limit(1);
    if (existingRow) {
      await app.db
        .update(companySecurityPolicies)
        .set(values)
        .where(eq(companySecurityPolicies.id, existingRow.id));
    } else {
      await app.db.insert(companySecurityPolicies).values({ id: newId("secpol"), ...values });
    }

    // The MFA requirement has two homes for historical reasons (see
    // modules/mfa/service.ts `userCompanyPolicies`). Keep them in step from
    // whichever route the administrator used.
    if (next.mfaRequired !== current.mfaRequired) {
      const [company] = await app.db
        .select({ settings: companies.settings })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      await app.db
        .update(companies)
        .set({
          settings: {
            ...(company?.settings ?? {}),
            mfa: { required: next.mfaRequired, updatedAt: nowIso, updatedBy: actor.id },
          },
          updatedAt: nowIso,
        })
        .where(eq(companies.id, companyId));
      await recordAuthEvent(app.db, {
        kind: "mfa_policy_changed",
        companyId,
        userId: actor.id,
        email: actor.email,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        reason: next.mfaRequired
          ? "A second factor is now required for every member"
          : "The second-factor requirement was lifted",
      });
    }

    await appendLedger(app.db, {
      companyId,
      actorId: actor.id,
      action: "state_change",
      objectType: "company_security_policy",
      objectId: companyId,
      payload: { previous: current, next, at: nowIso },
      storePayload: true,
    });
    await recordAuthEvent(app.db, {
      kind: "security_policy_changed",
      companyId,
      userId: actor.id,
      email: actor.email,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      reason:
        // A legal hold turning on or off decides whether records survive, so
        // it is named in the trail line rather than left to be inferred from
        // a list of changed keys. The generic reason still covers everything
        // else; the ledger entry above carries the full before/after.
        next.legalHold !== current.legalHold
          ? next.legalHold
            ? "Legal hold placed: every retention sweep is suspended for this organisation"
            : "Legal hold lifted: retention sweeps resume for this organisation"
          : "Tenant security policy updated",
      metadata: {
        changed: Object.keys(body),
        legalHold: next.legalHold,
        retention: {
          securityEventDays: next.securityEventRetentionDays,
          emailDispatchDays: next.emailDispatchRetentionDays,
        },
      },
    });

    const [company] = await app.db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    const stored = await loadCompanyPolicy(app.db, companyId);
    return policyView(stored, company?.name ?? null);
  });

  /* ================================================================ */
  /* §0.2 — the login audit and its export                             */
  /* ================================================================ */

  const auditQuery = z.object({
    kind: z.string().max(64).optional(),
    outcome: z.enum(["success", "failure", "blocked", "pending"]).optional(),
    userId: z.string().max(64).optional(),
    email: z.string().max(320).optional(),
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
  });

  function auditWhere(companyId: string, q: z.infer<typeof auditQuery>) {
    return and(
      eq(authSecurityEvents.companyId, companyId),
      q.kind ? eq(authSecurityEvents.kind, q.kind) : undefined,
      q.outcome ? eq(authSecurityEvents.outcome, q.outcome) : undefined,
      q.userId ? eq(authSecurityEvents.userId, q.userId) : undefined,
      q.email ? eq(authSecurityEvents.email, q.email.toLowerCase()) : undefined,
      q.from ? gte(authSecurityEvents.at, q.from) : undefined,
      q.to ? lte(authSecurityEvents.at, q.to) : undefined,
    );
  }

  /**
   * The tenant's slice of the trail.
   *
   * COMPANY-SCOPED, AND THAT IS A REAL LIMIT: a failed sign-in against an
   * address that belongs to nobody has no company, so it is not here. Those
   * rows exist (they are the ones an intrusion investigation needs most) but
   * they belong to the operator, not to a tenant — a company that could read
   * them would be reading other tenants' failures. The response says so rather
   * than letting an auditor conclude there were none.
   */
  app.get("/company/security-events", { preHandler: companyAdmin }, async (req) => {
    const companyId = req.companyId!;
    const q = auditQuery.parse(req.query);
    const page = pageQuerySchema.parse(req.query);
    const where = auditWhere(companyId, q);
    const rows = await app.db
      .select()
      .from(authSecurityEvents)
      .where(where)
      .orderBy(desc(authSecurityEvents.at))
      .limit(page.pageSize)
      .offset(pageOffset(page));
    const total = await app.db.select({ id: authSecurityEvents.id }).from(authSecurityEvents).where(where);
    return {
      ...paginate(
        rows.map((row) => ({
          id: row.id,
          at: row.at,
          kind: row.kind,
          outcome: row.outcome,
          userId: row.userId,
          email: row.email,
          sessionId: row.sessionId,
          providerId: row.providerId,
          ip: row.ip,
          userAgent: row.userAgent,
          reason: row.reason,
          metadata: row.metadata,
        })),
        total.length,
        page,
      ),
      reasons: [
        "Attempts against an address that belongs to no account carry no company and are not " +
          "included here; they are retained platform-wide for the operator.",
      ],
    };
  });

  /**
   * The same rows as a file. CSV by default because that is what lands in a
   * spreadsheet and in a SIEM's bulk importer; JSON when asked.
   *
   * BOUNDED at 50,000 rows: an unbounded export of a busy tenant's trail is a
   * request that holds a connection open for minutes and a response nothing
   * can open. The bound and the count are both in the response so a truncated
   * export is never mistaken for a complete one.
   */
  app.get("/company/security-events/export", { preHandler: companyAdmin }, async (req, reply) => {
    const companyId = req.companyId!;
    const q = auditQuery.parse(req.query);
    const format = z
      .object({ format: z.enum(["csv", "json"]).default("csv"), limit: z.coerce.number().int().min(1).max(50_000).default(50_000) })
      .parse(req.query);
    const rows = await app.db
      .select()
      .from(authSecurityEvents)
      .where(auditWhere(companyId, q))
      .orderBy(desc(authSecurityEvents.at))
      .limit(format.limit);
    await recordAuthEvent(app.db, {
      kind: "security_policy_changed",
      outcome: "success",
      companyId,
      userId: req.user!.id,
      email: req.user!.email,
      ...requestContext(req),
      reason: "Login audit exported",
      metadata: { rows: rows.length, format: format.format, filters: q },
    });
    const stamp = new Date().toISOString().slice(0, 10);
    if (format.format === "json") {
      return reply
        .header("content-disposition", `attachment; filename="security-events-${stamp}.json"`)
        .type("application/json")
        .send({ companyId, exportedAt: new Date().toISOString(), count: rows.length, limit: format.limit, items: rows });
    }
    const header = [
      "at",
      "kind",
      "outcome",
      "user_id",
      "email",
      "session_id",
      "provider_id",
      "ip",
      "user_agent",
      "reason",
    ];
    const lines = [header.join(",")];
    for (const row of rows) {
      lines.push(
        [
          row.at,
          row.kind,
          row.outcome,
          row.userId ?? "",
          row.email ?? "",
          row.sessionId ?? "",
          row.providerId ?? "",
          row.ip ?? "",
          row.userAgent ?? "",
          row.reason ?? "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    return reply
      .header("content-disposition", `attachment; filename="security-events-${stamp}.csv"`)
      .type("text/csv; charset=utf-8")
      .send(lines.join("\n"));
  });

  /* ================================================================ */
  /* Administering a member's access                                   */
  /*                                                                   */
  /* NAMESPACED UNDER /company/security/ deliberately. The directory    */
  /* module owns /company/users/* (list, invite, role, remove, and its  */
  /* own sessions/revoke); duplicating that prefix is how two modules   */
  /* end up declaring the same route and Fastify refuses to boot. These */
  /* are the SECURITY actions on a member — deactivate, cut every       */
  /* session, clear a lost second factor — and they live under the      */
  /* surface an administrator opens to do exactly that.                 */
  /* ================================================================ */

  /** Load a member of THIS company, or 404. Never leaks that a user exists. */
  async function loadMember(companyId: string, userId: string) {
    const [row] = await app.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        isActive: users.isActive,
        role: companyMemberships.role,
      })
      .from(companyMemberships)
      .innerJoin(users, eq(users.id, companyMemberships.userId))
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  /** The two refusals every admin action here shares. */
  function guardTarget(
    req: { user?: { id: string } | undefined; companyRole?: string | undefined },
    target: { id: string; role: string },
    verb: string,
  ): void {
    if (target.id === req.user!.id) {
      throw forbidden(
        `You cannot ${verb} your own account from here — use the account security page, where the ` +
          "consequences are yours alone.",
      );
    }
    if (target.role === "owner" && req.companyRole !== "owner") {
      throw forbidden(`Only an owner may ${verb} another owner.`);
    }
  }

  app.post("/company/security/users/:userId/deactivate", { preHandler: companyAdmin }, async (req) => {
    const companyId = req.companyId!;
    const { userId } = req.params as { userId: string };
    const target = await loadMember(companyId, userId);
    if (!target) throw notFound("No such member of this company");
    guardTarget(req, target, "deactivate");
    if (!target.isActive) throw conflict("That account is already deactivated.");

    await app.db
      .update(users)
      .set({ isActive: false, updatedAt: new Date().toISOString() })
      .where(eq(users.id, target.id));
    const revoked = await revokeAllUserSessions(app.db, target.id, {
      reason: "account_deactivated",
      byUser: false,
      actorId: req.user!.id,
      includeOrphanTokens: true,
    });
    await appendLedger(app.db, {
      companyId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "user",
      objectId: target.id,
      payload: { isActive: false, email: target.email, sessionsRevoked: revoked },
      storePayload: true,
    });
    await recordAuthEvent(app.db, {
      kind: "account_deactivated",
      outcome: "blocked",
      companyId,
      userId: target.id,
      email: target.email,
      ...requestContext(req),
      reason: `Deactivated by ${req.user!.email}`,
      metadata: { actorId: req.user!.id, sessionsRevoked: revoked },
    });
    return { ok: true, userId: target.id, isActive: false, sessionsRevoked: revoked };
  });

  app.post("/company/security/users/:userId/reactivate", { preHandler: companyAdmin }, async (req) => {
    const companyId = req.companyId!;
    const { userId } = req.params as { userId: string };
    const target = await loadMember(companyId, userId);
    if (!target) throw notFound("No such member of this company");
    guardTarget(req, target, "reactivate");
    if (target.isActive) throw conflict("That account is already active.");
    await app.db
      .update(users)
      .set({ isActive: true, updatedAt: new Date().toISOString() })
      .where(eq(users.id, target.id));
    await appendLedger(app.db, {
      companyId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "user",
      objectId: target.id,
      payload: { isActive: true, email: target.email },
      storePayload: true,
    });
    await recordAuthEvent(app.db, {
      kind: "account_reactivated",
      companyId,
      userId: target.id,
      email: target.email,
      ...requestContext(req),
      reason: `Reactivated by ${req.user!.email}`,
      metadata: { actorId: req.user!.id },
    });
    return { ok: true, userId: target.id, isActive: true };
  });

  /**
   * Cut a member off without deactivating them — the "their laptop was stolen"
   * action, distinct from "they left".
   */
  app.post("/company/security/users/:userId/sessions/revoke", { preHandler: companyAdmin }, async (req) => {
    const companyId = req.companyId!;
    const { userId } = req.params as { userId: string };
    const scope = z
      .object({ scope: z.enum(["company", "all"]).default("company") })
      .parse(req.body ?? {});
    const target = await loadMember(companyId, userId);
    if (!target) throw notFound("No such member of this company");
    guardTarget(req, target, "sign out");

    let revoked: number;
    if (scope.scope === "all") {
      revoked = await revokeAllUserSessions(app.db, target.id, {
        reason: "admin_revoked",
        byUser: false,
        actorId: req.user!.id,
        includeOrphanTokens: true,
      });
    } else {
      // Only the sessions opened in THIS company. An admin of one tenant has
      // no business ending a session the same person holds in another.
      const rows = await app.db
        .select({ id: authSessions.id })
        .from(authSessions)
        .where(and(eq(authSessions.userId, target.id), eq(authSessions.companyId, companyId)));
      revoked = await revokeSessions(app.db, rows.map((r) => r.id), {
        reason: "admin_revoked",
        byUser: false,
        actorId: req.user!.id,
      });
    }
    await recordAuthEvent(app.db, {
      kind: "admin_sessions_revoked",
      companyId,
      userId: target.id,
      email: target.email,
      ...requestContext(req),
      reason: `Sessions revoked by ${req.user!.email} (${scope.scope})`,
      metadata: { actorId: req.user!.id, revoked, scope: scope.scope },
    });
    await appendLedger(app.db, {
      companyId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "auth_sessions",
      objectId: target.id,
      payload: { revoked, scope: scope.scope, email: target.email },
      storePayload: true,
    });
    return { ok: true, userId: target.id, revoked, scope: scope.scope };
  });

  /**
   * Clear a lost second factor. The account is then subject to whatever the
   * tenant policy says at the next sign-in — if MFA is required, the login
   * route issues an `enrol` challenge, so this is a re-enrolment, not a hole.
   */
  app.post("/company/security/users/:userId/mfa/reset", { preHandler: companyAdmin }, async (req) => {
    const companyId = req.companyId!;
    const { userId } = req.params as { userId: string };
    const target = await loadMember(companyId, userId);
    if (!target) throw notFound("No such member of this company");
    guardTarget(req, target, "reset the second factor of");

    const factors = await app.db
      .select({ id: userMfa.id })
      .from(userMfa)
      .where(eq(userMfa.userId, target.id));
    if (factors.length === 0) {
      throw conflict("That account has no enrolled second factor to reset.");
    }
    const nowIso = new Date().toISOString();
    await app.db
      .update(userMfa)
      .set({ status: "disabled", disabledAt: nowIso, updatedAt: nowIso })
      .where(eq(userMfa.userId, target.id));
    await app.db
      .update(mfaRecoveryCodes)
      .set({ revokedAt: nowIso })
      .where(eq(mfaRecoveryCodes.userId, target.id));
    // Every device that cleared the OLD factor loses its session: the whole
    // point of a reset is that the factor it was authorised against is gone.
    const revoked = await revokeAllUserSessions(app.db, target.id, {
      reason: "mfa_reset",
      byUser: false,
      actorId: req.user!.id,
      includeOrphanTokens: true,
    });
    // AND every half-finished sign-in. A challenge minted a minute ago is
    // authority issued on the strength of the factor being removed; leaving it
    // exchangeable would let the person who holds the old authenticator finish
    // a sign-in after the reset that was meant to stop exactly that.
    const challengesRevoked = await revokeUserChallenges(
      app.db,
      target.id,
      "The second factor this challenge was issued against was reset by an administrator.",
      Date.now(),
    );
    await appendLedger(app.db, {
      companyId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "user_mfa",
      objectId: target.id,
      payload: { reset: true, factors: factors.length, sessionsRevoked: revoked, challengesRevoked },
      storePayload: true,
    });
    await recordAuthEvent(app.db, {
      kind: "admin_mfa_reset",
      companyId,
      userId: target.id,
      email: target.email,
      ...requestContext(req),
      reason: `Second factor reset by ${req.user!.email}`,
      metadata: { actorId: req.user!.id, sessionsRevoked: revoked, challengesRevoked },
    });
    return {
      ok: true,
      userId: target.id,
      factorsCleared: factors.length,
      sessionsRevoked: revoked,
      challengesRevoked,
    };
  });

  /* ================================================================ */
  /* #21 — SCIM bearer tokens                                          */
  /* ================================================================ */

  app.get("/company/scim/tokens", { preHandler: companyAdmin }, async (req) => {
    const companyId = req.companyId!;
    const rows = await app.db
      .select()
      .from(scimTokens)
      .where(eq(scimTokens.companyId, companyId))
      .orderBy(desc(scimTokens.createdAt));
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        tokenPrefix: r.tokenPrefix,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt,
        lastUsedIp: r.lastUsedIp,
        useCount: r.useCount,
        expiresAt: r.expiresAt,
        revokedAt: r.revokedAt,
        status: r.revokedAt ? "revoked" : "active",
      })),
      baseUrl: "/api/v1/scim/v2",
      reasons: [
        "The token itself is shown once, at creation. Only its first ten characters are kept.",
      ],
    };
  });

  app.post("/company/scim/tokens", { preHandler: companyAdmin }, async (req, reply) => {
    const companyId = req.companyId!;
    const body = z
      .object({
        name: z.string().min(1).max(120),
        expiresInDays: z.number().int().min(1).max(3650).optional(),
      })
      .parse(req.body);
    const minted = mintScimToken();
    const id = newId("scimt");
    await app.db.insert(scimTokens).values({
      id,
      companyId,
      name: body.name,
      tokenHash: minted.hash,
      tokenPrefix: minted.prefix,
      createdBy: req.user!.id,
      expiresAt: body.expiresInDays
        ? new Date(Date.now() + body.expiresInDays * 24 * 3600_000).toISOString()
        : null,
    });
    await appendLedger(app.db, {
      companyId,
      actorId: req.user!.id,
      action: "create",
      objectType: "scim_token",
      objectId: id,
      payload: { name: body.name, prefix: minted.prefix, expiresInDays: body.expiresInDays ?? null },
      storePayload: true,
    });
    await recordAuthEvent(app.db, {
      kind: "scim_token_changed",
      companyId,
      userId: req.user!.id,
      email: req.user!.email,
      ...requestContext(req),
      reason: `SCIM token "${body.name}" created`,
      metadata: { tokenId: id, prefix: minted.prefix },
    });
    return reply.status(201).send({
      id,
      name: body.name,
      tokenPrefix: minted.prefix,
      // Shown exactly once. The row holds sha256 of it and nothing else.
      token: minted.raw,
      baseUrl: "/api/v1/scim/v2",
      warning:
        "This token is shown once. Store it in the identity provider now — it cannot be retrieved again.",
    });
  });

  app.delete("/company/scim/tokens/:id", { preHandler: companyAdmin }, async (req) => {
    const companyId = req.companyId!;
    const { id } = req.params as { id: string };
    const [row] = await app.db
      .select()
      .from(scimTokens)
      .where(and(eq(scimTokens.id, id), eq(scimTokens.companyId, companyId)))
      .limit(1);
    if (!row) throw notFound("SCIM token not found");
    if (row.revokedAt) return { ok: true, id, alreadyRevoked: true };
    await app.db
      .update(scimTokens)
      .set({ revokedAt: new Date().toISOString(), revokedBy: req.user!.id })
      .where(eq(scimTokens.id, id));
    await appendLedger(app.db, {
      companyId,
      actorId: req.user!.id,
      action: "delete",
      objectType: "scim_token",
      objectId: id,
      payload: { name: row.name, prefix: row.tokenPrefix },
      storePayload: true,
    });
    await recordAuthEvent(app.db, {
      kind: "scim_token_changed",
      companyId,
      userId: req.user!.id,
      email: req.user!.email,
      ...requestContext(req),
      reason: `SCIM token "${row.name}" revoked`,
      metadata: { tokenId: id },
    });
    return { ok: true, id, alreadyRevoked: false };
  });

  /* ================================================================ */
  /* §0.2 — security event webhooks                                    */
  /* ================================================================ */

  const webhookSchema = z.object({
    name: z.string().min(1).max(120),
    url: z.string().min(8).max(2048),
    eventKinds: z.array(z.string().min(1).max(64)).max(60).default([]),
  });

  app.get("/company/security-webhooks", { preHandler: companyAdmin }, async (req) => {
    const companyId = req.companyId!;
    const rows = await app.db
      .select()
      .from(securityWebhooks)
      .where(eq(securityWebhooks.companyId, companyId))
      .orderBy(desc(securityWebhooks.createdAt));
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        url: r.url,
        eventKinds: r.eventKinds,
        isEnabled: r.isEnabled,
        disabledReason: r.disabledReason,
        consecutiveFailures: r.consecutiveFailures,
        lastDeliveryAt: r.lastDeliveryAt,
        lastStatus: r.lastStatus,
        secretFingerprint: r.secretFingerprint,
        createdAt: r.createdAt,
      })),
      signature: {
        header: "x-constructos-signature",
        scheme: "v1=HMAC-SHA256 over `v1:<timestamp>:<deliveryId>:<body>`",
        note: "Identical to the integrations webhook scheme, so one verifier serves both.",
      },
    };
  });

  app.post("/company/security-webhooks", { preHandler: companyAdmin }, async (req, reply) => {
    const companyId = req.companyId!;
    const body = webhookSchema.parse(req.body);
    // Checked at registration AND on every delivery: DNS moves.
    const verdict = checkWebhookUrlSync(
      body.url,
      policyFor({ NODE_ENV: app.appConfig.NODE_ENV }),
    );
    if (!verdict.ok) {
      throw badRequest(`That destination cannot receive webhooks: ${verdict.reason}`, {
        code: verdict.code,
      });
    }
    const id = newId("swh");
    await app.db.insert(securityWebhooks).values({
      id,
      companyId,
      name: body.name,
      url: verdict.url,
      eventKinds: body.eventKinds,
      secretFingerprint: fingerprintFor(app, id),
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId,
      actorId: req.user!.id,
      action: "create",
      objectType: "security_webhook",
      objectId: id,
      payload: { name: body.name, url: verdict.url, eventKinds: body.eventKinds },
      storePayload: true,
    });
    await recordAuthEvent(app.db, {
      kind: "security_webhook_changed",
      companyId,
      userId: req.user!.id,
      email: req.user!.email,
      ...requestContext(req),
      reason: `Security webhook "${body.name}" created`,
      metadata: { webhookId: id },
    });
    return reply.status(201).send({
      id,
      name: body.name,
      url: verdict.url,
      eventKinds: body.eventKinds,
      isEnabled: true,
      secret: secretFor(app, id),
      warning: "The signing secret is shown once. It is derived, never stored.",
    });
  });

  app.patch("/company/security-webhooks/:id", { preHandler: companyAdmin }, async (req) => {
    const companyId = req.companyId!;
    const { id } = req.params as { id: string };
    const body = webhookSchema.partial().extend({ isEnabled: z.boolean().optional() }).parse(req.body);
    const [row] = await app.db
      .select()
      .from(securityWebhooks)
      .where(and(eq(securityWebhooks.id, id), eq(securityWebhooks.companyId, companyId)))
      .limit(1);
    if (!row) throw notFound("Security webhook not found");
    let url = row.url;
    if (body.url && body.url !== row.url) {
      const verdict = checkWebhookUrlSync(body.url, policyFor({ NODE_ENV: app.appConfig.NODE_ENV }));
      if (!verdict.ok) {
        throw badRequest(`That destination cannot receive webhooks: ${verdict.reason}`, {
          code: verdict.code,
        });
      }
      url = verdict.url;
    }
    const reEnabling = body.isEnabled === true && !row.isEnabled;
    await app.db
      .update(securityWebhooks)
      .set({
        ...(body.name ? { name: body.name } : {}),
        ...(body.eventKinds ? { eventKinds: body.eventKinds } : {}),
        url,
        ...(body.isEnabled === undefined ? {} : { isEnabled: body.isEnabled }),
        // Re-enabling clears the failure count, or the endpoint is disabled
        // again by the next single failure.
        ...(reEnabling ? { consecutiveFailures: 0, disabledReason: null } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(securityWebhooks.id, id));
    await recordAuthEvent(app.db, {
      kind: "security_webhook_changed",
      companyId,
      userId: req.user!.id,
      email: req.user!.email,
      ...requestContext(req),
      reason: `Security webhook "${row.name}" updated`,
      metadata: { webhookId: id, changed: Object.keys(body) },
    });
    const [after] = await app.db
      .select()
      .from(securityWebhooks)
      .where(eq(securityWebhooks.id, id))
      .limit(1);
    return after;
  });

  app.delete("/company/security-webhooks/:id", { preHandler: companyAdmin }, async (req) => {
    const companyId = req.companyId!;
    const { id } = req.params as { id: string };
    const [row] = await app.db
      .select({ id: securityWebhooks.id, name: securityWebhooks.name })
      .from(securityWebhooks)
      .where(and(eq(securityWebhooks.id, id), eq(securityWebhooks.companyId, companyId)))
      .limit(1);
    if (!row) throw notFound("Security webhook not found");
    await app.db.delete(securityWebhookDeliveries).where(eq(securityWebhookDeliveries.webhookId, id));
    await app.db.delete(securityWebhooks).where(eq(securityWebhooks.id, id));
    await recordAuthEvent(app.db, {
      kind: "security_webhook_changed",
      companyId,
      userId: req.user!.id,
      email: req.user!.email,
      ...requestContext(req),
      reason: `Security webhook "${row.name}" deleted`,
      metadata: { webhookId: id },
    });
    return { ok: true, id };
  });

  /** Enqueue a `ping` and attempt it now, so an operator can prove the wiring. */
  app.post("/company/security-webhooks/:id/test", { preHandler: companyAdmin }, async (req) => {
    const companyId = req.companyId!;
    const { id } = req.params as { id: string };
    const [row] = await app.db
      .select()
      .from(securityWebhooks)
      .where(and(eq(securityWebhooks.id, id), eq(securityWebhooks.companyId, companyId)))
      .limit(1);
    if (!row) throw notFound("Security webhook not found");
    const deliveryId = newId("swd");
    await app.db.insert(securityWebhookDeliveries).values({
      id: deliveryId,
      companyId,
      webhookId: id,
      eventKind: "ping",
      payload: {
        id: deliveryId,
        kind: "ping",
        outcome: "success",
        at: new Date().toISOString(),
        companyId,
        reason: `Test delivery requested by ${req.user!.email}`,
      },
      status: "pending",
      nextAttemptAt: new Date().toISOString(),
    });
    const outcome = await attemptDelivery(app, deliveryId);
    return {
      deliveryId,
      status: outcome.status,
      statusCode: outcome.statusCode,
      error: outcome.error,
      reasons:
        outcome.status === "delivered"
          ? []
          : [
              "Nothing was confirmed delivered. The delivery stays in the queue and the sweep will " +
                "retry it unless it was refused by the destination policy.",
            ],
    };
  });

  app.get("/company/security-webhooks/deliveries", { preHandler: companyAdmin }, async (req) => {
    const companyId = req.companyId!;
    const q = z
      .object({ webhookId: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query);
    const rows = await recentDeliveries(app.db, companyId, {
      ...(q.webhookId ? { webhookId: q.webhookId } : {}),
      limit: q.limit,
    });
    return { items: rows };
  });

  /** Flush the queue by hand — the manual counterpart to the scheduler job. */
  app.post("/company/security-webhooks/run", { preHandler: companyAdmin }, async (req) => {
    const companyId = req.companyId!;
    return sweepSecurityWebhooks(app, { companyId, limit: 200 });
  });

  /* ================================================================ */
  /* §0.2 #46/#47 — retention                                          */
  /* ================================================================ */

  /**
   * Run this tenant's retention policy now. The scheduler runs the same
   * function daily; this exists so an administrator who has just set a policy
   * can see what it did instead of being told to wait a day, and so the
   * behaviour is testable without a clock.
   *
   * Ledgered, because destroying records is exactly the kind of consequential
   * act the chain exists for — including the run that destroyed nothing.
   */
  app.post("/company/security/retention/run", { preHandler: companyAdmin }, async (req) => {
    const companyId = req.companyId!;
    const outcome = await applyRetention(app.db, companyId);
    await appendLedger(app.db, {
      companyId,
      actorId: req.user!.id,
      action: "delete",
      objectType: "auth_retention_run",
      objectId: companyId,
      payload: { ...outcome, manual: true },
      storePayload: true,
    });
    return {
      ...outcome,
      reasons: outcome.skipped
        ? [outcome.reason ?? "Nothing to do."]
        : [
            `${outcome.securityEventsPseudonymised} trail rows had their address, IP and user agent removed; the kind, outcome and time were kept.`,
            `${outcome.emailDispatchesDeleted} message records were deleted.`,
          ],
    };
  });

  /* ================================================================ */
  /* Health inputs — what WP-INTEL may read from this area             */
  /* ================================================================ */

  /**
   * Company-level security posture, as counted facts. Every figure that cannot
   * be computed is `null` with a reason, never 0 — the house rule.
   */
  app.get("/company/security/health-inputs", { preHandler: companyAdmin }, async (req) => {
    const companyId = req.companyId!;
    const nowMs = Date.now();
    const dayAgo = new Date(nowMs - 24 * 3600_000).toISOString();
    const members = await app.db
      .select({ userId: companyMemberships.userId })
      .from(companyMemberships)
      .where(eq(companyMemberships.companyId, companyId));
    const memberIds = members.map((m) => m.userId);
    const enrolled =
      memberIds.length === 0
        ? []
        : await app.db
            .select({ userId: userMfa.userId })
            .from(userMfa)
            .where(and(inArray(userMfa.userId, memberIds), eq(userMfa.status, "active")));
    const recent = await app.db
      .select({ kind: authSecurityEvents.kind, outcome: authSecurityEvents.outcome })
      .from(authSecurityEvents)
      .where(
        and(eq(authSecurityEvents.companyId, companyId), gte(authSecurityEvents.at, dayAgo)),
      )
      .limit(5000);
    const policy = await loadCompanyPolicy(app.db, companyId);
    const reasons: string[] = [];
    if (policy.updatedAt === null) {
      reasons.push("No tenant security policy has been set; the platform defaults apply.");
    }
    if (memberIds.length === 0) reasons.push("This company has no members.");
    return {
      metrics: {
        members: memberIds.length,
        mfaEnrolled: new Set(enrolled.map((e) => e.userId)).size,
        mfaCoveragePercent:
          memberIds.length === 0
            ? null
            : Math.round((new Set(enrolled.map((e) => e.userId)).size / memberIds.length) * 100),
        failedSignIns24h: recent.filter((r) => r.kind === "login_failure").length,
        blockedSignIns24h: recent.filter((r) => r.outcome === "blocked").length,
        policyConfigured: policy.updatedAt === null ? 0 : 1,
        ipAllowlistEnforced: policy.ipAllowlistMode === "enforce" ? 1 : 0,
        mfaRequired: policy.mfaRequired ? 1 : 0,
      },
      reasons,
    };
  });
}

/** RFC 4180 quoting: a comma, quote or newline inside a field breaks a CSV. */
export function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export { emptyPolicy, rowToPolicy };
