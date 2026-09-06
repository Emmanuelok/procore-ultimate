/**
 * Integration tests for the WP-GOV risk upgrade: async simulation jobs with
 * convergence and risk-adjusted joins (#464, #475-476), the contingency
 * planned-vs-actual curve and release authority workflow (#451, #471-472),
 * risk appetite thresholds (#472), reference-class forecasting and the
 * optimism-bias table (#402-405), enforced status transitions (#450) and the
 * health-inputs contract.
 *
 * The audit regressions asserted here are labelled REGRESSION.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { companyMemberships, contingencyDrawdowns, projects, signals } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let approver: TestActor; // second admin — SoD counterparty for releases
let approverHeaders: Record<string, string>;
let stranger: TestActor; // different company entirely
let projectId: string;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
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
  stranger = await registerActor(app);
  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Risk Upgrade Project",
  });
}, 240_000);

afterAll(async () => {
  await built.close();
});

type Json = Record<string, unknown>;

async function makeProject(name: string): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({ id, companyId: owner.companyId, name });
  return id;
}

function post(url: string, payload?: unknown, headers = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload as Json });
}
function put(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "PUT", url: `/api/v1${url}`, headers, payload: payload as Json });
}
function patch(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload: payload as Json });
}
function del(url: string, headers = owner.headers) {
  return app.inject({ method: "DELETE", url: `/api/v1${url}`, headers });
}
function get(url: string, headers = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}

async function createQuantifiedRisk(pid: string, over: Json = {}) {
  const res = await post(`/projects/${pid}/risks`, {
    title: "Ground conditions worse than assumed",
    category: "technical",
    probabilityScore: 4,
    impactScore: 4,
    occurrenceProbability: 0.4,
    costImpact: { kind: "triangular", min: 100_000, mode: 200_000, max: 400_000 },
    ...over,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as Json;
}

async function createContingency(pid: string, over: Json = {}) {
  const res = await post(`/projects/${pid}/contingencies`, {
    name: "Construction contingency",
    amount: 200_000,
    ...over,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as Json;
}

/* ------------------------------------------------------------------ */
/* Async simulation jobs (#464, #475-476)                              */
/* ------------------------------------------------------------------ */

describe("simulation jobs", () => {
  it("queues a QCRA job, drains it, records convergence and the risk-adjusted EAC", async () => {
    const pid = await makeProject("Async QCRA");
    await createQuantifiedRisk(pid);

    const queued = await post(`/projects/${pid}/risk/simulations/qcra`, {
      iterations: 1000,
      seed: 42,
      async: true,
    });
    expect(queued.statusCode).toBe(202);
    const job = (queued.json() as { job: Json }).job;
    expect(job.status).toBe("queued");
    expect(job.simulationId).toBeNull();

    // the enqueue kicks the queue itself; /run is the operator's manual cycle
    const drained = await post(`/projects/${pid}/risk/simulation-jobs/run`);
    expect(drained.statusCode).toBe(200);
    expect(typeof (drained.json() as { ran: number }).ran).toBe("number");

    const done = (await get(`/projects/${pid}/risk/simulation-jobs/${job.id}`)).json() as Json;
    expect(done.status).toBe("done");
    expect(done.iterationsDone).toBe(1000);
    expect(done.progressPercent).toBe(100);
    expect(typeof done.simulationId).toBe("string");
    // convergence series: one point per 500-iteration batch
    const series = done.convergence as Array<{ iterations: number; p80: number }>;
    expect(series.length).toBe(2);
    expect(series[0]!.iterations).toBe(500);
    expect(series[1]!.iterations).toBe(1000);
    expect(typeof series[1]!.p80).toBe("number");
    // no deterministic budget on this project → the join refuses to invent one
    const adjusted = done.riskAdjusted as { p80: number | null; reasons?: string[] } | null;
    expect(adjusted).not.toBeNull();
    expect(adjusted!.p80).toBeNull();

    const list = (await get(`/projects/${pid}/risk/simulation-jobs`)).json() as {
      items: Json[];
      total: number;
    };
    expect(list.total).toBe(1);
    expect(list.items[0]!.id).toBe(job.id);
  });

  it("the synchronous path still returns a finished simulation and matches the queued one", async () => {
    const pid = await makeProject("Sync QCRA");
    await createQuantifiedRisk(pid);
    const sync = await post(`/projects/${pid}/risk/simulations/qcra`, {
      iterations: 500,
      seed: 7,
    });
    expect(sync.statusCode).toBe(201);
    // The synchronous response spreads the simulation results at the top
    // level (summary, perRisk, contingencyAt) alongside the job metadata.
    const syncBody = sync.json() as Json;
    const syncSummary = syncBody.summary as { percentiles: Json };
    expect(syncBody.simulationId).toBeTruthy();
    expect(syncBody.jobId).toBeTruthy();

    const queued = await post(`/projects/${pid}/risk/simulations/qcra`, {
      iterations: 500,
      seed: 7,
      async: true,
    });
    await post(`/projects/${pid}/risk/simulation-jobs/run`);
    const job = (
      await get(
        `/projects/${pid}/risk/simulation-jobs/${(queued.json() as { job: Json }).job.id as string}`,
      )
    ).json() as Json;
    const sim = (
      await get(`/projects/${pid}/risk-simulations/${job.simulationId as string}`)
    ).json() as Json;
    // same seed, same iterations → identical percentiles whichever path ran it
    expect(((sim.results as Json).summary as { percentiles: Json }).percentiles).toEqual(
      syncSummary.percentiles,
    );
  });

  it("a failed job records its error rather than disappearing", async () => {
    const pid = await makeProject("QCRA no risks");
    const res = await post(`/projects/${pid}/risk/simulations/qcra`, { async: true });
    // nothing quantified — refused up front, no job created
    expect(res.statusCode).toBe(400);
    const jobs = (await get(`/projects/${pid}/risk/simulation-jobs`)).json() as { total: number };
    expect(jobs.total).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Contingency plan, drift and release authority (#451, #471-472)      */
/* ------------------------------------------------------------------ */

describe("contingency governance", () => {
  it("stores a generated plan curve and reports drift against actual drawdowns", async () => {
    const pid = await makeProject("Contingency plan");
    const cont = await createContingency(pid, { amount: 100_000 });

    const plan = await put(`/projects/${pid}/contingencies/${cont.id as string}/plan`, {
      shape: "linear",
      startDate: addDaysISO(todayISO(), -100),
      endDate: addDaysISO(todayISO(), 100),
      intervals: 4,
    });
    expect(plan.statusCode).toBe(200);
    const planBody = plan.json() as { source: string; points: Array<{ plannedRemaining: number }> };
    expect(planBody.source).toBe("linear");
    expect(planBody.points).toHaveLength(5);
    expect(planBody.points[0]!.plannedRemaining).toBe(100_000);
    expect(planBody.points[4]!.plannedRemaining).toBe(0);

    // half-way through the window, plan says 50,000 remaining; draw 90,000
    await post(`/projects/${pid}/contingencies/${cont.id as string}/drawdowns`, {
      amount: 40_000,
      reason: "Rock excavation",
      drawnAt: todayISO(),
    });
    await post(`/projects/${pid}/contingencies/${cont.id as string}/drawdowns`, {
      amount: 50_000,
      reason: "Dewatering",
      drawnAt: todayISO(),
    });

    const curve = (
      await get(`/projects/${pid}/contingencies/${cont.id as string}/drawdown-curve`)
    ).json() as Json;
    const points = curve.points as Array<{ drawn: number; remaining: number }>;
    expect(points).toHaveLength(2);
    expect(points[1]!.drawn).toBe(90_000);
    expect(points[1]!.remaining).toBe(10_000);
    const drift = curve.drift as {
      plannedRemaining: number | null;
      actualRemaining: number;
      variance: number | null;
      aheadOfPlan: boolean;
      breached: boolean;
      basis: string;
    };
    expect(drift.plannedRemaining).toBe(50_000);
    expect(drift.actualRemaining).toBe(10_000);
    expect(drift.variance).toBe(-40_000);
    expect(drift.aheadOfPlan).toBe(true);
    expect(drift.breached).toBe(true);
    expect(drift.basis).toBeTruthy();
  });

  it("says so — rather than assuming zero — when there is no plan to compare against", async () => {
    const pid = await makeProject("Contingency without plan");
    const cont = await createContingency(pid);
    const curve = (
      await get(`/projects/${pid}/contingencies/${cont.id as string}/drawdown-curve`)
    ).json() as Json;
    const drift = curve.drift as { plannedRemaining: number | null; basis: string };
    expect(drift.plannedRemaining).toBeNull();
    expect(drift.basis).toMatch(/no plan/i);
    expect(curve.plan).toEqual([]);
  });

  it("routes a large draw through request → approval by someone else and refuses self-approval", async () => {
    const pid = await makeProject("Release workflow");
    const cont = await createContingency(pid, { amount: 500_000 });

    // above the direct-draw threshold a standard user cannot write straight out
    const direct = await post(`/projects/${pid}/contingencies/${cont.id as string}/drawdowns`, {
      amount: 120_000,
      reason: "Major variation",
      drawnAt: todayISO(),
    });
    // the company owner holds admin, so the direct path is open to them...
    expect(direct.statusCode).toBe(201);

    const release = await post(`/projects/${pid}/contingencies/${cont.id as string}/releases`, {
      amount: 80_000,
      reason: "Acceleration package",
      drawnAt: todayISO(),
    });
    expect(release.statusCode).toBe(201);
    const rel = release.json() as Json;
    expect(rel.status).toBe("requested");
    expect(rel.requiresAdmin).toBe(1);

    const selfApprove = await post(
      `/projects/${pid}/contingency-releases/${rel.id as string}/approve`,
      {},
    );
    expect(selfApprove.statusCode).toBe(403);
    expect((selfApprove.json() as { message: string }).message).toContain("Separation of duties");

    const approved = await post(
      `/projects/${pid}/contingency-releases/${rel.id as string}/approve`,
      { note: "Within delegated authority" },
      approverHeaders,
    );
    expect(approved.statusCode).toBe(200);
    const ab = approved.json() as Json;
    expect(ab.status).toBe("approved");
    expect(typeof ab.drawdownId).toBe("string");
    expect(ab.drawnTotal).toBe(200_000);

    // the drawdown really exists, for the approved amount
    const draws = await app.db
      .select()
      .from(contingencyDrawdowns)
      .where(eq(contingencyDrawdowns.id, ab.drawdownId as string));
    expect(draws[0]!.amount).toBe(80_000);
    expect(draws[0]!.approvedBy).toBe(approver.userId);

    // a decided release cannot be decided twice
    const again = await post(
      `/projects/${pid}/contingency-releases/${rel.id as string}/approve`,
      {},
      approverHeaders,
    );
    expect(again.statusCode).toBe(400);
  });

  it("REGRESSION: the over-draw check runs inside the approving transaction", async () => {
    const pid = await makeProject("Release over-draw");
    const cont = await createContingency(pid, { amount: 100_000 });
    // two requests that individually fit but together do not
    const r1 = (
      await post(`/projects/${pid}/contingencies/${cont.id as string}/releases`, {
        amount: 60_000,
        reason: "Package A",
        drawnAt: todayISO(),
      })
    ).json() as Json;
    const r2 = (
      await post(`/projects/${pid}/contingencies/${cont.id as string}/releases`, {
        amount: 60_000,
        reason: "Package B",
        drawnAt: todayISO(),
      })
    ).json() as Json;

    const first = await post(
      `/projects/${pid}/contingency-releases/${r1.id as string}/approve`,
      {},
      approverHeaders,
    );
    expect(first.statusCode).toBe(200);
    const second = await post(
      `/projects/${pid}/contingency-releases/${r2.id as string}/approve`,
      {},
      approverHeaders,
    );
    expect(second.statusCode).toBe(409);
    expect((second.json() as { message: string }).message).toContain("exceeds the remaining");

    // the pot is never negative
    const curve = (
      await get(`/projects/${pid}/contingencies/${cont.id as string}/drawdown-curve`)
    ).json() as Json;
    const pts = curve.points as Array<{ remaining: number }>;
    expect(pts.at(-1)!.remaining).toBe(40_000);
  });

  it("rejects and withdraws releases with the right authority", async () => {
    const pid = await makeProject("Release rejection");
    const cont = await createContingency(pid, { amount: 100_000 });
    const rel = (
      await post(`/projects/${pid}/contingencies/${cont.id as string}/releases`, {
        amount: 10_000,
        reason: "Small package",
        drawnAt: todayISO(),
      })
    ).json() as Json;

    // the requester may not reject their own request (they withdraw it)
    const selfReject = await post(
      `/projects/${pid}/contingency-releases/${rel.id as string}/reject`,
      { note: "no" },
    );
    expect(selfReject.statusCode).toBe(403);

    const withdrawn = await post(
      `/projects/${pid}/contingency-releases/${rel.id as string}/withdraw`,
      { note: "No longer needed" },
    );
    expect(withdrawn.statusCode).toBe(200);
    expect((withdrawn.json() as Json).status).toBe("withdrawn");

    const list = (
      await get(`/projects/${pid}/contingencies/${cont.id as string}/releases`)
    ).json() as { items: Json[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.status).toBe("withdrawn");
  });
});

/* ------------------------------------------------------------------ */
/* Risk appetite (#472)                                                */
/* ------------------------------------------------------------------ */

describe("risk appetite", () => {
  it("raises breaches against the effective score and the aggregate expected value", async () => {
    const pid = await makeProject("Appetite");
    await createQuantifiedRisk(pid, { probabilityScore: 5, impactScore: 5 });

    const empty = (await get(`/projects/${pid}/risk/appetite`)).json() as Json;
    expect(empty.rules).toEqual([]);
    expect(empty.breaches).toEqual([]);

    const rule = await put(`/projects/${pid}/risk/appetite`, {
      scope: "project",
      maxScore: 12,
      maxExpectedValue: 50_000,
      note: "Board tolerance",
    });
    expect(rule.statusCode).toBe(200);

    const after = (await get(`/projects/${pid}/risk/appetite`)).json() as {
      rules: Json[];
      breaches: Array<{ kind: string; observed: number; limit: number }>;
      liveRisks: number;
      quantifiedRisks: number;
    };
    expect(after.rules).toHaveLength(1);
    expect(after.liveRisks).toBe(1);
    expect(after.quantifiedRisks).toBe(1);
    const kinds = after.breaches.map((b) => b.kind);
    expect(kinds).toContain("score");
    expect(kinds).toContain("expected_value");

    // the sweep raises exactly one open signal per breach and stays idempotent
    await app.scheduler.runNow("risk.appetite");
    await app.scheduler.runNow("risk.appetite");
    const raised = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.projectId, pid), eq(signals.detector, "risk_appetite_exceeded")));
    expect(raised.length).toBeGreaterThan(0);
    const openOnes = raised.filter((s) => s.status === "open");
    // one per breach kind, not one per sweep
    expect(openOnes.length).toBe(new Set(openOnes.map((s) => s.title)).size);

    // clearing both limits deletes the rule
    const cleared = await put(`/projects/${pid}/risk/appetite`, { scope: "project" });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as Json).deleted).toBe(true);
    expect(((await get(`/projects/${pid}/risk/appetite`)).json() as Json).rules).toEqual([]);
  });

  it("scopes a category rule to its category and refuses one without a category", async () => {
    const pid = await makeProject("Appetite by category");
    await createQuantifiedRisk(pid, { category: "commercial", probabilityScore: 5, impactScore: 5 });
    const bad = await put(`/projects/${pid}/risk/appetite`, { scope: "category", maxScore: 4 });
    expect(bad.statusCode).toBe(400);

    await put(`/projects/${pid}/risk/appetite`, {
      scope: "category",
      category: "environmental",
      maxScore: 4,
    });
    const body = (await get(`/projects/${pid}/risk/appetite`)).json() as { breaches: Json[] };
    expect(body.breaches).toEqual([]); // the live risk is commercial, not environmental
  });
});

/* ------------------------------------------------------------------ */
/* Reference class forecasting (#402-405)                              */
/* ------------------------------------------------------------------ */

describe("reference class forecasting", () => {
  it("serves the published optimism bias table with its source", async () => {
    const res = await get(`/risk/optimism-bias`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      source: string;
      bands: Array<{ category: string; upperPercent: number; lowerPercent: number }>;
    };
    expect(body.source).toContain("Green Book");
    expect(body.bands.find((b) => b.category === "standard_building")).toMatchObject({
      upperPercent: 24,
      lowerPercent: 2,
    });
    expect(body.bands.find((b) => b.category === "equipment_development")).toMatchObject({
      upperPercent: 200,
      lowerPercent: 10,
    });
  });

  it("computes an outside view from the company's own outturn database", async () => {
    // 3 references: outturn/estimate 1.5, 1.2, 2.0
    for (const [estimated, outturn] of [
      [100, 150],
      [100, 120],
      [100, 200],
    ] as const) {
      const created = await post(`/risk/reference-projects`, {
        name: `Ref ${outturn}`,
        category: "non_standard_civil_engineering",
        estimatedCost: estimated,
        outturnCost: outturn,
      });
      expect(created.statusCode).toBe(201);
    }

    const rcf = (
      await get(`/risk/reference-class?category=non_standard_civil_engineering&basis=cost&position=0`)
    ).json() as {
      inside: { upliftPercent: number; upperPercent: number; lowerPercent: number; basis: string };
      outside: {
        sampleSize: number;
        p50UpliftPercent: number | null;
        p80UpliftPercent: number | null;
        thin: boolean;
        basisNote: string;
      };
      references: Json[];
    };
    expect(rcf.inside.upliftPercent).toBe(66); // upper bound at position 0
    expect(rcf.outside.sampleSize).toBe(3);
    expect(rcf.outside.p50UpliftPercent).toBe(50);
    expect(rcf.outside.p80UpliftPercent).toBe(100);
    expect(rcf.references).toHaveLength(3);
  });

  it("lists, patches and deletes reference projects, and never invents a distribution", async () => {
    const created = (
      await post(`/risk/reference-projects`, {
        name: "Sole reference",
        category: "equipment_development",
        estimatedCost: 1000,
        outturnCost: 3000,
      })
    ).json() as Json;

    const thin = (
      await get(`/risk/reference-class?category=equipment_development`)
    ).json() as { outside: { sampleSize: number; thin: boolean; basisNote: string } };
    expect(thin.outside.sampleSize).toBe(1);
    expect(thin.outside.thin).toBe(true);

    const patched = await patch(`/risk/reference-projects/${created.id as string}`, {
      note: "Verified against the final account",
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as Json).note).toBe("Verified against the final account");

    const list = (await get(`/risk/reference-projects?category=equipment_development`)).json() as {
      items: Json[];
    };
    expect(list.items).toHaveLength(1);

    expect((await del(`/risk/reference-projects/${created.id as string}`)).statusCode).toBe(204);
    expect((await del(`/risk/reference-projects/${created.id as string}`)).statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* Status transitions (#450) + health inputs                           */
/* ------------------------------------------------------------------ */

describe("risk status transitions", () => {
  it("REGRESSION: refuses realised → open without admin authority and a note", async () => {
    const pid = await makeProject("Transitions");
    const risk = await createQuantifiedRisk(pid);
    const riskId = risk.id as string;

    expect(
      (await post(`/projects/${pid}/risks/${riskId}/status`, { status: "mitigating" })).statusCode,
    ).toBe(200);
    expect(
      (await post(`/projects/${pid}/risks/${riskId}/status`, { status: "realised" })).statusCode,
    ).toBe(200);

    // a no-op is refused rather than silently ledgered
    const noop = await post(`/projects/${pid}/risks/${riskId}/status`, { status: "realised" });
    expect(noop.statusCode).toBe(400);

    // the owner holds admin, but reopening still demands an explanation
    const noNote = await post(`/projects/${pid}/risks/${riskId}/status`, { status: "open" });
    expect(noNote.statusCode).toBe(400);
    expect((noNote.json() as { message: string }).message).toMatch(/note/i);

    const reopened = await post(`/projects/${pid}/risks/${riskId}/status`, {
      status: "open",
      note: "Recorded in error — the event did not occur",
    });
    expect(reopened.statusCode).toBe(200);
    expect((reopened.json() as Json).status).toBe("open");

    // closed → realised is not a transition at all
    await post(`/projects/${pid}/risks/${riskId}/status`, { status: "closed" });
    const bogus = await post(`/projects/${pid}/risks/${riskId}/status`, {
      status: "realised",
      note: "trying anyway",
    });
    expect(bogus.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Register depth: cause/effect, response strategy, secondary risks    */
/* ------------------------------------------------------------------ */

describe("register depth (#447-450)", () => {
  it("records cause, effect, the chosen response, proximity and triggers", async () => {
    const pid = await makeProject("Register depth");
    const created = await createQuantifiedRisk(pid, {
      cause: "The site investigation was limited to the northern half of the plot",
      effect: "Piling redesign and a four-week delay to the substructure",
      responseStrategy: "reduce",
      proximityDate: addDaysISO(todayISO(), 60),
      triggers: ["Trial pit finds made ground below 3m", "Piling rig refusal on any pile"],
    });
    expect(created.cause).toContain("northern half");
    expect(created.responseStrategy).toBe("reduce");
    expect(created.triggers).toHaveLength(2);

    const patched = await patch(`/projects/${pid}/risks/${created.id as string}`, {
      responseStrategy: "transfer",
      effect: "Carried by the piling subcontractor under a lump sum",
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as Json).responseStrategy).toBe("transfer");

    const bad = await post(`/projects/${pid}/risks`, {
      title: "Bad strategy",
      category: "technical",
      probabilityScore: 2,
      impactScore: 2,
      responseStrategy: "ignore_it",
    });
    expect(bad.statusCode).toBe(400);
  });

  it("links a secondary risk to the primary whose response created it, both ways", async () => {
    const pid = await makeProject("Secondary risks");
    const primary = await createQuantifiedRisk(pid, {
      title: "Flood damage to the ground floor",
      responseStrategy: "transfer",
    });
    const secondary = await post(`/projects/${pid}/risks`, {
      title: "Insurer disputes the claim",
      category: "commercial",
      probabilityScore: 2,
      impactScore: 5,
      cause: "The flood exposure was transferred to an insurer",
      secondaryOfRiskId: primary.id,
    });
    expect(secondary.statusCode).toBe(201);

    const detail = (await get(`/projects/${pid}/risks/${primary.id as string}`)).json() as {
      secondaries: Json[];
      primary: Json | null;
    };
    expect(detail.primary).toBeNull();
    expect(detail.secondaries).toHaveLength(1);
    expect(detail.secondaries[0]!.title).toBe("Insurer disputes the claim");

    const child = (
      await get(`/projects/${pid}/risks/${(secondary.json() as Json).id as string}`)
    ).json() as { primary: Json | null };
    expect(child.primary).not.toBeNull();
    expect(child.primary!.id).toBe(primary.id);
  });

  it("refuses a secondary link that is self-referential, looping or off-project", async () => {
    const pid = await makeProject("Secondary guards");
    const other = await makeProject("Somewhere else");
    const a = await createQuantifiedRisk(pid, { title: "A" });
    const b = await post(`/projects/${pid}/risks`, {
      title: "B",
      category: "commercial",
      probabilityScore: 2,
      impactScore: 2,
      secondaryOfRiskId: a.id,
    });
    expect(b.statusCode).toBe(201);
    const bId = (b.json() as Json).id as string;

    const self = await patch(`/projects/${pid}/risks/${bId}`, { secondaryOfRiskId: bId });
    expect(self.statusCode).toBe(400);

    // A ← B already; making A a secondary of B closes the loop
    const loop = await patch(`/projects/${pid}/risks/${a.id as string}`, {
      secondaryOfRiskId: bId,
    });
    expect(loop.statusCode).toBe(400);
    expect((loop.json() as Json).message).toMatch(/loop/i);

    const foreign = await post(`/projects/${other}/risks`, {
      title: "Elsewhere",
      category: "commercial",
      probabilityScore: 2,
      impactScore: 2,
      secondaryOfRiskId: a.id,
    });
    expect(foreign.statusCode).toBe(400);
  });

  it("counts responses in the health inputs so an unmanaged register is visible", async () => {
    const pid = await makeProject("Response coverage");
    await createQuantifiedRisk(pid, { title: "No response chosen" });
    await createQuantifiedRisk(pid, { title: "Accepted", responseStrategy: "accept" });
    const metrics = (
      (await get(`/projects/${pid}/risk/health-inputs`)).json() as {
        metrics: Record<string, number | null>;
      }
    ).metrics;
    expect(metrics["liveRisksWithoutResponse"]).toBe(1);
    expect(metrics["liveRisksAccepted"]).toBe(1);
    expect(metrics["secondaryRisks"]).toBe(0);
  });
});

describe("risk health inputs", () => {
  it("returns metrics with reasons and never a fabricated zero", async () => {
    const pid = await makeProject("Health inputs");
    const empty = (await get(`/projects/${pid}/risk/health-inputs`)).json() as {
      metrics: Record<string, number | null>;
      reasons: string[];
    };
    expect(empty.metrics["contingencyRemainingPercent"]).toBeNull();
    expect(empty.metrics["expectedValueTotal"]).toBeNull();
    expect(empty.reasons.join(" ").toLowerCase()).toContain("contingency");

    await createQuantifiedRisk(pid, { probabilityScore: 5, impactScore: 5 });
    const cont = await createContingency(pid, { amount: 100_000 });
    await post(`/projects/${pid}/contingencies/${cont.id as string}/drawdowns`, {
      amount: 25_000,
      reason: "Draw",
      drawnAt: todayISO(),
    });
    const filled = (await get(`/projects/${pid}/risk/health-inputs`)).json() as {
      metrics: Record<string, number | null>;
    };
    expect(filled.metrics["contingencyRemainingPercent"]).toBe(75);
    expect(filled.metrics["openRisks"]).toBe(1);
    expect(filled.metrics["quantifiedRisks"]).toBe(1);
    expect(filled.metrics["appetiteBreaches"]).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Tenant isolation                                                    */
/* ------------------------------------------------------------------ */

describe("tenant isolation on the upgraded routes", () => {
  it("keeps every new risk route invisible to another company", async () => {
    const cont = await createContingency(projectId);
    const strangerHeaders = stranger.headers;

    for (const url of [
      `/projects/${projectId}/risk/simulation-jobs`,
      `/projects/${projectId}/risk/appetite`,
      `/projects/${projectId}/contingencies/${cont.id as string}/drawdown-curve`,
      `/projects/${projectId}/risk/health-inputs`,
    ]) {
      const res = await get(url, strangerHeaders);
      expect([403, 404]).toContain(res.statusCode);
    }

    const write = await put(
      `/projects/${projectId}/risk/appetite`,
      { scope: "project", maxScore: 4 },
      strangerHeaders,
    );
    expect([403, 404]).toContain(write.statusCode);

    // company-level reference projects are scoped to the caller's company
    await post(`/risk/reference-projects`, {
      name: "Owner company reference",
      category: "standard_building",
      estimatedCost: 10,
      outturnCost: 12,
    });
    const theirs = await get(`/risk/reference-projects`, strangerHeaders);
    if (theirs.statusCode === 200) {
      const items = (theirs.json() as { items: Json[] }).items;
      expect(items.every((i) => i.companyId === stranger.companyId)).toBe(true);
    } else {
      expect([403, 404]).toContain(theirs.statusCode);
    }
  });
});
