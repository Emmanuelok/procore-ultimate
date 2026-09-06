/**
 * Integration tests for the WP-GOV governance upgrade: reference-class /
 * optimism-bias positioning with a challenge workflow (#402-405), EIRR,
 * sensitivity and switching values (#400, #406), gate evidence packs and the
 * independent reviewer rule (#410-411, #415), the benefits dependency
 * network, logic model and realisation dashboard (#418-422), assurance
 * action tracking (#415), the company reviewer workspace and health inputs.
 *
 * Audit regressions asserted here are labelled REGRESSION.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  benefits,
  companyMemberships,
  evidence,
  lessons,
  obligations,
  projectMemberships,
  projects,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let reviewer: TestActor; // second admin — independent decision-maker
let reviewerHeaders: Record<string, string>;
let stranger: TestActor;
let projectId: string;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  reviewer = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: reviewer.userId,
    role: "admin",
  });
  reviewerHeaders = {
    authorization: reviewer.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };
  stranger = await registerActor(app);
  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Governance Upgrade Project",
  });
}, 600_000);

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

async function seedEvidence(pid: string, source = "Independent monitor pack") {
  const id = newId("ev");
  await app.db.insert(evidence).values({
    id,
    companyId: owner.companyId,
    projectId: pid,
    kind: "document",
    source,
    contentHash: `sha256:${id}`,
    submittedBy: owner.userId,
  });
  return id;
}

async function createBc(pid: string, over: Json = {}) {
  const res = await post(`/projects/${pid}/business-cases`, {
    stage: "outline",
    title: "Depot renewal OBC",
    cases: { strategic: "Fleet growth", economic: "See appraisal" },
    appraisal: { discountRatePercent: 10, appraisalYears: 3, optimismBiasPercent: 0 },
    ...over,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as Json;
}

async function createBenefit(pid: string, over: Json = {}) {
  const res = await post(`/projects/${pid}/benefits`, {
    name: "Journey time saving",
    unit: "minutes",
    baselineValue: 0,
    targetValue: 100,
    ...over,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as Json;
}

/* ------------------------------------------------------------------ */
/* Reference class + optimism bias challenge (#402-405)                */
/* ------------------------------------------------------------------ */

describe("optimism bias positioning", () => {
  it("serves the published table at company level", async () => {
    const res = await get(`/governance/optimism-bias`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      bands: Array<{ category: string; upperPercent: number; lowerPercent: number }>;
    };
    expect(body.bands.find((b) => b.category === "non_standard_building")).toMatchObject({
      upperPercent: 51,
      lowerPercent: 4,
    });
  });

  it("sets the inside view from the table and recomputes every option", async () => {
    const pid = await makeProject("Inside view");
    const bc = await createBc(pid);
    await put(`/projects/${pid}/business-cases/${bc.id as string}/options`, {
      options: [
        {
          name: "Do minimum",
          capex: 100,
          annualBenefits: [40, 40, 40],
          isCounterfactual: true,
        },
        { name: "Full renewal", capex: 200, annualBenefits: [120, 120, 120] },
      ],
    });

    const res = await put(`/projects/${pid}/business-cases/${bc.id as string}/reference-class`, {
      category: "standard_building",
      position: 0,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    const rc = body.referenceClass as {
      category: string;
      appliedPercent: number;
      view: string;
      upperPercent: number;
      lowerPercent: number;
    };
    expect(rc.category).toBe("standard_building");
    expect(rc.upperPercent).toBe(24);
    expect(rc.appliedPercent).toBe(24);
    expect(rc.view).toBe("inside");
    expect((body.appraisal as Json).optimismBiasPercent).toBe(24);
    // options were recomputed under the new uplift
    const options = body.options as Array<{ computed: { npv: number } }>;
    expect(options).toHaveLength(2);
    expect(typeof options[0]!.computed.npv).toBe("number");

    // position 1 is the fully-mitigated lower bound
    const mitigated = await put(
      `/projects/${pid}/business-cases/${bc.id as string}/reference-class`,
      { category: "standard_building", position: 1, mitigations: ["Brief frozen", "Site surveyed"] },
    );
    const mrc = (mitigated.json() as Json).referenceClass as { appliedPercent: number };
    expect(mrc.appliedPercent).toBe(2);
  });

  it("refuses the outside view when the reference class cannot support it", async () => {
    const pid = await makeProject("Outside view unavailable");
    const bc = await createBc(pid);
    const res = await put(`/projects/${pid}/business-cases/${bc.id as string}/reference-class`, {
      category: "outsourcing",
      useOutsideView: true,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message.length).toBeGreaterThan(10);
  });

  it("applies the outside view from the company's own outturn database", async () => {
    for (const [est, out] of [
      [100, 130],
      [100, 160],
      [100, 190],
    ] as const) {
      await post(`/risk/reference-projects`, {
        name: `Civil ref ${out}`,
        category: "standard_civil_engineering",
        estimatedCost: est,
        outturnCost: out,
      });
    }
    const pid = await makeProject("Outside view");
    const bc = await createBc(pid);
    const res = await put(`/projects/${pid}/business-cases/${bc.id as string}/reference-class`, {
      category: "standard_civil_engineering",
      useOutsideView: true,
      outsideConfidence: "p50",
    });
    expect(res.statusCode).toBe(200);
    const rc = (res.json() as Json).referenceClass as {
      view: string;
      appliedPercent: number;
      outside: { sampleSize: number; p50UpliftPercent: number };
    };
    expect(rc.view).toBe("outside");
    expect(rc.outside.sampleSize).toBe(3);
    expect(rc.appliedPercent).toBe(60); // median ratio 1.6 → 60%
  });

  it("records a challenge to the table and requires an independent approver", async () => {
    const pid = await makeProject("Uplift challenge");
    const bc = await createBc(pid);
    await put(`/projects/${pid}/business-cases/${bc.id as string}/reference-class`, {
      category: "non_standard_building",
      position: 0,
    });

    const short = await post(
      `/projects/${pid}/business-cases/${bc.id as string}/uplift-challenges`,
      { category: "non_standard_building", proposedPercent: 10, justification: "too short" },
    );
    expect(short.statusCode).toBe(400);

    const created = await post(
      `/projects/${pid}/business-cases/${bc.id as string}/uplift-challenges`,
      {
        category: "non_standard_building",
        proposedPercent: 10,
        justification:
          "The brief is frozen, the site is fully surveyed and the contractor is engaged early, so the published upper bound overstates the residual bias.",
      },
    );
    expect(created.statusCode).toBe(201);
    const ch = created.json() as Json;
    expect(ch.status).toBe("proposed");
    expect(ch.tablePercent).toBe(51);
    expect(ch.proposedPercent).toBe(10);

    const list = (
      await get(`/projects/${pid}/business-cases/${bc.id as string}/uplift-challenges`)
    ).json() as { items: Json[] };
    expect(list.items).toHaveLength(1);

    const selfApprove = await post(
      `/projects/${pid}/uplift-challenges/${ch.id as string}/approve`,
      { note: "fine" },
    );
    expect(selfApprove.statusCode).toBe(403);

    const approved = await post(
      `/projects/${pid}/uplift-challenges/${ch.id as string}/approve`,
      { note: "Mitigations evidenced" },
      reviewerHeaders,
    );
    expect(approved.statusCode).toBe(200);
    expect((approved.json() as Json).status).toBe("approved");

    // the approved deviation is what the appraisal now uses
    const after = (await get(`/projects/${pid}/business-cases/${bc.id as string}`)).json() as Json;
    expect((after.appraisal as Json).optimismBiasPercent).toBe(10);
  });
});

/* ------------------------------------------------------------------ */
/* Appraisal depth: EIRR, sensitivity, switching values (#400, #406)   */
/* ------------------------------------------------------------------ */

describe("options appraisal depth", () => {
  it("returns EIRR, a sensitivity grid, a tornado and switching values per option", async () => {
    const pid = await makeProject("Appraisal depth");
    const bc = await createBc(pid);
    const res = await put(`/projects/${pid}/business-cases/${bc.id as string}/options`, {
      options: [
        { name: "Do nothing", capex: 0, annualBenefits: [0, 0, 0], isCounterfactual: true },
        { name: "Invest", capex: 100, annualBenefits: [60, 60, 60] },
      ],
    });
    expect(res.statusCode).toBe(200);
    const options = (res.json() as Json).options as Array<{
      name: string;
      computed: {
        npv: number;
        bcr: number | null;
        eirr: number | null;
        sensitivity?: { tornado: Array<{ variable: string; swing: number }>; basis: string };
        switchingValues?: Array<{ variable: string; percentChange: number | null }>;
      };
    }>;
    const invest = options.find((o) => o.name === "Invest")!;
    expect(invest.computed.eirr).not.toBeNull();
    expect(invest.computed.eirr!).toBeGreaterThan(0.1);
    expect(invest.computed.sensitivity!.tornado.length).toBeGreaterThan(0);
    const capexSwitch = invest.computed.switchingValues!.find((s) => s.variable === "capex");
    expect(capexSwitch).toBeDefined();
    expect(capexSwitch!.percentChange).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Gate evidence packs and independence (#410-411, #415)               */
/* ------------------------------------------------------------------ */

describe("gate evidence packs", () => {
  async function createGate(pid: string, gateNumber: number) {
    const res = await post(`/projects/${pid}/stage-gates`, {
      gateNumber,
      name: `Gate ${gateNumber}`,
      criteria: [
        { text: "Business case approved", evidenceRequired: true },
        { text: "Funding confirmed" },
      ],
    });
    expect(res.statusCode).toBe(201);
    return res.json() as Json;
  }

  /**
   * The audit found approve/reject and gate reviews behind `standard`: any
   * project member — the estimator, a contractor-side user — could approve a
   * business case or record a Gateway "stop". Both now require
   * governance:admin, and reviews additionally require independence.
   */
  it("REGRESSION: a governance:standard member cannot approve a case or record a gate review", async () => {
    const pid = await makeProject("Standard cannot decide");
    const member = await registerActor(app);
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: member.userId,
      role: "member",
    });
    await app.db.insert(projectMemberships).values({
      id: newId("pm"),
      companyId: owner.companyId,
      projectId: pid,
      userId: member.userId,
      templateKey: "read_only",
      overrides: { governance: "standard" },
    });
    const memberHeaders = {
      authorization: member.headers["authorization"]!,
      "x-company-id": owner.companyId,
    };

    const bc = await createBc(pid);
    const optRes = await put(`/projects/${pid}/business-cases/${bc.id as string}/options`, {
      options: [
        {
          name: "Do minimum",
          isCounterfactual: true,
          capex: 100,
          annualBenefits: [60, 60],
          annualCosts: [],
        },
        {
          name: "Full scheme",
          capex: 100,
          annualBenefits: [90, 90],
          annualCosts: [],
        },
      ],
    });
    expect(optRes.statusCode).toBe(200);
    const options = (optRes.json() as Json).options as Json[];
    await post(`/projects/${pid}/business-cases/${bc.id as string}/select-option`, {
      optionId: options[1]!.id,
    });
    await post(`/projects/${pid}/business-cases/${bc.id as string}/submit`);

    // the member can still READ and can still do standard work…
    const read = await get(`/projects/${pid}/business-cases`, memberHeaders);
    expect(read.statusCode).toBe(200);
    // …but not decide the case
    const approve = await post(
      `/projects/${pid}/business-cases/${bc.id as string}/approve`,
      {},
      memberHeaders,
    );
    expect(approve.statusCode).toBe(403);
    const reject = await post(
      `/projects/${pid}/business-cases/${bc.id as string}/reject`,
      { reason: "no" },
      memberHeaders,
    );
    expect(reject.statusCode).toBe(403);

    const gate = (
      await post(`/projects/${pid}/stage-gates`, {
        gateNumber: 0,
        name: "Gate 0",
        criteria: [{ text: "Strategic fit" }],
      })
    ).json() as Json;
    const review = await post(
      `/projects/${pid}/stage-gates/${gate.id as string}/reviews`,
      {
        reviewDate: todayISO(),
        rag: "red",
        decision: "stop",
        findings: (gate.criteria as Json[]).map((c) => ({ criterionId: c.id, met: false })),
      },
      memberHeaders,
    );
    expect(review.statusCode).toBe(403);
  });

  it("REGRESSION: refuses a decision when an evidence-required criterion has no artefact", async () => {
    const pid = await makeProject("Pack required");
    const gate = await createGate(pid, 1);
    const criteria = gate.criteria as Json[];
    const res = await post(`/projects/${pid}/stage-gates/${gate.id as string}/reviews`, {
      reviewDate: todayISO(),
      rag: "green",
      decision: "proceed",
      findings: criteria.map((c) => ({ criterionId: c.id, met: true })),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toContain("requiring evidence");
  });

  it("freezes a merkle-rooted evidence pack on the review", async () => {
    const pid = await makeProject("Pack frozen");
    const gate = await createGate(pid, 2);
    const criteria = gate.criteria as Json[];
    const ev1 = await seedEvidence(pid, "IPA assurance review report");
    const res = await post(`/projects/${pid}/stage-gates/${gate.id as string}/reviews`, {
      reviewDate: todayISO(),
      rag: "green",
      decision: "proceed",
      findings: criteria.map((c, i) => ({
        criterionId: c.id,
        met: true,
        ...(i === 0 ? { evidenceIds: [ev1] } : {}),
      })),
    });
    expect(res.statusCode).toBe(201);
    const pack = (res.json() as Json).evidencePack as {
      merkleRoot: string;
      items: Array<{ id: string; sha256: string; kind: string }>;
      unevidencedCriteria: Json[];
      frozenAt: string;
    };
    expect(pack.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.items).toHaveLength(1);
    expect(pack.items[0]!.id).toBe(ev1);
    expect(pack.unevidencedCriteria).toEqual([]);
    expect(pack.frozenAt).toBeTruthy();
  });

  it("rejects evidence belonging to another project", async () => {
    const pid = await makeProject("Pack cross project");
    const other = await makeProject("Somebody else's project");
    const gate = await createGate(pid, 3);
    const criteria = gate.criteria as Json[];
    const foreign = await seedEvidence(other, "Another project's report");
    const res = await post(`/projects/${pid}/stage-gates/${gate.id as string}/reviews`, {
      reviewDate: todayISO(),
      rag: "green",
      decision: "proceed",
      findings: criteria.map((c, i) => ({
        criterionId: c.id,
        met: true,
        ...(i === 0 ? { evidenceIds: [foreign] } : {}),
      })),
    });
    expect(res.statusCode).toBe(400);
  });

  it("REGRESSION: a hold decision leaves the gate in review, not decided", async () => {
    const pid = await makeProject("Hold decision");
    const gate = await createGate(pid, 4);
    const criteria = gate.criteria as Json[];
    const ev1 = await seedEvidence(pid);
    const res = await post(`/projects/${pid}/stage-gates/${gate.id as string}/reviews`, {
      reviewDate: todayISO(),
      rag: "amber",
      decision: "hold",
      findings: criteria.map((c, i) => ({
        criterionId: c.id,
        met: i !== 0,
        ...(i === 0 ? { evidenceIds: [ev1] } : {}),
      })),
    });
    expect(res.statusCode).toBe(201);
    const after = (await get(`/projects/${pid}/stage-gates/${gate.id as string}`)).json() as Json;
    expect(after.status).toBe("in_review");
    // a held gate can still be edited and re-reviewed
    const edit = await patch(`/projects/${pid}/stage-gates/${gate.id as string}`, {
      description: "Revised scope",
    });
    expect(edit.statusCode).toBe(200);
  });

  /* ---------------------------------------------------------------- */
  /* Lessons closure gate (#415)                                       */
  /* ---------------------------------------------------------------- */

  async function seedLesson(pid: string, status: string, number: string) {
    const id = newId("lsn");
    await app.db.insert(lessons).values({
      id,
      companyId: owner.companyId,
      projectId: pid,
      originProjectId: pid,
      number,
      title: `Lesson ${number}`,
      category: "commercial",
      whatHappened: "The ground investigation was too narrow.",
      recommendation: "Investigate the whole footprint before the works contract.",
      status,
      createdBy: owner.userId,
    });
    return id;
  }

  it("reports lessons readiness and blocks a proceed decision while lessons are unvalidated", async () => {
    const pid = await makeProject("Lessons gate");
    const create = await post(`/projects/${pid}/stage-gates`, {
      gateNumber: 5,
      name: "Gate 5 — lessons closure",
      criteria: [{ text: "Stage complete" }],
      lessonsRequired: true,
    });
    expect(create.statusCode).toBe(201);
    const gate = create.json() as Json;
    expect(gate.lessonsRequired).toBe(true);

    // nothing captured at all → not ready, and it says why
    const empty = (
      await get(`/projects/${pid}/stage-gates/${gate.id as string}/lessons-readiness`)
    ).json() as { ready: boolean; capturedCount: number; reasons: string[] };
    expect(empty.ready).toBe(false);
    expect(empty.capturedCount).toBe(0);
    expect(empty.reasons.join(" ")).toMatch(/No lesson has been captured/i);

    await seedLesson(pid, "draft", "LSN-001");
    const blocked = await post(`/projects/${pid}/stage-gates/${gate.id as string}/reviews`, {
      reviewDate: todayISO(),
      rag: "green",
      decision: "proceed",
      findings: (gate.criteria as Json[]).map((c) => ({ criterionId: c.id, met: true })),
    });
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { message: string }).message).toMatch(/awaiting validation/i);

    // a stop decision is never blocked by unfinished paperwork
    const stop = await post(`/projects/${pid}/stage-gates/${gate.id as string}/reviews`, {
      reviewDate: todayISO(),
      rag: "red",
      decision: "stop",
      findings: (gate.criteria as Json[]).map((c) => ({ criterionId: c.id, met: false })),
    });
    expect(stop.statusCode).toBe(201);
  });

  it("lets the gate proceed once every captured lesson has been ruled on", async () => {
    const pid = await makeProject("Lessons closed");
    const gate = (
      await post(`/projects/${pid}/stage-gates`, {
        gateNumber: 5,
        name: "Gate 5",
        criteria: [{ text: "Stage complete" }],
        lessonsRequired: true,
      })
    ).json() as Json;
    await seedLesson(pid, "validated", "LSN-010");
    await seedLesson(pid, "rejected", "LSN-011");

    const readiness = (
      await get(`/projects/${pid}/stage-gates/${gate.id as string}/lessons-readiness`)
    ).json() as { ready: boolean; closedCount: number; outstanding: Json[] };
    expect(readiness.ready).toBe(true);
    expect(readiness.closedCount).toBe(2);
    expect(readiness.outstanding).toEqual([]);

    const res = await post(`/projects/${pid}/stage-gates/${gate.id as string}/reviews`, {
      reviewDate: todayISO(),
      rag: "green",
      decision: "proceed",
      findings: (gate.criteria as Json[]).map((c) => ({ criterionId: c.id, met: true })),
    });
    expect(res.statusCode).toBe(201);
  });

  it("leaves gates without the requirement untouched, and reports lessons for information", async () => {
    const pid = await makeProject("Lessons optional");
    const gate = (
      await post(`/projects/${pid}/stage-gates`, {
        gateNumber: 5,
        name: "Gate 5",
        criteria: [{ text: "Stage complete" }],
      })
    ).json() as Json;
    expect(gate.lessonsRequired).toBe(false);
    await seedLesson(pid, "draft", "LSN-020");
    const readiness = (
      await get(`/projects/${pid}/stage-gates/${gate.id as string}/lessons-readiness`)
    ).json() as { required: boolean; ready: boolean; outstanding: Json[] };
    expect(readiness.required).toBe(false);
    expect(readiness.ready).toBe(true);
    expect(readiness.outstanding).toHaveLength(1);

    const res = await post(`/projects/${pid}/stage-gates/${gate.id as string}/reviews`, {
      reviewDate: todayISO(),
      rag: "green",
      decision: "proceed",
      findings: (gate.criteria as Json[]).map((c) => ({ criterionId: c.id, met: true })),
    });
    expect(res.statusCode).toBe(201);
  });

  it("REGRESSION: concurrent gate creation surfaces 409, never a 500", async () => {
    const pid = await makeProject("Gate race");
    const results = await Promise.all([
      post(`/projects/${pid}/stage-gates`, {
        gateNumber: 7,
        name: "Gate 7 A",
        criteria: [{ text: "x" }],
      }),
      post(`/projects/${pid}/stage-gates`, {
        gateNumber: 7,
        name: "Gate 7 B",
        criteria: [{ text: "y" }],
      }),
    ]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes[0]).toBe(201);
    expect(codes[1]).toBe(409);
  });
});

/* ------------------------------------------------------------------ */
/* Benefits: network, logic model, realisation (#418-422)              */
/* ------------------------------------------------------------------ */

describe("benefits network and realisation", () => {
  it("REGRESSION: a stale benefit is re-evaluated on a plain read, not only on write", async () => {
    const pid = await makeProject("Stale benefit");
    const b = await createBenefit(pid, {
      name: "Carbon reduction",
      unit: "tCO2e",
      baselineValue: 0,
      targetValue: 1000,
      targetDate: addDaysISO(todayISO(), 5),
    });
    await post(`/projects/${pid}/benefits/${b.id as string}/readings`, {
      readingDate: todayISO(),
      value: 100,
    });
    expect(
      ((await get(`/projects/${pid}/benefits/${b.id as string}`)).json() as Json).status,
    ).toBe("tracking");

    // move the target date deep into the past directly in the DB — no write
    // through the API, exactly like the passage of time
    await app.db
      .update(benefits)
      .set({ targetDate: addDaysISO(todayISO(), -120) })
      .where(eq(benefits.id, b.id as string));

    const detail = (await get(`/projects/${pid}/benefits/${b.id as string}`)).json() as Json;
    expect(detail.status).toBe("missed");
    const list = (await get(`/projects/${pid}/benefits`)).json() as { items: Json[] };
    expect(list.items.find((i) => i.id === b.id)!.status).toBe("missed");
  });

  it("propagates at_risk upstream through an enables dependency, and refuses cycles", async () => {
    const pid = await makeProject("Benefit network");
    const upstream = await createBenefit(pid, {
      name: "Depot commissioned",
      unit: "percent",
      baselineValue: 0,
      targetValue: 100,
      targetDate: addDaysISO(todayISO(), -30),
    });
    const downstream = await createBenefit(pid, {
      name: "Fleet availability",
      unit: "percent",
      baselineValue: 0,
      targetValue: 100,
      targetDate: addDaysISO(todayISO(), 300),
    });
    await post(`/projects/${pid}/benefits/${upstream.id as string}/readings`, {
      readingDate: todayISO(),
      value: 10,
    });

    const dep = await post(`/projects/${pid}/benefits/dependencies`, {
      fromBenefitId: upstream.id,
      toBenefitId: downstream.id,
      depType: "enables",
    });
    expect(dep.statusCode).toBe(201);

    const dupe = await post(`/projects/${pid}/benefits/dependencies`, {
      fromBenefitId: upstream.id,
      toBenefitId: downstream.id,
      depType: "enables",
    });
    expect(dupe.statusCode).toBe(409);

    const cycle = await post(`/projects/${pid}/benefits/dependencies`, {
      fromBenefitId: downstream.id,
      toBenefitId: upstream.id,
      depType: "enables",
    });
    expect(cycle.statusCode).toBe(400);

    const self = await post(`/projects/${pid}/benefits/dependencies`, {
      fromBenefitId: upstream.id,
      toBenefitId: upstream.id,
    });
    expect(self.statusCode).toBe(400);

    const net = (await get(`/projects/${pid}/benefits/network`)).json() as {
      nodes: Array<{ id: string; ownStatus: string; effectiveStatus: string; inherited: boolean }>;
      edges: Json[];
      basis: string;
    };
    const up = net.nodes.find((n) => n.id === upstream.id)!;
    const down = net.nodes.find((n) => n.id === downstream.id)!;
    expect(up.ownStatus).toBe("at_risk");
    expect(down.ownStatus).toBe("tracking");
    expect(down.effectiveStatus).toBe("at_risk");
    expect(down.inherited).toBe(true);
    expect(net.edges).toHaveLength(1);

    const removed = await del(`/projects/${pid}/benefit-dependencies/${(dep.json() as Json).id as string}`);
    expect(removed.statusCode).toBe(204);
    const after = (await get(`/projects/${pid}/benefits/network`)).json() as { edges: Json[] };
    expect(after.edges).toHaveLength(0);
  });

  it("builds a realisation dashboard grouped by unit and never summed across units", async () => {
    const pid = await makeProject("Realisation");
    const minutes = await createBenefit(pid, {
      name: "Journey time",
      unit: "minutes",
      baselineValue: 0,
      targetValue: 100,
      targetDate: addDaysISO(todayISO(), -10),
    });
    await createBenefit(pid, {
      name: "Carbon",
      unit: "tCO2e",
      baselineValue: 0,
      targetValue: 50,
      targetDate: addDaysISO(todayISO(), 90),
    });
    await post(`/projects/${pid}/benefits/${minutes.id as string}/readings`, {
      readingDate: addDaysISO(todayISO(), -20),
      value: 40,
    });

    const dash = (await get(`/projects/${pid}/benefits/realisation`)).json() as {
      total: number;
      byStatus: Record<string, number>;
      series: Array<{ unit: string; benefits: number; points: Array<{ planned: number; realised: number }> }>;
      basis: string;
    };
    expect(dash.total).toBe(2);
    expect(dash.series.map((s) => s.unit).sort()).toEqual(["minutes", "tCO2e"]);
    const minutesSeries = dash.series.find((s) => s.unit === "minutes")!;
    expect(minutesSeries.benefits).toBe(1);
    expect(minutesSeries.points.at(-1)!.realised).toBe(40);
    expect(minutesSeries.points.at(-1)!.planned).toBe(100);
    expect(dash.basis).toContain("never summed across units");
  });

  it("stores a logic model and validates its edges and benefit references", async () => {
    const pid = await makeProject("Logic model");
    const bc = await createBc(pid);
    const b = await createBenefit(pid);

    const bad = await put(`/projects/${pid}/business-cases/${bc.id as string}/logic-model`, {
      nodes: [{ id: "n1", level: "input", label: "Capital" }],
      edges: [{ from: "n1", to: "missing" }],
    });
    expect(bad.statusCode).toBe(400);

    const ok = await put(`/projects/${pid}/business-cases/${bc.id as string}/logic-model`, {
      nodes: [
        { id: "n1", level: "input", label: "Capital budget" },
        { id: "n2", level: "output", label: "New depot" },
        { id: "n3", level: "outcome", label: "Shorter journeys", benefitId: b.id },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3" },
      ],
    });
    expect(ok.statusCode).toBe(200);
    const lm = (ok.json() as Json).logicModel as { nodes: Json[]; edges: Json[] };
    expect(lm.nodes).toHaveLength(3);
    expect(lm.edges).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Assurance actions + reviewer workspace (#415)                       */
/* ------------------------------------------------------------------ */

describe("assurance actions", () => {
  it("numbers actions, backs dated ones with an obligation and closes them with evidence", async () => {
    const pid = await makeProject("Assurance actions");
    const due = addDaysISO(todayISO(), 20);
    const created = await post(`/projects/${pid}/assurance-actions`, {
      title: "Appoint an independent cost assurer",
      source: "assurance_review",
      priority: "essential",
      ownerId: owner.userId,
      dueDate: due,
    });
    expect(created.statusCode).toBe(201);
    const action = created.json() as Json;
    expect(action.number).toBe(1);
    expect(action.status).toBe("open");
    expect(typeof action.obligationId).toBe("string");

    const obl = (
      await app.db
        .select()
        .from(obligations)
        .where(eq(obligations.id, action.obligationId as string))
    )[0]!;
    expect(obl.status).toBe("open");
    expect(obl.deadline).toContain(due);

    const evId = await seedEvidence(pid, "Assurer appointment letter");
    const bogus = await post(`/projects/${pid}/assurance-actions/${action.id as string}/close`, {
      evidenceIds: ["evd_nonexistent"],
    });
    expect(bogus.statusCode).toBe(400);

    const closed = await post(`/projects/${pid}/assurance-actions/${action.id as string}/close`, {
      note: "Appointed",
      evidenceIds: [evId],
    });
    expect(closed.statusCode).toBe(200);
    expect((closed.json() as Json).status).toBe("done");
    const oblAfter = (
      await app.db
        .select()
        .from(obligations)
        .where(eq(obligations.id, action.obligationId as string))
    )[0]!;
    expect(oblAfter.status).toBe("satisfied");

    expect(
      (await post(`/projects/${pid}/assurance-actions/${action.id as string}/close`, {})).statusCode,
    ).toBe(400);
  });

  it("sweeps overdue actions to 'overdue' idempotently", async () => {
    const pid = await makeProject("Overdue actions");
    const created = (
      await post(`/projects/${pid}/assurance-actions`, {
        title: "Close out the gate condition",
        dueDate: addDaysISO(todayISO(), -5),
      })
    ).json() as Json;

    await app.scheduler.runNow("governance.assurance-actions");
    await app.scheduler.runNow("governance.assurance-actions");
    const after = (
      await get(`/projects/${pid}/assurance-actions/${created.id as string}`)
    ).json() as Json;
    expect(after.status).toBe("overdue");
  });

  it("lists gates, open conditions and actions across the company for a reviewer", async () => {
    const pid = await makeProject("Reviewer workspace");
    await post(`/projects/${pid}/stage-gates`, {
      gateNumber: 1,
      name: "Gate 1",
      plannedDate: addDaysISO(todayISO(), 14),
      criteria: [{ text: "Scope agreed" }],
    });
    await post(`/projects/${pid}/assurance-actions`, {
      title: "Publish the delivery confidence assessment",
      dueDate: addDaysISO(todayISO(), 3),
    });

    const ws = (await get(`/governance/reviewer-workspace`)).json() as {
      gates: Json[];
      conditions: Json[];
      actions: Json[];
      projects: Json[];
    };
    expect(ws.gates.length).toBeGreaterThan(0);
    expect(ws.actions.some((a) => a.projectId === pid)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Health inputs + isolation                                           */
/* ------------------------------------------------------------------ */

describe("governance health inputs and isolation", () => {
  it("reports metrics with reasons for anything unmeasurable", async () => {
    const pid = await makeProject("Governance health");
    const empty = (await get(`/projects/${pid}/governance/health-inputs`)).json() as {
      metrics: Record<string, number | null>;
      reasons: string[];
    };
    expect(empty.metrics["gates"]).toBe(0);
    expect(empty.metrics["latestRagScore"]).toBeNull();
    expect(empty.reasons.length).toBeGreaterThan(0);

    await createBenefit(pid, { targetDate: addDaysISO(todayISO(), -200) });
    const filled = (await get(`/projects/${pid}/governance/health-inputs`)).json() as {
      metrics: Record<string, number | null>;
    };
    expect(filled.metrics["benefits"]).toBe(1);
  });

  it("keeps every upgraded governance route invisible to another company", async () => {
    const bc = await createBc(projectId);
    for (const url of [
      `/projects/${projectId}/benefits/network`,
      `/projects/${projectId}/benefits/realisation`,
      `/projects/${projectId}/assurance-actions`,
      `/projects/${projectId}/governance/health-inputs`,
      `/projects/${projectId}/business-cases/${bc.id as string}/uplift-challenges`,
    ]) {
      const res = await get(url, stranger.headers);
      expect([403, 404]).toContain(res.statusCode);
    }
    const write = await post(
      `/projects/${projectId}/assurance-actions`,
      { title: "Sneak in" },
      stranger.headers,
    );
    expect([403, 404]).toContain(write.statusCode);

    // the reviewer workspace of another company never leaks this company's rows
    const theirs = await get(`/governance/reviewer-workspace`, stranger.headers);
    if (theirs.statusCode === 200) {
      const body = theirs.json() as { gates: Array<{ projectId: string }> };
      expect(body.gates.every((g) => g.projectId !== projectId)).toBe(true);
    } else {
      expect([403, 404]).toContain(theirs.statusCode);
    }
  });
});

/* keep the unused-import checker honest about `and` */
void and;
