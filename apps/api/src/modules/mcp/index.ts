import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { MCP_TOOL_NAMES } from "@constructos/shared";
import { appendLedger } from "../../lib/ledger.js";
import {
  errorForStatus,
  parseCall,
  rpcError,
  rpcResult,
  RPC_ERRORS,
  splitBatch,
  type RpcResponse,
} from "./protocol.js";
import { MCP_TOOLS, toolByName, toolListPayload, type ToolContext } from "./tools.js";

/**
 * Model Context Protocol server (spec Vol I §0.7 #126-127).
 *
 * WHAT THIS IS. One JSON-RPC 2.0 endpoint that lets an AI client — Claude
 * Desktop, an agent runtime, a customer's own orchestrator — discover and call
 * a small, deliberate set of platform capabilities: search, read a record,
 * list signals and obligations, read a project's health, raise an RFI, record
 * an observation, run the detectors.
 *
 * THE RULE THAT SHAPES EVERYTHING ELSE. An MCP session is not a second, softer
 * door. Every tool is dispatched through the platform's own router, with the
 * caller's own credentials, into the same handler a browser would reach — same
 * `requireTool` gate, same tenant scoping, same ledger append, same 403. There
 * is no privileged query path here and nothing to keep in sync: a permission
 * change anywhere on the platform lands here for free, and an agent can never
 * be given authority the human or the OAuth client behind it does not hold.
 *
 * WHO MAY CALL IT.
 *  - A signed-in person: POST /api/v1/mcp (company-scoped), or the
 *    project-pinned form below.
 *  - A machine caller holding an OAuth2 client-credentials token: POST
 *    /api/v1/projects/:projectId/mcp, which is tool-gated on
 *    `integrations:read`. The project-scoped form exists because a machine's
 *    authority is resolved per project by the shared gate, so a machine caller
 *    needs a route that names one. The session then inherits that project, and
 *    every tool that needs a project uses it unless the arguments override it —
 *    and an override is checked by the underlying route exactly as any other
 *    project would be.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. No SSE or streaming transport (one POST
 * answers one batch; nothing here is long-running enough to need it), no
 * `sampling` (the server never asks the client to run a model on its behalf),
 * no `prompts`, and no session state — so a client may reconnect at will and
 * replicas need no affinity. Tool results are returned both as text (for a
 * model to read) and as `structuredContent` (for a client to parse), which is
 * what the protocol asks of a server that has real data rather than prose.
 */

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "constructos", title: "ConstructOS", version: "1.0.0" };

/** How many calls one batch may carry: an agent's typo must not be a DoS. */
const MAX_BATCH = 20;

interface ResourceDef {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  /** the platform route the resource is read from, relative to the prefix */
  path: (ctx: ToolContext) => string | null;
}

const RESOURCES: readonly ResourceDef[] = [
  {
    uri: "constructos://openapi",
    name: "openapi",
    title: "OpenAPI description of this API",
    description:
      "The machine-readable description of every route this deployment serves, generated from " +
      "the live route table.",
    mimeType: "application/json",
    path: () => "/openapi.json",
  },
  {
    uri: "constructos://projects",
    name: "projects",
    title: "Projects visible to this caller",
    description: "The projects this caller can open, with stage and status.",
    mimeType: "application/json",
    path: () => "/projects?pageSize=100",
  },
  {
    uri: "constructos://project/health",
    name: "project-health",
    title: "Health of the session's project",
    description:
      "The explainable health verdict for the project this session is pinned to. Available only " +
      "on a project-scoped session.",
    mimeType: "application/json",
    path: (ctx) => (ctx.defaultProjectId ? `/projects/${ctx.defaultProjectId}/health` : null),
  },
  {
    uri: "constructos://signals",
    name: "signals",
    title: "Open assurance signals",
    description: "Integrity and risk signals the detector programme has raised.",
    mimeType: "application/json",
    path: (ctx) =>
      ctx.defaultProjectId ? `/signals?projectId=${ctx.defaultProjectId}&pageSize=50` : "/signals?pageSize=50",
  },
];

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

function queryString(query: Record<string, string | number | undefined> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s === "" ? "" : `?${s}`;
}

interface PlatformCallResult {
  status: number;
  body: unknown;
}

/**
 * Call one of the platform's own routes as this caller.
 *
 * `app.inject` runs the complete request lifecycle — authentication, the
 * company gate, the tool gate, validation, the handler, the ledger append —
 * against the in-process router. That is the whole point: there is no way for
 * this file to accidentally read a table the caller may not read, because it
 * never touches a table.
 */
async function callPlatform(
  app: FastifyInstance,
  req: FastifyRequest,
  prefix: string,
  invocation: { method: "GET" | "POST"; path: string; query?: Record<string, string | number | undefined>; payload?: Record<string, unknown> },
): Promise<PlatformCallResult> {
  const headers: Record<string, string> = {};
  const auth = req.headers.authorization;
  if (typeof auth === "string") headers["authorization"] = auth;
  const company = req.headers["x-company-id"];
  if (typeof company === "string") headers["x-company-id"] = company;
  const res = await app.inject({
    method: invocation.method,
    url: `${prefix}${invocation.path}${queryString(invocation.query)}`,
    headers,
    ...(invocation.method === "POST" ? { payload: invocation.payload ?? {} } : {}),
  });
  let body: unknown = null;
  const text = res.body;
  if (text && text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.statusCode, body };
}

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null) {
    const rec = body as Record<string, unknown>;
    for (const key of ["message", "error"]) {
      const v = rec[key];
      if (typeof v === "string" && v !== "") return v;
    }
  }
  return fallback;
}

export const mcpModule: FastifyPluginAsync = async (app) => {
  const prefix = "/api/v1";

  const companyGate = [app.authenticate, app.requireCompany];
  const projectGate = [
    app.authenticate,
    app.requireCompany,
    // Tool-gated so an OAuth machine caller is admitted at all: the shared gate
    // only lets a machine through a route that names a tool AND a project.
    app.requireTool("integrations", "read"),
  ];

  /** One JSON-RPC call → one JSON-RPC response (or null for a notification). */
  async function handleCall(
    req: FastifyRequest,
    ctx: ToolContext,
    raw: unknown,
    used: { methods: string[]; tools: string[] },
  ): Promise<RpcResponse | null> {
    const parsed = parseCall(raw);
    if (!parsed.ok) return rpcError(parsed.id, parsed.error.code, parsed.error.message);
    const { call } = parsed;
    used.methods.push(call.method);
    const answer = async (): Promise<RpcResponse> => {
      switch (call.method) {
        case "initialize":
          return rpcResult(call.id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
            },
            serverInfo: SERVER_INFO,
            instructions:
              "ConstructOS is a construction delivery and owner-side assurance platform. Every " +
              "tool here runs as the caller who opened this session, through the same " +
              "permission gates the web application uses — a refusal is a real refusal, not a " +
              "transport problem, and retrying it will not help. Figures the platform cannot " +
              "compute are returned as null with a reason; never present such a value as zero. " +
              (ctx.defaultProjectId
                ? `This session is pinned to project ${ctx.defaultProjectId}, which every ` +
                  "project-scoped tool uses unless you pass another."
                : "This session is company-scoped: pass projectId to tools that need one, or " +
                  "call list_projects first."),
          });

        case "notifications/initialized":
        case "ping":
          return rpcResult(call.id, {});

        case "tools/list":
          return rpcResult(call.id, toolListPayload());

        case "resources/list":
          return rpcResult(call.id, {
            resources: RESOURCES.filter((r) => r.path(ctx) !== null).map((r) => ({
              uri: r.uri,
              name: r.name,
              title: r.title,
              description: r.description,
              mimeType: r.mimeType,
            })),
          });

        case "resources/read": {
          const uri = call.params["uri"];
          const resource = RESOURCES.find((r) => r.uri === uri);
          const path = resource?.path(ctx) ?? null;
          if (!resource || path === null) {
            return rpcError(
              call.id,
              RPC_ERRORS.unavailable,
              typeof uri === "string" && resource
                ? `Resource ${uri} needs a project-scoped session — open the MCP session on /api/v1/projects/{projectId}/mcp`
                : `Unknown resource ${String(uri)}`,
              { available: RESOURCES.map((r) => r.uri) },
            );
          }
          const res = await callPlatform(app, req, prefix, { method: "GET", path });
          if (res.status >= 400) {
            return rpcError(
              call.id,
              errorForStatus(res.status),
              errorMessage(res.body, `Reading ${resource.uri} failed with status ${res.status}`),
              { status: res.status },
            );
          }
          return rpcResult(call.id, {
            contents: [
              {
                uri: resource.uri,
                mimeType: resource.mimeType,
                text: JSON.stringify(res.body, null, 2),
              },
            ],
          });
        }

        case "tools/call": {
          const name = call.params["name"];
          if (typeof name !== "string") {
            return rpcError(call.id, RPC_ERRORS.invalidParams, "tools/call requires a tool name");
          }
          const tool = toolByName(name);
          if (!tool) {
            return rpcError(call.id, RPC_ERRORS.methodNotFound, `Unknown tool "${name}"`, {
              available: MCP_TOOL_NAMES,
            });
          }
          used.tools.push(name);
          const rawArgs = call.params["arguments"];
          const args =
            typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
              ? (rawArgs as Record<string, unknown>)
              : {};
          const validated = tool.schema.safeParse(args);
          if (!validated.success) {
            return rpcError(
              call.id,
              RPC_ERRORS.invalidParams,
              `Arguments for "${name}" are not valid`,
              { issues: validated.error.issues.map((i) => ({ path: i.path, message: i.message })) },
            );
          }
          let invocation;
          try {
            invocation = tool.build(validated.data as Record<string, unknown>, ctx);
          } catch (err) {
            return rpcError(
              call.id,
              RPC_ERRORS.invalidParams,
              err instanceof Error ? err.message : String(err),
            );
          }
          const res = await callPlatform(app, req, prefix, invocation);
          if (res.status >= 400) {
            /*
             * A tool that FAILED is reported as an MCP tool error (isError on
             * the result), not as a transport error, whenever the failure is
             * the caller's to act on — that is what lets a model read the
             * message and try something else. Permission refusals carry the
             * platform's own wording, because "forbidden" without the reason
             * teaches an agent nothing.
             */
            return rpcResult(call.id, {
              isError: true,
              content: [
                {
                  type: "text",
                  text: errorMessage(
                    res.body,
                    `${tool.name} failed with status ${res.status}`,
                  ),
                },
              ],
              structuredContent: {
                status: res.status,
                rpcCode: errorForStatus(res.status),
                backs: tool.backs,
                detail: res.body,
              },
            });
          }
          return rpcResult(call.id, {
            content: [{ type: "text", text: tool.summarise(res.body) }],
            structuredContent: res.body,
          });
        }

        default:
          return rpcError(call.id, RPC_ERRORS.methodNotFound, `Unknown method "${call.method}"`, {
            supported: [
              "initialize",
              "ping",
              "tools/list",
              "tools/call",
              "resources/list",
              "resources/read",
            ],
          });
      }
    };

    const response = await answer();
    // A notification expects no response at all — not null, not an empty
    // object. Errors on a notification are dropped too, which is the spec's
    // rule and not an oversight.
    return call.notification ? null : response;
  }

  async function serve(req: FastifyRequest, defaultProjectId: string | null) {
    const ctx: ToolContext = { defaultProjectId };
    const split = splitBatch(req.body);
    const calls = split.calls ?? [];
    if (split.batch && calls.length === 0) {
      return [rpcError(null, RPC_ERRORS.invalidRequest, "A batch must contain at least one call")];
    }
    if (calls.length > MAX_BATCH) {
      return split.batch
        ? [rpcError(null, RPC_ERRORS.invalidRequest, `A batch may carry at most ${MAX_BATCH} calls`)]
        : rpcError(null, RPC_ERRORS.invalidRequest, "Too many calls");
    }
    const used = { methods: [] as string[], tools: [] as string[] };
    const responses: RpcResponse[] = [];
    for (const raw of calls) {
      const response = await handleCall(req, ctx, raw, used);
      if (response) responses.push(response);
    }

    /*
     * One ledger entry per REQUEST, not per call: an agent surface must leave
     * an audit trail of what it exercised, and the writes the tools performed
     * are already ledgered by the routes that performed them. Recording each
     * call separately would double the volume without adding a fact.
     */
    if (used.methods.length > 0) {
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user?.id ?? null,
        action: "access",
        objectType: "mcp_session",
        objectId: req.user?.id ?? "anonymous",
        ...(defaultProjectId ? { projectId: defaultProjectId } : {}),
        payload: {
          methods: [...new Set(used.methods)],
          tools: [...new Set(used.tools)],
          calls: calls.length,
          machineClient: req.machineClient?.clientId ?? null,
          projectId: defaultProjectId,
        },
        storePayload: true,
      });
    }

    if (!split.batch) return responses[0] ?? null;
    return responses.length > 0 ? responses : null;
  }

  /** Company-scoped session — a signed-in person, no project pinned. */
  app.post("/mcp", { preHandler: companyGate }, async (req, reply) => {
    const out = await serve(req, null);
    // A body of only notifications produces no response: 204, per JSON-RPC.
    if (out === null) return reply.status(204).send();
    return out;
  });

  /** Project-scoped session — the form a machine caller uses. */
  app.post("/projects/:projectId/mcp", { preHandler: projectGate }, async (req, reply) => {
    const out = await serve(req, req.projectId!);
    if (out === null) return reply.status(204).send();
    return out;
  });

  /**
   * A plain description of the endpoint for a human (or a client bootstrapping
   * itself) — what it speaks, which tools exist and how authority works.
   */
  app.get("/mcp", { preHandler: companyGate }, async () => ({
    protocol: "JSON-RPC 2.0 over a single POST",
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: SERVER_INFO,
    endpoints: {
      company: `${prefix}/mcp`,
      project: `${prefix}/projects/{projectId}/mcp`,
    },
    methods: [
      "initialize",
      "ping",
      "tools/list",
      "tools/call",
      "resources/list",
      "resources/read",
    ],
    tools: MCP_TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      backs: t.backs,
      writes: t.destructive,
    })),
    resources: RESOURCES.map((r) => ({ uri: r.uri, title: r.title })),
    authority:
      "Every tool is dispatched through the platform's own router as the caller who opened the " +
      "session, so an MCP client sees exactly what that caller can see over HTTP and nothing " +
      "more. Machine callers authenticate with an OAuth2 client-credentials token and must use " +
      "the project-scoped endpoint, because a machine's authority is resolved per project.",
    limits: { maxBatch: MAX_BATCH },
  }));
};
