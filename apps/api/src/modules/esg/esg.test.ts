import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { boqItems, boqs, projects, signals } from "@constructos/db";
import { CARBON_MODULES, SOCIAL_VALUE_THEMES } from "@constructos/shared";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let other: TestActor; // separate tenant — isolation counterparty
let projectId: string;

const today = todayISO();

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  other = await registerActor(app);
  projectId = await makeProject("Carbon Test Project");
});

afterAll(async () => {
  await built.close();
});

async function makeProject(name: string, settings?: Record<string, unknown>): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({
    id,
    companyId: owner.companyId,
    name,
    ...(settings ? { settings } : {}),
  });
  return id;
}

async function createFactor(payload: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/carbon-factors",
    headers: owner.headers,
    payload: {
      name: `Factor ${newId()}`,
      unit: "kg",
      factorKgCo2ePerUnit: 1,
      source: "generic",
      ...payload,
    },
  });
  if (res.statusCode !== 201) throw new Error(`createFactor failed: ${res.body}`);
  return res.json() as { id: string; name: string; unit: string };
}

async function createEntry(pid: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/carbon-entries`,
    headers: owner.headers,
    payload: {
      description: "Test entry",
      lifecycleModule: "A1-A3",
      quantity: 1000,
      unit: "kg",
      entryDate: today,
      ...payload,
    },
  });
}

async function createBudget(pid: string, payload: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/carbon-budgets`,
    headers: owner.headers,
    payload: { name: "Substructure", baselineTco2e: 20, targetTco2e: 10, ...payload },
  });
  if (res.statusCode !== 201) throw new Error(`createBudget failed: ${res.body}`);
  return res.json() as { id: string };
}

async function listBudgets(pid: string) {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/projects/${pid}/carbon-budgets`,
    headers: owner.headers,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    items: { id: string; actualTco2e: number; drawdownPercent: number; status: string }[];
  };
}

async function budgetSignals(pid: string) {
  return app.db
    .select()
    .from(signals)
    .where(and(eq(signals.projectId, pid), eq(signals.detector, "carbon_budget_exceeded")));
}

/* ------------------------------------------------------------------ */
/* Factor library (#496-498)                                           */
/* ------------------------------------------------------------------ */

describe("carbon factor library", () => {
  it("creates a factor and finds it by search and source", async () => {
    const created = await createFactor({
      name: "Supplier EPD — CEM III/A blend",
      materialCategory: "cement",
      factorKgCo2ePerUnit: 0.42,
      source: "epd",
      isProductSpecific: true,
      epdReference: "EPD-XYZ-0001",
    });
    expect(created.id).toMatch(/^cfa_/);

    const search = await app.inject({
      method: "GET",
      url: "/api/v1/carbon-factors?search=CEM%20III&source=epd",
      headers: owner.headers,
    });
    expect(search.statusCode).toBe(200);
    const body = search.json() as { items: { id: string; isProductSpecific: number }[] };
    expect(body.items.map((f) => f.id)).toContain(created.id);
    expect(body.items[0]!.isProductSpecific).toBe(1);

    const wrongSource = await app.inject({
      method: "GET",
      url: "/api/v1/carbon-factors?search=CEM%20III&source=supplier",
      headers: owner.headers,
    });
    expect((wrongSource.json() as { total: number }).total).toBe(0);
  });

  it("seeds the default library idempotently", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/carbon-factors/seed-defaults",
      headers: owner.headers,
      payload: {},
    });
    expect(first.statusCode).toBe(201);
    const a = first.json() as { created: number; skipped: number; total: number };
    expect(a.total).toBe(15);
    expect(a.created).toBe(15);
    expect(a.skipped).toBe(0);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/carbon-factors/seed-defaults",
      headers: owner.headers,
      payload: {},
    });
    const b = second.json() as { created: number; skipped: number };
    expect(b.created).toBe(0);
    expect(b.skipped).toBe(15);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/carbon-factors?source=ice_database&pageSize=200",
      headers: owner.headers,
    });
    const items = (list.json() as { items: { name: string; isProductSpecific: number }[] }).items;
    expect(items).toHaveLength(15);
    // seeded rows are generic by construction, so #498 reports honestly
    expect(items.every((f) => f.isProductSpecific === 0)).toBe(true);
    expect(items.map((f) => f.name)).toContain("Concrete C30/37 (generic)");
  });

  it("rejects an entry whose unit does not match the factor, naming both", async () => {
    const kgFactor = await createFactor({ name: "Concrete per kg", unit: "kg" });
    const res = await createEntry(projectId, {
      factorId: kgFactor.id,
      unit: "m3",
      quantity: 12,
    });
    expect(res.statusCode).toBe(400);
    const message = (res.json() as { message: string }).message;
    expect(message).toContain("m3");
    expect(message).toContain("kg");
    expect(message).toContain("Concrete per kg");
  });

  it("refuses to edit or delete a factor in use, allows both when unused", async () => {
    const used = await createFactor({ name: "Pinned factor", factorKgCo2ePerUnit: 2 });
    const entry = await createEntry(projectId, { factorId: used.id });
    expect(entry.statusCode).toBe(201);

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/carbon-factors/${used.id}`,
      headers: owner.headers,
      payload: { factorKgCo2ePerUnit: 99 },
    });
    expect(patch.statusCode).toBe(409);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/carbon-factors/${used.id}`,
      headers: owner.headers,
    });
    expect(del.statusCode).toBe(409);
    expect((del.json() as { message: string }).message).toContain("1 carbon entry");

    const unused = await createFactor({ name: "Orphan factor" });
    const okPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/carbon-factors/${unused.id}`,
      headers: owner.headers,
      payload: { factorKgCo2ePerUnit: 5, isProductSpecific: true },
    });
    expect(okPatch.statusCode).toBe(200);
    expect((okPatch.json() as { factorKgCo2ePerUnit: number }).factorKgCo2ePerUnit).toBe(5);

    const okDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/carbon-factors/${unused.id}`,
      headers: owner.headers,
    });
    expect(okDelete.statusCode).toBe(204);
  });
});

/* ------------------------------------------------------------------ */
/* Entries (#491-492)                                                  */
/* ------------------------------------------------------------------ */

describe("carbon entries", () => {
  it("computes tCO2e as quantity x factor / 1000", async () => {
    const pid = await makeProject("Entry math");
    const factor = await createFactor({ name: "C30/37 math", factorKgCo2ePerUnit: 0.103 });
    const res = await createEntry(pid, {
      description: "Foundation concrete",
      factorId: factor.id,
      quantity: 10_000,
      unit: "kg",
      scope: "scope_3",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      tco2e: number;
      factorKgCo2ePerUnit: number;
      factorName: string;
      isProductSpecific: boolean;
    };
    // 10,000 kg x 0.103 kgCO2e/kg = 1030 kgCO2e = 1.03 tCO2e
    expect(body.tco2e).toBe(1.03);
    expect(body.factorKgCo2ePerUnit).toBe(0.103);
    expect(body.factorName).toBe("C30/37 math");
    expect(body.isProductSpecific).toBe(false);

    const manual = await createEntry(pid, {
      description: "Site diesel",
      lifecycleModule: "A5",
      scope: "scope_1",
      manualFactor: 2.68,
      quantity: 5000,
      unit: "litre",
    });
    expect(manual.statusCode).toBe(201);
    // 5000 l x 2.68 = 13,400 kgCO2e = 13.4 tCO2e
    expect((manual.json() as { tco2e: number }).tco2e).toBe(13.4);
    expect((manual.json() as { factorSource: string }).factorSource).toBe("manual");
  });

  it("requires exactly one of factorId or manualFactor", async () => {
    const factor = await createFactor({ name: "Either-or" });
    const neither = await createEntry(projectId, {});
    expect(neither.statusCode).toBe(400);
    const both = await createEntry(projectId, { factorId: factor.id, manualFactor: 3 });
    expect(both.statusCode).toBe(400);
  });

  it("recomputes tCO2e on patch and removes the entry on delete", async () => {
    const pid = await makeProject("Entry patch");
    const factor = await createFactor({ name: "Patchable", factorKgCo2ePerUnit: 2 });
    const created = await createEntry(pid, { factorId: factor.id, quantity: 1000 });
    const id = (created.json() as { id: string }).id;
    expect((created.json() as { tco2e: number }).tco2e).toBe(2);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/carbon-entries/${id}`,
      headers: owner.headers,
      payload: { quantity: 3000, lifecycleModule: "A4" },
    });
    expect(patched.statusCode).toBe(200);
    const pb = patched.json() as { tco2e: number; lifecycleModule: string };
    expect(pb.tco2e).toBe(6);
    expect(pb.lifecycleModule).toBe("A4");

    // switching to a manual factor drops the library reference
    const manualPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/carbon-entries/${id}`,
      headers: owner.headers,
      payload: { manualFactor: 0.5 },
    });
    const mb = manualPatch.json() as { tco2e: number; factorId: string | null };
    expect(mb.tco2e).toBe(1.5);
    expect(mb.factorId).toBeNull();

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${pid}/carbon-entries/${id}`,
      headers: owner.headers,
    });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/carbon-entries`,
      headers: owner.headers,
    });
    expect((after.json() as { total: number }).total).toBe(0);
  });

  it("rejects a budget or BoQ item from another project", async () => {
    const pidA = await makeProject("Scoping A");
    const pidB = await makeProject("Scoping B");
    const budgetB = await createBudget(pidB, { name: "B budget" });
    const factor = await createFactor({ name: "Scoping factor" });

    const crossBudget = await createEntry(pidA, {
      factorId: factor.id,
      budgetId: budgetB.id,
    });
    expect(crossBudget.statusCode).toBe(404);

    const boqId = newId("boq");
    await app.db.insert(boqs).values({
      id: boqId,
      companyId: owner.companyId,
      projectId: pidB,
      name: "B bill",
      createdBy: owner.userId,
    });
    const itemId = newId("bqi");
    await app.db.insert(boqItems).values({
      id: itemId,
      boqId,
      path: itemId,
      level: "item",
      code: "C10",
      description: "Cross-project item",
      unit: "kg",
      quantity: 100,
    });
    const crossItem = await createEntry(pidA, { factorId: factor.id, boqItemId: itemId });
    expect(crossItem.statusCode).toBe(400);
    expect((crossItem.json() as { message: string }).message).toContain("boqItemId");
  });
});

/* ------------------------------------------------------------------ */
/* Bulk generation from the BoQ (#501)                                 */
/* ------------------------------------------------------------------ */

describe("carbon entries from BoQ", () => {
  it("creates A1-A3 entries from BoQ quantities and reports what it skipped", async () => {
    const pid = await makeProject("BoQ carbon");
    const boqId = newId("boq");
    await app.db.insert(boqs).values({
      id: boqId,
      companyId: owner.companyId,
      projectId: pid,
      name: "Bill No.1",
      createdBy: owner.userId,
    });
    const mk = async (
      code: string,
      description: string,
      unit: string | null,
      quantity: number | null,
    ) => {
      const id = newId("bqi");
      await app.db.insert(boqItems).values({
        id,
        boqId,
        path: `${code}-${id}`,
        level: "item",
        code,
        description,
        unit,
        quantity,
      });
      return id;
    };
    const good = await mk("E10.100", "In-situ concrete C30/37", "kg", 250_000);
    const alsoGood = await mk("E30.100", "Reinforcement bar", "kg", 18_000);
    const noQty = await mk("E10.200", "Concrete — provisional", "kg", null);
    const wrongUnit = await mk("E10.300", "Concrete — volumetric", "m3", 120);
    await mk("Z99.999", "Unmapped preliminaries", "item", 1); // out of scope

    const concrete = await createFactor({
      name: "BoQ concrete",
      unit: "kg",
      factorKgCo2ePerUnit: 0.103,
    });
    const rebar = await createFactor({ name: "BoQ rebar", unit: "kg", factorKgCo2ePerUnit: 1.99 });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/carbon-entries/from-boq`,
      headers: owner.headers,
      payload: {
        boqId,
        mappings: [
          { boqItemId: alsoGood, factorId: rebar.id },
          { boqItemCodePrefix: "E10", factorId: concrete.id },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      created: number;
      totalTco2e: number;
      skipped: { boqItemId: string; reason: string }[];
    };
    expect(body.created).toBe(2);
    // 250,000 kg x 0.103 = 25.75 t; 18,000 kg x 1.99 = 35.82 t
    expect(body.totalTco2e).toBeCloseTo(61.57, 6);
    const reasons = Object.fromEntries(body.skipped.map((s) => [s.boqItemId, s.reason]));
    expect(reasons[noQty]).toBe("no_quantity");
    expect(reasons[wrongUnit]).toBe("unit_mismatch");
    expect(body.skipped).toHaveLength(2);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/carbon-entries?lifecycleModule=A1-A3&scope=scope_3`,
      headers: owner.headers,
    });
    const items = (
      list.json() as { items: { boqItemId: string; sourceNote: string; tco2e: number }[] }
    ).items;
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.boqItemId).sort()).toEqual([good, alsoGood].sort());
    expect(items.every((i) => i.sourceNote.startsWith("BoQ Bill No.1 item "))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Budgets (#494-495)                                                  */
/* ------------------------------------------------------------------ */

describe("carbon budgets", () => {
  it("moves on_track -> at_risk -> exceeded and signals the exceedance once", async () => {
    const pid = await makeProject("Budget drawdown");
    const budget = await createBudget(pid, { name: "Frame", baselineTco2e: 20, targetTco2e: 10 });
    // manualFactor 1 kgCO2e/unit makes quantity (kg) directly readable as tCO2e x 1000
    const book = async (kg: number) => {
      const res = await createEntry(pid, {
        budgetId: budget.id,
        manualFactor: 1,
        quantity: kg,
        unit: "kg",
      });
      expect(res.statusCode).toBe(201);
    };

    let items = (await listBudgets(pid)).items;
    expect(items[0]!.status).toBe("on_track");
    expect(items[0]!.actualTco2e).toBe(0);

    await book(5000); // 5.0 t = 50%
    items = (await listBudgets(pid)).items;
    expect(items[0]!.actualTco2e).toBeCloseTo(5, 6);
    expect(items[0]!.drawdownPercent).toBe(50);
    expect(items[0]!.status).toBe("on_track");
    expect(await budgetSignals(pid)).toHaveLength(0);

    await book(3500); // 8.5 t = 85%
    items = (await listBudgets(pid)).items;
    expect(items[0]!.drawdownPercent).toBe(85);
    expect(items[0]!.status).toBe("at_risk");
    expect(await budgetSignals(pid)).toHaveLength(0);

    await book(2000); // 10.5 t = 105%
    items = (await listBudgets(pid)).items;
    expect(items[0]!.drawdownPercent).toBe(105);
    expect(items[0]!.status).toBe("exceeded");
    expect(items[0]!.actualTco2e).toBeCloseTo(10.5, 6);

    const raised = await budgetSignals(pid);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe("medium");
    expect(raised[0]!.title).toContain("Frame");
    expect((raised[0]!.evidenceRefs as { budgetId: string }).budgetId).toBe(budget.id);

    // re-reading, and booking more, must not raise it again
    await listBudgets(pid);
    await book(1000);
    await listBudgets(pid);
    expect(await budgetSignals(pid)).toHaveLength(1);
  });

  it("refuses to delete a budget with entries booked against it", async () => {
    const pid = await makeProject("Budget delete");
    const budget = await createBudget(pid, { name: "Pinned budget" });
    await createEntry(pid, { budgetId: budget.id, manualFactor: 1, quantity: 10 });

    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${pid}/carbon-budgets/${budget.id}`,
      headers: owner.headers,
    });
    expect(blocked.statusCode).toBe(409);

    const empty = await createBudget(pid, { name: "Empty budget" });
    const ok = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${pid}/carbon-budgets/${empty.id}`,
      headers: owner.headers,
    });
    expect(ok.statusCode).toBe(204);
  });
});

/* ------------------------------------------------------------------ */
/* Reporting (#491-492, #498, #505-508)                                */
/* ------------------------------------------------------------------ */

describe("carbon reporting", () => {
  let pid: string;

  beforeAll(async () => {
    pid = await makeProject("Carbon summary", { gia: 2000 });
    const epd = await createFactor({
      name: "EPD concrete",
      unit: "kg",
      factorKgCo2ePerUnit: 0.1,
      source: "epd",
      isProductSpecific: true,
    });
    const generic = await createFactor({
      name: "Generic steel",
      unit: "kg",
      factorKgCo2ePerUnit: 1,
      source: "ice_database",
    });
    // 30,000 kg x 0.1 = 3 t product-specific
    await createEntry(pid, {
      description: "EPD concrete",
      factorId: epd.id,
      quantity: 30_000,
      unit: "kg",
      scope: "scope_3",
      lifecycleModule: "A1-A3",
    });
    // 1000 kg x 1 = 1 t generic
    await createEntry(pid, {
      description: "Generic steel",
      factorId: generic.id,
      quantity: 1000,
      unit: "kg",
      scope: "scope_3",
      lifecycleModule: "A1-A3",
    });
    // 1000 l x 1 = 1 t manual, module A5, scope 1
    await createEntry(pid, {
      description: "Site plant diesel",
      manualFactor: 1,
      quantity: 1000,
      unit: "litre",
      scope: "scope_1",
      lifecycleModule: "A5",
    });
  });

  it("reports every lifecycle module, the scope split and the product-specific share", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/carbon/summary`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totalTco2e: number;
      byModule: Record<string, number>;
      byScope: Record<string, number>;
      productSpecificSharePercent: number;
      productSpecificTco2e: number;
      intensityPerSqm: number | null;
      gia: number | null;
      unbudgetedTco2e: number;
      budgets: { count: number };
    };
    expect(body.totalTco2e).toBeCloseTo(5, 6);
    // every EN 15978 module is present, zeros included — a missing module is
    // indistinguishable from an unassessed one otherwise
    expect(Object.keys(body.byModule).sort()).toEqual([...CARBON_MODULES].sort());
    expect(body.byModule["A1-A3"]).toBeCloseTo(4, 6);
    expect(body.byModule["A5"]).toBeCloseTo(1, 6);
    expect(body.byModule["D"]).toBe(0);
    expect(body.byScope["scope_3"]).toBeCloseTo(4, 6);
    expect(body.byScope["scope_1"]).toBeCloseTo(1, 6);
    expect(body.byScope["scope_2"]).toBe(0);
    expect(body.byScope["unscoped"]).toBe(0);
    // 3 t of 5 t stands on an EPD
    expect(body.productSpecificTco2e).toBeCloseTo(3, 6);
    expect(body.productSpecificSharePercent).toBe(60);
    // 5 tCO2e over 2000 m2 GIA = 2.5 kgCO2e/m2
    expect(body.gia).toBe(2000);
    expect(body.intensityPerSqm).toBe(2.5);
    expect(body.unbudgetedTco2e).toBeCloseTo(5, 6);
    expect(body.budgets.count).toBe(0);
  });

  it("renders a CSV with one row per entry and a total", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/carbon/report.csv`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.body.trim().split("\n");
    expect(lines[0]).toBe(
      "module,scope,description,quantity,unit,factor_kgco2e_per_unit,tco2e",
    );
    expect(lines).toHaveLength(5); // header + 3 entries + total
    expect(lines[lines.length - 1]).toBe("TOTAL,,,,,,5");
    const concrete = lines.find((l) => l.includes("EPD concrete"))!;
    expect(concrete).toBe("A1-A3,scope_3,EPD concrete,30000,kg,0.1,3");
  });
});

/* ------------------------------------------------------------------ */
/* Waste (#513-514)                                                    */
/* ------------------------------------------------------------------ */

describe("waste", () => {
  let pid: string;

  beforeAll(async () => {
    pid = await makeProject("Waste project");
    const add = async (payload: Record<string, unknown>) => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/waste-records`,
        headers: owner.headers,
        payload: { recordDate: today, tonnes: 1, ...payload },
      });
      expect(res.statusCode).toBe(201);
    };
    await add({ stream: "inert", destination: "landfill", tonnes: 20, cost: 500 });
    await add({ stream: "inert", destination: "recycled", tonnes: 50, cost: 200 });
    await add({ stream: "timber", destination: "reused", tonnes: 10 });
    await add({
      stream: "hazardous",
      destination: "incinerated",
      tonnes: 20,
      carrier: "Licensed Carrier Ltd",
      consignmentNote: "CN-2026-0001",
      recordDate: addDaysISO(today, -40),
    });
  });

  it("computes diversion from landfill and the recycled share", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/waste/summary`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totalTonnes: number;
      byStream: Record<string, number>;
      byDestination: Record<string, number>;
      diversionFromLandfillPercent: number;
      recycledPercent: number;
      costTotal: number;
      hazardousTonnes: number;
    };
    expect(body.totalTonnes).toBe(100);
    // 100 t moved, 20 t landfilled -> 80 t diverted
    expect(body.diversionFromLandfillPercent).toBe(80);
    expect(body.recycledPercent).toBe(50);
    expect(body.costTotal).toBe(700);
    expect(body.hazardousTonnes).toBe(20);
    expect(body.byStream["inert"]).toBe(70);
    expect(body.byStream["packaging"]).toBe(0);
    expect(body.byDestination["landfill"]).toBe(20);
    expect(body.byDestination["recovered"]).toBe(0);
  });

  it("filters records by stream and date window", async () => {
    const byStream = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/waste-records?stream=inert`,
      headers: owner.headers,
    });
    expect((byStream.json() as { total: number }).total).toBe(2);

    const recent = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/waste-records?from=${addDaysISO(today, -7)}`,
      headers: owner.headers,
    });
    expect((recent.json() as { total: number }).total).toBe(3);

    const scoped = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/waste/summary?from=${addDaysISO(today, -7)}`,
      headers: owner.headers,
    });
    const s = scoped.json() as { totalTonnes: number; diversionFromLandfillPercent: number };
    expect(s.totalTonnes).toBe(80);
    // window excludes the incinerated load: 80 t moved, 20 t landfilled = 75%
    expect(s.diversionFromLandfillPercent).toBe(75);
  });
});

/* ------------------------------------------------------------------ */
/* Social value (#527-540)                                             */
/* ------------------------------------------------------------------ */

describe("social value", () => {
  let pid: string;
  let apprenticeships: string;
  let localSpend: string;

  async function createCommitment(payload: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/social-value`,
      headers: owner.headers,
      payload: {
        theme: "equal_opportunity",
        description: "Apprenticeship weeks",
        unit: "weeks",
        targetValue: 100,
        ...payload,
      },
    });
    if (res.statusCode !== 201) throw new Error(`createCommitment failed: ${res.body}`);
    return res.json() as { id: string; number: number; status: string; progressPercent: number };
  }

  async function deliver(id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/social-value/${id}/deliveries`,
      headers: owner.headers,
      payload: { deliveryDate: today, ...payload },
    });
  }

  beforeAll(async () => {
    pid = await makeProject("Social value project");
  });

  it("tracks progress, proxy value and the committed -> on_track -> delivered path", async () => {
    const created = await createCommitment({
      measureRef: "NT6",
      proxyValuePerUnit: 250,
      dueDate: addDaysISO(today, 60),
    });
    apprenticeships = created.id;
    expect(created.number).toBe(1);
    expect(created.status).toBe("committed");
    expect(created.progressPercent).toBe(0);

    const first = await deliver(apprenticeships, { value: 40, note: "Q1 cohort" });
    expect(first.statusCode).toBe(201);
    const afterFirst = (first.json() as { commitment: Record<string, unknown> }).commitment as {
      deliveredValue: number;
      progressPercent: number;
      proxyValueDelivered: number;
      proxyValueCommitted: number;
      status: string;
    };
    expect(afterFirst.deliveredValue).toBe(40);
    expect(afterFirst.progressPercent).toBe(40);
    // 40 weeks x £250 proxy = £10,000 delivered against £25,000 committed
    expect(afterFirst.proxyValueDelivered).toBe(10_000);
    expect(afterFirst.proxyValueCommitted).toBe(25_000);
    expect(afterFirst.status).toBe("on_track");

    const second = await deliver(apprenticeships, { value: 60 });
    const afterSecond = (second.json() as { commitment: { status: string; progressPercent: number } })
      .commitment;
    expect(afterSecond.progressPercent).toBe(100);
    expect(afterSecond.status).toBe("delivered");

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/social-value/${apprenticeships}`,
      headers: owner.headers,
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { deliveries: { value: number }[]; status: string };
    expect(body.deliveries).toHaveLength(2);
    expect(body.deliveries.map((d) => d.value)).toEqual([40, 60]);
    expect(body.status).toBe("delivered");
  });

  it("falls to shortfall past due date + 30 days and signals exactly once", async () => {
    const created = await createCommitment({
      theme: "economic_inequality",
      description: "Local SME spend within 30 miles",
      unit: "GBP",
      targetValue: 100,
      proxyValuePerUnit: 10,
      dueDate: addDaysISO(today, -45),
    });
    localSpend = created.id;

    const res = await deliver(localSpend, { value: 20 });
    expect(res.statusCode).toBe(201);
    const commitment = (res.json() as { commitment: { status: string; progressPercent: number } })
      .commitment;
    expect(commitment.status).toBe("shortfall");
    expect(commitment.progressPercent).toBe(20);

    const shortfallSignals = async () =>
      app.db
        .select()
        .from(signals)
        .where(and(eq(signals.projectId, pid), eq(signals.detector, "social_value_shortfall")));
    const raised = await shortfallSignals();
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe("medium");
    expect(raised[0]!.explanation).toContain("shortfall of 80 GBP");

    // repeated reads re-run the sweep but must not re-raise
    for (let i = 0; i < 3; i += 1) {
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${pid}/social-value`,
        headers: owner.headers,
      });
    }
    expect(await shortfallSignals()).toHaveLength(1);
  });

  it("flags a past-due commitment under 70 percent as at_risk", async () => {
    const created = await createCommitment({
      theme: "wellbeing",
      description: "Volunteering hours",
      unit: "hours",
      targetValue: 200,
      dueDate: addDaysISO(today, -5),
    });
    const res = await deliver(created.id, { value: 20 });
    expect(
      (res.json() as { commitment: { status: string } }).commitment.status,
    ).toBe("at_risk");
  });

  it("reconciles committed against delivered by theme with the shortfall list", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/social-value/summary`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      byTheme: Record<
        string,
        { committed: number; delivered: number; progressPercent: number; proxyValueDelivered: number }
      >;
      overall: {
        commitments: number;
        delivered: number;
        atRisk: number;
        shortfall: number;
        proxyValueCommitted: number;
        proxyValueDelivered: number;
        proxyValueShortfall: number;
      };
      shortfalls: { id: string; shortfallValue: number; proxyValueShortfall: number | null }[];
    };
    expect(Object.keys(body.byTheme).sort()).toEqual([...SOCIAL_VALUE_THEMES].sort());
    expect(body.byTheme["equal_opportunity"]).toMatchObject({
      committed: 100,
      delivered: 100,
      progressPercent: 100,
      proxyValueDelivered: 25_000,
    });
    expect(body.byTheme["economic_inequality"]).toMatchObject({
      committed: 100,
      delivered: 20,
      progressPercent: 20,
      proxyValueDelivered: 200,
    });
    expect(body.byTheme["covid_recovery"]!.committed).toBe(0);

    expect(body.overall.commitments).toBe(3);
    expect(body.overall.delivered).toBe(1);
    expect(body.overall.shortfall).toBe(1);
    expect(body.overall.atRisk).toBe(1);
    // £25,000 apprenticeships + £1,000 local spend committed
    expect(body.overall.proxyValueCommitted).toBe(26_000);
    expect(body.overall.proxyValueDelivered).toBe(25_200);
    expect(body.overall.proxyValueShortfall).toBe(800);

    const ids = body.shortfalls.map((s) => s.id);
    expect(ids).toContain(localSpend);
    expect(ids).not.toContain(apprenticeships);
    const spend = body.shortfalls.find((s) => s.id === localSpend)!;
    expect(spend.shortfallValue).toBe(80);
    expect(spend.proxyValueShortfall).toBe(800);
  });
});

/* ------------------------------------------------------------------ */
/* Tenant isolation                                                    */
/* ------------------------------------------------------------------ */

describe("isolation", () => {
  it("keeps the register and the factor library inside the tenant", async () => {
    const factor = await createFactor({ name: `Private factor ${newId()}` });

    const foreignFactors = await app.inject({
      method: "GET",
      url: "/api/v1/carbon-factors?pageSize=200",
      headers: other.headers,
    });
    expect(foreignFactors.statusCode).toBe(200);
    const foreignIds = (foreignFactors.json() as { items: { id: string }[] }).items.map(
      (f) => f.id,
    );
    expect(foreignIds).not.toContain(factor.id);

    const foreignFactorRead = await app.inject({
      method: "GET",
      url: `/api/v1/carbon-factors/${factor.id}`,
      headers: other.headers,
    });
    expect(foreignFactorRead.statusCode).toBe(404);

    for (const url of [
      `/api/v1/projects/${projectId}/carbon-entries`,
      `/api/v1/projects/${projectId}/carbon/summary`,
      `/api/v1/projects/${projectId}/waste/summary`,
      `/api/v1/projects/${projectId}/social-value`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: other.headers });
      expect(res.statusCode).toBe(403);
    }
  });
});
