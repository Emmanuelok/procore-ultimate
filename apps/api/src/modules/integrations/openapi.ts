/**
 * OpenAPI 3.1 document, generated from the live route table (#122).
 *
 * WHY GENERATED, NOT WRITTEN. A hand-maintained specification is wrong the
 * first week: a route is added, the document is not, and an integrator builds
 * against a description of a platform that no longer exists. This document is
 * derived from Fastify's own router at request time, so it cannot describe a
 * route that does not exist and cannot omit one that does. The cost is stated
 * on the document itself rather than hidden: bodies are validated by zod at
 * runtime and are NOT published as JSON Schema here, so the document describes
 * the surface (paths, methods, path parameters, authentication) exactly, and
 * says plainly that payload shapes come from the endpoint documentation.
 *
 * Fastify's router is a single object shared by every encapsulated instance, so
 * `app.printRoutes()` from inside a plugin enumerates the WHOLE application.
 * The pretty-printed tree is the only enumeration Fastify exposes publicly, so
 * it is parsed here — `parseRouteTree` is a pure function with its own fixture
 * tests, because a parser nobody tests is a parser that silently returns an
 * empty document the day the format shifts.
 */

export interface RouteEntry {
  path: string;
  methods: string[];
}

/** Path segments that are never part of the public API surface. */
const HIDDEN_PREFIXES = ["/api/v1/internal", "/__"];

/**
 * Parse `fastify.printRoutes({ commonPrefix: false })`.
 *
 * The tree indents children by four characters per level and marks each node
 * with `├── ` or `└── `; a node's full path is the concatenation of its
 * ancestors' segments. Methods, when a node terminates a route, are printed in
 * parentheses after the segment.
 */
export function parseRouteTree(printed: string): RouteEntry[] {
  const stack: string[] = [];
  const out = new Map<string, Set<string>>();
  for (const rawLine of printed.split("\n")) {
    if (rawLine.trim() === "") continue;
    const markerIndex = Math.max(rawLine.indexOf("├── "), rawLine.indexOf("└── "));
    let depth: number;
    let rest: string;
    if (markerIndex >= 0) {
      depth = Math.floor(markerIndex / 4);
      rest = rawLine.slice(markerIndex + 4);
    } else {
      // The root node of a tree with a common prefix has no branch marker.
      depth = 0;
      rest = rawLine.trim();
    }
    const methodsMatch = /\s\(([^)]*)\)\s*$/.exec(rest);
    const segment = methodsMatch ? rest.slice(0, methodsMatch.index) : rest;
    stack.length = depth;
    stack.push(segment);
    if (!methodsMatch) continue;
    const path = stack.join("");
    const methods = (methodsMatch[1] ?? "")
      .split(",")
      .map((m) => m.trim().toUpperCase())
      .filter((m) => m !== "" && m !== "HEAD" && m !== "OPTIONS");
    if (methods.length === 0) continue;
    const set = out.get(path) ?? new Set<string>();
    for (const m of methods) set.add(m);
    out.set(path, set);
  }
  return [...out.entries()]
    .filter(([path]) => !HIDDEN_PREFIXES.some((p) => path.startsWith(p)))
    .map(([path, methods]) => ({ path, methods: [...methods].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Fastify writes `:name`; OpenAPI writes `{name}`. */
export function toOpenApiPath(path: string): { path: string; params: string[] } {
  const params: string[] = [];
  const converted = path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        const name = segment.slice(1).replace(/[^A-Za-z0-9_]/g, "");
        params.push(name);
        return `{${name}}`;
      }
      if (segment === "*") {
        params.push("wildcard");
        return "{wildcard}";
      }
      return segment;
    })
    .join("/");
  return { path: converted, params };
}

/**
 * The tag a path belongs to: the first meaningful segment after the version
 * prefix, with project-scoped routes tagged by the AREA rather than by
 * "projects", because `/projects/{projectId}/rfis` is an RFI endpoint.
 */
export function tagForPath(path: string, prefix: string): string {
  const trimmed = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  const parts = trimmed.split("/").filter((p) => p !== "");
  if (parts.length === 0) return "root";
  if (parts[0] === "projects" && parts.length >= 3) return parts[2]!.replace(/^:/, "");
  return parts[0]!.replace(/^:/, "");
}

export interface OpenApiOptions {
  title: string;
  version: string;
  prefix: string;
  serverUrl: string;
  description?: string;
  routes: readonly RouteEntry[];
}

export interface OpenApiDocument {
  openapi: string;
  info: Record<string, unknown>;
  servers: { url: string }[];
  tags: { name: string }[];
  components: Record<string, unknown>;
  security: Record<string, string[]>[];
  paths: Record<string, Record<string, unknown>>;
}

const METHOD_SUMMARY: Record<string, string> = {
  GET: "Read",
  POST: "Create or execute",
  PATCH: "Update",
  PUT: "Replace",
  DELETE: "Delete",
};

/** Build the document. Pure — every input is passed in, nothing is read. */
export function buildOpenApiDocument(options: OpenApiOptions): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  const tags = new Set<string>();

  for (const route of options.routes) {
    const { path, params } = toOpenApiPath(route.path);
    const tag = tagForPath(route.path, options.prefix);
    tags.add(tag);
    const item: Record<string, unknown> = paths[path] ?? {};
    if (params.length > 0) {
      item["parameters"] = params.map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
    }
    for (const method of route.methods) {
      item[method.toLowerCase()] = {
        tags: [tag],
        summary: `${METHOD_SUMMARY[method] ?? method} ${path}`,
        operationId: `${method.toLowerCase()}_${path
          .replace(/[^A-Za-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")}`,
        responses: {
          "200": { description: "Success" },
          "400": { description: "Validation failed" },
          "401": { description: "Not authenticated" },
          "403": { description: "Authenticated, but not permitted" },
          "404": { description: "Not found, or not visible to this caller" },
        },
      };
    }
    paths[path] = item;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: options.title,
      version: options.version,
      description:
        (options.description ? `${options.description}\n\n` : "") +
        "GENERATED FROM THE LIVE ROUTE TABLE. This document enumerates every path and method " +
        "the running API serves, so it cannot drift from the platform. Request and response " +
        "bodies are validated at runtime by zod schemas and are NOT published here as JSON " +
        "Schema — treat the shapes in the endpoint documentation as authoritative and expect a " +
        "400 with the offending field when a body does not validate.\n\n" +
        "AUTHENTICATION. Human callers send a bearer JWT plus an `x-company-id` header naming " +
        "the tenant. Machine callers use OAuth2 client credentials at POST /oauth/token and " +
        "carry `tool:level` scopes drawn from the same permission vocabulary humans are governed " +
        "by, so a machine is never a wider door than the person who created it.",
    },
    servers: [{ url: options.serverUrl }],
    tags: [...tags].sort().map((name) => ({ name })),
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        companyHeader: {
          type: "apiKey",
          in: "header",
          name: "x-company-id",
          description: "The tenant the request acts in. Required on every company-scoped route.",
        },
        oauth2: {
          type: "oauth2",
          flows: {
            clientCredentials: {
              tokenUrl: `${options.prefix}/oauth/token`,
              scopes: {},
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [], companyHeader: [] }, { oauth2: [] }],
    paths,
  };
}
