import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  authSessions,
  companyMemberships,
  scimTokens,
  users,
} from "@constructos/db";
import { COMPANY_ROLES, type CompanyRole } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { isExpired } from "../../lib/time.js";
import type { Db } from "../../lib/db.js";
import { recordAuthEvent } from "./events.js";
import { hashPassword } from "./password.js";
import { requestContext, revokeAllUserSessions } from "./sessions.js";

/**
 * SCIM 2.0 — System for Cross-domain Identity Management (spec #21).
 *
 * WHAT THIS IS FOR. An enterprise runs Okta/Entra/OneLogin as the source of
 * truth for who works there. Without SCIM, a leaver is removed from the IdP
 * and keeps a live ConstructOS account until somebody remembers — which is the
 * single most common finding in an access review, and the reason "we have SSO"
 * is not the same as "we control access".
 *
 * ------------------------------------------------------------------------
 * WHAT IS IMPLEMENTED, PRECISELY
 * ------------------------------------------------------------------------
 *   /scim/v2/ServiceProviderConfig   what this server supports (honestly:
 *                                    patch yes, bulk no, sort no, ETag no)
 *   /scim/v2/ResourceTypes, /Schemas the discovery documents
 *   /scim/v2/Users                   GET (filter `userName eq "…"` and
 *                                    `active eq true|false`), POST, GET/:id,
 *                                    PUT/:id, PATCH/:id, DELETE/:id
 *   /scim/v2/Groups                  GET, GET/:id, PATCH/:id
 *
 * GROUPS ARE COMPANY ROLES, and that is a deliberate limitation stated rather
 * than hidden. This platform's real access model is per-PROJECT permission
 * templates, and SCIM has no concept of a project — a directory cannot know
 * that "Bridge 4 QA reviewers" is a thing. So the groups exposed are the four
 * company roles (`owner`, `admin`, `member`, `guest`); adding a user to the
 * `admin` group sets their company role, and project access stays with the
 * people who know which projects exist. `ServiceProviderConfig` says so.
 *
 * DEPROVISIONING IS REAL. `active: false` (via PUT, PATCH or DELETE) removes
 * the company membership, revokes every session opened in that company, and
 * writes both the ledger entry and the security-trail row. Where the account
 * belongs to no other company it is also deactivated platform-wide, which is
 * what makes a leaver actually leave.
 *
 * ------------------------------------------------------------------------
 * AUTHENTICATION
 * ------------------------------------------------------------------------
 * A per-tenant bearer token, hashed at rest exactly like every other
 * credential here, minted at POST /company/scim/tokens and shown once. It
 * authenticates a DIRECTORY, not a person: it carries no user id, and its
 * authority is exactly "manage members of this one company". Every handler
 * filters on the token's company; nothing is taken from the request.
 *
 * ERRORS are SCIM errors (`urn:ietf:params:scim:api:messages:2.0:Error`) with
 * the SCIM status codes, not this platform's `AppError` envelope — an IdP
 * parses the former and logs the latter as a failure it cannot explain.
 */

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

const TOKEN_PREFIX = "scim_";

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

export function mintScimToken(): { raw: string; hash: string; prefix: string } {
  const raw = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { raw, hash: sha256(raw), prefix: raw.slice(0, 10) };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface ScimPrincipal {
  tokenId: string;
  companyId: string;
}

/**
 * Resolve the bearer token to a tenant, or null.
 *
 * The lookup is by HASH, so a database reader holds nothing presentable. The
 * comparison after the lookup is constant-time even though the hash lookup
 * already matched — it costs nothing and it keeps the pattern uniform with the
 * rest of this codebase.
 */
export async function resolveScimToken(
  db: Db,
  raw: string,
  nowMs = Date.now(),
): Promise<ScimPrincipal | null> {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const hash = sha256(raw);
  const [row] = await db.select().from(scimTokens).where(eq(scimTokens.tokenHash, hash)).limit(1);
  if (!row) return null;
  if (!constantTimeEqual(row.tokenHash, hash)) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && isExpired(row.expiresAt, nowMs)) return null;
  return { tokenId: row.id, companyId: row.companyId };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/* ------------------------------------------------------------------ */
/* Representations                                                     */
/* ------------------------------------------------------------------ */

export interface ScimUserRow {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  role: CompanyRole | null;
  createdAt: string;
  updatedAt: string;
}

/** Split a display name into the given/family halves SCIM expects. */
export function splitName(name: string): { givenName: string; familyName: string } {
  const trimmed = name.trim();
  const space = trimmed.lastIndexOf(" ");
  if (space === -1) return { givenName: trimmed, familyName: "" };
  return { givenName: trimmed.slice(0, space), familyName: trimmed.slice(space + 1) };
}

export function joinName(
  formatted: string | undefined,
  given: string | undefined,
  family: string | undefined,
  fallback: string,
): string {
  if (formatted && formatted.trim()) return formatted.trim();
  const joined = [given, family].filter((p) => p && p.trim()).join(" ").trim();
  return joined || fallback;
}

export function scimUser(row: ScimUserRow, baseUrl: string): Record<string, unknown> {
  const { givenName, familyName } = splitName(row.name);
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: row.id,
    externalId: undefined,
    userName: row.email,
    name: { formatted: row.name, givenName, familyName },
    displayName: row.name,
    emails: [{ value: row.email, primary: true, type: "work" }],
    active: row.isActive && row.role !== null,
    groups: row.role ? [{ value: `role:${row.role}`, display: row.role, type: "direct" }] : [],
    meta: {
      resourceType: "User",
      created: row.createdAt,
      lastModified: row.updatedAt,
      location: `${baseUrl}/Users/${row.id}`,
    },
  };
}

export function scimGroup(
  role: CompanyRole,
  members: Array<{ id: string; name: string }>,
  baseUrl: string,
): Record<string, unknown> {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: `role:${role}`,
    displayName: role,
    members: members.map((m) => ({ value: m.id, display: m.name, type: "User" })),
    meta: { resourceType: "Group", location: `${baseUrl}/Groups/role:${role}` },
  };
}

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

export interface ScimFilter {
  attribute: string;
  operator: string;
  value: string;
}

/**
 * Parse the ONE filter shape every identity provider actually sends:
 * `userName eq "someone@example.com"`. Anything more is refused with SCIM's
 * own `invalidFilter` code rather than silently ignored — an IdP that asks
 * for a subset and receives everything will happily deprovision the lot.
 */
export function parseScimFilter(raw: string | undefined): ScimFilter | null | "invalid" {
  if (!raw || raw.trim() === "") return null;
  const match = /^\s*(\w+)\s+(eq|ne|co|sw|pr)\s*(?:"([^"]*)"|(\S+))?\s*$/i.exec(raw);
  if (!match) return "invalid";
  const attribute = (match[1] ?? "").toLowerCase();
  const operator = (match[2] ?? "").toLowerCase();
  const value = match[3] ?? match[4] ?? "";
  if (!["username", "externalid", "active", "displayname", "emails.value"].includes(attribute)) {
    return "invalid";
  }
  return { attribute, operator, value };
}

/* ------------------------------------------------------------------ */
/* PATCH                                                               */
/* ------------------------------------------------------------------ */

export interface ScimPatchOp {
  op: "add" | "replace" | "remove";
  path?: string;
  value?: unknown;
}

const patchSchema = z.object({
  schemas: z.array(z.string()).optional(),
  Operations: z
    .array(
      z.object({
        op: z.string().transform((s) => s.toLowerCase()),
        path: z.string().optional(),
        value: z.unknown().optional(),
      }),
    )
    .min(1),
});

export interface UserPatchResult {
  active?: boolean;
  name?: string;
  userName?: string;
  role?: CompanyRole;
  unsupported: string[];
}

/**
 * Apply a SCIM PATCH document to a user, as a pure decision.
 *
 * Handles the two shapes providers use interchangeably: an operation with a
 * `path` (`{op:"replace", path:"active", value:false}`) and one with a value
 * object and no path (`{op:"replace", value:{active:false}}`). Anything it
 * does not understand is collected in `unsupported` rather than dropped, so
 * the route can say so instead of reporting a success it did not perform.
 */
export function applyUserPatch(body: unknown): UserPatchResult {
  const parsed = patchSchema.parse(body);
  const out: UserPatchResult = { unsupported: [] };
  for (const op of parsed.Operations) {
    const path = (op.path ?? "").toLowerCase().replace(/^urn:[^:]*:/, "");
    if (path === "" && op.value && typeof op.value === "object") {
      const value = op.value as Record<string, unknown>;
      if ("active" in value) out.active = truthy(value["active"]);
      if (typeof value["displayName"] === "string") out.name = value["displayName"];
      if (typeof value["userName"] === "string") out.userName = value["userName"].toLowerCase();
      if (value["name"] && typeof value["name"] === "object") {
        const n = value["name"] as Record<string, unknown>;
        out.name = joinName(
          typeof n["formatted"] === "string" ? n["formatted"] : undefined,
          typeof n["givenName"] === "string" ? n["givenName"] : undefined,
          typeof n["familyName"] === "string" ? n["familyName"] : undefined,
          out.name ?? "",
        );
        if (!out.name) delete out.name;
      }
      continue;
    }
    if (path === "active") {
      out.active = op.op === "remove" ? false : truthy(op.value);
      continue;
    }
    if (path === "displayname" || path === "name.formatted") {
      if (typeof op.value === "string") out.name = op.value;
      continue;
    }
    if (path === "username") {
      if (typeof op.value === "string") out.userName = op.value.toLowerCase();
      continue;
    }
    out.unsupported.push(op.path ?? op.op);
  }
  return out;
}

function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  if (Array.isArray(value) && value.length > 0) return truthy(value[0]);
  if (value && typeof value === "object" && "value" in (value as Record<string, unknown>)) {
    return truthy((value as Record<string, unknown>)["value"]);
  }
  return false;
}

export interface GroupPatchResult {
  add: string[];
  remove: string[];
  /** `replace` on `members` means "these and only these" */
  replaceWith: string[] | null;
  unsupported: string[];
}

/** Decide what a Groups PATCH asks for, without touching the database. */
export function applyGroupPatch(body: unknown): GroupPatchResult {
  const parsed = patchSchema.parse(body);
  const out: GroupPatchResult = { add: [], remove: [], replaceWith: null, unsupported: [] };
  for (const op of parsed.Operations) {
    const path = (op.path ?? "").toLowerCase();
    // `members[value eq "id"]` — the shape Entra sends for a removal
    const filtered = /^members\[value\s+eq\s+"?([^"\]]+)"?\]$/.exec(path);
    if (filtered?.[1]) {
      if (op.op === "remove") out.remove.push(filtered[1]);
      else out.add.push(filtered[1]);
      continue;
    }
    if (path !== "members") {
      out.unsupported.push(op.path ?? op.op);
      continue;
    }
    const ids = memberIds(op.value);
    if (op.op === "add") out.add.push(...ids);
    else if (op.op === "remove") out.remove.push(...ids);
    else out.replaceWith = ids;
  }
  return out;
}

function memberIds(value: unknown): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const ids: string[] = [];
  for (const item of list) {
    if (typeof item === "string") ids.push(item);
    else if (item && typeof item === "object" && typeof (item as Record<string, unknown>)["value"] === "string") {
      ids.push((item as Record<string, unknown>)["value"] as string);
    }
  }
  return ids;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

function scimError(reply: FastifyReply, status: number, detail: string, scimType?: string) {
  return reply
    .status(status)
    .type("application/scim+json")
    .send({
      schemas: [SCIM_ERROR_SCHEMA],
      status: String(status),
      ...(scimType ? { scimType } : {}),
      detail,
    });
}

const createUserSchema = z.object({
  schemas: z.array(z.string()).optional(),
  userName: z.string().email().toLowerCase().max(320),
  externalId: z.string().max(200).optional(),
  displayName: z.string().max(200).optional(),
  name: z
    .object({
      formatted: z.string().max(200).optional(),
      givenName: z.string().max(200).optional(),
      familyName: z.string().max(200).optional(),
    })
    .optional(),
  emails: z
    .array(z.object({ value: z.string().max(320), primary: z.boolean().optional(), type: z.string().optional() }))
    .optional(),
  active: z.boolean().optional(),
  roles: z.array(z.unknown()).optional(),
});

export function registerScimRoutes(app: FastifyInstance): void {
  /**
   * TWO BASES, AND THE DIFFERENCE MATTERS.
   *
   * `route` is the path these handlers are REGISTERED at. This function is
   * called from inside `accountModule`, which app.ts registers with
   * `{ prefix: "/api/v1" }`, so Fastify prepends that prefix itself. Passing
   * the full public path here registered every SCIM route at
   * `/api/v1/api/v1/scim/v2/...` — the documented URL 404'd, and no test
   * noticed because the SCIM tests only exercised the pure helpers. There are
   * now route tests (security.test.ts, "SCIM 2.0 (#21)") that call the documented
   * path and would fail again the moment the two drift apart.
   *
   * `base` is the path that goes into `meta.location` and the `Location`
   * header — what an identity provider stores and calls back on. That one IS
   * the full public path.
   */
  const route = "/scim/v2";
  const base = "/api/v1/scim/v2";

  /** The SCIM gate. Sets `req.scim` or answers 401 in SCIM's own envelope. */
  async function scimAuth(req: FastifyRequest, reply: FastifyReply): Promise<ScimPrincipal | null> {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      void scimError(reply, 401, "A SCIM bearer token is required.");
      return null;
    }
    const principal = await resolveScimToken(app.db, header.slice(7));
    if (!principal) {
      void scimError(reply, 401, "This SCIM token is not valid, has been revoked, or has expired.");
      return null;
    }
    // Usage is recorded so an operator can answer "is this token still in
    // use?" before revoking it. Best effort: a counter must never fail a
    // provisioning call.
    try {
      const [row] = await app.db
        .select({ useCount: scimTokens.useCount })
        .from(scimTokens)
        .where(eq(scimTokens.id, principal.tokenId))
        .limit(1);
      await app.db
        .update(scimTokens)
        .set({
          lastUsedAt: new Date().toISOString(),
          lastUsedIp: req.ip ?? null,
          useCount: (row?.useCount ?? 0) + 1,
        })
        .where(eq(scimTokens.id, principal.tokenId));
    } catch {
      /* ignore */
    }
    return principal;
  }

  async function loadMembers(companyId: string, filter?: { email?: string; active?: boolean }) {
    const rows = await app.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        isActive: users.isActive,
        role: companyMemberships.role,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(companyMemberships)
      .innerJoin(users, eq(users.id, companyMemberships.userId))
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          filter?.email ? eq(users.email, filter.email) : undefined,
        ),
      )
      .orderBy(asc(users.email));
    const mapped: ScimUserRow[] = rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      isActive: r.isActive,
      role: r.role as CompanyRole,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
    if (filter?.active === undefined) return mapped;
    return mapped.filter((r) => r.isActive === filter.active);
  }

  async function loadMember(companyId: string, userId: string): Promise<ScimUserRow | null> {
    const [row] = await app.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        isActive: users.isActive,
        role: companyMemberships.role,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(companyMemberships)
      .innerJoin(users, eq(users.id, companyMemberships.userId))
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.userId, userId)))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      isActive: row.isActive,
      role: row.role as CompanyRole,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /* --- discovery --- */

  app.get(`${route}/ServiceProviderConfig`, async (_req, reply) =>
    reply.type("application/scim+json").send({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      documentationUri: "https://constructos.dev/docs/security#scim",
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 500 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: "oauthbearertoken",
          name: "OAuth Bearer Token",
          description:
            "A per-tenant SCIM token minted at POST /api/v1/company/scim/tokens and shown once.",
          primary: true,
        },
      ],
      // Stated in the discovery document rather than only in prose: an
      // integrator must not have to discover the group model by experiment.
      "urn:constructos:scim:notes": {
        groups:
          "Groups are this platform's four company roles (owner, admin, member, guest). " +
          "Per-project permission templates are not exposed: SCIM has no project concept.",
        deprovisioning:
          "active:false or DELETE removes the company membership, revokes sessions opened in " +
          "that company, and deactivates the account platform-wide when it has no other company.",
      },
    }),
  );

  app.get(`${route}/ResourceTypes`, async (_req, reply) =>
    reply.type("application/scim+json").send({
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: 2,
      itemsPerPage: 2,
      startIndex: 1,
      Resources: [
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
          id: "User",
          name: "User",
          endpoint: "/Users",
          schema: SCIM_USER_SCHEMA,
          meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/User` },
        },
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
          id: "Group",
          name: "Group",
          endpoint: "/Groups",
          schema: SCIM_GROUP_SCHEMA,
          meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/Group` },
        },
      ],
    }),
  );

  app.get(`${route}/Schemas`, async (_req, reply) =>
    reply.type("application/scim+json").send({
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: 2,
      itemsPerPage: 2,
      startIndex: 1,
      Resources: [
        {
          id: SCIM_USER_SCHEMA,
          name: "User",
          description: "A member of one ConstructOS company.",
          attributes: [
            { name: "userName", type: "string", required: true, uniqueness: "server" },
            { name: "displayName", type: "string", required: false },
            { name: "active", type: "boolean", required: false },
            { name: "emails", type: "complex", multiValued: true, required: false },
          ],
        },
        {
          id: SCIM_GROUP_SCHEMA,
          name: "Group",
          description: "A ConstructOS company role.",
          attributes: [
            { name: "displayName", type: "string", required: true },
            { name: "members", type: "complex", multiValued: true, required: false },
          ],
        },
      ],
    }),
  );

  /* --- Users --- */

  app.get(`${route}/Users`, async (req, reply) => {
    const principal = await scimAuth(req, reply);
    if (!principal) return reply;
    const query = req.query as Record<string, string | undefined>;
    const parsed = parseScimFilter(query["filter"]);
    if (parsed === "invalid") {
      return scimError(
        reply,
        400,
        `This server supports "userName eq \\"…\\"" and "active eq true|false" only. Received: ${query["filter"]}`,
        "invalidFilter",
      );
    }
    const filter: { email?: string; active?: boolean } = {};
    if (parsed) {
      if (parsed.attribute === "username" || parsed.attribute === "emails.value") {
        filter.email = parsed.value.toLowerCase();
      } else if (parsed.attribute === "active") {
        filter.active = parsed.value.toLowerCase() === "true";
      } else {
        // externalId / displayName: honest empty result rather than everyone.
        return reply.type("application/scim+json").send({
          schemas: [SCIM_LIST_SCHEMA],
          totalResults: 0,
          itemsPerPage: 0,
          startIndex: 1,
          Resources: [],
        });
      }
    }
    const all = await loadMembers(principal.companyId, filter);
    const startIndex = Math.max(1, Number(query["startIndex"] ?? 1) || 1);
    const count = Math.min(500, Math.max(0, Number(query["count"] ?? 100) || 100));
    const page = all.slice(startIndex - 1, startIndex - 1 + count);
    return reply.type("application/scim+json").send({
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: all.length,
      itemsPerPage: page.length,
      startIndex,
      Resources: page.map((r) => scimUser(r, base)),
    });
  });

  app.get(`${route}/Users/:id`, async (req, reply) => {
    const principal = await scimAuth(req, reply);
    if (!principal) return reply;
    const { id } = req.params as { id: string };
    const row = await loadMember(principal.companyId, id);
    if (!row) return scimError(reply, 404, `No user ${id} in this company.`);
    return reply.type("application/scim+json").send(scimUser(row, base));
  });

  app.post(`${route}/Users`, async (req, reply) => {
    const principal = await scimAuth(req, reply);
    if (!principal) return reply;
    let body: z.infer<typeof createUserSchema>;
    try {
      body = createUserSchema.parse(req.body);
    } catch (err) {
      return scimError(
        reply,
        400,
        `The User resource is not valid: ${err instanceof Error ? err.message : String(err)}`,
        "invalidValue",
      );
    }
    const email = body.userName;
    const name = joinName(
      body.name?.formatted,
      body.name?.givenName,
      body.name?.familyName,
      body.displayName ?? email,
    );
    const ctx = requestContext(req);

    const [existing] = await app.db.select().from(users).where(eq(users.email, email)).limit(1);
    let userId: string;
    let created = false;
    if (existing) {
      userId = existing.id;
      const [membership] = await app.db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, principal.companyId),
            eq(companyMemberships.userId, existing.id),
          ),
        )
        .limit(1);
      if (membership) {
        // SCIM says 409 for a uniqueness conflict, and an IdP treats it as
        // "already provisioned, carry on" rather than an error to escalate.
        return scimError(reply, 409, `${email} is already a member of this company.`, "uniqueness");
      }
      if (body.active === false) {
        return scimError(
          reply,
          400,
          "Creating a member with active:false is refused: it would mean provisioning access and " +
            "revoking it in the same call. Create the user, then PATCH active:false.",
          "invalidValue",
        );
      }
    } else {
      // A password nobody knows. The account is reachable through the tenant's
      // SSO connection or through a password reset — never through a
      // credential this platform invented and stored.
      userId = newId("u");
      await app.db.insert(users).values({
        id: userId,
        email,
        name,
        passwordHash: await hashPassword(app.appConfig, `scim-provisioned-${randomBytes(24).toString("hex")}`),
        isActive: body.active !== false,
      });
      created = true;
    }

    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: principal.companyId,
      userId,
      role: "member",
    });
    await appendLedger(app.db, {
      companyId: principal.companyId,
      actorId: null,
      action: "create",
      objectType: "company_membership",
      objectId: userId,
      payload: { via: "scim", email, created, tokenId: principal.tokenId },
      storePayload: true,
    });
    await recordAuthEvent(app.db, {
      kind: "scim_user_provisioned",
      companyId: principal.companyId,
      userId,
      email,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      reason: created ? "SCIM created the account" : "SCIM added an existing account to the company",
      metadata: { tokenId: principal.tokenId, created },
    });

    const row = await loadMember(principal.companyId, userId);
    return reply
      .status(201)
      .type("application/scim+json")
      .send(scimUser(row!, base));
  });

  async function setActive(
    principal: ScimPrincipal,
    req: FastifyRequest,
    row: ScimUserRow,
    active: boolean,
  ): Promise<void> {
    const ctx = requestContext(req);
    const nowIso = new Date().toISOString();
    if (!active) {
      await app.db
        .delete(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, principal.companyId),
            eq(companyMemberships.userId, row.id),
          ),
        );
      // Sessions opened in this company die with the membership. A session
      // with no company recorded is left alone — it may belong to another
      // tenant this person still works for.
      const sessions = await app.db
        .select({ id: authSessions.id })
        .from(authSessions)
        .where(
          and(eq(authSessions.userId, row.id), eq(authSessions.companyId, principal.companyId)),
        );
      if (sessions.length > 0) {
        const { revokeSessions } = await import("./sessions.js");
        await revokeSessions(app.db, sessions.map((s) => s.id), {
          reason: "membership_removed",
          byUser: false,
          actorId: null,
        });
      }
      // No other company: the account itself goes. This is the half that makes
      // a leaver actually leave.
      const remaining = await app.db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(eq(companyMemberships.userId, row.id));
      if (remaining.length === 0) {
        await app.db
          .update(users)
          .set({ isActive: false, updatedAt: nowIso })
          .where(eq(users.id, row.id));
        await revokeAllUserSessions(app.db, row.id, {
          reason: "account_deactivated",
          byUser: false,
          actorId: null,
          includeOrphanTokens: true,
        });
      }
    } else {
      await app.db.update(users).set({ isActive: true, updatedAt: nowIso }).where(eq(users.id, row.id));
      const [membership] = await app.db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, principal.companyId),
            eq(companyMemberships.userId, row.id),
          ),
        )
        .limit(1);
      if (!membership) {
        await app.db.insert(companyMemberships).values({
          id: newId("cm"),
          companyId: principal.companyId,
          userId: row.id,
          role: "member",
        });
      }
    }
    await appendLedger(app.db, {
      companyId: principal.companyId,
      actorId: null,
      action: "state_change",
      objectType: "company_membership",
      objectId: row.id,
      payload: { via: "scim", active, email: row.email, tokenId: principal.tokenId },
      storePayload: true,
    });
    await recordAuthEvent(app.db, {
      kind: active ? "scim_user_provisioned" : "scim_user_deactivated",
      companyId: principal.companyId,
      userId: row.id,
      email: row.email,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      reason: active ? "SCIM reactivated the member" : "SCIM deprovisioned the member",
      metadata: { tokenId: principal.tokenId },
    });
  }

  app.put(`${route}/Users/:id`, async (req, reply) => {
    const principal = await scimAuth(req, reply);
    if (!principal) return reply;
    const { id } = req.params as { id: string };
    const row = await loadMember(principal.companyId, id);
    if (!row) return scimError(reply, 404, `No user ${id} in this company.`);
    let body: z.infer<typeof createUserSchema>;
    try {
      body = createUserSchema.parse(req.body);
    } catch (err) {
      return scimError(
        reply,
        400,
        `The User resource is not valid: ${err instanceof Error ? err.message : String(err)}`,
        "invalidValue",
      );
    }
    const name = joinName(
      body.name?.formatted,
      body.name?.givenName,
      body.name?.familyName,
      body.displayName ?? row.name,
    );
    if (name !== row.name) {
      await app.db
        .update(users)
        .set({ name, updatedAt: new Date().toISOString() })
        .where(eq(users.id, row.id));
    }
    if (body.active !== undefined && body.active !== (row.isActive && row.role !== null)) {
      await setActive(principal, req, row, body.active);
    }
    const after = await loadMember(principal.companyId, id);
    return reply
      .type("application/scim+json")
      .send(after ? scimUser(after, base) : scimUser({ ...row, name, isActive: false, role: null }, base));
  });

  app.patch(`${route}/Users/:id`, async (req, reply) => {
    const principal = await scimAuth(req, reply);
    if (!principal) return reply;
    const { id } = req.params as { id: string };
    const row = await loadMember(principal.companyId, id);
    if (!row) return scimError(reply, 404, `No user ${id} in this company.`);
    let patch: UserPatchResult;
    try {
      patch = applyUserPatch(req.body);
    } catch (err) {
      return scimError(
        reply,
        400,
        `The PatchOp is not valid: ${err instanceof Error ? err.message : String(err)}`,
        "invalidSyntax",
      );
    }
    if (patch.name && patch.name !== row.name) {
      await app.db
        .update(users)
        .set({ name: patch.name, updatedAt: new Date().toISOString() })
        .where(eq(users.id, row.id));
    }
    if (patch.active !== undefined && patch.active !== (row.isActive && row.role !== null)) {
      await setActive(principal, req, row, patch.active);
    }
    const after = await loadMember(principal.companyId, id);
    const body = after
      ? scimUser(after, base)
      : scimUser({ ...row, name: patch.name ?? row.name, isActive: false, role: null }, base);
    if (patch.unsupported.length > 0) {
      // Named, not swallowed: an IdP that asked for something we did not do
      // must be able to see that in its own logs.
      (body as Record<string, unknown>)["urn:constructos:scim:unsupported"] = patch.unsupported;
    }
    return reply.type("application/scim+json").send(body);
  });

  app.delete(`${route}/Users/:id`, async (req, reply) => {
    const principal = await scimAuth(req, reply);
    if (!principal) return reply;
    const { id } = req.params as { id: string };
    const row = await loadMember(principal.companyId, id);
    if (!row) return scimError(reply, 404, `No user ${id} in this company.`);
    await setActive(principal, req, row, false);
    return reply.status(204).send();
  });

  /* --- Groups (company roles) --- */

  app.get(`${route}/Groups`, async (req, reply) => {
    const principal = await scimAuth(req, reply);
    if (!principal) return reply;
    const members = await loadMembers(principal.companyId);
    const resources = COMPANY_ROLES.map((role) =>
      scimGroup(
        role,
        members.filter((m) => m.role === role).map((m) => ({ id: m.id, name: m.name })),
        base,
      ),
    );
    return reply.type("application/scim+json").send({
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: resources.length,
      itemsPerPage: resources.length,
      startIndex: 1,
      Resources: resources,
    });
  });

  app.get(`${route}/Groups/:id`, async (req, reply) => {
    const principal = await scimAuth(req, reply);
    if (!principal) return reply;
    const { id } = req.params as { id: string };
    const role = id.replace(/^role:/, "") as CompanyRole;
    if (!COMPANY_ROLES.includes(role)) return scimError(reply, 404, `No group ${id}.`);
    const members = await loadMembers(principal.companyId);
    return reply
      .type("application/scim+json")
      .send(
        scimGroup(
          role,
          members.filter((m) => m.role === role).map((m) => ({ id: m.id, name: m.name })),
          base,
        ),
      );
  });

  app.patch(`${route}/Groups/:id`, async (req, reply) => {
    const principal = await scimAuth(req, reply);
    if (!principal) return reply;
    const { id } = req.params as { id: string };
    const role = id.replace(/^role:/, "") as CompanyRole;
    if (!COMPANY_ROLES.includes(role)) return scimError(reply, 404, `No group ${id}.`);
    let patch: GroupPatchResult;
    try {
      patch = applyGroupPatch(req.body);
    } catch (err) {
      return scimError(
        reply,
        400,
        `The PatchOp is not valid: ${err instanceof Error ? err.message : String(err)}`,
        "invalidSyntax",
      );
    }
    const members = await loadMembers(principal.companyId);
    const byId = new Map(members.map((m) => [m.id, m]));
    const toRole: string[] = [];
    const toMember: string[] = [];
    if (patch.replaceWith) {
      for (const m of members) {
        if (patch.replaceWith.includes(m.id) && m.role !== role) toRole.push(m.id);
        if (!patch.replaceWith.includes(m.id) && m.role === role) toMember.push(m.id);
      }
    } else {
      for (const memberId of patch.add) if (byId.has(memberId)) toRole.push(memberId);
      for (const memberId of patch.remove) {
        if (byId.get(memberId)?.role === role) toMember.push(memberId);
      }
    }
    // The `owner` role is never taken away by a directory. An IdP mapping
    // mistake that removed every owner would leave the tenant with nobody who
    // can fix it, and no directory has enough context to make that call.
    const guarded = toMember.filter((memberId) => byId.get(memberId)?.role !== "owner");
    if (toRole.length > 0) {
      await app.db
        .update(companyMemberships)
        .set({ role })
        .where(
          and(
            eq(companyMemberships.companyId, principal.companyId),
            inArray(companyMemberships.userId, toRole),
          ),
        );
    }
    if (guarded.length > 0 && role !== "member") {
      await app.db
        .update(companyMemberships)
        .set({ role: "member" })
        .where(
          and(
            eq(companyMemberships.companyId, principal.companyId),
            inArray(companyMemberships.userId, guarded),
          ),
        );
    }
    if (toRole.length > 0 || guarded.length > 0) {
      await appendLedger(app.db, {
        companyId: principal.companyId,
        actorId: null,
        action: "state_change",
        objectType: "company_membership_role",
        objectId: `role:${role}`,
        payload: { via: "scim", role, granted: toRole, removed: guarded, tokenId: principal.tokenId },
        storePayload: true,
      });
      await recordAuthEvent(app.db, {
        kind: "scim_group_changed",
        companyId: principal.companyId,
        ip: req.ip ?? null,
        reason: `SCIM changed membership of the ${role} group`,
        metadata: { granted: toRole, removed: guarded, tokenId: principal.tokenId },
      });
    }
    const after = await loadMembers(principal.companyId);
    return reply.type("application/scim+json").send(
      scimGroup(
        role,
        after.filter((m) => m.role === role).map((m) => ({ id: m.id, name: m.name })),
        base,
      ),
    );
  });
}
