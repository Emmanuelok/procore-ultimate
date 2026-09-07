import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companyMemberships, projectMemberships, projects, rfis, vendors } from "@constructos/db";
import type { FastifyInstance } from "fastify";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import { searchModule } from "./index.js";

let built: BuiltApp;
let app: FastifyInstance;
let owner: TestActor;
let member: TestActor;
let memberHeaders: Record<string, string>;
let outsider: TestActor;
let projectA: string;
let projectB: string;
let rfiA: string;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  // app.ts registers every module; until the orchestrator adds the search line
  // there, mount it here so the suite exercises the real plugin either way.
  if (!app.hasRoute({ method: "GET", url: "/api/v1/search" })) {
    await app.register(searchModule, { prefix: "/api/v1" });
  }

  owner = await registerActor(app, { companyName: "Search Test Co" });
  member = await registerActor(app);
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
  outsider = await registerActor(app, { companyName: "Other Co" });

  projectA = newId("prj");
  projectB = newId("prj");
  await app.db.insert(projects).values([
    { id: projectA, companyId: owner.companyId, name: "Riverside Tower", number: "P-100", city: "Leeds" },
    { id: projectB, companyId: owner.companyId, name: "Riverside Bridge", number: "P-200", city: "York" },
  ]);
  // The member is on project A only.
  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId: projectA,
    userId: member.userId,
    templateKey: "project_manager",
  });

  rfiA = newId("rfi");
  await app.db.insert(rfis).values([
    {
      id: rfiA,
      companyId: owner.companyId,
      projectId: projectA,
      number: 42,
      subject: "Riverside slab pour sequence",
      question: "Which pour comes first?",
      createdBy: owner.userId,
    },
    {
      id: newId("rfi"),
      companyId: owner.companyId,
      projectId: projectB,
      number: 7,
      subject: "Riverside bridge bearing detail",
      question: "Confirm the bearing detail.",
      createdBy: owner.userId,
    },
  ]);

  await app.db.insert(vendors).values({
    id: newId("vnd"),
    companyId: owner.companyId,
    name: "Riverside Groundworks Ltd",
    city: "Leeds",
  });
  // A vendor of ANOTHER tenant with a matching name — the cross-tenant probe.
  await app.db.insert(vendors).values({
    id: newId("vnd"),
    companyId: outsider.companyId,
    name: "Riverside Groundworks Ltd",
    city: "Leeds",
  });
});

afterAll(async () => {
  await built.close();
});

async function search(headers: Record<string, string>, qs: string) {
  const res = await app.inject({ method: "GET", url: `/api/v1/search?${qs}`, headers });
  return res;
}

describe("GET /search", () => {
  it("finds records of many types in one call and reports what it searched", async () => {
    const res = await search(owner.headers, "q=riverside");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const types = new Set(body.items.map((i: { type: string }) => i.type));
    expect(types.has("project")).toBe(true);
    expect(types.has("rfi")).toBe(true);
    expect(types.has("vendor")).toBe(true);
    expect(body.coverage).toContain("project");
    expect(typeof body.tookMs).toBe("number");
  });

  it("returns a usable SPA link for every hit", async () => {
    const res = await search(owner.headers, "q=riverside");
    for (const item of res.json().items) {
      expect(typeof item.href).toBe("string");
      expect(item.href.length).toBeGreaterThan(1);
    }
  });

  it("ranks an exact record reference above a loose title match", async () => {
    const res = await search(owner.headers, "q=P-100&types=project");
    const [first] = res.json().items;
    expect(first.title).toBe("Riverside Tower");
  });

  it("filters by type", async () => {
    const res = await search(owner.headers, "q=riverside&types=vendor");
    const body = res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(new Set(body.items.map((i: { type: string }) => i.type))).toEqual(new Set(["vendor"]));
    expect(body.coverage).toEqual(["vendor"]);
  });

  it("narrows to one project when asked", async () => {
    const res = await search(owner.headers, `q=riverside&types=rfi&projectId=${projectB}`);
    const items = res.json().items;
    expect(items.length).toBe(1);
    expect(items[0].projectId).toBe(projectB);
  });

  it("scopes project-scoped hits to the caller's memberships", async () => {
    const res = await search(memberHeaders, "q=riverside&types=project,rfi");
    const items = res.json().items as Array<{ projectId: string | null }>;
    expect(items.length).toBeGreaterThan(0);
    // The member is on project A only; project B and its RFI must not appear.
    expect(items.every((i) => i.projectId === projectA)).toBe(true);
  });

  it("does not let a named projectId widen the caller's scope", async () => {
    // The member is on project A only. Naming project B must narrow their own
    // scope to nothing, not hand them project B's records.
    const res = await search(memberHeaders, `q=riverside&types=rfi,project&projectId=${projectB}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ projectId: string | null }>; coverage: string[] };
    expect(body.items).toEqual([]);
    expect(body.coverage).toEqual([]);
  });

  it("still narrows for a caller who IS on the named project", async () => {
    const res = await search(memberHeaders, `q=riverside&types=rfi&projectId=${projectA}`);
    const items = res.json().items as Array<{ projectId: string | null }>;
    expect(items.length).toBe(1);
    expect(items[0]!.projectId).toBe(projectA);
  });

  it("never crosses a tenant boundary", async () => {
    const res = await search(outsider.headers, "q=riverside");
    const items = res.json().items as Array<{ type: string; id: string }>;
    // The other tenant has a vendor with the same name, and nothing else.
    expect(items.every((i) => i.type === "vendor")).toBe(true);
    expect(items.some((i) => i.id === rfiA)).toBe(false);
  });

  it("returns an empty result rather than an error for punctuation-only input", async () => {
    const res = await search(owner.headers, "q=%2C%2C%2C");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: [], total: 0, coverage: [] });
  });

  it("refuses an unauthenticated call", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/search?q=riverside" });
    expect(res.statusCode).toBe(401);
  });

  it("validates the query", async () => {
    const res = await search(owner.headers, "q=");
    expect(res.statusCode).toBe(400);
  });

  it("caps the limit", async () => {
    const res = await search(owner.headers, "q=riverside&limit=5000");
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /search/sources", () => {
  it("lists what this caller can search", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/search/sources",
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ type: string; tool: string | null }>;
    expect(items.some((i) => i.type === "project")).toBe(true);
    expect(items.some((i) => i.type === "user" && i.tool === null)).toBe(true);
  });

  it("offers fewer sources to a member with one project than to an owner", async () => {
    const asOwner = await app.inject({
      method: "GET",
      url: "/api/v1/search/sources",
      headers: owner.headers,
    });
    const asMember = await app.inject({
      method: "GET",
      url: "/api/v1/search/sources",
      headers: memberHeaders,
    });
    expect(asMember.json().total).toBeLessThanOrEqual(asOwner.json().total);
  });
});
