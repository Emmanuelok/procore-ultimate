import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  boqItems,
  boqs,
  companyMemberships,
  contractEvents,
  contracts,
  dailyLogs,
  delayEvents,
  evidence,
  ledgerEntries,
  obligations,
  projects,
  rfis,
  scheduleBaselines,
  scheduleDependencies,
  scheduleTasks,
  schedules,
  signals,
  siteWeatherAnalyses,
  timecards,
  variations,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let assessor: TestActor; // second user (company admin) for determination independence
let assessorHeaders: Record<string, string>;
let approver: TestActor; // third user — determination must differ from the assessor too
let approverHeaders: Record<string, string>;

let projectId: string; // main project with schedule A(5) -> B(10)
let project2Id: string; // windows-analysis project
let project3Id: string; // bare project (no schedule, no BoQ)
let scheduleId: string;
let schedule2Id: string;
let taskA: string;
let taskB: string;
let baselineId: string;
let evidenceId: string;
let contractId: string;
let contractEventId: string;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  assessor = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: assessor.userId,
    role: "admin",
  });
  assessorHeaders = {
    authorization: assessor.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };
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

  projectId = newId("prj");
  project2Id = newId("prj");
  project3Id = newId("prj");
  await app.db.insert(projects).values([
    { id: projectId, companyId: owner.companyId, name: "Forensics Test Project" },
    { id: project2Id, companyId: owner.companyId, name: "Windows Analysis Project" },
    { id: project3Id, companyId: owner.companyId, name: "Bare Project" },
  ]);

  // Master programme: A(5) --FS--> B(10), projectStart 2026-01-01.
  // Computed fields persisted as the schedule module would after a CPM pass
  // (matches lib/cpm.test.ts: duration 15, finish 2026-01-15).
  scheduleId = newId("sch");
  taskA = newId("tsk");
  taskB = newId("tsk");
  await app.db.insert(schedules).values({
    id: scheduleId,
    companyId: owner.companyId,
    projectId,
    name: "Master Programme",
    projectStart: "2026-01-01",
    isActive: 1,
    computedFinish: "2026-01-15",
    computedDurationDays: 15,
    createdBy: owner.userId,
  });
  await app.db.insert(scheduleTasks).values([
    {
      id: taskA,
      scheduleId,
      projectId,
      name: "Excavation",
      durationDays: 5,
      sortOrder: 0,
      startDate: "2026-01-01",
      finishDate: "2026-01-05",
      totalFloat: 0,
      isCritical: 1,
    },
    {
      id: taskB,
      scheduleId,
      projectId,
      name: "Concrete Works",
      durationDays: 10,
      sortOrder: 1,
      startDate: "2026-01-06",
      finishDate: "2026-01-15",
      totalFloat: 0,
      isCritical: 1,
    },
  ]);
  await app.db.insert(scheduleDependencies).values({
    id: newId("dep"),
    scheduleId,
    predecessorId: taskA,
    successorId: taskB,
    depType: "FS",
    lagDays: 0,
  });
  baselineId = newId("bas");
  await app.db.insert(scheduleBaselines).values({
    id: baselineId,
    scheduleId,
    projectId,
    name: "Baseline 1",
    projectStart: "2026-01-01",
    computedFinish: "2026-01-15",
    snapshot: [
      {
        taskId: taskA,
        name: "Excavation",
        durationDays: 5,
        startDate: "2026-01-01",
        finishDate: "2026-01-05",
        totalFloat: 0,
        isCritical: true,
      },
      {
        taskId: taskB,
        name: "Concrete Works",
        durationDays: 10,
        startDate: "2026-01-06",
        finishDate: "2026-01-15",
        totalFloat: 0,
        isCritical: true,
      },
    ],
    capturedBy: owner.userId,
  });

  // Windows project schedule (no baseline — windows tolerates that).
  schedule2Id = newId("sch");
  await app.db.insert(schedules).values({
    id: schedule2Id,
    companyId: owner.companyId,
    projectId: project2Id,
    name: "Windows Programme",
    projectStart: "2026-01-01",
    isActive: 1,
    createdBy: owner.userId,
  });

  evidenceId = newId("evd");
  await app.db.insert(evidence).values({
    id: evidenceId,
    companyId: owner.companyId,
    projectId,
    kind: "photograph",
    source: "site camera",
    contentHash: "hash-abc-123",
    submittedBy: assessor.userId,
  });

  contractId = newId("con");
  await app.db.insert(contracts).values({
    id: contractId,
    companyId: owner.companyId,
    projectId,
    name: "Main Works Contract",
    form: "nec4_ecc",
    necOption: "A",
    createdBy: owner.userId,
  });
  contractEventId = newId("cev");
  await app.db.insert(contractEvents).values({
    id: contractEventId,
    companyId: owner.companyId,
    projectId,
    contractId,
    number: 1,
    kind: "early_warning",
    title: "Unforeseen ground conditions",
    eventDate: "2026-01-02",
    noticeServedAt: "2026-01-04T10:00:00Z",
    raisedBy: owner.userId,
  });
});

afterAll(async () => {
  await built.close();
});

async function createDelayEvent(pid: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/delay-events`,
    headers: owner.headers,
    payload,
  });
}

/* ------------------------------------------------------------------ */
/* Delay event register (#265-268)                                     */
/* ------------------------------------------------------------------ */

let ev1Id: string; // excusable non-compensable, 2026-01-10, 3d, on task B
let ev2Id: string; // compensable, no task, 2026-02-15, 2d

describe("delay events", () => {
  it("rejects a compensable but non-excusable classification (400)", async () => {
    const res = await createDelayEvent(projectId, {
      title: "Contradictory classification",
      cause: "client_change",
      excusable: false,
      compensable: true,
      startDate: "2026-01-05",
      durationDays: 2,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("excusable");
  });

  it("creates events with sequential numbering and resolves the active schedule for a bare taskId", async () => {
    const r1 = await createDelayEvent(projectId, {
      title: "Storm shutdown",
      cause: "exceptional_weather",
      excusable: true,
      compensable: false,
      startDate: "2026-01-10",
      durationDays: 3,
      taskId: taskB, // no scheduleId — must resolve + store the active schedule
    });
    expect(r1.statusCode).toBe(201);
    const b1 = r1.json();
    expect(b1.number).toBe(1);
    expect(b1.status).toBe("open");
    expect(b1.scheduleId).toBe(scheduleId);
    expect(b1.taskId).toBe(taskB);
    ev1Id = b1.id;

    const r2 = await createDelayEvent(projectId, {
      title: "Late steel design",
      cause: "late_design_information",
      excusable: true,
      compensable: true,
      startDate: "2026-02-15",
      durationDays: 2,
    });
    expect(r2.statusCode).toBe(201);
    expect(r2.json().number).toBe(2);
    ev2Id = r2.json().id;
  });

  it("rejects a taskId that does not belong to the schedule and a foreign scheduleId", async () => {
    const badTask = await createDelayEvent(projectId, {
      title: "Bad task",
      cause: "other",
      excusable: false,
      compensable: false,
      startDate: "2026-01-05",
      durationDays: 1,
      taskId: newId("tsk"),
    });
    expect(badTask.statusCode).toBe(400);

    // schedule2 belongs to project2 — invalid for the main project
    const foreignSchedule = await createDelayEvent(projectId, {
      title: "Foreign schedule",
      cause: "other",
      excusable: false,
      compensable: false,
      startDate: "2026-01-05",
      durationDays: 1,
      taskId: taskA,
      scheduleId: schedule2Id,
    });
    expect(foreignSchedule.statusCode).toBe(400);
  });

  it("validates evidence and contract-event references and expands them on GET one", async () => {
    const badEvidence = await createDelayEvent(projectId, {
      title: "Bad evidence",
      cause: "other",
      excusable: true,
      compensable: false,
      startDate: "2026-01-09",
      durationDays: 2,
      evidenceIds: [newId("evd")],
    });
    expect(badEvidence.statusCode).toBe(400);

    const badContractEvent = await createDelayEvent(projectId, {
      title: "Bad contract event",
      cause: "other",
      excusable: true,
      compensable: false,
      startDate: "2026-01-09",
      durationDays: 2,
      contractEventId: newId("cev"),
    });
    expect(badContractEvent.statusCode).toBe(400);

    const good = await createDelayEvent(projectId, {
      title: "Ground conditions stop",
      cause: "unforeseen_ground_conditions",
      excusable: true,
      compensable: false,
      startDate: "2026-01-09",
      durationDays: 2,
      taskId: taskA,
      evidenceIds: [evidenceId, evidenceId], // duplicates collapse
      contractEventId,
    });
    expect(good.statusCode).toBe(201);
    expect(good.json().evidenceIds).toEqual([evidenceId]);

    const one = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/delay-events/${good.json().id}`,
      headers: owner.headers,
    });
    expect(one.statusCode).toBe(200);
    const body = one.json();
    expect(body.task).toEqual({ id: taskA, name: "Excavation" });
    expect(body.contractEvent.title).toBe("Unforeseen ground conditions");
    expect(body.evidence).toHaveLength(1);
    expect(body.evidence[0].id).toBe(evidenceId);
    expect(body.evidence[0].kind).toBe("photograph");
  });

  it("filters the list by classification flags", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/delay-events?excusable=true&compensable=false`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThanOrEqual(2);
    for (const item of body.items) {
      expect(item.excusable).toBe(1);
      expect(item.compensable).toBe(0);
    }
  });

  it("enforces the classification rule on PATCH with merged values and ledgers the change", async () => {
    // ev2 is compensable — flipping excusable off must fail
    const bad = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/delay-events/${ev2Id}`,
      headers: owner.headers,
      payload: { excusable: false },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/delay-events/${ev2Id}`,
      headers: owner.headers,
      payload: { title: "Late steel design information" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().title).toBe("Late steel design information");
  });

  it("changes status and appends a state_change ledger entry", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/delay-events/${ev2Id}/status`,
      headers: owner.headers,
      payload: { status: "assessed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("assessed");

    const rows = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "delay_event"),
          eq(ledgerEntries.action, "state_change"),
        ),
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ */
/* Time Impact Analysis (#272)                                         */
/* ------------------------------------------------------------------ */

describe("TIA fragnet insertion", () => {
  it("hand-checked: a 7-day fragnet mid-chain delays completion by 7 days", async () => {
    // Matches lib/cpm.test.ts "fragnet insertion delays the completion":
    // A(5)->B(10) is 15 days; A -> DELAY(7) -> B pushes B to day 12 → 22 days.
    const create = await createDelayEvent(projectId, {
      title: "Design hold on excavation handover",
      cause: "client_change",
      excusable: true,
      compensable: true,
      startDate: "2026-01-01", // SNET before A finishes — logic drives, not the date
      durationDays: 7,
      taskId: taskA,
      scheduleId,
    });
    expect(create.statusCode).toBe(201);
    const eventId = create.json().id as string;

    const tia = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/delay-events/${eventId}/tia`,
      headers: owner.headers,
    });
    expect(tia.statusCode).toBe(200);
    const body = tia.json();
    expect(body.completionDeltaDays).toBe(7);
    expect(body.beforeFinish).toBe("2026-01-15");
    expect(body.afterFinish).toBe("2026-01-22");

    // persisted on the event
    const one = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/delay-events/${eventId}`,
      headers: owner.headers,
    });
    expect(one.json().tiaResult.completionDeltaDays).toBe(7);
    expect(one.json().tiaResult.computedAt).toBeTruthy();
  });

  it("honours the delay start date via start_no_earlier_than on the fragnet", async () => {
    // Delay starts 2026-01-11 (day 10), after A finishes (day 5): the fragnet
    // waits for its real-world start → B starts day 17, completion 27 days.
    const create = await createDelayEvent(projectId, {
      title: "Late variation instruction",
      cause: "client_change",
      excusable: true,
      compensable: true,
      startDate: "2026-01-11",
      durationDays: 7,
      taskId: taskA,
      scheduleId,
    });
    const eventId = create.json().id as string;
    const tia = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/delay-events/${eventId}/tia`,
      headers: owner.headers,
    });
    expect(tia.statusCode).toBe(200);
    expect(tia.json().completionDeltaDays).toBe(12);
    expect(tia.json().afterFinish).toBe("2026-01-27");
  });

  it("requires the event to reference a schedule task (400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/delay-events/${ev2Id}/tia`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("taskId");
  });
});

/* ------------------------------------------------------------------ */
/* As-planned vs as-built (#269)                                       */
/* ------------------------------------------------------------------ */

describe("as-planned vs as-built", () => {
  it("reports per-task slips and the headline slip after actuals move the programme", async () => {
    // Site started excavation 2 days late; forecasts (persisted CPM output)
    // shift everything +2 as the schedule module would after recompute.
    await app.db
      .update(scheduleTasks)
      .set({ actualStart: "2026-01-03", startDate: "2026-01-03", finishDate: "2026-01-07" })
      .where(eq(scheduleTasks.id, taskA));
    await app.db
      .update(scheduleTasks)
      .set({ startDate: "2026-01-08", finishDate: "2026-01-17" })
      .where(eq(scheduleTasks.id, taskB));
    await app.db
      .update(schedules)
      .set({ computedFinish: "2026-01-17" })
      .where(eq(schedules.id, scheduleId));

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/forensics/as-planned-vs-as-built`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scheduleId).toBe(scheduleId);
    expect(body.baselineId).toBe(baselineId);
    expect(body.plannedFinish).toBe("2026-01-15");
    expect(body.currentForecastFinish).toBe("2026-01-17");
    expect(body.totalSlipDays).toBe(2);

    const a = body.tasks.find((t: { taskId: string }) => t.taskId === taskA);
    expect(a.plannedStart).toBe("2026-01-01");
    expect(a.actualOrForecastStart).toBe("2026-01-03"); // actualStart wins
    expect(a.startSlipDays).toBe(2);
    expect(a.finishSlipDays).toBe(2);
    expect(a.hasStarted).toBe(true);

    const b = body.tasks.find((t: { taskId: string }) => t.taskId === taskB);
    expect(b.actualOrForecastStart).toBe("2026-01-08"); // forecast (no actual)
    expect(b.finishSlipDays).toBe(2);
    expect(b.isCritical).toBe(true);
  });

  it("fails with a clear message when the schedule has no baseline", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project2Id}/forensics/as-planned-vs-as-built?scheduleId=${schedule2Id}`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("baseline");
  });
});

/* ------------------------------------------------------------------ */
/* Windows analysis (#273)                                             */
/* ------------------------------------------------------------------ */

describe("windows analysis", () => {
  it("buckets delay events by start date and sums classification days + TIA deltas", async () => {
    const e1 = await createDelayEvent(project2Id, {
      title: "Employer variation stop",
      cause: "client_change",
      excusable: true,
      compensable: true,
      startDate: "2026-01-10",
      durationDays: 5,
    });
    const e2 = await createDelayEvent(project2Id, {
      title: "February storms",
      cause: "exceptional_weather",
      excusable: true,
      compensable: false,
      startDate: "2026-02-10",
      durationDays: 3,
    });
    const e3 = await createDelayEvent(project2Id, {
      title: "Subcontractor no-show",
      cause: "subcontractor_default",
      excusable: false,
      compensable: false,
      startDate: "2026-03-05",
      durationDays: 4,
    });
    expect(e1.statusCode).toBe(201);
    expect(e2.statusCode).toBe(201);
    expect(e3.statusCode).toBe(201);
    // a previously computed TIA rides along into the window totals
    await app.db
      .update(delayEvents)
      .set({ tiaResult: { completionDeltaDays: 5, computedAt: new Date().toISOString() } })
      .where(eq(delayEvents.id, e1.json().id));

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project2Id}/forensics/windows?boundaries=2026-03-01,2026-02-01`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.method).toContain("TIA");
    expect(body.boundaries).toEqual(["2026-02-01", "2026-03-01"]); // sorted
    expect(body.windows).toHaveLength(3);

    const [w0, w1, w2] = body.windows;
    expect(w0.start).toBe("2026-01-01");
    expect(w0.end).toBe("2026-02-01");
    expect(w0.totals).toEqual({
      events: 1,
      excusableDays: 0,
      compensableDays: 5,
      nonExcusableDays: 0,
      tiaDeltaDays: 5,
      staleTia: 0,
    });
    expect(w0.events[0].tiaDeltaDays).toBe(5);

    expect(w1.totals.events).toBe(1);
    expect(w1.totals.excusableDays).toBe(3);
    expect(w1.totals.compensableDays).toBe(0);

    expect(w2.end).toBeNull(); // open-ended final window
    expect(w2.totals.nonExcusableDays).toBe(4);
    expect(body.unattributedEvents).toBe(0);
  });

  it("rejects malformed boundaries", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project2Id}/forensics/windows?boundaries=not-a-date`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Prolongation (#299-301 seed)                                        */
/* ------------------------------------------------------------------ */

let mainBoqId: string;

describe("prolongation", () => {
  it("computes from an explicit rate", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/prolongation`,
      headers: owner.headers,
      payload: { compensableDays: 10, prelimsRatePerDay: 500 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.amount).toBe(5000);
    expect(body.prelimsRatePerDay).toBe(500);
    expect(body.derivation).toContain("explicit");
    expect(body.sources).toBeNull();
  });

  it("derives the rate from prelims_time BQ items over the programme duration", async () => {
    const boqId = newId("boq");
    mainBoqId = boqId;
    await app.db.insert(boqs).values({
      id: boqId,
      companyId: owner.companyId,
      projectId,
      name: "Main BQ",
      status: "agreed",
      currency: "GBP",
      createdBy: owner.userId,
    });
    await app.db.insert(boqItems).values([
      {
        id: newId("bqi"),
        boqId,
        path: "0001",
        level: "item",
        code: "A1.1",
        description: "Site management (time-related)",
        itemType: "prelims_time",
        amount: 900,
      },
      {
        id: newId("bqi"),
        boqId,
        path: "0002",
        level: "item",
        code: "A1.2",
        description: "Cranage (time-related)",
        itemType: "prelims_time",
        amount: 600,
      },
      {
        id: newId("bqi"),
        boqId,
        path: "0003",
        level: "item",
        code: "B2.1",
        description: "Concrete in foundations",
        itemType: "measured",
        amount: 99999, // must NOT leak into the prelims rate
      },
    ]);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/prolongation`,
      headers: owner.headers,
      payload: { compensableDays: 12 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 1500 prelims over the active schedule's 15-day duration = 100/day
    expect(body.prelimsRatePerDay).toBe(100);
    expect(body.amount).toBe(1200);
    expect(body.currency).toBe("GBP");
    expect(body.sources).toEqual({
      prelimsTimeTotal: 1500,
      scheduleDurationDays: 15,
      scheduleId,
      boqIds: [boqId],
      currency: "GBP",
      basis: "agreed bills of quantities",
    });
  });

  it("refuses to price prolongation from a draft bill, and from two bills without a choice", async () => {
    // A draft bill is not a priced position — deriving a rate from it is wrong
    // by construction, so the caller is told to choose or supply a rate.
    const draftOnlyProject = newId("prj");
    await app.db.insert(projects).values({
      id: draftOnlyProject,
      companyId: owner.companyId,
      name: "Draft BQ project",
    });
    await app.db.insert(boqs).values({
      id: newId("boq"),
      companyId: owner.companyId,
      projectId: draftOnlyProject,
      name: "Draft BQ",
      status: "draft",
      createdBy: owner.userId,
    });
    const draftRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${draftOnlyProject}/forensics/prolongation`,
      headers: owner.headers,
      payload: { compensableDays: 5 },
    });
    expect(draftRes.statusCode).toBe(400);
    expect(draftRes.json().message).toMatch(/none is agreed or issued/i);

    // Two agreed bills: summing them would mix versions, so the caller chooses.
    const secondAgreed = newId("boq");
    await app.db.insert(boqs).values({
      id: secondAgreed,
      companyId: owner.companyId,
      projectId,
      name: "Main BQ v2",
      status: "agreed",
      currency: "GBP",
      version: 2,
      createdBy: owner.userId,
    });
    const ambiguous = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/prolongation`,
      headers: owner.headers,
      payload: { compensableDays: 5 },
    });
    expect(ambiguous.statusCode).toBe(400);
    expect(ambiguous.json().message).toMatch(/pass boqId/i);

    // Different currencies are refused outright — money is never summed across them.
    await app.db
      .update(boqs)
      .set({ currency: "USD" })
      .where(eq(boqs.id, secondAgreed));
    const mixed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/prolongation`,
      headers: owner.headers,
      payload: { compensableDays: 5 },
    });
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json().message).toMatch(/never summed across currencies/i);

    // Naming a bill resolves the ambiguity and reports which one was used.
    const chosen = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/prolongation`,
      headers: owner.headers,
      payload: { compensableDays: 12, boqId: mainBoqId },
    });
    expect(chosen.statusCode).toBe(200);
    expect(chosen.json().sources.boqIds).toEqual([mainBoqId]);
    expect(chosen.json().amount).toBe(1200);

    // Clean up so later suites see a single agreed bill again.
    await app.db.delete(boqs).where(eq(boqs.id, secondAgreed));
  });

  it("400s when the rate is neither given nor derivable", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project3Id}/forensics/prolongation`,
      headers: owner.headers,
      payload: { compensableDays: 5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("prelims");
  });
});

/* ------------------------------------------------------------------ */
/* Claims workspace (#304-320)                                         */
/* ------------------------------------------------------------------ */

let claim1Id: string;

describe("claims", () => {
  it("validates delayEventIds and creates with numbering + the CEEQ chain", async () => {
    const bad = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims`,
      headers: owner.headers,
      payload: { title: "Bad refs", kind: "delay", delayEventIds: [newId("dly")] },
    });
    expect(bad.statusCode).toBe(400);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims`,
      headers: owner.headers,
      payload: {
        title: "EOT — storm and design holds",
        kind: "delay",
        contractId,
        clauseRef: "60.1",
        delayEventIds: [ev1Id],
        chain: {
          cause: "Exceptionally adverse weather 10-12 Jan",
          effect: "Concrete works suspended 3 days",
          entitlement: "NEC4 cl. 60.1(13) compensation event",
          quantum: "3 days EOT",
        },
        daysClaimed: 3,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.number).toBe(1);
    expect(body.status).toBe("draft");
    expect(body.chain.entitlement).toContain("60.1");
    claim1Id = body.id;

    const one = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/claims/${claim1Id}`,
      headers: owner.headers,
    });
    expect(one.statusCode).toBe(200);
    expect(one.json().delayEvents).toHaveLength(1);
    expect(one.json().delayEvents[0].id).toBe(ev1Id);
  });

  it("walks the lifecycle and forbids self-assessment (403)", async () => {
    const submit = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${claim1Id}/status`,
      headers: owner.headers,
      payload: { status: "submitted" },
    });
    expect(submit.statusCode).toBe(200);

    const selfAssess = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${claim1Id}/status`,
      headers: owner.headers, // owner created the claim
      payload: { status: "assessed", daysAssessed: 2 },
    });
    expect(selfAssess.statusCode).toBe(403);

    const assess = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${claim1Id}/status`,
      headers: assessorHeaders,
      payload: { status: "assessed", daysAssessed: 2, amountAssessed: 15000 },
    });
    expect(assess.statusCode).toBe(200);
    expect(assess.json().daysAssessed).toBe(2);
    expect(assess.json().assessedBy).toBe(assessor.userId);

    // Segregation of duties on the DETERMINATION, not just the assessment:
    // neither the claimant nor the assessor may agree the claim.
    const selfAgree = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${claim1Id}/status`,
      headers: owner.headers, // owner created it
      payload: { status: "agreed" },
    });
    expect(selfAgree.statusCode).toBe(403);
    expect(selfAgree.json().message).toMatch(/created it/i);

    const assessorAgrees = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${claim1Id}/status`,
      headers: assessorHeaders, // assessor assessed it
      payload: { status: "agreed" },
    });
    expect(assessorAgrees.statusCode).toBe(403);
    expect(assessorAgrees.json().message).toMatch(/assessed it/i);

    const agree = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${claim1Id}/status`,
      headers: approverHeaders,
      payload: { status: "agreed" },
    });
    expect(agree.statusCode).toBe(200);
    expect(agree.json().decidedBy).toBe(approver.userId);

    // agreed is terminal — no withdrawal after agreement
    const withdrawAgreed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${claim1Id}/status`,
      headers: owner.headers,
      payload: { status: "withdrawn" },
    });
    expect(withdrawAgreed.statusCode).toBe(400);
  });

  it("freezes chain and delayEventIds once the claim leaves draft; withdrawal works pre-agreement", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims`,
      headers: owner.headers,
      payload: { title: "Prolongation claim", kind: "prolongation" },
    });
    const id = create.json().id as string;
    expect(create.json().number).toBe(2);

    const draftPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/claims/${id}`,
      headers: owner.headers,
      payload: {
        chain: {
          cause: "Compensable delays",
          effect: "Site held 5 days",
          entitlement: "Clause 60.1",
          quantum: "Prolongation at the site overhead rate",
        },
        daysClaimed: 5,
      },
    });
    expect(draftPatch.statusCode).toBe(200);

    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${id}/status`,
      headers: owner.headers,
      payload: { status: "submitted" },
    });
    expect(submitted.statusCode).toBe(200);
    const frozenPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/claims/${id}`,
      headers: owner.headers,
      payload: { chain: { cause: "rewritten" } },
    });
    expect(frozenPatch.statusCode).toBe(400);

    // Everything that defines the claim is frozen after draft — including the
    // title and, critically, the quantum: an assessed claim whose amount could
    // still be raised is an assessment of numbers nobody assessed.
    const titlePatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/claims/${id}`,
      headers: owner.headers,
      payload: { title: "Prolongation claim (rev A)" },
    });
    expect(titlePatch.statusCode).toBe(400);

    const withdraw = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${id}/status`,
      headers: owner.headers,
      payload: { status: "withdrawn" },
    });
    expect(withdraw.statusCode).toBe(200);
    expect(withdraw.json().status).toBe("withdrawn");
  });
});

/* ------------------------------------------------------------------ */
/* Chronology auto-assembly (#318)                                     */
/* ------------------------------------------------------------------ */

describe("chronology", () => {
  it("assembles platform records in ascending date order and persists them", async () => {
    await app.db.insert(rfis).values({
      id: newId("rfi"),
      companyId: owner.companyId,
      projectId,
      number: 1,
      subject: "Rebar clash at grid 4",
      question: "Confirm bar spacing at grid 4",
      status: "answered",
      createdBy: owner.userId,
      createdAt: "2026-01-05T08:00:00Z",
      respondedAt: "2026-01-12T08:00:00Z",
    });
    await app.db.insert(dailyLogs).values([
      {
        id: newId("log"),
        companyId: owner.companyId,
        projectId,
        logDate: "2026-01-15",
        sections: { delays: [{ description: "Tower crane down all day" }] },
        createdBy: owner.userId,
      },
      {
        id: newId("log"),
        companyId: owner.companyId,
        projectId,
        logDate: "2026-01-16",
        sections: { delays: [], notes: "clear day" }, // empty delays — excluded
        createdBy: owner.userId,
      },
    ]);
    await app.db.insert(variations).values({
      id: newId("var"),
      companyId: owner.companyId,
      projectId,
      number: 1,
      title: "Additional drainage runs",
      status: "instructed",
      instructedAt: "2026-01-20",
      createdBy: owner.userId,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${claim1Id}/chronology`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(body.items.length);
    expect(body.chronologyAt).toBeTruthy();

    const items = body.items as { date: string; source: string; ref: string; title: string }[];
    // sorted ascending
    for (let i = 1; i < items.length; i += 1) {
      expect(items[i]!.date >= items[i - 1]!.date).toBe(true);
    }
    const refs = items.map((i) => `${i.source}:${i.ref}`);
    expect(refs).toContain("delay_event:DE-1");
    expect(refs).toContain("contract_event:CE-1");
    expect(refs).toContain("rfi:RFI-1");
    expect(refs).toContain("daily_log:LOG-2026-01-15");
    expect(refs).toContain("variation:VO-1");
    expect(refs).not.toContain("daily_log:LOG-2026-01-16");
    // RFI appears twice: raised + answered; contract event twice: event + notice
    expect(items.filter((i) => i.ref === "RFI-1")).toHaveLength(2);
    expect(items.filter((i) => i.ref === "CE-1")).toHaveLength(2);
    expect(items.some((i) => i.title.startsWith("Notice served"))).toBe(true);

    // persisted on the claim
    const one = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/claims/${claim1Id}`,
      headers: owner.headers,
    });
    expect(one.json().chronology).toHaveLength(body.count);
    expect(one.json().chronologyAt).toBeTruthy();
  });
});

/* ================================================================== */
/* WP-SCHED upgrade — audit regressions and the forensic method suite  */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* Claim quantum integrity (audit: editable after submission)          */
/* ------------------------------------------------------------------ */

describe("claim quantum integrity", () => {
  let id: string;

  it("refuses to change the claimed amount on a submitted or assessed claim", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims`,
      headers: owner.headers,
      payload: {
        title: "Quantum integrity",
        kind: "prolongation",
        chain: { cause: "c", effect: "e", entitlement: "ent", quantum: "q" },
        amountClaimed: 100_000,
        daysClaimed: 10,
      },
    });
    expect(create.statusCode).toBe(201);
    id = create.json().id as string;

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${id}/status`,
      headers: owner.headers,
      payload: { status: "submitted" },
    });
    const raise = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/claims/${id}`,
      headers: owner.headers,
      payload: { amountClaimed: 500_000 },
    });
    expect(raise.statusCode).toBe(400);
    expect(raise.json().message).toMatch(/amountClaimed/);

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${id}/status`,
      headers: assessorHeaders,
      payload: { status: "assessed", amountAssessed: 60_000, daysAssessed: 6 },
    });
    const raiseAgain = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/claims/${id}`,
      headers: owner.headers,
      payload: { amountClaimed: 500_000, daysClaimed: 40 },
    });
    expect(raiseAgain.statusCode).toBe(400);
    const still = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/claims/${id}`,
      headers: owner.headers,
    });
    expect(still.json().amountClaimed).toBe(100_000);
    expect(still.json().amountAssessed).toBe(60_000);
  });

  it("the revise transition clears the assessment and lets the quantum change", async () => {
    const noReason = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${id}/status`,
      headers: owner.headers,
      payload: { status: "draft" },
    });
    expect(noReason.statusCode).toBe(400);

    const revise = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${id}/status`,
      headers: owner.headers,
      payload: { status: "draft", reason: "Quantum restated after the measured mile" },
    });
    expect(revise.statusCode).toBe(200);
    const revised = revise.json();
    expect(revised.status).toBe("draft");
    expect(revised.amountAssessed).toBeNull();
    expect(revised.assessedBy).toBeNull();
    expect(revised.revisionCount).toBe(1);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/claims/${id}`,
      headers: owner.headers,
      payload: { amountClaimed: 500_000 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().amountClaimed).toBe(500_000);
  });

  it("refuses to submit a claim with an incomplete chain (#305)", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims`,
      headers: owner.headers,
      payload: { title: "Empty chain", kind: "delay" },
    });
    const emptyId = create.json().id as string;
    const submit = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${emptyId}/status`,
      headers: owner.headers,
      payload: { status: "submitted" },
    });
    expect(submit.statusCode).toBe(400);
    expect(submit.json().message).toMatch(/cause, effect, entitlement, quantum/);

    // Complete chain but nothing claimed and no events — still nothing to assess.
    await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/claims/${emptyId}`,
      headers: owner.headers,
      payload: { chain: { cause: "c", effect: "e", entitlement: "ent", quantum: "q" } },
    });
    const stillEmpty = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${emptyId}/status`,
      headers: owner.headers,
      payload: { status: "submitted" },
    });
    expect(stillEmpty.statusCode).toBe(400);
    expect(stillEmpty.json().message).toMatch(/nothing to assess/);

    await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/claims/${emptyId}`,
      headers: owner.headers,
      payload: { daysClaimed: 4 },
    });
    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${emptyId}/status`,
      headers: owner.headers,
      payload: { status: "submitted" },
    });
    expect(ok.statusCode).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* Delay event state machine (audit: any status -> any status)         */
/* ------------------------------------------------------------------ */

describe("delay event state machine", () => {
  let eventId: string;

  it("enforces the transition table and demands a reason to withdraw", async () => {
    const created = await createDelayEvent(project2Id, {
      title: "Raised in error",
      cause: "other",
      excusable: true,
      compensable: true,
      startDate: "2026-01-20",
      durationDays: 20,
    });
    expect(created.statusCode).toBe(201);
    eventId = created.json().id as string;

    const noReason = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project2Id}/delay-events/${eventId}/status`,
      headers: owner.headers,
      payload: { status: "withdrawn" },
    });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().message).toMatch(/reason is required/i);

    const withdrawn = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project2Id}/delay-events/${eventId}/status`,
      headers: owner.headers,
      payload: { status: "withdrawn", reason: "Duplicate of DE-1" },
    });
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json().statusReason).toBe("Duplicate of DE-1");

    // withdrawn -> assessed is not a legal move
    const illegal = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project2Id}/delay-events/${eventId}/status`,
      headers: owner.headers,
      payload: { status: "assessed", reason: "x" },
    });
    expect(illegal.statusCode).toBe(400);

    // reopening is allowed but must be justified
    const reopenNoReason = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project2Id}/delay-events/${eventId}/status`,
      headers: owner.headers,
      payload: { status: "open" },
    });
    expect(reopenNoReason.statusCode).toBe(400);
  });

  it("keeps a withdrawn event out of windows totals", async () => {
    const withdrawnStillCounted = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project2Id}/forensics/windows?boundaries=2026-02-01`,
      headers: owner.headers,
    });
    expect(withdrawnStillCounted.statusCode).toBe(200);
    const body = withdrawnStillCounted.json();
    const firstWindow = body.windows[0];
    expect(body.statuses).not.toContain("withdrawn");
    expect(firstWindow.events.map((e: { id: string }) => e.id)).not.toContain(eventId);
    // The 20 compensable days of the withdrawn event must not be in the totals.
    expect(firstWindow.totals.compensableDays).toBe(5);

    // …unless the caller explicitly asks for them, and then the filter is stated.
    const asked = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project2Id}/forensics/windows?boundaries=2026-02-01&statuses=open,withdrawn`,
      headers: owner.headers,
    });
    expect(asked.statusCode).toBe(200);
    expect(asked.json().statuses).toContain("withdrawn");
    expect(asked.json().method).toContain("withdrawn");
    expect(asked.json().windows[0].totals.compensableDays).toBe(25);
  });

  it("refuses to link a withdrawn event to a claim and refuses to edit it", async () => {
    const link = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project2Id}/claims`,
      headers: owner.headers,
      payload: { title: "Built on a withdrawn event", kind: "delay", delayEventIds: [eventId] },
    });
    expect(link.statusCode).toBe(400);
    expect(link.json().message).toMatch(/withdrawn/i);

    const edit = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project2Id}/delay-events/${eventId}`,
      headers: owner.headers,
      payload: { durationDays: 3 },
    });
    expect(edit.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Stale TIA (audit: cached results never invalidated)                 */
/* ------------------------------------------------------------------ */

describe("TIA staleness", () => {
  it("marks a cached TIA stale once the schedule is recomputed", async () => {
    // Compute once so the schedule carries a version stamp; a TIA run against
    // an unstamped schedule can only report that it predates stamping.
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/${scheduleId}/compute`,
      headers: owner.headers,
    });
    const created = await createDelayEvent(projectId, {
      title: "Stale check",
      cause: "client_change",
      excusable: true,
      compensable: true,
      startDate: "2026-01-07",
      durationDays: 4,
      taskId: taskB,
    });
    const id = created.json().id as string;

    const tia = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/delay-events/${id}/tia`,
      headers: owner.headers,
    });
    expect(tia.statusCode).toBe(200);
    expect(tia.json().completionDeltaDays).toBeGreaterThan(0);

    const fresh = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/delay-events/${id}`,
      headers: owner.headers,
    });
    expect(fresh.json().tia.stale).toBe(false);
    expect(fresh.json().tia.deltaDays).toBeGreaterThan(0);

    // The schedule is recomputed by an unrelated edit: the cached delta no
    // longer describes the programme, so it must read as stale, not as current.
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/${scheduleId}/compute`,
      headers: owner.headers,
    });
    const after = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/delay-events/${id}`,
      headers: owner.headers,
    });
    expect(after.json().tia.stale).toBe(true);
    expect(after.json().tia.deltaDays).toBeNull();
    expect(after.json().tia.reason).toMatch(/recomputed/);
  });
});

/* ------------------------------------------------------------------ */
/* Method suite, float rules, quantum, disruption, sufficiency         */
/* ------------------------------------------------------------------ */

describe("forensic method suite (#270-277)", () => {
  let iapEventId: string;

  it("recommends methods from the AACE selection factors", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/method-selection`,
      headers: owner.headers,
      payload: {
        perspective: "retrospective",
        updatesAvailable: true,
        baselineAvailable: true,
        asBuiltComplete: true,
        concurrencyInIssue: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { recommendations: { method: string; suitability: string; rationale: string }[] };
    expect(body.recommendations.some((r) => r.method === "windows" && r.suitability === "recommended")).toBe(true);
    expect(body.recommendations.every((r) => r.rationale.length > 10)).toBe(true);
  });

  it("runs an impacted as-planned analysis and records it with its MIP code", async () => {
    const created = await createDelayEvent(projectId, {
      title: "IAP event",
      cause: "client_change",
      excusable: true,
      compensable: true,
      party: "owner",
      startDate: "2026-01-07",
      durationDays: 6,
      taskId: taskB,
    });
    iapEventId = created.json().id as string;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/analyses`,
      headers: owner.headers,
      payload: {
        method: "impacted_as_planned",
        title: "IAP of the January events",
        scheduleId,
        baselineId,
        eventIds: [iapEventId],
        rationale: "Prospective additive modelling agreed with the Engineer",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      method: string;
      mipCode: string;
      sclReference: string;
      resultDays: number | null;
      output: { steps: { incrementalDays: number; driving: boolean }[] };
      summary: string;
      rationale: string;
    };
    expect(body.method).toBe("impacted_as_planned");
    expect(body.mipCode).toBe("3.6");
    expect(body.sclReference).toMatch(/SCL/);
    expect(body.resultDays).toBeGreaterThan(0);
    expect(body.output.steps).toHaveLength(1);
    expect(body.rationale).toMatch(/Engineer/);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/forensics/analyses?method=impacted_as_planned`,
      headers: owner.headers,
    });
    expect((list.json() as { total: number }).total).toBeGreaterThan(0);

    const one = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/forensics/analyses/${body.id}`,
      headers: owner.headers,
    });
    expect(one.statusCode).toBe(200);
    expect((one.json() as { inputs: { eventIds: string[] } }).inputs.eventIds).toEqual([iapEventId]);
  });

  it("runs a collapsed as-built analysis for a chosen party", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/analyses`,
      headers: owner.headers,
      payload: {
        method: "collapsed_as_built",
        title: "But-for the employer's delays",
        scheduleId,
        party: "owner",
        eventIds: [iapEventId],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { output: { removed: unknown[]; butForFinish: string | null }; summary: string };
    expect(body.output.removed).toHaveLength(1);
    expect(body.summary).toMatch(/owner/);
  });

  it("refuses collapsed as-built without a party", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/analyses`,
      headers: owner.headers,
      payload: { method: "collapsed_as_built", title: "No party", scheduleId },
    });
    expect(res.statusCode).toBe(400);
  });

  it("runs a windows analysis with per-window critical-path attribution", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/analyses`,
      headers: owner.headers,
      payload: {
        method: "windows",
        title: "Windows to February",
        scheduleId,
        boundaries: ["2026-02-01"],
        eventIds: [iapEventId],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      output: { windows: { start: string; events: { driving: boolean }[]; unattributedDays: number | null }[] };
    };
    expect(body.output.windows.length).toBe(2);
    expect(body.output.windows[0]!.events.length).toBeGreaterThan(0);
  });

  it("returns the retrospective longest path with activity names", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/analyses`,
      headers: owner.headers,
      payload: { method: "longest_path", title: "As-built driving chain", scheduleId },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { output: { path: { taskId: string; name: string }[] } };
    expect(body.output.path.map((p) => p.name)).toEqual(["Excavation", "Concrete Works"]);
  });

  it("refuses to analyse withdrawn events", async () => {
    const created = await createDelayEvent(projectId, {
      title: "To be withdrawn",
      cause: "other",
      excusable: false,
      compensable: false,
      startDate: "2026-01-07",
      durationDays: 2,
      taskId: taskB,
    });
    const id = created.json().id as string;
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/delay-events/${id}/status`,
      headers: owner.headers,
      payload: { status: "withdrawn", reason: "raised in error" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/analyses`,
      headers: owner.headers,
      payload: { method: "impacted_as_planned", title: "Uses a withdrawn event", scheduleId, eventIds: [id] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/withdrawn/);
  });
});

describe("float doctrine and concurrency (#278-281)", () => {
  it("reports platform defaults until a doctrine is recorded, then cites the recorded one", async () => {
    const before = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/forensics/float-rules`,
      headers: owner.headers,
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().configured).toBe(false);
    expect(before.json().explanation).toMatch(/defaults/);

    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/forensics/float-rules`,
      headers: owner.headers,
      payload: {
        ownership: "contractor",
        concurrencyRule: "apportionment",
        pacingThresholdDays: 3,
        basis: "Contract particular condition 8.4",
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ ownership: "contractor", concurrencyRule: "apportionment", configured: true });

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/forensics/float-rules`,
      headers: owner.headers,
    });
    expect(after.json().basis).toMatch(/8.4/);
  });

  it("runs a concurrency analysis that cites the project doctrine", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/analyses`,
      headers: owner.headers,
      payload: { method: "concurrency", title: "Concurrency assessment", scheduleId },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      output: { recommendations: { rule: string; time: string; money: string }[]; rulesConfigured: boolean };
      summary: string;
    };
    expect(body.output.rulesConfigured).toBe(true);
    expect(body.summary).toMatch(/apportionment/);
    expect(body.output.recommendations.length).toBeGreaterThan(0);
  });
});

describe("quantum engines (#300-303)", () => {
  it("computes Hudson from the contract and records the assumptions", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/quantum`,
      headers: owner.headers,
      payload: {
        method: "hudson",
        contractSum: 10_000_000,
        contractPeriodDays: 500,
        hoProfitPercent: 7,
        delayDays: 30,
        currency: "GBP",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { amount: number; currency: string; assumptions: string[]; workings: string };
    expect(body.amount).toBe(42_000);
    expect(body.currency).toBe("GBP");
    expect(body.assumptions.length).toBeGreaterThan(0);
    expect(body.workings).toContain("42,000");
  });

  it("refuses to produce a figure from missing inputs and says which", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/quantum`,
      headers: owner.headers,
      payload: { method: "eichleay", delayDays: 10 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/contractBillings/);
    expect(res.json().message).toMatch(/never produced from assumed inputs/);
  });

  it("lists calculations and links them to a claim", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims`,
      headers: owner.headers,
      payload: { title: "Quantum-linked claim", kind: "prolongation" },
    });
    const claimId = create.json().id as string;
    const calc = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/quantum`,
      headers: owner.headers,
      payload: {
        method: "finance_charge",
        claimId,
        principal: 365_000,
        annualRatePercent: 10,
        days: 365,
        basis: "simple",
      },
    });
    expect(calc.statusCode).toBe(201);
    expect(calc.json().amount).toBe(36_500);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/forensics/quantum?claimId=${claimId}`,
      headers: owner.headers,
    });
    expect((list.json() as { total: number }).total).toBe(1);
  });
});

describe("claim valuation and portfolio exposure (#312-313, #320)", () => {
  it("computes a provision from the range and probability", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims`,
      headers: owner.headers,
      payload: { title: "Valued claim", kind: "delay", currency: "GBP", amountClaimed: 400_000 },
    });
    const id = create.json().id as string;
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/claims/${id}/valuation`,
      headers: owner.headers,
      payload: { quantumBest: 100_000, quantumLikely: 250_000, quantumWorst: 500_000, successProbability: 0.6 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().provisionAmount).toBe(150_000);
    expect(res.json().provision.expectedValue).toBeCloseTo(266_666.67, 1);

    const exposure = await app.inject({
      method: "GET",
      url: `/api/v1/claims/exposure`,
      headers: owner.headers,
    });
    expect(exposure.statusCode).toBe(200);
    const body = exposure.json() as {
      byCurrency: { currency: string; claims: number; provision: number }[];
      reasons: string[];
    };
    const gbp = body.byCurrency.find((c) => c.currency === "GBP")!;
    expect(gbp.provision).toBe(150_000);
    // Claims exist in more than one currency, so nothing is summed across them.
    expect(body.byCurrency.length).toBeGreaterThan(1);
    expect(body.reasons.join(" ")).toMatch(/never summed across them/);
  });
});

describe("disruption (#290-293)", () => {
  it("builds a productivity series from timecards and daily logs, and suggests a baseline window", async () => {
    const weeks = ["2026-04-06", "2026-04-13", "2026-04-20", "2026-04-27", "2026-05-04", "2026-05-11"];
    const quantities = [100, 110, 105, 60, 55, 50];
    for (let i = 0; i < weeks.length; i += 1) {
      const worker = newId("wkr");
      await app.db.insert(timecards).values({
        id: newId("tc"),
        companyId: owner.companyId,
        projectId,
        number: 1000 + i,
        reference: `TC-${1000 + i}`,
        workerId: worker,
        workDate: weeks[i]!,
        trade: "steel_fixing",
        totalHours: 100,
        status: "approved",
        createdBy: owner.userId,
      });
      await app.db.insert(dailyLogs).values({
        id: newId("log"),
        companyId: owner.companyId,
        projectId,
        logDate: weeks[i]!,
        sections: { quantities: [{ description: "Rebar fixed", unit: "t", quantity: quantities[i] }] },
        createdBy: owner.userId,
      });
    }

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/forensics/productivity-series?trade=steel_fixing&unit=t&from=2026-04-01&to=2026-05-31`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      points: { weekStart: string; hours: number; quantity: number; sourceIds: string[] }[];
      suggestedBaseline: { from: string; to: string } | null;
      sources: { timecards: number; dailyLogQuantities: number };
    };
    expect(body.points).toHaveLength(6);
    expect(body.points[0]!.hours).toBe(100);
    expect(body.points[0]!.sourceIds.length).toBeGreaterThan(0);
    expect(body.suggestedBaseline!.from).toBe("2026-04-06");
    expect(body.sources.timecards).toBe(6);
  });

  it("runs a measured mile and stores the series with its source records", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/disruption`,
      headers: owner.headers,
      payload: {
        method: "measured_mile",
        title: "Steel fixing measured mile",
        trade: "steel_fixing",
        unit: "t",
        baselineFrom: "2026-04-06",
        baselineTo: "2026-04-20",
        impactedFrom: "2026-04-27",
        impactedTo: "2026-05-11",
        hourlyRate: 40,
        currency: "GBP",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      lostHours: number | null;
      amount: number | null;
      currency: string;
      series: { window: string }[];
      output: { baselineProductivity: number; sourceIds: string[] };
    };
    expect(body.lostHours).toBeGreaterThan(0);
    expect(body.amount).toBeGreaterThan(0);
    expect(body.currency).toBe("GBP");
    expect(body.output.baselineProductivity).toBeCloseTo(1.05, 2);
    expect(body.output.sourceIds.length).toBeGreaterThan(0);
    expect(body.series.some((p) => p.window === "baseline")).toBe(true);
  });

  it("refuses an industry-curve claim with no justification", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/disruption`,
      headers: owner.headers,
      payload: {
        method: "industry_curve_mcaa",
        title: "MCAA factors",
        baseHours: 1000,
        factors: [{ key: "stacking_of_trades", severity: "average" }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/justification/i);
  });

  it("applies MCAA factors with a justification and names each factor", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/disruption`,
      headers: owner.headers,
      payload: {
        method: "industry_curve_mcaa",
        title: "MCAA factors",
        baseHours: 1000,
        hourlyRate: 40,
        factors: [
          { key: "stacking_of_trades", severity: "average" },
          { key: "dilution_of_supervision", severity: "minor" },
        ],
        justification:
          "Three trades were compelled into the same riser zone for eleven weeks by the late release of the M&E design.",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { lostHours: number; amount: number; output: { applied: { label: string }[] } };
    expect(body.lostHours).toBe(300);
    expect(body.amount).toBe(12_000);
    expect(body.output.applied.map((a) => a.label)).toContain("Stacking of trades");
  });
});

describe("record sufficiency, chronology scope and the submission package", () => {
  let claimId: string;
  let eventId: string;

  it("scores the record and finds daily-log gaps and missing notices", async () => {
    const created = await createDelayEvent(projectId, {
      title: "Sufficiency event",
      cause: "late_design_information",
      excusable: true,
      compensable: true,
      startDate: "2026-06-01",
      durationDays: 5,
      taskId: taskB,
      evidenceIds: [evidenceId],
      noticeDueDate: "2026-06-15",
    });
    expect(created.statusCode).toBe(201);
    eventId = created.json().id as string;

    await app.db.insert(dailyLogs).values({
      id: newId("log"),
      companyId: owner.companyId,
      projectId,
      logDate: "2026-06-01",
      sections: { delays: [{ description: "design hold" }] },
      createdBy: owner.userId,
    });

    const claim = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims`,
      headers: owner.headers,
      payload: {
        title: "Sufficiency claim",
        kind: "delay",
        contractId,
        delayEventIds: [eventId],
        chain: {
          cause: "The employer released the reinforcement drawings eleven days late.",
          effect: "Steel fixing to grid 4-9 could not start on the programmed date.",
          entitlement: "NEC4 cl. 60.1(1) compensation event.",
          quantum: "Five days of prolongation at the site overhead rate.",
        },
        daysClaimed: 5,
      },
    });
    claimId = claim.json().id as string;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${claimId}/sufficiency`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      overallScore: number;
      limbs: { key: string; present: boolean }[];
      events: { logCoveragePercent: number; gaps: { from: string; days: number }[] }[];
      missingNotices: { reason: string }[];
    };
    expect(body.limbs.every((l) => l.present)).toBe(true);
    expect(body.events[0]!.logCoveragePercent).toBe(20); // one of five days logged
    expect(body.events[0]!.gaps[0]).toMatchObject({ from: "2026-06-02", days: 4 });
    expect(body.missingNotices[0]!.reason).toMatch(/no notice/i);
    expect(body.overallScore).toBeGreaterThan(0);
  });

  it("scopes the chronology to the claim rather than the whole project", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${claimId}/chronology`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      window: { from: string | null; to: string | null };
      items: { date: string; source: string; recordId: string }[];
      scope: { delayEvents: number };
    };
    expect(body.scope.delayEvents).toBe(1);
    expect(body.window.from).toBe("2026-05-02"); // 1 June minus the 30-day margin
    // January records belong to a different claim's story and must not appear.
    expect(body.items.every((i) => i.date >= body.window.from!)).toBe(true);
    expect(body.items.some((i) => i.source === "daily_log")).toBe(true);
    expect(body.items.every((i) => typeof i.recordId === "string")).toBe(true);
  });

  it("generates a Scott Schedule with the claimant columns filled and the rest empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${claimId}/scott-schedule`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rows: {
        item: number;
        reference: string;
        claimantContention: string;
        respondentResponse: string;
        tribunalFinding: string;
      }[];
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!.claimantContention).toMatch(/late design information/);
    expect(body.rows[0]!.respondentResponse).toBe("");
    expect(body.rows[0]!.tribunalFinding).toBe("");
  });

  it("assembles a submission package and reports what is still missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/claims/${claimId}/package`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      completeness: { ready: boolean; missing: string[] };
      chronology: unknown[] | null;
      scottSchedule: unknown[] | null;
    };
    expect(body.chronology).not.toBeNull();
    expect(body.scottSchedule).not.toBeNull();
    expect(body.completeness.ready).toBe(false);
    expect(body.completeness.missing.join(" ")).toMatch(/no delay analysis/);
  });
});

describe("forensics health inputs", () => {
  it("reports metrics and explains missing figures rather than reporting zeros", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/forensics/health-inputs`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { metrics: Record<string, number | null>; reasons: string[] };
    expect(body.metrics["liveDelayEvents"]).toBeGreaterThan(0);
    expect(body.metrics).toHaveProperty("eventsWithoutNotice");
    expect(Array.isArray(body.reasons)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Tenant isolation (production blocker: forensics had no coverage)    */
/* ------------------------------------------------------------------ */

describe("tenant isolation", () => {
  let outsider: TestActor;

  beforeAll(async () => {
    outsider = await registerActor(app);
  });

  it("another company cannot read delay events, claims or analyses", async () => {
    for (const url of [
      `/api/v1/projects/${projectId}/delay-events`,
      `/api/v1/projects/${projectId}/claims`,
      `/api/v1/projects/${projectId}/forensics/analyses`,
      `/api/v1/projects/${projectId}/forensics/quantum`,
      `/api/v1/projects/${projectId}/forensics/disruption`,
      `/api/v1/projects/${projectId}/forensics/float-rules`,
      `/api/v1/projects/${projectId}/forensics/health-inputs`,
      `/api/v1/projects/${projectId}/forensics/as-planned-vs-as-built`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: outsider.headers });
      expect([403, 404]).toContain(res.statusCode);
    }
  });

  it("another company cannot create or mutate forensic records", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/delay-events`,
      headers: outsider.headers,
      payload: {
        title: "Hijack",
        cause: "other",
        excusable: true,
        compensable: false,
        startDate: "2026-01-01",
        durationDays: 1,
      },
    });
    expect([403, 404]).toContain(create.statusCode);

    const claim = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims`,
      headers: outsider.headers,
      payload: { title: "Hijack", kind: "delay" },
    });
    expect([403, 404]).toContain(claim.statusCode);

    const analysis = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/forensics/analyses`,
      headers: outsider.headers,
      payload: { method: "longest_path", title: "Hijack", scheduleId },
    });
    expect([403, 404]).toContain(analysis.statusCode);

    const rules = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/forensics/float-rules`,
      headers: outsider.headers,
      payload: { ownership: "owner", concurrencyRule: "malmaison" },
    });
    expect([403, 404]).toContain(rules.statusCode);
  });

  it("a claim of one project is not reachable through another project of the same company", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project2Id}/claims/${claim1Id}`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("a delay event of one project is not reachable through another project", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project2Id}/delay-events/${ev1Id}`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("company-level claim exposure never leaks another tenant's claims", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/claims/exposure`,
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { totalClaims: number }).totalClaims).toBe(0);
  });
});


/* ------------------------------------------------------------------ */
/* Notice time bars — the sweep, the obligation and idempotence         */
/* ------------------------------------------------------------------ */

describe("notice time bars", () => {
  const iso = (offsetDays: number) =>
    new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

  // The notice sweep runs on project3 (no schedule, no BoQ), so it needs its
  // own contract event: contract events are project-scoped.
  let p3ContractEventId: string;

  beforeAll(async () => {
    const p3ContractId = newId("con");
    await app.db.insert(contracts).values({
      id: p3ContractId,
      companyId: owner.companyId,
      projectId: project3Id,
      name: "Bare Project Contract",
      form: "nec4_ecc",
      necOption: "A",
      createdBy: owner.userId,
    });
    p3ContractEventId = newId("cev");
    await app.db.insert(contractEvents).values({
      id: p3ContractEventId,
      companyId: owner.companyId,
      projectId: project3Id,
      contractId: p3ContractId,
      number: 1,
      kind: "early_warning",
      title: "Notice served",
      eventDate: "2026-02-01",
      noticeServedAt: "2026-02-02T09:00:00Z",
      raisedBy: owner.userId,
    });
  });

  async function createEvent(noticeDueDate: string | null): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project3Id}/delay-events`,
      headers: owner.headers,
      payload: {
        title: `Notice bar ${noticeDueDate ?? "none"} ${Math.random().toString(36).slice(2, 8)}`,
        cause: "client_change",
        excusable: true,
        compensable: true,
        startDate: "2026-02-01",
        durationDays: 4,
        ...(noticeDueDate ? { noticeDueDate } : {}),
      },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  async function sweep() {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project3Id}/forensics/notice-sweep`,
      headers: owner.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      scanned: number;
      obligationsOpened: number;
      obligationsClosed: number;
      dueSoon: number;
      missed: number;
      alerted: number;
      warnDays: number;
    };
  }

  async function eventRow(id: string) {
    const [row] = await app.db.select().from(delayEvents).where(eq(delayEvents.id, id)).limit(1);
    return row!;
  }

  it("opens exactly one obligation per notice deadline and never a second", async () => {
    const id = await createEvent(iso(20));
    const first = await sweep();
    expect(first.obligationsOpened).toBeGreaterThanOrEqual(1);

    const row = await eventRow(id);
    expect(row.noticeObligationId).toBeTruthy();
    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, row.noticeObligationId!))
      .limit(1);
    expect(obl!.status).toBe("open");
    expect(obl!.deadline?.slice(0, 10)).toBe(iso(20));

    // A second cycle over unchanged data must not manufacture another.
    const again = await sweep();
    const rowAgain = await eventRow(id);
    expect(rowAgain.noticeObligationId).toBe(row.noticeObligationId);
    expect(again.obligationsOpened).toBe(0);
  });

  it("raises one critical signal for a passed bar, breaches the obligation, and does not duplicate", async () => {
    const id = await createEvent(iso(-3));
    const first = await sweep();
    expect(first.missed).toBeGreaterThanOrEqual(1);
    expect(first.alerted).toBeGreaterThanOrEqual(1);

    const row = await eventRow(id);
    expect(row.noticeAlertedAt).toBeTruthy();
    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, row.noticeObligationId!))
      .limit(1);
    expect(obl!.status).toBe("breached");

    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.projectId, project3Id),
          eq(signals.detector, "forensics.notice_time_bar_missed"),
        ),
      );
    const mine = raised.filter(
      (sg) => (sg.evidenceRefs as { key?: string } | null)?.key === id,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.severity).toBe("critical");

    const second = await sweep();
    expect(second.alerted).toBe(0);
    const after = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.projectId, project3Id),
          eq(signals.detector, "forensics.notice_time_bar_missed"),
        ),
      );
    expect(after.filter((sg) => (sg.evidenceRefs as { key?: string } | null)?.key === id)).toHaveLength(1);
  });

  it("warns once for a bar inside the warning window without breaching the obligation", async () => {
    const id = await createEvent(iso(2));
    const res = await sweep();
    expect(res.dueSoon).toBeGreaterThanOrEqual(1);
    const row = await eventRow(id);
    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, row.noticeObligationId!))
      .limit(1);
    expect(obl!.status).toBe("open");
    const due = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.projectId, project3Id), eq(signals.detector, "forensics.notice_time_bar_due")),
      );
    expect(due.filter((sg) => (sg.evidenceRefs as { key?: string } | null)?.key === id)).toHaveLength(1);
  });

  it("satisfies the obligation once a notice is recorded against the event", async () => {
    const id = await createEvent(iso(10));
    await sweep();
    const before = await eventRow(id);
    expect(before.noticeObligationId).toBeTruthy();

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project3Id}/delay-events/${id}`,
      headers: owner.headers,
      payload: { contractEventId: p3ContractEventId },
    });
    expect(patch.statusCode).toBe(200);

    const res = await sweep();
    expect(res.obligationsClosed).toBeGreaterThanOrEqual(1);
    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, before.noticeObligationId!))
      .limit(1);
    expect(obl!.status).toBe("satisfied");
    expect(obl!.satisfiedEvidenceId).toBe(p3ContractEventId);
  });

  it("waives the obligation and opens a fresh one when the deadline moves", async () => {
    const id = await createEvent(iso(15));
    await sweep();
    const before = await eventRow(id);
    const originalObligation = before.noticeObligationId!;

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project3Id}/delay-events/${id}`,
      headers: owner.headers,
      payload: { noticeDueDate: iso(25) },
    });
    expect(patch.statusCode).toBe(200);

    const [waived] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, originalObligation))
      .limit(1);
    expect(waived!.status).toBe("waived");

    const cleared = await eventRow(id);
    expect(cleared.noticeObligationId).toBeNull();

    await sweep();
    const reopened = await eventRow(id);
    expect(reopened.noticeObligationId).toBeTruthy();
    expect(reopened.noticeObligationId).not.toBe(originalObligation);
    const [fresh] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, reopened.noticeObligationId!))
      .limit(1);
    expect(fresh!.deadline?.slice(0, 10)).toBe(iso(25));
  });

  it("waives the obligation when the event is withdrawn", async () => {
    const id = await createEvent(iso(12));
    await sweep();
    const before = await eventRow(id);

    const status = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project3Id}/delay-events/${id}/status`,
      headers: owner.headers,
      payload: { status: "withdrawn", reason: "Raised in error" },
    });
    expect(status.statusCode).toBe(200);

    await sweep();
    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, before.noticeObligationId!))
      .limit(1);
    expect(obl!.status).toBe("waived");
  });

  it("reports notice exposure through the health-inputs endpoint", async () => {
    await createEvent(iso(-1));
    await sweep();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project3Id}/forensics/health-inputs`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { metrics: Record<string, number | null>; reasons: string[] };
    expect(body.metrics["noticeTimeBarsMissed"]).toBeGreaterThanOrEqual(1);
    expect(body.reasons.some((r) => r.includes("notice time bar"))).toBe(true);
  });

  it("runs as a registered scheduler job", async () => {
    const status = await app.scheduler.runNow("forensics.notice-time-bars");
    expect(status.lastError ?? null).toBeNull();
  });

  it("another company cannot run the notice sweep on this project", async () => {
    const outsider = await registerActor(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project3Id}/forensics/notice-sweep`,
      headers: outsider.headers,
      payload: {},
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});


/* ------------------------------------------------------------------ */
/* Weather baseline linkage (delay event <-> site weather analysis)     */
/* ------------------------------------------------------------------ */

describe("weather baseline linkage", () => {
  let weatherEventId: string;
  let dryEventId: string;

  beforeAll(async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project2Id}/delay-events`,
      headers: owner.headers,
      payload: {
        title: "Exceptional rainfall, February",
        cause: "exceptional_weather",
        excusable: true,
        compensable: false,
        startDate: "2026-02-01",
        durationDays: 12,
      },
    });
    expect(res.statusCode).toBe(201);
    weatherEventId = (res.json() as { id: string }).id;

    const dry = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project2Id}/delay-events`,
      headers: owner.headers,
      payload: {
        title: "Late design release",
        cause: "client_change",
        excusable: true,
        compensable: true,
        startDate: "2026-03-01",
        durationDays: 5,
      },
    });
    dryEventId = (dry.json() as { id: string }).id;

    await app.db.insert(siteWeatherAnalyses).values({
      id: newId("swa"),
      companyId: owner.companyId,
      projectId: project2Id,
      number: 1,
      reference: "WX-001",
      baselineId: newId("swb"),
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
      status: "issued",
      daysInPeriod: 28,
      daysObserved: 26,
      observedAdverseDays: 14,
      baselineAdverseDays: 6,
      exceptionalDays: 8,
      hoursLost: 64,
      coveragePercent: 92.9,
      byMonth: [
        { month: "2026-02", days: 28, observed: 14, expected: 6, exceptional: 8, reasons: ["precipitation_mm > 10"] },
      ],
      reasons: [],
      delayEventId: weatherEventId,
      generatedBy: owner.userId,
    });
  });

  it("returns the issued weather analysis behind an exceptional-weather event", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project2Id}/delay-events/${weatherEventId}/weather`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      analyses: { reference: string; exceptionalDays: number | null }[];
      summary: { exceptionalDays: number | null; hoursLost: number | null; meanCoveragePercent: number | null };
      reasons: string[];
    };
    expect(body.analyses).toHaveLength(1);
    expect(body.analyses[0]!.reference).toBe("WX-001");
    expect(body.summary.exceptionalDays).toBe(8);
    expect(body.summary.hoursLost).toBe(64);
    expect(body.summary.meanCoveragePercent).toBe(92.9);
    expect(body.reasons).toHaveLength(0);
  });

  it("says exceptional days are not available rather than reporting zero", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project2Id}/delay-events/${dryEventId}/weather`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      analyses: unknown[];
      summary: { exceptionalDays: number | null };
      reasons: string[];
    };
    expect(body.analyses).toHaveLength(0);
    expect(body.summary.exceptionalDays).toBeNull();
    expect(body.reasons.length).toBeGreaterThan(0);
  });

  it("another company cannot read the weather evidence of this event", async () => {
    const outsider = await registerActor(app);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project2Id}/delay-events/${weatherEventId}/weather`,
      headers: outsider.headers,
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

/* ------------------------------------------------------------------ */
/* Company-wide search (contract §3.3)                                 */
/* ------------------------------------------------------------------ */

describe("company search covers delay events and claims", () => {
  let stranger: TestActor;
  let eventId: string;
  let claimId: string;

  beforeAll(async () => {
    stranger = await registerActor(app);
    const ev = await createDelayEvent(projectId, {
      title: "Unforeseen ground obstruction at pier 4",
      description: "Reinforced concrete obstruction found during piling",
      cause: "unforeseen_ground_conditions",
      excusable: true,
      compensable: true,
      startDate: "2026-05-04",
      durationDays: 6,
    });
    expect(ev.statusCode).toBe(201);
    eventId = ev.json().id;

    const claim = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims`,
      headers: owner.headers,
      payload: {
        title: "Pier 4 obstruction extension of time",
        kind: "delay",
        clauseRef: "Cl. 8.5(a)",
      },
    });
    expect(claim.statusCode).toBe(201);
    claimId = claim.json().id;
  });

  it("finds a delay event and links to its drawer", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/search?q=obstruction&types=delay_event",
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: string; href: string; status: string }[] };
    const hit = body.items.find((i) => i.id === eventId);
    expect(hit).toBeDefined();
    expect(hit!.href).toBe(`/projects/${projectId}/forensics?tab=events&id=${eventId}`);
    expect(hit!.status).toBe("open");
  });

  it("finds a claim and links to its drawer", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/search?q=pier%204&types=forensic_claim",
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: string; href: string; subtitle: string | null }[] };
    const hit = body.items.find((i) => i.id === claimId);
    expect(hit).toBeDefined();
    expect(hit!.href).toBe(`/projects/${projectId}/forensics?tab=claims&id=${claimId}`);
    expect(hit!.subtitle).toBe("Cl. 8.5(a)");
  });

  it("never returns another tenant's delay events or claims", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/search?q=obstruction%20pier&types=delay_event,forensic_claim",
      headers: stranger.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });
});
