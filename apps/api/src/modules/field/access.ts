/**
 * Authorisation helpers local to the field module (plan §6.3).
 *
 *  - `toolLevelFor` resolves a user's effective level on a project tool the
 *    same way plugins/auth.ts `requireTool` does, for routes that are
 *    addressed by record id rather than by :projectId (photo PATCH/DELETE,
 *    submittal step responses) and for "does this actor hold admin on the
 *    tool" checks inside a handler.
 *  - `assertCompanyUsers` refuses user ids that are not members of the
 *    tenant, so ball-in-court, distribution, verifier and reviewer fields can
 *    never point at a stranger (audit: rfis.ts:137).
 *  - `projectManagerIds` lists who the escalation ladder treats as "PM".
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import {
  companyMemberships,
  locations,
  permissionTemplates,
  projectMemberships,
  vendors,
} from "@constructos/db";
import {
  BUILTIN_PERMISSION_TEMPLATES,
  meetsLevel,
  resolveLevel,
  type CompanyRole,
  type PermissionLevel,
  type ToolKey,
  type ToolPermissionMap,
} from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { badRequest, forbidden } from "../../lib/errors.js";

export interface Actor {
  userId: string;
  companyId: string;
  companyRole: CompanyRole | undefined;
}

export function isCompanyAdmin(role: CompanyRole | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** Effective level of `actor` on `tool` for `projectId`; "none" for non-members. */
export async function toolLevelFor(
  app: FastifyInstance,
  actor: Actor,
  projectId: string,
  tool: ToolKey,
): Promise<PermissionLevel> {
  if (isCompanyAdmin(actor.companyRole)) return "admin";
  const membership = (
    await app.db
      .select()
      .from(projectMemberships)
      .where(and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, actor.userId)))
      .limit(1)
  )[0];
  if (!membership) return "none";
  const templateRow = (
    await app.db
      .select({ tools: permissionTemplates.tools })
      .from(permissionTemplates)
      .where(
        and(
          eq(permissionTemplates.companyId, actor.companyId),
          eq(permissionTemplates.key, membership.templateKey),
        ),
      )
      .limit(1)
  )[0];
  const builtin = BUILTIN_PERMISSION_TEMPLATES.find((t) => t.key === membership.templateKey)?.tools;
  const stored = templateRow?.tools as ToolPermissionMap | undefined;
  const template: ToolPermissionMap | undefined = stored ? { ...(builtin ?? {}), ...stored } : builtin;
  return resolveLevel(tool, template, membership.overrides as ToolPermissionMap);
}

/** Throws 403 unless the actor meets `level` on the tool for the project. */
export async function requireToolLevel(
  app: FastifyInstance,
  actor: Actor,
  projectId: string,
  tool: ToolKey,
  level: PermissionLevel,
): Promise<PermissionLevel> {
  const effective = await toolLevelFor(app, actor, projectId, tool);
  if (!meetsLevel(effective, level)) throw forbidden(`Requires ${level} access to ${tool}`);
  return effective;
}

export async function hasToolAdmin(
  app: FastifyInstance,
  actor: Actor,
  projectId: string,
  tool: ToolKey,
): Promise<boolean> {
  return meetsLevel(await toolLevelFor(app, actor, projectId, tool), "admin");
}

/**
 * Every id in `ids` must be a member of the company. Returns the de-duplicated
 * list; throws 400 naming the first offending id.
 */
export async function assertCompanyUsers(
  db: Db,
  companyId: string,
  ids: ReadonlyArray<string | null | undefined>,
  label = "user",
): Promise<string[]> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string" && id !== ""))];
  if (wanted.length === 0) return [];
  const rows = await db
    .select({ userId: companyMemberships.userId })
    .from(companyMemberships)
    .where(and(eq(companyMemberships.companyId, companyId), inArray(companyMemberships.userId, wanted)));
  const found = new Set(rows.map((r) => r.userId));
  const missing = wanted.find((id) => !found.has(id));
  if (missing) throw badRequest(`Unknown ${label} id "${missing}" — not a member of this company`);
  return wanted;
}

/** The location must exist in this project; returns it or throws 400. */
export async function assertProjectLocation(
  db: Db,
  companyId: string,
  projectId: string,
  locationId: string | null | undefined,
): Promise<void> {
  if (!locationId) return;
  const row = (
    await db
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.id, locationId), eq(locations.companyId, companyId), eq(locations.projectId, projectId)))
      .limit(1)
  )[0];
  if (!row) throw badRequest(`Unknown location id "${locationId}" for this project`);
}

/** The vendor must belong to this company; returns silently for null. */
export async function assertVendor(
  db: Db,
  companyId: string,
  vendorId: string | null | undefined,
): Promise<void> {
  if (!vendorId) return;
  const row = (
    await db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
      .limit(1)
  )[0];
  if (!row) throw badRequest(`Unknown vendor id "${vendorId}" for this company`);
}

/** Template keys the escalation ladder treats as project management. */
const PM_TEMPLATE_KEYS: ReadonlySet<string> = new Set(["project_manager", "admin", "owner"]);

/** Project members holding a PM-class template plus company owners/admins. */
export async function projectManagerIds(db: Db, companyId: string, projectId: string): Promise<string[]> {
  const members = await db
    .select({ userId: projectMemberships.userId, templateKey: projectMemberships.templateKey })
    .from(projectMemberships)
    .where(and(eq(projectMemberships.companyId, companyId), eq(projectMemberships.projectId, projectId)));
  const admins = await db
    .select({ userId: companyMemberships.userId, role: companyMemberships.role })
    .from(companyMemberships)
    .where(eq(companyMemberships.companyId, companyId));
  const ids = new Set<string>();
  for (const m of members) if (PM_TEMPLATE_KEYS.has(m.templateKey)) ids.add(m.userId);
  for (const a of admins) if (a.role === "owner" || a.role === "admin") ids.add(a.userId);
  return [...ids];
}

/** All project member ids (for distribution defaults). */
export async function projectMemberIds(db: Db, companyId: string, projectId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: projectMemberships.userId })
    .from(projectMemberships)
    .where(and(eq(projectMemberships.companyId, companyId), eq(projectMemberships.projectId, projectId)));
  return rows.map((r) => r.userId);
}
