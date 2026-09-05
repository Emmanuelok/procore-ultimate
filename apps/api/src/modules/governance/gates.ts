/**
 * Permission helpers shared by the four owner-side modules (risk,
 * governance, finance, disputes).
 *
 * Two things `app.requireTool` cannot do on its own:
 *
 *  1. COMPANY-LEVEL ROUTES. The reference-project outturn database and the
 *     cross-project reviewer workspace sit above any one project, so there
 *     is no `:projectId` for `requireTool` to resolve. On
 *     `[authenticate, requireCompany]` alone, any company member — including
 *     a guest with read-only access to one project — could seed the
 *     reference class that every business case's outside view is computed
 *     from. The rule, matching modules/tax/gates.ts and
 *     modules/equipment/gates.ts: a company-level route requires the tool at
 *     the stated level on AT LEAST ONE project in the company; owners and
 *     admins bypass; an assurance grant confers read only.
 *
 *  2. IN-ROUTE LEVEL CHECKS. Some transitions are open to standard users and
 *     some are not — reversing a realised risk, releasing contingency above
 *     a threshold, deciding a gate. Those routes are gated at `standard` and
 *     ask `holdsToolLevel(…, "admin")` for the privileged branch, so the
 *     ordinary path stays available and the privileged one is refused with
 *     an explanation rather than a blanket 403 on the whole route.
 */
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
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
  type AssuranceRole,
  type PermissionLevel,
  type ToolKey,
  type ToolPermissionMap,
} from "@constructos/shared";
import { forbidden, unauthorized } from "../../lib/errors.js";
import { isExpired } from "../../lib/time.js";

interface MembershipRow {
  projectId: string;
  templateKey: string;
  overrides: unknown;
}

async function membershipsIn(
  app: FastifyInstance,
  req: FastifyRequest,
  projectId?: string,
): Promise<MembershipRow[]> {
  const clauses = [
    eq(projectMemberships.userId, req.user!.id),
    eq(projects.companyId, req.companyId!),
  ];
  if (projectId) clauses.push(eq(projectMemberships.projectId, projectId));
  return app.db
    .select({
      projectId: projectMemberships.projectId,
      templateKey: projectMemberships.templateKey,
      overrides: projectMemberships.overrides,
    })
    .from(projectMemberships)
    .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
    .where(and(...clauses));
}

async function effectiveLevels(
  app: FastifyInstance,
  companyId: string,
  rows: MembershipRow[],
  tool: ToolKey,
  level: PermissionLevel,
): Promise<string[]> {
  if (rows.length === 0) return [];
  const keys = [...new Set(rows.map((r) => r.templateKey))];
  const stored = await app.db
    .select({ key: permissionTemplates.key, tools: permissionTemplates.tools })
    .from(permissionTemplates)
    .where(
      and(eq(permissionTemplates.companyId, companyId), inArray(permissionTemplates.key, keys)),
    );
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

/** Every project in the company on which the caller holds `tool` at `level`. */
export async function projectsWithTool(
  app: FastifyInstance,
  req: FastifyRequest,
  tool: ToolKey,
  level: PermissionLevel,
): Promise<string[]> {
  const rows = await membershipsIn(app, req);
  return effectiveLevels(app, req.companyId!, rows, tool, level);
}

/**
 * Does the caller hold `tool` at `level` on THIS project? Company owners and
 * admins always do. Used for the privileged branch inside a standard-gated
 * route; never as a substitute for the route's own gate.
 */
export async function holdsToolLevel(
  app: FastifyInstance,
  req: FastifyRequest,
  tool: ToolKey,
  level: PermissionLevel,
): Promise<boolean> {
  if (req.companyRole === "owner" || req.companyRole === "admin") return true;
  if (!req.projectId) return false;
  const rows = await membershipsIn(app, req, req.projectId);
  const held = await effectiveLevels(app, req.companyId!, rows, tool, level);
  return held.length > 0;
}

/** Whether a live assurance grant covers anything at all (read-only visibility). */
export async function assuranceCoverage(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<AssuranceRole | null> {
  const grants = await app.db
    .select()
    .from(assuranceGrants)
    .where(
      and(eq(assuranceGrants.companyId, req.companyId!), eq(assuranceGrants.userId, req.user!.id)),
    );
  const now = Date.now();
  const live = grants.filter((g) => !isExpired(g.expiresAt, now));
  return live.length > 0 ? ((live[0]!.role as AssuranceRole) ?? null) : null;
}

/**
 * Is the caller an independent assurance reviewer — an integrity_reviewer or
 * auditor grant, or a company owner/admin? Gate decisions and disbursement
 * certification require this: a delivery-side project member deciding their
 * own gate is the assurance failure the module exists to prevent (#411,
 * #415).
 */
export async function isIndependentReviewer(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<{ independent: boolean; basis: string }> {
  const role = await assuranceCoverage(app, req);
  if (role === "integrity_reviewer" || role === "auditor") {
    return { independent: true, basis: `Holds the ${role} assurance grant for this company.` };
  }
  if (req.companyRole === "owner" || req.companyRole === "admin") {
    return { independent: true, basis: `Company ${req.companyRole}.` };
  }
  return {
    independent: false,
    basis:
      "No assurance grant and not a company owner or admin — a delivery-side member cannot be the independent reviewer of their own gate.",
  };
}

/** preHandler for a company-level route in this area. */
export function companyToolGate(
  app: FastifyInstance,
  tool: ToolKey,
  level: PermissionLevel,
): preHandlerHookHandler {
  return async (req: FastifyRequest) => {
    if (!req.user || !req.companyId) throw unauthorized("Company context not resolved");
    if (req.companyRole === "owner" || req.companyRole === "admin") return;
    const held = await projectsWithTool(app, req, tool, level);
    if (held.length > 0) return;
    if (level === "read") {
      const role = await assuranceCoverage(app, req);
      if (role) {
        req.assuranceRole = role;
        return;
      }
    }
    throw forbidden(
      `Requires ${level} access to ${tool} on at least one project in this company. This register ` +
        `sits above the projects — every project reads it — so it is gated by the same tool the ` +
        `project routes are.`,
    );
  };
}

/**
 * Project ids the caller may see company-wide lists for. `null` means "all"
 * (owner/admin), matching the convention in modules/intelligence/visibility.ts.
 */
export async function visibleProjectIds(
  app: FastifyInstance,
  req: FastifyRequest,
  tool: ToolKey,
): Promise<string[] | null> {
  if (req.companyRole === "owner" || req.companyRole === "admin") return null;
  const held = await projectsWithTool(app, req, tool, "read");
  if (held.length > 0) return held;
  const role = await assuranceCoverage(app, req);
  if (role) return null; // an assurance grant is read-all by design
  return [];
}
