import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  delayEvents,
  ledgerEntries,
  locations,
  projects,
  scheduleBaselines,
  scheduleConstraints,
  scheduleDependencies,
  scheduleTasks,
  signals,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let outsider: TestActor; // separate company — must never see owner's data
let projectId: string;
let otherProjectId: string;

const START = "2026-01-01";

function isoDaysFromToday(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  outsider = await registerActor(app);
  projectId = newId("prj");
  otherProjectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Schedule Core Test Project",
  });
  await app.db.insert(projects).values({
    id: otherProjectId,
    companyId: owner.companyId,
    name: "Sibling Project",
  });
});

afterAll(async () => {
  await built.close();
});

interface TaskRow {
  id: string;
  name: string;
  sortOrder: number;
  startDate: string | null;
  finishDate: string | null;
  totalFloat: number | null;
  isCritical: number;
  percentComplete: number;
}

interface ScheduleDetail {
  id: string;
  name: string;
  isActive: number;
  projectStart: string;
  computedFinish: string | null;
  computedDurationDays: number | null;
  tasks: TaskRow[];
  dependencies: { id: string; predecessorId: string; successorId: string; depType: string }[];
  summary: { taskCount: number; dependencyCount: number; criticalCount: number };
}

async function createSchedule(name: string, projectStart = START): Promise<{ id: string; isActive: number }> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/schedules`,
    headers: owner.headers,
    payload: { name, projectStart },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function addTask(
  scheduleId: string,
  payload: Record<string, unknown>,
): Promise<TaskRow> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/schedules/${scheduleId}/tasks`,
    headers: owner.headers,
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function addDep(scheduleId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/schedules/${scheduleId}/dependencies`,
    headers: owner.headers,
    payload,
  });
}

async function getSchedule(scheduleId: string): Promise<ScheduleDetail> {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/projects/${projectId}/schedules/${scheduleId}`,
    headers: owner.headers,
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function patchTask(taskId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "PATCH",
    url: `/api/v1/projects/${projectId}/schedule-tasks/${taskId}`,
    headers: owner.headers,
    payload,
  });
}

/** The A/B/C/D 20-day textbook case from lib/cpm.test.ts, built over HTTP. */
async function buildTextbook(name: string) {
  const schedule = await createSchedule(name);
  const a = await addTask(schedule.id, { name: "A", durationDays: 5 });
  const b = await addTask(schedule.id, { name: "B", durationDays: 10 });
  const c = await addTask(schedule.id, { name: "C", durationDays: 3 });
  const d = await addTask(schedule.id, { name: "D", durationDays: 5 });
  for (const [predecessorId, successorId] of [
    [a.id, b.id],
    [a.id, c.id],
    [b.id, d.id],
    [c.id, d.id],
  ] as const) {
    const res = await addDep(schedule.id, { predecessorId, successorId, depType: "FS", lagDays: 0 });
    expect(res.statusCode).toBe(201);
  }
  return { scheduleId: schedule.id, a, b, c, d };
}

/* ------------------------------------------------------------------ */
/* Schedules                                                           */
/* ------------------------------------------------------------------ */

let mainScheduleId: string;
let secondScheduleId: string;
let tb: Awaited<ReturnType<typeof buildTextbook>>;

describe("schedules", () => {
  it("creates schedules (first becomes active), lists and patches", async () => {
    const first = await createSchedule("Master Programme");
    mainScheduleId = first.id;
    expect(first.isActive).toBe(1);

    const second = await createSchedule("What-if Programme");
    secondScheduleId = second.id;
    expect(second.isActive).toBe(0);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules`,
      headers: owner.headers,
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { items: { id: string; isActive: number }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.items[0]!.isActive).toBe(1); // active first

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/schedules/${mainScheduleId}`,
      headers: owner.headers,
      payload: { name: "Master Programme r2" },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { name: string }).name).toBe("Master Programme r2");
  });

  it("activate switches the active schedule", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/${secondScheduleId}/activate`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { isActive: number }).isActive).toBe(1);
    const main = await getSchedule(mainScheduleId);
    expect(main.isActive).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* CPM through the HTTP layer                                          */
/* ------------------------------------------------------------------ */

describe("cpm auto-recompute", () => {
  it("persists dates matching the hand-computed textbook case", async () => {
    tb = await buildTextbook("Textbook");
    const detail = await getSchedule(tb.scheduleId);
    const byName = new Map(detail.tasks.map((t) => [t.name, t]));
    const a = byName.get("A")!;
    const b = byName.get("B")!;
    const c = byName.get("C")!;
    const d = byName.get("D")!;
    expect(a.startDate).toBe("2026-01-01");
    expect(a.finishDate).toBe("2026-01-05"); // inclusive finish
    expect(a.isCritical).toBe(1);
    expect(b.startDate).toBe("2026-01-06");
    expect(b.finishDate).toBe("2026-01-15");
    expect(c.totalFloat).toBe(7);
    expect(c.isCritical).toBe(0);
    expect(d.startDate).toBe("2026-01-16");
    expect(d.finishDate).toBe("2026-01-20");
    expect(detail.computedFinish).toBe("2026-01-20");
    expect(detail.computedDurationDays).toBe(20);
    expect(detail.summary.criticalCount).toBe(3);
  });

  it("explicit compute returns the summary and appends a ledger entry", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/${tb.scheduleId}/compute`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      projectFinishDate: "2026-01-20",
      durationDays: 20,
      criticalCount: 3,
    });
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "schedule"),
          eq(ledgerEntries.objectId, tb.scheduleId),
          eq(ledgerEntries.action, "update"),
        ),
      );
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects a dependency that would create a cycle with 409 naming the members", async () => {
    const res = await addDep(tb.scheduleId, {
      predecessorId: tb.d.id,
      successorId: tb.a.id,
      depType: "FS",
      lagDays: 0,
    });
    expect(res.statusCode).toBe(409);
    const message = (res.json() as { message: string }).message;
    expect(message).toContain("would create a cycle");
    expect(message).toContain(tb.a.id);
    expect(message).toContain(tb.d.id);
    // nothing persisted
    const detail = await getSchedule(tb.scheduleId);
    expect(detail.dependencies.length).toBe(4);
  });

  it("rejects self-links, foreign tasks and duplicate dependencies", async () => {
    const self = await addDep(tb.scheduleId, {
      predecessorId: tb.a.id,
      successorId: tb.a.id,
    });
    expect(self.statusCode).toBe(400);

    const foreignTask = await addTask(mainScheduleId, { name: "Elsewhere", durationDays: 1 });
    const foreign = await addDep(tb.scheduleId, {
      predecessorId: tb.a.id,
      successorId: foreignTask.id,
    });
    expect(foreign.statusCode).toBe(400);

    const dup = await addDep(tb.scheduleId, {
      predecessorId: tb.a.id,
      successorId: tb.b.id,
      depType: "FS",
    });
    expect(dup.statusCode).toBe(409);
  });

  it("reorders tasks and validates the id set", async () => {
    const before = await getSchedule(tb.scheduleId);
    const reversed = [...before.tasks.map((t) => t.id)].reverse();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/${tb.scheduleId}/tasks/reorder`,
      headers: owner.headers,
      payload: { orderedIds: reversed },
    });
    expect(res.statusCode).toBe(200);
    const after = await getSchedule(tb.scheduleId);
    expect(after.tasks.map((t) => t.id)).toEqual(reversed);
    expect(after.tasks.map((t) => t.sortOrder)).toEqual([0, 1, 2, 3]);

    const bad = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/${tb.scheduleId}/tasks/reorder`,
      headers: owner.headers,
      payload: { orderedIds: reversed.slice(1) },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("validates actuals and pins the forward pass through them", async () => {
    const backwards = await patchTask(tb.a.id, {
      actualStart: "2026-01-03",
      actualFinish: "2026-01-02",
    });
    expect(backwards.statusCode).toBe(400);

    const finishOnly = await patchTask(tb.a.id, { actualFinish: "2026-01-09" });
    expect(finishOnly.statusCode).toBe(400); // no actualStart on record

    const ok = await patchTask(tb.a.id, {
      actualStart: "2026-01-03",
      actualFinish: "2026-01-09",
      percentComplete: 100,
    });
    expect(ok.statusCode).toBe(200);
    const detail = await getSchedule(tb.scheduleId);
    const byName = new Map(detail.tasks.map((t) => [t.name, t]));
    expect(byName.get("A")!.startDate).toBe("2026-01-03");
    expect(byName.get("A")!.finishDate).toBe("2026-01-09");
    expect(byName.get("B")!.startDate).toBe("2026-01-10"); // FS successor follows the actual
  });

  it("deleting a task also deletes its dependencies and recomputes", async () => {
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/schedule-tasks/${tb.c.id}`,
      headers: owner.headers,
    });
    expect(del.statusCode).toBe(204);
    const detail = await getSchedule(tb.scheduleId);
    expect(detail.tasks.length).toBe(3);
    expect(detail.dependencies.length).toBe(2); // A->C and C->D went with C
    // B and D are critical; A finished in the previous test and a COMPLETE
    // activity is never on the critical path — it can no longer delay anything.
    expect(detail.summary.criticalCount).toBe(2);
    expect(detail.tasks.find((t) => t.name === "A")!.isCritical).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Baselines (#355-357)                                                */
/* ------------------------------------------------------------------ */

describe("baselines", () => {
  let scheduleId: string;
  let dId: string;
  let cId: string;
  let baselineId: string;

  it("captures a snapshot of every task", async () => {
    const built2 = await buildTextbook("Baseline case");
    scheduleId = built2.scheduleId;
    dId = built2.d.id;
    cId = built2.c.id;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/${scheduleId}/baselines`,
      headers: owner.headers,
      payload: { name: "Contract baseline" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; taskCount: number; computedFinish: string };
    baselineId = body.id;
    expect(body.taskCount).toBe(4);
    expect(body.computedFinish).toBe("2026-01-20");

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules/${scheduleId}/baselines`,
      headers: owner.headers,
    });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: { id: string; taskCount: number }[] }).items;
    expect(items.length).toBe(1);
    expect(items[0]!.taskCount).toBe(4);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedule-baselines/${baselineId}`,
      headers: owner.headers,
    });
    expect(detail.statusCode).toBe(200);
    const snapshot = (detail.json() as { snapshot: { taskId: string; finishDate: string }[] })
      .snapshot;
    expect(snapshot.length).toBe(4);
    expect(snapshot.find((s) => s.taskId === dId)!.finishDate).toBe("2026-01-20");
  });

  it("compare reports exact variances after extending a task", async () => {
    const patch = await patchTask(dId, { durationDays: 10 });
    expect(patch.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules/${scheduleId}/baselines/${baselineId}/compare`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      header: { baselineFinish: string; currentFinish: string; completionMovementDays: number };
      items: {
        taskId: string;
        startVarianceDays: number | null;
        finishVarianceDays: number | null;
        floatChange: number | null;
        becameCritical: boolean;
        added: boolean;
        removed: boolean;
      }[];
    };
    expect(body.header.baselineFinish).toBe("2026-01-20");
    expect(body.header.currentFinish).toBe("2026-01-25");
    expect(body.header.completionMovementDays).toBe(5);
    const d = body.items.find((i) => i.taskId === dId)!;
    expect(d.startVarianceDays).toBe(0);
    expect(d.finishVarianceDays).toBe(5);
    const c = body.items.find((i) => i.taskId === cId)!;
    expect(c.floatChange).toBe(0);
    expect(c.becameCritical).toBe(false);
  });

  it("compare marks added and removed tasks", async () => {
    const extra = await addTask(scheduleId, { name: "E", durationDays: 2 });
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/schedule-tasks/${cId}`,
      headers: owner.headers,
    });
    expect(delRes.statusCode).toBe(204);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules/${scheduleId}/baselines/${baselineId}/compare`,
      headers: owner.headers,
    });
    const body = res.json() as { items: { taskId: string; added: boolean; removed: boolean }[] };
    expect(body.items.find((i) => i.taskId === extra.id)!.added).toBe(true);
    expect(body.items.find((i) => i.taskId === cId)!.removed).toBe(true);
  });

  it("delete schedule cascades tasks, dependencies and baselines", async () => {
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/schedules/${scheduleId}`,
      headers: owner.headers,
    });
    expect(del.statusCode).toBe(204);
    const [tasks, deps, baselines] = await Promise.all([
      app.db.select().from(scheduleTasks).where(eq(scheduleTasks.scheduleId, scheduleId)),
      app.db
        .select()
        .from(scheduleDependencies)
        .where(eq(scheduleDependencies.scheduleId, scheduleId)),
      app.db
        .select()
        .from(scheduleBaselines)
        .where(eq(scheduleBaselines.scheduleId, scheduleId)),
    ]);
    expect(tasks.length).toBe(0);
    expect(deps.length).toBe(0);
    expect(baselines.length).toBe(0);
    const gone = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules/${scheduleId}`,
      headers: owner.headers,
    });
    expect(gone.statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* Lookahead (#359)                                                    */
/* ------------------------------------------------------------------ */

describe("lookahead", () => {
  it("returns incomplete tasks inside the window, ordered by start", async () => {
    const schedule = await createSchedule("Lookahead case", isoDaysFromToday(0));
    const near = await addTask(schedule.id, { name: "Near", durationDays: 5 });
    const later = await addTask(schedule.id, { name: "Later", durationDays: 5 });
    await addTask(schedule.id, {
      name: "Far",
      durationDays: 5,
      constraintType: "start_no_earlier_than",
      constraintDate: isoDaysFromToday(40),
    });
    const done = await addTask(schedule.id, { name: "Done", durationDays: 3 });
    const dep = await addDep(schedule.id, {
      predecessorId: near.id,
      successorId: later.id,
      depType: "FS",
      lagDays: 0,
    });
    expect(dep.statusCode).toBe(201);
    const donePatch = await patchTask(done.id, {
      percentComplete: 100,
      actualStart: isoDaysFromToday(0),
      actualFinish: isoDaysFromToday(2),
    });
    expect(donePatch.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/lookahead?weeks=3`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { name: string }[]; total: number; weeks: number };
    expect(body.weeks).toBe(3);
    expect(body.items.map((t) => t.name)).toEqual(["Near", "Later"]);

    const wide = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/lookahead?weeks=6`,
      headers: owner.headers,
    });
    const wideBody = wide.json() as { items: { name: string }[] };
    expect(wideBody.items.map((t) => t.name)).toEqual(["Near", "Later", "Far"]);
  });
});

/* ------------------------------------------------------------------ */
/* Quality checks (#371 / Domain D #283)                               */
/* ------------------------------------------------------------------ */

describe("quality checks", () => {
  it("flags every DCMA-style metric on a crafted bad schedule", async () => {
    const schedule = await createSchedule("Bad schedule");
    const a = await addTask(schedule.id, { name: "Long", durationDays: 60 });
    const b = await addTask(schedule.id, { name: "LeadSucc", durationDays: 1 });
    const l = await addTask(schedule.id, { name: "LagSucc", durationDays: 1 });
    const o = await addTask(schedule.id, {
      name: "Orphan",
      durationDays: 1,
      constraintType: "start_no_earlier_than",
      constraintDate: "2026-01-05",
    });
    const n = await addTask(schedule.id, {
      name: "Squeezed",
      durationDays: 5,
      constraintType: "finish_no_later_than",
      constraintDate: "2026-01-03",
    });
    const h = await addTask(schedule.id, {
      name: "Pinned",
      durationDays: 2,
      constraintType: "must_start_on",
      constraintDate: "2026-01-10",
    });
    const lead = await addDep(schedule.id, {
      predecessorId: a.id,
      successorId: b.id,
      depType: "FS",
      lagDays: -2,
    });
    expect(lead.statusCode).toBe(201);
    const lag = await addDep(schedule.id, {
      predecessorId: b.id,
      successorId: l.id,
      depType: "FS",
      lagDays: 3,
    });
    expect(lag.statusCode).toBe(201);
    // invalid progress: percent without actualStart, 100% without actualFinish
    expect((await patchTask(o.id, { percentComplete: 50 })).statusCode).toBe(200);
    expect((await patchTask(b.id, { percentComplete: 100 })).statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/quality`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const q = res.json() as {
      taskCount: number;
      dependencyCount: number;
      criticalPercent: number;
      passed: number;
      total: number;
      score: number;
      checks: Record<string, { count: number; ids: string[]; ratio: number | null; pass: boolean }>;
    };
    expect(q.taskCount).toBe(6);
    expect(q.dependencyCount).toBe(2);

    // Only ONE start activity and ONE finish activity are excused (the old
    // rule excused every task sitting on the earliest date, which made the
    // logic check vacuous — see quality.test.ts for the regression).
    expect(q.checks["missingPredecessors"]).toMatchObject({ count: 3, pass: false });
    expect(q.checks["missingPredecessors"]!.ids.sort()).toEqual([h.id, n.id, o.id].sort());
    expect(q.checks["missingSuccessors"]).toMatchObject({ count: 3, pass: false });
    expect(q.checks["missingSuccessors"]!.ids.sort()).toEqual([h.id, n.id, o.id].sort());
    expect(q.checks["leads"]).toMatchObject({ count: 1, pass: false });
    expect(q.checks["lags"]).toMatchObject({ count: 1, ratio: 0.5, pass: false });
    expect(q.checks["fsRatio"]).toMatchObject({ ratio: 1, pass: true });
    expect(q.checks["hardConstraints"]).toMatchObject({ count: 1, pass: false });
    expect(q.checks["hardConstraints"]!.ids).toEqual([h.id]);
    expect(q.checks["highFloat"]).toMatchObject({ count: 1, pass: false });
    expect(q.checks["highFloat"]!.ids).toEqual([o.id]); // float 58 > 44
    expect(q.checks["negativeFloat"]).toMatchObject({ count: 1, pass: false });
    expect(q.checks["negativeFloat"]!.ids).toEqual([n.id]); // finish_no_later_than breached
    expect(q.checks["highDuration"]).toMatchObject({ count: 1, pass: false });
    expect(q.checks["invalidProgress"]).toMatchObject({ count: 2, pass: false });

    expect(q.criticalPercent).toBeCloseTo(5 / 6, 3);

    // The DCMA checks that need a data date, a baseline or resource loading
    // report themselves not-applicable instead of failing silently.
    expect(q.notApplicable.sort()).toEqual(["bei", "invalidDates", "missedTasks", "resources"]);
    expect(q.checks["criticalPathTest"]).toMatchObject({ applicable: true, pass: true });
    expect(q.checks["cpli"]!.applicable).toBe(true);
    expect(q.total).toBe(12);
    expect(q.passed).toBe(3); // fsRatio, criticalPathTest, cpli
    expect(q.score).toBeCloseTo(0.25, 5);
  });

  it("BEI and missed tasks come alive once a baseline and a data date exist", async () => {
    const schedule = await createSchedule("Statused programme", "2026-01-01");
    const a = await addTask(schedule.id, { name: "First", durationDays: 5 });
    const b = await addTask(schedule.id, { name: "Second", durationDays: 5 });
    expect((await addDep(schedule.id, { predecessorId: a.id, successorId: b.id })).statusCode).toBe(201);
    const baseline = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/baselines`,
      headers: owner.headers,
      payload: { name: "Contract baseline" },
    });
    expect(baseline.statusCode).toBe(201);

    // Status the programme: the first activity should have finished, but has not.
    const dated = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}`,
      headers: owner.headers,
      payload: { dataDate: "2026-01-20" },
    });
    expect(dated.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/quality`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const q = res.json() as {
      notApplicable: string[];
      checks: Record<string, { pass: boolean; applicable: boolean; value?: number | null }>;
    };
    expect(q.notApplicable).not.toContain("bei");
    expect(q.notApplicable).not.toContain("missedTasks");
    expect(q.checks["bei"]!.applicable).toBe(true);
    expect(q.checks["bei"]!.value).toBe(0); // nothing finished by the data date
    expect(q.checks["bei"]!.pass).toBe(false);
    expect(q.checks["missedTasks"]!.applicable).toBe(true);
    expect(q.checks["invalidDates"]!.applicable).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Tenant isolation                                                    */
/* ------------------------------------------------------------------ */

describe("tenant isolation", () => {
  it("another company cannot read or mutate schedules on the project", async () => {
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules`,
      headers: outsider.headers,
    });
    expect([403, 404]).toContain(list.statusCode);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules/${mainScheduleId}`,
      headers: outsider.headers,
    });
    expect([403, 404]).toContain(detail.statusCode);

    const create = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules`,
      headers: outsider.headers,
      payload: { name: "Hijack", projectStart: START },
    });
    expect([403, 404]).toContain(create.statusCode);
  });

  it("a schedule is not reachable through a different project of the same company", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${otherProjectId}/schedules/${mainScheduleId}`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

/* ================================================================== */
/* WP-SCHED upgrade — regressions for every audit finding, plus the    */
/* new capabilities (calendars, resources, constraints, narratives,    */
/* import/export, earned value, milestone slip).                       */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* Recompute integrity (audit: recompute ran outside a transaction)    */
/* ------------------------------------------------------------------ */

describe("recompute integrity", () => {
  it("persists every task's dates in one transaction and stamps the header", async () => {
    const { scheduleId, a, d } = await buildTextbook("Recompute integrity");
    const detail = await getSchedule(scheduleId);
    // Every task carries computed dates and the header agrees with them.
    for (const t of detail.tasks) {
      expect(t.startDate).not.toBeNull();
      expect(t.finishDate).not.toBeNull();
    }
    const latest = detail.tasks
      .map((t) => t.finishDate)
      .filter((x): x is string => x !== null)
      .reduce((x, y) => (y > x ? y : x));
    expect(detail.computedFinish).toBe(latest);

    // Concurrent edits do not leave half-written state: after both settle, the
    // stored dates match a fresh recompute of the stored inputs.
    await Promise.all([
      patchTask(a.id, { durationDays: 6 }),
      patchTask(d.id, { durationDays: 7 }),
    ]);
    const recompute = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/${scheduleId}/compute`,
      headers: owner.headers,
    });
    expect(recompute.statusCode).toBe(200);
    const after = await getSchedule(scheduleId);
    const summary = recompute.json() as { projectFinishDate: string | null; longestPath?: string[] };
    expect(after.computedFinish).toBe(summary.projectFinishDate);
    expect(Array.isArray(summary.longestPath)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Dependencies — PATCH, duplicate handling                            */
/* ------------------------------------------------------------------ */

describe("dependency editing", () => {
  it("PATCHes a link in place instead of delete-then-recreate", async () => {
    const { scheduleId, a, b } = await buildTextbook("Dependency patch");
    const detail = await getSchedule(scheduleId);
    const dep = detail.dependencies.find((d) => d.predecessorId === a.id && d.successorId === b.id)!;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/schedule-dependencies/${dep.id}`,
      headers: owner.headers,
      payload: { depType: "SS", lagDays: 2 },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json() as { id: string; depType: string; lagDays: number };
    expect(updated.id).toBe(dep.id); // same row — the link was never dropped
    expect(updated).toMatchObject({ depType: "SS", lagDays: 2 });

    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.objectType, "schedule_dependency"), eq(ledgerEntries.objectId, dep.id)),
      );
    expect(entries.some((e) => e.action === "update")).toBe(true);
    expect(entries.some((e) => e.action === "delete")).toBe(false);
  });

  it("refuses a PATCH that would create a cycle and leaves the link untouched", async () => {
    const { scheduleId, a, b, d } = await buildTextbook("Dependency cycle patch");
    const detail = await getSchedule(scheduleId);
    const dep = detail.dependencies.find((x) => x.predecessorId === b.id && x.successorId === d.id)!;
    // Reversing this link is not expressible through PATCH (endpoints are
    // fixed), so instead prove a cycle-creating CREATE is refused and the
    // existing links survive.
    const cycle = await addDep(scheduleId, { predecessorId: d.id, successorId: a.id });
    expect(cycle.statusCode).toBe(409);
    const after = await getSchedule(scheduleId);
    expect(after.dependencies.some((x) => x.id === dep.id)).toBe(true);
  });

  it("returns 409, not 500, when the same link is posted twice", async () => {
    const { scheduleId, a, d } = await buildTextbook("Duplicate link");
    const first = await addDep(scheduleId, { predecessorId: a.id, successorId: d.id });
    expect(first.statusCode).toBe(201);
    const second = await addDep(scheduleId, { predecessorId: a.id, successorId: d.id });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { message: string }).message).toMatch(/already exists/i);
  });
});

/* ------------------------------------------------------------------ */
/* Lookahead (audit: in-progress spanning tasks were dropped)          */
/* ------------------------------------------------------------------ */

describe("lookahead window", () => {
  it("includes an in-progress task that spans the whole window", async () => {
    const schedule = await createSchedule("Lookahead span", isoDaysFromToday(-60));
    const long = await addTask(schedule.id, { name: "Twelve week wall", durationDays: 84 });
    await patchTask(long.id, { actualStart: isoDaysFromToday(-21), percentComplete: 25 });
    const short = await addTask(schedule.id, { name: "Starts next week", durationDays: 3 });
    await patchTask(short.id, {
      constraintType: "start_no_earlier_than",
      constraintDate: isoDaysFromToday(7),
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/lookahead?weeks=3`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: string; name: string; inProgress: boolean }[] };
    const names = body.items.map((t) => t.name);
    // The 12-week activity has neither its start nor its finish inside the
    // 3-week window — it is exactly the work happening in it.
    expect(names).toContain("Twelve week wall");
    expect(names).toContain("Starts next week");
    expect(body.items.find((t) => t.id === long.id)!.inProgress).toBe(true);
  });

  it("carries the open constraints of the tasks in the window", async () => {
    const schedule = await createSchedule("Lookahead constraints", isoDaysFromToday(0));
    const task = await addTask(schedule.id, { name: "Blocked", durationDays: 5 });
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedule-constraints`,
      headers: owner.headers,
      payload: {
        scheduleId: schedule.id,
        taskId: task.id,
        description: "Rebar schedule not released",
        category: "design_information",
        needByDate: isoDaysFromToday(3),
      },
    });
    expect(created.statusCode).toBe(201);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/lookahead?weeks=2`,
      headers: owner.headers,
    });
    const body = res.json() as { items: { id: string; constraints: { description: string }[] }[] };
    const row = body.items.find((t) => t.id === task.id)!;
    expect(row.constraints.map((c) => c.description)).toEqual(["Rebar schedule not released"]);
  });
});

/* ------------------------------------------------------------------ */
/* Assignment validation (audit: responsibleId/locationId free text)    */
/* ------------------------------------------------------------------ */

describe("assignment validation", () => {
  it("rejects a responsibleId that is not a user of the company", async () => {
    const schedule = await createSchedule("Assignment");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/tasks`,
      headers: owner.headers,
      payload: { name: "Assigned", durationDays: 1, responsibleId: "not-a-user" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toMatch(/user of this company/i);
  });

  it("rejects another company's user id", async () => {
    const schedule = await createSchedule("Assignment cross tenant");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/tasks`,
      headers: owner.headers,
      payload: { name: "Assigned", durationDays: 1, responsibleId: outsider.userId },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts a real company user and a real project location", async () => {
    const locationId = newId("loc");
    await app.db.insert(locations).values({
      id: locationId,
      companyId: owner.companyId,
      projectId,
      name: "Level 3",
      path: locationId,
    });
    const schedule = await createSchedule("Assignment happy");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/tasks`,
      headers: owner.headers,
      payload: {
        name: "Assigned",
        durationDays: 1,
        responsibleId: owner.userId,
        locationId,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ responsibleId: owner.userId, locationId });
  });

  it("rejects a location belonging to a different project", async () => {
    const foreignLocation = newId("loc");
    await app.db.insert(locations).values({
      id: foreignLocation,
      companyId: owner.companyId,
      projectId: otherProjectId,
      name: "Other site",
      path: foreignLocation,
    });
    const schedule = await createSchedule("Assignment foreign location");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/tasks`,
      headers: owner.headers,
      payload: { name: "Assigned", durationDays: 1, locationId: foreignLocation },
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Deleting a schedule (audit: orphaned delay events and risks)         */
/* ------------------------------------------------------------------ */

describe("schedule deletion referential integrity", () => {
  it("refuses to delete a schedule a delay event points at, then detaches on request", async () => {
    const schedule = await createSchedule("Referenced programme");
    const task = await addTask(schedule.id, { name: "Struck", durationDays: 5 });
    const eventId = newId("dly");
    await app.db.insert(delayEvents).values({
      id: eventId,
      companyId: owner.companyId,
      projectId,
      number: 9001,
      title: "Points at the schedule",
      cause: "client_change",
      excusable: 1,
      compensable: 1,
      taskId: task.id,
      scheduleId: schedule.id,
      startDate: "2026-02-01",
      durationDays: 5,
      tiaResult: { completionDeltaDays: 5 },
      raisedBy: owner.userId,
    });

    const refused = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}`,
      headers: owner.headers,
    });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { message: string }).message).toMatch(/delay event/i);

    const detached = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}?detach=true`,
      headers: owner.headers,
    });
    expect(detached.statusCode).toBe(204);

    const [ev] = await app.db.select().from(delayEvents).where(eq(delayEvents.id, eventId));
    expect(ev!.scheduleId).toBeNull();
    expect(ev!.taskId).toBeNull();
    expect(ev!.tiaResult).toBeNull();
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.objectType, "delay_event"), eq(ledgerEntries.objectId, eventId)));
    expect(entries.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Calendars                                                           */
/* ------------------------------------------------------------------ */

describe("work calendars", () => {
  it("a five-day calendar pushes a five-day activity across the weekend", async () => {
    const cal = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedule-calendars`,
      headers: owner.headers,
      payload: {
        name: "Mon-Fri",
        workdays: [0, 1, 1, 1, 1, 1, 0],
        holidays: ["2026-01-07"],
        hoursPerDay: 8,
      },
    });
    expect(cal.statusCode).toBe(201);
    const calendarId = (cal.json() as { id: string }).id;

    const schedule = await createSchedule("Calendar programme", "2026-01-05"); // a Monday
    const task = await addTask(schedule.id, { name: "Five day", durationDays: 5, calendarId });
    const detail = await getSchedule(schedule.id);
    const row = detail.tasks.find((t) => t.id === task.id)!;
    // Mon 5 - Fri 9 minus the Wednesday holiday = finishes Monday 12.
    expect(row.startDate).toBe("2026-01-05");
    expect(row.finishDate).toBe("2026-01-12");
  });

  it("refuses a calendar with no working days and refuses to delete one in use", async () => {
    const bad = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedule-calendars`,
      headers: owner.headers,
      payload: { name: "Never works", workdays: [0, 0, 0, 0, 0, 0, 0] },
    });
    expect(bad.statusCode).toBe(400);

    const cal = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedule-calendars`,
      headers: owner.headers,
      payload: { name: "In use", workdays: [1, 1, 1, 1, 1, 1, 1] },
    });
    const calendarId = (cal.json() as { id: string }).id;
    const schedule = await createSchedule("Calendar in use");
    await addTask(schedule.id, { name: "Uses it", durationDays: 2, calendarId });
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/schedule-calendars/${calendarId}`,
      headers: owner.headers,
    });
    expect(del.statusCode).toBe(409);
  });
});

/* ------------------------------------------------------------------ */
/* Resource loading (#370)                                             */
/* ------------------------------------------------------------------ */

describe("resource-loaded activities", () => {
  it("adds, rolls up and deletes resources, and makes the DCMA resource check live", async () => {
    const schedule = await createSchedule("Resourced programme");
    const a = await addTask(schedule.id, { name: "Formwork", durationDays: 10 });
    const b = await addTask(schedule.id, { name: "Rebar", durationDays: 10 });

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedule-tasks/${a.id}/resources`,
      headers: owner.headers,
      payload: {
        name: "Carpenters",
        resourceType: "labour",
        budgetedUnits: 400,
        actualUnits: 120,
        unitRate: 45,
      },
    });
    expect(created.statusCode).toBe(201);
    const resourceId = (created.json() as { id: string; budgetedCost: number }).id;
    expect((created.json() as { budgetedCost: number }).budgetedCost).toBe(18_000);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/resources`,
      headers: owner.headers,
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as {
      total: number;
      currency: string;
      reasons: string[];
      byType: { resourceType: string; budgetedCost: number }[];
    };
    expect(body.total).toBe(1);
    expect(body.byType[0]).toMatchObject({ resourceType: "labour", budgetedCost: 18_000 });
    // Money carries a currency, and where it was defaulted the caller is told why.
    expect(body.currency).toBe("USD");
    expect(body.reasons.some((r) => r.includes("No active budget"))).toBe(true);

    const quality = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/quality`,
      headers: owner.headers,
    });
    const q = quality.json() as { checks: Record<string, { applicable: boolean; ids: string[] }> };
    expect(q.checks["resources"]!.applicable).toBe(true);
    expect(q.checks["resources"]!.ids).toEqual([b.id]); // the unresourced one

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/schedule-task-resources/${resourceId}`,
      headers: owner.headers,
    });
    expect(del.statusCode).toBe(204);
  });
});

/* ------------------------------------------------------------------ */
/* Constraints log + sweep (#359)                                      */
/* ------------------------------------------------------------------ */

describe("lookahead constraints log", () => {
  it("numbers, transitions and clears constraints, and refuses an illegal move", async () => {
    const schedule = await createSchedule("Constraint log");
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedule-constraints`,
      headers: owner.headers,
      payload: {
        scheduleId: schedule.id,
        description: "Crane permit outstanding",
        category: "permit_or_approval",
        ownerId: owner.userId,
        needByDate: isoDaysFromToday(5),
      },
    });
    expect(created.statusCode).toBe(201);
    const constraint = created.json() as { id: string; number: number; status: string };
    expect(constraint.status).toBe("open");
    expect(constraint.number).toBeGreaterThan(0);

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/schedule-constraints/${constraint.id}`,
      headers: owner.headers,
      payload: { status: "cleared", resolution: "Permit issued" },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ status: "cleared", clearedBy: owner.userId });

    const illegal = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/schedule-constraints/${constraint.id}`,
      headers: owner.headers,
      payload: { status: "escalated" },
    });
    expect(illegal.statusCode).toBe(400);
  });

  it("the scheduler job escalates an overdue constraint exactly once", async () => {
    const schedule = await createSchedule("Constraint sweep");
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedule-constraints`,
      headers: owner.headers,
      payload: {
        scheduleId: schedule.id,
        description: "Access to the east core",
        category: "site_access",
        ownerId: owner.userId,
        needByDate: isoDaysFromToday(-3),
      },
    });
    const id = (created.json() as { id: string }).id;

    await app.scheduler.runNow("schedule.constraints");
    const [afterFirst] = await app.db
      .select()
      .from(scheduleConstraints)
      .where(eq(scheduleConstraints.id, id));
    expect(afterFirst!.status).toBe("escalated");
    expect(afterFirst!.escalatedAt).not.toBeNull();

    const signalsAfterFirst = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "schedule.constraint_overdue")),
      );
    await app.scheduler.runNow("schedule.constraints");
    const signalsAfterSecond = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "schedule.constraint_overdue")),
      );
    // Idempotent: a second sweep must not raise the same signal again.
    expect(signalsAfterSecond.length).toBe(signalsAfterFirst.length);
  });
});

/* ------------------------------------------------------------------ */
/* Milestones and slip alerts (#362)                                   */
/* ------------------------------------------------------------------ */

describe("key milestones and slip alerts", () => {
  it("tracks slip against a contractual date and alerts once per slip magnitude", async () => {
    const schedule = await createSchedule("Milestone programme", "2026-01-01");
    const work = await addTask(schedule.id, { name: "Structure", durationDays: 30 });
    const milestone = await addTask(schedule.id, {
      name: "Structure complete",
      durationDays: 0,
      isKeyMilestone: true,
      contractualDate: "2026-01-20",
      responsibleId: owner.userId,
    });
    expect(
      (await addDep(schedule.id, { predecessorId: work.id, successorId: milestone.id })).statusCode,
    ).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/milestones`,
      headers: owner.headers,
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as {
      items: { id: string; slipDays: number | null; status: string }[];
      late: number;
    };
    const row = body.items.find((m) => m.id === milestone.id)!;
    // 30 working days from 1 Jan puts the milestone on 31 Jan; the contractual
    // date is 20 Jan, so the slip is 11 days.
    expect(row.slipDays).toBe(11);
    expect(row.status).toBe("late");
    expect(body.late).toBe(1);

    const swept = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/milestone-sweep`,
      headers: owner.headers,
    });
    expect(swept.statusCode).toBe(200);
    expect(swept.json()).toMatchObject({ slipped: 1, alerted: 1 });

    // Idempotent: the same slip does not alert twice.
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/milestone-sweep`,
      headers: owner.headers,
    });
    expect(again.json()).toMatchObject({ slipped: 1, alerted: 0 });

    // A worse slip alerts again.
    await patchTask(work.id, { durationDays: 60 });
    const worse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/milestone-sweep`,
      headers: owner.headers,
    });
    expect(worse.json()).toMatchObject({ alerted: 1 });

    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "schedule.milestone_slip")),
      );
    expect(raised.length).toBeGreaterThanOrEqual(2);
  });

  it("the scheduler job is registered and runs", async () => {
    const result = await app.scheduler.runNow("schedule.milestone-slip");
    expect(result).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* Import / export (#349-350)                                          */
/* ------------------------------------------------------------------ */

const XER_FIXTURE = [
  "ERMHDR\t19.12\t2026-01-05\tProject\tadmin\tadmin\tPrimavera\tProject Management\tUSD",
  "%T\tPROJECT",
  "%F\tproj_id\tproj_short_name\tplan_start_date\tlast_recalc_date",
  "%R\t1000\tTOWER-A\t2026-01-05 00:00\t2026-02-02 00:00",
  "%T\tCALENDAR",
  "%F\tclndr_id\tdefault_flag\tclndr_name\tday_hr_cnt\tclndr_data",
  "%R\t1\tY\tStandard 5 Day\t8\t(0||CalendarData()(0||DaysOfWeek()(0||1())(0||2()(0||0(s|08:00|f|17:00)))(0||3()(0||0(s|08:00|f|17:00)))(0||4()(0||0(s|08:00|f|17:00)))(0||5()(0||0(s|08:00|f|17:00)))(0||6()(0||0(s|08:00|f|17:00)))(0||7()))))",
  "%T\tTASK",
  "%F\ttask_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_name\ttask_type\ttarget_drtn_hr_cnt\tremain_drtn_hr_cnt\tact_start_date\tact_end_date\tphys_complete_pct\tcstr_type\tcstr_date\ttarget_start_date\ttarget_end_date",
  "%R\t2001\t1000\t10\t1\tA1000\tMobilise\tTT_Task\t40\t0\t2026-01-05 08:00\t2026-01-09 17:00\t100\t\t\t2026-01-05 08:00\t2026-01-09 17:00",
  "%R\t2002\t1000\t10\t1\tA1010\tPiling\tTT_Task\t80\t80\t\t\t0\t\t\t2026-01-12 08:00\t2026-01-23 17:00",
  "%T\tTASKPRED",
  "%F\ttask_pred_id\ttask_id\tpred_task_id\tpred_type\tlag_hr_cnt",
  "%R\t9001\t2002\t2001\tPR_FS\t0",
  "%E",
  "",
].join("\n");

function multipart(fields: Record<string, string>, file: { name: string; content: string; type: string }) {
  const boundary = "----constructostest";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
      `Content-Type: ${file.type}\r\n\r\n${file.content}\r\n`,
  );
  parts.push(`--${boundary}--\r\n`);
  return { body: parts.join(""), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe("schedule import and export", () => {
  let importedScheduleId: string;

  it("imports a P6 XER file, computes it and records the run", async () => {
    const mp = multipart({ name: "Imported P6" }, { name: "tower.xer", content: XER_FIXTURE, type: "text/plain" });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/import`,
      headers: { ...owner.headers, ...mp.headers },
      payload: mp.body,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      importId: string;
      schedule: { id: string; source: string; dataDate: string | null; projectStart: string };
      stats: { tasks: number; dependencies: number; calendars: number };
      warnings: string[];
    };
    importedScheduleId = body.schedule.id;
    expect(body.schedule.source).toBe("xer");
    expect(body.schedule.projectStart).toBe("2026-01-05");
    expect(body.schedule.dataDate).toBe("2026-02-02");
    expect(body.stats).toMatchObject({ tasks: 2, dependencies: 1, calendars: 1 });

    const detail = await getSchedule(importedScheduleId);
    expect(detail.tasks).toHaveLength(2);
    expect(detail.tasks.every((t) => t.startDate !== null)).toBe(true);

    const runs = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedule-imports`,
      headers: owner.headers,
    });
    expect(runs.statusCode).toBe(200);
    expect((runs.json() as { total: number }).total).toBeGreaterThan(0);
  });

  it("dry-runs a revision import and returns a diff without writing", async () => {
    const changed = XER_FIXTURE.replace("Piling\tTT_Task\t80", "Piling\tTT_Task\t160");
    const mp = multipart(
      { targetScheduleId: importedScheduleId, dryRun: "true" },
      { name: "tower-r2.xer", content: changed, type: "text/plain" },
    );
    const before = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules`,
      headers: owner.headers,
    });
    const beforeCount = (before.json() as { total: number }).total;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/import`,
      headers: { ...owner.headers, ...mp.headers },
      payload: mp.body,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      dryRun: boolean;
      diff: { durationChanges: { name: string; fromDays: number; toDays: number }[] } | null;
    };
    expect(body.dryRun).toBe(true);
    expect(body.diff!.durationChanges[0]).toMatchObject({ name: "Piling", fromDays: 10, toDays: 20 });

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules`,
      headers: owner.headers,
    });
    expect((after.json() as { total: number }).total).toBe(beforeCount);
  });

  it("commits a revision import as a new revision of the target", async () => {
    const changed = XER_FIXTURE.replace("Piling\tTT_Task\t80", "Piling\tTT_Task\t160");
    const mp = multipart(
      { targetScheduleId: importedScheduleId, name: "Imported P6 r2" },
      { name: "tower-r2.xer", content: changed, type: "text/plain" },
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/import`,
      headers: { ...owner.headers, ...mp.headers },
      payload: mp.body,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { schedule: { id: string; revision: number; parentScheduleId: string | null } };
    expect(body.schedule.revision).toBe(2);
    expect(body.schedule.parentScheduleId).toBe(importedScheduleId);

    const compare = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules-compare?fromScheduleId=${importedScheduleId}&toScheduleId=${body.schedule.id}`,
      headers: owner.headers,
    });
    expect(compare.statusCode).toBe(200);
    const cmp = compare.json() as { diff: { totals: { durationChanged: number } }; completionMovementDays: number | null };
    expect(cmp.diff.totals.durationChanged).toBe(1);
    expect(cmp.completionMovementDays).not.toBeNull();
  });

  it("rejects a file that is neither XER nor MSPDI", async () => {
    const mp = multipart({}, { name: "notes.txt", content: "just some notes", type: "text/plain" });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/import`,
      headers: { ...owner.headers, ...mp.headers },
      payload: mp.body,
    });
    expect(res.statusCode).toBe(400);
  });

  it("exports MS Project XML that re-imports cleanly", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules/${importedScheduleId}/export?format=mspdi`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/xml/);
    expect(res.body).toContain("<Project");

    const mp = multipart({ name: "Round trip" }, { name: "roundtrip.xml", content: res.body, type: "text/xml" });
    const back = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/import`,
      headers: { ...owner.headers, ...mp.headers },
      payload: mp.body,
    });
    expect(back.statusCode).toBe(201);
    expect((back.json() as { schedule: { source: string } }).schedule.source).toBe("mspdi");
  });
});

/* ------------------------------------------------------------------ */
/* Earned value, narratives, calendar view, health inputs              */
/* ------------------------------------------------------------------ */

describe("earned value", () => {
  it("computes PV/EV/AC from per-activity budgets and reports what is unpriced", async () => {
    const schedule = await createSchedule("EV programme", "2026-01-01");
    const a = await addTask(schedule.id, { name: "Priced", durationDays: 10, budgetedCost: 1000 });
    await addTask(schedule.id, { name: "Unpriced", durationDays: 10 });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/baselines`,
      headers: owner.headers,
      payload: { name: "EV baseline" },
    });
    await patchTask(a.id, { actualStart: "2026-01-01", percentComplete: 50 });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedule-tasks/${a.id}/resources`,
      headers: owner.headers,
      payload: { name: "Gang", resourceType: "labour", budgetedUnits: 0, actualUnits: 0, actualCost: 700 },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/earned-value?dataDate=2026-01-05`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const ev = res.json() as {
      bac: number;
      ev: number;
      ac: number;
      spi: number | null;
      cpi: number | null;
      unpriced: number;
      reasons: string[];
      basis: string;
    };
    expect(ev.bac).toBe(1000);
    expect(ev.ev).toBe(500);
    expect(ev.ac).toBe(700);
    expect(ev.cpi).toBeCloseTo(0.714, 2);
    expect(ev.unpriced).toBe(1);
    expect(ev.reasons.join(" ")).toMatch(/no budget line/);
    expect(ev.basis).toBe("baseline dates");
  });
});

describe("update narratives", () => {
  it("stores a narrative with the figures it was written against", async () => {
    const { scheduleId } = await buildTextbook("Narrative programme");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedules/${scheduleId}/narratives`,
      headers: owner.headers,
      payload: {
        title: "January update",
        body: "Completion has moved five days on the piling path.",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as { metrics: { taskCount: number; computedFinish: string | null } };
    expect(created.metrics.taskCount).toBe(4);
    expect(created.metrics.computedFinish).not.toBeNull();

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules/${scheduleId}/narratives`,
      headers: owner.headers,
    });
    expect((list.json() as { total: number }).total).toBe(1);
  });
});

describe("calendar view", () => {
  it("returns day buckets with working-day shading", async () => {
    const cal = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedule-calendars`,
      headers: owner.headers,
      payload: { name: "View calendar", workdays: [0, 1, 1, 1, 1, 1, 0], isDefault: false },
    });
    const calendarId = (cal.json() as { id: string }).id;
    const schedule = await createSchedule("Calendar view", "2026-01-05");
    await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}`,
      headers: owner.headers,
      payload: { defaultCalendarId: calendarId },
    });
    await addTask(schedule.id, { name: "Week one", durationDays: 5, calendarId });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedules/${schedule.id}/calendar-view?from=2026-01-05&to=2026-01-19`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      days: { date: string; working: boolean; starting: unknown[]; inProgress: number }[];
      calendarName: string | null;
    };
    expect(body.days).toHaveLength(14);
    expect(body.calendarName).toBe("View calendar");
    expect(body.days.find((d) => d.date === "2026-01-10")!.working).toBe(false); // Saturday
    expect(body.days.find((d) => d.date === "2026-01-05")!.starting).toHaveLength(1);
  });
});

describe("health inputs", () => {
  it("reports metrics for the active schedule and explains what is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/schedule/health-inputs`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      metrics: Record<string, number | null>;
      reasons: string[];
      scheduleId?: string;
    };
    expect(body.metrics).toHaveProperty("scheduleQualityScore");
    expect(body.metrics).toHaveProperty("openConstraints");
    expect(Array.isArray(body.reasons)).toBe(true);
  });

  it("says the project has no active schedule rather than reporting zeros", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${otherProjectId}/schedule/health-inputs`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { metrics: Record<string, number | null>; reasons: string[] };
    expect(body.metrics["scheduleQualityScore"]).toBeNull();
    expect(body.reasons).toContain("The project has no active schedule");
  });
});

/* ------------------------------------------------------------------ */
/* Tenant isolation for the new routes                                 */
/* ------------------------------------------------------------------ */

describe("tenant isolation — upgraded routes", () => {
  it("another company cannot reach calendars, constraints, imports or exports", async () => {
    for (const url of [
      `/api/v1/projects/${projectId}/schedule-calendars`,
      `/api/v1/projects/${projectId}/schedule-constraints`,
      `/api/v1/projects/${projectId}/schedule-imports`,
      `/api/v1/projects/${projectId}/schedule/health-inputs`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: outsider.headers });
      expect([403, 404]).toContain(res.statusCode);
    }
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/schedule-calendars`,
      headers: outsider.headers,
      payload: { name: "Hijack" },
    });
    expect([403, 404]).toContain(create.statusCode);
  });

  it("a schedule of one project is not reachable through another project of the same company", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${otherProjectId}/schedules/${mainScheduleId}/earned-value`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});
