import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { scheduleBaselines, scheduleDependencies, scheduleTasks, schedules } from "@constructos/db";
import {
  DEPENDENCY_TYPES,
  TASK_CONSTRAINT_TYPES,
  type DependencyType,
  type TaskConstraintType,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { addDaysISO, isoDateSchema, todayISO } from "../field/dates.js";
import { computeCpm, type CpmDependencyInput, type CpmTaskInput } from "../../lib/cpm.js";
import { assessScheduleQuality } from "./quality.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const scheduleCreateSchema = z.object({
  name: z.string().min(1).max(300),
  projectStart: isoDateSchema,
});

const schedulePatchSchema = scheduleCreateSchema.partial();

const taskCreateSchema = z.object({
  name: z.string().min(1).max(300),
  durationDays: z.number().int().min(0).max(10000),
  wbsCode: z.string().max(60).nullable().optional(),
  constraintType: z.enum(TASK_CONSTRAINT_TYPES).nullable().optional(),
  constraintDate: isoDateSchema.nullable().optional(),
  responsibleId: z.string().max(100).nullable().optional(),
  locationId: z.string().max(100).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

const taskPatchSchema = taskCreateSchema.partial().extend({
  percentComplete: z.number().min(0).max(100).optional(),
  actualStart: isoDateSchema.nullable().optional(),
  actualFinish: isoDateSchema.nullable().optional(),
});

const reorderSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1).max(5000),
});

const dependencyCreateSchema = z.object({
  predecessorId: z.string().min(1),
  successorId: z.string().min(1),
  depType: z.enum(DEPENDENCY_TYPES).default("FS"),
  lagDays: z.number().int().min(-3650).max(3650).default(0),
});

const baselineCreateSchema = z.object({
  name: z.string().min(1).max(300),
});

const lookaheadQuerySchema = z.object({
  weeks: z.coerce.number().int().min(1).max(26).default(3),
});

/** Immutable per-task record inside a baseline snapshot (#355). */
interface BaselineTaskRow {
  taskId: string;
  name: string;
  wbsCode: string | null;
  durationDays: number;
  startDate: string | null;
  finishDate: string | null;
  totalFloat: number | null;
  isCritical: boolean;
}

/** Whole days between two ISO dates (a - b). */
function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

interface ComputeSummary {
  projectFinishDate: string | null;
  durationDays: number;
  criticalCount: number;
  cycle?: string[];
}

/**
 * Native schedule core — spec Vol I §2.6 subset (#351 creation/editing,
 * #353 critical path, #354 typed dependencies with lag, #355-357 baselines &
 * comparison, #358/#361 progress, #359 lookahead, #360 assignment) plus the
 * DCMA-style health check (#371 / Domain D #283). CPM results are persisted
 * after every task/dependency mutation so stored dates are never stale; the
 * CPM engine itself is pure (lib/cpm.ts).
 */
export const scheduleModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("schedule", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("schedule", "standard"),
  ];

  /* ---------------------------------------------------------------- */
  /* Scoped fetch helpers                                              */
  /* ---------------------------------------------------------------- */

  async function fetchSchedule(scheduleId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.id, scheduleId),
          eq(schedules.companyId, companyId),
          eq(schedules.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Schedule not found");
    return rows[0];
  }

  /** Fetch a task and its (tenant-verified) schedule. */
  async function fetchTask(taskId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(scheduleTasks)
      .where(and(eq(scheduleTasks.id, taskId), eq(scheduleTasks.projectId, projectId)))
      .limit(1);
    if (!rows[0]) throw notFound("Schedule task not found");
    const schedule = await fetchSchedule(rows[0].scheduleId, companyId, projectId);
    return { task: rows[0], schedule };
  }

  async function listTasks(scheduleId: string) {
    return app.db
      .select()
      .from(scheduleTasks)
      .where(eq(scheduleTasks.scheduleId, scheduleId))
      .orderBy(asc(scheduleTasks.sortOrder), asc(scheduleTasks.createdAt), asc(scheduleTasks.id));
  }

  async function listDependencies(scheduleId: string) {
    return app.db
      .select()
      .from(scheduleDependencies)
      .where(eq(scheduleDependencies.scheduleId, scheduleId));
  }

  function toCpmTasks(tasks: Awaited<ReturnType<typeof listTasks>>): CpmTaskInput[] {
    return tasks.map((t) => ({
      id: t.id,
      duration: t.durationDays,
      constraintType: (t.constraintType as TaskConstraintType | null) ?? null,
      constraintDate: t.constraintDate,
      actualStart: t.actualStart,
      actualFinish: t.actualFinish,
    }));
  }

  function toCpmDeps(deps: Awaited<ReturnType<typeof listDependencies>>): CpmDependencyInput[] {
    return deps.map((d) => ({
      predecessorId: d.predecessorId,
      successorId: d.successorId,
      type: d.depType as DependencyType,
      lagDays: d.lagDays,
    }));
  }

  /**
   * Single recompute code path: run the CPM engine over the schedule's tasks
   * and dependencies, persist per-task dates/float/criticality and the
   * schedule header. Called after every task/dependency mutation and by the
   * explicit compute endpoint — persisted dates are never stale.
   */
  async function recomputeSchedule(schedule: {
    id: string;
    projectStart: string;
  }): Promise<ComputeSummary> {
    const tasks = await listTasks(schedule.id);
    const deps = await listDependencies(schedule.id);
    const result = computeCpm(toCpmTasks(tasks), toCpmDeps(deps), {
      projectStart: schedule.projectStart,
    });
    const now = new Date().toISOString();
    if (!result.ok) {
      // A cycle aborts the pass; existing dates are left as-is and reported.
      return { projectFinishDate: null, durationDays: 0, criticalCount: 0, cycle: result.cycle };
    }
    for (const t of tasks) {
      const r = result.tasks.get(t.id);
      if (!r) continue;
      const critical = r.isCritical ? 1 : 0;
      if (
        t.startDate !== r.startDate ||
        t.finishDate !== r.finishDate ||
        t.totalFloat !== r.totalFloat ||
        t.isCritical !== critical
      ) {
        await app.db
          .update(scheduleTasks)
          .set({
            startDate: r.startDate,
            finishDate: r.finishDate,
            totalFloat: r.totalFloat,
            isCritical: critical,
            updatedAt: now,
          })
          .where(eq(scheduleTasks.id, t.id));
      }
    }
    const computedFinish = tasks.length > 0 ? result.projectFinishDate : null;
    const computedDurationDays = tasks.length > 0 ? result.projectDurationDays : 0;
    await app.db
      .update(schedules)
      .set({ computedFinish, computedDurationDays, lastComputedAt: now, updatedAt: now })
      .where(eq(schedules.id, schedule.id));
    return {
      projectFinishDate: computedFinish,
      durationDays: computedDurationDays,
      criticalCount: result.criticalIds.length,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Schedules (#351)                                                  */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/schedules", { preHandler: standardGate }, async (req, reply) => {
    const body = scheduleCreateSchema.parse(req.body);
    const [existing] = await app.db
      .select({ n: count() })
      .from(schedules)
      .where(
        and(eq(schedules.companyId, req.companyId!), eq(schedules.projectId, req.projectId!)),
      );
    const isActive = Number(existing?.n ?? 0) === 0 ? 1 : 0; // the first schedule becomes active
    const id = newId("sch");
    await app.db.insert(schedules).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      name: body.name,
      projectStart: body.projectStart,
      isActive,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "schedule",
      objectId: id,
      payload: { name: body.name, projectStart: body.projectStart, isActive: isActive === 1 },
    });
    const created = await fetchSchedule(id, req.companyId!, req.projectId!);
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/schedules", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = and(
      eq(schedules.companyId, req.companyId!),
      eq(schedules.projectId, req.projectId!),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(schedules).where(where);
    const items = await app.db
      .select()
      .from(schedules)
      .where(where)
      .orderBy(desc(schedules.isActive), asc(schedules.createdAt), asc(schedules.id))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/schedules/:scheduleId", { preHandler: readGate }, async (req) => {
    const { scheduleId } = req.params as { scheduleId: string };
    const schedule = await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
    const tasks = await listTasks(scheduleId);
    const dependencies = await listDependencies(scheduleId);
    return {
      ...schedule,
      tasks,
      dependencies,
      summary: {
        taskCount: tasks.length,
        dependencyCount: dependencies.length,
        criticalCount: tasks.filter((t) => t.isCritical === 1).length,
        computedFinish: schedule.computedFinish,
        computedDurationDays: schedule.computedDurationDays,
        lastComputedAt: schedule.lastComputedAt,
      },
    };
  });

  app.patch(
    "/projects/:projectId/schedules/:scheduleId",
    { preHandler: standardGate },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const body = schedulePatchSchema.parse(req.body);
      const schedule = await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      if (body.name !== undefined) set["name"] = body.name;
      if (body.projectStart !== undefined) set["projectStart"] = body.projectStart;
      await app.db.update(schedules).set(set).where(eq(schedules.id, scheduleId));
      // Moving day 0 moves every computed date — recompute on the same path.
      if (body.projectStart !== undefined && body.projectStart !== schedule.projectStart) {
        await recomputeSchedule({ id: scheduleId, projectStart: body.projectStart });
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "schedule",
        objectId: scheduleId,
        payload: { changed: Object.keys(body) },
      });
      return fetchSchedule(scheduleId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/schedules/:scheduleId/activate",
    { preHandler: standardGate },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const schedule = await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      const now = new Date().toISOString();
      await app.db.transaction(async (tx) => {
        await tx
          .update(schedules)
          .set({ isActive: 0, updatedAt: now })
          .where(
            and(
              eq(schedules.companyId, req.companyId!),
              eq(schedules.projectId, req.projectId!),
              eq(schedules.isActive, 1),
            ),
          );
        await tx
          .update(schedules)
          .set({ isActive: 1, updatedAt: now })
          .where(eq(schedules.id, scheduleId));
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "schedule",
        objectId: scheduleId,
        payload: { name: schedule.name, isActive: true },
      });
      return fetchSchedule(scheduleId, req.companyId!, req.projectId!);
    },
  );

  app.delete(
    "/projects/:projectId/schedules/:scheduleId",
    { preHandler: standardGate },
    async (req, reply) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const schedule = await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      const tasks = await listTasks(scheduleId);
      await app.db.transaction(async (tx) => {
        await tx
          .delete(scheduleDependencies)
          .where(eq(scheduleDependencies.scheduleId, scheduleId));
        await tx.delete(scheduleBaselines).where(eq(scheduleBaselines.scheduleId, scheduleId));
        await tx.delete(scheduleTasks).where(eq(scheduleTasks.scheduleId, scheduleId));
        await tx.delete(schedules).where(eq(schedules.id, scheduleId));
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "schedule",
        objectId: scheduleId,
        payload: { name: schedule.name, taskCount: tasks.length },
      });
      return reply.status(204).send();
    },
  );

  /* ---------------------------------------------------------------- */
  /* Tasks (#351, #358, #360, #361)                                    */
  /* ---------------------------------------------------------------- */

  /** Constraint types that are meaningless without a date. */
  const DATED_CONSTRAINTS: readonly string[] = [
    "start_no_earlier_than",
    "finish_no_later_than",
    "must_start_on",
  ];

  function validateConstraint(
    constraintType: string | null | undefined,
    constraintDate: string | null | undefined,
  ): void {
    if (constraintType && DATED_CONSTRAINTS.includes(constraintType) && !constraintDate) {
      throw badRequest(`constraintDate is required for constraintType "${constraintType}"`);
    }
  }

  app.post(
    "/projects/:projectId/schedules/:scheduleId/tasks",
    { preHandler: standardGate },
    async (req, reply) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const body = taskCreateSchema.parse(req.body);
      const schedule = await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      validateConstraint(body.constraintType, body.constraintDate);
      let sortOrder = body.sortOrder;
      if (sortOrder === undefined) {
        const existing = await listTasks(scheduleId);
        sortOrder = existing.reduce((max, t) => Math.max(max, t.sortOrder + 1), 0);
      }
      const id = newId("tsk");
      await app.db.insert(scheduleTasks).values({
        id,
        scheduleId,
        projectId: req.projectId!,
        name: body.name,
        wbsCode: body.wbsCode ?? null,
        durationDays: body.durationDays,
        constraintType: body.constraintType ?? null,
        constraintDate: body.constraintDate ?? null,
        responsibleId: body.responsibleId ?? null,
        locationId: body.locationId ?? null,
        sortOrder,
      });
      await recomputeSchedule(schedule);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "schedule_task",
        objectId: id,
        payload: { scheduleId, name: body.name, durationDays: body.durationDays },
      });
      const { task } = await fetchTask(id, req.companyId!, req.projectId!);
      return reply.status(201).send(task);
    },
  );

  app.patch(
    "/projects/:projectId/schedule-tasks/:taskId",
    { preHandler: standardGate },
    async (req) => {
      const { taskId } = req.params as { taskId: string };
      const body = taskPatchSchema.parse(req.body);
      const { task, schedule } = await fetchTask(taskId, req.companyId!, req.projectId!);

      const nextConstraintType =
        body.constraintType !== undefined ? body.constraintType : task.constraintType;
      const nextConstraintDate =
        body.constraintDate !== undefined ? body.constraintDate : task.constraintDate;
      validateConstraint(nextConstraintType, nextConstraintDate);

      const nextActualStart = body.actualStart !== undefined ? body.actualStart : task.actualStart;
      const nextActualFinish =
        body.actualFinish !== undefined ? body.actualFinish : task.actualFinish;
      if (nextActualStart && nextActualFinish && nextActualFinish < nextActualStart) {
        throw badRequest("actualFinish must be on or after actualStart");
      }
      if (nextActualFinish && !nextActualStart) {
        throw badRequest("actualFinish requires actualStart");
      }

      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined) set[k] = v;
      }
      await app.db.update(scheduleTasks).set(set).where(eq(scheduleTasks.id, taskId));
      await recomputeSchedule(schedule);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "schedule_task",
        objectId: taskId,
        payload: { scheduleId: schedule.id, changed: Object.keys(body) },
      });
      const { task: updated } = await fetchTask(taskId, req.companyId!, req.projectId!);
      return updated;
    },
  );

  app.delete(
    "/projects/:projectId/schedule-tasks/:taskId",
    { preHandler: standardGate },
    async (req, reply) => {
      const { taskId } = req.params as { taskId: string };
      const { task, schedule } = await fetchTask(taskId, req.companyId!, req.projectId!);
      await app.db.transaction(async (tx) => {
        await tx
          .delete(scheduleDependencies)
          .where(
            and(
              eq(scheduleDependencies.scheduleId, schedule.id),
              or(
                eq(scheduleDependencies.predecessorId, taskId),
                eq(scheduleDependencies.successorId, taskId),
              ),
            ),
          );
        await tx.delete(scheduleTasks).where(eq(scheduleTasks.id, taskId));
      });
      await recomputeSchedule(schedule);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "schedule_task",
        objectId: taskId,
        payload: { scheduleId: schedule.id, name: task.name },
      });
      return reply.status(204).send();
    },
  );

  app.post(
    "/projects/:projectId/schedules/:scheduleId/tasks/reorder",
    { preHandler: standardGate },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const body = reorderSchema.parse(req.body);
      await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      const tasks = await listTasks(scheduleId);
      const currentIds = new Set(tasks.map((t) => t.id));
      const orderedSet = new Set(body.orderedIds);
      if (
        orderedSet.size !== body.orderedIds.length ||
        orderedSet.size !== currentIds.size ||
        body.orderedIds.some((id) => !currentIds.has(id))
      ) {
        throw badRequest("orderedIds must contain every task of the schedule exactly once");
      }
      const now = new Date().toISOString();
      const byId = new Map(tasks.map((t) => [t.id, t] as const));
      for (let i = 0; i < body.orderedIds.length; i += 1) {
        const id = body.orderedIds[i]!;
        if (byId.get(id)!.sortOrder !== i) {
          await app.db
            .update(scheduleTasks)
            .set({ sortOrder: i, updatedAt: now })
            .where(eq(scheduleTasks.id, id));
        }
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "schedule",
        objectId: scheduleId,
        payload: { reordered: body.orderedIds.length },
      });
      return { items: await listTasks(scheduleId) };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Dependencies (#354)                                               */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/schedules/:scheduleId/dependencies",
    { preHandler: standardGate },
    async (req, reply) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const body = dependencyCreateSchema.parse(req.body);
      if (body.predecessorId === body.successorId) {
        throw badRequest("A task cannot depend on itself");
      }
      const schedule = await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      const tasks = await listTasks(scheduleId);
      const taskIds = new Set(tasks.map((t) => t.id));
      if (!taskIds.has(body.predecessorId) || !taskIds.has(body.successorId)) {
        throw badRequest("predecessorId and successorId must be tasks of this schedule");
      }
      const deps = await listDependencies(scheduleId);
      if (
        deps.some(
          (d) =>
            d.predecessorId === body.predecessorId &&
            d.successorId === body.successorId &&
            d.depType === body.depType,
        )
      ) {
        throw conflict("This dependency already exists");
      }

      // Cycle guard: run the CPM engine over existing + candidate BEFORE the
      // insert — a link that cannot schedule is never persisted.
      const trial = computeCpm(
        toCpmTasks(tasks),
        [
          ...toCpmDeps(deps),
          {
            predecessorId: body.predecessorId,
            successorId: body.successorId,
            type: body.depType,
            lagDays: body.lagDays,
          },
        ],
        { projectStart: schedule.projectStart },
      );
      if (!trial.ok) {
        throw conflict(`would create a cycle: ${trial.cycle.join(", ")}`);
      }

      const id = newId("dep");
      await app.db.insert(scheduleDependencies).values({
        id,
        scheduleId,
        predecessorId: body.predecessorId,
        successorId: body.successorId,
        depType: body.depType,
        lagDays: body.lagDays,
      });
      await recomputeSchedule(schedule);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "schedule_dependency",
        objectId: id,
        payload: {
          scheduleId,
          predecessorId: body.predecessorId,
          successorId: body.successorId,
          depType: body.depType,
          lagDays: body.lagDays,
        },
      });
      const [created] = await app.db
        .select()
        .from(scheduleDependencies)
        .where(eq(scheduleDependencies.id, id))
        .limit(1);
      return reply.status(201).send(created);
    },
  );

  app.delete(
    "/projects/:projectId/schedule-dependencies/:depId",
    { preHandler: standardGate },
    async (req, reply) => {
      const { depId } = req.params as { depId: string };
      const rows = await app.db
        .select()
        .from(scheduleDependencies)
        .where(eq(scheduleDependencies.id, depId))
        .limit(1);
      if (!rows[0]) throw notFound("Schedule dependency not found");
      // tenant/project verification via the owning schedule
      const schedule = await fetchSchedule(rows[0].scheduleId, req.companyId!, req.projectId!);
      await app.db.delete(scheduleDependencies).where(eq(scheduleDependencies.id, depId));
      await recomputeSchedule(schedule);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "schedule_dependency",
        objectId: depId,
        payload: {
          scheduleId: schedule.id,
          predecessorId: rows[0].predecessorId,
          successorId: rows[0].successorId,
          depType: rows[0].depType,
        },
      });
      return reply.status(204).send();
    },
  );

  /* ---------------------------------------------------------------- */
  /* Explicit recompute (#353)                                         */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/schedules/:scheduleId/compute",
    { preHandler: standardGate },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const schedule = await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      const summary = await recomputeSchedule(schedule);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "schedule",
        objectId: scheduleId,
        payload: { computed: summary },
      });
      return summary;
    },
  );

  /* ---------------------------------------------------------------- */
  /* Baselines (#355-357)                                              */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/schedules/:scheduleId/baselines",
    { preHandler: standardGate },
    async (req, reply) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const body = baselineCreateSchema.parse(req.body);
      const schedule = await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      // Snapshot the freshest possible picture (#355).
      const summary = await recomputeSchedule(schedule);
      if (summary.cycle) {
        throw conflict(`schedule has a dependency cycle: ${summary.cycle.join(", ")}`);
      }
      const tasks = await listTasks(scheduleId);
      const snapshot: BaselineTaskRow[] = tasks.map((t) => ({
        taskId: t.id,
        name: t.name,
        wbsCode: t.wbsCode,
        durationDays: t.durationDays,
        startDate: t.startDate,
        finishDate: t.finishDate,
        totalFloat: t.totalFloat,
        isCritical: t.isCritical === 1,
      }));
      const id = newId("bsl");
      await app.db.insert(scheduleBaselines).values({
        id,
        scheduleId,
        projectId: req.projectId!,
        name: body.name,
        projectStart: schedule.projectStart,
        computedFinish: summary.projectFinishDate,
        snapshot,
        capturedBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "schedule_baseline",
        objectId: id,
        payload: { name: body.name, taskCount: snapshot.length },
        storePayload: false,
      });
      const [created] = await app.db
        .select()
        .from(scheduleBaselines)
        .where(eq(scheduleBaselines.id, id))
        .limit(1);
      return reply.status(201).send({ ...created, taskCount: snapshot.length });
    },
  );

  app.get(
    "/projects/:projectId/schedules/:scheduleId/baselines",
    { preHandler: readGate },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      const rows = await app.db
        .select()
        .from(scheduleBaselines)
        .where(eq(scheduleBaselines.scheduleId, scheduleId))
        .orderBy(asc(scheduleBaselines.capturedAt), asc(scheduleBaselines.id));
      return {
        items: rows.map(({ snapshot, ...rest }) => ({
          ...rest,
          taskCount: Array.isArray(snapshot) ? snapshot.length : 0,
        })),
        total: rows.length,
      };
    },
  );

  app.get(
    "/projects/:projectId/schedule-baselines/:baselineId",
    { preHandler: readGate },
    async (req) => {
      const { baselineId } = req.params as { baselineId: string };
      const rows = await app.db
        .select()
        .from(scheduleBaselines)
        .where(
          and(
            eq(scheduleBaselines.id, baselineId),
            eq(scheduleBaselines.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!rows[0]) throw notFound("Schedule baseline not found");
      await fetchSchedule(rows[0].scheduleId, req.companyId!, req.projectId!);
      return rows[0];
    },
  );

  /** Baseline vs current comparison (#356-357). */
  app.get(
    "/projects/:projectId/schedules/:scheduleId/baselines/:baselineId/compare",
    { preHandler: readGate },
    async (req) => {
      const { scheduleId, baselineId } = req.params as { scheduleId: string; baselineId: string };
      const schedule = await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      const rows = await app.db
        .select()
        .from(scheduleBaselines)
        .where(
          and(
            eq(scheduleBaselines.id, baselineId),
            eq(scheduleBaselines.scheduleId, scheduleId),
            eq(scheduleBaselines.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!rows[0]) throw notFound("Schedule baseline not found");
      const baseline = rows[0];
      const snapshot = (baseline.snapshot ?? []) as BaselineTaskRow[];
      const current = await listTasks(scheduleId);
      const currentById = new Map(current.map((t) => [t.id, t] as const));
      const snapshotIds = new Set(snapshot.map((s) => s.taskId));

      const items = snapshot.map((snap) => {
        const cur = currentById.get(snap.taskId);
        if (!cur) {
          return {
            taskId: snap.taskId,
            name: snap.name,
            baselineStart: snap.startDate,
            baselineFinish: snap.finishDate,
            currentStart: null as string | null,
            currentFinish: null as string | null,
            startVarianceDays: null as number | null,
            finishVarianceDays: null as number | null,
            floatChange: null as number | null,
            becameCritical: false,
            droppedCritical: false,
            added: false,
            removed: true,
          };
        }
        const curCritical = cur.isCritical === 1;
        return {
          taskId: snap.taskId,
          name: cur.name,
          baselineStart: snap.startDate,
          baselineFinish: snap.finishDate,
          currentStart: cur.startDate,
          currentFinish: cur.finishDate,
          startVarianceDays:
            cur.startDate && snap.startDate ? diffDays(cur.startDate, snap.startDate) : null,
          finishVarianceDays:
            cur.finishDate && snap.finishDate ? diffDays(cur.finishDate, snap.finishDate) : null,
          floatChange:
            cur.totalFloat !== null && snap.totalFloat !== null
              ? cur.totalFloat - snap.totalFloat
              : null,
          becameCritical: !snap.isCritical && curCritical,
          droppedCritical: snap.isCritical && !curCritical,
          added: false,
          removed: false,
        };
      });
      for (const cur of current) {
        if (snapshotIds.has(cur.id)) continue;
        items.push({
          taskId: cur.id,
          name: cur.name,
          baselineStart: null,
          baselineFinish: null,
          currentStart: cur.startDate,
          currentFinish: cur.finishDate,
          startVarianceDays: null,
          finishVarianceDays: null,
          floatChange: null,
          becameCritical: cur.isCritical === 1,
          droppedCritical: false,
          added: true,
          removed: false,
        });
      }

      const baselineFinish = baseline.computedFinish;
      const currentFinish = schedule.computedFinish;
      return {
        baselineId: baseline.id,
        baselineName: baseline.name,
        capturedAt: baseline.capturedAt,
        header: {
          baselineFinish,
          currentFinish,
          completionMovementDays:
            baselineFinish && currentFinish ? diffDays(currentFinish, baselineFinish) : null,
        },
        items,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Lookahead (#359)                                                  */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/schedules/:scheduleId/lookahead",
    { preHandler: readGate },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const q = lookaheadQuerySchema.parse(req.query);
      await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      const from = todayISO();
      const to = addDaysISO(from, q.weeks * 7); // exclusive
      const inWindow = (d: string | null) => d !== null && d >= from && d < to;
      const tasks = await listTasks(scheduleId);
      const items = tasks
        .filter(
          (t) => t.percentComplete < 100 && (inWindow(t.startDate) || inWindow(t.finishDate)),
        )
        .sort((a, b) => {
          const sa = a.startDate ?? "9999-12-31";
          const sb = b.startDate ?? "9999-12-31";
          return sa < sb ? -1 : sa > sb ? 1 : a.sortOrder - b.sortOrder;
        });
      return { weeks: q.weeks, from, to, items, total: items.length };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Quality / health check (#371, Domain D #283)                      */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/schedules/:scheduleId/quality",
    { preHandler: readGate },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const schedule = await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      const tasks = await listTasks(scheduleId);
      const deps = await listDependencies(scheduleId);
      const report = assessScheduleQuality(
        tasks.map((t) => ({
          id: t.id,
          name: t.name,
          durationDays: t.durationDays,
          constraintType: t.constraintType,
          percentComplete: t.percentComplete,
          actualStart: t.actualStart,
          actualFinish: t.actualFinish,
          startDate: t.startDate,
          finishDate: t.finishDate,
          totalFloat: t.totalFloat,
        })),
        deps.map((d) => ({
          id: d.id,
          predecessorId: d.predecessorId,
          successorId: d.successorId,
          depType: d.depType,
          lagDays: d.lagDays,
        })),
      );
      return { scheduleId, scheduleName: schedule.name, ...report };
    },
  );
};
