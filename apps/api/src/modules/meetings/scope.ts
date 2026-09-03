/**
 * COMPANY-LEVEL VISIBILITY for WP-MEET (meetings, learning, insurance).
 *
 * WHY THIS FILE EXISTS
 * `app.requireTool` resolves permission through `:projectId`. Every route that
 * has no `:projectId` — "my actions across the tenant", the overdue register,
 * the lessons library, the insurance programme — therefore ran on
 * `[authenticate, requireCompany]` alone, and `COMPANY_ROLES` includes
 * `guest`. A guest with one project membership, or with none at all, could
 * read every project's overdue actions (title, owner, meeting), every
 * project's policies, certificates and claim reserves, and every project's
 * draft and rejected lessons, simply by choosing the URL without a project in
 * it. That is the module's permission model bypassed by routing.
 *
 * THE RULE
 *  • owner/admin see the whole tenant (`all: true`);
 *  • everyone else sees the projects where their membership resolves the tool
 *    to at least the required level;
 *  • a live assurance grant confers READ visibility only, never write;
 *  • holding the tool nowhere is a 403 on company-level routes, not an empty
 *    list — "you have no access" and "there is nothing" are different answers
 *    and the platform must not conflate them.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not replace `requireTool` on project routes, and it is not a
 * substitute for id-addressed routes resolving their own project. It answers
 * "which set", never "may I act on this one".
 *
 * Kept inside this work package (rather than imported from modules/projects)
 * so the three modules here do not depend on another package's build order.
 */
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
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

export interface CompanyScope {
  /** true for owners, admins and tenant-wide assurance grants */
  all: boolean;
  /** the live project ids the caller may see when `all` is false */
  projectIds: string[];
  /** the tool this scope was resolved for, for error messages */
  tool: ToolKey;
}

const SCOPE_KEY = "wpMeetScope" as const;
type ScopedRequest = FastifyRequest & { [SCOPE_KEY]?: Record<string, CompanyScope> };

/** Every LIVE project in the company where the caller holds `tool` at `level`. */
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
        isNull(projects.deletedAt),
      ),
    );
  if (rows.length === 0) return [];

  const keys = [...new Set(rows.map((r) => r.templateKey))];
  const stored = keys.length
    ? await app.db
        .select({ key: permissionTemplates.key, tools: permissionTemplates.tools })
        .from(permissionTemplates)
        .where(
          and(eq(permissionTemplates.companyId, companyId), inArray(permissionTemplates.key, keys)),
        )
    : [];
  const storedByKey = new Map(stored.map((s) => [s.key, s.tools as ToolPermissionMap]));

  const out = new Set<string>();
  for (const row of rows) {
    const builtin = BUILTIN_PERMISSION_TEMPLATES.find((t) => t.key === row.templateKey)?.tools;
    const s = storedByKey.get(row.templateKey);
    const template: ToolPermissionMap | undefined = s ? { ...(builtin ?? {}), ...s } : builtin;
    const effective = resolveLevel(tool, template, row.overrides as ToolPermissionMap);
    if (meetsLevel(effective, level)) out.add(row.projectId);
  }
  return [...out];
}

/** Projects covered by a live assurance grant (a grant with no projectId = all). */
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
 * preHandler for a company-level route. Resolves the caller's visibility once
 * and stashes it on the request; `companyScopeOf(req, tool)` reads it back.
 */
export function companyToolGate(
  app: FastifyInstance,
  tool: ToolKey,
  level: PermissionLevel,
): preHandlerHookHandler {
  return async (req: FastifyRequest) => {
    if (!req.user || !req.companyId) throw unauthorized("Company context not resolved");
    const store = (req as ScopedRequest)[SCOPE_KEY] ?? {};
    const remember = (scope: CompanyScope) => {
      store[tool] = scope;
      (req as ScopedRequest)[SCOPE_KEY] = store;
    };
    if (req.companyRole === "owner" || req.companyRole === "admin") {
      remember({ all: true, projectIds: [], tool });
      return;
    }
    const held = await projectsWithTool(app, req, tool, level);
    if (held.length > 0) {
      remember({ all: false, projectIds: held, tool });
      return;
    }
    if (level === "read") {
      const cover = await assuranceCoverage(app, req);
      if (cover.all || cover.projectIds.length > 0) {
        req.assuranceRole = cover.role ?? undefined;
        remember({ all: cover.all, projectIds: cover.projectIds, tool });
        return;
      }
    }
    throw forbidden(
      `Requires ${level} access to ${tool} on at least one project in this company. This route ` +
        "sits above the projects, so it is gated by the same tool the project routes are — and " +
        "it returns only the projects you actually hold it on.",
    );
  };
}

/**
 * The scope the gate resolved. Defaults to "nothing visible" rather than
 * "everything": a handler that forgot its gate must fail closed.
 */
export function companyScopeOf(req: FastifyRequest, tool: ToolKey): CompanyScope {
  return (req as ScopedRequest)[SCOPE_KEY]?.[tool] ?? { all: false, projectIds: [], tool };
}

/**
 * A drizzle predicate restricting a NOT NULL project column to what the caller
 * may see. `undefined` (no restriction) for an unrestricted scope, and an
 * impossible predicate rather than "no filter" when the scope is empty.
 */
export function scopeProjects(
  scope: CompanyScope,
  column: Parameters<typeof inArray>[0],
): SQL | undefined {
  if (scope.all) return undefined;
  if (scope.projectIds.length === 0) return inArray(column as never, ["__none__"]);
  return inArray(column as never, scope.projectIds);
}

/**
 * As above, for a NULLABLE project column where NULL means "company-level
 * record". Company-level rows (an OCIP master policy, a published lesson) are
 * tenant assets rather than project data and stay visible to anyone who holds
 * the tool somewhere — hiding them would make the register unusable for a
 * broker who holds insurance on one job.
 */
export function scopeProjectsOrCompanyWide(
  scope: CompanyScope,
  column: Parameters<typeof inArray>[0] & Parameters<typeof isNull>[0],
): SQL | undefined {
  if (scope.all) return undefined;
  if (scope.projectIds.length === 0) return isNull(column);
  return or(isNull(column), inArray(column as never, scope.projectIds));
}

/** Guard for an id-addressed company route: may the caller see this project? */
export function scopeAllows(scope: CompanyScope, projectId: string | null): boolean {
  if (scope.all) return true;
  if (projectId === null) return true;
  return scope.projectIds.includes(projectId);
}
