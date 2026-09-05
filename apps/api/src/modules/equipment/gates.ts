/**
 * COMPANY-LEVEL TOOL GATES for the plant register.
 *
 * `app.requireTool` resolves permission through `:projectId`, which is right
 * for project routes and impossible for a fleet register: the fleet exists
 * above every project. Before this file the company routes ran on
 * `[authenticate, requireCompany]` alone, so a company GUEST with no project
 * membership could read the whole fleet, every certificate, the maintenance
 * register and the raw telematics feed, and any MEMBER could register plant,
 * off-hire it, verify certificates and remap telematics devices without
 * holding `equipment` on a single project. That is the module's permission
 * model bypassed by the URL you happen to use.
 *
 * The rule here: a company-level route requires the tool at the stated level
 * on AT LEAST ONE project in the company (owners and admins bypass, as they
 * do everywhere else; an assurance grant confers read only). And because
 * "holding equipment on one project" is not "may see every project's plant",
 * `visibleProjectIds` narrows what the list routes actually return.
 */
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
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
    .where(
      and(
        eq(projectMemberships.userId, req.user!.id),
        eq(projects.companyId, companyId),
      ),
    );
  if (rows.length === 0) return [];

  const keys = [...new Set(rows.map((r) => r.templateKey))];
  const stored = keys.length
    ? await app.db
        .select({ key: permissionTemplates.key, tools: permissionTemplates.tools })
        .from(permissionTemplates)
        .where(
          and(
            eq(permissionTemplates.companyId, companyId),
            inArray(permissionTemplates.key, keys),
          ),
        )
    : [];
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

/** Projects covered by a live assurance grant (null projectId = all of them). */
async function assuranceCoverage(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<{ all: boolean; projectIds: string[]; role: AssuranceRole | null }> {
  const grants = await app.db
    .select()
    .from(assuranceGrants)
    .where(
      and(
        eq(assuranceGrants.companyId, req.companyId!),
        eq(assuranceGrants.userId, req.user!.id),
      ),
    );
  const now = Date.now();
  const live = grants.filter((g) => !isExpired(g.expiresAt, now));
  if (live.length === 0) return { all: false, projectIds: [], role: null };
  return {
    all: live.some((g) => !g.projectId),
    projectIds: live.map((g) => g.projectId).filter((v): v is string => Boolean(v)),
    role: (live[0]!.role as AssuranceRole) ?? null,
  };
}

/**
 * The preHandler for a company-level route. Stashes the resolved visibility
 * on the request so the handler does not resolve it twice.
 */
export function companyToolGate(
  app: FastifyInstance,
  tool: ToolKey,
  level: PermissionLevel,
): preHandlerHookHandler {
  return async (req: FastifyRequest) => {
    if (!req.user || !req.companyId) throw unauthorized("Company context not resolved");
    const scope = (req as CompanyScopedRequest).equipmentScope ?? {};
    if (req.companyRole === "owner" || req.companyRole === "admin") {
      (req as CompanyScopedRequest).equipmentScope = { ...scope, all: true, projectIds: [] };
      return;
    }
    const held = await projectsWithTool(app, req, tool, level);
    if (held.length > 0) {
      (req as CompanyScopedRequest).equipmentScope = { ...scope, all: false, projectIds: held };
      return;
    }
    if (level === "read") {
      const cover = await assuranceCoverage(app, req);
      if (cover.all || cover.projectIds.length > 0) {
        req.assuranceRole = cover.role ?? undefined;
        (req as CompanyScopedRequest).equipmentScope = {
          ...scope,
          all: cover.all,
          projectIds: cover.projectIds,
        };
        return;
      }
    }
    throw forbidden(
      `Requires ${level} access to ${tool} on at least one project in this company. The fleet ` +
        "register sits above the projects, so it is gated by the same tool the project routes are.",
    );
  };
}

export interface CompanyScope {
  /** true for owners, admins and company-wide assurance grants */
  all: boolean;
  projectIds: string[];
}

type CompanyScopedRequest = FastifyRequest & { equipmentScope?: CompanyScope };

export function companyScopeOf(req: FastifyRequest): CompanyScope {
  return (req as CompanyScopedRequest).equipmentScope ?? { all: true, projectIds: [] };
}

/**
 * A drizzle condition restricting a table's `projectId` to what the caller
 * may see. Rows with a NULL projectId (fleet plant not on any project, a
 * company catalogue item) stay visible: they are company assets, not project
 * data, and hiding them would make the register unusable for a plant manager
 * who holds the tool on one job.
 */
export function scopeProjectFilter(
  scope: CompanyScope,
  column: Parameters<typeof eq>[0] & Parameters<typeof isNull>[0],
) {
  if (scope.all) return undefined;
  if (scope.projectIds.length === 0) return isNull(column);
  return or(isNull(column), inArray(column as never, scope.projectIds));
}
