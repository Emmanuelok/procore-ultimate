/**
 * COMPANY-LEVEL TOOL GATES for the tax registers.
 *
 * `app.requireTool` resolves permission through `:projectId`, which is right
 * for the project routes and impossible for the registration register: a
 * vendor's VAT/CIS/RCT registration is a company-level fact that every
 * project's determination reads. On `[authenticate, requireCompany]` alone any
 * company member — including one whose only project grant is read-only — could
 * record a vendor registration and (with a second user) verify it at 0% gross
 * payment status, which zeroes the statutory deduction on every subsequent
 * determination and payment for that vendor (determine.ts, registration-driven
 * schemes). That is the module's permission model bypassed by the URL.
 *
 * The rule, matching the fleet register in modules/equipment/gates.ts: a
 * company-level route requires `tax` at the stated level on AT LEAST ONE
 * project in the company; owners and admins bypass, and an assurance grant
 * confers read only.
 */
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import {
  assuranceGrants,
  permissionTemplates,
  projectMemberships,
  projects,
} from "@constructos/db";
import {
  BUILTIN_PERMISSION_TEMPLATES,
  meetsLevel,
  resolveLevel,
  type AssuranceRole,
  type PermissionLevel,
  type ToolKey,
  type ToolPermissionMap,
} from "@constructos/shared";
import { forbidden, unauthorized } from "../../lib/errors.js";
import { isExpired } from "../../lib/time.js";

/** Every project in the company on which the caller holds `tool` at `level`. */
export async function projectsWithTool(
  app: FastifyInstance,
  req: FastifyRequest,
  tool: ToolKey,
  level: PermissionLevel,
): Promise<string[]> {
  const companyId = req.companyId!;
  const rows = await app.db
    .select({
      projectId: projectMemberships.projectId,
      templateKey: projectMemberships.templateKey,
      overrides: projectMemberships.overrides,
    })
    .from(projectMemberships)
    .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
    .where(and(eq(projectMemberships.userId, req.user!.id), eq(projects.companyId, companyId)));
  if (rows.length === 0) return [];

  const keys = [...new Set(rows.map((r) => r.templateKey))];
  const stored = await app.db
    .select({ key: permissionTemplates.key, tools: permissionTemplates.tools })
    .from(permissionTemplates)
    .where(
      and(eq(permissionTemplates.companyId, companyId), inArray(permissionTemplates.key, keys)),
    );
  const storedByKey = new Map(stored.map((s) => [s.key, s.tools as ToolPermissionMap]));

  const out: string[] = [];
  for (const row of rows) {
    const builtin = BUILTIN_PERMISSION_TEMPLATES.find((t) => t.key === row.templateKey)?.tools;
    const s = storedByKey.get(row.templateKey);
    const template: ToolPermissionMap | undefined = s ? { ...(builtin ?? {}), ...s } : builtin;
    const effective = resolveLevel(tool, template, row.overrides as ToolPermissionMap);
    if (meetsLevel(effective, level)) out.push(row.projectId);
  }
  return [...new Set(out)];
}

/** Whether a live assurance grant covers anything at all (read-only visibility). */
async function hasAssuranceCoverage(app: FastifyInstance, req: FastifyRequest): Promise<AssuranceRole | null> {
  const grants = await app.db
    .select()
    .from(assuranceGrants)
    .where(
      and(eq(assuranceGrants.companyId, req.companyId!), eq(assuranceGrants.userId, req.user!.id)),
    );
  const now = Date.now();
  const live = grants.filter((g) => !isExpired(g.expiresAt, now));
  return live.length > 0 ? ((live[0]!.role as AssuranceRole) ?? null) : null;
}

/** preHandler for a company-level tax route. */
export function companyTaxGate(app: FastifyInstance, level: PermissionLevel): preHandlerHookHandler {
  return async (req: FastifyRequest) => {
    if (!req.user || !req.companyId) throw unauthorized("Company context not resolved");
    if (req.companyRole === "owner" || req.companyRole === "admin") return;
    const held = await projectsWithTool(app, req, "tax", level);
    if (held.length > 0) return;
    if (level === "read") {
      const role = await hasAssuranceCoverage(app, req);
      if (role) {
        req.assuranceRole = role;
        return;
      }
    }
    throw forbidden(
      `Requires ${level} access to tax on at least one project in this company. Registrations sit ` +
        "above the projects — every determination reads them — so they are gated by the same tool " +
        "the project routes are.",
    );
  };
}
