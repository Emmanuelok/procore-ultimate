/**
 * Delegated administration (Vol I §0.1 #27) — the ENFORCEMENT half.
 *
 * `admin_delegations` rows hand a named person a bounded slice of
 * administration: named capabilities, over named projects, with an expiry.
 * Creating, listing, revoking and expiring those rows lives in
 * modules/admin/index.ts. This file is what makes them mean something: the
 * gates below admit a caller who holds a live delegation covering the
 * operation, so an owner who delegates `memberships` over project P and then
 * removes the person's company-admin role has actually changed an
 * authorisation decision rather than filed a note.
 *
 * SCOPE RULES
 *  • A delegation with an empty `projectIds` is tenant-wide.
 *  • A delegation naming projects covers ONLY those projects, and grants
 *    nothing on a company-level route: "manage memberships on project P" is
 *    not "administer the whole directory". Company-level routes therefore
 *    require a tenant-wide delegation.
 *  • Expired (`expiresAt` in the past) and revoked delegations grant nothing,
 *    checked on every request rather than relying on the expiry sweep.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It never GRANTS a project tool level — a delegate does not become a project
 * member and cannot read the project's records through this. It only opens
 * the specific administrative routes its capability names.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gte, isNull, or } from "drizzle-orm";
import { adminDelegations } from "@constructos/db";
import type { AdminDelegationCapability, PermissionLevel, ToolKey } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { forbidden } from "../../lib/errors.js";

/**
 * Which surface each capability can reach. Stated once and served to the UI
 * so the Delegation tab stops promising a scope the API will not honour.
 */
export const DELEGATION_CAPABILITY_SCOPES: Record<
  AdminDelegationCapability,
  { scope: "company" | "project"; covers: string }
> = {
  memberships: {
    scope: "project",
    covers: "add, re-template and remove project memberships on the named projects",
  },
  directory: {
    scope: "company",
    covers:
      "vendors, contacts, distribution groups, merges, imports and the directory recycle bin (tenant-wide delegations only)",
  },
  workflow_templates: {
    scope: "project",
    covers:
      "create, edit, deactivate and retroactively apply approval templates; a tenant-wide delegation also covers company templates",
  },
  notifications: {
    scope: "company",
    covers: "run the notification digest sweep (tenant-wide delegations only)",
  },
};

export interface LiveDelegation {
  id: string;
  capabilities: string[];
  projectIds: string[];
  expiresAt: string | null;
}

/** Every delegation of this user that is live right now. */
export async function liveDelegations(
  db: Db,
  companyId: string,
  userId: string,
  now = new Date().toISOString(),
): Promise<LiveDelegation[]> {
  const rows = await db
    .select({
      id: adminDelegations.id,
      capabilities: adminDelegations.capabilities,
      projectIds: adminDelegations.projectIds,
      expiresAt: adminDelegations.expiresAt,
    })
    .from(adminDelegations)
    .where(
      and(
        eq(adminDelegations.companyId, companyId),
        eq(adminDelegations.userId, userId),
        isNull(adminDelegations.revokedAt),
        or(isNull(adminDelegations.expiresAt), gte(adminDelegations.expiresAt, now))!,
      ),
    );
  return rows;
}

/**
 * Does any of these delegations authorise `capability` here?
 *
 * `projectId === null` means a company-level route, which only a tenant-wide
 * delegation (empty `projectIds`) can reach.
 */
export function delegationCovering(
  delegations: readonly LiveDelegation[],
  capability: AdminDelegationCapability,
  projectId: string | null,
): LiveDelegation | null {
  for (const d of delegations) {
    if (!d.capabilities.includes(capability)) continue;
    const tenantWide = !d.projectIds || d.projectIds.length === 0;
    if (tenantWide) return d;
    if (projectId && d.projectIds.includes(projectId)) return d;
  }
  return null;
}

/** One query, one answer: the delegation that authorises this call, or null. */
export async function delegationFor(
  db: Db,
  companyId: string,
  userId: string,
  capability: AdminDelegationCapability,
  projectId: string | null,
): Promise<LiveDelegation | null> {
  return delegationCovering(await liveDelegations(db, companyId, userId), capability, projectId);
}

/*
 * The machine-caller marker.
 *
 * plugins/auth.ts labels every `requireTool` closure with this well-known
 * symbol so an onRoute hook can record which routes are tool-gated; machine
 * (OAuth) callers are admitted only to those. Wrapping a tool gate hides the
 * label, which would silently stop machine tokens working on the wrapped
 * routes, so the wrapper carries it forward. `Symbol.for` is a global
 * registry — this reads the same symbol the auth plugin sets, without editing
 * a shared file.
 */
const TOOL_GATE = Symbol.for("constructos.machineAuth.toolGate");

type MaybeMarked = { [TOOL_GATE]?: string };

function carryToolGateMark<T extends object>(wrapper: T, inner: object): T {
  const mark = (inner as MaybeMarked)[TOOL_GATE];
  if (mark !== undefined) (wrapper as MaybeMarked)[TOOL_GATE] = mark;
  return wrapper;
}

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * A project-scoped tool gate that ALSO admits a live delegation.
 *
 * The tool gate runs first and unchanged, so nothing an existing caller can
 * do changes. Only when it refuses does the delegation get a say, and only
 * for the project the gate already resolved and proved belongs to the tenant.
 */
export function toolGateOrDelegation(
  app: FastifyInstance,
  tool: ToolKey,
  level: PermissionLevel,
  capability: AdminDelegationCapability,
): PreHandler {
  const inner = app.requireTool(tool, level) as unknown as PreHandler;
  const wrapper: PreHandler = async (req, reply) => {
    try {
      await inner(req, reply);
      return;
    } catch (err) {
      // Only a permission refusal is negotiable. If the gate never resolved a
      // project (missing param, project outside the tenant, no company
      // context) there is nothing a delegation could be scoped to.
      const params = req.params as Record<string, string | undefined>;
      const projectId = params["projectId"];
      if (!projectId || req.projectId !== projectId || !req.companyId || !req.user) throw err;
      const covering = await delegationFor(
        app.db,
        req.companyId,
        req.user.id,
        capability,
        projectId,
      );
      if (!covering) throw err;
    }
  };
  return carryToolGateMark(wrapper, inner as object);
}

/**
 * A company-level admin gate that also admits a TENANT-WIDE delegation.
 *
 * Used where the route has no project to scope to. A project-scoped
 * delegation deliberately does not open these.
 */
export function companyAdminOrDelegation(
  app: FastifyInstance,
  capability: AdminDelegationCapability,
): PreHandler {
  return async (req) => {
    if (req.companyRole === "owner" || req.companyRole === "admin") return;
    if (!req.companyId || !req.user) throw forbidden("Company context not resolved");
    const covering = await delegationFor(
      app.db,
      req.companyId,
      req.user.id,
      capability,
      null,
    );
    if (!covering) {
      throw forbidden(
        `Requires company owner/admin, or a tenant-wide "${capability}" administration delegation`,
      );
    }
  };
}
