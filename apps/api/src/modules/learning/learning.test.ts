import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  bidOpportunities,
  boqItems,
  boqs,
  companyMemberships,
  contracts,
  delayEvents,
  disputes,
  forensicClaims,
  insuranceCertificates,
  gateReviews,
  lessonTriggers,
  ledgerEntries,
  obligations,
  paymentCertificates,
  projectMemberships,
  projects,
  punchItems,
  recordLinks,
  rfis,
  riskRealisations,
  risks,
  scheduleBaselines,
  scheduleTasks,
  schedules,
  signals,
  stageGates,
  valuationLines,
  valuations,
  vendors,
  variations,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

// The AI layer must be OFF for the fallback assertions to mean anything.
delete process.env.ANTHROPIC_API_KEY;

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let validator: TestActor; // independent second pair of eyes, company admin
let reader: TestActor; // project member on the read_only template
let outsider: TestActor; // a different tenant entirely
let validatorHeaders: Record<string, string>;
let readerHeaders: Record<string, string>;

let projectId: string; // populated delivery project
let bareProjectId: string; // nothing has ever happened here
let thresholdProjectId: string; // carries a configured variation threshold

const CONFIRMED_SIGNAL_TITLE = "Certifier also authored the valuation";

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  validator = await registerActor(app);
  reader = await registerActor(app);
  outsider = await registerActor(app);

  await app.db.insert(companyMemberships).values([
    { id: newId("cm"), companyId: owner.companyId, userId: validator.userId, role: "admin" },
    { id: newId("cm"), companyId: owner.companyId, userId: reader.userId, role: "member" },
  ]);
  validatorHeaders = {
    authorization: validator.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };
  readerHeaders = {
    authorization: reader.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  projectId = newId("prj");
  bareProjectId = newId("prj");
  thresholdProjectId = newId("prj");
  await app.db.insert(projects).values([
    {
      id: projectId,
      companyId: owner.companyId,
      name: "Riverside Interchange",
      currency: "GBP",
      stage: "course_of_construction",
    },
    { id: bareProjectId, companyId: owner.companyId, name: "Greenfield Depot", currency: "GBP" },
    {
      id: thresholdProjectId,
      companyId: owner.companyId,
      name: "Threshold Test Works",
      currency: "GBP",
      settings: { learning: { variationTriggerThreshold: 5_000 } },
    },
  ]);
  // reader is a plain company member: project reach comes from the template
  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId,
    userId: reader.userId,
    templateKey: "read_only",
  });

  /* ---- records that MUST fire a mandatory-capture trigger --------- */

  await app.db.insert(disputes).values({
    id: newId("dsp"),
    companyId: owner.companyId,
    projectId,
    number: 1,
    title: "Adjudication over disputed retention release",
    kind: "adjudication",
    status: "decided",
    outcome: "Adjudicator found for the contractor",
    amountInDispute: 420_000,
    currency: "GBP",
    createdBy: owner.userId,
  });
  await app.db.insert(forensicClaims).values({
    id: newId("fcl"),
    companyId: owner.companyId,
    projectId,
    number: 1,
    title: "Prolongation from late piling information",
    kind: "prolongation",
    status: "agreed",
    amountClaimed: 900_000,
    amountAssessed: 310_000,
    daysAssessed: 34,
    createdBy: owner.userId,
  });
  await app.db.insert(delayEvents).values({
    id: newId("dly"),
    companyId: owner.companyId,
    projectId,
    number: 1,
    title: "Unforeseen ground conditions at pier 3",
    cause: "ground_conditions",
    status: "closed",
    startDate: "2025-06-02",
    durationDays: 28,
    excusable: 1,
    compensable: 1,
    raisedBy: owner.userId,
  });
  await app.db.insert(variations).values([
    {
      id: newId("var"),
      companyId: owner.companyId,
      projectId,
      number: 1,
      title: "Redesign of pier 3 foundations",
      status: "agreed",
      agreedValue: 250_000,
      timeImpactDays: 21,
      createdBy: owner.userId,
    },
    {
      id: newId("var"),
      companyId: owner.companyId,
      projectId,
      number: 2,
      title: "Proposed cladding upgrade (never instructed)",
      status: "proposed",
      costEstimate: 900_000,
      createdBy: owner.userId,
    },
  ]);
  await app.db.insert(signals).values([
    {
      id: newId("sig"),
      companyId: owner.companyId,
      projectId,
      detector: "certifier_independence",
      severity: "high",
      confidence: 0.9,
      title: CONFIRMED_SIGNAL_TITLE,
      explanation: "The same actor authored and certified valuation 4.",
      disposition: "confirmed",
      reviewerId: validator.userId,
    },
    {
      id: newId("sig"),
      companyId: owner.companyId,
      projectId,
      detector: "round_number_clustering",
      severity: "low",
      confidence: 0.4,
      title: "Round-number clustering in daywork sheets",
      explanation: "Undispositioned — must not fire a trigger.",
      disposition: "new",
    },
  ]);
  const gateId = newId("gat");
  await app.db.insert(stageGates).values({
    id: gateId,
    companyId: owner.companyId,
    projectId,
    gateNumber: 3,
    name: "Investment decision",
    criteria: [],
    status: "decided",
  });
  await app.db.insert(gateReviews).values({
    id: newId("grv"),
    gateId,
    companyId: owner.companyId,
    projectId,
    reviewDate: "2025-09-15",
    rag: "amber_red",
    decision: "proceed_with_conditions",
    reviewedBy: validator.userId,
    findings: [],
    conditions: [],
  });

  /* ---- records the metrics computation reads ---------------------- */

  await app.db.insert(contracts).values({
    id: newId("con"),
    companyId: owner.companyId,
    projectId,
    name: "Main works",
    form: "nec4_ecc",
    status: "executed",
    currency: "GBP",
    contractSum: 10_000_000,
    createdBy: owner.userId,
  });
  const boqId = newId("boq");
  await app.db.insert(boqs).values({
    id: boqId,
    companyId: owner.companyId,
    projectId,
    name: "Main works BQ",
    currency: "GBP",
    status: "agreed",
    createdBy: owner.userId,
  });
  const valuationIds = [newId("val"), newId("val")];
  await app.db.insert(valuations).values([
    {
      id: valuationIds[0]!,
      companyId: owner.companyId,
      projectId,
      boqId,
      number: 1,
      valuationDate: "2026-01-31",
      createdBy: owner.userId,
    },
    {
      id: valuationIds[1]!,
      companyId: owner.companyId,
      projectId,
      boqId,
      number: 2,
      valuationDate: "2026-02-28",
      createdBy: owner.userId,
    },
  ]);
  await app.db.insert(paymentCertificates).values([
    {
      id: newId("cert"),
      companyId: owner.companyId,
      projectId,
      valuationId: valuationIds[0]!,
      number: 1,
      netCertified: 4_000_000,
      issuedBy: validator.userId,
    },
    {
      id: newId("cert"),
      companyId: owner.companyId,
      projectId,
      valuationId: valuationIds[1]!,
      number: 2,
      netCertified: 7_000_000,
      issuedBy: validator.userId,
    },
  ]);
  const scheduleId = newId("sch");
  await app.db.insert(schedules).values({
    id: scheduleId,
    companyId: owner.companyId,
    projectId,
    name: "Delivery programme",
    projectStart: "2025-01-01",
    isActive: 1,
    computedFinish: "2026-08-15",
    createdBy: owner.userId,
  });
  await app.db.insert(scheduleBaselines).values({
    id: newId("bsl"),
    scheduleId,
    projectId,
    name: "Contract baseline",
    projectStart: "2025-01-01",
    computedFinish: "2026-06-30",
    snapshot: [],
    capturedBy: owner.userId,
  });
  await app.db.insert(scheduleTasks).values([
    {
      id: newId("tsk"),
      scheduleId,
      projectId,
      name: "Practical completion",
      durationDays: 0,
      actualFinish: "2026-08-15",
    },
    {
      id: newId("tsk"),
      scheduleId,
      projectId,
      name: "Pier 3 foundations",
      durationDays: 40,
      actualFinish: "2026-03-02",
    },
  ]);
  await app.db.insert(rfis).values([
    {
      id: newId("rfi"),
      companyId: owner.companyId,
      projectId,
      number: 1,
      subject: "Pier 3 rebar congestion",
      question: "q",
      status: "closed",
      respondedAt: new Date().toISOString(),
      createdBy: owner.userId,
    },
    {
      id: newId("rfi"),
      companyId: owner.companyId,
      projectId,
      number: 2,
      subject: "Cladding fixing centres",
      question: "q",
      status: "open",
      createdBy: owner.userId,
    },
  ]);
  await app.db.insert(punchItems).values([
    {
      id: newId("pnc"),
      companyId: owner.companyId,
      projectId,
      number: 1,
      title: "Snag: handrail finish",
      status: "open",
      createdBy: owner.userId,
    },
    {
      id: newId("pnc"),
      companyId: owner.companyId,
      projectId,
      number: 2,
      title: "Snag: door closer",
      status: "closed",
      createdBy: owner.userId,
    },
  ]);
  await app.db.insert(obligations).values({
    id: newId("obl"),
    companyId: owner.companyId,
    projectId,
    sourceClause: "NEC4 cl.61.3",
    trigger: "Notify a compensation event within 8 weeks",
    status: "breached",
    createdBy: owner.userId,
  });

  // a small variation on the threshold project, under the platform default
  await app.db.insert(variations).values({
    id: newId("var"),
    companyId: owner.companyId,
    projectId: thresholdProjectId,
    number: 1,
    title: "Extra bollards",
    status: "agreed",
    agreedValue: 10_000,
    createdBy: owner.userId,
  });
}, 180_000);

afterAll(async () => {
  await built.close();
});

type Json = Record<string, unknown>;

async function post(url: string, payload?: unknown, headers = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload as Json });
}
async function patch(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload: payload as Json });
}
async function get(url: string, headers = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}

const lessonBody = (over: Json = {}): Json => ({
  title: "Retention release needs a dated checklist",
  category: "commercial",
  phase: "construction",
  whatHappened:
    "Retention was released against an undated checklist, and the adjudicator treated the " +
    "release as an admission that the works were complete.",
  rootCause: "No dated evidence pack attached to the release approval.",
  recommendation: "Attach a dated completion checklist to every retention release approval.",
  impactValue: 420_000,
  impactCurrency: "GBP",
  impactDays: 21,
  tags: ["Retention", "adjudication", "commercial"],
  ...over,
});

/** Create → submit → validate (independently) → publish. Returns the lesson. */
async function publishLesson(over: Json = {}): Promise<Json> {
  const created = await post(`/projects/${projectId}/learning/lessons`, lessonBody(over));
  expect(created.statusCode).toBe(201);
  const id = (created.json() as Json).id as string;
  expect((await post(`/projects/${projectId}/learning/lessons/${id}/submit`)).statusCode).toBe(200);
  const validated = await post(
    `/projects/${projectId}/learning/lessons/${id}/validate`,
    undefined,
    validatorHeaders,
  );
  expect(validated.statusCode).toBe(200);
  const published = await post(`/projects/${projectId}/learning/lessons/${id}/publish`);
  expect(published.statusCode).toBe(200);
  return published.json() as Json;
}

/* ================================================================== */
/* Lesson lifecycle — validation is a second pair of eyes              */
/* ================================================================== */

describe("lesson lifecycle", () => {
  it("creates a draft with an auto-allocated number, normalized tags and a ledger entry", async () => {
    const res = await post(`/projects/${projectId}/learning/lessons`, lessonBody());
    expect(res.statusCode).toBe(201);
    const lesson = res.json() as Json;
    expect(lesson.status).toBe("draft");
    expect(lesson.number).toMatch(/^LL-\d{4}$/);
    expect(lesson.originProjectId).toBe(projectId);
    expect(lesson.projectId).toBe(projectId);
    // tags are lowercased, de-duplicated and sorted so retrieval can match them
    expect(lesson.tags).toEqual(["adjudication", "commercial", "retention"]);

    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.objectType, "lesson"), eq(ledgerEntries.objectId, lesson.id as string)),
      );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("create");
  });

  it("refuses to let the author validate their own lesson (403)", async () => {
    const created = await post(`/projects/${projectId}/learning/lessons`, lessonBody());
    const id = (created.json() as Json).id as string;
    await post(`/projects/${projectId}/learning/lessons/${id}/submit`);
    const res = await post(`/projects/${projectId}/learning/lessons/${id}/validate`);
    expect(res.statusCode).toBe(403);
    expect((res.json() as Json).message).toContain("second pair of eyes");
    const after = await get(`/learning/lessons/${id}`);
    expect((after.json() as Json).status).toBe("submitted");
  });

  it("refuses to let the submitter validate either, even when someone else authored it", async () => {
    // owner authors; validator submits; validator must still not validate
    const created = await post(`/projects/${projectId}/learning/lessons`, lessonBody());
    const id = (created.json() as Json).id as string;
    await post(`/projects/${projectId}/learning/lessons/${id}/submit`, undefined, validatorHeaders);
    const res = await post(
      `/projects/${projectId}/learning/lessons/${id}/validate`,
      undefined,
      validatorHeaders,
    );
    expect(res.statusCode).toBe(403);
    expect((res.json() as Json).message).toContain("submitted");
  });

  it("lets an independent validator validate, and publishing releases it company-wide", async () => {
    const lesson = await publishLesson({ title: "Piling records must be surveyed before award" });
    expect(lesson.status).toBe("published");
    expect(lesson.projectId).toBeNull(); // it belongs to the company now
    expect(lesson.originProjectId).toBe(projectId); // but we never forget where it was learned
    expect(lesson.validatedBy).toBe(validator.userId);
    expect(lesson.validatedBy).not.toBe(lesson.createdBy);
    expect(lesson.publishedAt).toBeTruthy();
  });

  it("rejects with a recorded reason, reopens for editing, and re-submits", async () => {
    const created = await post(`/projects/${projectId}/learning/lessons`, lessonBody());
    const id = (created.json() as Json).id as string;
    await post(`/projects/${projectId}/learning/lessons/${id}/submit`);

    const tooShort = await post(`/projects/${projectId}/learning/lessons/${id}/reject`, {
      reason: "no",
    });
    expect(tooShort.statusCode).toBe(400);

    const rejected = await post(
      `/projects/${projectId}/learning/lessons/${id}/reject`,
      { reason: "The root cause is a restatement of what happened, not a cause." },
      validatorHeaders,
    );
    expect(rejected.statusCode).toBe(200);
    expect((rejected.json() as Json).status).toBe("rejected");
    expect((rejected.json() as Json).rejectionReason).toContain("root cause");

    const edited = await patch(`/projects/${projectId}/learning/lessons/${id}`, {
      rootCause: "The approval workflow had no evidence requirement attached.",
    });
    expect(edited.statusCode).toBe(200);
    const resubmitted = await post(`/projects/${projectId}/learning/lessons/${id}/submit`);
    expect(resubmitted.statusCode).toBe(200);
    expect((resubmitted.json() as Json).rejectionReason).toBeNull();
  });

  it("freezes a published lesson against editing and requires supersession instead", async () => {
    const lesson = await publishLesson({ title: "Frozen lesson" });
    const res = await patch(`/projects/${projectId}/learning/lessons/${lesson.id}`, {
      title: "Quietly rewritten",
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as Json).message).toContain("supersede");

    const replacement = await publishLesson({ title: "Frozen lesson, revised" });
    const superseded = await post(`/learning/lessons/${lesson.id}/supersede`, {
      supersededById: replacement.id,
    });
    expect(superseded.statusCode).toBe(200);
    expect((superseded.json() as Json).status).toBe("superseded");
    expect((superseded.json() as Json).supersededById).toBe(replacement.id);
  });
});

/* ================================================================== */
/* Mandatory capture                                                   */
/* ================================================================== */

describe("mandatory-capture triggers", () => {
  let firstSweep: Json;

  it("materializes a trigger and an obligation from records other modules already wrote", async () => {
    const res = await post(`/projects/${projectId}/learning/triggers/sweep`);
    expect(res.statusCode).toBe(200);
    firstSweep = res.json() as Json;
    // dispute closed, claim settled, delay event closed, variation over
    // threshold, confirmed signal, gate review — but NOT the proposed
    // variation, the undispositioned signal, or closeout (still in construction)
    expect(firstSweep.created).toBe(6);
    expect(firstSweep.threshold).toEqual({ value: 50_000, source: "default" });

    const rows = await app.db
      .select()
      .from(lessonTriggers)
      .where(eq(lessonTriggers.projectId, projectId));
    expect(rows.map((r) => r.kind).sort()).toEqual([
      "claim_settled",
      "delay_event_closed",
      "dispute_closed",
      "gate_review",
      "signal_confirmed",
      "variation_threshold",
    ]);
    for (const row of rows) {
      expect(row.status).toBe("open");
      expect(row.rationale.length).toBeGreaterThan(40);
      expect(row.obligationId).toBeTruthy();
      expect(row.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const [obligation] = await app.db
        .select()
        .from(obligations)
        .where(eq(obligations.id, row.obligationId!));
      expect(obligation!.status).toBe("open");
      expect(obligation!.evidenceRequirement).toContain("lesson");
    }
  });

  it("is idempotent across repeated calls — a second sweep creates nothing", async () => {
    const before = await app.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.objectType, "lesson_trigger"));
    const second = await post(`/projects/${projectId}/learning/triggers/sweep`);
    const third = await post(`/projects/${projectId}/learning/triggers/sweep`);
    expect((second.json() as Json).created).toBe(0);
    expect((third.json() as Json).created).toBe(0);
    expect((second.json() as Json).scanned).toBe(firstSweep.scanned);
    const after = await app.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.objectType, "lesson_trigger"));
    expect(after.length).toBe(before.length); // a no-op sweep does not touch the chain
  });

  it("still picks up genuinely new events — idempotent is not frozen", async () => {
    await app.db.update(projects).set({ stage: "closed" }).where(eq(projects.id, projectId));
    const res = await post(`/projects/${projectId}/learning/triggers/sweep`);
    expect((res.json() as Json).created).toBe(1);
    const rows = await app.db
      .select()
      .from(lessonTriggers)
      .where(
        and(eq(lessonTriggers.projectId, projectId), eq(lessonTriggers.kind, "project_closeout")),
      );
    expect(rows).toHaveLength(1);
    // and it does not fire a second time
    expect(((await post(`/projects/${projectId}/learning/triggers/sweep`)).json() as Json).created).toBe(0);
  });

  it("reads the backlog purely — the sweep is a scheduled job, not a side effect", async () => {
    const res = await get(`/projects/${bareProjectId}/learning/triggers`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as Json).total).toBe(0); // nothing has happened here

    const listed = await get(`/projects/${projectId}/learning/triggers?status=open`);
    const body = listed.json() as {
      items: Json[];
      total: number;
      sweptBy: string;
    };
    expect(body.total).toBeGreaterThanOrEqual(6);
    /*
     * The read used to run the sweep, so a read-only member — or an assurance
     * grantee with no write permission at all — created obligations, lesson
     * triggers and hash-chained ledger entries simply by opening the tab, all
     * attributed to them. The response now names the job that does it instead.
     */
    expect(body.sweptBy).toMatch(/learning\.capture-triggers/);
    expect(body.sweptBy).toMatch(/performs no writes/);
    for (const item of body.items) {
      expect(typeof item.ageDays).toBe("number");
      expect(typeof item.overdue).toBe("boolean");
    }
  });

  it("honours a per-project variation threshold from project settings", async () => {
    const res = await post(`/projects/${thresholdProjectId}/learning/triggers/sweep`);
    const body = res.json() as Json;
    expect(body.threshold).toEqual({ value: 5_000, source: "project" });
    // a GBP 10,000 variation is under the platform default but over this project's
    expect(body.created).toBe(1);
    const rows = await app.db
      .select()
      .from(lessonTriggers)
      .where(eq(lessonTriggers.projectId, thresholdProjectId));
    expect(rows[0]!.kind).toBe("variation_threshold");
    expect(rows[0]!.rationale).toContain("10,000");
  });

  it("discharges the trigger's obligation when a lesson is captured against it", async () => {
    const [trigger] = await app.db
      .select()
      .from(lessonTriggers)
      .where(
        and(eq(lessonTriggers.projectId, projectId), eq(lessonTriggers.kind, "dispute_closed")),
      );
    const res = await post(
      `/projects/${projectId}/learning/triggers/${trigger!.id}/capture`,
      lessonBody({ title: "Dispute lesson captured from its trigger" }),
    );
    expect(res.statusCode).toBe(201);
    const body = res.json() as { lesson: Json; trigger: Json };
    expect(body.trigger.status).toBe("captured");
    expect(body.trigger.lessonId).toBe(body.lesson.id);
    expect(body.trigger.closedAt).toBeTruthy();
    // the triggering record travels onto the lesson as evidence, unprompted
    expect((body.lesson.evidenceRefs as Json[])[0]!.recordId).toBe(
      (trigger!.sourceRef as Json).recordId,
    );

    const [obligation] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, trigger!.obligationId!));
    expect(obligation!.status).toBe("satisfied");

    const again = await post(
      `/projects/${projectId}/learning/triggers/${trigger!.id}/capture`,
      lessonBody(),
    );
    expect(again.statusCode).toBe(409);
  });

  it("refuses a dismissal without a reason and records who dismissed it", async () => {
    const [trigger] = await app.db
      .select()
      .from(lessonTriggers)
      .where(and(eq(lessonTriggers.projectId, projectId), eq(lessonTriggers.kind, "gate_review")));

    expect((await post(`/projects/${projectId}/learning/triggers/${trigger!.id}/dismiss`)).statusCode).toBe(400);
    expect(
      (
        await post(`/projects/${projectId}/learning/triggers/${trigger!.id}/dismiss`, {
          reason: "n/a",
        })
      ).statusCode,
    ).toBe(400);

    const res = await post(
      `/projects/${projectId}/learning/triggers/${trigger!.id}/dismiss`,
      { reason: "Superseded by the programme-wide gate review lesson LL-0002." },
      validatorHeaders,
    );
    expect(res.statusCode).toBe(200);
    const dismissed = res.json() as Json;
    expect(dismissed.status).toBe("dismissed");
    expect(dismissed.dismissedBy).toBe(validator.userId);
    expect(dismissed.dismissedReason).toContain("Superseded");

    // the obligation is WAIVED, not satisfied — the distinction survives
    const [obligation] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, trigger!.obligationId!));
    expect(obligation!.status).toBe("waived");

    const capture = await post(
      `/projects/${projectId}/learning/triggers/${trigger!.id}/capture`,
      lessonBody(),
    );
    expect(capture.statusCode).toBe(409);
  });

  it("publishes the rule registry so the mandatory-capture claim is auditable", async () => {
    const res = await get("/learning/triggers/rules");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rules: { kind: string; reads: string }[] };
    expect(body.rules).toHaveLength(7);
    expect(body.rules.find((r) => r.kind === "signal_confirmed")!.reads).toContain("signals");
  });
});

/* ================================================================== */
/* Retrieval bound to the moment                                       */
/* ================================================================== */

describe("relevance retrieval", () => {
  beforeAll(async () => {
    await publishLesson({
      title: "Programme float was consumed by the piling subcontractor",
      category: "programme",
      phase: "construction",
      tags: ["piling", "float"],
      impactValue: 1_200_000,
      impactDays: 60,
    });
    await publishLesson({
      title: "Stakeholder consent lapsed before mobilisation",
      category: "stakeholder",
      phase: "pre_construction",
      tags: ["consents"],
      impactValue: 15_000,
    });
  });

  it("returns only published lessons, ranked, with the reason each one surfaced", async () => {
    const res = await get(
      `/projects/${bareProjectId}/learning/relevant?tool=commercial&category=commercial&tags=retention`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: { lesson: Json; score: number; reasons: { code: string; detail: string }[] }[];
      query: Json;
      matched: number;
      ranking: string;
    };
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item.lesson.status).toBe("published");
      expect(item.score).toBeGreaterThan(0);
      expect(item.reasons.length).toBeGreaterThan(0);
      for (const reason of item.reasons) {
        expect(reason.code).toBeTruthy();
        expect(reason.detail.length).toBeGreaterThan(0);
      }
    }
    const top = body.items[0]!;
    expect(top.reasons.map((r) => r.code)).toContain("category_match");
    expect(body.query.toolImpliesCategories).toContain("commercial");
  });

  it("binds retrieval to the moment: a programme query does not return commercial lessons", async () => {
    const res = await get(
      `/projects/${bareProjectId}/learning/relevant?category=programme&tags=piling`,
    );
    const body = res.json() as { items: { lesson: Json }[] };
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(["programme"]).toContain(item.lesson.category);
    }
  });

  it("is deterministic: the same moment returns the same order and the same scores", async () => {
    const url = `/projects/${bareProjectId}/learning/relevant?tool=schedule&limit=10`;
    const a = (await get(url)).json() as { items: { lesson: Json; score: number }[] };
    const b = (await get(url)).json() as { items: { lesson: Json; score: number }[] };
    expect(b.items.map((i) => i.lesson.id)).toEqual(a.items.map((i) => i.lesson.id));
    expect(b.items.map((i) => i.score)).toEqual(a.items.map((i) => i.score));
  });
});

/* ================================================================== */
/* Search — degrades honestly without the AI layer                     */
/* ================================================================== */

describe("natural-language search", () => {
  it("falls back to deterministic keyword search and SAYS SO when AI is unavailable", async () => {
    expect(app.appConfig.ANTHROPIC_API_KEY).toBeUndefined();
    const res = await post("/learning/search", { query: "why did we lose float on piling?" });
    expect(res.statusCode).toBe(200); // never an error: retrieval must not depend on AI
    const body = res.json() as Json;
    expect(body.mode).toBe("deterministic");
    expect(body.aiAvailable).toBe(false);
    expect(body.note).toContain("ANTHROPIC_API_KEY");
    expect(body.answer).toBeNull();
    expect(body.runId).toBeNull();
    expect(body.citations).toEqual([]);
    const results = body.results as { lesson: Json; matchedTerms: string[]; why: string }[];
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.matchedTerms).toContain("piling");
    expect(results[0]!.why).toContain("piling");
  });

  it("returns an empty, explained result set rather than erroring on a no-match query", async () => {
    const res = await post("/learning/search", { query: "zircon telemetry manifold" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    expect(body.results).toEqual([]);
    expect(body.note).toContain("No published lesson matched");
  });
});

/* ================================================================== */
/* The loop nobody closes                                              */
/* ================================================================== */

describe("lesson application and impact", () => {
  let published: Json;

  beforeAll(async () => {
    published = await publishLesson({
      title: "Ground investigation scope must cover every pier location",
      category: "design",
      tags: ["ground", "design"],
      impactValue: 800_000,
    });
  });

  it("records an application against a later record on another project", async () => {
    const res = await post(`/projects/${bareProjectId}/learning/lessons/${published.id}/apply`, {
      appliedTo: { tool: "contracts", recordId: "con_ground_survey", label: "GI scope of works" },
      action: "Added a per-pier borehole requirement to the GI scope before tender.",
      outcomeNote: "Two soft spots found before award; no variation needed.",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { application: Json; crossedProjectBoundary: boolean };
    expect(body.crossedProjectBoundary).toBe(true);
    expect(body.application.projectId).toBe(bareProjectId);
    expect(body.application.appliedBy).toBe(owner.userId);
  });

  it("refuses to apply a lesson that is not published", async () => {
    const draft = await post(`/projects/${projectId}/learning/lessons`, lessonBody());
    const res = await post(
      `/projects/${bareProjectId}/learning/lessons/${(draft.json() as Json).id}/apply`,
      { appliedTo: { tool: "rfis", recordId: "rfi_1" }, action: "n/a" },
    );
    expect(res.statusCode).toBe(409);
    expect((res.json() as Json).message).toContain("published");
  });

  it("reports where a lesson travelled, on which projects, with what outcomes", async () => {
    await post(`/projects/${projectId}/learning/lessons/${published.id}/apply`, {
      appliedTo: { tool: "rfis", recordId: "rfi_home", label: "Same-project reuse" },
      action: "Reused the borehole checklist on the remaining piers.",
    });
    const res = await get(`/learning/lessons/${published.id}/impact`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    expect(body.applicationCount).toBe(2);
    expect(body.crossProjectApplicationCount).toBe(1);
    expect(body.crossedProjectBoundary).toBe(true);
    expect(body.projectsReached).toBe(2);
    expect(body.outcomesRecorded).toBe(1);
    const byProject = body.projects as Json[];
    expect(byProject.find((p) => p.projectId === bareProjectId)!.projectName).toBe(
      "Greenfield Depot",
    );
    expect(byProject.find((p) => p.projectId === projectId)!.isOriginProject).toBe(true);
    expect(body.note).toContain("away from where the lesson was learned");
  });

  it("says plainly when a published lesson has never been applied", async () => {
    const orphan = await publishLesson({ title: "Nobody has ever used this lesson" });
    const res = await get(`/learning/lessons/${orphan.id}/impact`);
    const body = res.json() as Json;
    expect(body.applicationCount).toBe(0);
    expect(body.crossedProjectBoundary).toBe(false);
    expect(body.note).toContain("document, not a change in practice");
  });
});

/* ================================================================== */
/* Post-project reviews — numbers from records, not recall             */
/* ================================================================== */

describe("post-project reviews", () => {
  it("computes metrics from platform records on a populated project", async () => {
    const created = await post(`/projects/${projectId}/learning/reviews`, {
      title: "Riverside Interchange closeout review",
      scheduledFor: "2026-09-01",
      facilitator: "Head of Delivery",
      participants: [{ name: "Project Director", role: "sponsor" }],
    });
    expect(created.statusCode).toBe(201);
    const reviewId = (created.json() as Json).id as string;

    const res = await post(
      `/projects/${projectId}/learning/reviews/${reviewId}/compute-metrics`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { metrics: Json[]; unavailable: string[]; currency: string };
    const value = (key: string) => body.metrics.find((m) => m.key === key)!;

    expect(body.currency).toBe("GBP");
    expect(value("approved_budget").value).toBe(10_250_000); // 10m contract + 250k agreed VOs
    expect(value("outturn_cost").value).toBe(11_000_000); // Σ netCertified
    expect(value("cost_variance_pct").value).toBe(7.32);
    expect(value("finish_variance_days").value).toBe(46); // 30 Jun baseline → 15 Aug actual
    expect(value("variation_count").value).toBe(2);
    expect(value("variation_value_agreed").value).toBe(250_000);
    expect(value("signals_raised").value).toBe(2);
    expect((value("signals_raised").inputs as Json).confirmed).toBe(1);
    expect(value("obligations_missed").value).toBe(1);
    expect(value("rfi_count").value).toBe(2);
    expect((value("rfi_count").inputs as Json).responded).toBe(1);
    expect(value("punch_count").value).toBe(2);
    expect(value("lessons_captured").value).toBeGreaterThan(0);
    expect(value("lesson_capture_rate_pct").value).not.toBeNull();
    for (const metric of body.metrics) {
      if (metric.value != null) expect(metric.reasons).toEqual([]);
    }

    // the stored metrics are what the review will be signed against
    const stored = await get(`/projects/${projectId}/learning/reviews/${reviewId}`);
    expect(((stored.json() as Json).metrics as Json).computedAt).toBeTruthy();
  });

  it("returns null with a reason — never a fabricated number — on a bare project", async () => {
    const created = await post(`/projects/${bareProjectId}/learning/reviews`, {
      title: "Greenfield Depot review",
    });
    const reviewId = (created.json() as Json).id as string;
    const res = await post(
      `/projects/${bareProjectId}/learning/reviews/${reviewId}/compute-metrics`,
    );
    const body = res.json() as { metrics: Json[]; unavailable: string[]; methodology: string };
    const value = (key: string) => body.metrics.find((m) => m.key === key)!;

    for (const key of [
      "approved_budget",
      "outturn_cost",
      "cost_variance_pct",
      "finish_variance_days",
      "lesson_capture_rate_pct",
    ]) {
      expect(value(key).value).toBeNull();
      expect((value(key).reasons as string[]).length).toBeGreaterThan(0);
      expect(body.unavailable).toContain(key);
    }
    expect((value("outturn_cost").reasons as string[])[0]).toContain("not assumed");
    expect((value("finish_variance_days").reasons as string[]).join(" ")).toContain(
      "No active schedule",
    );
    // counts of zero are real numbers, not missing inputs
    expect(value("rfi_count").value).toBe(0);
    expect(value("punch_count").value).toBe(0);
    expect(value("rfi_count").reasons).toEqual([]);
    expect(body.methodology).toContain("never inferred");
  });

  it("enforces the review state machine and records who signed it off", async () => {
    const created = await post(`/projects/${projectId}/learning/reviews`, {
      title: "Sign-off flow",
    });
    const reviewId = (created.json() as Json).id as string;
    const url = `/projects/${projectId}/learning/reviews/${reviewId}`;

    // sign-off before completion is refused
    expect((await post(`${url}/sign-off`)).statusCode).toBe(409);
    // scheduled cannot jump straight to completed
    expect((await post(`${url}/transition`, { to: "completed" })).statusCode).toBe(409);

    expect((await post(`${url}/transition`, { to: "in_progress" })).statusCode).toBe(200);
    // completing without the date it was held is refused
    const noDate = await post(`${url}/transition`, { to: "completed" });
    expect(noDate.statusCode).toBe(400);
    expect((noDate.json() as Json).message).toContain("heldAt");

    const completed = await post(`${url}/transition`, { to: "completed", heldAt: "2026-09-04" });
    expect(completed.statusCode).toBe(200);
    expect((completed.json() as Json).heldAt).toBe("2026-09-04");

    const signed = await post(`${url}/sign-off`, undefined, validatorHeaders);
    expect(signed.statusCode).toBe(200);
    const body = signed.json() as Json;
    expect(body.status).toBe("signed_off");
    expect(body.signedOffBy).toBe(validator.userId);
    expect(body.signedOffAt).toBeTruthy();

    // and a signed-off review is frozen against edits and recomputation
    expect((await patch(url, { whatWentWell: "rewritten" })).statusCode).toBe(409);
    expect((await post(`${url}/compute-metrics`)).statusCode).toBe(409);
  });

  it("stores findings with ids and keeps them on the review", async () => {
    const created = await post(`/projects/${projectId}/learning/reviews`, { title: "Findings" });
    const reviewId = (created.json() as Json).id as string;
    const res = await patch(`/projects/${projectId}/learning/reviews/${reviewId}`, {
      findings: [
        { text: "Ground investigation was scoped to budget, not to risk.", category: "design" },
        { text: "Retention release had no evidence requirement.", category: "commercial" },
      ],
      whatWentWell: "Early warning discipline held throughout.",
    });
    expect(res.statusCode).toBe(200);
    const findings = (res.json() as Json).findings as Json[];
    expect(findings).toHaveLength(2);
    expect(findings[0]!.id).toBeTruthy();
    expect(findings[0]!.category).toBe("design");
  });
});

/* ================================================================== */
/* Company register and learning health                                */
/* ================================================================== */

describe("company register and summary", () => {
  it("filters the register by category, tags, impact range and free text", async () => {
    const byCategory = await get("/learning/lessons?category=programme&status=published");
    const catBody = byCategory.json() as { items: Json[] };
    expect(catBody.items.length).toBeGreaterThan(0);
    for (const l of catBody.items) expect(l.category).toBe("programme");

    const byTag = await get("/learning/lessons?tags=piling");
    expect((byTag.json() as { items: Json[] }).items.length).toBeGreaterThan(0);
    for (const l of (byTag.json() as { items: Json[] }).items) {
      expect(l.tags as string[]).toContain("piling");
    }

    const byImpact = await get("/learning/lessons?impactMin=1000000");
    for (const l of (byImpact.json() as { items: Json[] }).items) {
      expect(l.impactValue as number).toBeGreaterThanOrEqual(1_000_000);
    }

    const byText = await get("/learning/lessons?q=borehole");
    expect((byText.json() as { items: Json[] }).items.length).toBe(0); // not in any narrative
    const byRealText = await get("/learning/lessons?q=retention");
    expect((byRealText.json() as { items: Json[] }).items.length).toBeGreaterThan(0);

    const byOrigin = await get(`/learning/lessons?originProject=${projectId}&pageSize=200`);
    for (const l of (byOrigin.json() as { items: Json[] }).items) {
      expect(l.originProjectId).toBe(projectId);
    }
  });

  it("reports learning health: the backlog that shames, capture rate and dead lessons", async () => {
    const res = await get("/learning/summary");
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;

    const triggers = body.triggers as Json;
    expect(triggers.raised as number).toBeGreaterThanOrEqual(8);
    expect(triggers.captured as number).toBeGreaterThanOrEqual(1);
    expect(triggers.dismissed as number).toBeGreaterThanOrEqual(1);
    expect((triggers.openByAge as Json)["0-7"] as number).toBeGreaterThan(0);
    expect(triggers.oldestOpenDays).not.toBeNull();
    expect((triggers.oldestOpen as Json[]).length).toBeGreaterThan(0);

    const capture = body.captureRate as Json;
    expect(capture.raised).toBe(triggers.raised);
    expect(capture.discharged).toBe(triggers.captured);
    expect(capture.percent as number).toBeGreaterThan(0);
    expect(capture.note as string).toContain("decision not to learn");

    const dead = body.publishedNeverApplied as Json;
    expect(dead.count as number).toBeGreaterThan(0);
    expect((dead.lessons as Json[])[0]!.number).toBeTruthy();

    const mostApplied = body.mostApplied as Json[];
    expect(mostApplied[0]!.applications as number).toBeGreaterThanOrEqual(2);
    expect((body.applications as Json).crossProject as number).toBeGreaterThanOrEqual(1);
  });
});

/* ================================================================== */
/* Tenancy and permissions                                             */
/* ================================================================== */

describe("tenant isolation and permissions", () => {
  it("hides another tenant's lessons, impact and triggers", async () => {
    const lesson = await publishLesson({ title: "Tenant-scoped lesson" });
    expect((await get(`/learning/lessons/${lesson.id}`, outsider.headers)).statusCode).toBe(404);
    expect((await get(`/learning/lessons/${lesson.id}/impact`, outsider.headers)).statusCode).toBe(404);
    // the project itself is invisible to the other tenant
    expect(
      (await get(`/projects/${projectId}/learning/triggers`, outsider.headers)).statusCode,
    ).toBe(403);
    expect(
      (await post(`/projects/${projectId}/learning/triggers/sweep`, undefined, outsider.headers))
        .statusCode,
    ).toBe(403);
    // and their own register does not contain it
    const register = await get("/learning/lessons", outsider.headers);
    expect((register.json() as { total: number }).total).toBe(0);
  });

  it("enforces tool permission levels: read may look, not write", async () => {
    const read = await get(`/projects/${projectId}/learning/lessons`, readerHeaders);
    expect(read.statusCode).toBe(200);
    const relevant = await get(`/projects/${projectId}/learning/relevant`, readerHeaders);
    expect(relevant.statusCode).toBe(200);

    const create = await post(
      `/projects/${projectId}/learning/lessons`,
      lessonBody(),
      readerHeaders,
    );
    expect(create.statusCode).toBe(403);
    const sweep = await post(
      `/projects/${projectId}/learning/triggers/sweep`,
      undefined,
      readerHeaders,
    );
    expect(sweep.statusCode).toBe(403);
  });

  it("restricts publication and sign-off to admin level on the learning tool", async () => {
    // reader holds `read` on learning; publish requires `admin`
    const created = await post(`/projects/${projectId}/learning/lessons`, lessonBody());
    const id = (created.json() as Json).id as string;
    await post(`/projects/${projectId}/learning/lessons/${id}/submit`);
    await post(`/projects/${projectId}/learning/lessons/${id}/validate`, undefined, validatorHeaders);
    const denied = await post(
      `/projects/${projectId}/learning/lessons/${id}/publish`,
      undefined,
      readerHeaders,
    );
    expect(denied.statusCode).toBe(403);
    expect((await post(`/projects/${projectId}/learning/lessons/${id}/publish`)).statusCode).toBe(200);
  });

  it("refuses company-level supersession to non-admin members", async () => {
    const a = await publishLesson({ title: "Supersession target" });
    const b = await publishLesson({ title: "Supersession replacement" });
    const res = await post(
      `/learning/lessons/${a.id}/supersede`,
      { supersededById: b.id },
      readerHeaders,
    );
    expect(res.statusCode).toBe(403);
  });
});

/* ================================================================== */
/* Health inputs for the intelligence layer                            */
/* ================================================================== */

describe("learning health-inputs", () => {
  it("refuses a capture rate on a project nothing has ever obliged", async () => {
    const res = await get(`/projects/${bareProjectId}/learning/health-inputs`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    const metrics = body.metrics as Json;
    expect(metrics.triggersRaised).toBe(0);
    expect(metrics.captureRate).toBeNull();
    expect((body.reasons as string[]).join(" ")).toMatch(/never been asked to learn/i);
  });

  it("reports the trigger backlog and the measured-outcome count on a live project", async () => {
    await post(`/projects/${projectId}/learning/triggers/sweep`);
    const res = await get(`/projects/${projectId}/learning/health-inputs`);
    expect(res.statusCode).toBe(200);
    const metrics = (res.json() as Json).metrics as Json;
    expect(metrics.triggersRaised as number).toBeGreaterThan(0);
    expect(typeof metrics.triggersOpen).toBe("number");
    expect(typeof metrics.lessonsAuthored).toBe("number");
    expect(typeof metrics.appliedLessonsMeasured).toBe("number");
    expect(metrics.appliedLessonsMeasured as number).toBeLessThanOrEqual(
      metrics.lessonsApplied as number,
    );
  });

  it("is read-gated and tenant-scoped", async () => {
    const reader = await get(`/projects/${projectId}/learning/health-inputs`, readerHeaders);
    expect(reader.statusCode).toBe(200);
    const foreign = await get(
      `/projects/${projectId}/learning/health-inputs`,
      outsider.headers,
    );
    expect([403, 404]).toContain(foreign.statusCode);
  });
});

/* ================================================================== */
/* AI lesson drafting from the triggering record                       */
/* ================================================================== */

describe("AI lesson draft", () => {
  it("answers 503 AiDisabled with no key, and leaves the capture path untouched", async () => {
    await post(`/projects/${projectId}/learning/triggers/sweep`);
    const triggers = await get(`/projects/${projectId}/learning/triggers?status=open`);
    const open = (triggers.json() as { items: Json[] }).items[0];
    expect(open).toBeDefined();
    const triggerId = open!.id as string;

    const res = await post(
      `/projects/${projectId}/learning/triggers/${triggerId}/draft`,
      {},
    );
    /* buildTestApp runs with no ANTHROPIC_API_KEY: the AI path must degrade,
       never take the non-AI workflow down with it. */
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/Capture the lesson directly/);

    /* And capture still works, on the same trigger, with no AI at all. */
    const captured = await post(
      `/projects/${projectId}/learning/triggers/${triggerId}/capture`,
      lessonBody({ title: "Captured without the AI layer" }),
    );
    expect(captured.statusCode).toBe(201);
  });

  it("refuses a draft for a trigger that is no longer owed", async () => {
    const triggers = await get(`/projects/${projectId}/learning/triggers?status=captured`);
    const done = (triggers.json() as { items: Json[] }).items[0];
    if (!done) return;
    const res = await post(
      `/projects/${projectId}/learning/triggers/${done.id as string}/draft`,
      {},
    );
    expect(res.statusCode).toBe(409);
  });

  it("is refused to a read-only member", async () => {
    const triggers = await get(`/projects/${projectId}/learning/triggers?status=open`);
    const open = (triggers.json() as { items: Json[] }).items[0];
    if (!open) return;
    const res = await post(
      `/projects/${projectId}/learning/triggers/${open.id as string}/draft`,
      {},
      readerHeaders,
    );
    expect(res.statusCode).toBe(403);
  });
});


/* ================================================================== */
/* The scheduled capture sweep                                         */
/*                                                                     */
/* Deliberately LAST in the file: this runs the sweep across the whole  */
/* tenant, and a global sweep run earlier would discharge triggers the  */
/* per-project tests above are asserting on.                            */
/* ================================================================== */

describe("scheduled capture sweep", () => {
  it("raises triggers under the system actor, with no reader involved", async () => {
    const fresh = newId("prj");
    await app.db.insert(projects).values({
      id: fresh,
      companyId: owner.companyId,
      name: "Scheduled sweep project",
      stage: "closed",
    });

    /* A read raises nothing: the sweep is not a side effect of looking. */
    const beforeRead = await get(`/projects/${fresh}/learning/triggers`);
    expect(beforeRead.statusCode).toBe(200);
    expect((beforeRead.json() as Json).total).toBe(0);

    await app.scheduler.runNow("learning.capture-triggers");

    const afterJob = await get(`/projects/${fresh}/learning/triggers`);
    const body = afterJob.json() as { total: number; items: Json[] };
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.some((t) => t.kind === "project_closeout")).toBe(true);

    /* And the obligation it raised is attributed to the system, not to a user
       who merely opened a page. */
    const obligationRows = await app.db
      .select()
      .from(obligations)
      .where(
        and(eq(obligations.companyId, owner.companyId), eq(obligations.projectId, fresh)),
      );
    expect(obligationRows.length).toBeGreaterThan(0);
  });

  it("is idempotent — a second run raises nothing twice", async () => {
    const before = await app.db
      .select()
      .from(lessonTriggers)
      .where(eq(lessonTriggers.companyId, owner.companyId));
    await app.scheduler.runNow("learning.capture-triggers");
    const after = await app.db
      .select()
      .from(lessonTriggers)
      .where(eq(lessonTriggers.companyId, owner.companyId));
    expect(after.length).toBe(before.length);
  });
});

/* ================================================================== */
/* Cross-project supplier performance (#987-989)                       */
/* ================================================================== */

describe("supplier performance scorecard", () => {
  let goodVendor: string;
  let badVendor: string;
  let silentVendor: string;

  beforeAll(async () => {
    goodVendor = newId("ven");
    badVendor = newId("ven");
    silentVendor = newId("ven");
    await app.db.insert(vendors).values([
      { id: goodVendor, companyId: owner.companyId, name: "Aaa Reliable Ltd" },
      { id: badVendor, companyId: owner.companyId, name: "Bbb Chaotic Ltd" },
      { id: silentVendor, companyId: owner.companyId, name: "Ccc Unknown Ltd" },
    ]);
    const iso = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    await app.db.insert(insuranceCertificates).values([
      {
        id: newId("cert"),
        companyId: owner.companyId,
        projectId,
        vendorId: goodVendor,
        subjectName: "Aaa Reliable Ltd",
        policyType: "public_liability",
        validFrom: iso(-100),
        validTo: iso(200),
        verifiedAt: new Date().toISOString(),
        verificationMethod: "insurer_confirmation",
        createdBy: owner.userId,
      },
      {
        id: newId("cert"),
        companyId: owner.companyId,
        projectId,
        vendorId: goodVendor,
        subjectName: "Aaa Reliable Ltd",
        policyType: "employers_liability",
        validFrom: iso(-100),
        validTo: iso(200),
        verifiedAt: new Date().toISOString(),
        verificationMethod: "insurer_confirmation",
        createdBy: owner.userId,
      },
      {
        id: newId("cert"),
        companyId: owner.companyId,
        projectId,
        vendorId: goodVendor,
        subjectName: "Aaa Reliable Ltd",
        policyType: "professional_indemnity",
        validFrom: iso(-100),
        validTo: iso(200),
        verifiedAt: new Date().toISOString(),
        verificationMethod: "insurer_confirmation",
        createdBy: owner.userId,
      },
      {
        id: newId("cert"),
        companyId: owner.companyId,
        projectId,
        vendorId: badVendor,
        subjectName: "Bbb Chaotic Ltd",
        policyType: "public_liability",
        validFrom: iso(-400),
        validTo: iso(-30),
        verifiedAt: null,
        createdBy: owner.userId,
      },
      {
        id: newId("cert"),
        companyId: owner.companyId,
        projectId,
        vendorId: badVendor,
        subjectName: "Bbb Chaotic Ltd",
        policyType: "employers_liability",
        validFrom: iso(-400),
        validTo: iso(-10),
        verifiedAt: null,
        createdBy: owner.userId,
      },
      {
        id: newId("cert"),
        companyId: owner.companyId,
        projectId,
        vendorId: badVendor,
        subjectName: "Bbb Chaotic Ltd",
        policyType: "professional_indemnity",
        validFrom: iso(-400),
        validTo: iso(-5),
        verifiedAt: null,
        createdBy: owner.userId,
      },
    ]);
  }, 120_000);

  it("ranks the worst supplier first and refuses to rate one with no records", async () => {
    const res = await get("/learning/supplier-performance");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ vendorId: string; composite: number | null; reasons: string[] }>;
      sources: string[];
    };
    const ids = body.items.map((i) => i.vendorId);
    expect(ids.indexOf(badVendor)).toBeLessThan(ids.indexOf(goodVendor));
    const silent = body.items.find((i) => i.vendorId === silentVendor)!;
    expect(silent.composite).toBeNull();
    expect(silent.reasons.join(" ")).toMatch(/coincidence wearing a number/);
    expect(body.sources.length).toBeGreaterThan(0);
  });

  it("shows the basis and counts behind every dimension", async () => {
    const res = await get(`/learning/supplier-performance?vendorId=${badVendor}`);
    expect(res.statusCode).toBe(200);
    const [row] = res.json().items as Array<{
      certificateDiscipline: { score: number; counts: Record<string, number>; basis: string };
      quality: { score: number | null; basis: string };
      reasons: string[];
    }>;
    expect(row!.certificateDiscipline.counts["expired"]).toBe(3);
    expect(row!.certificateDiscipline.basis).toMatch(/in date/);
    // no NCR exists against this vendor: null, not zero
    expect(row!.quality.score).toBeNull();
    expect(row!.reasons.join(" ")).toMatch(/not a recommendation/);
  });

  it("says so, rather than reporting zero, when the caller holds learning nowhere", async () => {
    const nobody = await registerActor(app);
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: nobody.userId,
      role: "guest",
    });
    const res = await get("/learning/supplier-performance", {
      authorization: nobody.headers["authorization"]!,
      "x-company-id": owner.companyId,
    });
    // A guest with no project membership holds the tool nowhere: refused
    // outright rather than handed an empty list that reads as "nothing to report".
    expect(res.statusCode).toBe(403);
  });

  it("keeps another tenant out", async () => {
    const res = await get("/learning/supplier-performance", outsider.headers);
    const body = res.statusCode === 200 ? (res.json().items as unknown[]) : [];
    expect(body).toHaveLength(0);
  });
});

/* ================================================================== */
/* Contract clause & procurement route analytics (#987-988)            */
/* ================================================================== */

describe("clause and procurement route performance", () => {
  let routeProjectA: string;
  let routeProjectB: string;

  beforeAll(async () => {
    routeProjectA = newId("prj");
    routeProjectB = newId("prj");
    await app.db.insert(projects).values([
      {
        id: routeProjectA,
        companyId: owner.companyId,
        name: "Clause analytics A",
        currency: "GBP",
      },
      {
        id: routeProjectB,
        companyId: owner.companyId,
        name: "Clause analytics B",
        currency: "GBP",
      },
    ]);
    await app.db.insert(contracts).values([
      {
        id: newId("con"),
        companyId: owner.companyId,
        projectId: routeProjectA,
        name: "A main works",
        form: "fidic_red_2017",
        status: "executed",
        currency: "GBP",
        contractSum: 1_000_000,
        createdBy: owner.userId,
      },
      {
        id: newId("con"),
        companyId: owner.companyId,
        projectId: routeProjectB,
        name: "B main works",
        form: "fidic_red_2017",
        status: "executed",
        currency: "GBP",
        contractSum: 2_000_000,
        createdBy: owner.userId,
      },
    ]);
    await app.db.insert(bidOpportunities).values([
      {
        id: newId("opp"),
        companyId: owner.companyId,
        projectId: routeProjectA,
        number: 8001,
        reference: "OPP-8001",
        title: "Clause analytics A pursuit",
        procurementRoute: "design_and_build",
        currency: "GBP",
        createdBy: owner.userId,
      },
      {
        id: newId("opp"),
        companyId: owner.companyId,
        projectId: routeProjectB,
        number: 8002,
        reference: "OPP-8002",
        title: "Clause analytics B pursuit",
        procurementRoute: "design_and_build",
        currency: "GBP",
        createdBy: owner.userId,
      },
    ]);
    await app.db.insert(disputes).values([
      {
        id: newId("dsp"),
        companyId: owner.companyId,
        projectId: routeProjectA,
        number: 8001,
        title: "Clause 20.1 time bar",
        kind: "adjudication",
        status: "decided",
        governingClause: "Sub-Clause 20.1",
        contractFamily: "FIDIC",
        outcome: "partly_successful",
        rootCause: "late_notice",
        amountClaimed: 100_000,
        amountAwarded: 40_000,
        currency: "GBP",
        resolvedAt: "2026-04-01",
        createdBy: owner.userId,
      },
      {
        id: newId("dsp"),
        companyId: owner.companyId,
        projectId: routeProjectB,
        number: 8002,
        title: "Clause 20.1 again",
        kind: "adjudication",
        status: "decided",
        governingClause: "clause 20.1",
        contractFamily: "FIDIC",
        outcome: "partly_successful",
        rootCause: "late_notice",
        amountClaimed: 100_000,
        amountAwarded: 60_000,
        currency: "GBP",
        resolvedAt: "2026-05-01",
        createdBy: owner.userId,
      },
    ]);
    await app.db.insert(variations).values([
      {
        id: newId("var"),
        companyId: owner.companyId,
        projectId: routeProjectA,
        number: 8001,
        title: "Instructed change under 13.3",
        status: "agreed",
        clauseRef: "13.3",
        currency: "GBP",
        agreedValue: 100_000,
        timeImpactDays: 10,
        createdBy: owner.userId,
      },
      {
        id: newId("var"),
        companyId: owner.companyId,
        projectId: routeProjectB,
        number: 8002,
        title: "Instructed change under 13.3",
        status: "agreed",
        clauseRef: "Clause 13.3",
        currency: "GBP",
        agreedValue: 400_000,
        timeImpactDays: 20,
        createdBy: owner.userId,
      },
    ]);
    await app.db.insert(obligations).values([
      {
        id: newId("obl"),
        companyId: owner.companyId,
        projectId: routeProjectA,
        sourceClause: "20.1",
        trigger: "Notice of claim within 28 days",
        status: "breached",
        createdBy: owner.userId,
      },
      {
        id: newId("obl"),
        companyId: owner.companyId,
        projectId: routeProjectB,
        sourceClause: "Sub-Clause 20.1",
        trigger: "Notice of claim within 28 days",
        status: "discharged",
        createdBy: owner.userId,
      },
    ]);
  }, 120_000);

  it("collapses the ways a clause is written and measures recovery across projects", async () => {
    const res = await get("/learning/clause-performance?contractFamily=FIDIC&clause=Clause%2020.1");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{
        clause: string;
        contractFamily: string;
        disputes: number;
        projects: number;
        amountClaimed: Record<string, number>;
        amountAwarded: Record<string, number>;
        recoveryRatio: number | null;
        obligations: number;
        obligationsBreached: number;
        breachRate: number | null;
      }>;
      sources: string[];
    };
    expect(body.items).toHaveLength(1);
    const row = body.items[0]!;
    expect(row.clause).toBe("20.1");
    expect(row.contractFamily).toBe("fidic");
    expect(row.disputes).toBe(2);
    expect(row.projects).toBe(2);
    expect(row.amountClaimed["GBP"]).toBe(200_000);
    expect(row.amountAwarded["GBP"]).toBe(100_000);
    expect(row.recoveryRatio).toBe(0.5);
    // the obligations materialised from the same clause, both spellings
    expect(row.obligations).toBe(2);
    expect(row.obligationsBreached).toBe(1);
    expect(row.breachRate).toBe(0.5);
    expect(body.sources.length).toBeGreaterThan(0);
  });

  it("reports records that carry no clause reference rather than silently dropping them", async () => {
    const res = await get("/learning/clause-performance");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      unattributed: { disputes: number; variations: number; obligations: number };
      reasons: string[];
    };
    // the fixtures at the top of this file carry no clause at all
    expect(body.unattributed.disputes).toBeGreaterThan(0);
    expect(body.reasons.join(" ")).toMatch(/carry no clause reference|Frequency is not fault/);
  });

  it("filters by minimum dispute count", async () => {
    const res = await get("/learning/clause-performance?minDisputes=2");
    const items = (res.json() as { items: Array<{ clause: string; disputes: number }> }).items;
    expect(items.every((i) => i.disputes >= 2)).toBe(true);
    expect(items.some((i) => i.clause === "20.1")).toBe(true);
  });

  it("computes the outturn variance per project and never sums across currencies", async () => {
    const res = await get("/learning/procurement-routes");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{
        route: string;
        projects: number;
        contractSum: Record<string, number>;
        outturnVariancePercent: number | null;
        outturnObservations: number;
        disputeRate: number | null;
        reliable: boolean;
        reasons: string[];
      }>;
    };
    const dnb = body.items.find((r) => r.route === "design_and_build")!;
    expect(dnb).toBeDefined();
    expect(dnb.projects).toBe(2);
    expect(dnb.contractSum["GBP"]).toBe(3_000_000);
    // A: 100k/1m = 10%, B: 400k/2m = 20% → mean 15%
    expect(dnb.outturnVariancePercent).toBe(15);
    expect(dnb.outturnObservations).toBe(2);
    expect(dnb.disputeRate).toBe(1);
    expect(dnb.reliable).toBe(false);
    expect(dnb.reasons.join(" ")).toMatch(/below the/);
  });

  it("keeps projects with no recorded route visible instead of inventing one", async () => {
    const res = await get("/learning/procurement-routes");
    const body = res.json() as { items: Array<{ route: string; reasons: string[] }> };
    const unrecorded = body.items.find((r) => r.route === "unrecorded");
    expect(unrecorded).toBeDefined();
    expect(unrecorded!.reasons.join(" ")).toMatch(/No procurement route is recorded/);
  });

  it("refuses both reports to a guest who holds learning nowhere", async () => {
    const nobody = await registerActor(app);
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: nobody.userId,
      role: "guest",
    });
    const headers = {
      authorization: nobody.headers["authorization"]!,
      "x-company-id": owner.companyId,
    };
    expect((await get("/learning/clause-performance", headers)).statusCode).toBe(403);
    expect((await get("/learning/procurement-routes", headers)).statusCode).toBe(403);
  });

  it("shows another tenant nothing of this company's clause history", async () => {
    const clause = await get("/learning/clause-performance", outsider.headers);
    const routes = await get("/learning/procurement-routes", outsider.headers);
    const clauseItems =
      clause.statusCode === 200 ? (clause.json().items as unknown[]) : [];
    const routeItems = routes.statusCode === 200 ? (routes.json().items as unknown[]) : [];
    expect(clauseItems).toHaveLength(0);
    expect(routeItems).toHaveLength(0);
  });
});


/* ================================================================== */
/* Audit bug regressions                                               */
/* ================================================================== */

describe("audit bug regressions", () => {
  it("[#21] numbers lessons on a COMPANY counter, so two projects cannot both hold LL-0001", async () => {
    const a = await post(`/projects/${projectId}/learning/lessons`, lessonBody({ title: "A" }));
    const b = await post(
      `/projects/${bareProjectId}/learning/lessons`,
      lessonBody({ title: "B" }),
    );
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    const na = (a.json() as Json).number as string;
    const nb = (b.json() as Json).number as string;
    expect(na).toMatch(/^LL-\d{4}$/);
    expect(nb).toMatch(/^LL-\d{4}$/);
    // Published lessons are a company-wide register and their number is cited
    // as the reference. Two lessons sharing LL-0001 makes every citation
    // ambiguous, which is precisely what a per-project counter produced.
    expect(na).not.toBe(nb);
  });

  it("[#9] leaves the trigger list a pure read — no obligation, trigger or ledger entry", async () => {
    const before = await app.db
      .select()
      .from(lessonTriggers)
      .where(eq(lessonTriggers.projectId, projectId));
    const oblBefore = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.projectId, projectId));
    const res = await get(`/projects/${projectId}/learning/triggers`, readerHeaders);
    expect(res.statusCode).toBe(200);
    expect((res.json() as Json).sweptBy).toMatch(/performs no writes/);
    const after = await app.db
      .select()
      .from(lessonTriggers)
      .where(eq(lessonTriggers.projectId, projectId));
    const oblAfter = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.projectId, projectId));
    expect(after.length).toBe(before.length);
    expect(oblAfter.length).toBe(oblBefore.length);
  });
});

/* ================================================================== */
/* KNOWLEDGE GRAPH, ONBOARDING PACKS AND THE LIBRARIES (#981-984, #992-994) */
/* ================================================================== */

describe("knowledge graph, onboarding packs and the feedback libraries", () => {
  let graphDisputeId: string;
  let libProjectA: string;
  let libProjectB: string;
  let realisedRiskId: string;

  beforeAll(async () => {
    graphDisputeId = newId("dsp");
    await app.db.insert(disputes).values({
      id: graphDisputeId,
      companyId: owner.companyId,
      projectId,
      number: 90,
      title: "Ground conditions adjudication at pier 7",
      kind: "adjudication",
      status: "decided",
      currency: "GBP",
      createdBy: owner.userId,
    });

    /* Two projects with certified valuations for the SAME element, so a rate
       has a sample of two across a project boundary — the only shape the
       engine will call sufficient. */
    libProjectA = newId("prj");
    libProjectB = newId("prj");
    await app.db.insert(projects).values([
      {
        id: libProjectA,
        companyId: owner.companyId,
        name: "Library Source A",
        type: "highways",
        currency: "GBP",
        value: 4_000_000,
        stage: "course_of_construction",
      },
      {
        id: libProjectB,
        companyId: owner.companyId,
        name: "Library Source B",
        type: "highways",
        currency: "GBP",
        value: 5_000_000,
        stage: "course_of_construction",
      },
    ]);

    for (const [i, p] of [libProjectA, libProjectB].entries()) {
      const boqId = newId("boq");
      await app.db.insert(boqs).values({
        id: boqId,
        companyId: owner.companyId,
        projectId: p,
        name: `Works BQ ${i}`,
        currency: "GBP",
        status: "agreed",
        createdBy: owner.userId,
      });
      const itemId = newId("bqi");
      await app.db.insert(boqItems).values({
        id: itemId,
        boqId,
        parentId: null,
        path: itemId,
        level: "item",
        code: "E10",
        description: "Excavation in made ground",
        unit: "m3",
        quantity: 100,
        rate: 100,
        amount: 10_000,
        itemType: "measured",
      });
      /* A draft valuation must never reach the library: only what was
         certified is outturn. */
      const draftId = newId("val");
      const certifiedId = newId("val");
      await app.db.insert(valuations).values([
        {
          id: draftId,
          companyId: owner.companyId,
          projectId: p,
          boqId,
          number: 1,
          valuationDate: "2026-01-31",
          status: "draft",
          currency: "GBP",
          createdBy: owner.userId,
        },
        {
          id: certifiedId,
          companyId: owner.companyId,
          projectId: p,
          boqId,
          number: 2,
          valuationDate: "2026-02-28",
          status: "certified",
          currency: "GBP",
          createdBy: owner.userId,
        },
      ]);
      await app.db.insert(valuationLines).values([
        {
          id: newId("vln"),
          valuationId: draftId,
          boqItemId: itemId,
          qtyToDate: 50,
          amountToDate: 50_000, // a wild rate that must not reach the library
          previousAmount: 0,
          thisPeriod: 50_000,
        },
        {
          id: newId("vln"),
          valuationId: certifiedId,
          boqItemId: itemId,
          qtyToDate: 100,
          /* A: 120/m3, B: 140/m3 → median 130 against a priced 100 */
          amountToDate: i === 0 ? 12_000 : 14_000,
          previousAmount: 0,
          thisPeriod: i === 0 ? 12_000 : 14_000,
        },
      ]);

      const schedId = newId("sch");
      await app.db.insert(schedules).values({
        id: schedId,
        companyId: owner.companyId,
        projectId: p,
        name: `Programme ${i}`,
        projectStart: "2025-01-01",
        isActive: 1,
        createdBy: owner.userId,
      });
      await app.db.insert(scheduleTasks).values([
        {
          id: newId("tsk"),
          scheduleId: schedId,
          projectId: p,
          name: "Piling to pier 3",
          wbsCode: "A100",
          durationDays: 10,
          /* A took 12 days, B took 16 → median 14 against a planned 10 */
          actualStart: "2026-01-05",
          actualFinish: i === 0 ? "2026-01-16" : "2026-01-20",
        },
        {
          id: newId("tsk"),
          scheduleId: schedId,
          projectId: p,
          name: "Sectional completion",
          wbsCode: "M900",
          taskType: "milestone",
          durationDays: 0,
          actualStart: "2026-02-01",
          actualFinish: "2026-02-01",
        },
        {
          id: newId("tsk"),
          scheduleId: schedId,
          projectId: p,
          name: "Still running",
          wbsCode: "A200",
          durationDays: 20,
          actualStart: "2026-03-01",
          actualFinish: null,
        },
      ]);
    }

    realisedRiskId = newId("rsk");
    await app.db.insert(risks).values({
      id: realisedRiskId,
      companyId: owner.companyId,
      projectId,
      number: 77,
      title: "Made ground deeper than the SI suggested",
      category: "technical",
      status: "realised",
      probabilityScore: 2,
      impactScore: 4,
      occurrenceProbability: 0.15,
      costImpact: { kind: "triangular", min: 50_000, mode: 200_000, max: 500_000 },
      createdBy: owner.userId,
    });
  }, 120_000);

  /* ---------------- knowledge graph ---------------- */

  it("verifies every evidence reference against the record it names when a lesson is published", async () => {
    const lesson = await publishLesson({
      title: "Probe made ground before mobilising a piling rig",
      whatHappened:
        "The piling rig sank in made ground that had never been probed, and the adjudication " +
        "that followed turned on whether the SI was adequate.",
      recommendation: "Probe made ground on the piling platform before mobilising.",
      tags: ["ground", "piling"],
      evidenceRefs: [
        { tool: "disputes", recordId: graphDisputeId, label: "D-090" },
        { tool: "disputes", recordId: "dsp_does_not_exist", label: "phantom" },
      ],
    });
    expect((lesson.graph as Json).inserted).toBeGreaterThan(0);
    const unverified = (lesson.graph as Json).unverified as Array<Json>;
    expect(unverified).toHaveLength(1);
    expect(unverified[0]!.targetId).toBe("dsp_does_not_exist");
    expect(String(unverified[0]!.reason)).toContain("No record with that id");

    const res = await get(`/learning/lessons/${lesson.id as string}/graph`);
    expect(res.statusCode).toBe(200);
    const graph = res.json() as Json;
    const counts = graph.counts as Json;
    expect(counts.record).toBe(2);
    expect(counts.unverified).toBe(1);
    expect(counts.tag).toBe(2);
    // author and validator are different people and both are on the graph
    expect(counts.person).toBe(2);
    expect(String(graph.reason)).toContain("unverified");

    // the verified edge is mirrored into record_links, so the DISPUTE can
    // answer "what did we learn from this?" without knowing about lessons
    const links = await app.db
      .select()
      .from(recordLinks)
      .where(and(eq(recordLinks.fromId, lesson.id as string), eq(recordLinks.toId, graphDisputeId)));
    expect(links).toHaveLength(1);
    expect(links[0]!.toType).toBe("dispute");
  });

  it("answers the reverse question from the record's side", async () => {
    const res = await get(
      `/projects/${projectId}/learning/for-record?type=disputes&id=${graphDisputeId}`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect((body.record as Json).resolvable).toBe(true);
    const items = body.items as Array<Json>;
    expect(items.every((i) => i.lesson !== null)).toBe(true);
  });

  it("says plainly when no lesson cites a record", async () => {
    const res = await get(`/projects/${projectId}/learning/for-record?type=disputes&id=nope`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    expect(body.total).toBe(0);
    expect(String(body.reason)).toContain("fact about the register");
  });

  it("is idempotent: rebuilding writes nothing the second time", async () => {
    const lesson = await publishLesson({
      title: "Idempotence check",
      evidenceRefs: [{ tool: "disputes", recordId: graphDisputeId }],
    });
    const first = await post(`/learning/lessons/${lesson.id as string}/graph/rebuild`);
    expect(first.statusCode).toBe(200);
    expect((first.json() as Json).inserted).toBe(0);
    expect((first.json() as Json).deleted).toBe(0);
    const second = await post(`/learning/lessons/${lesson.id as string}/graph/rebuild`);
    expect((second.json() as Json).inserted).toBe(0);
    expect((second.json() as Json).deleted).toBe(0);
    expect((second.json() as Json).unchanged).toBeGreaterThan(0);
  });

  it("adds an applied_to edge when the lesson is applied to a later record", async () => {
    const lesson = await publishLesson({ title: "Applied edge check" });
    const applied = await post(
      `/projects/${bareProjectId}/learning/lessons/${lesson.id as string}/apply`,
      {
        appliedTo: { tool: "disputes", recordId: graphDisputeId, label: "D-090" },
        action: "Checked the SI adequacy before mobilising",
      },
    );
    expect(applied.statusCode).toBe(201);
    const res = await get(`/learning/lessons/${lesson.id as string}/graph`);
    const edges = (res.json() as Json).edges as Array<Json>;
    expect(edges.some((e) => e.role === "applied_to" && e.targetId === graphDisputeId)).toBe(true);
    expect(edges.some((e) => e.role === "applier")).toBe(true);
  });

  it("refuses the graph of another tenant's lesson", async () => {
    const lesson = await publishLesson({ title: "Cross tenant graph" });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/learning/lessons/${lesson.id as string}/graph`,
      headers: outsider.headers,
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it("shows a published lesson's provenance to anyone who holds the tool anywhere", async () => {
    /* A published lesson is a tenant asset. Showing the claim while hiding the
       evidence it rests on would make the citation unverifiable. */
    const lesson = await publishLesson({ title: "Published provenance is company-wide" });
    const res = await get(`/learning/lessons/${lesson.id as string}/graph`, readerHeaders);
    expect(res.statusCode).toBe(200);
    expect(((res.json() as Json).counts as Json).total).toBeGreaterThan(0);
  });

  it("refuses a graph rebuild from a plain member — the projection is an admin act", async () => {
    const lesson = await publishLesson({ title: "Rebuild permission" });
    const res = await post(
      `/learning/lessons/${lesson.id as string}/graph/rebuild`,
      undefined,
      readerHeaders,
    );
    expect(res.statusCode).toBe(403);
  });

  /* ---------------- semantic retrieval ---------------- */

  it("surfaces a lesson whose words match the record being created, and states the similarity", async () => {
    await publishLesson({
      title: "Cladding fixings corroded within a year",
      category: "quality",
      whatHappened:
        "Cladding fixings specified in the wrong grade corroded within a year of installation " +
        "in a marine exposure zone.",
      recommendation: "Check the fixing grade against the exposure category before approval.",
      tags: ["cladding", "facade"],
    });
    const res = await get(
      `/projects/${projectId}/learning/relevant?text=${encodeURIComponent(
        "cladding fixings corroding in a marine exposure zone",
      )}`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    expect((body.query as Json).semanticMatches).toBeGreaterThan(0);
    const items = body.items as Array<Json>;
    const hit = items.find((i) => String((i.lesson as Json).title).includes("Cladding fixings"));
    expect(hit).toBeDefined();
    const reasons = hit!.reasons as Array<Json>;
    const semantic = reasons.find((r) => r.code === "semantic_similarity");
    expect(semantic).toBeDefined();
    expect(String(semantic!.detail)).toMatch(/Semantic similarity: 0\.\d\d/);
    expect(hit!.similarity).toBeGreaterThan(0);
  });

  it("adds nothing when the record's words are not in the register's vocabulary", async () => {
    const res = await get(
      `/projects/${projectId}/learning/relevant?text=${encodeURIComponent("quantum chromodynamics")}`,
    );
    const body = res.json() as Json;
    expect((body.query as Json).semanticMatches).toBe(0);
  });

  /* ---------------- onboarding packs ---------------- */

  it("selects an onboarding pack from similar projects with the reasons attached", async () => {
    const res = await get(`/projects/${libProjectA}/learning/onboarding-pack?limit=5`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    expect((body.project as Json).id).toBe(libProjectA);
    const items = body.items as Array<Json>;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect((item.reasons as string[]).length).toBeGreaterThan(0);
    }
    expect(String(body.selection)).toContain("Deterministic");
  });

  it("returns the pack with an honest reason when AI is not configured, never an error", async () => {
    const res = await post(`/projects/${libProjectA}/learning/onboarding-pack`, { limit: 3 });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    expect(body.narrative).toBeNull();
    expect(String(body.narrativeReason)).toContain("AI is not configured");
    expect((body.items as Array<Json>).length).toBeGreaterThan(0);
  });

  it("refuses an onboarding pack for another tenant's project", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${libProjectA}/learning/onboarding-pack`,
      headers: outsider.headers,
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  /* ---------------- rate and duration libraries ---------------- */

  it("builds a rate library from certified valuations only, and measures the estimate against it", async () => {
    const res = await post(`/learning/libraries/rebuild`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    expect((body.rates as Json).proposals).toBeGreaterThan(0);

    const list = await get(`/learning/libraries/rates?code=E10`);
    expect(list.statusCode).toBe(200);
    const items = (list.json() as Json).items as Array<Json>;
    const entry = items.find((i) => i.elementCode === "E10");
    expect(entry).toBeDefined();
    expect(entry!.sampleSize).toBe(2); // the draft valuation was excluded
    expect(entry!.medianRate).toBe(130);
    expect(entry!.estimatedRate).toBe(100);
    expect(entry!.accuracyRatio).toBeCloseTo(0.3, 6);
    expect(entry!.status).toBe("proposed");
    expect((entry!.sourceProjectIds as string[]).sort()).toEqual([libProjectA, libProjectB].sort());
    expect(String(entry!.note)).toContain("optimistic by 30%");
  });

  it("builds a duration library from completed activities only", async () => {
    const list = await get(`/learning/libraries/durations?code=A100`);
    const items = (list.json() as Json).items as Array<Json>;
    const entry = items.find((i) => i.activityCode === "A100");
    expect(entry).toBeDefined();
    expect(entry!.sampleSize).toBe(2);
    expect(entry!.medianDays).toBe(14); // 12 and 16 days, inclusive of both ends
    expect(entry!.plannedDays).toBe(10);
    expect(entry!.accuracyRatio).toBeCloseTo(0.4, 6);
    // the milestone and the unfinished activity are not evidence about duration
    const all = (await get(`/learning/libraries/durations`)).json() as Json;
    const codes = (all.items as Array<Json>).map((i) => i.activityCode);
    expect(codes).not.toContain("M900");
    expect(codes).not.toContain("A200");
  });

  it("accepts a proposal under a named actor and ledgers the decision", async () => {
    const list = await get(`/learning/libraries/rates?code=E10&status=proposed`);
    const entry = ((list.json() as Json).items as Array<Json>)[0]!;
    const res = await post(`/learning/libraries/rates/${entry.id as string}/accept`, {
      note: "Sample reviewed against both jobs.",
    });
    expect(res.statusCode).toBe(200);
    const accepted = res.json() as Json;
    expect(accepted.status).toBe("accepted");
    expect(accepted.acceptedBy).toBe(owner.userId);
    const led = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.objectType, "rate_library_entry"),
          eq(ledgerEntries.objectId, entry.id as string),
          eq(ledgerEntries.action, "state_change"),
        ),
      );
    expect(led.length).toBe(1);
  });

  it("refuses to decide the same entry twice", async () => {
    const list = await get(`/learning/libraries/rates?code=E10&status=accepted`);
    const entry = ((list.json() as Json).items as Array<Json>)[0]!;
    const res = await post(`/learning/libraries/rates/${entry.id as string}/reject`);
    expect(res.statusCode).toBe(409);
  });

  it("leaves an accepted entry alone when the evidence has not moved", async () => {
    const before = await get(`/learning/libraries/rates?code=E10`);
    const countBefore = ((before.json() as Json).items as Array<Json>).length;
    const res = await post(`/learning/libraries/rebuild`);
    expect((res.json() as Json).rates).toMatchObject({ skipped: expect.any(Number) });
    const after = await get(`/learning/libraries/rates?code=E10`);
    expect(((after.json() as Json).items as Array<Json>).length).toBe(countBefore);
  });

  it("refuses a rebuild from a plain member and shows another tenant none of this library", async () => {
    const member = await post(`/learning/libraries/rebuild`, undefined, readerHeaders);
    expect(member.statusCode).toBe(403);
    /*
     * The outsider is the OWNER of their own company, so the route is open to
     * them — and answers about their tenant, which is empty. "You may not ask"
     * and "there is nothing of yours here" are different answers and the
     * second is the correct one; what must never happen is this company's
     * entries appearing in it.
     */
    const other = await app.inject({
      method: "GET",
      url: "/api/v1/learning/libraries/rates?pageSize=100",
      headers: outsider.headers,
    });
    expect(other.statusCode).toBe(200);
    const mine = await get(`/learning/libraries/rates?pageSize=100`);
    const myIds = ((mine.json() as Json).items as Array<Json>).map((i) => i.id);
    expect(myIds.length).toBeGreaterThan(0);
    const theirs = ((other.json() as Json).items as Array<Json>).map((i) => i.id);
    expect(theirs).toEqual([]);
    for (const id of myIds) expect(theirs).not.toContain(id);
  });

  /* ---------------- risk realisation ---------------- */

  it("records a realised risk with the prediction as it stood, and refuses a duplicate", async () => {
    const res = await post(`/projects/${projectId}/learning/risk-realisations`, {
      riskId: realisedRiskId,
      realisedImpact: 400_000,
      realisedCurrency: "GBP",
      sourceType: "variation",
      sourceId: "var_pier7",
      note: "Settled through variation 14.",
    });
    expect(res.statusCode).toBe(201);
    const row = res.json() as Json;
    expect(row.predictedProbability).toBeCloseTo(0.15, 6);
    expect(row.predictedImpact).toBe(200_000); // the triangular mode
    expect(row.realisedImpact).toBe(400_000);

    const dup = await post(`/projects/${projectId}/learning/risk-realisations`, {
      riskId: realisedRiskId,
      sourceType: "variation",
      sourceId: "var_pier7",
    });
    expect(dup.statusCode).toBe(409);
  });

  it("captures realised risks on a schedule and never records the same one twice", async () => {
    await app.scheduler.runNow("learning.libraries");
    const rows = await app.db
      .select()
      .from(riskRealisations)
      .where(eq(riskRealisations.riskId, realisedRiskId));
    // one recorded by hand against the variation, one captured from the register
    expect(rows.length).toBe(2);
    await app.scheduler.runNow("learning.libraries");
    const again = await app.db
      .select()
      .from(riskRealisations)
      .where(eq(riskRealisations.riskId, realisedRiskId));
    expect(again.length).toBe(2);
  });

  it("publishes estimate accuracy with what it could not compare, never as a clean score", async () => {
    const res = await get(`/learning/libraries/accuracy`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    const rates = body.rates as Json;
    expect(rates.comparable).toBeGreaterThan(0);
    expect(typeof rates.notComparable).toBe("number");
    expect(String(rates.reason)).toContain("librar");
    const realisation = body.riskRealisation as Array<Json>;
    expect(realisation.length).toBeGreaterThan(0);
    const technical = realisation.find((r) => r.category === "technical")!;
    expect((technical.impactByCurrency as Array<Json>).every((c) => typeof c.currency === "string")).toBe(
      true,
    );
    expect(String(body.basis)).toContain("median outturn");
  });

  it("keeps risk realisations inside the tenant", async () => {
    const mine = await get(`/learning/risk-realisations?pageSize=100`);
    const myIds = ((mine.json() as Json).items as Array<Json>).map((i) => i.id);
    expect(myIds.length).toBeGreaterThan(0);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/learning/risk-realisations?pageSize=100",
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(200);
    const theirs = ((res.json() as Json).items as Array<Json>).map((i) => i.id);
    expect(theirs).toEqual([]);
    for (const id of myIds) expect(theirs).not.toContain(id);
  });

  it("shows a project member only the realisations of projects they can see", async () => {
    /* `reader` holds learning on `projectId` alone, and the realisations live
       there — so they see them, and nothing from a project they are not on. */
    const res = await get(`/learning/risk-realisations?pageSize=100`, readerHeaders);
    expect(res.statusCode).toBe(200);
    const rows = (res.json() as Json).items as Array<Json>;
    expect(rows.every((r) => r.projectId === projectId)).toBe(true);
  });

  it("keeps the accepted rate in force until its replacement is accepted", async () => {
    /* Move the outturn on project B so the median genuinely changes. */
    const boq = await app.db
      .select({ id: boqs.id })
      .from(boqs)
      .where(eq(boqs.projectId, libProjectB));
    const items = await app.db
      .select({ id: boqItems.id })
      .from(boqItems)
      .where(eq(boqItems.boqId, boq[0]!.id));
    await app.db
      .update(valuationLines)
      .set({ amountToDate: 30_000 })
      .where(eq(valuationLines.boqItemId, items[0]!.id));

    const before = await get(`/learning/libraries/rates?code=E10&status=accepted`);
    const accepted = ((before.json() as Json).items as Array<Json>)[0]!;

    await post(`/learning/libraries/rebuild`);
    const proposals = await get(`/learning/libraries/rates?code=E10&status=proposed`);
    const proposal = ((proposals.json() as Json).items as Array<Json>)[0]!;
    expect(proposal).toBeDefined();
    expect(proposal.supersedesId).toBe(accepted.id);

    // the library is never empty in between: the accepted entry still stands
    const still = await get(`/learning/libraries/rates?code=E10&status=accepted`);
    expect(((still.json() as Json).items as Array<Json>)[0]!.id).toBe(accepted.id);

    await post(`/learning/libraries/rates/${proposal.id as string}/accept`);
    const after = await get(`/learning/libraries/rates?code=E10&status=accepted`);
    const nowAccepted = (after.json() as Json).items as Array<Json>;
    expect(nowAccepted).toHaveLength(1);
    expect(nowAccepted[0]!.id).toBe(proposal.id);
    const retired = await get(`/learning/libraries/rates?code=E10&status=superseded`);
    expect(((retired.json() as Json).items as Array<Json>).map((i) => i.id)).toContain(accepted.id);
  });

  it("registers the knowledge-graph and library sweeps with the platform scheduler", async () => {
    const names = app.scheduler.list().map((j) => j.name);
    expect(names).toContain("learning.knowledge-graph");
    expect(names).toContain("learning.libraries");
  });
});
