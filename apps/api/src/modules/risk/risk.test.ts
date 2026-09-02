import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  ledgerEntries,
  projects,
  riskSimulations,
  scheduleDependencies,
  scheduleTasks,
  schedules,
  signals,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let projectId: string;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Quantitative Risk Test Project",
  });
});

afterAll(async () => {
  await built.close();
});

async function makeProject(name: string): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({ id, companyId: owner.companyId, name });
  return id;
}

async function createRisk(pid: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/risks`,
    headers: owner.headers,
    payload: {
      title: "Test risk",
      category: "technical",
      probabilityScore: 3,
      impactScore: 3,
      ...payload,
    },
  });
}

/** Seeded schedule fixture: A(10d) → B(5d) FS, project start 2026-01-05. */
async function insertSchedule(pid: string): Promise<{
  scheduleId: string;
  taskA: string;
  taskB: string;
}> {
  const scheduleId = newId("sch");
  await app.db.insert(schedules).values({
    id: scheduleId,
    companyId: owner.companyId,
    projectId: pid,
    name: "QSRA fixture",
    projectStart: "2026-01-05",
    isActive: 1,
    createdBy: owner.userId,
  });
  const taskA = newId("tsk");
  const taskB = newId("tsk");
  await app.db.insert(scheduleTasks).values([
    { id: taskA, scheduleId, projectId: pid, name: "Groundworks", durationDays: 10, sortOrder: 1 },
    { id: taskB, scheduleId, projectId: pid, name: "Frame", durationDays: 5, sortOrder: 2 },
  ]);
  await app.db.insert(scheduleDependencies).values({
    id: newId("dep"),
    scheduleId,
    predecessorId: taskA,
    successorId: taskB,
    depType: "FS",
    lagDays: 0,
  });
  return { scheduleId, taskA, taskB };
}

/* ------------------------------------------------------------------ */
/* Register + distribution validation                                  */
/* ------------------------------------------------------------------ */

describe("risk register", () => {
  it("rejects malformed distributions with 400 (min<=mode<=max etc.)", async () => {
    const minAboveMode = await createRisk(projectId, {
      costImpact: { kind: "triangular", min: 5000, mode: 2000, max: 10000 },
      occurrenceProbability: 0.5,
    });
    expect(minAboveMode.statusCode).toBe(400);

    const modeAboveMax = await createRisk(projectId, {
      costImpact: { kind: "pert", min: 1000, mode: 2000, max: 1500 },
    });
    expect(modeAboveMax.statusCode).toBe(400);

    const invertedUniform = await createRisk(projectId, {
      costImpact: { kind: "uniform", min: 5, max: 2 },
    });
    expect(invertedUniform.statusCode).toBe(400);

    const emptyDiscrete = await createRisk(projectId, {
      costImpact: { kind: "discrete", values: [] },
    });
    expect(emptyDiscrete.statusCode).toBe(400);

    const negativeStdDev = await createRisk(projectId, {
      costImpact: { kind: "normal", mean: 100, stdDev: -1 },
    });
    expect(negativeStdDev.statusCode).toBe(400);
  });

  it("creates risks with sequential 'risk' numbering and qualitative scores", async () => {
    const first = await createRisk(projectId, {
      title: "Ground conditions worse than survey",
      probabilityScore: 4,
      impactScore: 4,
      postProbabilityScore: 2,
      postImpactScore: 2,
      occurrenceProbability: 0.5,
      costImpact: { kind: "triangular", min: 1000, mode: 2000, max: 6000 },
      mitigationCost: 500,
    });
    expect(first.statusCode).toBe(201);
    const r1 = first.json() as Record<string, unknown>;
    expect(r1["number"]).toBe(1);
    expect(r1["status"]).toBe("open");
    expect(r1["preScore"]).toBe(16);
    expect(r1["postScore"]).toBe(4);

    const second = await createRisk(projectId, {
      title: "Steel price escalation",
      category: "commercial",
      probabilityScore: 3,
      impactScore: 5,
    });
    expect(second.statusCode).toBe(201);
    const r2 = second.json() as Record<string, unknown>;
    expect(r2["number"]).toBe(2);
    expect(r2["preScore"]).toBe(15);
    expect(r2["postScore"]).toBeNull();
  });

  it("lists with pre/post scores and category/status filters", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/risks?category=commercial`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Record<string, unknown>[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]!["category"]).toBe("commercial");
    expect(body.items[0]!["preScore"]).toBe(15);

    const all = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/risks`,
      headers: owner.headers,
    });
    expect((all.json() as { total: number }).total).toBe(2);
  });

  it("changes status with a ledgered note (realised)", async () => {
    const created = (
      await createRisk(projectId, { title: "Realisable risk" })
    ).json() as { id: string };
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/risks/${created.id}/status`,
      headers: owner.headers,
      payload: { status: "realised", note: "Materialised on site 12 Aug" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("realised");

    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.objectId, created.id), eq(ledgerEntries.action, "state_change")),
      );
    expect(entries.length).toBe(1);
    expect((entries[0]!.payload as { note: string }).note).toBe("Materialised on site 12 Aug");
  });

  it("validates scheduleTaskId belongs to a project schedule", async () => {
    const bad = await createRisk(projectId, {
      scheduleTaskId: "tsk_doesnotexist",
      durationImpact: { kind: "uniform", min: 1, max: 3 },
    });
    expect(bad.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Mitigation value (#454)                                             */
/* ------------------------------------------------------------------ */

describe("mitigation value", () => {
  it("computes analytic EV before/after and the worthwhile verdict", async () => {
    // risk #1: P=0.5, triangular(1000,2000,6000) mean 3000 → EV before 1500;
    // scores 4×4 → 2×2 scale EV by 0.25 → EV after 375; reduction 1125 > 500.
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/risks?category=technical`,
      headers: owner.headers,
    });
    const risk = (list.json() as { items: { id: string; number: number }[] }).items.find(
      (r) => r.number === 1,
    )!;
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/risks/${risk.id}/mitigation-value`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body["expectedValueBefore"]).toBe(1500);
    expect(body["expectedValueAfter"]).toBe(375);
    expect(body["riskReduction"]).toBe(1125);
    expect(body["mitigationCost"]).toBe(500);
    expect(body["worthwhile"]).toBe(true);

    // an expensive mitigation flips the verdict
    await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/risks/${risk.id}`,
      headers: owner.headers,
      payload: { mitigationCost: 2000 },
    });
    const flipped = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/risks/${risk.id}/mitigation-value`,
      headers: owner.headers,
    });
    expect((flipped.json() as { worthwhile: boolean }).worthwhile).toBe(false);
    await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/risks/${risk.id}`,
      headers: owner.headers,
      payload: { mitigationCost: 500 },
    });
  });

  it("refuses unquantified risks with 400", async () => {
    const created = (
      await createRisk(projectId, { title: "Qualitative-only risk" })
    ).json() as { id: string };
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/risks/${created.id}/mitigation-value`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toContain("not quantified");
  });
});

/* ------------------------------------------------------------------ */
/* QCRA (#458-466)                                                     */
/* ------------------------------------------------------------------ */

describe("qcra", () => {
  let qcraProject: string;
  let simulationId: string;
  let riskIdToMutate: string;

  beforeAll(async () => {
    qcraProject = await makeProject("QCRA Project");
    // Degenerate distributions make the whole simulation deterministic in
    // VALUE (not just in seed): every iteration totals exactly 150.
    const r1 = await createRisk(qcraProject, {
      title: "Certain cost risk A",
      occurrenceProbability: 1,
      costImpact: { kind: "uniform", min: 100, max: 100 },
    });
    riskIdToMutate = (r1.json() as { id: string }).id;
    await createRisk(qcraProject, {
      title: "Certain cost risk B",
      occurrenceProbability: 1,
      costImpact: { kind: "uniform", min: 50, max: 50 },
    });
    // an unquantified risk must be excluded from the default selection
    await createRisk(qcraProject, { title: "Qualitative bystander" });
  });

  it("runs, persists and returns the full result with correlationModelled:false", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${qcraProject}/risk/simulations/qcra`,
      headers: owner.headers,
      payload: { seed: 42, iterations: 500 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      simulationId: string;
      seed: number;
      riskCount: number;
      summary: { mean: number; percentiles: Record<string, number> };
      perRisk: { expectedValue: number }[];
      contingencyAt: { p80: number };
      correlationModelled: boolean;
    };
    simulationId = body.simulationId;
    expect(body.seed).toBe(42);
    expect(body.riskCount).toBe(2); // bystander excluded
    expect(body.summary.mean).toBe(150);
    expect(body.summary.percentiles.p50).toBe(150);
    expect(body.contingencyAt.p80).toBe(150);
    expect(body.correlationModelled).toBe(false);
    expect(body.perRisk.map((r) => r.expectedValue).sort((a, b) => a - b)).toEqual([50, 100]);

    const [row] = await app.db
      .select()
      .from(riskSimulations)
      .where(eq(riskSimulations.id, simulationId));
    expect(row).toBeDefined();
    expect(row!.kind).toBe("qcra");
    expect(row!.seed).toBe(42);
    expect(
      (row!.results as { summary: { percentiles: { p80: number } } }).summary.percentiles.p80,
    ).toBe(150);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${qcraProject}/risk/simulations`,
      headers: owner.headers,
    });
    const listBody = list.json() as { items: { id: string; kind: string }[] };
    expect(listBody.items[0]!.id).toBe(simulationId);
    expect(listBody.items[0]!.kind).toBe("qcra");
  });

  it("is deterministic: same seed reproduces identical percentiles, and rerun verifies it", async () => {
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${qcraProject}/risk/simulations/qcra`,
      headers: owner.headers,
      payload: { seed: 42, iterations: 500 },
    });
    const first = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${qcraProject}/risk-simulations/${simulationId}`,
      headers: owner.headers,
    });
    const a = (again.json() as { summary: { percentiles: unknown } }).summary.percentiles;
    const b = (first.json() as { results: { summary: { percentiles: unknown } } }).results.summary
      .percentiles;
    expect(a).toEqual(b);

    // mutate an input risk AFTER the run — the stored snapshot must still
    // reproduce (that is the audit point of persisting inputs + seed)
    await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${qcraProject}/risks/${riskIdToMutate}`,
      headers: owner.headers,
      payload: { costImpact: { kind: "uniform", min: 99999, max: 99999 } },
    });
    const rerun = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${qcraProject}/risk-simulations/${simulationId}/rerun`,
      headers: owner.headers,
      payload: {},
    });
    expect(rerun.statusCode).toBe(200);
    const verdict = rerun.json() as { reproduced: boolean; expected: unknown; actual: unknown };
    expect(verdict.reproduced).toBe(true);
    expect(verdict.actual).toEqual(verdict.expected);
  });

  it("400s when no quantified risks exist and when named risks are unquantified", async () => {
    const empty = await makeProject("No Quantified Risks");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${empty}/risk/simulations/qcra`,
      headers: owner.headers,
      payload: { seed: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toContain("No quantified risks");

    const bystander = (
      await createRisk(qcraProject, { title: "Another qualitative risk" })
    ).json() as { id: string };
    const named = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${qcraProject}/risk/simulations/qcra`,
      headers: owner.headers,
      payload: { seed: 1, riskIds: [bystander.id] },
    });
    expect(named.statusCode).toBe(400);
    expect((named.json() as { message: string }).message).toContain("not quantified");
  });
});

/* ------------------------------------------------------------------ */
/* QSRA (#457)                                                         */
/* ------------------------------------------------------------------ */

describe("qsra", () => {
  let qsraProject: string;
  let fixture: Awaited<ReturnType<typeof insertSchedule>>;

  beforeAll(async () => {
    qsraProject = await makeProject("QSRA Project");
    fixture = await insertSchedule(qsraProject);
  });

  it("zero-variance uncertainty collapses to the deterministic duration, with ISO completion dates", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${qsraProject}/risk/simulations/qsra`,
      headers: owner.headers,
      payload: {
        seed: 7,
        iterations: 200,
        taskUncertainties: [
          { taskId: fixture.taskA, distribution: { kind: "uniform", min: 10, max: 10 } },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      scheduleId: string;
      deterministicDurationDays: number;
      summary: { min: number; max: number; percentiles: { p50: number } };
      completionDates: Record<string, string>;
      perTask: { id: string; criticalityIndex: number }[];
      correlationModelled: boolean;
    };
    expect(body.scheduleId).toBe(fixture.scheduleId); // active-schedule default
    expect(body.deterministicDurationDays).toBe(15);
    expect(body.summary.min).toBe(15);
    expect(body.summary.max).toBe(15);
    expect(body.summary.percentiles.p50).toBe(15);
    // day 15 exclusive → inclusive finish day 14 from 2026-01-05
    expect(body.completionDates["p50"]).toBe("2026-01-19");
    expect(body.completionDates["deterministic"]).toBe("2026-01-19");
    expect(body.correlationModelled).toBe(false);
    for (const t of body.perTask) expect(t.criticalityIndex).toBe(1);
  });

  it("merges risk-linked durationImpact onto the linked task, and reruns reproducibly", async () => {
    await createRisk(qsraProject, {
      title: "Frame erection slower than planned",
      scheduleTaskId: fixture.taskB,
      durationImpact: { kind: "uniform", min: 8, max: 8 },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${qsraProject}/risk/simulations/qsra`,
      headers: owner.headers,
      payload: { seed: 9, iterations: 100 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      simulationId: string;
      summary: { min: number; max: number };
      completionDates: Record<string, string>;
    };
    // task B duration replaced by the risk's distribution: 10 + 8 = 18 days
    expect(body.summary.min).toBe(18);
    expect(body.summary.max).toBe(18);
    expect(body.completionDates["p80"]).toBe("2026-01-22");

    const rerun = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${qsraProject}/risk-simulations/${body.simulationId}/rerun`,
      headers: owner.headers,
      payload: {},
    });
    expect((rerun.json() as { reproduced: boolean }).reproduced).toBe(true);
  });

  it("rejects taskUncertainties for tasks off the schedule", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${qsraProject}/risk/simulations/qsra`,
      headers: owner.headers,
      payload: {
        seed: 1,
        taskUncertainties: [
          { taskId: "tsk_offschedule", distribution: { kind: "uniform", min: 1, max: 2 } },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Contingency (#469-473)                                              */
/* ------------------------------------------------------------------ */

describe("contingency", () => {
  let contProject: string;
  let contingencyId: string;

  beforeAll(async () => {
    contProject = await makeProject("Contingency Project");
  });

  it("creates a contingency and validates simulationId scoping", async () => {
    const badSim = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${contProject}/contingencies`,
      headers: owner.headers,
      payload: { name: "Bad link", amount: 100, simulationId: "sim_nope" },
    });
    expect(badSim.statusCode).toBe(400);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${contProject}/contingencies`,
      headers: owner.headers,
      payload: { name: "P80 risk contingency", amount: 10000, confidenceLevel: "p80" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; remaining: number; drawnTotal: number };
    contingencyId = body.id;
    expect(body.drawnTotal).toBe(0);
    expect(body.remaining).toBe(10000);
  });

  it("refuses over-draws with 409 and raises the exhaustion signal exactly once at <20%", async () => {
    const draw = (amount: number, drawnAt: string) =>
      app.inject({
        method: "POST",
        url: `/api/v1/projects/${contProject}/contingencies/${contingencyId}/drawdowns`,
        headers: owner.headers,
        payload: { amount, reason: "Realised risk settlement", drawnAt },
      });

    const first = await draw(5000, "2026-02-01");
    expect(first.statusCode).toBe(201);
    expect((first.json() as { remaining: number }).remaining).toBe(5000);
    expect((first.json() as { exhaustionSignal: boolean }).exhaustionSignal).toBe(false);

    const overdraw = await draw(6000, "2026-02-02");
    expect(overdraw.statusCode).toBe(409);
    expect((overdraw.json() as { message: string }).message).toContain("5000");

    // crosses the 20% line (remaining 5000 → 500 vs threshold 2000)
    const crossing = await draw(4500, "2026-02-03");
    expect(crossing.statusCode).toBe(201);
    expect((crossing.json() as { remaining: number }).remaining).toBe(500);
    expect((crossing.json() as { exhaustionSignal: boolean }).exhaustionSignal).toBe(true);

    // already under the line: no second signal
    const under = await draw(100, "2026-02-04");
    expect(under.statusCode).toBe(201);
    expect((under.json() as { exhaustionSignal: boolean }).exhaustionSignal).toBe(false);

    const sigs = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.projectId, contProject), eq(signals.detector, "contingency_exhaustion")),
      );
    expect(sigs.length).toBe(1);
    expect(sigs[0]!.severity).toBe("high");
    expect(sigs[0]!.title).toContain("below 20%");

    const finalOverdraw = await draw(500, "2026-02-05"); // only 400 remains
    expect(finalOverdraw.statusCode).toBe(409);
  });

  it("returns the drawdown curve ordered by date with correct cumulative arithmetic", async () => {
    const cont = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${contProject}/contingencies`,
        headers: owner.headers,
        payload: { name: "Curve contingency", amount: 1000 },
      })
    ).json() as { id: string };
    // inserted out of date order deliberately
    for (const [amount, drawnAt] of [
      [100, "2026-03-10"],
      [200, "2026-03-01"],
      [50, "2026-03-05"],
    ] as const) {
      const r = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${contProject}/contingencies/${cont.id}/drawdowns`,
        headers: owner.headers,
        payload: { amount, reason: "draw", drawnAt },
      });
      expect(r.statusCode).toBe(201);
    }
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${contProject}/contingencies/${cont.id}/drawdown-curve`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      amount: number;
      points: { date: string; drawn: number; remaining: number }[];
    };
    expect(body.points.map((p) => p.date)).toEqual(["2026-03-01", "2026-03-05", "2026-03-10"]);
    expect(body.points.map((p) => p.drawn)).toEqual([200, 250, 350]);
    expect(body.points.map((p) => p.remaining)).toEqual([800, 750, 650]);

    // list shows drawn totals + remaining
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${contProject}/contingencies`,
      headers: owner.headers,
    });
    const item = (
      list.json() as { items: { id: string; drawnTotal: number; remaining: number }[] }
    ).items.find((c) => c.id === cont.id)!;
    expect(item.drawnTotal).toBe(350);
    expect(item.remaining).toBe(650);
  });

  it("deletes only contingencies without drawdowns", async () => {
    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${contProject}/contingencies/${contingencyId}`,
      headers: owner.headers,
    });
    expect(blocked.statusCode).toBe(409);

    const fresh = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${contProject}/contingencies`,
        headers: owner.headers,
        payload: { name: "Deletable", amount: 5 },
      })
    ).json() as { id: string };
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${contProject}/contingencies/${fresh.id}`,
      headers: owner.headers,
    });
    expect(deleted.statusCode).toBe(204);
    const gone = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${contProject}/contingencies/${fresh.id}/drawdown-curve`,
      headers: owner.headers,
    });
    expect(gone.statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* Tenant isolation                                                    */
/* ------------------------------------------------------------------ */

describe("tenant isolation", () => {
  it("blocks another company from the register and simulations", async () => {
    const outsider = await registerActor(app);
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/risks`,
      headers: outsider.headers,
    });
    expect(list.statusCode).toBe(403);

    const sims = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/risk/simulations`,
      headers: outsider.headers,
    });
    expect(sims.statusCode).toBe(403);
  });

  it("scopes a simulation to its own project even inside the tenant", async () => {
    const otherProject = await makeProject("Other Project Same Tenant");
    const [sim] = await app.db
      .select({ id: riskSimulations.id })
      .from(riskSimulations)
      .limit(1);
    expect(sim).toBeDefined();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${otherProject}/risk-simulations/${sim!.id}`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});
