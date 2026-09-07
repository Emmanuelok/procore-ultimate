/**
 * Which projects a caller may see on company-level intelligence routes
 * (plan §6.3). Company owners and admins see every project; everyone else
 * sees the projects they are a member of plus any covered by a live
 * assurance grant (a grant with no projectId covers the whole company).
 *
 * Returns `null` for "all projects" so callers can skip the filter, and a
 * Set otherwise. Deliberately independent of modules/projects so it works
 * whether or not WP-SUBSTRATE lands a shared helper.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { assuranceGrants, permissionTemplates, projectMemberships, projects } from "@constructos/db";
import {
  BUILTIN_PERMISSION_TEMPLATES,
  meetsLevel,
  resolveLevel,
  type ToolPermissionMap,
} from "@constructos/shared";
import { isExpired } from "../../lib/time.js";

export async function visibleProjectIds(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<Set<string> | null> {
  const companyId = req.companyId!;
  const userId = req.user!.id;
  if (req.companyRole === "owner" || req.companyRole === "admin") return null;

  const nowMs = Date.now();
  const [memberRows, grantRows] = await Promise.all([
    app.db
      .select({ projectId: projectMemberships.projectId })
      .from(projectMemberships)
      .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
      .where(and(eq(projectMemberships.userId, userId), eq(projects.companyId, companyId))),
    app.db
      .select({ projectId: assuranceGrants.projectId, expiresAt: assuranceGrants.expiresAt })
      .from(assuranceGrants)
      .where(and(eq(assuranceGrants.companyId, companyId), eq(assuranceGrants.userId, userId))),
  ]);
  const visible = new Set<string>(memberRows.map((r) => r.projectId));
  for (const g of grantRows) {
    if (isExpired(g.expiresAt, nowMs)) continue;
    if (g.projectId === null) return null;
    visible.add(g.projectId);
  }
  return visible;
}

/** True when the caller may see `projectId` (null = company-level item, visible to every member). */
export function canSeeProject(visible: Set<string> | null, projectId: string | null): boolean {
  if (visible === null) return true;
  if (projectId === null) return true;
  return visible.has(projectId);
}

/**
 * May the caller ACT on a project-scoped item (dismiss, reopen)? Seeing is
 * not acting: an assurance grant is read-only, so it never qualifies here.
 * Company owners/admins may; otherwise the caller needs a project
 * membership whose template (builtin merged under the tenant's stored copy,
 * overrides on top — the same resolution `requireTool` performs) gives at
 * least `standard` on the intelligence tool. Company-level items (no
 * project) are open to every member.
 */
export async function canActOnProject(
  app: FastifyInstance,
  req: FastifyRequest,
  projectId: string | null,
): Promise<boolean> {
  if (projectId === null) return true;
  if (req.companyRole === "owner" || req.companyRole === "admin") return true;
  const companyId = req.companyId!;
  const [membership] = await app.db
    .select({ templateKey: projectMemberships.templateKey, overrides: projectMemberships.overrides })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.companyId, companyId),
        eq(projectMemberships.projectId, projectId),
        eq(projectMemberships.userId, req.user!.id),
      ),
    )
    .limit(1);
  if (!membership) return false;
  const [stored] = await app.db
    .select({ tools: permissionTemplates.tools })
    .from(permissionTemplates)
    .where(and(eq(permissionTemplates.companyId, companyId), eq(permissionTemplates.key, membership.templateKey)))
    .limit(1);
  return actsOnIntelligence(membership, stored ? (stored.tools as ToolPermissionMap) : undefined);
}

interface MembershipRow {
  templateKey: string;
  overrides: unknown;
}

/** The same resolution `requireTool` performs, for one membership. */
function actsOnIntelligence(membership: MembershipRow, storedTools: ToolPermissionMap | undefined): boolean {
  const builtin = BUILTIN_PERMISSION_TEMPLATES.find((t) => t.key === membership.templateKey)?.tools;
  const template: ToolPermissionMap | undefined = storedTools
    ? { ...(builtin ?? {}), ...storedTools }
    : builtin;
  return meetsLevel(resolveLevel("intelligence", template, membership.overrides as ToolPermissionMap), "standard");
}

/**
 * Every project the caller may ACT on (dismiss/reopen an attention item),
 * resolved in two queries so a list route can label its rows without one
 * permission lookup per item. `null` = every project (owner/admin).
 */
export async function actableProjectIds(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<Set<string> | null> {
  if (req.companyRole === "owner" || req.companyRole === "admin") return null;
  const companyId = req.companyId!;
  const memberships = await app.db
    .select({
      projectId: projectMemberships.projectId,
      templateKey: projectMemberships.templateKey,
      overrides: projectMemberships.overrides,
    })
    .from(projectMemberships)
    .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
    .where(and(eq(projectMemberships.userId, req.user!.id), eq(projects.companyId, companyId)));
  if (memberships.length === 0) return new Set<string>();
  const stored = await app.db
    .select({ key: permissionTemplates.key, tools: permissionTemplates.tools })
    .from(permissionTemplates)
    .where(eq(permissionTemplates.companyId, companyId));
  const byKey = new Map(stored.map((t) => [t.key, t.tools as ToolPermissionMap] as const));
  const out = new Set<string>();
  for (const m of memberships) {
    if (actsOnIntelligence(m, byKey.get(m.templateKey))) out.add(m.projectId);
  }
  return out;
}

/** True when the caller may act on `projectId` given a resolved actable set. */
export function canActWith(actable: Set<string> | null, projectId: string | null): boolean {
  if (projectId === null) return true;
  if (actable === null) return true;
  return actable.has(projectId);
}
