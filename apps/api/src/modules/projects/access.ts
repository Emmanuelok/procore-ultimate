/**
 * Who can see which project, and at what tool level.
 *
 * WHAT THIS IS
 * `requireTool` (plugins/auth.ts) answers the question for ONE project named
 * in the URL. Every company-level list — the portfolio, the ⌘K palette, the
 * audit viewer, cross-project search — asks the plural version of the same
 * question, and before this file each of them answered it by filtering on
 * `companyId` alone. That is how a subcontractor with one project membership
 * came to receive the name, number, address, dates, currency and recorded
 * value of all 200 projects the general contractor runs.
 *
 * WHAT IT COVERS (Vol I §0.1 #8, #28, #30)
 *  • owner/admin see every project in the tenant;
 *  • everyone else sees the projects they hold a `project_memberships` row on,
 *    plus any project covered by a live assurance grant (read-only);
 *  • a soft-deleted project is visible to nobody through these helpers — the
 *    recycle bin has its own explicitly-gated route.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not replace `requireTool`. An id-addressed route must still run the
 * gate for its own project: this file answers "which set", not "may I act".
 */
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { assuranceGrants, projectMemberships, projects, permissionTemplates } from "@constructos/db";
import {
  BUILTIN_PERMISSION_TEMPLATES,
  meetsLevel,
  resolveLevel,
  type PermissionLevel,
  type ToolKey,
  type ToolPermissionMap,
} from "@constructos/shared";
import { isExpired } from "../../lib/time.js";

export interface ProjectAccess {
  companyId: string;
  userId: string;
  /** owner/admin bypass every per-project check */
  isCompanyAdmin: boolean;
  /** projectId → the tool map that project membership resolves to */
  memberships: Map<string, ToolPermissionMap>;
  /** a company-wide assurance grant (read-only over every project) */
  assuranceAll: boolean;
  /** project-scoped assurance grants */
  assuranceProjects: Set<string>;
}

/** Load everything needed to answer visibility questions in one round trip. */
export async function loadProjectAccess(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<ProjectAccess> {
  const companyId = req.companyId!;
  const userId = req.user!.id;
  const isCompanyAdmin = req.companyRole === "owner" || req.companyRole === "admin";

  const memberships = new Map<string, ToolPermissionMap>();
  const assuranceProjects = new Set<string>();
  let assuranceAll = false;

  if (!isCompanyAdmin) {
    const rows = await app.db
      .select({
        projectId: projectMemberships.projectId,
        templateKey: projectMemberships.templateKey,
        overrides: projectMemberships.overrides,
      })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.companyId, companyId),
          eq(projectMemberships.userId, userId),
        ),
      );

    const keys = [...new Set(rows.map((r) => r.templateKey))];
    const stored = new Map<string, ToolPermissionMap>();
    if (keys.length > 0) {
      const templates = await app.db
        .select({ key: permissionTemplates.key, tools: permissionTemplates.tools })
        .from(permissionTemplates)
        .where(eq(permissionTemplates.companyId, companyId));
      for (const t of templates) stored.set(t.key, t.tools as ToolPermissionMap);
    }
    for (const row of rows) {
      // Same merge order as requireTool: the builtin underneath the stored
      // template, so a tenant seeded before a tool existed still inherits it.
      const builtin = BUILTIN_PERMISSION_TEMPLATES.find((t) => t.key === row.templateKey)?.tools as
        | ToolPermissionMap
        | undefined;
      const storedTools = stored.get(row.templateKey);
      const template: ToolPermissionMap = { ...(builtin ?? {}), ...(storedTools ?? {}) };
      const overrides = (row.overrides ?? {}) as ToolPermissionMap;
      memberships.set(row.projectId, { ...template, ...overrides });
    }
  }

  const nowMs = Date.now();
  const grants = await app.db
    .select({ projectId: assuranceGrants.projectId, expiresAt: assuranceGrants.expiresAt })
    .from(assuranceGrants)
    .where(
      and(eq(assuranceGrants.companyId, companyId), eq(assuranceGrants.userId, userId)),
    );
  for (const g of grants) {
    if (isExpired(g.expiresAt, nowMs)) continue;
    if (g.projectId === null) assuranceAll = true;
    else assuranceProjects.add(g.projectId);
  }

  return { companyId, userId, isCompanyAdmin, memberships, assuranceAll, assuranceProjects };
}

/**
 * Every live project id the caller may see, or `null` when the caller is
 * unrestricted (owner/admin, or a tenant-wide assurance grant). `null` means
 * "do not add a project filter", never "no projects".
 */
export async function visibleProjectIds(
  app: FastifyInstance,
  req: FastifyRequest,
  access?: ProjectAccess,
): Promise<string[] | null> {
  const a = access ?? (await loadProjectAccess(app, req));
  if (a.isCompanyAdmin || a.assuranceAll) return null;
  const ids = new Set<string>([...a.memberships.keys(), ...a.assuranceProjects]);
  if (ids.size === 0) return [];
  // Drop anything soft-deleted or belonging to another tenant: a membership
  // row outlives the project it names.
  const live = await app.db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.companyId, a.companyId), isNull(projects.deletedAt)));
  const liveIds = new Set(live.map((r) => r.id));
  return [...ids].filter((id) => liveIds.has(id));
}

/** May the caller read `tool` on `projectId`? Mirrors requireTool's ladder. */
export function canUseTool(
  access: ProjectAccess,
  projectId: string,
  tool: ToolKey,
  level: PermissionLevel = "read",
): boolean {
  if (access.isCompanyAdmin) return true;
  const map = access.memberships.get(projectId);
  if (map && meetsLevel(resolveLevel(tool, map, {}), level)) return true;
  // Assurance roles are read-only visibility over operational tools.
  if (level === "read" && (access.assuranceAll || access.assuranceProjects.has(projectId))) {
    return true;
  }
  return false;
}

/**
 * The live project ids where the caller holds at least `level` on `tool`.
 * `null` again means unrestricted. Used by cross-project readers (search,
 * audit) so a hit is never returned for a tool the caller cannot open.
 */
export async function projectIdsForTool(
  app: FastifyInstance,
  req: FastifyRequest,
  tool: ToolKey,
  level: PermissionLevel = "read",
  access?: ProjectAccess,
): Promise<string[] | null> {
  const a = access ?? (await loadProjectAccess(app, req));
  if (a.isCompanyAdmin) return null;
  const candidates = await visibleProjectIds(app, req, a);
  if (candidates === null) return null;
  return candidates.filter((id) => canUseTool(a, id, tool, level));
}

/** Live (not soft-deleted) project ids in the tenant. */
export async function liveProjectIds(app: FastifyInstance, companyId: string): Promise<string[]> {
  const rows = await app.db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt)));
  return rows.map((r) => r.id);
}

/**
 * Assert a project exists in the tenant and is not soft-deleted.
 *
 * `requireTool` resolves the project without a `deleted_at` filter (it is a
 * shared plugin this package does not own), so every route in this package
 * that acts on a project runs this immediately after the gate. Returns the
 * project row so the caller does not read it twice.
 */
export async function requireLiveProject(app: FastifyInstance, companyId: string, projectId: string) {
  const rows = await app.db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.companyId, companyId),
        isNull(projects.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
