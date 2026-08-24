import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  ledgerEntries,
  projects,
  scheduleBaselines,
  scheduleDependencies,
  scheduleTasks,
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
    expect(detail.summary.criticalCount).toBe(3); // A, B, D all critical now
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

    expect(q.checks["missingPredecessors"]).toMatchObject({ count: 2, pass: false });
    expect(q.checks["missingPredecessors"]!.ids.sort()).toEqual([h.id, o.id].sort());
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
    expect(q.passed).toBe(1);
    expect(q.total).toBe(10);
    expect(q.score).toBeCloseTo(0.1, 5);
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
