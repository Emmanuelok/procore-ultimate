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
  projects,
  rfis,
  scheduleBaselines,
  scheduleDependencies,
  scheduleTasks,
  schedules,
  variations,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let assessor: TestActor; // second user (company admin) for determination independence
let assessorHeaders: Record<string, string>;

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
    await app.db.insert(boqs).values({
      id: boqId,
      companyId: owner.companyId,
      projectId,
      name: "Main BQ",
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
    expect(body.sources).toEqual({
      prelimsTimeTotal: 1500,
      scheduleDurationDays: 15,
      scheduleId,
    });
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

    const agree = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${claim1Id}/status`,
      headers: owner.headers,
      payload: { status: "agreed" },
    });
    expect(agree.statusCode).toBe(200);

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
      payload: { chain: { cause: "Compensable delays", effect: "Site held 5 days" } },
    });
    expect(draftPatch.statusCode).toBe(200);

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims/${id}/status`,
      headers: owner.headers,
      payload: { status: "submitted" },
    });
    const frozenPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/claims/${id}`,
      headers: owner.headers,
      payload: { chain: { cause: "rewritten" } },
    });
    expect(frozenPatch.statusCode).toBe(400);

    const titlePatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/claims/${id}`,
      headers: owner.headers,
      payload: { title: "Prolongation claim (rev A)" },
    });
    expect(titlePatch.statusCode).toBe(200);

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
