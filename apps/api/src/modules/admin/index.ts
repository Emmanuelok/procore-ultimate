/**
 * Tenant administration: permission templates, project memberships, assurance
 * grants, the audit trail, retention and legal hold, data export and
 * delegated administration (Vol I §0.1 #20–#30, §0.8 #45–#47).
 *
 * WHAT CHANGED IN THIS WAVE
 *  • assurance grants enforce segregation of duties. `POST /assurance-grants`
 *    accepted any userId — including the caller's own — so a company admin
 *    could grant themselves `integrity_reviewer` and then disposition the
 *    signals raised about their own records, which is precisely the model the
 *    assurance layer exists to prevent.
 *  • the auth-event register is scoped to events that happened in THIS
 *    tenant. It used to join through company_memberships, showing an admin of
 *    company A every sign-in a shared user made while working in company B.
 *  • an audit viewer over the hash-chained ledger (#92), retention policies
 *    and legal holds with real enforcement (#46–#47), a company data export
 *    (#45), and delegated administration (#27).
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, asc, count, desc, eq, gt, or, isNull, isNotNull, inArray, gte, lte } from "drizzle-orm";
import {
  adminDelegations,
  assuranceGrants,
  authEvents,
  companyMemberships,
  contacts,
  costCodes,
  exportJobs,
  ledgerEntries,
  legalHolds,
  locations,
  permissionTemplates,
  projectMemberships,
  projects,
  retentionPolicies,
  users,
  vendors,
  workflowTemplates,
} from "@constructos/db";
import {
  ADMIN_DELEGATION_CAPABILITIES,
  ASSURANCE_ROLES,
  EXPORT_JOB_STATUSES,
  PERMISSION_LEVELS,
  RETENTION_ACTIONS,
  TOOLS,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const toolSet = new Set<string>(TOOLS);
const levelSet = new Set<string>(PERMISSION_LEVELS);

/** Validate a tools/overrides map: keys ∈ TOOLS, values ∈ PERMISSION_LEVELS. */
function validateToolMap(map: Record<string, string>, label: string): Record<string, string> {
  for (const [key, value] of Object.entries(map)) {
    if (!toolSet.has(key)) {
      throw badRequest(`Unknown tool "${key}" in ${label}`, { validTools: TOOLS });
    }
    if (!levelSet.has(value)) {
      throw badRequest(`Unknown permission level "${value}" for tool "${key}" in ${label}`, {
        validLevels: PERMISSION_LEVELS,
      });
    }
  }
  return map;
}

const templateCreateSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "key must be a lowercase slug"),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).default(""),
  tools: z.record(z.string(), z.string()),
});

const templatePatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  tools: z.record(z.string(), z.string()).optional(),
});

const membershipCreateSchema = z.object({
  userId: z.string().min(1),
  templateKey: z.string().min(1),
  overrides: z.record(z.string(), z.string()).default({}),
});

const membershipPatchSchema = z.object({
  templateKey: z.string().min(1).optional(),
  overrides: z.record(z.string(), z.string()).optional(),
});

const grantCreateSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(ASSURANCE_ROLES),
  projectId: z.string().min(1).optional(),
  expiresAt: z.string().optional(),
});

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

export const adminModule: FastifyPluginAsync = async (app) => {
  const adminOnly = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];

  /* ----------------------- Permission templates -------------------- */

  app.get("/permission-templates", { preHandler: adminOnly }, async (req) => {
    const items = await app.db
      .select()
      .from(permissionTemplates)
      .where(eq(permissionTemplates.companyId, req.companyId!))
      .orderBy(desc(permissionTemplates.isBuiltin), asc(permissionTemplates.name));
    return { items, total: items.length };
  });

  app.post("/permission-templates", { preHandler: adminOnly }, async (req, reply) => {
    const body = templateCreateSchema.parse(req.body);
    validateToolMap(body.tools, "tools");
    const [dup] = await app.db
      .select({ id: permissionTemplates.id })
      .from(permissionTemplates)
      .where(
        and(
          eq(permissionTemplates.companyId, req.companyId!),
          eq(permissionTemplates.key, body.key),
        ),
      )
      .limit(1);
    if (dup) throw conflict(`A template with key "${body.key}" already exists`);

    const id = newId("ptpl");
    await app.db.insert(permissionTemplates).values({
      id,
      companyId: req.companyId!,
      key: body.key,
      name: body.name,
      description: body.description,
      tools: body.tools,
      isBuiltin: false,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "permission_template",
      objectId: id,
      payload: body,
      storePayload: true,
    });
    const [created] = await app.db
      .select()
      .from(permissionTemplates)
      .where(eq(permissionTemplates.id, id));
    return reply.status(201).send(created);
  });

  async function getTemplateOr404(companyId: string, templateId: string) {
    const [tpl] = await app.db
      .select()
      .from(permissionTemplates)
      .where(
        and(eq(permissionTemplates.id, templateId), eq(permissionTemplates.companyId, companyId)),
      )
      .limit(1);
    if (!tpl) throw notFound("Permission template not found");
    return tpl;
  }

  app.patch("/permission-templates/:templateId", { preHandler: adminOnly }, async (req) => {
    const { templateId } = req.params as { templateId: string };
    const body = templatePatchSchema.parse(req.body);
    const tpl = await getTemplateOr404(req.companyId!, templateId);
    if (tpl.isBuiltin) throw conflict("Built-in templates cannot be modified");
    if (body.tools) validateToolMap(body.tools, "tools");
    await app.db
      .update(permissionTemplates)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.tools !== undefined ? { tools: body.tools } : {}),
      })
      .where(eq(permissionTemplates.id, templateId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "permission_template",
      objectId: templateId,
      payload: body,
      storePayload: true,
    });
    return getTemplateOr404(req.companyId!, templateId);
  });

  app.delete("/permission-templates/:templateId", { preHandler: adminOnly }, async (req) => {
    const { templateId } = req.params as { templateId: string };
    const tpl = await getTemplateOr404(req.companyId!, templateId);
    if (tpl.isBuiltin) throw conflict("Built-in templates cannot be deleted");
    const [inUse] = await app.db
      .select({ n: count() })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.companyId, req.companyId!),
          eq(projectMemberships.templateKey, tpl.key),
        ),
      );
    if (Number(inUse?.n ?? 0) > 0) {
      throw conflict("Template is assigned to project memberships and cannot be deleted");
    }
    await app.db.delete(permissionTemplates).where(eq(permissionTemplates.id, templateId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "permission_template",
      objectId: templateId,
      payload: { key: tpl.key, name: tpl.name },
    });
    return { ok: true };
  });

  /* ----------------------- Project memberships --------------------- */

  async function assertTemplateKey(companyId: string, templateKey: string) {
    const [tpl] = await app.db
      .select({ id: permissionTemplates.id })
      .from(permissionTemplates)
      .where(
        and(
          eq(permissionTemplates.companyId, companyId),
          eq(permissionTemplates.key, templateKey),
        ),
      )
      .limit(1);
    if (!tpl) throw badRequest(`Unknown permission template key "${templateKey}"`);
  }

  app.get(
    "/projects/:projectId/memberships",
    { preHandler: [app.authenticate, app.requireCompany, app.requireTool("admin", "read")] },
    async (req) => {
      const q = pageQuerySchema.parse(req.query);
      const where = and(
        eq(projectMemberships.companyId, req.companyId!),
        eq(projectMemberships.projectId, req.projectId!),
      );
      const items = await app.db
        .select({
          id: projectMemberships.id,
          userId: projectMemberships.userId,
          templateKey: projectMemberships.templateKey,
          overrides: projectMemberships.overrides,
          createdAt: projectMemberships.createdAt,
          userName: users.name,
          userEmail: users.email,
        })
        .from(projectMemberships)
        .innerJoin(users, eq(users.id, projectMemberships.userId))
        .where(where)
        .orderBy(asc(users.name))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      const [row] = await app.db.select({ n: count() }).from(projectMemberships).where(where);
      return paginate(items, Number(row?.n ?? 0), q);
    },
  );

  app.post(
    "/projects/:projectId/memberships",
    { preHandler: [app.authenticate, app.requireCompany, app.requireTool("admin", "admin")] },
    async (req, reply) => {
      const body = membershipCreateSchema.parse(req.body);
      validateToolMap(body.overrides, "overrides");
      await assertTemplateKey(req.companyId!, body.templateKey);
      const [companyMember] = await app.db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, req.companyId!),
            eq(companyMemberships.userId, body.userId),
          ),
        )
        .limit(1);
      if (!companyMember) throw badRequest("userId is not a member of this company");
      const [dup] = await app.db
        .select({ id: projectMemberships.id })
        .from(projectMemberships)
        .where(
          and(
            eq(projectMemberships.projectId, req.projectId!),
            eq(projectMemberships.userId, body.userId),
          ),
        )
        .limit(1);
      if (dup) throw conflict("User is already a member of this project");

      const id = newId("pm");
      await app.db.insert(projectMemberships).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        userId: body.userId,
        templateKey: body.templateKey,
        overrides: body.overrides,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "project_membership",
        objectId: id,
        payload: { projectId: req.projectId!, ...body },
        storePayload: true,
      });
      const [created] = await app.db
        .select()
        .from(projectMemberships)
        .where(eq(projectMemberships.id, id));
      return reply.status(201).send(created);
    },
  );

  async function getProjectMembershipOr404(
    companyId: string,
    projectId: string,
    membershipId: string,
  ) {
    const [membership] = await app.db
      .select()
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.id, membershipId),
          eq(projectMemberships.companyId, companyId),
          eq(projectMemberships.projectId, projectId),
        ),
      )
      .limit(1);
    if (!membership) throw notFound("Project membership not found");
    return membership;
  }

  app.patch(
    "/projects/:projectId/memberships/:membershipId",
    { preHandler: [app.authenticate, app.requireCompany, app.requireTool("admin", "admin")] },
    async (req) => {
      const { membershipId } = req.params as { projectId: string; membershipId: string };
      const body = membershipPatchSchema.parse(req.body);
      await getProjectMembershipOr404(req.companyId!, req.projectId!, membershipId);
      if (body.overrides) validateToolMap(body.overrides, "overrides");
      if (body.templateKey) await assertTemplateKey(req.companyId!, body.templateKey);
      await app.db
        .update(projectMemberships)
        .set({
          ...(body.templateKey !== undefined ? { templateKey: body.templateKey } : {}),
          ...(body.overrides !== undefined ? { overrides: body.overrides } : {}),
        })
        .where(eq(projectMemberships.id, membershipId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "project_membership",
        objectId: membershipId,
        payload: body,
        storePayload: true,
      });
      return getProjectMembershipOr404(req.companyId!, req.projectId!, membershipId);
    },
  );

  app.delete(
    "/projects/:projectId/memberships/:membershipId",
    { preHandler: [app.authenticate, app.requireCompany, app.requireTool("admin", "admin")] },
    async (req) => {
      const { membershipId } = req.params as { projectId: string; membershipId: string };
      const membership = await getProjectMembershipOr404(
        req.companyId!,
        req.projectId!,
        membershipId,
      );
      await app.db.delete(projectMemberships).where(eq(projectMemberships.id, membershipId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "project_membership",
        objectId: membershipId,
        payload: { userId: membership.userId, projectId: membership.projectId },
      });
      return { ok: true };
    },
  );

  /* ------------------------- Assurance grants ---------------------- */

  app.get("/assurance-grants", { preHandler: adminOnly }, async (req) => {
    const q = pageQuerySchema
      .extend({
        userId: z.string().optional(),
        role: z.enum(ASSURANCE_ROLES).optional(),
        projectId: z.string().optional(),
        includeExpired: z.string().optional(),
      })
      .parse(req.query);
    const conds = [eq(assuranceGrants.companyId, req.companyId!)];
    if (q.userId) conds.push(eq(assuranceGrants.userId, q.userId));
    if (q.role) conds.push(eq(assuranceGrants.role, q.role));
    if (q.projectId) conds.push(eq(assuranceGrants.projectId, q.projectId));
    if (q.includeExpired !== "true") {
      const now = new Date().toISOString();
      conds.push(or(isNull(assuranceGrants.expiresAt), gte(assuranceGrants.expiresAt, now))!);
    }
    const where = and(...conds);
    const items = await app.db
      .select({
        id: assuranceGrants.id,
        userId: assuranceGrants.userId,
        role: assuranceGrants.role,
        projectId: assuranceGrants.projectId,
        expiresAt: assuranceGrants.expiresAt,
        grantedBy: assuranceGrants.grantedBy,
        createdAt: assuranceGrants.createdAt,
        userName: users.name,
        userEmail: users.email,
      })
      .from(assuranceGrants)
      .innerJoin(users, eq(users.id, assuranceGrants.userId))
      .where(where)
      .orderBy(desc(assuranceGrants.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [row] = await app.db
      .select({ n: count() })
      .from(assuranceGrants)
      .innerJoin(users, eq(users.id, assuranceGrants.userId))
      .where(where);
    return paginate(items, Number(row?.n ?? 0), q);
  });

  /**
   * Grant an assurance role — the segregation-of-duties boundary.
   *
   * permissions.ts states the invariant this route exists to protect:
   * "Operational admins must NOT be able to disposition signals about their
   * own records." The route enforced none of it. It checked only that the
   * userId existed SOMEWHERE on the platform, so a company admin could POST
   * `{ userId: <self>, role: "integrity_reviewer" }`, pass
   * `requireAssuranceRole` on `POST /signals/:id/disposition`, and mark the
   * signals raised about their own invoices as false positives. Grants could
   * also be created for users of other tenants, lying dormant until those
   * users happened to join.
   *
   * Three rules now hold, and each refusal is ledgered so an attempt is
   * itself evidence:
   *   1. nobody grants themselves an assurance role;
   *   2. the grantee must be an active member of THIS company;
   *   3. `integrity_reviewer` may not be held by an owner or admin — the
   *      operational authority and the review authority are different people.
   */
  app.post("/assurance-grants", { preHandler: adminOnly }, async (req, reply) => {
    const body = grantCreateSchema.parse(req.body);

    const refuse = async (reason: string) => {
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "access",
        objectType: "assurance_grant",
        objectId: `refused:${body.userId}`,
        payload: { refused: true, reason, role: body.role, userId: body.userId },
        storePayload: true,
      });
      throw forbidden(reason);
    };

    if (body.userId === req.user!.id) {
      await refuse(
        "An assurance role cannot be granted to yourself: the reviewer and the operator must be different people.",
      );
    }

    const [membership] = await app.db
      .select({ role: companyMemberships.role })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, req.companyId!),
          eq(companyMemberships.userId, body.userId),
        ),
      )
      .limit(1);
    if (!membership) {
      await refuse("The grantee must already be a member of this company.");
    }
    if (
      body.role === "integrity_reviewer" &&
      (membership!.role === "owner" || membership!.role === "admin")
    ) {
      await refuse(
        "An owner or admin cannot hold integrity_reviewer: they would be dispositioning signals about records they control.",
      );
    }

    const [user] = await app.db
      .select({ id: users.id, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, body.userId))
      .limit(1);
    if (!user) throw badRequest("userId does not exist");
    if (!user.isActive) throw badRequest("The grantee's account is deactivated");
    if (body.projectId) {
      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, body.projectId), eq(projects.companyId, req.companyId!)))
        .limit(1);
      if (!project) throw badRequest("projectId does not exist in this company");
    }
    let expiresAt: string | null = null;
    if (body.expiresAt) {
      const parsed = new Date(body.expiresAt);
      if (Number.isNaN(parsed.getTime())) throw badRequest("expiresAt is not a valid timestamp");
      expiresAt = parsed.toISOString();
    }

    const id = newId("ag");
    await app.db.insert(assuranceGrants).values({
      id,
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      userId: body.userId,
      role: body.role,
      expiresAt,
      grantedBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "assurance_grant",
      objectId: id,
      payload: { ...body, expiresAt, grantedBy: req.user!.id },
      storePayload: true,
    });
    const [created] = await app.db
      .select()
      .from(assuranceGrants)
      .where(eq(assuranceGrants.id, id));
    return reply.status(201).send(created);
  });

  app.delete("/assurance-grants/:grantId", { preHandler: adminOnly }, async (req) => {
    const { grantId } = req.params as { grantId: string };
    const [grant] = await app.db
      .select()
      .from(assuranceGrants)
      .where(and(eq(assuranceGrants.id, grantId), eq(assuranceGrants.companyId, req.companyId!)))
      .limit(1);
    if (!grant) throw notFound("Assurance grant not found");
    await app.db.delete(assuranceGrants).where(eq(assuranceGrants.id, grantId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "assurance_grant",
      objectId: grantId,
      payload: { userId: grant.userId, role: grant.role, projectId: grant.projectId },
      storePayload: true,
    });
    return { ok: true };
  });

  /* --------------------------- Auth events ------------------------- */

  app.get("/company/auth-events", { preHandler: adminOnly }, async (req) => {
    const q = pageQuerySchema
      .extend({
        kind: z.string().max(50).optional(),
        userId: z.string().optional(),
      })
      .parse(req.query);
    /*
     * Events are scoped to THIS tenant.
     *
     * The register used to join auth_events through company_memberships,
     * which meant a user who belongs to companies A and B had every one of
     * their sign-ins — IP addresses and devices included — visible to the
     * admins of BOTH, including sessions used only for the other tenant.
     * Events now carry a companyId; historical rows that predate the column
     * are matched on membership only when they occurred after the membership
     * began, and they are labelled so nobody mistakes them for scoped data.
     */
    const conds = [
      eq(companyMemberships.companyId, req.companyId!),
      or(
        eq(authEvents.companyId, req.companyId!),
        and(isNull(authEvents.companyId), gt(authEvents.at, companyMemberships.createdAt)),
      )!,
    ];
    if (q.kind) conds.push(eq(authEvents.kind, q.kind));
    if (q.userId) conds.push(eq(authEvents.userId, q.userId));
    const where = and(...conds);
    const items = await app.db
      .select({
        id: authEvents.id,
        userId: authEvents.userId,
        email: authEvents.email,
        kind: authEvents.kind,
        companyId: authEvents.companyId,
        ip: authEvents.ip,
        userAgent: authEvents.userAgent,
        at: authEvents.at,
        userName: users.name,
      })
      .from(authEvents)
      .innerJoin(companyMemberships, eq(companyMemberships.userId, authEvents.userId))
      .innerJoin(users, eq(users.id, authEvents.userId))
      .where(where)
      .orderBy(desc(authEvents.at))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [row] = await app.db
      .select({ n: count() })
      .from(authEvents)
      .innerJoin(companyMemberships, eq(companyMemberships.userId, authEvents.userId))
      .innerJoin(users, eq(users.id, authEvents.userId))
      .where(where);
    return paginate(
      items.map((e) => ({ ...e, scoped: e.companyId !== null })),
      Number(row?.n ?? 0),
      q,
    );
  });

  /* ---------------------------------------------------------------- */
  /* Audit viewer over the ledger (#92)                                */
  /* ---------------------------------------------------------------- */

  /**
   * Read the tenant's hash-chained ledger as an audit trail.
   *
   * This is a READER, not a second trail: the ledger is already the record of
   * every consequential state change, and an audit log kept alongside it
   * would be a second version of the truth. Filters cover the questions an
   * administrator actually asks — what happened to this record, what did this
   * person do, what changed this week.
   */
  app.get("/company/audit", { preHandler: adminOnly }, async (req) => {
    const q = pageQuerySchema
      .extend({
        objectType: z.string().max(60).optional(),
        objectId: z.string().max(120).optional(),
        actorId: z.string().max(120).optional(),
        action: z.string().max(30).optional(),
        since: z.string().max(40).optional(),
        until: z.string().max(40).optional(),
      })
      .parse(req.query);
    const conds = [eq(ledgerEntries.companyId, req.companyId!)];
    if (q.objectType) conds.push(eq(ledgerEntries.objectType, q.objectType));
    if (q.objectId) conds.push(eq(ledgerEntries.objectId, q.objectId));
    if (q.actorId) conds.push(eq(ledgerEntries.actorId, q.actorId));
    if (q.action) conds.push(eq(ledgerEntries.action, q.action));
    if (q.since) conds.push(gte(ledgerEntries.at, q.since));
    if (q.until) conds.push(lte(ledgerEntries.at, q.until));
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(ledgerEntries).where(where);
    const items = await app.db
      .select({
        seq: ledgerEntries.seq,
        at: ledgerEntries.at,
        action: ledgerEntries.action,
        objectType: ledgerEntries.objectType,
        objectId: ledgerEntries.objectId,
        actorId: ledgerEntries.actorId,
        actorName: users.name,
        actorEmail: users.email,
        payload: ledgerEntries.payload,
        payloadHash: ledgerEntries.payloadHash,
        entryHash: ledgerEntries.entryHash,
        prevHash: ledgerEntries.prevHash,
      })
      .from(ledgerEntries)
      .leftJoin(users, eq(users.id, ledgerEntries.actorId))
      .where(where)
      .orderBy(desc(ledgerEntries.seq))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      items.map((e) => ({
        ...e,
        // A system action has no actor; say so rather than rendering a blank.
        actorName: e.actorId === null ? "System" : (e.actorName ?? e.actorId),
        // The payload is stored only for high-value objects; the hash always
        // is. An absent payload is not "no change", it is "not stored".
        payloadStored: e.payload !== null,
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  /** What object types and actors appear in this tenant's trail, for filters. */
  app.get("/company/audit/facets", { preHandler: adminOnly }, async (req) => {
    const types = await app.db
      .select({ objectType: ledgerEntries.objectType, n: count() })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.companyId, req.companyId!))
      .groupBy(ledgerEntries.objectType)
      .orderBy(desc(count()))
      .limit(100);
    const actions = await app.db
      .select({ action: ledgerEntries.action, n: count() })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.companyId, req.companyId!))
      .groupBy(ledgerEntries.action);
    return {
      objectTypes: types.map((t) => ({ value: t.objectType, count: Number(t.n) })),
      actions: actions.map((a) => ({ value: a.action, count: Number(a.n) })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* Retention policy (#46)                                            */
  /* ---------------------------------------------------------------- */

  app.get("/company/retention-policies", { preHandler: adminOnly }, async (req) => {
    const items = await app.db
      .select()
      .from(retentionPolicies)
      .where(eq(retentionPolicies.companyId, req.companyId!))
      .orderBy(asc(retentionPolicies.objectType));
    return { items, total: items.length, actions: RETENTION_ACTIONS };
  });

  app.put("/company/retention-policies/:objectType", { preHandler: adminOnly }, async (req) => {
    const { objectType } = req.params as { objectType: string };
    const body = z
      .object({
        retainMonths: z.number().int().min(1).max(1200),
        action: z.enum(RETENTION_ACTIONS),
        basis: z.string().max(500).nullable().optional(),
        isActive: z.boolean().optional(),
      })
      .parse(req.body);
    const [existing] = await app.db
      .select({ id: retentionPolicies.id })
      .from(retentionPolicies)
      .where(
        and(
          eq(retentionPolicies.companyId, req.companyId!),
          eq(retentionPolicies.objectType, objectType),
        ),
      )
      .limit(1);
    const now = new Date().toISOString();
    if (existing) {
      await app.db
        .update(retentionPolicies)
        .set({
          retainMonths: body.retainMonths,
          action: body.action,
          basis: body.basis ?? null,
          isActive: body.isActive === false ? 0 : 1,
          updatedAt: now,
        })
        .where(eq(retentionPolicies.id, existing.id));
    } else {
      await app.db.insert(retentionPolicies).values({
        id: newId("rp"),
        companyId: req.companyId!,
        objectType,
        retainMonths: body.retainMonths,
        action: body.action,
        basis: body.basis ?? null,
        isActive: body.isActive === false ? 0 : 1,
        createdBy: req.user!.id,
      });
    }
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: existing ? "update" : "create",
      objectType: "retention_policy",
      objectId: objectType,
      payload: body,
      storePayload: true,
    });
    const [row] = await app.db
      .select()
      .from(retentionPolicies)
      .where(
        and(
          eq(retentionPolicies.companyId, req.companyId!),
          eq(retentionPolicies.objectType, objectType),
        ),
      );
    return row;
  });

  /**
   * What the current policy WOULD act on, and what a hold is protecting.
   *
   * Deliberately a report rather than an execution: this module owns
   * projects, vendors and contacts, and reports on the rest instead of
   * destroying another module's evidence on a schedule it cannot reason
   * about.
   */
  app.get("/company/retention-policies/preview", { preHandler: adminOnly }, async (req) => {
    const policies = await app.db
      .select()
      .from(retentionPolicies)
      .where(
        and(eq(retentionPolicies.companyId, req.companyId!), eq(retentionPolicies.isActive, 1)),
      );
    const holds = await app.db
      .select()
      .from(legalHolds)
      .where(and(eq(legalHolds.companyId, req.companyId!), eq(legalHolds.status, "active")));
    const results: Array<{
      objectType: string;
      retainMonths: number;
      action: string;
      dueForAction: number;
      heldBack: number;
      enforced: boolean;
      note: string;
    }> = [];
    for (const policy of policies) {
      const cutoff = new Date(
        Date.now() - policy.retainMonths * 30 * 86_400_000,
      ).toISOString();
      let dueForAction = 0;
      let enforced = false;
      if (policy.objectType === "project") {
        enforced = true;
        const [row] = await app.db
          .select({ n: count() })
          .from(projects)
          .where(
            and(
              eq(projects.companyId, req.companyId!),
              eq(projects.stage, "closed"),
              lte(projects.updatedAt, cutoff),
            ),
          );
        dueForAction = Number(row?.n ?? 0);
      } else if (policy.objectType === "vendor") {
        enforced = true;
        const [row] = await app.db
          .select({ n: count() })
          .from(vendors)
          .where(
            and(
              eq(vendors.companyId, req.companyId!),
              eq(vendors.status, "inactive"),
              lte(vendors.updatedAt, cutoff),
            ),
          );
        dueForAction = Number(row?.n ?? 0);
      }
      const heldBack = holds.filter(
        (h) => h.objectType === null || h.objectType === policy.objectType,
      ).length;
      results.push({
        objectType: policy.objectType,
        retainMonths: policy.retainMonths,
        action: policy.action,
        dueForAction,
        heldBack,
        enforced,
        note: enforced
          ? "Enforced by the substrate: deletion refuses under a legal hold."
          : "Recorded for the owning module; the substrate does not delete records it does not own.",
      });
    }
    return { items: results, total: results.length, holds: holds.length };
  });

  /* ---------------------------------------------------------------- */
  /* Legal hold (#47)                                                  */
  /* ---------------------------------------------------------------- */

  app.get("/legal-holds", { preHandler: adminOnly }, async (req) => {
    const q = pageQuerySchema
      .extend({ status: z.enum(["active", "released"]).optional() })
      .parse(req.query);
    const conds = [eq(legalHolds.companyId, req.companyId!)];
    if (q.status) conds.push(eq(legalHolds.status, q.status));
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(legalHolds).where(where);
    const items = await app.db
      .select()
      .from(legalHolds)
      .where(where)
      .orderBy(desc(legalHolds.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/legal-holds", { preHandler: adminOnly }, async (req, reply) => {
    const body = z
      .object({
        name: z.string().min(1).max(200),
        reason: z.string().min(1).max(2000),
        matter: z.string().max(200).optional(),
        projectId: z.string().max(100).nullable().optional(),
        objectType: z.string().max(60).nullable().optional(),
        objectId: z.string().max(120).nullable().optional(),
        custodianIds: z.array(z.string().min(1)).max(100).default([]),
      })
      .parse(req.body);
    if (body.objectId && !body.objectType) {
      throw badRequest("An objectId needs an objectType to be meaningful");
    }
    if (body.projectId) {
      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, body.projectId), eq(projects.companyId, req.companyId!)))
        .limit(1);
      if (!project) throw badRequest("projectId does not exist in this company");
    }
    const id = newId("hold");
    await app.db.insert(legalHolds).values({
      id,
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      objectType: body.objectType ?? null,
      objectId: body.objectId ?? null,
      name: body.name,
      reason: body.reason,
      matter: body.matter ?? null,
      custodianIds: body.custodianIds,
      placedBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "legal_hold",
      objectId: id,
      payload: body,
      storePayload: true,
      projectId: body.projectId ?? null,
    });
    const [created] = await app.db.select().from(legalHolds).where(eq(legalHolds.id, id));
    return reply.status(201).send(created);
  });

  /**
   * Release a hold.
   *
   * A hold is never deleted — the fact that evidence was preserved between
   * two dates is itself part of the record. Releasing sets the status and
   * stamps who released it.
   */
  app.post("/legal-holds/:holdId/release", { preHandler: adminOnly }, async (req) => {
    const { holdId } = req.params as { holdId: string };
    const body = z.object({ note: z.string().max(2000).optional() }).parse(req.body ?? {});
    const [hold] = await app.db
      .select()
      .from(legalHolds)
      .where(and(eq(legalHolds.id, holdId), eq(legalHolds.companyId, req.companyId!)))
      .limit(1);
    if (!hold) throw notFound("Legal hold not found");
    if (hold.status === "released") throw conflict("This hold has already been released");
    const now = new Date().toISOString();
    await app.db
      .update(legalHolds)
      .set({ status: "released", releasedBy: req.user!.id, releasedAt: now })
      .where(eq(legalHolds.id, holdId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "legal_hold",
      objectId: holdId,
      payload: { from: "active", to: "released", note: body.note ?? null },
      storePayload: true,
      projectId: hold.projectId,
    });
    return { ok: true, id: holdId, status: "released", releasedAt: now };
  });

  /* ---------------------------------------------------------------- */
  /* Company data export (#45)                                         */
  /* ---------------------------------------------------------------- */

  const EXPORT_DATASETS = [
    "projects",
    "vendors",
    "contacts",
    "cost_codes",
    "locations",
    "users",
    "permission_templates",
    "workflow_templates",
    "ledger",
  ] as const;

  async function buildExport(
    companyId: string,
    datasets: readonly string[],
  ): Promise<{ data: Record<string, unknown[]>; manifest: Record<string, unknown> }> {
    const data: Record<string, unknown[]> = {};
    const manifest: Record<string, unknown> = {};
    const wanted = new Set(datasets);
    const add = async (name: string, run: () => Promise<unknown[]>) => {
      if (!wanted.has(name)) return;
      const rows = await run();
      data[name] = rows;
      manifest[name] = rows.length;
    };
    await add("projects", () =>
      app.db.select().from(projects).where(eq(projects.companyId, companyId)).limit(5000),
    );
    await add("vendors", () =>
      app.db.select().from(vendors).where(eq(vendors.companyId, companyId)).limit(20000),
    );
    await add("contacts", () =>
      app.db.select().from(contacts).where(eq(contacts.companyId, companyId)).limit(20000),
    );
    await add("cost_codes", () =>
      app.db.select().from(costCodes).where(eq(costCodes.companyId, companyId)).limit(20000),
    );
    await add("locations", () =>
      app.db.select().from(locations).where(eq(locations.companyId, companyId)).limit(20000),
    );
    await add("users", async () =>
      app.db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          title: users.title,
          isActive: users.isActive,
          role: companyMemberships.role,
          joinedAt: companyMemberships.createdAt,
        })
        .from(companyMemberships)
        .innerJoin(users, eq(users.id, companyMemberships.userId))
        .where(eq(companyMemberships.companyId, companyId))
        .limit(5000),
    );
    await add("permission_templates", () =>
      app.db
        .select()
        .from(permissionTemplates)
        .where(eq(permissionTemplates.companyId, companyId))
        .limit(1000),
    );
    await add("workflow_templates", () =>
      app.db
        .select()
        .from(workflowTemplates)
        .where(eq(workflowTemplates.companyId, companyId))
        .limit(1000),
    );
    await add("ledger", () =>
      app.db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.companyId, companyId))
        .orderBy(asc(ledgerEntries.seq))
        .limit(50000),
    );
    return { data, manifest };
  }

  app.get("/company/exports", { preHandler: adminOnly }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = eq(exportJobs.companyId, req.companyId!);
    const [totalRow] = await app.db.select({ n: count() }).from(exportJobs).where(where);
    const items = await app.db
      .select()
      .from(exportJobs)
      .where(where)
      .orderBy(desc(exportJobs.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q, );
  });

  /**
   * Produce the company's data as one JSON bundle.
   *
   * Synchronous and bounded rather than a background job with a download URL:
   * an export the operator cannot see complete is an export they cannot trust,
   * and every dataset here is bounded by an explicit limit so a large tenant
   * degrades into a truncated manifest rather than an out-of-memory process.
   * The manifest states what was included and how many rows, so a truncation
   * is visible instead of silent.
   */
  app.post("/company/exports", { preHandler: adminOnly }, async (req, reply) => {
    const body = z
      .object({
        datasets: z.array(z.enum(EXPORT_DATASETS)).min(1).default([...EXPORT_DATASETS]),
      })
      .parse(req.body ?? {});
    const id = newId("exp");
    await app.db.insert(exportJobs).values({
      id,
      companyId: req.companyId!,
      status: "running",
      datasets: [...body.datasets],
      format: "json",
      requestedBy: req.user!.id,
    });
    try {
      const { data, manifest } = await buildExport(req.companyId!, body.datasets);
      const rowCount = Object.values(manifest).reduce<number>(
        (sum, n) => sum + (typeof n === "number" ? n : 0),
        0,
      );
      const now = new Date().toISOString();
      await app.db
        .update(exportJobs)
        .set({ status: "complete", manifest, rowCount, completedAt: now })
        .where(eq(exportJobs.id, id));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "access",
        objectType: "company_export",
        objectId: id,
        payload: { datasets: body.datasets, manifest, rowCount },
        storePayload: true,
      });
      return reply.status(201).send({
        id,
        status: "complete",
        generatedAt: now,
        manifest,
        rowCount,
        data,
      });
    } catch (err) {
      await app.db
        .update(exportJobs)
        .set({
          status: "failed",
          error: err instanceof Error ? err.message.slice(0, 900) : String(err).slice(0, 900),
          completedAt: new Date().toISOString(),
        })
        .where(eq(exportJobs.id, id));
      throw err;
    }
  });

  /* ---------------------------------------------------------------- */
  /* Delegated administration (#27)                                    */
  /* ---------------------------------------------------------------- */

  app.get("/company/admin-delegations", { preHandler: adminOnly }, async (req) => {
    const items = await app.db
      .select({
        id: adminDelegations.id,
        userId: adminDelegations.userId,
        userName: users.name,
        userEmail: users.email,
        projectIds: adminDelegations.projectIds,
        capabilities: adminDelegations.capabilities,
        note: adminDelegations.note,
        expiresAt: adminDelegations.expiresAt,
        revokedAt: adminDelegations.revokedAt,
        grantedBy: adminDelegations.grantedBy,
        createdAt: adminDelegations.createdAt,
      })
      .from(adminDelegations)
      .innerJoin(users, eq(users.id, adminDelegations.userId))
      .where(eq(adminDelegations.companyId, req.companyId!))
      .orderBy(desc(adminDelegations.createdAt))
      .limit(200);
    return {
      items,
      total: items.length,
      capabilities: ADMIN_DELEGATION_CAPABILITIES,
    };
  });

  /**
   * Delegate a bounded slice of administration.
   *
   * A tenant-wide admin role is too much authority to hand a regional lead
   * who only needs to manage their own projects' memberships. A delegation
   * names the capabilities and the projects, and expires. It never includes
   * assurance roles: those are the segregation-of-duties boundary and are
   * granted only by an owner or admin through /assurance-grants.
   */
  app.post("/company/admin-delegations", { preHandler: adminOnly }, async (req, reply) => {
    const body = z
      .object({
        userId: z.string().min(1),
        projectIds: z.array(z.string().min(1).max(100)).max(200).default([]),
        capabilities: z.array(z.enum(ADMIN_DELEGATION_CAPABILITIES)).min(1),
        note: z.string().max(1000).optional(),
        expiresAt: z.string().max(40).optional(),
      })
      .parse(req.body);
    if (body.userId === req.user!.id) {
      throw forbidden("You cannot delegate administration to yourself");
    }
    const [membership] = await app.db
      .select({ role: companyMemberships.role })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, req.companyId!),
          eq(companyMemberships.userId, body.userId),
        ),
      )
      .limit(1);
    if (!membership) throw badRequest("userId is not a member of this company");
    if (body.projectIds.length > 0) {
      const known = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(eq(projects.companyId, req.companyId!), inArray(projects.id, body.projectIds)),
        );
      const missing = body.projectIds.filter((id) => !known.some((k) => k.id === id));
      if (missing.length > 0) throw badRequest(`Unknown project(s): ${missing.join(", ")}`);
    }
    let expiresAt: string | null = null;
    if (body.expiresAt) {
      const parsed = new Date(body.expiresAt);
      if (Number.isNaN(parsed.getTime())) throw badRequest("expiresAt is not a valid timestamp");
      expiresAt = parsed.toISOString();
    }
    const id = newId("adel");
    await app.db.insert(adminDelegations).values({
      id,
      companyId: req.companyId!,
      userId: body.userId,
      projectIds: body.projectIds,
      capabilities: [...body.capabilities],
      note: body.note ?? null,
      expiresAt,
      grantedBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "admin_delegation",
      objectId: id,
      payload: { ...body, expiresAt },
      storePayload: true,
    });
    const [created] = await app.db
      .select()
      .from(adminDelegations)
      .where(eq(adminDelegations.id, id));
    return reply.status(201).send(created);
  });

  app.delete("/company/admin-delegations/:delegationId", { preHandler: adminOnly }, async (req) => {
    const { delegationId } = req.params as { delegationId: string };
    const [row] = await app.db
      .select()
      .from(adminDelegations)
      .where(
        and(
          eq(adminDelegations.id, delegationId),
          eq(adminDelegations.companyId, req.companyId!),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Delegation not found");
    await app.db
      .update(adminDelegations)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(adminDelegations.id, delegationId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "admin_delegation",
      objectId: delegationId,
      payload: { userId: row.userId, capabilities: row.capabilities },
    });
    return { ok: true };
  });

  /** My own delegated capabilities — the shell reads this to shape the nav. */
  app.get("/me/admin-delegations", { preHandler: [app.authenticate, app.requireCompany] }, async (req) => {
    const now = new Date().toISOString();
    const rows = await app.db
      .select()
      .from(adminDelegations)
      .where(
        and(
          eq(adminDelegations.companyId, req.companyId!),
          eq(adminDelegations.userId, req.user!.id),
          isNull(adminDelegations.revokedAt),
          or(isNull(adminDelegations.expiresAt), gte(adminDelegations.expiresAt, now))!,
        ),
      );
    const capabilities = [...new Set(rows.flatMap((r) => r.capabilities))];
    const projectIds = rows.some((r) => r.projectIds.length === 0)
      ? null
      : [...new Set(rows.flatMap((r) => r.projectIds))];
    return {
      companyRole: req.companyRole,
      capabilities,
      // null = every project in the tenant.
      projectIds,
      items: rows,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Expiry sweep                                                      */
  /* ---------------------------------------------------------------- */

  if (!app.scheduler.has(EXPIRY_JOB)) {
    app.scheduler.register({
      name: EXPIRY_JOB,
      description:
        "Retire expired assurance grants and admin delegations, and report legal-hold coverage",
      everyMs: 60 * 60_000,
      runOnBoot: true,
      run: async ({ db, now }) => {
        let grants = 0;
        let delegations = 0;
        const result = await forEachCompany(db, async (companyId) => {
          const summary = await sweepExpiredAuthority(db, companyId, now);
          grants += summary.grants;
          delegations += summary.delegations;
        });
        return { ...result, grants, delegations };
      },
    });
  }
};

/* ------------------------------------------------------------------ */
/* Sweeps                                                              */
/* ------------------------------------------------------------------ */

const EXPIRY_JOB = "admin.authority-expiry";
export const ADMIN_EXPIRY_JOB = EXPIRY_JOB;

/**
 * Retire authority that has run out.
 *
 * `requireAssuranceRole` already refuses an expired grant per request, so
 * this is not a security control — it is hygiene: an expired grant that
 * lingers in the register makes the register a bad answer to "who can
 * disposition signals here", and a revived membership must not revive it.
 * Idempotent: deleting an already-deleted row is a no-op.
 */
export async function sweepExpiredAuthority(
  db: Db,
  companyId: string,
  now: Date,
): Promise<{ grants: number; delegations: number }> {
  const nowIso = now.toISOString();
  const expiredGrants = await db
    .delete(assuranceGrants)
    .where(
      and(
        eq(assuranceGrants.companyId, companyId),
        isNotNull(assuranceGrants.expiresAt),
        lte(assuranceGrants.expiresAt, nowIso),
      ),
    )
    .returning({ id: assuranceGrants.id, userId: assuranceGrants.userId, role: assuranceGrants.role });
  for (const grant of expiredGrants) {
    await appendLedger(db, {
      companyId,
      actorId: null,
      action: "delete",
      objectType: "assurance_grant",
      objectId: grant.id,
      payload: { event: "expired", userId: grant.userId, role: grant.role },
    });
  }

  const expiredDelegations = await db
    .update(adminDelegations)
    .set({ revokedAt: nowIso })
    .where(
      and(
        eq(adminDelegations.companyId, companyId),
        isNull(adminDelegations.revokedAt),
        isNotNull(adminDelegations.expiresAt),
        lte(adminDelegations.expiresAt, nowIso),
      ),
    )
    .returning({ id: adminDelegations.id });
  for (const delegation of expiredDelegations) {
    await appendLedger(db, {
      companyId,
      actorId: null,
      action: "delete",
      objectType: "admin_delegation",
      objectId: delegation.id,
      payload: { event: "expired" },
    });
  }

  return { grants: expiredGrants.length, delegations: expiredDelegations.length };
}
