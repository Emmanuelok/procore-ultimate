/**
 * Analytics row-level and column-level security (spec Vol I §6.1 #751).
 *
 * WHAT WAS WRONG. Analytics resolved reach as "every project you hold ANY
 * membership on". A membership on the built-in `subcontractor` template holds
 * `none` on workforce, payments, finance, commercial and assurance — and could
 * nevertheless run a report over `workers` and read every person's name,
 * nationality and daily rate, because the report executor never asked the
 * membership what level it carried. The module's own comment claimed analytics
 * "is never a wider door than the module it reports on"; it was.
 *
 * WHAT IS TRUE NOW. Every dataset declares a governing ToolKey and every column
 * a sensitivity class (see datasets.ts). This file resolves the caller's
 * EFFECTIVE LEVEL on that tool, per project, through the same
 * template + overrides + assurance-grant path `requireTool` uses in
 * plugins/auth.ts — the same answer, computed in bulk for a company-wide run
 * instead of one project at a time.
 *
 * The resolution is memoised PER REQUEST: a dashboard executes up to twelve
 * widgets and each used to recompute the caller's memberships twice, which was
 * sixty-odd queries for one page load. `reachFor` is now computed once per
 * (tool, level) pair and reused.
 *
 * It deliberately does NOT do: cross-company reach (there is none), a
 * "read-only analytics" bypass (a report is a read of the underlying record and
 * is governed as one), or any notion of a report being "shared" widening reach
 * (sharing a definition shares the QUESTION, never the answer).
 */
import type { FastifyRequest } from "fastify";
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
  type PermissionLevel,
  type ToolKey,
  type ToolPermissionMap,
} from "@constructos/shared";
import { badRequest, forbidden } from "../../lib/errors.js";
import type { Db } from "../../lib/db.js";

/**
 * `null` means unrestricted — the caller reaches every project in the company
 * at this level. An array is exhaustive, and an empty array is a real answer:
 * a user on no project reaches nothing, and their report returns no rows
 * rather than everything.
 */
export type Reach = string[] | null;

interface Membership {
  projectId: string;
  templateKey: string;
  overrides: ToolPermissionMap;
}

interface Grant {
  projectId: string | null;
  expiresAt: string | null;
}

/**
 * Everything about one caller that reach depends on, loaded once. Held on the
 * request object, so it lives exactly as long as the request does.
 */
export class AnalyticsReach {
  private memberships: Membership[] | null = null;
  private grants: Grant[] | null = null;
  private templates: Map<string, ToolPermissionMap> | null = null;
  private readonly cache = new Map<string, Reach>();
  private projectIndex: Map<string, Membership> | null = null;

  constructor(
    private readonly db: Db,
    private readonly companyId: string,
    private readonly userId: string,
    private readonly isCompanyAdmin: boolean,
  ) {}

  private async load(): Promise<void> {
    if (this.memberships && this.grants && this.templates) return;
    const [memberships, grants, templateRows] = await Promise.all([
      this.db
        .select({
          projectId: projectMemberships.projectId,
          templateKey: projectMemberships.templateKey,
          overrides: projectMemberships.overrides,
        })
        .from(projectMemberships)
        .where(
          and(
            eq(projectMemberships.companyId, this.companyId),
            eq(projectMemberships.userId, this.userId),
          ),
        ),
      this.db
        .select({ projectId: assuranceGrants.projectId, expiresAt: assuranceGrants.expiresAt })
        .from(assuranceGrants)
        .where(
          and(
            eq(assuranceGrants.companyId, this.companyId),
            eq(assuranceGrants.userId, this.userId),
          ),
        ),
      this.db
        .select({ key: permissionTemplates.key, tools: permissionTemplates.tools })
        .from(permissionTemplates)
        .where(eq(permissionTemplates.companyId, this.companyId)),
    ]);
    this.memberships = memberships.map((m) => ({
      projectId: m.projectId,
      templateKey: m.templateKey,
      overrides: (m.overrides ?? {}) as ToolPermissionMap,
    }));
    const now = new Date().toISOString();
    this.grants = grants.filter((g) => !g.expiresAt || g.expiresAt > now);
    // The stored template merged OVER the builtin one, exactly as
    // plugins/auth.ts does it: a tenant seeded before a tool existed still
    // inherits that tool's builtin level rather than silently getting "none".
    this.templates = new Map(
      templateRows.map((row) => {
        const builtin = BUILTIN_PERMISSION_TEMPLATES.find((t) => t.key === row.key)?.tools;
        const stored = (row.tools ?? {}) as ToolPermissionMap;
        return [row.key, { ...(builtin ?? {}), ...stored } as ToolPermissionMap];
      }),
    );
    this.projectIndex = new Map(this.memberships.map((m) => [m.projectId, m]));
  }

  /** The caller's effective level on `tool` for one project. */
  async levelFor(projectId: string, tool: ToolKey): Promise<PermissionLevel> {
    if (this.isCompanyAdmin) return "admin";
    await this.load();
    const membership = this.projectIndex!.get(projectId);
    let level: PermissionLevel = "none";
    if (membership) {
      const builtin = BUILTIN_PERMISSION_TEMPLATES.find(
        (t) => t.key === membership.templateKey,
      )?.tools;
      const template = this.templates!.get(membership.templateKey) ?? builtin;
      level = resolveLevel(tool, template as ToolPermissionMap | undefined, membership.overrides);
    }
    // An assurance grant is read-only visibility over operational tools — the
    // same read-through plugins/auth.ts grants, and never more than read.
    if (!meetsLevel(level, "read")) {
      const covering = this.grants!.some((g) => g.projectId === null || g.projectId === projectId);
      if (covering) level = "read";
    }
    return level;
  }

  /**
   * Projects where the caller holds at least `level` on `tool`. Memoised per
   * (tool, level) for the life of the request.
   */
  async reachFor(tool: ToolKey, level: PermissionLevel): Promise<Reach> {
    const key = `${tool}:${level}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const answer = await this.computeReach(tool, level);
    this.cache.set(key, answer);
    return answer;
  }

  private async computeReach(tool: ToolKey, level: PermissionLevel): Promise<Reach> {
    if (this.isCompanyAdmin) return null;
    await this.load();
    // A company-wide assurance grant is read across the tenant, and nothing
    // more: it never satisfies a standard-level request.
    if (level === "read" && this.grants!.some((g) => g.projectId === null)) return null;
    const out = new Set<string>();
    for (const m of this.memberships!) {
      const builtin = BUILTIN_PERMISSION_TEMPLATES.find((t) => t.key === m.templateKey)?.tools;
      const template = this.templates!.get(m.templateKey) ?? builtin;
      const effective = resolveLevel(
        tool,
        template as ToolPermissionMap | undefined,
        m.overrides,
      );
      if (meetsLevel(effective, level)) out.add(m.projectId);
    }
    if (level === "read") {
      for (const g of this.grants!) if (g.projectId) out.add(g.projectId);
    }
    return [...out];
  }

  /**
   * The project must be in this company, and the caller must hold at least
   * `read` on the dataset's tool there. 400 when the project is not the
   * tenant's (it is a bad request, not a permission problem); 403 when it is
   * theirs and they may not read it.
   */
  async assertProjectReadable(projectId: string, tool: ToolKey): Promise<void> {
    const rows = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, this.companyId)))
      .limit(1);
    if (!rows[0]) throw badRequest("projectId is not a project in this company");
    const level = await this.levelFor(projectId, tool);
    if (!meetsLevel(level, "read")) {
      throw forbidden(`Requires read access to ${tool} on this project`);
    }
  }

  /** Projects of this company the caller is a member of (or holds a grant over). */
  async anyReach(): Promise<Reach> {
    if (this.isCompanyAdmin) return null;
    await this.load();
    if (this.grants!.some((g) => g.projectId === null)) return null;
    const out = new Set<string>(this.memberships!.map((m) => m.projectId));
    for (const g of this.grants!) if (g.projectId) out.add(g.projectId);
    return [...out];
  }

  /** Restrict a candidate list to the ids in `reach` (null = no restriction). */
  static narrow(reach: Reach, candidates: string[]): string[] {
    if (reach === null) return candidates;
    const set = new Set(reach);
    return candidates.filter((c) => set.has(c));
  }
}

declare module "fastify" {
  interface FastifyRequest {
    /** per-request memoised analytics reach; built by `reachOf` */
    analyticsReach?: AnalyticsReach;
  }
}

/** The request-scoped reach resolver. One per request, built on first use. */
export function reachOf(db: Db, req: FastifyRequest): AnalyticsReach {
  if (!req.analyticsReach) {
    req.analyticsReach = new AnalyticsReach(
      db,
      req.companyId!,
      req.user!.id,
      req.companyRole === "owner" || req.companyRole === "admin",
    );
  }
  return req.analyticsReach;
}

/** The intersection of two reaches (null = unrestricted). */
export function intersectReach(a: Reach, b: Reach): Reach {
  if (a === null) return b;
  if (b === null) return a;
  const set = new Set(b);
  return a.filter((id) => set.has(id));
}

/** True when `ids` may all be read (used for id-in-list checks). */
export function reachIncludes(reach: Reach, projectId: string): boolean {
  return reach === null || reach.includes(projectId);
}

export { meetsLevel };
