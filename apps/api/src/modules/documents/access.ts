/**
 * Tool-level authorisation for id-scoped routes (plan §6.3).
 *
 * `requireTool` is a route gate keyed on `:projectId`. Routes addressed by a
 * record id (`/files/:fileId`, `/sheets/:sheetId`, `/revisions/:id`) have no
 * project in the URL, so they resolve the record first and then call
 * `assertToolLevel` with the record's project. The resolution mirrors the
 * gate exactly — company owner/admin bypass, template + overrides, assurance
 * grants for read — so an id-scoped route can never be weaker than the
 * project-scoped one beside it. Non-members get 404, not 403: a record they
 * cannot see is a record they cannot enumerate.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, isNull, or } from "drizzle-orm";
import { assuranceGrants, permissionTemplates, projectMemberships, projects } from "@constructos/db";
import {
  BUILTIN_PERMISSION_TEMPLATES,
  meetsLevel,
  resolveLevel,
  type PermissionLevel,
  type ToolKey,
  type ToolPermissionMap,
} from "@constructos/shared";
import { forbidden, notFound, unauthorized } from "../../lib/errors.js";
import { isExpired } from "../../lib/time.js";

export interface ResolvedAccess {
  /** the effective level on the tool, or "none" */
  level: PermissionLevel;
  /** true when the caller is a company owner/admin (bypasses tool checks) */
  bypass: boolean;
  /** project membership template key, when a member */
  templateKey: string | null;
  isMember: boolean;
  /** an assurance grant covers the project (read only) */
  assurance: boolean;
}

/**
 * Resolve what `req.user` may do on `tool` in `projectId`. Throws 404 when
 * the project is not in the caller's company.
 */
export async function resolveToolAccess(
  app: FastifyInstance,
  req: FastifyRequest,
  projectId: string,
  tool: ToolKey,
): Promise<ResolvedAccess> {
  if (!req.user || !req.companyId) throw unauthorized("Company context not resolved");
  const project = await app.db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, req.companyId)))
    .limit(1);
  if (!project[0]) throw notFound("Not found");

  if (req.companyRole === "owner" || req.companyRole === "admin") {
    return { level: "admin", bypass: true, templateKey: null, isMember: true, assurance: false };
  }

  const membership = await app.db
    .select()
    .from(projectMemberships)
    .where(
      and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, req.user.id)),
    )
    .limit(1);
  let level: PermissionLevel = "none";
  let templateKey: string | null = null;
  if (membership[0]) {
    templateKey = membership[0].templateKey;
    const templateRow = await app.db
      .select({ tools: permissionTemplates.tools })
      .from(permissionTemplates)
      .where(
        and(
          eq(permissionTemplates.companyId, req.companyId),
          eq(permissionTemplates.key, membership[0].templateKey),
        ),
      )
      .limit(1);
    const builtin = BUILTIN_PERMISSION_TEMPLATES.find((t) => t.key === templateKey)?.tools;
    const stored = templateRow[0]?.tools as ToolPermissionMap | undefined;
    const template: ToolPermissionMap | undefined = stored
      ? { ...(builtin ?? {}), ...stored }
      : builtin;
    level = resolveLevel(tool, template, membership[0].overrides as ToolPermissionMap);
  }

  let assurance = false;
  if (level === "none") {
    const nowMs = Date.now();
    const grants = await app.db
      .select()
      .from(assuranceGrants)
      .where(
        and(
          eq(assuranceGrants.companyId, req.companyId),
          eq(assuranceGrants.userId, req.user.id),
          or(isNull(assuranceGrants.projectId), eq(assuranceGrants.projectId, projectId)),
        ),
      );
    assurance = grants.some((g) => !isExpired(g.expiresAt, nowMs));
    if (assurance) level = "read";
  }
  return { level, bypass: false, templateKey, isMember: Boolean(membership[0]), assurance };
}

/**
 * Enforce `level` on `tool` for a project the request did not name in its
 * URL. Sets `req.projectId` so downstream ledger/notification calls carry it.
 * 404 for non-members with no access (they cannot tell the record exists);
 * 403 for members whose level is too low.
 */
export async function assertToolLevel(
  app: FastifyInstance,
  req: FastifyRequest,
  projectId: string,
  tool: ToolKey,
  level: PermissionLevel,
): Promise<ResolvedAccess> {
  const access = await resolveToolAccess(app, req, projectId, tool);
  req.projectId = projectId;
  if (access.bypass) return access;
  if (meetsLevel(access.level, level)) return access;
  if (access.level === "none") throw notFound("Not found");
  throw forbidden(`Requires ${level} access to ${tool}`);
}
