/**
 * The MCP tool catalogue (#126-127).
 *
 * THE DESIGN DECISION THAT MATTERS. Every tool here is a thin adapter over an
 * EXISTING PLATFORM ROUTE, dispatched through the app's own router with the
 * caller's own credentials. Not a second query layer, not a "trusted" path —
 * the same handler, the same `requireTool` gate, the same tenant scoping, the
 * same ledger append. It follows that an MCP session can never see or do
 * something the same caller could not do over HTTP, and that a permission fix
 * anywhere on the platform is a permission fix here too, with nothing to
 * remember to mirror.
 *
 * The cost, stated honestly: a tool whose backing route is not present in a
 * deployment reports itself unavailable rather than half-working. That is the
 * right failure — an agent told "list_obligations is not available in this
 * deployment" retries something else; an agent handed an empty list concludes
 * there are no obligations.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: no streaming (a single POST answers one
 * batch), no sampling or roots (the server never asks the client to run a
 * model), no prompts capability, and no long-lived session state — an MCP
 * session here is stateless, so a client may reconnect at will and a replica
 * behind a load balancer needs no affinity.
 */
import { z } from "zod";
import { MCP_TOOL_NAMES, type McpToolName } from "@constructos/shared";

/** How a tool call becomes an HTTP call against the platform's own router. */
export interface ToolInvocation {
  method: "GET" | "POST";
  /** path relative to the API prefix, e.g. "/search" */
  path: string;
  query?: Record<string, string | number | undefined>;
  payload?: Record<string, unknown>;
}

export interface McpToolDef {
  name: McpToolName;
  title: string;
  description: string;
  /** JSON Schema published through tools/list */
  inputSchema: Record<string, unknown>;
  /** zod mirror of inputSchema — the one that actually rejects bad input */
  schema: z.ZodType<Record<string, unknown>>;
  /** true when the tool mutates: an MCP client shows a confirmation for these */
  destructive: boolean;
  /** the platform route this tool goes through, published in the description */
  backs: string;
  build: (args: Record<string, unknown>, ctx: ToolContext) => ToolInvocation;
  /** shape the route's JSON into a short human-readable summary */
  summarise: (body: unknown) => string;
}

export interface ToolContext {
  /** the project an MCP session is pinned to, when it was opened on one */
  defaultProjectId: string | null;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const projectArg = z.string().min(1).max(64);

function requireProject(
  args: Record<string, unknown>,
  ctx: ToolContext,
): string {
  const raw = args["projectId"];
  const id = typeof raw === "string" && raw !== "" ? raw : ctx.defaultProjectId;
  if (!id) {
    throw new Error(
      "projectId is required — pass it in the tool arguments, or open the MCP session on " +
        "/api/v1/projects/{projectId}/mcp so every call inherits it",
    );
  }
  return id;
}

function countOf(body: unknown): number | null {
  if (Array.isArray(body)) return body.length;
  if (typeof body === "object" && body !== null) {
    const rec = body as Record<string, unknown>;
    for (const key of ["total", "count"]) {
      if (typeof rec[key] === "number") return rec[key] as number;
    }
    for (const key of ["items", "rows", "results", "signals", "obligations"]) {
      if (Array.isArray(rec[key])) return (rec[key] as unknown[]).length;
    }
  }
  return null;
}

function pick(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

const listSummary = (noun: string) => (body: unknown) => {
  const n = countOf(body);
  return n === null ? `Returned ${noun}.` : `Returned ${n} ${noun}.`;
};

/* ------------------------------------------------------------------ */
/* The catalogue                                                       */
/* ------------------------------------------------------------------ */

export const MCP_TOOLS: readonly McpToolDef[] = [
  {
    name: "search",
    title: "Search the platform",
    description:
      "Full-platform search across projects, RFIs, submittals, drawings, documents, " +
      "commitments, invoices, contracts, risks, signals, obligations, vendors and every other " +
      "registered record type. Results are already filtered to what the caller may see.",
    backs: "GET /api/v1/search",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "The search text" },
        types: {
          type: "string",
          description: "Comma-separated record types to restrict the search to",
        },
        projectId: { type: "string", description: "Restrict to one project" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["q"],
    },
    schema: z.object({
      q: z.string().min(1).max(200),
      types: z.string().max(300).optional(),
      projectId: projectArg.optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    build: (args, ctx) => ({
      method: "GET",
      path: "/search",
      query: {
        q: args["q"] as string,
        types: args["types"] as string | undefined,
        projectId: (args["projectId"] as string | undefined) ?? ctx.defaultProjectId ?? undefined,
        limit: (args["limit"] as number | undefined) ?? 20,
      },
    }),
    summarise: (body) => {
      const n = countOf(body);
      const took = pick(body, "tookMs");
      return `${n ?? 0} result(s)${typeof took === "number" ? ` in ${took}ms` : ""}.`;
    },
  },
  {
    name: "list_projects",
    title: "List projects",
    description:
      "The projects this caller can open, with stage and status. Use it to resolve a project " +
      "name to the id every other tool takes.",
    backs: "GET /api/v1/projects",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { pageSize: { type: "integer", minimum: 1, maximum: 100 } },
    },
    schema: z.object({ pageSize: z.number().int().min(1).max(100).optional() }),
    build: (args) => ({
      method: "GET",
      path: "/projects",
      query: { pageSize: (args["pageSize"] as number | undefined) ?? 50 },
    }),
    summarise: listSummary("project(s)"),
  },
  {
    name: "get_record",
    title: "Read one record",
    description:
      "Fetch a single record by type and id. Supported types: project, rfi, observation, " +
      "signal, obligation. The id is read through the module that owns it, so the same " +
      "permission that governs the record governs this call.",
    backs: "the owning module's own GET route",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["project", "rfi", "observation", "signal", "obligation"],
        },
        id: { type: "string" },
        projectId: {
          type: "string",
          description: "Required for project-scoped types (rfi, observation, obligation)",
        },
      },
      required: ["type", "id"],
    },
    schema: z.object({
      type: z.enum(["project", "rfi", "observation", "signal", "obligation"]),
      id: z.string().min(1).max(64),
      projectId: projectArg.optional(),
    }),
    build: (args, ctx) => {
      const type = args["type"] as string;
      const id = args["id"] as string;
      if (type === "project") return { method: "GET", path: `/projects/${id}` };
      if (type === "signal") return { method: "GET", path: `/signals/${id}` };
      const projectId = requireProject(args, ctx);
      const path =
        type === "rfi"
          ? `/projects/${projectId}/rfis/${id}`
          : type === "observation"
            ? `/projects/${projectId}/observations/${id}`
            : `/projects/${projectId}/obligations/${id}`;
      return { method: "GET", path };
    },
    summarise: (body) => {
      const id = pick(body, "id");
      return typeof id === "string" ? `Record ${id}.` : "Record returned.";
    },
  },
  {
    name: "list_signals",
    title: "List assurance signals",
    description:
      "Open integrity and risk signals raised by the detector programme, newest first. Each " +
      "carries its detector, severity, confidence and the evidence it points at.",
    backs: "GET /api/v1/signals",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
        disposition: { type: "string" },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    schema: z.object({
      projectId: projectArg.optional(),
      severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
      disposition: z.string().max(40).optional(),
      pageSize: z.number().int().min(1).max(100).optional(),
    }),
    build: (args, ctx) => ({
      method: "GET",
      path: "/signals",
      query: {
        projectId: (args["projectId"] as string | undefined) ?? ctx.defaultProjectId ?? undefined,
        severity: args["severity"] as string | undefined,
        disposition: args["disposition"] as string | undefined,
        pageSize: (args["pageSize"] as number | undefined) ?? 25,
      },
    }),
    summarise: listSummary("signal(s)"),
  },
  {
    name: "list_obligations",
    title: "List contract obligations",
    description:
      "Obligations extracted from the project's contracts, with their deadlines and status. " +
      "This is the register a time-bar or notice question is answered from.",
    backs: "GET /api/v1/projects/{projectId}/obligations",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        status: { type: "string" },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    schema: z.object({
      projectId: projectArg.optional(),
      status: z.string().max(40).optional(),
      pageSize: z.number().int().min(1).max(100).optional(),
    }),
    build: (args, ctx) => ({
      method: "GET",
      path: `/projects/${requireProject(args, ctx)}/obligations`,
      query: {
        status: args["status"] as string | undefined,
        pageSize: (args["pageSize"] as number | undefined) ?? 25,
      },
    }),
    summarise: listSummary("obligation(s)"),
  },
  {
    name: "project_health",
    title: "Project health",
    description:
      "The explainable health verdict for a project: an overall level and score, each " +
      "dimension with the basis it was computed from, and the recent trend. Figures the " +
      "platform cannot compute come back null with a reason — never as zero.",
    backs: "GET /api/v1/projects/{projectId}/health",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
    },
    schema: z.object({ projectId: projectArg.optional() }),
    build: (args, ctx) => ({
      method: "GET",
      path: `/projects/${requireProject(args, ctx)}/health`,
    }),
    summarise: (body) => {
      const level = pick(body, "level");
      const score = pick(body, "score");
      if (typeof level !== "string") return "Health returned.";
      return `Health: ${level}${typeof score === "number" ? ` (${score}/100)` : " (score not available)"}.`;
    },
  },
  {
    name: "create_rfi",
    title: "Raise an RFI",
    description:
      "Create a request for information on a project. It lands in DRAFT — an agent may " +
      "prepare an RFI but the decision to issue it stays with a person.",
    backs: "POST /api/v1/projects/{projectId}/rfis",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        subject: { type: "string" },
        question: { type: "string" },
        proposedSolution: { type: "string" },
        dueDate: { type: "string", description: "ISO date" },
        assigneeId: { type: "string" },
      },
      required: ["subject", "question"],
    },
    schema: z.object({
      projectId: projectArg.optional(),
      subject: z.string().min(1).max(300),
      question: z.string().min(1).max(10_000),
      proposedSolution: z.string().max(10_000).optional(),
      dueDate: z.string().min(4).max(40).optional(),
      assigneeId: z.string().min(1).max(64).optional(),
    }),
    build: (args, ctx) => ({
      method: "POST",
      path: `/projects/${requireProject(args, ctx)}/rfis`,
      payload: {
        subject: args["subject"],
        question: args["question"],
        ...(args["proposedSolution"] !== undefined
          ? { proposedSolution: args["proposedSolution"] }
          : {}),
        ...(args["dueDate"] !== undefined ? { dueDate: args["dueDate"] } : {}),
        ...(args["assigneeId"] !== undefined ? { assigneeId: args["assigneeId"] } : {}),
      },
    }),
    summarise: (body) => {
      const number = pick(body, "number");
      const id = pick(body, "id");
      return `RFI ${number ?? id ?? "created"} raised in draft.`;
    },
  },
  {
    name: "create_observation",
    title: "Record an observation",
    description:
      "Record a field observation — a condition seen on site, which a person can later " +
      "convert to a punch item, an incident or a change event.",
    backs: "POST /api/v1/projects/{projectId}/observations",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        observationType: { type: "string" },
        priority: { type: "string" },
        dueDate: { type: "string", description: "ISO date" },
      },
      required: ["title"],
    },
    schema: z.object({
      projectId: projectArg.optional(),
      title: z.string().min(1).max(300),
      description: z.string().max(10_000).optional(),
      observationType: z.string().max(40).optional(),
      priority: z.string().max(40).optional(),
      dueDate: z.string().min(4).max(40).optional(),
    }),
    build: (args, ctx) => ({
      method: "POST",
      path: `/projects/${requireProject(args, ctx)}/observations`,
      payload: {
        title: args["title"],
        ...(args["description"] !== undefined ? { description: args["description"] } : {}),
        ...(args["observationType"] !== undefined
          ? { observationType: args["observationType"] }
          : {}),
        ...(args["priority"] !== undefined ? { priority: args["priority"] } : {}),
        ...(args["dueDate"] !== undefined ? { dueDate: args["dueDate"] } : {}),
      },
    }),
    summarise: (body) => {
      const id = pick(body, "id");
      return `Observation ${id ?? "recorded"}.`;
    },
  },
  {
    name: "run_detectors",
    title: "Run the assurance detectors",
    description:
      "Run the integrity detector programme over a project now. Detectors raise signals; they " +
      "never change a record, so this is safe to call, but it is a write in the sense that new " +
      "signals appear and are ledgered.",
    backs: "POST /api/v1/projects/{projectId}/detectors/run",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
    },
    schema: z.object({ projectId: projectArg.optional() }),
    build: (args, ctx) => ({
      method: "POST",
      path: `/projects/${requireProject(args, ctx)}/detectors/run`,
      payload: {},
    }),
    summarise: (body) => {
      const raised = pick(body, "signalsRaised") ?? pick(body, "raised");
      return typeof raised === "number"
        ? `Detector run complete — ${raised} signal(s) raised.`
        : "Detector run complete.";
    },
  },
];

/** Names in the declared order, so tools/list is stable across calls. */
export const TOOL_ORDER: readonly McpToolName[] = MCP_TOOL_NAMES;

export function toolByName(name: string): McpToolDef | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}

/** The tools/list payload. */
export function toolListPayload(): { tools: Record<string, unknown>[] } {
  return {
    tools: [...MCP_TOOLS]
      .sort((a, b) => TOOL_ORDER.indexOf(a.name) - TOOL_ORDER.indexOf(b.name))
      .map((t) => ({
        name: t.name,
        title: t.title,
        description: `${t.description}\n\nBacked by ${t.backs}; the caller's own permissions apply.`,
        inputSchema: t.inputSchema,
        annotations: {
          readOnlyHint: !t.destructive,
          destructiveHint: false,
          idempotentHint: !t.destructive,
          openWorldHint: false,
        },
      })),
  };
}
