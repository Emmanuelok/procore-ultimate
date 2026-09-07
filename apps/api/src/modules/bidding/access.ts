import type { FastifyInstance, FastifyRequest } from "fastify";
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
  type ToolPermissionMap,
} from "@constructos/shared";
import { forbidden } from "../../lib/errors.js";
import { isExpired } from "../../lib/time.js";
import type { Db } from "../../lib/db.js";

/**
 * COMPANY-LEVEL BIDDING ACCESS.
 *
 * `app.requireTool("bidding", …)` resolves a project from `:projectId`, so it
 * cannot guard a `/companies/current/...` route. Without something in its
 * place the company surface of this module was the module's back door: the
 * per-vendor pricing history, every amount a named supplier has ever bid us,
 * their rank in each field and their deviation from the pre-tender estimate
 * — the most commercially sensitive data the module holds — were reachable
 * with plain company membership by a user whose `bidding` level is `none` and
 * who is refused the tabulation of a single package.
 *
 * This resolves the same permission the project gate resolves, once, over
 * every project the caller belongs to:
 *
 *   - a company owner or admin sees everything (as `requireTool` lets them);
 *   - a live tenant-wide assurance grant sees everything READ-ONLY (as
 *     `requireTool` does at level `read`);
 *   - anyone else sees exactly the projects where their template + overrides
 *     resolve `bidding` to at least the required level, plus the projects a
 *     project-scoped assurance grant covers (read only);
 *   - a caller with no such project is refused outright, rather than being
 *     handed a company-wide answer.
 *
 * Callers that aggregate MUST pass the resulting scope into their queries —
 * `scopeToProjects` is the helper for that — because a company-wide
 * aggregate over projects the caller cannot open is the same disclosure
 * wearing a percentage sign.
 */
export interface BiddingScope {
  /** true when the caller may read every project's bidding data. */
  all: boolean;
  /** When `all` is false, the projects the caller may read. Never empty. */
  projectIds: string[];
  /** How the scope was arrived at, for the response's own honesty note. */
  basis: string;
}

export async function resolveBiddingScope(
  db: Db,
  req: FastifyRequest,
  level: "read" | "standard" | "admin" = "read",
): Promise<BiddingScope> {
  const companyId = req.companyId;
  const userId = req.user?.id;
  if (!companyId || !userId) throw forbidden("Company context not resolved");

  if (req.companyRole === "owner" || req.companyRole === "admin") {
    return { all: true, projectIds: [], basis: "Company owner/admin — every project." };
  }

  const nowMs = Date.now();
  const grants = await db
    .select()
    .from(assuranceGrants)
    .where(and(eq(assuranceGrants.companyId, companyId), eq(assuranceGrants.userId, userId)));
  const liveGrants = grants.filter((g) => !isExpired(g.expiresAt, nowMs));
  // An assurance grant is read-only visibility, exactly as in `requireTool`.
  if (level === "read" && liveGrants.some((g) => g.projectId === null)) {
    return {
      all: true,
      projectIds: [],
      basis: "Tenant-wide assurance grant — read access to every project.",
    };
  }

  const memberships = await db
    .select()
    .from(projectMemberships)
    .where(eq(projectMemberships.userId, userId));
  const allowed = new Set<string>();

  if (memberships.length > 0) {
    const templateKeys = [...new Set(memberships.map((m) => m.templateKey))];
    const storedRows = await db
      .select({ key: permissionTemplates.key, tools: permissionTemplates.tools })
      .from(permissionTemplates)
      .where(
        and(
          eq(permissionTemplates.companyId, companyId),
          inArray(permissionTemplates.key, templateKeys),
        ),
      );
    const storedByKey = new Map(
      storedRows.map((r) => [r.key, r.tools as ToolPermissionMap] as const),
    );
    for (const m of memberships) {
      const builtin = BUILTIN_PERMISSION_TEMPLATES.find((t) => t.key === m.templateKey)?.tools;
      const stored = storedByKey.get(m.templateKey);
      const template: ToolPermissionMap | undefined = stored
        ? { ...(builtin ?? {}), ...stored }
        : builtin;
      const effective = resolveLevel("bidding", template, m.overrides as ToolPermissionMap);
      if (meetsLevel(effective, level)) allowed.add(m.projectId);
    }
  }

  if (level === "read") {
    for (const g of liveGrants) if (g.projectId) allowed.add(g.projectId);
  }

  if (allowed.size === 0) {
    throw forbidden(
      `Requires ${level} access to bidding on at least one project. Company-level bidding ` +
        "analytics report on the same amounts as the package screens, so they are held to the " +
        "same permission rather than to plain company membership.",
    );
  }

  // Never trust a membership row to imply the project is in this tenant.
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), inArray(projects.id, [...allowed])));
  const projectIds = rows.map((r) => r.id);
  if (projectIds.length === 0) {
    throw forbidden(
      `Requires ${level} access to bidding on at least one project in this company.`,
    );
  }
  return {
    all: false,
    projectIds,
    basis:
      `Scoped to the ${projectIds.length} project(s) where you hold bidding:${level}. ` +
      "Figures below are computed from those projects only.",
  };
}

/**
 * A preHandler for `/companies/current/...` bidding routes. It resolves the
 * scope (throwing 403 when the caller holds the tool nowhere) and stashes it
 * so the handler can filter its queries without resolving it twice.
 */
const SCOPE_KEY = Symbol.for("constructos.bidding.scope");

export function requireBiddingScope(app: FastifyInstance, level: "read" | "standard" = "read") {
  return async (req: FastifyRequest) => {
    const scope = await resolveBiddingScope(app.db, req, level);
    (req as unknown as Record<symbol, BiddingScope>)[SCOPE_KEY] = scope;
  };
}

/** Reads the scope stashed by `requireBiddingScope`. */
export function biddingScopeOf(req: FastifyRequest): BiddingScope {
  const scope = (req as unknown as Record<symbol, BiddingScope | undefined>)[SCOPE_KEY];
  if (!scope) throw forbidden("Bidding scope not resolved");
  return scope;
}

/**
 * Adds the scope to a drizzle WHERE. Pass the project column of whichever
 * table is being read; an `all` scope adds nothing (returns undefined, which
 * drizzle's `and(...)` drops).
 */
export function scopeToProjects(
  scope: BiddingScope,
  column: Parameters<typeof inArray>[0],
): ReturnType<typeof inArray> | undefined {
  if (scope.all) return undefined;
  return inArray(column, scope.projectIds);
}
