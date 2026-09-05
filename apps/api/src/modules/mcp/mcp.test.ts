import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { companyMemberships, ledgerEntries, projectMemberships, projects, rfis } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { mcpModule } from "./index.js";

/**
 * MCP server integration tests (#126-127).
 *
 * The property under test throughout is the one the module exists to
 * guarantee: an MCP session is not a second, softer door. Every tool goes
 * through the platform's own router as the caller, so the tests assert not only
 * that a tool works, but that it REFUSES exactly where the HTTP route would —
 * including across a tenant boundary.
 */

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let member: TestActor;
let outsider: TestActor;
let memberHeaders: Record<string, string>;
let projectId: string;

const url = (p: string) => `/api/v1${p}`;

interface RpcOut {
  jsonrpc: string;
  id: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

async function rpc(
  headers: Record<string, string>,
  body: unknown,
  path = "/mcp",
): Promise<{ status: number; body: RpcOut }> {
  const res = await app.inject({ method: "POST", url: url(path), headers, payload: body });
  return { status: res.statusCode, body: res.body ? (res.json() as RpcOut) : ({} as RpcOut) };
}

const call = (id: number | string, method: string, params?: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params ? { params } : {}),
});

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  // app.ts registers every module; until the orchestrator adds the mcp line
  // there, mount it here so the suite exercises the real plugin either way.
  if (!app.hasRoute({ method: "POST", url: "/api/v1/mcp" })) {
    await app.register(mcpModule, { prefix: "/api/v1" });
  }
  owner = await registerActor(app, { companyName: "MCP Test Co" });
  member = await registerActor(app);
  outsider = await registerActor(app, { companyName: "Other Co" });

  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: member.userId,
    role: "member",
  });
  memberHeaders = {
    authorization: member.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "MCP Project",
  });
  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId,
    userId: member.userId,
    templateKey: "project_manager",
  });
});

afterAll(async () => {
  await built.close();
});

/* ------------------------------------------------------------------ */
/* Handshake                                                           */
/* ------------------------------------------------------------------ */

describe("handshake", () => {
  it("initializes with a protocol version, capabilities and instructions", async () => {
    const { status, body } = await rpc(owner.headers, call(1, "initialize"));
    expect(status).toBe(200);
    const result = body.result!;
    expect(typeof result["protocolVersion"]).toBe("string");
    expect(result["capabilities"]).toMatchObject({ tools: {}, resources: {} });
    expect((result["serverInfo"] as Record<string, unknown>)["name"]).toBe("constructos");
    // the instructions must tell a model the honesty rule, not just the shape
    expect(String(result["instructions"])).toContain("null with a reason");
  });

  it("says the session is company-scoped when it is, and names the project when it is not", async () => {
    const company = await rpc(owner.headers, call(1, "initialize"));
    expect(String(company.body.result!["instructions"])).toContain("company-scoped");
    const project = await rpc(
      owner.headers,
      call(1, "initialize"),
      `/projects/${projectId}/mcp`,
    );
    expect(String(project.body.result!["instructions"])).toContain(projectId);
  });

  it("answers ping and requires authentication", async () => {
    expect((await rpc(owner.headers, call(2, "ping"))).body.result).toEqual({});
    const anon = await app.inject({
      method: "POST",
      url: url("/mcp"),
      payload: call(1, "ping"),
    });
    expect(anon.statusCode).toBe(401);
  });
});

/* ------------------------------------------------------------------ */
/* Envelope discipline                                                 */
/* ------------------------------------------------------------------ */

describe("JSON-RPC discipline", () => {
  it("answers a notification with NOTHING — 204, not a null result", async () => {
    const res = await app.inject({
      method: "POST",
      url: url("/mcp"),
      headers: owner.headers,
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
  });

  it("answers a batch with an array, skipping the notifications in it", async () => {
    const res = await app.inject({
      method: "POST",
      url: url("/mcp"),
      headers: owner.headers,
      payload: [
        call(1, "ping"),
        { jsonrpc: "2.0", method: "notifications/initialized" },
        call(2, "tools/list"),
      ],
    });
    expect(res.statusCode).toBe(200);
    const out = res.json() as RpcOut[];
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.id)).toEqual([1, 2]);
  });

  it("refuses an empty batch and an oversized one", async () => {
    const empty = await rpc(owner.headers, []);
    expect((empty.body as unknown as RpcOut[])[0]!.error!.code).toBe(-32600);
    const huge = await rpc(
      owner.headers,
      Array.from({ length: 25 }, (_, i) => call(i, "ping")),
    );
    expect((huge.body as unknown as RpcOut[])[0]!.error!.message).toContain("at most");
  });

  it("reports an unknown method and an unknown tool distinctly", async () => {
    const method = await rpc(owner.headers, call(1, "nonsense/thing"));
    expect(method.body.error!.code).toBe(-32601);
    expect(method.body.error!.message).toContain("nonsense/thing");

    const tool = await rpc(owner.headers, call(2, "tools/call", { name: "delete_everything" }));
    expect(tool.body.error!.code).toBe(-32601);
    expect((tool.body.error!.data as Record<string, unknown>)["available"]).toBeDefined();
  });

  it("validates tool arguments before dispatching anything", async () => {
    const out = await rpc(owner.headers, call(1, "tools/call", { name: "search", arguments: {} }));
    expect(out.body.error!.code).toBe(-32602);
    expect(JSON.stringify(out.body.error!.data)).toContain("q");
  });
});

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

describe("discovery", () => {
  it("lists every declared tool with a schema and a read-only hint", async () => {
    const { body } = await rpc(owner.headers, call(1, "tools/list"));
    const tools = body.result!["tools"] as Record<string, unknown>[];
    const names = tools.map((t) => t["name"]);
    expect(names).toContain("search");
    expect(names).toContain("project_health");
    expect(names).toContain("create_rfi");
    expect(names).toContain("run_detectors");
    for (const tool of tools) {
      expect(tool["inputSchema"], String(tool["name"])).toMatchObject({ type: "object" });
      // the description must say which route backs it: an agent that cannot
      // tell a read from a write cannot ask for confirmation at the right time
      expect(String(tool["description"])).toContain("Backed by");
    }
    const search = tools.find((t) => t["name"] === "search")!;
    expect((search["annotations"] as Record<string, unknown>)["readOnlyHint"]).toBe(true);
    const rfi = tools.find((t) => t["name"] === "create_rfi")!;
    expect((rfi["annotations"] as Record<string, unknown>)["readOnlyHint"]).toBe(false);
  });

  it("lists resources, and hides the project-scoped one on a company session", async () => {
    const company = await rpc(owner.headers, call(1, "resources/list"));
    const companyUris = (company.body.result!["resources"] as Record<string, unknown>[]).map(
      (r) => r["uri"],
    );
    expect(companyUris).toContain("constructos://projects");
    expect(companyUris).not.toContain("constructos://project/health");

    const project = await rpc(
      owner.headers,
      call(1, "resources/list"),
      `/projects/${projectId}/mcp`,
    );
    const projectUris = (project.body.result!["resources"] as Record<string, unknown>[]).map(
      (r) => r["uri"],
    );
    expect(projectUris).toContain("constructos://project/health");
  });

  it("explains rather than 500s when a project resource is read on a company session", async () => {
    const { body } = await rpc(
      owner.headers,
      call(1, "resources/read", { uri: "constructos://project/health" }),
    );
    expect(body.error!.message).toContain("project-scoped session");
  });

  it("refuses an unknown resource uri and names the ones that exist", async () => {
    const { body } = await rpc(
      owner.headers,
      call(1, "resources/read", { uri: "constructos://nope" }),
    );
    expect(body.error!.code).toBe(-32002);
    expect((body.error!.data as Record<string, unknown>)["available"]).toBeDefined();
  });

  it("reads a resource through the platform's own route", async () => {
    const { body } = await rpc(
      owner.headers,
      call(1, "resources/read", { uri: "constructos://projects" }),
    );
    const contents = body.result!["contents"] as Record<string, unknown>[];
    expect(contents[0]!["mimeType"]).toBe("application/json");
    expect(String(contents[0]!["text"])).toContain(projectId);
  });
});

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

describe("tools", () => {
  it("lists projects, returning both a text summary and structured content", async () => {
    const { body } = await rpc(owner.headers, call(1, "tools/call", { name: "list_projects" }));
    const result = body.result!;
    expect(result["isError"]).toBeUndefined();
    const content = result["content"] as Record<string, unknown>[];
    expect(String(content[0]!["text"])).toMatch(/Returned \d+ project/);
    expect(JSON.stringify(result["structuredContent"])).toContain(projectId);
  });

  it("creates an RFI in DRAFT and it is a real record", async () => {
    const { body } = await rpc(
      owner.headers,
      call(1, "tools/call", {
        name: "create_rfi",
        arguments: { projectId, subject: "MCP raised", question: "Which detail governs?" },
      }),
    );
    expect(body.result!["isError"]).toBeUndefined();
    const rows = await app.db
      .select()
      .from(rfis)
      .where(and(eq(rfis.projectId, projectId), eq(rfis.subject, "MCP raised")));
    expect(rows).toHaveLength(1);
    // an agent may PREPARE an RFI; issuing it stays a human decision
    expect(rows[0]!.status).toBe("draft");
  });

  it("inherits the session's project so the arguments need not repeat it", async () => {
    const { body } = await rpc(
      owner.headers,
      call(1, "tools/call", {
        name: "create_rfi",
        arguments: { subject: "Inherited project", question: "q" },
      }),
      `/projects/${projectId}/mcp`,
    );
    expect(body.result!["isError"]).toBeUndefined();
    const rows = await app.db
      .select()
      .from(rfis)
      .where(and(eq(rfis.projectId, projectId), eq(rfis.subject, "Inherited project")));
    expect(rows).toHaveLength(1);
  });

  it("tells the caller plainly when a project-scoped tool has no project", async () => {
    const { body } = await rpc(
      owner.headers,
      call(1, "tools/call", { name: "list_obligations", arguments: {} }),
    );
    expect(body.error!.code).toBe(-32602);
    expect(body.error!.message).toContain("projectId is required");
  });

  it("reports a failed tool as an MCP tool error with the platform's own wording", async () => {
    const { body } = await rpc(
      owner.headers,
      call(1, "tools/call", {
        name: "get_record",
        arguments: { type: "project", id: "prj_does_not_exist" },
      }),
    );
    const result = body.result!;
    expect(result["isError"]).toBe(true);
    // The platform refuses an unknown id at the gate that resolves it, so the
    // status is the route's own (403 here, 404 elsewhere) — the point is that
    // the MCP layer surfaces it rather than inventing one.
    expect([403, 404]).toContain(
      (result["structuredContent"] as Record<string, unknown>)["status"],
    );
    expect(String((result["content"] as Record<string, unknown>[])[0]!["text"]).length).toBeGreaterThan(
      0,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Authority — the property the module exists for                      */
/* ------------------------------------------------------------------ */

describe("an MCP session is never a wider door", () => {
  it("refuses a cross-tenant project exactly as the HTTP route does", async () => {
    const viaMcp = await rpc(outsider.headers, call(1, "tools/call", {
      name: "create_rfi",
      arguments: { projectId, subject: "Cross tenant", question: "q" },
    }));
    const result = viaMcp.body.result!;
    expect(result["isError"]).toBe(true);
    const structured = result["structuredContent"] as Record<string, unknown>;
    expect([401, 403, 404]).toContain(structured["status"]);

    // and nothing was written
    const rows = await app.db
      .select()
      .from(rfis)
      .where(eq(rfis.subject, "Cross tenant"));
    expect(rows).toHaveLength(0);
  });

  it("refuses a project the caller is not a member of, for a non-admin", async () => {
    const otherProject = newId("prj");
    await app.db.insert(projects).values({
      id: otherProject,
      companyId: owner.companyId,
      name: "Not the member's project",
    });
    const { body } = await rpc(
      memberHeaders,
      call(1, "tools/call", {
        name: "create_rfi",
        arguments: { projectId: otherProject, subject: "Should not exist", question: "q" },
      }),
    );
    expect(body.result!["isError"]).toBe(true);
    expect((body.result!["structuredContent"] as Record<string, unknown>)["status"]).toBe(403);
    const rows = await app.db.select().from(rfis).where(eq(rfis.projectId, otherProject));
    expect(rows).toHaveLength(0);
  });

  it("lets a member reach the project they ARE on, at the level their template grants", async () => {
    const { body } = await rpc(
      memberHeaders,
      call(1, "tools/call", {
        name: "create_rfi",
        arguments: { projectId, subject: "Member raised", question: "q" },
      }),
    );
    expect(body.result!["isError"]).toBeUndefined();

    // …and is still refused a tool their template says none to. The
    // `project_manager` template holds no assurance access, so the obligations
    // register is closed to them THROUGH MCP exactly as it is over HTTP.
    const obligations = await rpc(
      memberHeaders,
      call(2, "tools/call", { name: "list_obligations", arguments: { projectId } }),
    );
    expect(obligations.body.result!["isError"]).toBe(true);
    expect(
      (obligations.body.result!["structuredContent"] as Record<string, unknown>)["status"],
    ).toBe(403);
    const direct = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/obligations`),
      headers: memberHeaders,
    });
    // the same refusal, by the same gate, over HTTP
    expect(direct.statusCode).toBe(403);
  });

  it("refuses the project-scoped endpoint across a tenant boundary before any tool runs", async () => {
    const res = await app.inject({
      method: "POST",
      url: url(`/projects/${projectId}/mcp`),
      headers: outsider.headers,
      payload: call(1, "ping"),
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

describe("audit", () => {
  it("ledgers one entry per request naming the methods and tools exercised", async () => {
    const before = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "mcp_session"),
        ),
      );
    await rpc(owner.headers, [call(1, "tools/list"), call(2, "tools/call", { name: "list_projects" })]);
    const after = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "mcp_session"),
        ),
      );
    expect(after.length).toBe(before.length + 1);
    const payload = after[after.length - 1]!.payload as Record<string, unknown>;
    expect(payload["methods"]).toEqual(expect.arrayContaining(["tools/list", "tools/call"]));
    expect(payload["tools"]).toEqual(["list_projects"]);
    expect(payload["calls"]).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Self-description                                                    */
/* ------------------------------------------------------------------ */

describe("GET /mcp", () => {
  it("describes the endpoint, its tools and how authority works", async () => {
    const res = await app.inject({ method: "GET", url: url("/mcp"), headers: owner.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body["protocol"]).toContain("JSON-RPC 2.0");
    expect((body["tools"] as unknown[]).length).toBeGreaterThan(5);
    expect(String(body["authority"])).toContain("nothing more");
    expect((body["endpoints"] as Record<string, string>)["project"]).toContain("{projectId}");
  });
});
