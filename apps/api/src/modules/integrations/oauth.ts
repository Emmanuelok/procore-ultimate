import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  assuranceGrants,
  permissionTemplates,
  projectMemberships,
  projects,
} from "@constructos/db";
import {
  BUILTIN_PERMISSION_TEMPLATES,
  PERMISSION_LEVELS,
  TOOLS,
  meetsLevel,
  resolveLevel,
  type CompanyRole,
  type PermissionLevel,
  type ToolKey,
  type ToolPermissionMap,
} from "@constructos/shared";
import type { Db } from "../../lib/db.js";

/**
 * Vol I §0.7 #120 — scopes for machine callers.
 *
 * A scope is a `tool:level` pair drawn from the SAME vocabulary humans are
 * governed by (`TOOLS` x `PERMISSION_LEVELS`). That is deliberate: a machine
 * caller is not a second permission system running beside the first, it is an
 * actor inside the existing one. `requireTool("rfis","standard")` asks a
 * machine client exactly the question it asks a person, and gets the answer
 * from the client's scopes instead of from a project membership.
 */

export interface Scope {
  tool: ToolKey;
  level: PermissionLevel;
}

/**
 * Compare timestamps as instants, never as strings.
 *
 * Postgres hands back `2026-08-25 11:05:40.142+00` while `toISOString()`
 * produces `2026-08-25T11:05:40.142Z`, and a lexicographic comparison of the
 * two is wrong in a way that fails open or closed depending on the operator —
 * a space sorts before `T`, so a live token reads as expired. Every expiry
 * check in this module goes through here.
 */
import { epochMs, isExpired } from "../../lib/time.js";

export { epochMs, isExpired };

const TOOL_SET = new Set<string>(TOOLS);
const LEVEL_SET = new Set<string>(PERMISSION_LEVELS);

export function formatScope(scope: Scope): string {
  return `${scope.tool}:${scope.level}`;
}

/** OAuth2 delivers scope as a space-delimited string; we also accept arrays. */
export function splitScopeString(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export interface ScopeParseResult {
  ok: boolean;
  scopes: Scope[];
  invalid: string[];
}

export function parseScopes(raw: string[]): ScopeParseResult {
  const scopes: Scope[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const value = entry.trim();
    const idx = value.lastIndexOf(":");
    const tool = idx === -1 ? "" : value.slice(0, idx);
    const level = idx === -1 ? "" : value.slice(idx + 1);
    if (!TOOL_SET.has(tool) || !LEVEL_SET.has(level) || level === "none") {
      invalid.push(entry);
      continue;
    }
    const key = `${tool}:${level}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scopes.push({ tool: tool as ToolKey, level: level as PermissionLevel });
  }
  return { ok: invalid.length === 0, scopes, invalid };
}

/** Does this client's scope set satisfy a `requireTool(tool, level)` check? */
export function scopesAllow(
  scopeStrings: string[],
  tool: ToolKey,
  level: PermissionLevel,
): boolean {
  for (const raw of scopeStrings) {
    const idx = raw.lastIndexOf(":");
    if (idx === -1) continue;
    if (raw.slice(0, idx) !== tool) continue;
    const granted = raw.slice(idx + 1);
    if (!LEVEL_SET.has(granted)) continue;
    if (meetsLevel(granted as PermissionLevel, level)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* The escalation ceiling                                              */
/* ------------------------------------------------------------------ */

export interface ScopeCeiling {
  levels: Record<string, PermissionLevel>;
  basis: string;
}

const LEVEL_ORDER: Record<PermissionLevel, number> = {
  none: 0,
  read: 1,
  standard: 2,
  admin: 3,
};

function higher(a: PermissionLevel, b: PermissionLevel): PermissionLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}

/**
 * The highest level the CREATOR themselves holds, per tool. A client may never
 * be granted more than this — otherwise creating a machine client would be a
 * privilege-escalation primitive: mint a client with scopes you do not have,
 * then act through it.
 *
 * Company owners and admins bypass tool-level checks (plugins/auth.ts), so
 * their ceiling is `admin` on every tool — with ONE carve-out that is the
 * whole point of the assurance layer: `assurance` is not granted by company
 * role. permissions.ts is explicit that operational admins must not be able to
 * disposition signals about their own records, and a machine client is a
 * perfectly good laundering route for exactly that. So the `assurance` ceiling
 * is taken from the creator's own assurance grant, and an owner without one
 * cannot mint a client that has one.
 *
 * For a creator who is neither owner nor admin the ceiling is computed the
 * long way — the maximum effective level their project memberships resolve to
 * across this company. Today's routes require owner/admin, so that path is
 * belt-and-braces; it means the guarantee survives a future gate change
 * instead of silently becoming vacuous.
 */
export async function creatorScopeCeiling(
  db: Db,
  input: { companyId: string; userId: string; companyRole: CompanyRole | undefined },
): Promise<ScopeCeiling> {
  const levels: Record<string, PermissionLevel> = {};

  const nowMs = Date.now();
  const grants = await db
    .select()
    .from(assuranceGrants)
    .where(
      and(eq(assuranceGrants.companyId, input.companyId), eq(assuranceGrants.userId, input.userId)),
    );
  const holdsAssurance = grants.some((g) => !isExpired(g.expiresAt, nowMs));

  if (input.companyRole === "owner" || input.companyRole === "admin") {
    for (const tool of TOOLS) levels[tool] = "admin";
    // Assurance is granted, never inherited from an operational role.
    levels["assurance"] = holdsAssurance ? "read" : "none";
    return {
      levels,
      basis:
        `company role "${input.companyRole}" (bypasses tool-level checks on every project), ` +
        `assurance from ${holdsAssurance ? "an active assurance grant" : "no assurance grant"}`,
    };
  }

  for (const tool of TOOLS) levels[tool] = "none";
  const memberships = await db
    .select({
      templateKey: projectMemberships.templateKey,
      overrides: projectMemberships.overrides,
    })
    .from(projectMemberships)
    .innerJoin(projects, eq(projectMemberships.projectId, projects.id))
    .where(
      and(eq(projects.companyId, input.companyId), eq(projectMemberships.userId, input.userId)),
    );

  const templateKeys = [...new Set(memberships.map((m) => m.templateKey))];
  const storedTemplates = templateKeys.length
    ? await db
        .select({ key: permissionTemplates.key, tools: permissionTemplates.tools })
        .from(permissionTemplates)
        .where(
          and(
            eq(permissionTemplates.companyId, input.companyId),
            inArray(permissionTemplates.key, templateKeys),
          ),
        )
    : [];
  const storedByKey = new Map(storedTemplates.map((t) => [t.key, t.tools as ToolPermissionMap]));

  for (const membership of memberships) {
    const builtin = BUILTIN_PERMISSION_TEMPLATES.find(
      (t) => t.key === membership.templateKey,
    )?.tools;
    const stored = storedByKey.get(membership.templateKey);
    const template: ToolPermissionMap | undefined = stored
      ? { ...(builtin ?? {}), ...stored }
      : builtin;
    for (const tool of TOOLS) {
      const effective = resolveLevel(tool, template, membership.overrides as ToolPermissionMap);
      levels[tool] = higher(levels[tool] ?? "none", effective);
    }
  }
  levels["assurance"] = holdsAssurance ? "read" : "none";
  return {
    levels,
    basis: `maximum effective level across ${memberships.length} project membership(s)`,
  };
}

export interface EscalationCheck {
  ok: boolean;
  refused: { scope: string; creatorHolds: PermissionLevel }[];
}

export function checkEscalation(scopes: Scope[], ceiling: ScopeCeiling): EscalationCheck {
  const refused: { scope: string; creatorHolds: PermissionLevel }[] = [];
  for (const scope of scopes) {
    const held = ceiling.levels[scope.tool] ?? "none";
    if (!meetsLevel(held, scope.level)) {
      refused.push({ scope: formatScope(scope), creatorHolds: held });
    }
  }
  return { ok: refused.length === 0, refused };
}

/** Whether a user holds any live assurance grant — used by the ceiling above. */
export async function holdsAssuranceGrant(
  db: Db,
  companyId: string,
  userId: string,
  projectId?: string,
): Promise<boolean> {
  const nowMs = Date.now();
  const rows = await db
    .select()
    .from(assuranceGrants)
    .where(
      and(
        eq(assuranceGrants.companyId, companyId),
        eq(assuranceGrants.userId, userId),
        projectId
          ? or(isNull(assuranceGrants.projectId), eq(assuranceGrants.projectId, projectId))
          : undefined,
      ),
    );
  return rows.some((g) => !isExpired(g.expiresAt, nowMs));
}

/** The catalogue a UI needs to build a scope picker. */
export function scopeCatalogue() {
  return {
    tools: TOOLS,
    levels: PERMISSION_LEVELS.filter((l) => l !== "none"),
    format: "tool:level",
    examples: ["rfis:read", "documents:standard", "ingestion:admin"],
    note:
      "Scopes are the platform's own tool/level vocabulary, so a machine caller passes exactly " +
      "the same requireTool checks a person does. A client can never be granted a level higher " +
      "than its creator holds; `assurance` in particular is only grantable by a creator who " +
      "holds a live assurance grant, because company role does not confer it.",
  };
}
