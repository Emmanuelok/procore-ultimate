/**
 * Supply chain — map, supplier risk, long-lead register, JIT, scheduler jobs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  entities,
  notifications,
  obligations,
  prequalificationFinancials,
  projectMemberships,
  projects,
  scheduleTasks,
  schedules,
  signals,
  supplierRiskAssessments,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";
import { supplychainModule } from "./index.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let verifier: TestActor;
let viewerHeaders: Record<string, string>;
let stranger: TestActor;
let projectId: string;
let vendorId: string;
let entityId: string;
let criticalTaskId: string;

const today = todayISO();

function post(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload });
}
function patch(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
}
function get(url: string, headers = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}
function del(url: string, headers = owner.headers) {
  return app.inject({ method: "DELETE", url: `/api/v1${url}`, headers });
}

async function signalsFor(detector: string) {
  return app.db.select().from(signals).where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, detector)));
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  // Until the orchestrator wires the module in app.ts, mount it here; the
  // scheduler job name doubles as the "already registered" probe.
  if (!app.scheduler.has("supplychain.long-lead")) await app.register(supplychainModule, { prefix: "/api/v1" });
  owner = await registerActor(app);

  verifier = await registerActor(app);
  await app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: verifier.userId, role: "admin" });
  verifier = { ...verifier, companyId: owner.companyId, headers: { authorization: verifier.headers["authorization"]!, "x-company-id": owner.companyId } };

  const viewer = await registerActor(app);
  await app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: viewer.userId, role: "member" });
  viewerHeaders = { authorization: viewer.headers["authorization"]!, "x-company-id": owner.companyId };

  stranger = await registerActor(app);

  projectId = newId("prj");
  await app.db.insert(projects).values({ id: projectId, companyId: owner.companyId, name: "Supply chain — core", stage: "course_of_construction" });
  await app.db.insert(projectMemberships).values({ id: newId("pm"), companyId: owner.companyId, projectId, userId: viewer.userId, templateKey: "read_only" });

  vendorId = newId("ven");
  await app.db.insert(vendors).values({ id: vendorId, companyId: owner.companyId, name: "Fabricators Ltd", country: "GB" });
  await app.db.insert(prequalificationFinancials).values({
    id: newId("pqf"),
    companyId: owner.companyId,
    vendorId,
    financialYearEnd: "2025-12-31",
    currentRatio: 0.6,
    netAssets: -25_000,
    isGoingConcernQualified: 1,
    createdBy: owner.userId,
  });
  entityId = newId("ent");
  await app.db.insert(entities).values({ id: entityId, companyId: owner.companyId, kind: "company", name: "Shanxi Mill Co", screeningStatus: "sanctions_hit", screenedAt: new Date().toISOString() });

  const scheduleId = newId("sch");
  await app.db.insert(schedules).values({ id: scheduleId, companyId: owner.companyId, projectId, name: "Baseline", projectStart: today, createdBy: owner.userId });
  criticalTaskId = newId("tsk");
  await app.db.insert(scheduleTasks).values({
    id: criticalTaskId,
    scheduleId,
    projectId,
    name: "Erect steel frame L3",
    durationDays: 10,
    startDate: addDaysISO(today, 20),
    finishDate: addDaysISO(today, 30),
    isCritical: 1,
  });
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* Map                                                                 */
/* ================================================================== */

let fabId: string;
let millId: string;
let mill2Id: string;
let portId: string;
let linkId: string;

describe("supply chain map", () => {
  it("builds a tiered map with links and refuses bad edges", async () => {
    const fab = await post(`/projects/${projectId}/supply-chain/nodes`, { name: "Fabricators Ltd", kind: "fabricator", tier: 1, country: "gb", criticality: "critical", categories: ["steel"], vendorId });
    expect(fab.statusCode).toBe(201);
    fabId = fab.json().id;
    expect(fab.json().country).toBe("GB");

    const mill = await post(`/projects/${projectId}/supply-chain/nodes`, { name: "Shanxi Mill", kind: "manufacturer", tier: 2, country: "CN", criticality: "critical", entityId });
    millId = mill.json().id;
    const mill2 = await post(`/projects/${projectId}/supply-chain/nodes`, { name: "Cladding Works", kind: "manufacturer", tier: 2, country: "CN", criticality: "high" });
    mill2Id = mill2.json().id;
    const port = await post(`/projects/${projectId}/supply-chain/nodes`, { name: "Port agent", kind: "port", tier: 3, criticality: "low" });
    portId = port.json().id;

    const link = await post(`/projects/${projectId}/supply-chain/links`, { fromNodeId: millId, toNodeId: fabId, kind: "supplies", category: "steel", isSoleSource: true });
    expect(link.statusCode).toBe(201);
    linkId = link.json().id;
    expect((await post(`/projects/${projectId}/supply-chain/links`, { fromNodeId: mill2Id, toNodeId: fabId, kind: "supplies", category: "cladding" })).statusCode).toBe(201);

    const dup = await post(`/projects/${projectId}/supply-chain/links`, { fromNodeId: millId, toNodeId: fabId, kind: "supplies" });
    expect(dup.statusCode).toBe(409);
    const self = await post(`/projects/${projectId}/supply-chain/links`, { fromNodeId: millId, toNodeId: millId });
    expect(self.statusCode).toBe(400);
    const foreign = await post(`/projects/${projectId}/supply-chain/links`, { fromNodeId: millId, toNodeId: "scn_nope" });
    expect(foreign.statusCode).toBe(400);

    const badVendor = await post(`/projects/${projectId}/supply-chain/nodes`, { name: "X", vendorId: "ven_missing" });
    expect(badVendor.statusCode).toBe(400);

    const map = await get(`/projects/${projectId}/supply-chain/map`);
    expect(map.statusCode).toBe(200);
    expect(map.json().stats.nodes).toBe(4);
    expect(map.json().stats.links).toBe(2);
    expect(map.json().stats.soleSourceLinks).toBe(1);
    expect(map.json().stats.byTier).toEqual({ "1": 1, "2": 2, "3": 1 });
    expect(map.json().stats.byCountry["unknown"]).toBe(1);
  });

  it("lists, filters, reads and patches nodes", async () => {
    const tier2 = await get(`/projects/${projectId}/supply-chain/nodes?tier=2`);
    expect(tier2.json().total).toBe(2);
    const q = await get(`/projects/${projectId}/supply-chain/nodes?q=shanxi`);
    expect(q.json().items.map((n: { id: string }) => n.id)).toEqual([millId]);

    const detail = await get(`/projects/${projectId}/supply-chain/nodes/${fabId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().upstream).toHaveLength(2);
    expect(detail.json().downstream).toHaveLength(0);

    const patched = await patch(`/projects/${projectId}/supply-chain/nodes/${portId}`, { city: "Felixstowe", country: "GB", status: "inactive" });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().city).toBe("Felixstowe");
    expect(patched.json().status).toBe("inactive");
    // Regression: a partial PATCH must not reset the defaults of untouched columns.
    expect(patched.json().tier).toBe(3);
    expect(patched.json().criticality).toBe("low");
    expect(patched.json().kind).toBe("port");
  });

  it("enforces tool levels and tenant isolation", async () => {
    expect((await get(`/projects/${projectId}/supply-chain/nodes`, viewerHeaders)).statusCode).toBe(200);
    expect((await post(`/projects/${projectId}/supply-chain/nodes`, { name: "nope" }, viewerHeaders)).statusCode).toBe(403);
    expect((await get(`/projects/${projectId}/supply-chain/map`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`/projects/${projectId}/supply-chain/nodes/${fabId}`, stranger.headers)).statusCode).toBe(403);
    expect((await patch(`/projects/${projectId}/supply-chain/nodes/${fabId}`, { name: "hijack" }, stranger.headers)).statusCode).toBe(403);
    // a node id from another tenant's project is not found inside this one
    const otherProject = newId("prj");
    await app.db.insert(projects).values({ id: otherProject, companyId: stranger.companyId, name: "Stranger project" });
    expect((await get(`/projects/${otherProject}/supply-chain/nodes/${fabId}`, stranger.headers)).statusCode).toBe(404);
  });
});

/* ================================================================== */
/* Supplier risk                                                       */
/* ================================================================== */

describe("supplier risk engine", () => {
  it("scores every node from what the platform holds and raises signals once", async () => {
    const before = await get(`/projects/${projectId}/supply-chain/risk`);
    expect(before.json().reasons[0]).toMatch(/has not run/);

    const run = await post(`/projects/${projectId}/supply-chain/risk/run`, {});
    expect(run.statusCode).toBe(200);
    const body = run.json();
    expect(body.nodes).toBe(4);
    expect(body.snapshotsWritten).toBe(4);
    expect(body.concentration.flagged.map((b: { country: string }) => b.country)).toEqual(["CN"]);
    const fab = body.assessments.find((a: { nodeId: string }) => a.nodeId === fabId);
    expect(fab.level).toBe("critical");
    expect(fab.flags.map((f: { code: string }) => f.code)).toEqual(expect.arrayContaining(["going_concern", "financial_distress"]));
    const mill = body.assessments.find((a: { nodeId: string }) => a.nodeId === millId);
    expect(mill.flags.map((f: { code: string }) => f.code)).toEqual(expect.arrayContaining(["single_source", "sanctions_hit", "country_concentration"]));

    expect((await signalsFor("supply_sanctions")).length).toBe(1);
    expect((await signalsFor("supply_financial_distress")).length).toBeGreaterThanOrEqual(1);
    expect((await signalsFor("supply_single_source_critical")).length).toBeGreaterThanOrEqual(1);
    expect((await signalsFor("supply_country_concentration")).length).toBe(1);

    const again = await post(`/projects/${projectId}/supply-chain/risk/run`, {});
    expect(again.json().signalsRaised).toBe(0);
    expect(again.json().snapshotsWritten).toBe(0);
    expect(again.json().unchanged).toBe(4);
    expect((await signalsFor("supply_sanctions")).length).toBe(1);
    const snapshots = await app.db.select().from(supplierRiskAssessments).where(eq(supplierRiskAssessments.projectId, projectId));
    expect(snapshots).toHaveLength(4);

    const view = await get(`/projects/${projectId}/supply-chain/risk`);
    expect(view.json().summary.critical).toBe(2);
    expect(view.json().lastRunAt).not.toBeNull();
    const history = await get(`/projects/${projectId}/supply-chain/risk/assessments?nodeId=${fabId}`);
    expect(history.json().total).toBe(1);
    expect(history.json().items[0].basis).toMatch(/prequalification financials/);

    const map = await get(`/projects/${projectId}/supply-chain/map`);
    expect(map.json().stats.byRiskLevel.critical).toBe(2);
  });

  it("runs as a scheduler job", async () => {
    const status = await app.scheduler.runNow("supplychain.supplier-risk");
    expect(status.state).toBe("succeeded");
    expect((await signalsFor("supply_sanctions")).length).toBe(1);
  });

  it("is invisible to another tenant", async () => {
    expect((await get(`/projects/${projectId}/supply-chain/risk`, stranger.headers)).statusCode).toBe(403);
    expect((await post(`/projects/${projectId}/supply-chain/risk/run`, {}, stranger.headers)).statusCode).toBe(403);
    expect((await post(`/projects/${projectId}/supply-chain/risk/run`, {}, viewerHeaders)).statusCode).toBe(403);
  });
});

/* ================================================================== */
/* Long-lead                                                           */
/* ================================================================== */

let lateItemId: string;
let obligationId: string;

describe("long-lead register", () => {
  it("derives required-on-site from the programme and the order-by date from lead time", async () => {
    const res = await post(`/projects/${projectId}/supply-chain/long-lead`, {
      name: "Structural steel L3",
      supplierNodeId: fabId,
      vendorId,
      scheduleTaskId: criticalTaskId,
      leadTimeDays: 60,
      bufferDays: 0,
      value: 250_000,
      currency: "GBP",
    });
    expect(res.statusCode).toBe(201);
    const item = res.json();
    lateItemId = item.id;
    expect(item.reference).toBe("LLI-001");
    expect(item.requiredOnSite).toBe(addDaysISO(today, 20));
    expect(item.requiredFromSchedule).toBe(1);
    expect(item.scheduleTaskName).toBe("Erect steel frame L3");
    expect(item.orderByDate).toBe(addDaysISO(today, -40));
    expect(item.riskLevel).toBe("late");
    expect(item.assessment.reasons.some((r: string) => /order-by date .* passed 40 day/.test(r))).toBe(true);

    const detail = await get(`/projects/${projectId}/supply-chain/long-lead/${lateItemId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().task.isCritical).toBe(true);
    obligationId = detail.json().obligationId;
    expect(obligationId).toBeTruthy();
    const [obl] = await app.db.select().from(obligations).where(eq(obligations.id, obligationId));
    expect(obl?.status).toBe("open");
    expect(obl?.deadline?.slice(0, 10)).toBe(addDaysISO(today, -40));
  });

  it("raises a late signal once through the sweep and tells the owner", async () => {
    const sweep = await post(`/projects/${projectId}/supply-chain/long-lead/recompute`, {});
    expect(sweep.statusCode).toBe(200);
    expect(sweep.json().signalsRaised).toBe(1);
    const late = await signalsFor("supply_long_lead_late");
    expect(late).toHaveLength(1);
    expect(late[0]?.severity).toBe("critical");
    expect((late[0]?.evidenceRefs as { key: string }).key).toBe(`lli:${lateItemId}:late`);
    const again = await post(`/projects/${projectId}/supply-chain/long-lead/recompute`, {});
    expect(again.json().signalsRaised).toBe(0);
    const notes = await app.db.select().from(notifications).where(and(eq(notifications.userId, owner.userId), eq(notifications.kind, "supply_chain")));
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes[0]?.recordId).toBe(lateItemId);
    const job = await app.scheduler.runNow("supplychain.long-lead");
    expect(job.state).toBe("succeeded");
    expect((await signalsFor("supply_long_lead_late")).length).toBe(1);
  });

  it("records milestones in order, satisfies the obligation on ordering, and logs expediting", async () => {
    const skip = await post(`/projects/${projectId}/supply-chain/long-lead/${lateItemId}/milestones`, { milestone: "shipped" });
    expect(skip.statusCode).toBe(400);
    const ordered = await post(`/projects/${projectId}/supply-chain/long-lead/${lateItemId}/milestones`, { milestone: "ordered", at: today });
    expect(ordered.statusCode).toBe(200);
    expect(ordered.json().status).toBe("ordered");
    expect(ordered.json().actualOrderDate).toBe(today);
    const [obl] = await app.db.select().from(obligations).where(eq(obligations.id, obligationId));
    expect(obl?.status).toBe("satisfied");

    const chase = await post(`/projects/${projectId}/supply-chain/long-lead/${lateItemId}/expedite`, { action: "promise_received", contactName: "Sam", promisedDate: addDaysISO(today, 18), note: "Mill slot confirmed" });
    expect(chase.statusCode).toBe(201);
    expect(chase.json().expeditingCount).toBe(1);
    expect(chase.json().forecastArrivalDate).toBe(addDaysISO(today, 18));
    expect(chase.json().riskLevel).toBe("at_risk");

    const detail = await get(`/projects/${projectId}/supply-chain/long-lead/${lateItemId}`);
    expect(detail.json().expeditingLog).toHaveLength(1);

    for (const milestone of ["production_started", "shipped", "arrived", "installed"]) {
      const r = await post(`/projects/${projectId}/supply-chain/long-lead/${lateItemId}/milestones`, { milestone, at: today });
      expect(r.statusCode).toBe(200);
    }
    const done = await get(`/projects/${projectId}/supply-chain/long-lead/${lateItemId}`);
    expect(done.json().status).toBe("installed");
    expect(done.json().riskLevel).toBe("on_track");
    expect((await patch(`/projects/${projectId}/supply-chain/long-lead/${lateItemId}`, { name: "x" })).statusCode).toBe(200);
    expect((await post(`/projects/${projectId}/supply-chain/long-lead/${lateItemId}/expedite`, { action: "call" })).statusCode).toBe(400);
  });

  it("takes a typed need date off the programme and waives the obligation on cancel", async () => {
    const res = await post(`/projects/${projectId}/supply-chain/long-lead`, { name: "Lift motor", leadTimeDays: 30, requiredOnSite: addDaysISO(today, 120) });
    expect(res.statusCode).toBe(201);
    const item = res.json();
    expect(item.riskLevel).toBe("on_track");
    expect(item.orderByDate).toBe(addDaysISO(today, 90));
    const withTask = await patch(`/projects/${projectId}/supply-chain/long-lead/${item.id}`, { scheduleTaskId: criticalTaskId });
    expect(withTask.json().requiredOnSite).toBe(addDaysISO(today, 120));
    expect(withTask.json().requiredFromSchedule).toBe(0);
    expect(withTask.json().leadTimeDays).toBe(30);
    expect(withTask.json().orderByDate).toBe(addDaysISO(today, 90));
    const followProgramme = await patch(`/projects/${projectId}/supply-chain/long-lead/${item.id}`, { requiredOnSite: null });
    expect(followProgramme.json().requiredOnSite).toBe(addDaysISO(today, 20));
    expect(followProgramme.json().requiredFromSchedule).toBe(1);
    expect(followProgramme.json().riskLevel).toBe("late");

    const detail = await get(`/projects/${projectId}/supply-chain/long-lead/${item.id}`);
    const oblId = detail.json().obligationId as string;
    const cancel = await post(`/projects/${projectId}/supply-chain/long-lead/${item.id}/cancel`, { reason: "Scope removed" });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe("cancelled");
    const [obl] = await app.db.select().from(obligations).where(eq(obligations.id, oblId));
    expect(obl?.status).toBe("waived");
    expect((await patch(`/projects/${projectId}/supply-chain/long-lead/${item.id}`, { name: "x" })).statusCode).toBe(400);

    const list = await get(`/projects/${projectId}/supply-chain/long-lead?status=cancelled`);
    expect(list.json().total).toBe(1);
  });

  it("refuses references outside the project and other tenants", async () => {
    expect((await post(`/projects/${projectId}/supply-chain/long-lead`, { name: "x", scheduleTaskId: "tsk_nope" })).statusCode).toBe(400);
    expect((await post(`/projects/${projectId}/supply-chain/long-lead`, { name: "x", materialItemId: "mat_nope" })).statusCode).toBe(400);
    expect((await post(`/projects/${projectId}/supply-chain/long-lead`, { name: "x", supplierNodeId: "scn_nope" })).statusCode).toBe(400);
    expect((await get(`/projects/${projectId}/supply-chain/long-lead/${lateItemId}`, stranger.headers)).statusCode).toBe(403);
    expect((await post(`/projects/${projectId}/supply-chain/long-lead`, { name: "x" }, viewerHeaders)).statusCode).toBe(403);
    expect((await get(`/projects/${projectId}/supply-chain/long-lead`, viewerHeaders)).statusCode).toBe(200);
  });

  it("refuses deleting a node that still supplies an open item", async () => {
    const item = await post(`/projects/${projectId}/supply-chain/long-lead`, { name: "Cladding panels", supplierNodeId: mill2Id, leadTimeDays: 10, requiredOnSite: addDaysISO(today, 90) });
    expect(item.statusCode).toBe(201);
    expect((await del(`/projects/${projectId}/supply-chain/nodes/${mill2Id}`)).statusCode).toBe(400);
    expect((await del(`/projects/${projectId}/supply-chain/links/${linkId}`)).statusCode).toBe(204);
    expect((await del(`/projects/${projectId}/supply-chain/nodes/${portId}`, viewerHeaders)).statusCode).toBe(403);
    expect((await del(`/projects/${projectId}/supply-chain/nodes/${portId}`)).statusCode).toBe(204);
  });
});

/* ================================================================== */
/* Just-in-time                                                        */
/* ================================================================== */

describe("just-in-time linkage", () => {
  it("detects a forecast after the task start and raises one signal", async () => {
    const res = await post(`/projects/${projectId}/supply-chain/long-lead`, {
      name: "Steel connections",
      scheduleTaskId: criticalTaskId,
      leadTimeDays: 5,
      plannedArrivalDate: addDaysISO(today, 15),
      forecastArrivalDate: addDaysISO(today, 25),
    });
    expect(res.statusCode).toBe(201);
    await post(`/projects/${projectId}/supply-chain/long-lead/${res.json().id}/milestones`, { milestone: "ordered", at: today });

    const conflicts = await get(`/projects/${projectId}/supply-chain/jit/conflicts`);
    expect(conflicts.statusCode).toBe(200);
    const mine = conflicts.json().items.find((c: { sourceId: string }) => c.sourceId === res.json().id);
    expect(mine.kind).toBe("forecast_after_task_start");
    expect(mine.severity).toBe("high");
    expect(mine.daysDelta).toBe(5);

    const run = await post(`/projects/${projectId}/supply-chain/jit/run`, {});
    expect(run.json().signalsRaised).toBeGreaterThanOrEqual(1);
    const count = (await signalsFor("supply_jit_conflict")).length;
    const again = await post(`/projects/${projectId}/supply-chain/jit/run`, {});
    expect(again.json().signalsRaised).toBe(0);
    expect((await signalsFor("supply_jit_conflict")).length).toBe(count);
    const job = await app.scheduler.runNow("supplychain.jit");
    expect(job.state).toBe("succeeded");
    expect((await signalsFor("supply_jit_conflict")).length).toBe(count);
    expect((await get(`/projects/${projectId}/supply-chain/jit/conflicts`, stranger.headers)).statusCode).toBe(403);
  });
});
