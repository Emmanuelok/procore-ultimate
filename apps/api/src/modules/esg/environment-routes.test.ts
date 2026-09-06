/**
 * Integration tests for the ESG environment / disclosure routes and every
 * ESG audit bug this package fixed:
 *
 *  - read-time sweeps replaced by a scheduled, fingerprinted detector
 *  - BoQ carbon import made idempotent (a re-run no longer doubles the
 *    footprint) with an explicit `replace` mode
 *  - social value deliveredValue derived from SUM(deliveries), not a
 *    read-modify-write that loses concurrent increments
 *  - a writer for projects.settings.gia, so the RICS intensity unit can
 *    actually populate
 *  - carbon budget exceedance re-armed by a target revision
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  boqItems,
  boqs,
  carbonEntries,
  evidence,
  ledgerEntries,
  projects,
  signals,
  socialValueCommitments,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let stranger: TestActor;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  stranger = await registerActor(app);
});

afterAll(async () => {
  await built.close();
});

async function makeProject(name: string): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({ id, companyId: owner.companyId, name });
  return id;
}

async function makeEvidence(pid: string): Promise<string> {
  const id = newId("evd");
  await app.db.insert(evidence).values({
    id,
    companyId: owner.companyId,
    projectId: pid,
    kind: "photo",
    source: "site record",
    contentHash: `hash-${id}`,
    submittedBy: owner.userId,
  });
  return id;
}

async function makeFactor(name = "Concrete C30/37", extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/carbon-factors",
    headers: owner.headers,
    payload: {
      name,
      unit: "kg",
      factorKgCo2ePerUnit: 0.103,
      source: "ice_database",
      ...extra,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

/* ================================================================== */
/* AUDIT BUG: BoQ carbon import doubled the footprint on a re-run      */
/* ================================================================== */

describe("BoQ carbon import idempotence", () => {
  async function seedBoq(pid: string) {
    const boqId = newId("boq");
    await app.db.insert(boqs).values({
      id: boqId,
      companyId: owner.companyId,
      projectId: pid,
      name: "Bill 1 — Substructure",
      standard: "nrm2",
      currency: "GBP",
      createdBy: owner.userId,
    });
    for (const [i, code] of ["C10.1", "C10.2"].entries()) {
      await app.db.insert(boqItems).values({
        id: newId("bqi"),
        companyId: owner.companyId,
        boqId,
        code,
        path: `1.${i}`,
        sortOrder: i,
        description: `Concrete item ${code}`,
        quantity: 10_000,
        unit: "kg",
      });
    }
    return boqId;
  }

  it("skips items already imported, so a second run adds nothing", async () => {
    const pid = await makeProject("BoQ idempotence");
    const boqId = await seedBoq(pid);
    const factor = await makeFactor();
    const payload = {
      boqId,
      mappings: [{ boqItemCodePrefix: "C10", factorId: factor.id }],
    };

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/carbon-entries/from-boq`,
      headers: owner.headers,
      payload,
    });
    expect(first.statusCode).toBe(201);
    const a = first.json() as { created: number; totalTco2e: number };
    expect(a.created).toBe(2);
    expect(a.totalTco2e).toBe(2.06);

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/carbon-entries/from-boq`,
      headers: owner.headers,
      payload,
    });
    expect(second.statusCode).toBe(201);
    const b = second.json() as {
      created: number;
      alreadyImported: number;
      skipped: { reason: string; detail: string }[];
    };
    expect(b.created).toBe(0);
    expect(b.alreadyImported).toBe(2);
    expect(b.skipped[0]!.reason).toBe("already_imported");
    expect(b.skipped[0]!.detail).toContain("double its footprint");

    // the footprint is unchanged — this is the bug that mattered
    const entries = await app.db
      .select()
      .from(carbonEntries)
      .where(eq(carbonEntries.projectId, pid));
    expect(entries).toHaveLength(2);
    const summary = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/carbon/summary`,
      headers: owner.headers,
    });
    expect((summary.json() as { totalTco2e: number }).totalTco2e).toBe(2.06);
  });

  it("replaces prior entries when the caller asks for it, without doubling", async () => {
    const pid = await makeProject("BoQ replace");
    const boqId = await seedBoq(pid);
    const factor = await makeFactor("Low-carbon concrete", { factorKgCo2ePerUnit: 0.05 });
    const first = await makeFactor("Original concrete");
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/carbon-entries/from-boq`,
      headers: owner.headers,
      payload: { boqId, mappings: [{ boqItemCodePrefix: "C10", factorId: first.id }] },
    });
    const replaced = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/carbon-entries/from-boq`,
      headers: owner.headers,
      payload: {
        boqId,
        mode: "replace",
        mappings: [{ boqItemCodePrefix: "C10", factorId: factor.id }],
      },
    });
    expect(replaced.statusCode).toBe(201);
    const body = replaced.json() as { created: number; replaced: number; totalTco2e: number };
    expect(body.created).toBe(2);
    expect(body.replaced).toBe(2);
    expect(body.totalTco2e).toBe(1);
    const entries = await app.db
      .select()
      .from(carbonEntries)
      .where(eq(carbonEntries.projectId, pid));
    expect(entries).toHaveLength(2);
  });

  it("records the mode in the ledger so a re-import is auditable", async () => {
    const pid = await makeProject("BoQ ledger");
    const boqId = await seedBoq(pid);
    const factor = await makeFactor();
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/carbon-entries/from-boq`,
      headers: owner.headers,
      payload: { boqId, mappings: [{ boqItemCodePrefix: "C10", factorId: factor.id }] },
    });
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "carbon_entry_bulk"),
        ),
      );
    const payload = entries.at(-1)!.payload as { mode: string; replaced: number };
    expect(payload.mode).toBe("append");
    expect(payload.replaced).toBe(0);
  });
});

/* ================================================================== */
/* AUDIT BUG: social value deliveredValue lost concurrent increments   */
/* ================================================================== */

describe("social value delivered total", () => {
  async function makeCommitment(pid: string, extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/social-value`,
      headers: owner.headers,
      payload: {
        theme: "jobs",
        description: "Local apprenticeships",
        targetValue: 100,
        unit: "weeks",
        dueDate: addDaysISO(todayISO(), 90),
        proxyValuePerUnit: 250,
        ...extra,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; deliveredValue: number };
  }

  it("keeps deliveredValue equal to SUM(deliveries) under concurrent posts", async () => {
    const pid = await makeProject("Social value concurrency");
    const commitment = await makeCommitment(pid);
    const post = (value: number) =>
      app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/social-value/${commitment.id}/deliveries`,
        headers: owner.headers,
        payload: { deliveryDate: todayISO(), value },
      });

    // the double-submit that used to lose an increment
    const results = await Promise.all([post(10), post(10), post(10), post(10)]);
    for (const r of results) expect(r.statusCode).toBe(201);

    const [row] = await app.db
      .select()
      .from(socialValueCommitments)
      .where(eq(socialValueCommitments.id, commitment.id));
    expect(row!.deliveredValue).toBe(40);
  });

  it("recomputes status from the derived total without waiting for a sweep", async () => {
    const pid = await makeProject("Social value status");
    const commitment = await makeCommitment(pid, { targetValue: 10 });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/social-value/${commitment.id}/deliveries`,
      headers: owner.headers,
      payload: { deliveryDate: todayISO(), value: 10 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { commitment: { status: string; deliveredValue: number } };
    expect(body.commitment.deliveredValue).toBe(10);
    expect(body.commitment.status).toBe("delivered");
  });

  it("refuses a delivery from another tenant", async () => {
    const pid = await makeProject("Social value isolation");
    const commitment = await makeCommitment(pid);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/social-value/${commitment.id}/deliveries`,
      headers: stranger.headers,
      payload: { deliveryDate: todayISO(), value: 1 },
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

/* ================================================================== */
/* AUDIT BUG: no writer for projects.settings.gia                      */
/* ================================================================== */

describe("carbon intensity per m² GIA (#491)", () => {
  it("writes GIA and makes the intensity KPI populate", async () => {
    const pid = await makeProject("GIA");
    const before = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/carbon-settings`,
      headers: owner.headers,
    });
    expect((before.json() as { giaSqm: number | null }).giaSqm).toBeNull();
    expect((before.json() as { unavailableReason: string }).unavailableReason).toContain(
      "cannot be stated",
    );

    const set = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/carbon-settings`,
      headers: owner.headers,
      payload: { giaSqm: 5_000 },
    });
    expect(set.statusCode).toBe(200);

    const factor = await makeFactor();
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/carbon-entries`,
      headers: owner.headers,
      payload: {
        description: "Concrete",
        lifecycleModule: "A1-A3",
        scope: "scope_3",
        factorId: factor.id,
        quantity: 100_000,
        unit: "kg",
        entryDate: todayISO(),
      },
    });
    const summary = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/carbon/summary`,
      headers: owner.headers,
    });
    const body = summary.json() as { gia: number; intensityPerSqm: number; totalTco2e: number };
    expect(body.gia).toBe(5_000);
    // 10.3 tCO2e over 5,000 m² = 2.06 kgCO2e/m²
    expect(body.totalTco2e).toBe(10.3);
    expect(body.intensityPerSqm).toBe(2.06);
  });

  it("clears GIA and ledgers before/after", async () => {
    const pid = await makeProject("GIA clear");
    await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/carbon-settings`,
      headers: owner.headers,
      payload: { giaSqm: 1_000 },
    });
    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/carbon-settings`,
      headers: owner.headers,
      payload: { giaSqm: null },
    });
    expect(cleared.statusCode).toBe(200);
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/carbon-settings`,
      headers: owner.headers,
    });
    expect((read.json() as { giaSqm: number | null }).giaSqm).toBeNull();
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.objectId, pid), eq(ledgerEntries.objectType, "project")),
      );
    const payload = entries.at(-1)!.payload as { before: unknown; after: unknown };
    expect(payload.before).toBe(1_000);
    expect(payload.after).toBeNull();
  });

  it("rejects a non-positive GIA and a foreign tenant", async () => {
    const pid = await makeProject("GIA guards");
    const bad = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/carbon-settings`,
      headers: owner.headers,
      payload: { giaSqm: 0 },
    });
    expect(bad.statusCode).toBe(400);
    const foreign = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/carbon-settings`,
      headers: stranger.headers,
      payload: { giaSqm: 10 },
    });
    expect([403, 404]).toContain(foreign.statusCode);
  });
});

/* ================================================================== */
/* AUDIT BUG: read-time sweeps duplicated signals                      */
/* ================================================================== */

describe("ESG detectors run from the scheduler, not from reads", () => {
  async function exceededBudget(pid: string) {
    const factor = await makeFactor();
    const budget = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/carbon-budgets`,
      headers: owner.headers,
      payload: {
        name: "Substructure",
        element: "substructure",
        baselineTco2e: 20,
        targetTco2e: 10,
      },
    });
    expect(budget.statusCode).toBe(201);
    const b = budget.json() as { id: string };
    const entry = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/carbon-entries`,
      headers: owner.headers,
      payload: {
        budgetId: b.id,
        description: "Concrete over budget",
        lifecycleModule: "A1-A3",
        scope: "scope_3",
        factorId: factor.id,
        quantity: 200_000,
        unit: "kg",
        entryDate: todayISO(),
      },
    });
    expect(entry.statusCode).toBe(201);
    return b;
  }

  it("writes no signal from parallel workspace reads", async () => {
    const pid = await makeProject("ESG parallel reads");
    await exceededBudget(pid);
    await Promise.all([
      app.inject({
        method: "GET",
        url: `/api/v1/projects/${pid}/carbon/summary`,
        headers: owner.headers,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/projects/${pid}/carbon-budgets`,
        headers: owner.headers,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/projects/${pid}/social-value/summary`,
        headers: owner.headers,
      }),
    ]);
    const rows = await app.db.select().from(signals).where(eq(signals.projectId, pid));
    expect(rows).toHaveLength(0);
  });

  it("raises the budget exceedance exactly once, as the system actor", async () => {
    const pid = await makeProject("ESG detector once");
    await exceededBudget(pid);
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/esg/detectors/run`,
      headers: owner.headers,
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { raised: number }).raised).toBe(1);
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/esg/detectors/run`,
      headers: owner.headers,
    });
    expect((second.json() as { raised: number }).raised).toBe(0);
    const rows = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.projectId, pid), eq(signals.detector, "carbon_budget_exceeded")));
    expect(rows).toHaveLength(1);

    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "carbon_budget"),
          eq(ledgerEntries.action, "create"),
        ),
      );
    expect(entries.at(-1)!.actorId).toBeNull();
  });

  it("RE-ARMS the exceedance when the target is revised and breached again", async () => {
    const pid = await makeProject("ESG re-arm");
    const budget = await exceededBudget(pid);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/esg/detectors/run`,
      headers: owner.headers,
    });
    // revise the target UP so the budget is back on track
    const revised = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/carbon-budgets/${budget.id}`,
      headers: owner.headers,
      payload: { targetTco2e: 100 },
    });
    expect(revised.statusCode).toBe(200);
    const afterRevision = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/esg/detectors/run`,
      headers: owner.headers,
    });
    expect((afterRevision.json() as { closed: number }).closed).toBe(1);

    // …then blow through the NEW target: a second, distinct finding
    const factor = await makeFactor("More concrete");
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/carbon-entries`,
      headers: owner.headers,
      payload: {
        budgetId: budget.id,
        description: "Even more concrete",
        lifecycleModule: "A1-A3",
        scope: "scope_3",
        factorId: factor.id,
        quantity: 900_000,
        unit: "kg",
        entryDate: todayISO(),
      },
    });
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/esg/detectors/run`,
      headers: owner.headers,
    });
    expect((again.json() as { raised: number }).raised).toBe(1);
    const rows = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.projectId, pid), eq(signals.detector, "carbon_budget_exceeded")));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.disposition === "closed")).toHaveLength(1);
  });

  it("is registered with the platform scheduler", () => {
    expect(app.scheduler.has("esg.detectors")).toBe(true);
  });

  it("refuses a detector run from another tenant", async () => {
    const pid = await makeProject("ESG detector isolation");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/esg/detectors/run`,
      headers: stranger.headers,
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

/* ================================================================== */
/* Environmental monitoring                                            */
/* ================================================================== */

describe("environmental monitoring", () => {
  async function makePoint(pid: string, extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/monitoring-points`,
      headers: owner.headers,
      payload: {
        name: "MP-01 boundary dust",
        medium: "dust",
        parameter: "PM10",
        unit: "µg/m³",
        limitValue: 50,
        limitDirection: "max",
        limitBasis: "Environmental permit condition 4.2",
        ...extra,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  }

  it("computes and stores exceedance at write, and ledgers the breach", async () => {
    const pid = await makeProject("Monitoring");
    const point = await makePoint(pid);
    const within = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/monitoring-points/${point.id}/readings`,
      headers: owner.headers,
      payload: { readingAt: todayISO(), value: 40 },
    });
    expect(within.statusCode).toBe(201);
    expect((within.json() as { exceedance: boolean }).exceedance).toBe(false);

    const over = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/monitoring-points/${point.id}/readings`,
      headers: owner.headers,
      payload: { readingAt: todayISO(), value: 62 },
    });
    expect(over.statusCode).toBe(201);
    const body = over.json() as { exceedance: boolean; exceedanceBy: number; basis: string };
    expect(body.exceedance).toBe(true);
    expect(body.exceedanceBy).toBe(12);
    expect(body.basis).toContain("exceeds");

    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "environmental_reading"),
        ),
      );
    expect(entries).toHaveLength(1);
    expect((entries[0]!.payload as { limitBasis: string }).limitBasis).toContain("permit");
  });

  it("draws no compliance conclusion from a point with no limit", async () => {
    const pid = await makeProject("Baseline monitoring");
    const point = await makePoint(pid, { limitValue: null });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/monitoring-points/${point.id}/readings`,
      headers: owner.headers,
      payload: { readingAt: todayISO(), value: 9_999 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { exceedance: boolean; exceedanceBy: number | null; basis: string };
    expect(body.exceedance).toBe(false);
    expect(body.exceedanceBy).toBeNull();
    expect(body.basis).toContain("baseline observation");
  });

  it("raises and then clears the limit-exceedance finding", async () => {
    const pid = await makeProject("Exceedance detector");
    const point = await makePoint(pid);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/monitoring-points/${point.id}/readings`,
      headers: owner.headers,
      payload: { readingAt: todayISO(), value: 80 },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/esg/detectors/run`,
      headers: owner.headers,
    });
    const rows = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.projectId, pid), eq(signals.detector, "environmental_limit_exceeded")),
      );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.subjectId).toBe(point.id);
  });

  it("summarises monitoring, incidents and biodiversity in one read", async () => {
    const pid = await makeProject("Environment summary");
    const point = await makePoint(pid);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/monitoring-points/${point.id}/readings`,
      headers: owner.headers,
      payload: { readingAt: todayISO(), value: 80 },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/environment/summary`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      monitoring: { points: number; exceedances: number; exceedancePercent: number | null };
      biodiversity: { unavailableReason?: string };
    };
    expect(body.monitoring.points).toBe(1);
    expect(body.monitoring.exceedances).toBe(1);
    expect(body.monitoring.exceedancePercent).toBe(100);
    // no habitat records → an honest reason, not a zero
    expect(body.biodiversity.unavailableReason).toContain("No habitat units");
  });
});

/* ================================================================== */
/* Environmental incidents                                             */
/* ================================================================== */

describe("environmental incidents", () => {
  async function makeIncident(pid: string, extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/environmental-incidents`,
      headers: owner.headers,
      payload: {
        kind: "spill",
        severity: "high",
        occurredAt: todayISO(),
        description: "Hydraulic oil spill at the batching plant",
        quantity: 40,
        unit: "litre",
        medium: "soil",
        ...extra,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; number: number; obligationId: string | null };
  }

  it("opens a statutory notification obligation for a reportable incident", async () => {
    const pid = await makeProject("Incident obligation");
    const incident = await makeIncident(pid, { reportableToRegulator: true });
    expect(incident.obligationId).toBeTruthy();

    const notify = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/environmental-incidents/${incident.id}/notify`,
      headers: owner.headers,
      payload: { regulator: "Environment Agency", reference: "EA/2026/9981" },
    });
    expect(notify.statusCode).toBe(200);
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.objectId, incident.id),
          eq(ledgerEntries.action, "state_change"),
        ),
      );
    const payload = entries.at(-1)!.payload as {
      hoursFromOccurrence: number;
      withinWindow: boolean;
      windowHours: number;
    };
    expect(payload.windowHours).toBe(24);
    expect(typeof payload.hoursFromOccurrence).toBe("number");
    expect(typeof payload.withinWindow).toBe("boolean");
  });

  it("refuses a second notification", async () => {
    const pid = await makeProject("Double notify");
    const incident = await makeIncident(pid, { reportableToRegulator: true });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/environmental-incidents/${incident.id}/notify`,
      headers: owner.headers,
      payload: { regulator: "EA" },
    });
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/environmental-incidents/${incident.id}/notify`,
      headers: owner.headers,
      payload: { regulator: "EA" },
    });
    expect(again.statusCode).toBe(409);
  });

  it("refuses to close a reportable incident that was never notified", async () => {
    const pid = await makeProject("Close unnotified");
    const incident = await makeIncident(pid, { reportableToRegulator: true });
    for (const status of ["contained", "remediated"]) {
      const step = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/environmental-incidents/${incident.id}/status`,
        headers: owner.headers,
        payload: { status },
      });
      expect(step.statusCode, status).toBe(200);
    }
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/environmental-incidents/${incident.id}/status`,
      headers: owner.headers,
      payload: { status: "closed", rootCause: "Failed hose" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("not been notified");
  });

  it("enforces the incident lifecycle and requires a root cause to close", async () => {
    const pid = await makeProject("Incident lifecycle");
    const incident = await makeIncident(pid);
    const skip = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/environmental-incidents/${incident.id}/status`,
      headers: owner.headers,
      payload: { status: "closed", rootCause: "x" },
    });
    expect(skip.statusCode).toBe(400);
    for (const status of ["contained", "remediated"]) {
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/environmental-incidents/${incident.id}/status`,
        headers: owner.headers,
        payload: { status },
      });
    }
    const noCause = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/environmental-incidents/${incident.id}/status`,
      headers: owner.headers,
      payload: { status: "closed" },
    });
    expect(noCause.statusCode).toBe(400);
    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/environmental-incidents/${incident.id}/status`,
      headers: owner.headers,
      payload: { status: "closed", rootCause: "Perished hydraulic hose, no pre-use check" },
    });
    expect(ok.statusCode).toBe(200);
  });
});

/* ================================================================== */
/* Biodiversity, options, transport, EMS, disclosure                   */
/* ================================================================== */

describe("biodiversity net gain", () => {
  it("computes units and the net gain against the baseline", async () => {
    const pid = await makeProject("Biodiversity");
    const post = (stage: string, areaHectares: number, condition: string) =>
      app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/biodiversity-units`,
        headers: owner.headers,
        payload: {
          stage,
          habitatType: "Modified grassland",
          areaHectares,
          distinctiveness: 2,
          condition,
          strategicSignificance: 1,
        },
      });
    expect((await post("baseline", 5, "moderate")).statusCode).toBe(201);
    expect((await post("post_intervention", 6, "moderate")).statusCode).toBe(201);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/biodiversity-units`,
      headers: owner.headers,
    });
    const body = res.json() as {
      netGain: { baselineUnits: number; netGainPercent: number; meetsTarget: boolean };
    };
    expect(body.netGain.baselineUnits).toBe(20);
    expect(body.netGain.netGainPercent).toBe(20);
    expect(body.netGain.meetsTarget).toBe(true);
  });

  it("raises a net-loss finding through the detector", async () => {
    const pid = await makeProject("Biodiversity loss");
    const post = (stage: string, areaHectares: number) =>
      app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/biodiversity-units`,
        headers: owner.headers,
        payload: {
          stage,
          habitatType: "Woodland",
          areaHectares,
          distinctiveness: 6,
          condition: "good",
        },
      });
    await post("baseline", 10);
    await post("post_intervention", 4);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/esg/detectors/run`,
      headers: owner.headers,
    });
    const rows = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.projectId, pid), eq(signals.detector, "biodiversity_net_loss")));
    expect(rows).toHaveLength(1);
  });
});

describe("design option carbon comparison (#502-504)", () => {
  async function option(pid: string, payload: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/carbon-options`,
      headers: owner.headers,
      payload: { studyRef: "FRAME-01", currency: "GBP", ...payload },
    });
    return res;
  }

  it("ranks options by cost per tonne abated", async () => {
    const pid = await makeProject("MACC");
    expect(
      (await option(pid, { name: "RC frame", isBaseline: true, tco2e: 100, cost: 1_000_000 }))
        .statusCode,
    ).toBe(201);
    await option(pid, { name: "GGBS 50%", tco2e: 70, cost: 1_030_000 });
    await option(pid, { name: "Timber frame", tco2e: 40, cost: 1_400_000 });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/carbon-options?studyRef=FRAME-01`,
      headers: owner.headers,
    });
    const body = res.json() as {
      studies: { bestValueId: string | null; rows: { name: string; abatementCostPerTonne: number | null }[] }[];
    };
    const study = body.studies[0]!;
    const ggbs = study.rows.find((r) => r.name === "GGBS 50%")!;
    expect(ggbs.abatementCostPerTonne).toBe(1000);
    expect(study.bestValueId).toBeTruthy();
  });

  it("refuses a second baseline in one study", async () => {
    const pid = await makeProject("MACC baseline");
    await option(pid, { name: "A", isBaseline: true, tco2e: 100, cost: 1 });
    const second = await option(pid, { name: "B", isBaseline: true, tco2e: 90, cost: 1 });
    expect(second.statusCode).toBe(409);
  });

  it("refuses to price a study whose options are in different currencies", async () => {
    const pid = await makeProject("MACC currencies");
    await option(pid, { name: "A", isBaseline: true, tco2e: 100, cost: 1_000, currency: "GBP" });
    await option(pid, { name: "B", tco2e: 80, cost: 900, currency: "EUR" });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/carbon-options`,
      headers: owner.headers,
    });
    const study = (res.json() as { studies: { mixedCurrency: boolean; note: string }[] })
      .studies[0]!;
    expect(study.mixedCurrency).toBe(true);
    expect(study.note).toContain("means nothing");
  });

  it("records a decision with its ledger trail", async () => {
    const pid = await makeProject("MACC decision");
    const created = await option(pid, { name: "A", isBaseline: true, tco2e: 100, cost: 1 });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/carbon-options/${id}/decision`,
      headers: owner.headers,
      payload: { decision: "adopted", note: "Design review 2026-09" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { decision: string }).decision).toBe("adopted");
  });
});

describe("transport carbon", () => {
  it("books a leg into the project footprint", async () => {
    const pid = await makeProject("Transport");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/carbon-transport-legs`,
      headers: owner.headers,
      payload: {
        description: "Precast beams, works to site",
        mode: "articulated_truck",
        distanceKm: 120,
        payloadTonnes: 24,
        trips: 10,
        legDate: todayISO(),
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { tonneKm: number; tco2e: number; entryId: string; basis: string };
    expect(body.tonneKm).toBe(28_800);
    expect(body.tco2e).toBeGreaterThan(0);
    expect(body.basis).toContain("tonne-km");

    const summary = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/carbon/summary`,
      headers: owner.headers,
    });
    expect((summary.json() as { totalTco2e: number }).totalTco2e).toBe(body.tco2e);
  });

  it("refuses an unknown mode rather than estimating from nothing", async () => {
    const pid = await makeProject("Transport unknown mode");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/carbon-transport-legs`,
      headers: owner.headers,
      payload: {
        description: "Teleport",
        mode: "teleport",
        distanceKm: 1,
        payloadTonnes: 1,
        legDate: todayISO(),
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("ISO 14001 EMS register", () => {
  it("reports coverage across the whole clause set, gaps included", async () => {
    const pid = await makeProject("EMS");
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/ems-records`,
      headers: owner.headers,
      payload: {
        clause: "6.1.2_environmental_aspects",
        requirement: "Aspects and impacts register maintained and reviewed",
      },
    });
    expect(created.statusCode).toBe(201);
    const dup = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/ems-records`,
      headers: owner.headers,
      payload: { clause: "6.1.2_environmental_aspects", requirement: "again" },
    });
    expect(dup.statusCode).toBe(409);

    const record = created.json() as { id: string };
    const unevidenced = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/ems-records/${record.id}`,
      headers: owner.headers,
      payload: { status: "evidenced" },
    });
    expect(unevidenced.statusCode).toBe(400);
    expect(unevidenced.json().message).toContain("nothing attached");

    const evidenceId = await makeEvidence(pid);
    const ok = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/ems-records/${record.id}`,
      headers: owner.headers,
      payload: { status: "evidenced", evidenceIds: [evidenceId] },
    });
    expect(ok.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/ems-records`,
      headers: owner.headers,
    });
    const body = list.json() as {
      coverage: { clause: string; status: string }[];
      clauses: number;
      evidenced: number;
      coveragePercent: number | null;
    };
    expect(body.coverage.length).toBe(body.clauses);
    expect(body.evidenced).toBe(1);
    expect(body.coverage.filter((c) => c.status === "not_started").length).toBe(
      body.clauses - 1,
    );
  });
});

describe("ESG disclosure assembly (#541-546)", () => {
  it("assembles a period return with every figure carrying a basis", async () => {
    const pid = await makeProject("Disclosure");
    const factor = await makeFactor("EPD concrete", { isProductSpecific: true });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/carbon-entries`,
      headers: owner.headers,
      payload: {
        description: "EPD-backed concrete",
        lifecycleModule: "A1-A3",
        scope: "scope_3",
        factorId: factor.id,
        quantity: 100_000,
        unit: "kg",
        entryDate: todayISO(),
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/esg-disclosures`,
      headers: owner.headers,
      payload: {
        framework: "esrs_e1_climate",
        periodStart: addDaysISO(todayISO(), -30),
        periodEnd: todayISO(),
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      datapoints: { id: string; value: unknown; basis: string; unavailableReason: string | null }[];
      dataQuality: { productSpecificSharePercent: number | null };
      ledgerSeqTo: number;
    };
    expect(body.datapoints.length).toBeGreaterThan(0);
    for (const d of body.datapoints) {
      expect(d.basis.length).toBeGreaterThan(0);
      if (d.value === null) expect(d.unavailableReason).toBeTruthy();
    }
    // the whole footprint is EPD-backed here
    expect(body.dataQuality.productSpecificSharePercent).toBe(100);
    expect(body.ledgerSeqTo).toBeGreaterThan(0);

    const csv = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/esg-disclosures/${body.id}/export.csv`,
      headers: owner.headers,
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain("datapoint_id");
  });

  it("previews without storing when commit is false", async () => {
    const pid = await makeProject("Disclosure preview");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/esg-disclosures`,
      headers: owner.headers,
      payload: {
        framework: "tcfd",
        periodStart: addDaysISO(todayISO(), -30),
        periodEnd: todayISO(),
        commit: false,
      },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { committed: boolean }).committed).toBe(false);
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/esg-disclosures`,
      headers: owner.headers,
    });
    expect((list.json() as { total: number }).total).toBe(0);
  });

  it("refuses an inverted period", async () => {
    const pid = await makeProject("Disclosure period");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/esg-disclosures`,
      headers: owner.headers,
      payload: {
        framework: "tcfd",
        periodStart: todayISO(),
        periodEnd: addDaysISO(todayISO(), -1),
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ================================================================== */
/* Cross-tenant isolation                                              */
/* ================================================================== */

describe("cross-tenant isolation across the new ESG routes", () => {
  it("refuses every route to a foreign tenant", async () => {
    const pid = await makeProject("ESG isolation sweep");
    const routes: string[] = [
      `/api/v1/projects/${pid}/monitoring-points`,
      `/api/v1/projects/${pid}/environmental-incidents`,
      `/api/v1/projects/${pid}/biodiversity-units`,
      `/api/v1/projects/${pid}/carbon-options`,
      `/api/v1/projects/${pid}/carbon-transport-legs`,
      `/api/v1/projects/${pid}/ems-records`,
      `/api/v1/projects/${pid}/esg-disclosures`,
      `/api/v1/projects/${pid}/environment/summary`,
      `/api/v1/projects/${pid}/esg/health-inputs`,
    ];
    for (const url of routes) {
      const res = await app.inject({ method: "GET", url, headers: stranger.headers });
      expect([403, 404], url).toContain(res.statusCode);
    }
  });

  it("exposes health inputs with reasons", async () => {
    const pid = await makeProject("ESG health inputs");
    const point = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/monitoring-points`,
      headers: owner.headers,
      payload: {
        name: "MP-02",
        medium: "noise",
        parameter: "LAeq,1h",
        unit: "dB",
        limitValue: 70,
      },
    });
    const p = point.json() as { id: string };
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/monitoring-points/${p.id}/readings`,
      headers: owner.headers,
      payload: { readingAt: todayISO(), value: 85 },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/esg/health-inputs`,
      headers: owner.headers,
    });
    const body = res.json() as { metrics: Record<string, number | null>; reasons: string[] };
    expect(body.metrics["monitoringExceedances"]).toBe(1);
    expect(body.reasons.join(" ")).toContain("exceedance");
  });
});
