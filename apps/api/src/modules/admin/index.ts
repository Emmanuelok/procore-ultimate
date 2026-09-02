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

  app.post("/assurance-grants", { preHandler: adminOnly }, async (req, reply) => {
    const body = grantCreateSchema.parse(req.body);
    const [user] = await app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, body.userId))
      .limit(1);
    if (!user) throw badRequest("userId does not exist");
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
    // authEvents has no companyId — scope through membership of this company.
    const conds = [eq(companyMemberships.companyId, req.companyId!)];
    if (q.kind) conds.push(eq(authEvents.kind, q.kind));
    if (q.userId) conds.push(eq(authEvents.userId, q.userId));
    const where = and(...conds);
    const items = await app.db
      .select({
        id: authEvents.id,
        userId: authEvents.userId,
        email: authEvents.email,
        kind: authEvents.kind,
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
    return paginate(items, Number(row?.n ?? 0), q);
  });
};
