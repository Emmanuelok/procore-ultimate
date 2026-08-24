import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  events,
  ledgerEntries,
  notifications,
  obligations,
  projects,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let reviewer: TestActor; // second member of owner's company (independent decision-maker)
let reviewerHeaders: Record<string, string>;
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
  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Capital Governance Test Project",
  });
});

afterAll(async () => {
  await built.close();
});

type Json = Record<string, unknown>;

async function post(url: string, payload?: unknown, headers = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload as Json });
}
async function put(url: string, payload: unknown) {
  return app.inject({ method: "PUT", url: `/api/v1${url}`, headers: owner.headers, payload: payload as Json });
}
async function patch(url: string, payload: unknown) {
  return app.inject({ method: "PATCH", url: `/api/v1${url}`, headers: owner.headers, payload: payload as Json });
}
async function get(url: string) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers: owner.headers });
}

async function createBc(over: Json = {}) {
  const res = await post(`/projects/${projectId}/business-cases`, {
    stage: "outline",
    title: "New Bypass OBC",
    cases: { strategic: "Congestion relief", economic: "CBA below" },
    appraisal: { discountRatePercent: 10, appraisalYears: 2, optimismBiasPercent: 0 },
    ...over,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as Json;
}

const buildOption = {
  name: "Build the bypass",
  capex: 100,
  annualBenefits: [60, 60],
  annualCosts: [],
};

/* ------------------------------------------------------------------ */
/* Business cases (#394-405)                                           */
/* ------------------------------------------------------------------ */

describe("business cases", () => {
  it("creates with five-case narratives and defaults the Green Book discount rate (#395, #401)", async () => {
    const res = await post(`/projects/${projectId}/business-cases`, {
      stage: "strategic_outline",
      title: "SOC without explicit rate",
      appraisal: { appraisalYears: 30 },
    });
    expect(res.statusCode).toBe(201);
    const bc = res.json() as Json;
    expect(bc.status).toBe("draft");
    expect((bc.appraisal as Json).discountRatePercent).toBe(3.5); // HM Treasury social time preference rate
    expect((bc.appraisal as Json).optimismBiasPercent).toBe(0);
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.objectType, "business_case"),
          eq(ledgerEntries.objectId, bc.id as string),
        ),
      );
    expect(entries.length).toBe(1);
  });

  it("computes NPV, BCR and payback per option on PUT options (#397-399)", async () => {
    const bc = await createBc();
    const res = await put(`/projects/${projectId}/business-cases/${bc.id}/options`, {
      options: [
        { name: "Do nothing", isCounterfactual: true, capex: 0, annualBenefits: [], annualCosts: [] },
        buildOption,
      ],
    });
    expect(res.statusCode).toBe(200);
    const options = (res.json() as Json).options as Json[];
    expect(options).toHaveLength(2);
    const build = options[1]!;
    expect(typeof build.id).toBe("string");
    const computed = build.computed as Json;
    expect(computed.capexAdjusted).toBe(100);
    expect(computed.npv as number).toBeCloseTo(4.13, 2); // -100 + 60/1.1 + 60/1.21
    expect(computed.bcr as number).toBeCloseTo(1.0413, 3);
    expect(computed.paybackYear).toBe(2);
    const counterfactual = options[0]!;
    expect(counterfactual.isCounterfactual).toBe(true);
    expect((counterfactual.computed as Json).npv).toBe(0);
    expect((counterfactual.computed as Json).bcr).toBeNull();
  });

  it("recomputes every option when the optimism bias uplift changes (#402)", async () => {
    const bc = await createBc();
    await put(`/projects/${projectId}/business-cases/${bc.id}/options`, {
      options: [buildOption],
    });
    const res = await patch(`/projects/${projectId}/business-cases/${bc.id}`, {
      appraisal: { optimismBiasPercent: 20 },
    });
    expect(res.statusCode).toBe(200);
    const computed = ((res.json() as Json).options as Json[])[0]!.computed as Json;
    expect(computed.capexAdjusted).toBe(120); // capex only — 100 x 1.2
    expect(computed.npv as number).toBeCloseTo(4.13 - 20, 2);
    expect(computed.bcr as number).toBeCloseTo(104.1322 / 120, 3);
    expect(computed.paybackYear).toBe(2); // -120 + 60 + 60 = 0
  });

  it("guards the lifecycle: draft-only appraisal/stage/options edits", async () => {
    const bc = await createBc();
    await put(`/projects/${projectId}/business-cases/${bc.id}/options`, { options: [buildOption] });
    const submit = await post(`/projects/${projectId}/business-cases/${bc.id}/submit`);
    expect(submit.statusCode).toBe(200);
    expect((submit.json() as Json).status).toBe("submitted");

    const patchAppraisal = await patch(`/projects/${projectId}/business-cases/${bc.id}`, {
      appraisal: { discountRatePercent: 5 },
    });
    expect(patchAppraisal.statusCode).toBe(400);
    const patchStage = await patch(`/projects/${projectId}/business-cases/${bc.id}`, {
      stage: "full",
    });
    expect(patchStage.statusCode).toBe(400);
    const putOptions = await put(`/projects/${projectId}/business-cases/${bc.id}/options`, {
      options: [buildOption],
    });
    expect(putOptions.statusCode).toBe(400);
    // narrative refinement is still allowed while submitted
    const patchTitle = await patch(`/projects/${projectId}/business-cases/${bc.id}`, {
      title: "Renamed OBC",
    });
    expect(patchTitle.statusCode).toBe(200);
  });

  it("approval requires a preferred option and an independent approver (#396, #412)", async () => {
    const bc = await createBc();
    const optRes = await put(`/projects/${projectId}/business-cases/${bc.id}/options`, {
      options: [buildOption],
    });
    const optionId = ((optRes.json() as Json).options as Json[])[0]!.id as string;
    await post(`/projects/${projectId}/business-cases/${bc.id}/submit`);

    // no preferred option yet — 400 even for an independent approver
    const early = await post(
      `/projects/${projectId}/business-cases/${bc.id}/approve`,
      {},
      reviewerHeaders,
    );
    expect(early.statusCode).toBe(400);

    const badSelect = await post(`/projects/${projectId}/business-cases/${bc.id}/select-option`, {
      optionId: "opt_nonexistent",
    });
    expect(badSelect.statusCode).toBe(400);
    const select = await post(`/projects/${projectId}/business-cases/${bc.id}/select-option`, {
      optionId,
    });
    expect(select.statusCode).toBe(200);

    // determination independence: the author cannot decide their own case
    const selfApprove = await post(`/projects/${projectId}/business-cases/${bc.id}/approve`);
    expect(selfApprove.statusCode).toBe(403);
    const selfReject = await post(`/projects/${projectId}/business-cases/${bc.id}/reject`);
    expect(selfReject.statusCode).toBe(403);

    const approve = await post(
      `/projects/${projectId}/business-cases/${bc.id}/approve`,
      {},
      reviewerHeaders,
    );
    expect(approve.statusCode).toBe(200);
    const approved = approve.json() as Json;
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe(reviewer.userId);
    // approved cases are immutable
    const late = await patch(`/projects/${projectId}/business-cases/${bc.id}`, { title: "x" });
    expect(late.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Stage gates (#408-415)                                              */
/* ------------------------------------------------------------------ */

async function createGate(gateNumber: number, over: Json = {}) {
  const res = await post(`/projects/${projectId}/stage-gates`, {
    gateNumber,
    name: `Gate ${gateNumber}`,
    criteria: [{ text: "Business case approved", evidenceRequired: true }, { text: "Funding confirmed" }],
    ...over,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as Json;
}

describe("stage gates", () => {
  it("creates gates with server-assigned criterion ids, unique per gate number (#408)", async () => {
    const gate = await createGate(0);
    const criteria = gate.criteria as Json[];
    expect(criteria).toHaveLength(2);
    expect(typeof criteria[0]!.id).toBe("string");
    expect(criteria[0]!.evidenceRequired).toBe(true);
    expect(criteria[1]!.evidenceRequired).toBe(false);
    const dup = await post(`/projects/${projectId}/stage-gates`, {
      gateNumber: 0,
      name: "Duplicate",
      criteria: [{ text: "x" }],
    });
    expect(dup.statusCode).toBe(409);
  });

  it("rejects a review whose findings do not cover every criterion, listing the missing ids (#410)", async () => {
    const gate = await createGate(1);
    const criteria = gate.criteria as Json[];
    const res = await post(`/projects/${projectId}/stage-gates/${gate.id}/reviews`, {
      reviewDate: todayISO(),
      rag: "amber",
      decision: "proceed",
      findings: [{ criterionId: criteria[0]!.id, met: true }],
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as Json;
    expect(JSON.stringify(body)).toContain(criteria[1]!.id as string);
    // unknown criterion ids are also rejected
    const unknown = await post(`/projects/${projectId}/stage-gates/${gate.id}/reviews`, {
      reviewDate: todayISO(),
      rag: "amber",
      decision: "proceed",
      findings: [
        { criterionId: criteria[0]!.id, met: true },
        { criterionId: criteria[1]!.id, met: true },
        { criterionId: "crt_bogus", met: true },
      ],
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("materializes conditions as assurance obligations and closes them to satisfaction (#412-413)", async () => {
    const gate = await createGate(2);
    const criteria = gate.criteria as Json[];
    const due = addDaysISO(todayISO(), 30);
    const res = await post(`/projects/${projectId}/stage-gates/${gate.id}/reviews`, {
      reviewDate: todayISO(),
      rag: "amber_green",
      decision: "proceed_with_conditions",
      narrative: "Proceed subject to funding letter",
      findings: (gate.criteria as Json[]).map((c) => ({ criterionId: c.id, met: true })),
      conditions: [{ text: "Provide signed funding letter", dueDate: due }, { text: "Update risk register" }],
    });
    expect(res.statusCode).toBe(201);
    const review = res.json() as Json;
    const conditions = review.conditions as Json[];
    expect(conditions).toHaveLength(2);
    expect(conditions[0]!.closed).toBe(false);

    // each condition is backed by an open assurance obligation with the gate as source clause
    const obl = (
      await app.db
        .select()
        .from(obligations)
        .where(eq(obligations.id, conditions[0]!.obligationId as string))
    )[0]!;
    expect(obl.status).toBe("open");
    expect(obl.sourceClause).toBe("Gate 2 — Gate 2");
    expect(obl.trigger).toBe("Provide signed funding letter");
    expect(obl.deadline).toContain(due);
    expect(obl.warnDaysBefore).toBe(7);

    // gate is decided; a decided gate can no longer be edited
    const gateAfter = (await get(`/projects/${projectId}/stage-gates/${gate.id}`)).json() as Json;
    expect(gateAfter.status).toBe("decided");
    expect((gateAfter.reviews as Json[]).length).toBe(1);
    const editAfter = await patch(`/projects/${projectId}/stage-gates/${gate.id}`, { name: "x" });
    expect(editAfter.statusCode).toBe(400);
    void criteria;

    // open-conditions dashboard shows both, soonest due first, with daysToDue
    const dash = (await get(`/projects/${projectId}/governance/conditions`)).json() as Json;
    const items = (dash.items as Json[]).filter((i) => i.reviewId === review.id);
    expect(items).toHaveLength(2);
    expect(items[0]!.dueDate).toBe(due);
    expect(items[0]!.daysToDue).toBe(30);
    expect(items[1]!.daysToDue).toBeNull();

    // close the first condition — condition closed, obligation satisfied
    const close = await post(
      `/projects/${projectId}/gate-reviews/${review.id}/conditions/${conditions[0]!.id}/close`,
      { note: "Letter received" },
    );
    expect(close.statusCode).toBe(200);
    const closed = ((close.json() as Json).conditions as Json[])[0]!;
    expect(closed.closed).toBe(true);
    expect(closed.closeNote).toBe("Letter received");
    const oblAfter = (
      await app.db
        .select()
        .from(obligations)
        .where(eq(obligations.id, conditions[0]!.obligationId as string))
    )[0]!;
    expect(oblAfter.status).toBe("satisfied");
    const again = await post(
      `/projects/${projectId}/gate-reviews/${review.id}/conditions/${conditions[0]!.id}/close`,
      {},
    );
    expect(again.statusCode).toBe(400);
    const dashAfter = (await get(`/projects/${projectId}/governance/conditions`)).json() as Json;
    expect((dashAfter.items as Json[]).filter((i) => i.reviewId === review.id)).toHaveLength(1);
  });

  it("records a stop decision in the project event graph (#412)", async () => {
    const gate = await createGate(3);
    const res = await post(`/projects/${projectId}/stage-gates/${gate.id}/reviews`, {
      reviewDate: todayISO(),
      rag: "red",
      decision: "stop",
      findings: (gate.criteria as Json[]).map((c) => ({ criterionId: c.id, met: false })),
    });
    expect(res.statusCode).toBe(201);
    const rows = await app.db
      .select()
      .from(events)
      .where(and(eq(events.projectId, projectId), eq(events.type, "gate_stop")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detectedOrReported).toBe("reported");
    expect((rows[0]!.payload as Json).gateId).toBe(gate.id);
  });
});

/* ------------------------------------------------------------------ */
/* Benefits register (#416-421)                                        */
/* ------------------------------------------------------------------ */

async function createBenefit(over: Json = {}) {
  const res = await post(`/projects/${projectId}/benefits`, {
    name: "Journey time saving",
    unit: "min",
    baselineValue: 0,
    targetValue: 100,
    ...over,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as Json;
}

describe("benefits register", () => {
  it("numbers benefits and tracks progress from readings (#416-418)", async () => {
    const b1 = await createBenefit();
    const b2 = await createBenefit({ name: "Air quality uplift", unit: "ug/m3" });
    expect(b2.number).toBe((b1.number as number) + 1);
    expect(b1.status).toBe("planned");

    const r1 = await post(`/projects/${projectId}/benefits/${b1.id}/readings`, {
      readingDate: todayISO(),
      value: 50,
    });
    expect(r1.statusCode).toBe(201);
    const after1 = r1.json() as Json;
    expect(after1.status).toBe("tracking");
    expect(after1.progressPercent).toBe(50);

    const r2 = await post(`/projects/${projectId}/benefits/${b1.id}/readings`, {
      readingDate: todayISO(),
      value: 120,
    });
    const after2 = r2.json() as Json;
    expect(after2.status).toBe("realised"); // >= 100%, overshoot clamped
    expect(after2.progressPercent).toBe(100);

    const listed = (await get(`/projects/${projectId}/benefits`)).json() as Json;
    const row = (listed.items as Json[]).find((i) => i.id === b1.id)!;
    expect(row.latestValue).toBe(120);
    expect(row.progressPercent).toBe(100);
    const one = (await get(`/projects/${projectId}/benefits/${b1.id}`)).json() as Json;
    expect((one.readings as Json[]).length).toBe(2);
  });

  it("tracks disbenefits direction-aware: progress is movement DOWN toward the target (#420)", async () => {
    const d = await createBenefit({
      name: "Construction traffic",
      unit: "HGV/day",
      baselineValue: 100,
      targetValue: 40,
      isDisbenefit: true,
    });
    expect(d.isDisbenefit).toBe(1);
    const worse = await post(`/projects/${projectId}/benefits/${d.id}/readings`, {
      readingDate: addDaysISO(todayISO(), -2),
      value: 130, // moved AWAY from the reduction target
    });
    expect((worse.json() as Json).progressPercent).toBe(0);
    const better = await post(`/projects/${projectId}/benefits/${d.id}/readings`, {
      readingDate: todayISO(),
      value: 70, // halfway down from 100 to 40
    });
    const body = better.json() as Json;
    expect(body.progressPercent).toBe(50);
    expect(body.status).toBe("tracking");
  });

  it("moves to at_risk past the target date below 70% and notifies the owner (#418)", async () => {
    const b = await createBenefit({
      name: "Modal shift",
      unit: "%",
      ownerId: reviewer.userId,
      targetDate: addDaysISO(todayISO(), -10),
    });
    const res = await post(`/projects/${projectId}/benefits/${b.id}/readings`, {
      readingDate: todayISO(),
      value: 40,
    });
    const body = res.json() as Json;
    expect(body.status).toBe("at_risk");
    const notes = await app.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, reviewer.userId),
          eq(notifications.recordId, b.id as string),
        ),
      );
    expect(notes.length).toBe(1);
    expect(notes[0]!.title).toContain("at risk");
  });

  it("moves to missed more than 90 days past the target date below 100% (#418)", async () => {
    const b = await createBenefit({
      name: "Carbon saving",
      unit: "tCO2e",
      ownerId: reviewer.userId,
      targetDate: addDaysISO(todayISO(), -120),
    });
    const res = await post(`/projects/${projectId}/benefits/${b.id}/readings`, {
      readingDate: todayISO(),
      value: 90,
    });
    expect((res.json() as Json).status).toBe("missed");
    const notes = await app.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, reviewer.userId),
          eq(notifications.recordId, b.id as string),
        ),
      );
    expect(notes.length).toBe(1);
    expect(notes[0]!.title).toContain("missed");
  });

  it("re-evaluates status when the target moves via PATCH", async () => {
    const b = await createBenefit({ name: "Noise reduction", unit: "dB", targetValue: 10 });
    await post(`/projects/${projectId}/benefits/${b.id}/readings`, {
      readingDate: todayISO(),
      value: 10,
    });
    const realised = (await get(`/projects/${projectId}/benefits/${b.id}`)).json() as Json;
    expect(realised.status).toBe("realised");
    // stretch the target — no longer fully realised
    const res = await patch(`/projects/${projectId}/benefits/${b.id}`, { targetValue: 20 });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Json).status).toBe("tracking");
  });
});
