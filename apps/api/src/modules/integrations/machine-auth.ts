import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { oauthAccessTokens, oauthClients, projects } from "@constructos/db";
import { sha256Hex } from "@constructos/ledger";
import type { PermissionLevel, ToolKey } from "@constructos/shared";
import { forbidden, unauthorized } from "../../lib/errors.js";
import type { Db } from "../../lib/db.js";
import { isExpired, scopesAllow } from "./oauth.js";

/**
 * Vol I §0.7 #120 — resolving an OAuth2 access token to a machine caller.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a machine caller goes THROUGH the
 * permission checks, never around them. `requireTool(tool, level)` is still
 * the gate on every route; all that changes is where the answer comes from —
 * a client's scopes instead of a person's project membership. There is no
 * second code path where a token "is trusted" and skips a check, and no
 * owner/admin bypass for machines: an OAuth client has no company role, so
 * `requireCompanyRole(["owner","admin"])` refuses it outright and a machine
 * caller can never mint credentials, its own or anyone else's.
 *
 * WHAT IT COSTS IN SHARED SURFACE: four additions to plugins/auth.ts, each
 * one or two lines and each marked there — a resolve call in `authenticate`,
 * an early branch in `requireCompany` and in `requireTool`, a label on the
 * tool gate, and an `onRoute` hook that records which routes carry one. None
 * of it can be done from inside this module: Fastify hooks and content-type
 * parsers are encapsulated per plugin, and the integrations module is
 * registered last, so nothing it adds can reach routes registered before it.
 * Making an OAuth token work on `GET /projects/:id/rfis` genuinely requires
 * the shared gate to know machine callers exist.
 */

/** Access tokens are distinguishable by prefix, so the hot path costs nothing. */
export const ACCESS_TOKEN_PREFIX = "cot_";
export const CLIENT_ID_PREFIX = "cli_";
export const CLIENT_SECRET_PREFIX = "cos_";

export function newAccessTokenValue(): string {
  return `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}
export function newClientIdValue(): string {
  return `${CLIENT_ID_PREFIX}${randomBytes(12).toString("hex")}`;
}
export function newClientSecretValue(): string {
  return `${CLIENT_SECRET_PREFIX}${randomBytes(32).toString("hex")}`;
}

export interface MachineCaller {
  /** oauth_clients.id */
  clientRowId: string;
  /** the public client_id */
  clientId: string;
  companyId: string;
  name: string;
  scopes: string[];
  tokenId: string;
  expiresAt: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Set when the bearer token was an OAuth2 access token rather than a user
     * JWT (Vol I §0.7 #120). Its presence means req.user is a machine identity
     * and permissions come from `machineClient.scopes`.
     */
    machineClient?: MachineCaller;
  }
}

/* ------------------------------------------------------------------ */
/* Which routes a machine caller may reach at all                      */
/* ------------------------------------------------------------------ */

/**
 * A machine caller's authority is its scopes, and scopes are `tool:level`
 * pairs. It follows that a route with NO tool gate has nothing to check a
 * machine against: `[authenticate, requireCompany]` alone means "any member of
 * this tenant", and an OAuth client is not a member. Admitting it there would
 * quietly hand every client company-wide read of projects, sources,
 * notifications and the rest, regardless of the scopes an admin so carefully
 * chose — the exact over-grant scopes exist to prevent.
 *
 * So machine callers are admitted ONLY to routes that carry a `requireTool`
 * gate. Detecting that is the awkward part: Fastify does not expose a route's
 * preHandler list on the request at run time. It does expose it at
 * REGISTRATION time, through the `onRoute` hook — so the auth plugin (which is
 * non-encapsulated and loads before every module, hence sees every route)
 * labels each tool gate as it is built and records which method+url pairs
 * carry one. The lookup at request time is then a Set hit on the route
 * pattern.
 *
 * The Set is process-wide and keyed by route pattern, not by app instance:
 * every app in a process registers the same routes, so there is nothing
 * tenant- or instance-specific in it to leak.
 */
const TOOL_GATE = Symbol.for("constructos.machineAuth.toolGate");
const toolGatedRoutes = new Set<string>();

type Marked = { [TOOL_GATE]?: string };

/** Label a `requireTool` gate so `noteRoute` can recognise it. */
export function markToolGate<T extends (...args: never[]) => unknown>(
  gate: T,
  tool: ToolKey,
  level: PermissionLevel,
): T {
  (gate as T & Marked)[TOOL_GATE] = `${tool}:${level}`;
  return gate;
}

/** onRoute hook: remember which routes are tool-gated. */
export function noteRoute(route: {
  method: string | string[];
  url: string;
  preHandler?: unknown;
}): void {
  const raw = route.preHandler;
  const handlers = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const gated = handlers.some(
    (h) => typeof h === "function" && (h as Marked)[TOOL_GATE] !== undefined,
  );
  if (!gated) return;
  const methods = Array.isArray(route.method) ? route.method : [route.method];
  for (const method of methods) toolGatedRoutes.add(`${method} ${route.url}`);
}

function routeIsToolGated(req: FastifyRequest): boolean {
  const pattern = (req as unknown as { routeOptions?: { url?: string } }).routeOptions?.url;
  if (!pattern) return false;
  return toolGatedRoutes.has(`${req.method} ${pattern}`);
}

/** Update lastUsedAt at most once a minute — visibility without a write storm. */
const LAST_USED_THROTTLE_MS = 60_000;

function stale(value: string | null, nowMs: number): boolean {
  if (!value) return true;
  const parsed = Date.parse(value);
  return !Number.isFinite(parsed) || nowMs - parsed > LAST_USED_THROTTLE_MS;
}

/**
 * Resolve a bearer value to a machine caller. Returns false when the value is
 * not one of ours, so the JWT path runs exactly as before; throws 401 when it
 * IS one of ours but is unusable, so an expired or revoked token gets a
 * truthful answer rather than "invalid JWT".
 */
export async function resolveMachineCaller(
  db: Db,
  req: FastifyRequest,
  bearer: string,
): Promise<boolean> {
  const token = bearer.trim();
  if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return false;

  const [row] = await db
    .select()
    .from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.tokenHash, sha256Hex(token)))
    .limit(1);
  if (!row) throw unauthorized("Invalid access token");
  const now = new Date();
  const nowIso = now.toISOString();
  if (row.revokedAt) throw unauthorized("Access token has been revoked");
  // Instant comparison, not string comparison — Postgres and toISOString()
  // disagree on separator, and a lexicographic test reads live tokens as dead.
  if (isExpired(row.expiresAt, now.getTime())) throw unauthorized("Access token has expired");

  const [client] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.id, row.clientId))
    .limit(1);
  if (!client) throw unauthorized("Access token belongs to an unknown client");
  if (client.isActive !== 1 || client.revokedAt) {
    throw unauthorized("OAuth client has been revoked");
  }

  // The token's scopes, never the client's current scopes: narrowing a client
  // must not retroactively widen a token that was issued before the change,
  // and widening a client must not silently upgrade tokens already in the wild.
  const scopes = (row.scopes as string[]) ?? [];

  req.machineClient = {
    clientRowId: client.id,
    clientId: client.clientId,
    companyId: client.companyId,
    name: client.name,
    scopes,
    tokenId: row.id,
    expiresAt: row.expiresAt,
  };
  // The machine IS the author. Records it writes carry the client's id in
  // createdBy — the same choice the ingestion push inlet makes with its token,
  // and the reason a reviewer can tell machine-authored rows from human ones.
  req.user = {
    id: client.id,
    email: `${client.clientId}@oauth-client.invalid`,
    name: `${client.name} (OAuth client)`,
  };

  const nowMs = now.getTime();
  if (stale(row.lastUsedAt, nowMs)) {
    await db
      .update(oauthAccessTokens)
      .set({ lastUsedAt: nowIso })
      .where(eq(oauthAccessTokens.id, row.id));
  }
  if (stale(client.lastUsedAt, nowMs)) {
    await db
      .update(oauthClients)
      .set({ lastUsedAt: nowIso })
      .where(eq(oauthClients.id, client.id));
  }
  return true;
}

/**
 * The machine equivalent of `requireCompany`. A client belongs to exactly one
 * tenant, fixed at issue time and carried on the token — it is not selected by
 * a header the caller controls. If the caller does send `x-company-id` it must
 * agree, so a mistargeted integration fails loudly instead of quietly reading
 * the wrong tenant.
 *
 * Note what is NOT set: `req.companyRole`. A machine has no company role, so
 * every `requireCompanyRole` gate refuses it, which is what keeps credential
 * management a human-only surface.
 */
export function machineRequireCompany(req: FastifyRequest): void {
  const client = req.machineClient!;
  const header = req.headers["x-company-id"];
  if (typeof header === "string" && header !== "" && header !== client.companyId) {
    throw forbidden("Access token is not issued for the requested company");
  }
  if (!routeIsToolGated(req)) {
    throw forbidden(
      "This route is not tool-scoped, so an OAuth client cannot be authorised for it — its " +
        "authority is its tool:level scopes, and there is no tool here to check them against. " +
        "Machine callers may only call routes governed by a tool permission check; this one " +
        "needs a human session.",
    );
  }
  req.companyId = client.companyId;
}

/**
 * The machine equivalent of the body of `requireTool`. Same project-in-tenant
 * check, same level comparison via `meetsLevel`; the only difference is that
 * the level comes from the token's scopes. No owner/admin bypass and no
 * assurance read-through — a machine gets precisely what it was granted.
 */
export async function machineRequireTool(
  db: Db,
  req: FastifyRequest,
  tool: ToolKey,
  level: PermissionLevel,
): Promise<void> {
  const client = req.machineClient!;
  const params = req.params as Record<string, string | undefined>;
  const projectId = params["projectId"];
  if (!projectId) throw forbidden("Route is missing :projectId");
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, client.companyId)))
    .limit(1);
  if (!project) throw forbidden("Project not found in this company");
  req.projectId = projectId;

  if (!scopesAllow(client.scopes, tool, level)) {
    throw forbidden(
      `OAuth client "${client.clientId}" lacks scope ${tool}:${level} ` +
        `(granted: ${client.scopes.length > 0 ? client.scopes.join(" ") : "none"})`,
    );
  }
}

/** The single import surface plugins/auth.ts touches. */
export const machineAuth = {
  resolve: resolveMachineCaller,
  company: machineRequireCompany,
  tool: machineRequireTool,
  markToolGate,
  noteRoute,
};
