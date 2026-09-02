import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  bidSubmissionLines,
  bidSubmissions,
  budgetLineItems,
  budgets,
  changeEvents,
  companyMemberships,
  costCatalogueItems,
  estimateLineItems,
  estimateSubQuotes,
  estimates,
  ledgerEntries,
  notifications,
  projects,
  signals,
  takeoffItems,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { estimatingModule } from "./index.js";

/**
 * Estimating & takeoff — route integration tests (spec Vol I §1.2, #184–208).
 *
 * Every route is exercised at least once; the segregation-of-duties refusal on
 * approval, the conversion guards and the validity guards are asserted
 * explicitly; both scheduler jobs are run on demand; and a second company is
 * shown to see and touch nothing.
 */

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
/** prepares the estimates */
let owner: TestActor;
/** the second person every approval needs */
let approver: TestActor;
let approverHeaders: Record<string, string>;
/** a different company altogether */
let stranger: TestActor;

let projectA: string;
let projectB: string;
let strangerProject: string;

let crewId: string;
let catalogueId: string;
let assemblyId: string;

const today = new Date().toISOString().slice(0, 10);
const shiftDays = (days: number): string => {
  const d = new Date(`${today}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function get(url: string, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}
function post(url: string, payload?: unknown, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload ?? {} });
}
function put(url: string, payload: unknown, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "PUT", url: `/api/v1${url}`, headers, payload });
}
function patch(url: string, payload: unknown, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
}
function del(url: string, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "DELETE", url: `/api/v1${url}`, headers });
}

async function makeProject(companyId: string, name: string, currency = "GBP"): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({ id, companyId, name, currency });
  return id;
}

/** Create a draft estimate on projectA and return its id. */
async function makeEstimate(name = "Base estimate", projectId = projectA): Promise<string> {
  const res = await post(`/projects/${projectId}/estimates`, { name, estimateType: "bid" });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function addLine(
  estimateId: string,
  payload: Record<string, unknown>,
  projectId = projectA,
): Promise<{ id: string; amount: number }> {
  const res = await post(`/projects/${projectId}/estimates/${estimateId}/lines`, payload);
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; amount: number };
}

/** Take an estimate from draft to approved with the second person. */
async function approve(estimateId: string, projectId = projectA): Promise<void> {
  const submitted = await post(`/projects/${projectId}/estimates/${estimateId}/submit`);
  expect(submitted.statusCode).toBe(200);
  const approved = await post(
    `/projects/${projectId}/estimates/${estimateId}/approve`,
    {},
    approverHeaders,
  );
  expect(approved.statusCode).toBe(200);
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  // app.ts registers every module; until the orchestrator adds the estimating
  // line there, mount it here so the suite exercises the real plugin either way.
  if (!app.hasRoute({ method: "GET", url: "/api/v1/estimating/catalogue" })) {
    await app.register(estimatingModule, { prefix: "/api/v1" });
  }
  owner = await registerActor(app, { companyName: "Estimating Test Co" });

  approver = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: approver.userId,
    role: "admin",
  });
  approverHeaders = {
    authorization: approver.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  stranger = await registerActor(app, { companyName: "Rival Estimators" });

  projectA = await makeProject(owner.companyId, "Northgate Phase 2");
  projectB = await makeProject(owner.companyId, "Southbank Depot");
  strangerProject = await makeProject(stranger.companyId, "Rival Job");
});

afterAll(async () => {
  await built.app.close();
});

/* ================================================================== */
/* Library — catalogue, assemblies, crews, production rates            */
/* ================================================================== */

describe("cost catalogue (#192, #195–196)", () => {
  it("creates a crew and materializes its hourly cost (#197)", async () => {
    const res = await post("/estimating/crews", {
      code: "GANG-2+1",
      name: "Bricklaying gang 2+1",
      trade: "Masonry",
      currency: "GBP",
      members: [
        { trade: "bricklayer", count: 2, hourlyRate: 32 },
        { trade: "labourer", count: 1, hourlyRate: 21 },
      ],
      equipment: [{ description: "Mixer", count: 1, hourlyRate: 6.5 }],
    });
    expect(res.statusCode).toBe(201);
    const crew = res.json() as { id: string; hourlyCost: number; labourHourlyCost: number; headcount: number };
    expect(crew.labourHourlyCost).toBe(85);
    expect(crew.hourlyCost).toBe(91.5);
    expect(crew.headcount).toBe(3);
    crewId = crew.id;
  });

  it("refuses a duplicate crew code", async () => {
    const res = await post("/estimating/crews", { code: "GANG-2+1", name: "Duplicate" });
    expect(res.statusCode).toBe(409);
  });

  it("recomputes the crew cost on patch and ledgers the move", async () => {
    const res = await patch(`/estimating/crews/${crewId}`, {
      members: [
        { trade: "bricklayer", count: 2, hourlyRate: 34 },
        { trade: "labourer", count: 1, hourlyRate: 21 },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { labourHourlyCost: number }).labourHourlyCost).toBe(89);
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.companyId, owner.companyId), eq(ledgerEntries.objectId, crewId)),
      );
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  it("creates a catalogue item and sums its rate split", async () => {
    const res = await post("/estimating/catalogue", {
      code: "BLK-140",
      description: "140mm dense blockwork",
      unit: "m2",
      costType: "material",
      currency: "GBP",
      trade: "Masonry",
      rates: { labour: 24, material: 18.4 },
      crewId,
      productionRate: 2.5,
      productionRateBasis: "output_per_hour",
      costCode: "04-2000",
      rateAsAt: shiftDays(-30),
    });
    expect(res.statusCode).toBe(201);
    const item = res.json() as { id: string; unitRate: number };
    expect(item.unitRate).toBe(42.4);
    catalogueId = item.id;
  });

  it("reports the staleness of a rate with its reason", async () => {
    const res = await get(`/estimating/catalogue/${catalogueId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { staleness: { stale: boolean; ageDays: number | null; reason: string } };
    expect(body.staleness.stale).toBe(false);
    expect(body.staleness.ageDays).toBeGreaterThanOrEqual(29);
    expect(body.staleness.reason).toContain("staleness threshold");
  });

  it("bulk-imports a rate list and upserts on a second pass", async () => {
    const items = [
      { code: "EXC-BULK", description: "Bulk excavation", unit: "m3", rates: { equipment: 9.2 } },
      { code: "CONC-C30", description: "C30 concrete", unit: "m3", rates: { material: 118 } },
    ];
    const first = await post("/estimating/catalogue/bulk", { items });
    expect(first.statusCode).toBe(201);
    expect((first.json() as { created: number }).created).toBe(2);

    const second = await post("/estimating/catalogue/bulk", { items });
    expect((second.json() as { created: number; skipped: unknown[] }).created).toBe(0);
    expect((second.json() as { skipped: unknown[] }).skipped).toHaveLength(2);

    const upsert = await post("/estimating/catalogue/bulk", {
      items: [{ ...items[1]!, rates: { material: 124 } }],
      upsert: true,
    });
    expect((upsert.json() as { updated: number }).updated).toBe(1);
    const rows = await app.db
      .select()
      .from(costCatalogueItems)
      .where(
        and(eq(costCatalogueItems.companyId, owner.companyId), eq(costCatalogueItems.code, "CONC-C30")),
      );
    expect(rows[0]?.unitRate).toBe(124);
  });

  it("filters and searches the catalogue", async () => {
    const res = await get("/estimating/catalogue?search=block&costType=material");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ code: string }>; total: number };
    expect(body.items.map((i) => i.code)).toContain("BLK-140");
  });

  it("retires rather than deletes a catalogue item", async () => {
    const created = await post("/estimating/catalogue", {
      code: "TMP-1",
      description: "Temporary",
      unit: "ea",
      rates: { other: 1 },
    });
    const id = (created.json() as { id: string }).id;
    const res = await del(`/estimating/catalogue/${id}`);
    expect(res.statusCode).toBe(200);
    const after = await get(`/estimating/catalogue/${id}`);
    expect((after.json() as { status: string }).status).toBe("retired");
  });

  it("keeps a rival company out of the catalogue", async () => {
    const list = await get("/estimating/catalogue", stranger.headers);
    expect(list.statusCode).toBe(200);
    expect((list.json() as { total: number }).total).toBe(0);
    expect((await get(`/estimating/catalogue/${catalogueId}`, stranger.headers)).statusCode).toBe(404);
    expect(
      (await patch(`/estimating/catalogue/${catalogueId}`, { description: "hijacked" }, stranger.headers))
        .statusCode,
    ).toBe(404);
    expect((await del(`/estimating/catalogue/${catalogueId}`, stranger.headers)).statusCode).toBe(404);
  });

  it("creates and prices a production rate", async () => {
    const res = await post("/estimating/production-rates", {
      code: "PR-BLK",
      description: "Blockwork laying",
      unit: "m2",
      crewId,
      basis: "output_per_hour",
      value: 2.5,
    });
    expect(res.statusCode).toBe(201);
    const rateId = (res.json() as { id: string }).id;
    const list = await get("/estimating/production-rates?search=block");
    expect((list.json() as { total: number }).total).toBe(1);
    const patched = await patch(`/estimating/production-rates/${rateId}`, { value: 3 });
    expect((patched.json() as { value: number }).value).toBe(3);
    const retired = await del(`/estimating/production-rates/${rateId}`);
    expect((retired.json() as { status: string }).status).toBe("retired");
  });
});

describe("assemblies (#191, #193)", () => {
  it("creates an assembly and materializes its unit rate from the components", async () => {
    const res = await post("/estimating/assemblies", {
      code: "ASM-BLK-140",
      name: "140mm blockwork, built",
      unit: "m2",
      currency: "GBP",
      costCode: "04-2000",
      components: [
        { catalogueItemId: catalogueId, description: "Blockwork rate", quantityPer: 1 },
        { description: "Wall ties", unit: "no", costType: "material", quantityPer: 2.5, rates: { material: 0.4 } },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; unitRate: number; components: unknown[] };
    // 42.4 (catalogue) + 2.5 × 0.40
    expect(body.unitRate).toBe(43.4);
    expect(body.components).toHaveLength(2);
    assemblyId = body.id;
  });

  it("replaces the component set and re-prices the assembly", async () => {
    const res = await put(`/estimating/assemblies/${assemblyId}/components`, {
      components: [
        { catalogueItemId: catalogueId, description: "Blockwork rate", quantityPer: 1 },
        { description: "Wall ties", unit: "no", costType: "material", quantityPer: 3, rates: { material: 0.4 } },
        { description: "Scaffold", costType: "equipment", quantityPer: 1, rates: { equipment: 3.1 } },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { unitRate: number }).unitRate).toBe(46.7);
  });

  it("refreshes catalogue-backed rates and says which it could not", async () => {
    await patch(`/estimating/catalogue/${catalogueId}`, { rates: { labour: 26, material: 18.4 } });
    const res = await post(`/estimating/assemblies/${assemblyId}/refresh-rates`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      unitRate: number;
      refresh: { unitRateBefore: number; unitRateAfter: number; notRefreshed: string[]; reason: string };
    };
    expect(body.refresh.unitRateAfter).toBeGreaterThan(body.refresh.unitRateBefore);
    expect(body.refresh.notRefreshed).toEqual(["Wall ties", "Scaffold"]);
    expect(body.refresh.reason).toContain("typed rate with no catalogue item");
  });

  it("keeps a rival company out of the assemblies", async () => {
    expect((await get(`/estimating/assemblies/${assemblyId}`, stranger.headers)).statusCode).toBe(404);
    expect(
      (await put(`/estimating/assemblies/${assemblyId}/components`, { components: [] }, stranger.headers))
        .statusCode,
    ).toBe(404);
    expect((await get("/estimating/assemblies", stranger.headers)).json()).toMatchObject({ total: 0 });
  });

  it("retires an assembly", async () => {
    const created = await post("/estimating/assemblies", { code: "ASM-TMP", name: "Temp", unit: "ea" });
    const id = (created.json() as { id: string }).id;
    expect((await del(`/estimating/assemblies/${id}`)).statusCode).toBe(200);
    expect((await get(`/estimating/assemblies/${id}`)).json()).toMatchObject({ status: "retired" });
  });
});

/* ================================================================== */
/* Takeoff                                                             */
/* ================================================================== */

describe("takeoff (#184–190)", () => {
  let layerId: string;
  let areaTakeoffId: string;

  it("creates a colour-coded layer with a default cost code (#189–190)", async () => {
    const res = await post(`/projects/${projectA}/takeoff/layers`, {
      name: "External walls",
      colour: "#c2410c",
      measurementType: "area",
      unit: "m2",
      costCode: "04-2000",
    });
    expect(res.statusCode).toBe(201);
    layerId = (res.json() as { id: string }).id;
  });

  it("rejects a colour that is not #rrggbb", async () => {
    const res = await post(`/projects/${projectA}/takeoff/layers`, { name: "Bad", colour: "orange" });
    expect(res.statusCode).toBe(400);
  });

  it("calibrates a sheet from a known dimension (#188)", async () => {
    const res = await post(`/projects/${projectA}/takeoff/calibrate`, {
      mode: "reference",
      drawnLength: 250,
      realLength: 5,
      unit: "m",
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { pixelsPerUnit: number }).pixelsPerUnit).toBe(50);
  });

  it("calibrates from a printed ratio", async () => {
    const res = await post(`/projects/${projectA}/takeoff/calibrate`, {
      mode: "ratio",
      ratio: 50,
      unit: "m",
    });
    expect((res.json() as { pixelsPerUnit: number }).pixelsPerUnit).toBeCloseTo(20, 6);
  });

  it("refuses a degenerate calibration", async () => {
    const res = await post(`/projects/${projectA}/takeoff/calibrate`, {
      mode: "reference",
      drawnLength: 0,
      realLength: 5,
      unit: "m",
    });
    expect(res.statusCode).toBe(400);
  });

  it("measures without persisting", async () => {
    const res = await post(`/projects/${projectA}/takeoff/measure`, {
      measurementType: "area",
      geometry: {
        kind: "polygon",
        points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      },
      pixelsPerUnit: 10,
      scaleUnit: "m",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { quantity: number; unit: string; basis: string[] };
    expect(body.quantity).toBe(100);
    expect(body.unit).toBe("m2");
    expect(body.basis.join(" ")).toContain("÷ scale");
    const persisted = await app.db
      .select()
      .from(takeoffItems)
      .where(eq(takeoffItems.projectId, projectA));
    expect(persisted).toHaveLength(0);
  });

  it("stores a measured area with its geometry, scale and basis", async () => {
    const res = await post(`/projects/${projectA}/takeoff/items`, {
      layerId,
      name: "Gable wall",
      measurementType: "area",
      sheetNumber: "A-201",
      pixelsPerUnit: 10,
      scaleUnit: "m",
      scaleLabel: "1:100",
      geometry: {
        kind: "rectangle",
        points: [{ x: 0, y: 0 }, { x: 120, y: 80 }],
      },
      multiplier: 2,
      deduction: 6,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      quantity: number;
      rawValue: number;
      unit: string;
      costCode: string;
      colour: string;
      perimeter: number;
      measurement: { basis: string[] };
    };
    expect(body.rawValue).toBe(96); // 12m × 8m
    expect(body.quantity).toBe(186); // 96 × 2 − 6
    expect(body.unit).toBe("m2");
    expect(body.costCode).toBe("04-2000"); // inherited from the layer
    expect(body.colour).toBe("#c2410c");
    expect(body.perimeter).toBe(80);
    expect(body.measurement.basis.length).toBeGreaterThan(1);
    areaTakeoffId = body.id;
  });

  it("stores a count and a volume", async () => {
    const counted = await post(`/projects/${projectA}/takeoff/items`, {
      name: "Doors",
      measurementType: "count",
      geometry: { kind: "points", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] },
    });
    expect((counted.json() as { quantity: number; unit: string }).quantity).toBe(3);
    expect((counted.json() as { unit: string }).unit).toBe("ea");

    const volume = await post(`/projects/${projectA}/takeoff/items`, {
      name: "Slab",
      measurementType: "volume",
      pixelsPerUnit: 10,
      scaleUnit: "m",
      geometry: { kind: "rectangle", points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] },
      depth: 0.25,
    });
    expect((volume.json() as { quantity: number; unit: string }).quantity).toBe(25);
    expect((volume.json() as { unit: string }).unit).toBe("m3");
  });

  it("records the uncalibrated warning rather than pretending the units are metres", async () => {
    const res = await post(`/projects/${projectA}/takeoff/items`, {
      name: "Uncalibrated run",
      measurementType: "linear",
      geometry: { kind: "polyline", points: [{ x: 0, y: 0 }, { x: 250, y: 0 }] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { measurement: { warnings: string[] }; quantity: number };
    expect(body.quantity).toBe(250);
    expect(body.measurement.warnings.join(" ")).toMatch(/not calibrated/);
  });

  it("re-measures on patch and warns that priced lines still carry the old quantity", async () => {
    const estimateId = await makeEstimate("Takeoff-linked estimate");
    await post(`/projects/${projectA}/estimates/${estimateId}/lines/from-takeoff`, {
      takeoffItemIds: [areaTakeoffId],
      rates: { material: 10 },
    });
    const res = await patch(`/projects/${projectA}/takeoff/items/${areaTakeoffId}`, { multiplier: 3 });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { quantity: number; warnings: string[]; pricedOn: unknown[] };
    expect(body.quantity).toBe(282); // 96 × 3 − 6
    expect(body.pricedOn).toHaveLength(1);
    expect(body.warnings.join(" ")).toMatch(/still carry the OLD quantity/);
  });

  it("refuses to delete a takeoff that an estimate line cites", async () => {
    const res = await del(`/projects/${projectA}/takeoff/items/${areaTakeoffId}`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ message: expect.stringContaining("Void it instead") });
  });

  it("voids an unused takeoff", async () => {
    const created = await post(`/projects/${projectA}/takeoff/items`, {
      name: "Abandoned",
      measurementType: "count",
      manualRawValue: 4,
    });
    const id = (created.json() as { id: string }).id;
    const res = await del(`/projects/${projectA}/takeoff/items/${id}`);
    expect((res.json() as { status: string }).status).toBe("void");
  });

  it("lists the measurements nobody priced", async () => {
    const res = await get(`/projects/${projectA}/takeoff/items?unpricedOnly=true&pageSize=100`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ name: string }> };
    expect(body.items.map((i) => i.name)).toContain("Doors");
    expect(body.items.map((i) => i.name)).not.toContain("Gable wall");
  });

  it("refuses to delete a layer that still carries measurements", async () => {
    const res = await del(`/projects/${projectA}/takeoff/layers/${layerId}`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      message: expect.stringContaining("must not delete a measurement"),
    });
  });

  it("patches and deletes an empty layer", async () => {
    const created = await post(`/projects/${projectA}/takeoff/layers`, { name: "Spare" });
    const id = (created.json() as { id: string }).id;
    const patched = await patch(`/projects/${projectA}/takeoff/layers/${id}`, {
      name: "Spare (renamed)",
      visible: false,
    });
    expect((patched.json() as { name: string; visible: number }).name).toBe("Spare (renamed)");
    expect((patched.json() as { visible: number }).visible).toBe(0);
    expect((await del(`/projects/${projectA}/takeoff/layers/${id}`)).statusCode).toBe(200);
  });

  it("keeps a rival company out of the takeoff", async () => {
    expect((await get(`/projects/${projectA}/takeoff/items`, stranger.headers)).statusCode).toBe(403);
    expect(
      (await get(`/projects/${projectA}/takeoff/items/${areaTakeoffId}`, stranger.headers)).statusCode,
    ).toBe(403);
    expect(
      (await post(`/projects/${projectA}/takeoff/items`, { name: "x", measurementType: "count" }, stranger.headers))
        .statusCode,
    ).toBe(403);
    expect(
      (await patch(`/projects/${projectA}/takeoff/items/${areaTakeoffId}`, { name: "x" }, stranger.headers))
        .statusCode,
    ).toBe(403);
  });

  it("refuses to attach a takeoff to another project's estimate", async () => {
    const foreign = await makeEstimate("Project B estimate", projectB);
    const res = await post(`/projects/${projectA}/takeoff/items`, {
      name: "Cross-project",
      measurementType: "count",
      manualRawValue: 1,
      estimateId: foreign,
    });
    expect(res.statusCode).toBe(404);
  });
});

/* ================================================================== */
/* Estimates — lines, markups, sections, lifecycle                     */
/* ================================================================== */

describe("estimate workspace (#190, #198–199)", () => {
  let estimateId: string;
  let sectionId: string;

  it("creates an estimate that inherits the project currency", async () => {
    const res = await post(`/projects/${projectA}/estimates`, {
      name: "Substructure GMP",
      estimateType: "gmp",
      basis: "Design development, ±15%",
      accuracyRange: 0.15,
      quantityBasis: 4200,
      quantityBasisUnit: "m2",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; reference: string; currency: string; version: number; rootId: string };
    expect(body.reference).toMatch(/^EST-\d{3}$/);
    expect(body.currency).toBe("GBP");
    expect(body.version).toBe(1);
    expect(body.rootId).toBe(body.id);
    estimateId = body.id;
  });

  it("adds a section", async () => {
    const res = await post(`/projects/${projectA}/estimates/${estimateId}/sections`, {
      name: "Groundworks",
      code: "A",
      sortOrder: 1,
    });
    expect(res.statusCode).toBe(201);
    sectionId = (res.json() as { id: string }).id;
  });

  it("prices a line from a catalogue item, carrying the rate and its provenance", async () => {
    const res = await post(`/projects/${projectA}/estimates/${estimateId}/lines`, {
      description: "140mm blockwork to core",
      catalogueItemId: catalogueId,
      quantity: 412,
      wastePercent: 6,
      sectionId,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      quantity: number;
      unitRate: number;
      amount: number;
      source: string;
      costCode: string;
      basis: string[];
      estimateTotals: { directCostTotal: number };
    };
    expect(body.quantity).toBe(436.72); // 412 + 6%
    expect(body.unitRate).toBe(44.4); // labour 26 + material 18.40, exactly as the library says
    expect(body.amount).toBe(19390.37);
    // the catalogue item names a crew, but the rate is already priced, so the
    // crew is used for the hour count and NOT added on top
    expect(body.basis.join(" ")).toContain("Crew build-up NOT applied");
    expect(body.source).toBe("catalogue");
    expect(body.costCode).toBe("04-2000");
    expect(body.basis.join(" ")).toContain("Rate from catalogue item BLK-140");
    expect(body.estimateTotals.directCostTotal).toBe(19390.37);
  });

  it("builds the labour rate from a crew and a production rate (#194, #197)", async () => {
    const res = await post(`/projects/${projectA}/estimates/${estimateId}/lines`, {
      description: "Blockwork, crew build-up",
      unit: "m2",
      quantity: 100,
      costType: "labour",
      crewId,
      productionRate: 2.5,
      productionRateBasis: "output_per_hour",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      labourRate: number;
      equipmentRate: number;
      amount: number;
      labourHours: number;
      basis: string[];
    };
    // 0.4 h/m² × 89/hr labour, plus the gang's mixer at 0.4 h × 6.50
    expect(body.labourRate).toBe(35.6);
    expect(body.equipmentRate).toBe(2.6);
    expect(body.amount).toBe(3820);
    expect(body.labourHours).toBe(40);
    expect(body.basis.join(" ")).toContain("crew-hours per unit");
  });

  it("bulk-creates lines", async () => {
    const res = await post(`/projects/${projectA}/estimates/${estimateId}/lines/bulk`, {
      lines: [
        { description: "Sundries", unit: "item", quantity: 1, rates: { other: 950 } },
        { description: "Alternate finish", unit: "m2", quantity: 50, rates: { material: 30 }, status: "alternate" },
        { description: "Dewatering", unit: "item", quantity: 1, rates: { other: 4000 }, status: "excluded" },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { created: number }).created).toBe(3);
  });

  it("keeps alternates and exclusions out of the total but visible", async () => {
    const res = await get(`/projects/${projectA}/estimates/${estimateId}`);
    const body = res.json() as {
      directCostTotal: number;
      alternateTotal: number;
      excludedTotal: number;
      lineCount: number;
    };
    expect(body.alternateTotal).toBe(1500);
    expect(body.excludedTotal).toBe(4000);
    expect(body.lineCount).toBe(5);
    expect(body.directCostTotal).toBe(19390.37 + 3820 + 950);
  });

  it("applies a tiered markup cascade (#198–199)", async () => {
    const overhead = await post(`/projects/${projectA}/estimates/${estimateId}/markups`, {
      kind: "overhead",
      name: "Site overhead",
      method: "percent",
      basis: "direct_cost",
      rate: 8,
      sequence: 1,
    });
    expect(overhead.statusCode).toBe(201);
    const profit = await post(`/projects/${projectA}/estimates/${estimateId}/markups`, {
      kind: "profit",
      name: "Profit",
      method: "percent",
      basis: "running_total",
      rate: 5,
      sequence: 2,
      rationale: "Tendered margin",
    });
    expect(profit.statusCode).toBe(201);
    const body = profit.json() as { baseAmount: number; amount: number; estimateTotals: { total: number } };
    const direct = 19390.37 + 3820 + 950;
    const oh = Math.round(direct * 0.08 * 100) / 100;
    expect(body.baseAmount).toBeCloseTo(direct + oh, 2);
    expect(body.estimateTotals.total).toBeCloseTo(direct + oh + (direct + oh) * 0.05, 1);
  });

  it("narrows a markup to a cost type", async () => {
    const res = await post(`/projects/${projectA}/estimates/${estimateId}/markups`, {
      kind: "insurance",
      name: "Labour insurance",
      basis: "cost_type",
      costTypes: ["labour"],
      rate: 2,
      sequence: 3,
    });
    expect(res.statusCode).toBe(201);
    // the whole amount of every line typed as labour, plant included
    expect((res.json() as { baseAmount: number }).baseAmount).toBe(3820);
    expect((res.json() as { amount: number }).amount).toBe(76.4);
  });

  it("disables a markup without deleting the reasoning", async () => {
    const list = await get(`/projects/${projectA}/estimates/${estimateId}/markups`);
    const markup = (list.json() as { items: Array<{ id: string; name: string }> }).items.find(
      (m) => m.name === "Labour insurance",
    )!;
    const res = await patch(
      `/projects/${projectA}/estimates/${estimateId}/markups/${markup.id}`,
      { enabled: false },
    );
    expect(res.statusCode).toBe(200);
    expect((res.json() as { amount: number }).amount).toBe(0);
    const restored = await patch(
      `/projects/${projectA}/estimates/${estimateId}/markups/${markup.id}`,
      { enabled: true },
    );
    expect((restored.json() as { amount: number }).amount).toBe(76.4);
    const removed = await del(`/projects/${projectA}/estimates/${estimateId}/markups/${markup.id}`);
    expect(removed.statusCode).toBe(200);
  });

  it("expands an assembly onto the grid without double-counting the header (#191)", async () => {
    const target = await makeEstimate("Assembly estimate");
    const res = await post(`/projects/${projectA}/estimates/${target}/lines/from-assembly`, {
      assemblyId,
      quantity: 200,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { created: number; parentLineId: string; estimateTotals: { directCostTotal: number } };
    expect(body.created).toBe(4); // header + three components
    const lines = await get(`/projects/${projectA}/estimates/${target}/lines?pageSize=100`);
    const rows = (lines.json() as { items: Array<{ status: string; amount: number; assemblyParentLineId: string | null }> }).items;
    const header = rows.find((r) => r.assemblyParentLineId === null)!;
    expect(header.status).toBe("excluded");
    const componentSum = rows
      .filter((r) => r.assemblyParentLineId !== null)
      .reduce((s, r) => s + r.amount, 0);
    expect(body.estimateTotals.directCostTotal).toBeCloseTo(componentSum, 2);
  });

  it("prices a line from a takeoff and marks the measurement priced (#190)", async () => {
    const target = await makeEstimate("Takeoff pricing");
    const takeoff = await post(`/projects/${projectA}/takeoff/items`, {
      name: "Slab area",
      measurementType: "area",
      pixelsPerUnit: 10,
      scaleUnit: "m",
      geometry: { kind: "rectangle", points: [{ x: 0, y: 0 }, { x: 200, y: 100 }] },
    });
    const takeoffId = (takeoff.json() as { id: string }).id;
    const res = await post(`/projects/${projectA}/estimates/${target}/lines/from-takeoff`, {
      takeoffItemIds: [takeoffId, "tko_missing"],
      rates: { material: 12 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { created: number; warnings: string[]; estimateTotals: { directCostTotal: number } };
    expect(body.created).toBe(1);
    expect(body.estimateTotals.directCostTotal).toBe(2400); // 200 m² × 12
    expect(body.warnings.join(" ")).toMatch(/were not found/);
    const rows = await app.db.select().from(takeoffItems).where(eq(takeoffItems.id, takeoffId));
    expect(rows[0]?.status).toBe("priced");
  });

  it("patches a line without compounding the waste allowance", async () => {
    const target = await makeEstimate("Patch test");
    const line = await addLine(target, {
      description: "Waste check",
      unit: "m2",
      quantity: 100,
      wastePercent: 10,
      rates: { material: 5 },
    });
    expect(line.amount).toBe(550);
    const res = await patch(`/projects/${projectA}/estimates/${target}/lines/${line.id}`, {
      rates: { material: 6 },
    });
    expect((res.json() as { quantity: number; amount: number }).quantity).toBe(110);
    expect((res.json() as { amount: number }).amount).toBe(660);
  });

  it("deletes a line and re-rolls the header", async () => {
    const target = await makeEstimate("Delete test");
    const line = await addLine(target, { description: "Doomed", quantity: 1, rates: { other: 100 } });
    const res = await del(`/projects/${projectA}/estimates/${target}/lines/${line.id}`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { estimateTotals: { directCostTotal: number } }).estimateTotals.directCostTotal).toBe(0);
  });

  it("unparents rather than deletes lines when a section goes", async () => {
    const target = await makeEstimate("Section delete");
    const section = await post(`/projects/${projectA}/estimates/${target}/sections`, { name: "Temp" });
    const sid = (section.json() as { id: string }).id;
    await addLine(target, { description: "Kept", quantity: 1, rates: { other: 500 }, sectionId: sid });
    const res = await del(`/projects/${projectA}/estimates/${target}/sections/${sid}`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { linesUnparented: number }).linesUnparented).toBe(1);
    const after = await get(`/projects/${projectA}/estimates/${target}`);
    expect((after.json() as { directCostTotal: number }).directCostTotal).toBe(500);
  });

  it("patches a section", async () => {
    const res = await patch(
      `/projects/${projectA}/estimates/${estimateId}/sections/${sectionId}`,
      { name: "Groundworks & substructure" },
    );
    expect((res.json() as { name: string }).name).toBe("Groundworks & substructure");
  });

  it("refuses to change the currency once lines are priced", async () => {
    const res = await patch(`/projects/${projectA}/estimates/${estimateId}`, { currency: "USD" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      message: expect.stringContaining("would reinterpret every one of them"),
    });
  });

  it("recalculates on demand", async () => {
    const res = await post(`/projects/${projectA}/estimates/${estimateId}/recalculate`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { recompute: { lineCount: number } }).recompute.lineCount).toBe(5);
  });

  it("keeps a rival company out of every estimate route", async () => {
    expect((await get(`/projects/${projectA}/estimates`, stranger.headers)).statusCode).toBe(403);
    expect(
      (await get(`/projects/${projectA}/estimates/${estimateId}`, stranger.headers)).statusCode,
    ).toBe(403);
    expect(
      (await post(`/projects/${projectA}/estimates`, { name: "hijack" }, stranger.headers)).statusCode,
    ).toBe(403);
    expect(
      (await post(
        `/projects/${projectA}/estimates/${estimateId}/lines`,
        { description: "hijack", quantity: 1, rates: { other: 1 } },
        stranger.headers,
      )).statusCode,
    ).toBe(403);
    expect(
      (await del(`/projects/${projectA}/estimates/${estimateId}`, stranger.headers)).statusCode,
    ).toBe(403);
  });

  it("refuses to reach an estimate through the wrong project", async () => {
    const res = await get(`/projects/${projectB}/estimates/${estimateId}`);
    expect(res.statusCode).toBe(404);
  });
});

describe("estimate lifecycle and versions (#200–201)", () => {
  let estimateId: string;

  it("refuses to submit an estimate with no lines", async () => {
    const empty = await makeEstimate("Empty");
    const res = await post(`/projects/${projectA}/estimates/${empty}/submit`);
    expect(res.statusCode).toBe(400);
  });

  it("submits an estimate for review", async () => {
    estimateId = await makeEstimate("Lifecycle estimate");
    await addLine(estimateId, { description: "Works", unit: "m2", quantity: 100, rates: { material: 40 } });
    const res = await post(`/projects/${projectA}/estimates/${estimateId}/submit`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("in_review");
  });

  it("refuses approval by the person who prepared it (segregation of duties)", async () => {
    const res = await post(`/projects/${projectA}/estimates/${estimateId}/approve`);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      message: expect.stringContaining("cannot be approved by the person who prepared it"),
    });
  });

  it("reverts to draft and clears the approval when the content changes under review", async () => {
    const line = await addLine(estimateId, {
      description: "Late addition",
      quantity: 1,
      rates: { other: 500 },
    });
    expect(line.amount).toBe(500);
    const after = await get(`/projects/${projectA}/estimates/${estimateId}`);
    expect((after.json() as { status: string }).status).toBe("draft");
  });

  it("lets a second person approve, which locks the estimate", async () => {
    await approve(estimateId);
    const res = await get(`/projects/${projectA}/estimates/${estimateId}`);
    const body = res.json() as { status: string; approvedBy: string; lockedAt: string | null };
    expect(body.status).toBe("approved");
    expect(body.approvedBy).toBe(approver.userId);
    expect(body.lockedAt).not.toBeNull();
    const notes = await app.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, owner.userId), eq(notifications.kind, "estimate")));
    expect(notes.some((n) => n.title.includes("approved"))).toBe(true);
  });

  it("refuses to edit an approved estimate", async () => {
    const res = await post(`/projects/${projectA}/estimates/${estimateId}/lines`, {
      description: "Sneaky",
      quantity: 1,
      rates: { other: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ message: expect.stringContaining("Cut a new version") });
  });

  it("sends an estimate back with a reason", async () => {
    const target = await makeEstimate("Rejection test");
    await addLine(target, { description: "Works", quantity: 1, rates: { other: 100 } });
    await post(`/projects/${projectA}/estimates/${target}/submit`);
    const own = await post(`/projects/${projectA}/estimates/${target}/reject`, { reason: "self" });
    expect(own.statusCode).toBe(403);
    const res = await post(
      `/projects/${projectA}/estimates/${target}/reject`,
      { reason: "The blockwork rate is out of date." },
      approverHeaders,
    );
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("draft");
  });

  it("withdraws an estimate from review", async () => {
    const target = await makeEstimate("Withdraw test");
    await addLine(target, { description: "Works", quantity: 1, rates: { other: 100 } });
    await post(`/projects/${projectA}/estimates/${target}/submit`);
    const res = await post(`/projects/${projectA}/estimates/${target}/withdraw`);
    expect((res.json() as { status: string }).status).toBe("draft");
  });

  it("cuts a new version that carries the lines, the markups and the lineage", async () => {
    const res = await post(`/projects/${projectA}/estimates/${estimateId}/versions`, {
      notes: "Rev B — rates refreshed",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; version: number; rootId: string; status: string; lineCount: number };
    expect(body.version).toBe(2);
    expect(body.status).toBe("draft");
    expect(body.lineCount).toBe(2);
    const parent = await get(`/projects/${projectA}/estimates/${estimateId}`);
    expect((parent.json() as { status: string }).status).toBe("superseded");

    const chain = await get(`/projects/${projectA}/estimates/${body.id}/versions`);
    expect((chain.json() as { items: unknown[] }).items).toHaveLength(2);

    const compare = await get(
      `/projects/${projectA}/estimates/${body.id}/compare?against=${estimateId}&includeUnchanged=true`,
    );
    expect(compare.statusCode).toBe(200);
    const diff = compare.json() as {
      rows: Array<{ matchedOn: string; change: string }>;
      totals: { totalDelta: number };
    };
    expect(diff.rows).toHaveLength(2);
    expect(diff.rows.every((r) => r.matchedOn === "lineage")).toBe(true);
    expect(diff.totals.totalDelta).toBe(0);
  });

  it("attributes a later version's movement to quantity and to rate", async () => {
    const chain = await get(`/projects/${projectA}/estimates/${estimateId}/versions`);
    const head = (chain.json() as { items: Array<{ id: string; version: number }> }).items.find(
      (i) => i.version === 2,
    )!;
    const lines = await get(`/projects/${projectA}/estimates/${head.id}/lines?pageSize=100`);
    const target = (lines.json() as { items: Array<{ id: string; description: string }> }).items.find(
      (l) => l.description === "Works",
    )!;
    await patch(`/projects/${projectA}/estimates/${head.id}/lines/${target.id}`, {
      quantity: 120,
      rates: { material: 45 },
    });
    const compare = await get(
      `/projects/${projectA}/estimates/${head.id}/compare?against=${estimateId}`,
    );
    const diff = compare.json() as {
      rows: Array<{ change: string; quantityEffect: number; rateEffect: number }>;
      totals: { quantityEffectTotal: number; rateEffectTotal: number; directCostDelta: number };
    };
    expect(diff.rows[0]?.change).toBe("quantity_and_rate");
    expect(diff.rows[0]?.quantityEffect).toBe(800); // 20 more at 40
    expect(diff.rows[0]?.rateEffect).toBe(600); // 5 more on 120
    expect(diff.totals.directCostDelta).toBe(1400);
  });

  it("refuses to branch from a superseded version", async () => {
    const res = await post(`/projects/${projectA}/estimates/${estimateId}/versions`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ message: expect.stringContaining("already been superseded") });
  });

  it("locks and unlocks, clearing the approval on the way out", async () => {
    const target = await makeEstimate("Lock test");
    await addLine(target, { description: "Works", quantity: 1, rates: { other: 100 } });
    const locked = await post(`/projects/${projectA}/estimates/${target}/lock`);
    expect((locked.json() as { lockedAt: string | null }).lockedAt).not.toBeNull();
    expect((await post(`/projects/${projectA}/estimates/${target}/lock`)).statusCode).toBe(409);
    const unlocked = await post(`/projects/${projectA}/estimates/${target}/unlock`);
    expect(unlocked.statusCode).toBe(200);
    expect((unlocked.json() as { lockedAt: string | null }).lockedAt).toBeNull();
  });

  it("voids a draft estimate but refuses to void anything else", async () => {
    const target = await makeEstimate("Void test");
    expect((await del(`/projects/${projectA}/estimates/${target}`)).statusCode).toBe(200);
    expect((await del(`/projects/${projectA}/estimates/${target}`)).statusCode).toBe(409);
  });

  it("warns when two estimates in different currencies are compared", async () => {
    const gbp = await makeEstimate("GBP estimate");
    await addLine(gbp, { description: "Works", quantity: 1, rates: { other: 100 } });
    const usdRes = await post(`/projects/${projectA}/estimates`, { name: "USD estimate", currency: "USD" });
    const usd = (usdRes.json() as { id: string }).id;
    await addLine(usd, { description: "Works", quantity: 1, rates: { other: 100 } });
    const res = await get(`/projects/${projectA}/estimates/${usd}/compare?against=${gbp}`);
    expect(res.statusCode).toBe(200);
    const warnings = (res.json() as { warnings: string[] }).warnings.join(" ");
    expect(warnings).toMatch(/two different currencies/);
    expect(warnings).toMatch(/not versions of one another/);
  });
});

/* ================================================================== */
/* Sub-quotes and levelling (#202–203)                                 */
/* ================================================================== */

describe("sub-quotes", () => {
  let vendorA: string;
  let vendorB: string;
  let quoteA: string;
  let quoteB: string;

  async function makeVendor(name: string, companyId = owner.companyId): Promise<string> {
    const id = newId("vnd");
    await app.db.insert(vendors).values({ id, companyId, name });
    return id;
  }

  it("records a quote with its priced lines and derives the total", async () => {
    vendorA = await makeVendor("Alpha Groundworks");
    const res = await post(`/projects/${projectA}/estimating/sub-quotes`, {
      vendorId: vendorA,
      vendorName: "Alpha Groundworks",
      tradePackage: "Groundworks",
      currency: "GBP",
      quoteDate: shiftDays(-3),
      validUntil: shiftDays(30),
      lines: [
        { description: "Bulk excavation", unit: "m3", quantity: 800, unitRate: 12.5 },
        { description: "Disposal", unit: "m3", quantity: 800, unitRate: 5 },
        { description: "Piling mat", amount: 3000 },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; reference: string; quotedTotal: number; lineCount: number };
    expect(body.reference).toMatch(/^SQ-\d{3}$/);
    expect(body.quotedTotal).toBe(17000);
    expect(body.lineCount).toBe(3);
    quoteA = body.id;
  });

  it("keeps the stated header total when one is given", async () => {
    vendorB = await makeVendor("Beta Civils");
    const res = await post(`/projects/${projectA}/estimating/sub-quotes`, {
      vendorId: vendorB,
      vendorName: "Beta Civils",
      tradePackage: "Groundworks",
      currency: "GBP",
      quotedTotal: 18000,
      adjustmentAmount: 500,
      validUntil: shiftDays(45),
      lines: [
        { description: "Bulk excavation", unit: "m3", quantity: 800, unitRate: 13 },
        { description: "Disposal", unit: "m3", quantity: 800, unitRate: 5.4 },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; quotedTotal: number; levelledTotal: number };
    expect(body.quotedTotal).toBe(18000);
    expect(body.levelledTotal).toBe(18500);
    quoteB = body.id;
  });

  it("levels the package: spread, gaps and comparable totals", async () => {
    const res = await get(
      `/projects/${projectA}/estimating/sub-quotes/levelling?tradePackage=Groundworks`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rows: Array<{ scopeKey: string; pricedCount: number; missingVendors: string[]; median: number | null }>;
      totals: Array<{ vendorName: string; comparableTotal: number | null; missingRows: number }>;
      scopeGaps: Array<{ scopeKey: string }>;
      currency: string | null;
    };
    expect(body.currency).toBe("GBP");
    expect(body.rows).toHaveLength(3);
    expect(body.scopeGaps.map((g) => g.scopeKey)).toContain("piling mat");
    const beta = body.totals.find((t) => t.vendorName === "Beta Civils")!;
    expect(beta.missingRows).toBe(1);
    expect(beta.comparableTotal).toBe(21500); // 18500 levelled + the 3000 gap
  });

  it("says nothing rather than guessing when no quotes match", async () => {
    const res = await get(
      `/projects/${projectA}/estimating/sub-quotes/levelling?tradePackage=Roofing`,
    );
    expect((res.json() as { rows: unknown[]; warnings: string[] }).rows).toHaveLength(0);
    expect((res.json() as { warnings: string[] }).warnings.join(" ")).toMatch(/nothing to level/);
  });

  it("accepts a quote onto an estimate and marks it accepted (#202)", async () => {
    const target = await makeEstimate("Quote acceptance");
    const res = await post(
      `/projects/${projectA}/estimating/sub-quotes/${quoteA}/accept`,
      { estimateId: target },
    );
    expect(res.statusCode).toBe(201);
    const body = res.json() as { created: number; estimateTotals: { directCostTotal: number } };
    expect(body.created).toBe(3);
    expect(body.estimateTotals.directCostTotal).toBe(17000);
    const quote = await get(`/projects/${projectA}/estimating/sub-quotes/${quoteA}`);
    expect((quote.json() as { status: string; acceptedBy: string }).status).toBe("accepted");
    const lines = await get(`/projects/${projectA}/estimates/${target}/lines?source=sub_quote`);
    expect((lines.json() as { total: number }).total).toBe(3);
  });

  it("refuses to rewrite the lines of an accepted quote", async () => {
    const res = await put(`/projects/${projectA}/estimating/sub-quotes/${quoteA}/lines`, {
      lines: [{ description: "Rewritten", amount: 1 }],
    });
    expect(res.statusCode).toBe(409);
  });

  it("refuses to accept a quote that is out of validity", async () => {
    const target = await makeEstimate("Expired quote target");
    const expired = await post(`/projects/${projectA}/estimating/sub-quotes`, {
      vendorName: "Late Ltd",
      tradePackage: "Roofing",
      quotedTotal: 5000,
      validUntil: shiftDays(-5),
      lines: [{ description: "Roofing", amount: 5000 }],
    });
    const id = (expired.json() as { id: string }).id;
    await app.db
      .update(estimateSubQuotes)
      .set({ status: "expired" })
      .where(eq(estimateSubQuotes.id, id));
    const res = await post(`/projects/${projectA}/estimating/sub-quotes/${id}/accept`, {
      estimateId: target,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ message: expect.stringContaining("out of validity") });
  });

  it("imports a bid submission as a sub-quote and flags a header/line mismatch (#203)", async () => {
    const vendorC = await makeVendor("Gamma Bidders");
    const submissionId = newId("bsub");
    await app.db.insert(bidSubmissions).values({
      id: submissionId,
      companyId: owner.companyId,
      projectId: projectA,
      packageId: "pkg_groundworks",
      vendorId: vendorC,
      reference: "BID-011",
      status: "submitted",
      totalAmount: 19500,
      currency: "GBP",
      exclusions: "Rock excavation excluded",
      validUntil: shiftDays(60),
      createdBy: owner.userId,
    });
    await app.db.insert(bidSubmissionLines).values([
      {
        id: newId("bsl"),
        companyId: owner.companyId,
        projectId: projectA,
        submissionId,
        packageId: "pkg_groundworks",
        vendorId: vendorC,
        position: 0,
        description: "Bulk excavation",
        unit: "m3",
        quantity: 800,
        unitRate: 14,
        amount: 11200,
        currency: "GBP",
      },
      {
        id: newId("bsl"),
        companyId: owner.companyId,
        projectId: projectA,
        submissionId,
        packageId: "pkg_groundworks",
        vendorId: vendorC,
        position: 1,
        description: "Disposal",
        unit: "m3",
        quantity: 800,
        unitRate: 6,
        amount: 4800,
        currency: "GBP",
      },
    ]);
    const res = await post(`/projects/${projectA}/estimating/sub-quotes/import-bid`, {
      submissionId,
      tradePackage: "Groundworks",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      vendorName: string;
      quotedTotal: number;
      lines: unknown[];
      warnings: string[];
    };
    expect(body.vendorName).toBe("Gamma Bidders");
    expect(body.quotedTotal).toBe(19500);
    expect(body.lines).toHaveLength(2);
    expect(body.warnings.join(" ")).toMatch(/differ by 3500/);

    const again = await post(`/projects/${projectA}/estimating/sub-quotes/import-bid`, { submissionId });
    expect(again.statusCode).toBe(409);
  });

  it("refuses to import a bid submission from another project", async () => {
    const res = await post(`/projects/${projectB}/estimating/sub-quotes/import-bid`, {
      submissionId: "bsub_missing",
    });
    expect(res.statusCode).toBe(404);
  });

  it("withdraws a quote and closes its validity signals", async () => {
    const created = await post(`/projects/${projectA}/estimating/sub-quotes`, {
      vendorName: "Withdrawn Ltd",
      tradePackage: "Cladding",
      quotedTotal: 100,
    });
    const id = (created.json() as { id: string }).id;
    const res = await del(`/projects/${projectA}/estimating/sub-quotes/${id}`);
    expect((res.json() as { status: string }).status).toBe("withdrawn");
  });

  it("patches a quote and re-levels its total", async () => {
    const res = await patch(`/projects/${projectA}/estimating/sub-quotes/${quoteB}`, {
      adjustmentAmount: 900,
    });
    expect((res.json() as { levelledTotal: number }).levelledTotal).toBe(18900);
  });

  it("keeps a rival company out of the quotes", async () => {
    expect(
      (await get(`/projects/${projectA}/estimating/sub-quotes`, stranger.headers)).statusCode,
    ).toBe(403);
    expect(
      (await get(`/projects/${projectA}/estimating/sub-quotes/${quoteA}`, stranger.headers)).statusCode,
    ).toBe(403);
    expect(
      (await post(
        `/projects/${projectA}/estimating/sub-quotes`,
        { vendorName: "x", tradePackage: "y" },
        stranger.headers,
      )).statusCode,
    ).toBe(403);
    expect(
      (await get(`/projects/${projectA}/estimating/sub-quotes/levelling`, stranger.headers)).statusCode,
    ).toBe(403);
  });
});

/* ================================================================== */
/* Conversion, proposals, export, reference data                       */
/* ================================================================== */

describe("estimate → budget (#204)", () => {
  let estimateId: string;

  beforeAll(async () => {
    estimateId = await makeEstimate("Conversion estimate");
    await addLine(estimateId, {
      description: "Blockwork",
      costCode: "04-2000",
      costType: "material",
      unit: "m2",
      quantity: 100,
      rates: { material: 40 },
    });
    await addLine(estimateId, {
      description: "Blockwork, upper floors",
      costCode: "04-2000",
      costType: "material",
      unit: "m2",
      quantity: 60,
      rates: { material: 40 },
    });
    await addLine(estimateId, {
      description: "Uncoded sundries",
      unit: "item",
      quantity: 1,
      rates: { other: 1200 },
    });
    await post(`/projects/${projectA}/estimates/${estimateId}/markups`, {
      kind: "overhead",
      name: "Overhead",
      rate: 10,
      basis: "direct_cost",
      sequence: 1,
    });
  });

  it("refuses to convert an estimate nobody approved", async () => {
    const res = await post(`/projects/${projectA}/estimates/${estimateId}/convert-to-budget`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      message: expect.stringContaining("may not rest on a number nobody signed"),
    });
  });

  it("previews the conversion without writing anything", async () => {
    const res = await post(`/projects/${projectA}/estimates/${estimateId}/convert-to-budget`, {
      dryRun: true,
      uncodedCostCode: "ZZ-TBC",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      dryRun: boolean;
      plan: Array<{ costCode: string; originalBudget: number; sourceLineIds: string[] }>;
      totals: { estimateTotal: number; budgetTotal: number; reconciles: boolean };
      warnings: string[];
    };
    expect(body.dryRun).toBe(true);
    const merged = body.plan.find((l) => l.costCode === "04-2000")!;
    expect(merged.originalBudget).toBe(6400);
    expect(merged.sourceLineIds).toHaveLength(2);
    expect(body.plan.some((l) => l.costCode === "ZZ-TBC")).toBe(true);
    expect(body.plan.some((l) => l.costCode === "MARKUP-OVERHEAD")).toBe(true);
    expect(body.totals.reconciles).toBe(true);
    expect(body.warnings.join(" ")).toMatch(/holding code "ZZ-TBC"/);
    const written = await app.db.select().from(budgets).where(eq(budgets.projectId, projectA));
    expect(written).toHaveLength(0);
  });

  it("writes the budget, its lines and both ledger entries in one go", async () => {
    await approve(estimateId);
    const res = await post(`/projects/${projectA}/estimates/${estimateId}/convert-to-budget`, {
      makeActive: true,
      uncodedCostCode: "ZZ-TBC",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      budgetId: string;
      budgetReference: string;
      lines: number;
      totals: { budgetTotal: number; estimateTotal: number; reconciles: boolean };
    };
    expect(body.lines).toBe(3);
    expect(body.totals.reconciles).toBe(true);
    expect(body.totals.budgetTotal).toBe(8360); // 7600 direct + 760 overhead

    const budgetRows = await app.db.select().from(budgets).where(eq(budgets.id, body.budgetId));
    expect(budgetRows[0]?.isActive).toBe(1);
    expect(budgetRows[0]?.currency).toBe("GBP");
    expect(budgetRows[0]?.originalBudgetTotal).toBe(8360);
    const lineRows = await app.db
      .select()
      .from(budgetLineItems)
      .where(eq(budgetLineItems.budgetId, body.budgetId));
    expect(lineRows).toHaveLength(3);
    expect(lineRows.find((l) => l.costCode === "04-2000")?.quantity).toBe(160);
    expect(lineRows.find((l) => l.costCode === "MARKUP-OVERHEAD")?.lineKind).toBe("markup");

    const estimateRows = await app.db.select().from(estimates).where(eq(estimates.id, estimateId));
    expect(estimateRows[0]?.status).toBe("converted");
    expect(estimateRows[0]?.convertedBudgetId).toBe(body.budgetId);

    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.companyId, owner.companyId));
    expect(entries.some((e) => e.objectType === "budget" && e.objectId === body.budgetId)).toBe(true);
    expect(
      entries.some((e) => e.objectType === "estimate" && e.objectId === estimateId && e.action === "state_change"),
    ).toBe(true);
  });

  it("refuses to convert the same estimate twice", async () => {
    const res = await post(`/projects/${projectA}/estimates/${estimateId}/convert-to-budget`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ message: expect.stringContaining("already been converted") });
  });

  it("refuses to unlock a converted estimate", async () => {
    const res = await post(`/projects/${projectA}/estimates/${estimateId}/unlock`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ message: expect.stringContaining("diverge silently") });
  });

  it("spreads markups pro rata when asked", async () => {
    const target = await makeEstimate("Prorate conversion");
    await addLine(target, {
      description: "Works",
      costCode: "02-1000",
      unit: "m2",
      quantity: 100,
      rates: { material: 30 },
    });
    await post(`/projects/${projectA}/estimates/${target}/markups`, {
      kind: "profit",
      name: "Profit",
      rate: 10,
      basis: "direct_cost",
    });
    await approve(target);
    const res = await post(`/projects/${projectA}/estimates/${target}/convert-to-budget`, {
      markupTreatment: "prorate",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { lines: number; totals: { budgetTotal: number }; warnings: string[] };
    expect(body.lines).toBe(1);
    expect(body.totals.budgetTotal).toBe(3300);
    expect(body.warnings.join(" ")).toMatch(/spread across the budget lines/);
  });

  it("says how big the funding gap is when markups are excluded", async () => {
    const target = await makeEstimate("Exclude conversion");
    await addLine(target, {
      description: "Works",
      costCode: "02-2000",
      quantity: 1,
      rates: { other: 1000 },
    });
    await post(`/projects/${projectA}/estimates/${target}/markups`, {
      kind: "contingency",
      name: "Contingency",
      rate: 20,
      basis: "direct_cost",
    });
    await approve(target);
    const res = await post(`/projects/${projectA}/estimates/${target}/convert-to-budget`, {
      markupTreatment: "exclude",
    });
    const body = res.json() as { totals: { reconciles: boolean }; warnings: string[] };
    expect(body.totals.reconciles).toBe(false);
    expect(body.warnings.join(" ")).toMatch(/has to be funded somewhere/);
    expect(body.warnings[0]).toMatch(/do not convert until it is understood/);
  });

  it("keeps a rival company out of the conversion", async () => {
    const res = await post(
      `/projects/${projectA}/estimates/${estimateId}/convert-to-budget`,
      { dryRun: true },
      stranger.headers,
    );
    expect(res.statusCode).toBe(403);
  });
});

describe("change-order estimating (#208)", () => {
  it("pushes a priced estimate onto a change event and ledgers the before/after", async () => {
    const eventId = newId("cev");
    await app.db.insert(changeEvents).values({
      id: eventId,
      companyId: owner.companyId,
      projectId: projectA,
      number: 1,
      reference: "CE-001",
      title: "Additional piling",
      createdBy: owner.userId,
    });
    const estimateId = await makeEstimate("Change order estimate");
    await addLine(estimateId, { description: "Extra piles", quantity: 12, rates: { subcontract: 950 } });
    const res = await post(`/projects/${projectA}/estimates/${estimateId}/push-to-change-event`, {
      changeEventId: eventId,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pushed: number; warnings: string[] };
    expect(body.pushed).toBe(11400);
    expect(body.warnings.join(" ")).toMatch(/still a draft/);
    const rows = await app.db.select().from(changeEvents).where(eq(changeEvents.id, eventId));
    expect(rows[0]?.estimatedCost).toBe(11400);
    expect(rows[0]?.latestCost).toBe(11400);
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.objectId, eventId));
    expect(entries.length).toBeGreaterThan(0);
  });

  it("refuses a change event that is not on this project", async () => {
    const estimateId = await makeEstimate("Bad push");
    await addLine(estimateId, { description: "x", quantity: 1, rates: { other: 1 } });
    const res = await post(`/projects/${projectA}/estimates/${estimateId}/push-to-change-event`, {
      changeEventId: "cev_missing",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("proposals (#205) and export (#206)", () => {
  let estimateId: string;
  let proposalId: string;

  beforeAll(async () => {
    estimateId = await makeEstimate("Proposal estimate");
    const section = await post(`/projects/${projectA}/estimates/${estimateId}/sections`, {
      name: "Groundworks",
      code: "A",
      sortOrder: 1,
    });
    const sectionId = (section.json() as { id: string }).id;
    await addLine(estimateId, {
      description: "Bulk excavation",
      itemCode: "A1",
      unit: "m3",
      quantity: 400,
      rates: { equipment: 15 },
      sectionId,
    });
    await addLine(estimateId, {
      description: "Ground gas membrane",
      unit: "m2",
      quantity: 300,
      rates: { material: 12 },
      status: "alternate",
    });
    await post(`/projects/${projectA}/estimates/${estimateId}/markups`, {
      kind: "overhead",
      name: "Overhead and profit",
      rate: 15,
      basis: "direct_cost",
    });
  });

  it("previews a proposal without persisting it", async () => {
    const res = await get(
      `/projects/${projectA}/estimates/${estimateId}/proposal-preview?detailLevel=summary`,
    );
    expect(res.statusCode).toBe(200);
    const doc = res.json() as {
      sections: Array<{ name: string }>;
      totals: { total: number };
      notes: string[];
    };
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0]?.name).toBe("Works as described");
    expect(doc.totals.total).toBe(6900); // 6000 + 15%
    expect(doc.notes.join(" ")).toMatch(/lump sum/);
  });

  it("freezes a proposal document at generation time", async () => {
    const res = await post(`/projects/${projectA}/estimates/${estimateId}/proposals`, {
      title: "Substructure works",
      clientName: "Northgate Developments",
      detailLevel: "line",
      validUntil: shiftDays(30),
      coveringNote: "Thank you for the enquiry.",
      exclusions: "Statutory undertakers' charges",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; reference: string; total: number; document: { totals: { total: number } } };
    expect(body.reference).toMatch(/^PRO-\d{3}$/);
    expect(body.total).toBe(6900);
    proposalId = body.id;

    // move the estimate on; the frozen document must not follow
    const lines = await get(`/projects/${projectA}/estimates/${estimateId}/lines?pageSize=100`);
    const first = (lines.json() as { items: Array<{ id: string }> }).items[0]!;
    await patch(`/projects/${projectA}/estimates/${estimateId}/lines/${first.id}`, {
      rates: { equipment: 30 },
    });
    const after = await get(`/projects/${projectA}/estimating/proposals/${proposalId}`);
    expect((after.json() as { total: number }).total).toBe(6900);
  });

  it("renders the proposal as printable HTML with everything escaped", async () => {
    const res = await get(`/projects/${projectA}/estimating/proposals/${proposalId}/html`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body.startsWith("<!doctype html>")).toBe(true);
    expect(res.body).toContain("Substructure works");
    expect(res.body).toContain("Bulk excavation");
    expect(res.body).toContain("Statutory undertakers&#39; charges");
    expect(res.body).toContain("GBP 6,900.00");
  });

  it("issues a proposal and refuses a no-op transition", async () => {
    const res = await post(`/projects/${projectA}/estimating/proposals/${proposalId}/status`, {
      status: "issued",
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { issuedBy: string }).issuedBy).toBe(owner.userId);
    const again = await post(`/projects/${projectA}/estimating/proposals/${proposalId}/status`, {
      status: "issued",
    });
    expect(again.statusCode).toBe(409);
  });

  it("lists proposals for the project", async () => {
    const res = await get(`/projects/${projectA}/estimating/proposals?status=issued`);
    expect((res.json() as { total: number }).total).toBe(1);
  });

  it("exports the estimate as CSV with its markups and total", async () => {
    const res = await get(`/projects/${projectA}/estimates/${estimateId}/export.csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(String(res.headers["content-disposition"])).toContain("attachment");
    const lines = res.body.split("\r\n");
    expect(lines[0]).toContain("Description");
    expect(res.body).toContain("Bulk excavation");
    expect(res.body).toContain("Overhead and profit (overhead)");
    expect(lines[lines.length - 1]).toContain("TOTAL");
  });

  it("keeps a rival company out of the proposals", async () => {
    expect(
      (await get(`/projects/${projectA}/estimating/proposals/${proposalId}`, stranger.headers)).statusCode,
    ).toBe(403);
    expect(
      (await get(`/projects/${projectA}/estimating/proposals/${proposalId}/html`, stranger.headers))
        .statusCode,
    ).toBe(403);
    expect(
      (await get(`/projects/${projectA}/estimates/${estimateId}/export.csv`, stranger.headers)).statusCode,
    ).toBe(403);
  });
});

describe("historical cost reference (#207)", () => {
  it("bucketes past rates by currency and unit, with the sample count", async () => {
    const res = await get(`/projects/${projectA}/estimating/historical-rates?costCode=04-2000`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      distributions: Array<{ currency: string; unit: string; n: number; median: number | null; basis: string }>;
      samples: unknown[];
    };
    expect(body.distributions.length).toBeGreaterThan(0);
    const gbp = body.distributions.find((d) => d.currency === "GBP" && d.unit === "m2")!;
    expect(gbp.n).toBeGreaterThan(0);
    expect(gbp.median).not.toBeNull();
    expect(gbp.basis).toContain("approved or converted estimates");
  });

  it("says the record is empty rather than reporting a rate of zero", async () => {
    const res = await get(`/projects/${projectA}/estimating/historical-rates?costCode=99-NOTHING`);
    const body = res.json() as { distributions: unknown[]; reasons: string[] };
    expect(body.distributions).toHaveLength(0);
    expect(body.reasons.join(" ")).toMatch(/gap in our records, not a rate of zero/);
  });

  it("needs a filter to look anything up", async () => {
    const res = await get(`/projects/${projectA}/estimating/historical-rates`);
    expect(res.statusCode).toBe(400);
  });
});

/* ================================================================== */
/* Sweeps, summary, health inputs                                       */
/* ================================================================== */

describe("scheduler sweeps", () => {
  it("registers both jobs", () => {
    const names = app.scheduler.list().map((j) => j.name);
    expect(names).toContain("estimating.quote-validity");
    expect(names).toContain("estimating.hygiene");
  });

  it("expires a lapsed quote, raises one signal, and does not raise it twice", async () => {
    const created = await post(`/projects/${projectB}/estimating/sub-quotes`, {
      vendorName: "Lapsed Ltd",
      tradePackage: "Cladding",
      quotedTotal: 12000,
      validUntil: shiftDays(-2),
      lines: [{ description: "Cladding", amount: 12000 }],
    });
    const quoteId = (created.json() as { id: string }).id;

    const first = await app.scheduler.runNow("estimating.quote-validity");
    expect(first.state).toBe("succeeded");
    const rows = await app.db
      .select()
      .from(estimateSubQuotes)
      .where(eq(estimateSubQuotes.id, quoteId));
    expect(rows[0]?.status).toBe("expired");

    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "sub_quote_expired")),
      );
    expect(raised.filter((s) => s.evidenceRefs && (s.evidenceRefs as { key?: string }).key === quoteId)).toHaveLength(1);

    await app.scheduler.runNow("estimating.quote-validity");
    const after = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "sub_quote_expired")),
      );
    expect(after.length).toBe(raised.length);

    const notes = await app.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, owner.userId), eq(notifications.recordId, quoteId)));
    expect(notes.length).toBeGreaterThan(0);
  });

  it("warns a week ahead of a quote lapsing", async () => {
    const created = await post(`/projects/${projectB}/estimating/sub-quotes`, {
      vendorName: "Nearly Ltd",
      tradePackage: "Roofing",
      quotedTotal: 4000,
      validUntil: shiftDays(3),
    });
    const quoteId = (created.json() as { id: string }).id;
    await app.scheduler.runNow("estimating.quote-validity");
    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "sub_quote_expiring")),
      );
    expect(
      raised.some((s) => (s.evidenceRefs as { key?: string } | null)?.key === quoteId),
    ).toBe(true);
  });

  it("closes the warning once the quote is re-dated", async () => {
    const created = await post(`/projects/${projectB}/estimating/sub-quotes`, {
      vendorName: "Extended Ltd",
      tradePackage: "M&E",
      quotedTotal: 9000,
      validUntil: shiftDays(2),
    });
    const quoteId = (created.json() as { id: string }).id;
    await app.scheduler.runNow("estimating.quote-validity");
    await patch(`/projects/${projectB}/estimating/sub-quotes/${quoteId}`, {
      validUntil: shiftDays(120),
    });
    const rows = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "sub_quote_expiring")),
      );
    const signal = rows.find((s) => (s.evidenceRefs as { key?: string } | null)?.key === quoteId);
    expect(signal?.disposition).toBe("closed");
  });

  it("flags a stale catalogue rate and the live estimates resting on it", async () => {
    const stale = await post("/estimating/catalogue", {
      code: "OLD-RATE",
      description: "Rate from another decade",
      unit: "m2",
      rates: { material: 10 },
      rateAsAt: shiftDays(-800),
    });
    const staleId = (stale.json() as { id: string }).id;
    const estimateId = await makeEstimate("Stale rate estimate", projectB);
    await addLine(estimateId, { description: "Old work", quantity: 10, catalogueItemId: staleId }, projectB);

    const run = await app.scheduler.runNow("estimating.hygiene");
    expect(run.state).toBe("succeeded");

    const item = await app.db
      .select()
      .from(costCatalogueItems)
      .where(eq(costCatalogueItems.id, staleId));
    expect(item[0]?.status).toBe("review");

    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "estimate_stale_rates")),
      );
    expect(raised.some((s) => (s.evidenceRefs as { key?: string } | null)?.key === estimateId)).toBe(true);
  });

  it("flags measured takeoff that nobody priced", async () => {
    const item = await post(`/projects/${projectB}/takeoff/items`, {
      name: "Never priced",
      measurementType: "count",
      manualRawValue: 12,
    });
    expect(item.statusCode).toBe(201);
    // backdate it past the sweep's window
    await app.db
      .update(takeoffItems)
      .set({ createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString() })
      .where(eq(takeoffItems.id, (item.json() as { id: string }).id));
    await app.scheduler.runNow("estimating.hygiene");
    const raised = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "takeoff_unpriced")));
    expect(raised.some((s) => (s.evidenceRefs as { key?: string } | null)?.key === projectB)).toBe(true);
  });

  it("flags an approved estimate nobody converted, and closes it on conversion", async () => {
    const estimateId = await makeEstimate("Never converted", projectB);
    await addLine(estimateId, { description: "Works", costCode: "07-1000", quantity: 1, rates: { other: 5000 } }, projectB);
    await approve(estimateId, projectB);
    await app.db
      .update(estimates)
      .set({ approvedAt: new Date(Date.now() - 60 * 86_400_000).toISOString() })
      .where(eq(estimates.id, estimateId));

    await app.scheduler.runNow("estimating.hygiene");
    let raised = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "estimate_unconverted")),
      );
    const signal = raised.find((s) => (s.evidenceRefs as { key?: string } | null)?.key === estimateId);
    expect(signal).toBeDefined();
    expect(signal?.disposition).toBe("new");

    const converted = await post(`/projects/${projectB}/estimates/${estimateId}/convert-to-budget`);
    expect(converted.statusCode).toBe(201);
    raised = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "estimate_unconverted")),
      );
    expect(
      raised.find((s) => (s.evidenceRefs as { key?: string } | null)?.key === estimateId)?.disposition,
    ).toBe("closed");
  });

  it("runs both sweeps on demand from the project route", async () => {
    const res = await post(`/projects/${projectA}/estimating/sweep`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      quotes: { ranAt: string };
      hygiene: { ranAt: string; catalogueFlagged: number };
    };
    expect(body.quotes.ranAt).toBeTruthy();
    expect(body.hygiene.ranAt).toBeTruthy();
  });

  it("keeps a rival company out of the sweep route", async () => {
    expect(
      (await post(`/projects/${projectA}/estimating/sweep`, {}, stranger.headers)).statusCode,
    ).toBe(403);
  });
});

describe("summary, health inputs and risks", () => {
  it("buckets money by currency and refuses a cross-currency total", async () => {
    const res = await get(`/projects/${projectA}/estimating/summary`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      estimates: { total: number; live: number; byStatus: Record<string, number> };
      byCurrency: Array<{ currency: string; total: number }>;
      crossCurrency: { value: number | null; reasons: string[] };
      takeoff: { total: number; unpriced: number; layers: number };
      subQuotes: { total: number };
      proposals: { total: number };
      latestEstimate: { reference: string } | null;
    };
    expect(body.estimates.total).toBeGreaterThan(0);
    expect(body.byCurrency.map((c) => c.currency)).toEqual(expect.arrayContaining(["GBP", "USD"]));
    expect(body.crossCurrency.value).toBeNull();
    expect(body.crossCurrency.reasons.join(" ")).toMatch(/exchange rate nobody recorded/);
    expect(body.takeoff.total).toBeGreaterThan(0);
    expect(body.subQuotes.total).toBeGreaterThan(0);
    expect(body.proposals.total).toBe(1);
    expect(body.latestEstimate).not.toBeNull();
  });

  it("returns a single total when the project has one currency", async () => {
    const res = await get(`/projects/${projectB}/estimating/summary`);
    const body = res.json() as { crossCurrency: { value: number | null; reasons: string[] } };
    expect(body.crossCurrency.value).not.toBeNull();
    expect(body.crossCurrency.reasons).toHaveLength(0);
  });

  it("exposes health inputs with their reasons", async () => {
    const res = await get(`/projects/${projectB}/estimating/health-inputs`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { metrics: Record<string, number | null>; reasons: string[] };
    expect(body.metrics).toHaveProperty("takeoffUnpriced");
    expect(body.metrics).toHaveProperty("staleRateLines");
    expect(body.metrics).toHaveProperty("openEstimatingSignals");
    expect(body.metrics["subQuotesExpired"]).toBeGreaterThan(0);
    expect(body.reasons.join(" ")).toMatch(/out of validity/);
  });

  it("lists this project's estimating signals, open by default", async () => {
    const open = await get(`/projects/${projectB}/estimating/risks`);
    expect(open.statusCode).toBe(200);
    const openBody = open.json() as { items: Array<{ detector: string; disposition: string }> };
    expect(openBody.items.length).toBeGreaterThan(0);
    expect(openBody.items.every((i) => i.disposition !== "closed")).toBe(true);
    const all = await get(`/projects/${projectB}/estimating/risks?includeClosed=true`);
    expect((all.json() as { total: number }).total).toBeGreaterThanOrEqual(
      (open.json() as { total: number }).total,
    );
  });

  it("keeps a rival company out of the summary, the health inputs and the risks", async () => {
    expect(
      (await get(`/projects/${projectA}/estimating/summary`, stranger.headers)).statusCode,
    ).toBe(403);
    expect(
      (await get(`/projects/${projectA}/estimating/health-inputs`, stranger.headers)).statusCode,
    ).toBe(403);
    expect((await get(`/projects/${projectA}/estimating/risks`, stranger.headers)).statusCode).toBe(403);
  });

  it("shows a rival company nothing on its own project", async () => {
    const res = await get(`/projects/${strangerProject}/estimating/summary`, stranger.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { estimates: { total: number }; takeoff: { total: number } };
    expect(body.estimates.total).toBe(0);
    expect(body.takeoff.total).toBe(0);
  });
});

/* ================================================================== */
/* The remaining read routes and a successful header patch             */
/* ================================================================== */

describe("read routes and header edits", () => {
  it("reads a crew, an assembly list and a layer list", async () => {
    const crew = await get(`/estimating/crews/${crewId}`);
    expect(crew.statusCode).toBe(200);
    expect((crew.json() as { code: string }).code).toBe("GANG-2+1");
    expect((await get(`/estimating/crews/est_missing`)).statusCode).toBe(404);

    const assemblies = await get("/estimating/assemblies?page=1&pageSize=50");
    expect((assemblies.json() as { total: number }).total).toBeGreaterThan(0);

    const layers = await get(`/projects/${projectA}/takeoff/layers`);
    expect(layers.statusCode).toBe(200);
    expect((layers.json() as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it("scopes the catalogue to a project when asked", async () => {
    const projectRate = await post("/estimating/catalogue", {
      projectId: projectA,
      code: "PROJ-ONLY",
      description: "Project-specific rate",
      unit: "m2",
      rates: { material: 5 },
    });
    expect(projectRate.statusCode).toBe(201);
    const both = await get(`/estimating/catalogue?projectId=${projectA}&pageSize=200`);
    const bothCodes = (both.json() as { items: Array<{ code: string }> }).items.map((i) => i.code);
    expect(bothCodes).toContain("PROJ-ONLY");
    expect(bothCodes).toContain("BLK-140");
    const only = await get(`/estimating/catalogue?projectId=${projectA}&includeCompany=false&pageSize=200`);
    const onlyCodes = (only.json() as { items: Array<{ code: string }> }).items.map((i) => i.code);
    expect(onlyCodes).toEqual(["PROJ-ONLY"]);
  });

  it("refuses a project id from another company on a library route", async () => {
    const res = await post("/estimating/catalogue", {
      projectId: strangerProject,
      code: "CROSS-TENANT",
      description: "Should not exist",
      unit: "ea",
      rates: { other: 1 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("lists an estimate's sections and markups", async () => {
    const estimateId = await makeEstimate("Read routes");
    await post(`/projects/${projectA}/estimates/${estimateId}/sections`, { name: "Section A" });
    await post(`/projects/${projectA}/estimates/${estimateId}/markups`, {
      kind: "bond",
      name: "Bond",
      method: "fixed",
      rate: 500,
    });
    const sections = await get(`/projects/${projectA}/estimates/${estimateId}/sections`);
    expect((sections.json() as { total: number }).total).toBe(1);
    const markups = await get(`/projects/${projectA}/estimates/${estimateId}/markups`);
    expect((markups.json() as { total: number; currency: string }).total).toBe(1);
    expect((markups.json() as { currency: string }).currency).toBe("GBP");
  });

  it("patches an estimate header and ledgers what changed", async () => {
    const estimateId = await makeEstimate("Before rename");
    const res = await patch(`/projects/${projectA}/estimates/${estimateId}`, {
      name: "After rename",
      basis: "Rates as at tender close",
      accuracyRange: 0.1,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string }).name).toBe("After rename");
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.objectId, estimateId));
    expect(entries.some((e) => e.action === "update")).toBe(true);
  });

  it("refuses to edit a superseded estimate at all", async () => {
    const estimateId = await makeEstimate("To be superseded");
    await addLine(estimateId, { description: "Works", quantity: 1, rates: { other: 100 } });
    const version = await post(`/projects/${projectA}/estimates/${estimateId}/versions`);
    expect(version.statusCode).toBe(201);
    const res = await patch(`/projects/${projectA}/estimates/${estimateId}`, { name: "nope" });
    expect(res.statusCode).toBe(409);
  });
});
