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
import { assuranceGrants, projectMemberships, projects } from "@constructos/db";
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
