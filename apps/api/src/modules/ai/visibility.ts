/**
 * Which projects a caller may see on the COMPANY-level AI routes (plan §6.3).
 *
 * This exists because of a real defect: `GET /ai/runs` and `GET /ai/review`
 * were gated on company membership alone and returned every column —
 * including 20k characters of drawing OCR, RFI questions, previous daily-log
 * content and full suggested responses — for every project in the tenant. A
 * `guest`, or a member with no project memberships at all (whom `requireTool`
 * refuses on every project route), could read all of it by omitting
 * projectId.
 *
 * Company owners and admins see everything. Everyone else sees the projects
 * they are a member of with at least `ai:read`, plus any covered by a live
 * assurance grant (a grant with no projectId covers the tenant).
 *
 * Deliberately independent of modules/projects so it works whether or not a
 * shared helper lands there.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { assuranceGrants, permissionTemplates, projectMemberships, projects } from "@constructos/db";
import {
  BUILTIN_PERMISSION_TEMPLATES,
  meetsLevel,
  resolveLevel,
  type PermissionLevel,
  type ToolPermissionMap,
} from "@constructos/shared";
import { isExpired } from "../../lib/time.js";

/** `null` means "every project in the company" — the caller is owner/admin. */
export async function visibleProjectIds(
  app: FastifyInstance,
  req: FastifyRequest,
  level: PermissionLevel = "read",
): Promise<Set<string> | null> {
  const companyId = req.companyId!;
  const userId = req.user!.id;
  if (req.companyRole === "owner" || req.companyRole === "admin") return null;

  const nowMs = Date.now();
  const [memberRows, grantRows, templateRows] = await Promise.all([
    app.db
      .select({
        projectId: projectMemberships.projectId,
        templateKey: projectMemberships.templateKey,
        overrides: projectMemberships.overrides,
      })
      .from(projectMemberships)
      .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
      .where(and(eq(projectMemberships.userId, userId), eq(projects.companyId, companyId))),
    app.db
      .select({ projectId: assuranceGrants.projectId, expiresAt: assuranceGrants.expiresAt })
      .from(assuranceGrants)
      .where(and(eq(assuranceGrants.companyId, companyId), eq(assuranceGrants.userId, userId))),
    app.db
      .select({ key: permissionTemplates.key, tools: permissionTemplates.tools })
      .from(permissionTemplates)
      .where(eq(permissionTemplates.companyId, companyId)),
  ]);

  const stored = new Map(templateRows.map((t) => [t.key, t.tools as ToolPermissionMap]));
  const visible = new Set<string>();
  for (const m of memberRows) {
    const builtin = BUILTIN_PERMISSION_TEMPLATES.find((t) => t.key === m.templateKey)?.tools;
    const merged: ToolPermissionMap | undefined = stored.has(m.templateKey)
      ? { ...(builtin ?? {}), ...(stored.get(m.templateKey) ?? {}) }
      : builtin;
    if (meetsLevel(resolveLevel("ai", merged, m.overrides as ToolPermissionMap), level)) {
      visible.add(m.projectId);
    }
  }

  // An assurance grant is READ-only: it widens what may be seen, never what
  // may be acted on.
  if (level === "read") {
    for (const g of grantRows) {
      if (isExpired(g.expiresAt, nowMs)) continue;
      if (g.projectId === null) return null;
      visible.add(g.projectId);
    }
  }
  return visible;
}

/** True when the caller may see a row belonging to `projectId`. */
export function canSeeProject(visible: Set<string> | null, projectId: string | null): boolean {
  if (visible === null) return true;
  // A company-scoped run (the company assistant) belongs to no project, so
  // there is no project ACL to consult; company membership is the gate.
  if (projectId === null) return true;
  return visible.has(projectId);
}

/**
 * The list-route filter. `null` = no filter needed (owner/admin); an empty
 * set means the caller sees only company-scoped rows.
 */
export function projectFilter(visible: Set<string> | null): string[] | null {
  return visible === null ? null : [...visible];
}
