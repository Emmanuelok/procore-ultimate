/**
 * Schedule module — the native CPM programme and everything a planner needs to
 * defend it (spec Vol I §2.6).
 *
 * COVERS: #349-350 Primavera P6 XER and MS Project MSPDI import (with a
 * revision diff and a dry-run preview) and #351-352 native creation/editing;
 * #353 critical path and float; #354 typed logic (FS/SS/FF/SF with lags) with
 * cycle refusal; #355-357 baselines, revision families and comparison; #358
 * and #361 progress (actuals, percent complete, a data date); #359 the
 * lookahead window and its make-ready constraints log; #360 responsible /
 * location assignment validated against real company users and project
 * locations; #362 key milestones tracked against contractual dates with slip
 * alerts; #363-366 work calendars; #370 resource-loaded activities; #371 and
 * Domain D #283 the full DCMA 14-point quality assessment (including BEI,
 * CPLI, missed tasks and the critical-path test); earned value (PV/EV/AC,
 * SPI/CPI, EAC) read from budget lines or per-activity budgets; MSPDI export;
 * calendar-view data; and update narratives.
 *
 * The engine is ./cpm2.ts — a superset of lib/cpm.ts that adds calendars, a
 * data date and remaining durations. lib/cpm.ts is untouched and still backs
 * its own tests. Every recompute runs inside a transaction holding a
 * per-schedule advisory lock, so two concurrent edits cannot persist dates
 * computed from different views of the network.
 *
 * DELIBERATELY NOT HERE: resource levelling and Monte-Carlo QSRA (risk owns
 * the latter), P6 XER *export* (P6 imports MSPDI), multi-project XER files,
 * and the delay-forensics methods — those live in modules/forensics, which
 * reads this module's tasks and dependencies.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  budgetLineItems,
  budgets,
  companyMemberships,
  delayEvents,
  locations,
  risks,
  scheduleBaselines,
  scheduleCalendars,
  scheduleConstraints,
  scheduleDependencies,
  scheduleImports,
  scheduleNarratives,
  scheduleTaskResources,
  scheduleTasks,
  schedules,
} from "@constructos/db";
import {
  CONSTRAINT_LOG_CATEGORIES,
  CONSTRAINT_LOG_STATUSES,
  DEPENDENCY_TYPES,
  SCHEDULE_FILE_FORMATS,
  SCHEDULE_RESOURCE_TYPES,
  SCHEDULE_TASK_TYPES,
  TASK_CONSTRAINT_TYPES,
  type DependencyType,
  type TaskConstraintType,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { forEachCompany } from "../../lib/scheduler.js";
import { addDaysISO, isoDateSchema, todayISO } from "../field/dates.js";
import {
  computeCpm2,
  dayFromIso,
  type CalendarSpec,
  type Cpm2DependencyInput,
  type Cpm2TaskInput,
} from "./cpm2.js";
import { assessScheduleQuality, type QualityBaselineRow } from "./quality.js";
import { computeEarnedValue, type EvActivity } from "./earnedvalue.js";
import { parseXer } from "./import/xer.js";
import { exportMspdi, parseMspdi } from "./import/mspdi.js";
import { diffRevisions, type DiffTask } from "./import/diff.js";
import type { ParsedSchedule } from "./import/types.js";
import {
  countOpenConstraints,
  sweepConstraints,
  sweepMilestoneSlips,
  untrackedMilestones,
} from "./sweeps.js";
import { registerSearchSource } from "../search/registry.js";
import { likePattern } from "../search/engine.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const scheduleCreateSchema = z.object({
  name: z.string().min(1).max(300),
  projectStart: isoDateSchema,
  dataDate: isoDateSchema.nullable().optional(),
  defaultCalendarId: z.string().min(1).nullable().optional(),
});

const schedulePatchSchema = scheduleCreateSchema.partial();

const taskCreateSchema = z.object({
  name: z.string().min(1).max(300),
  durationDays: z.number().int().min(0).max(10000),
  wbsCode: z.string().max(60).nullable().optional(),
  wbsPath: z.string().max(300).nullable().optional(),
  constraintType: z.enum(TASK_CONSTRAINT_TYPES).nullable().optional(),
  constraintDate: isoDateSchema.nullable().optional(),
  responsibleId: z.string().max(100).nullable().optional(),
  locationId: z.string().max(100).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  taskType: z.enum(SCHEDULE_TASK_TYPES).optional(),
  calendarId: z.string().min(1).nullable().optional(),
  isKeyMilestone: z.boolean().optional(),
  contractualDate: isoDateSchema.nullable().optional(),
  budgetLineItemId: z.string().min(1).nullable().optional(),
  budgetedCost: z.number().min(0).nullable().optional(),
  budgetedHours: z.number().min(0).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const taskPatchSchema = taskCreateSchema.partial().extend({
  percentComplete: z.number().min(0).max(100).optional(),
  actualStart: isoDateSchema.nullable().optional(),
  actualFinish: isoDateSchema.nullable().optional(),
  remainingDurationDays: z.number().int().min(0).max(10000).nullable().optional(),
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

const dependencyPatchSchema = z.object({
  depType: z.enum(DEPENDENCY_TYPES).optional(),
  lagDays: z.number().int().min(-3650).max(3650).optional(),
});

const baselineCreateSchema = z.object({
  name: z.string().min(1).max(300),
});

const lookaheadQuerySchema = z.object({
  weeks: z.coerce.number().int().min(1).max(26).default(3),
  from: isoDateSchema.optional(),
});

const calendarCreateSchema = z.object({
  name: z.string().min(1).max(200),
  scheduleId: z.string().min(1).nullable().optional(),
  workdays: z.array(z.number().int().min(0).max(1)).length(7).optional(),
  holidays: z.array(isoDateSchema).max(2000).optional(),
  exceptions: z.array(isoDateSchema).max(2000).optional(),
  hoursPerDay: z.number().min(0.5).max(24).optional(),
  isDefault: z.boolean().optional(),
});
const calendarPatchSchema = calendarCreateSchema.partial().omit({ scheduleId: true });

const resourceCreateSchema = z.object({
  name: z.string().min(1).max(200),
  resourceType: z.enum(SCHEDULE_RESOURCE_TYPES).default("labour"),
  unit: z.string().max(30).nullable().optional(),
  budgetedUnits: z.number().min(0).default(0),
  actualUnits: z.number().min(0).default(0),
  remainingUnits: z.number().min(0).nullable().optional(),
  unitRate: z.number().min(0).nullable().optional(),
  budgetedCost: z.number().min(0).optional(),
  actualCost: z.number().min(0).optional(),
});
const resourcePatchSchema = resourceCreateSchema.partial();

const constraintCreateSchema = z.object({
  scheduleId: z.string().min(1),
  taskId: z.string().min(1).nullable().optional(),
  description: z.string().min(1).max(2000),
  category: z.enum(CONSTRAINT_LOG_CATEGORIES).default("other"),
  ownerId: z.string().min(1).nullable().optional(),
  needByDate: isoDateSchema.nullable().optional(),
});
const constraintPatchSchema = constraintCreateSchema
  .omit({ scheduleId: true })
  .partial()
  .extend({ status: z.enum(CONSTRAINT_LOG_STATUSES).optional(), resolution: z.string().max(2000).nullable().optional() });

const narrativeCreateSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(50000),
  periodStart: isoDateSchema.nullable().optional(),
  periodEnd: isoDateSchema.nullable().optional(),
  dataDate: isoDateSchema.nullable().optional(),
});

const earnedValueQuerySchema = z.object({
  dataDate: isoDateSchema.optional(),
  baselineId: z.string().min(1).optional(),
  currency: z.string().length(3).optional(),
});

const qualityQuerySchema = z.object({
  baselineId: z.string().min(1).optional(),
});

const compareQuerySchema = z.object({
  fromScheduleId: z.string().min(1),
  toScheduleId: z.string().min(1),
});

const calendarViewQuerySchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
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
  longestPath?: string[];
  cycle?: string[];
}

const CONSTRAINT_TRANSITIONS: Record<string, string[]> = {
  open: ["in_progress", "cleared", "escalated", "void"],
  in_progress: ["cleared", "escalated", "void"],
  escalated: ["in_progress", "cleared", "void"],
  cleared: ["open"],
  void: [],
};

const MAX_IMPORT_BYTES = 32 * 1024 * 1024;

/**
 * Native schedule core — spec Vol I §2.6 (#351 creation/editing, #353 critical
 * path, #354 typed dependencies with lag, #355-357 baselines, revisions &
 * comparison, #358/#361 progress, #359 lookahead + constraints log, #360
 * assignment, #362 milestone slip tracking, #363-369 earned value, #370
 * resource-loaded activities, #371 / Domain D #283 full DCMA 14-point health)
 * plus the P6 XER and MS Project MSPDI importers and an MSPDI exporter
 * (#349-350).
 *
 * The CPM engine is ./cpm2.ts (calendars, data date, remaining duration);
 * lib/cpm.ts is left untouched and still backs its own tests. Recompute runs
 * inside a transaction serialised per schedule by a Postgres advisory lock,
 * and writes every task in one statement, so persisted dates can never be
 * half-updated or computed from a stale read.
 *
 * Deliberately NOT here: resource levelling, cost loading beyond a per-task
 * budget, and multi-project programmes (each schedule belongs to one project).
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

  /** Calendars visible to a schedule: its own plus the project-level ones. */
  async function loadCalendars(companyId: string, projectId: string, scheduleId: string) {
    return app.db
      .select()
      .from(scheduleCalendars)
      .where(
        and(
          eq(scheduleCalendars.companyId, companyId),
          eq(scheduleCalendars.projectId, projectId),
          or(eq(scheduleCalendars.scheduleId, scheduleId), sql`${scheduleCalendars.scheduleId} is null`)!,
        ),
      )
      .orderBy(asc(scheduleCalendars.createdAt));
  }

  function toCalendarSpecs(
    rows: Awaited<ReturnType<typeof loadCalendars>>,
  ): { specs: CalendarSpec[]; defaultId: string | null } {
    const specs = rows.map((c) => ({
      id: c.id,
      workdays: Array.isArray(c.workdays) && c.workdays.length === 7 ? c.workdays : [0, 1, 1, 1, 1, 1, 0],
      holidays: c.holidays ?? [],
      exceptions: c.exceptions ?? [],
      hoursPerDay: c.hoursPerDay,
    }));
    const def = rows.find((c) => c.isDefault === 1);
    return { specs, defaultId: def?.id ?? null };
  }

  function toCpmTasks(tasks: Awaited<ReturnType<typeof listTasks>>): Cpm2TaskInput[] {
    return tasks.map((t) => ({
      id: t.id,
      duration: t.durationDays,
      remainingDuration: t.remainingDurationDays,
      percentComplete: t.percentComplete,
      constraintType: (t.constraintType as TaskConstraintType | null) ?? null,
      constraintDate: t.constraintDate,
      actualStart: t.actualStart,
      actualFinish: t.actualFinish,
      calendarId: t.calendarId,
      taskType: t.taskType,
    }));
  }

  function toCpmDeps(deps: Awaited<ReturnType<typeof listDependencies>>): Cpm2DependencyInput[] {
    return deps.map((d) => ({
      predecessorId: d.predecessorId,
      successorId: d.successorId,
      type: d.depType as DependencyType,
      lagDays: d.lagDays,
    }));
  }

  /* ---------------------------------------------------------------- */
  /* Recompute — one transaction, serialised per schedule              */
  /* ---------------------------------------------------------------- */

  /**
   * Run CPM2 over the schedule and persist every task's dates, float and
   * criticality plus the schedule header.
   *
   * Everything happens inside ONE transaction that first takes a
   * transaction-scoped advisory lock keyed on the schedule id, so two
   * concurrent edits cannot interleave read → compute → write and leave
   * persisted dates that match neither input. The per-task writes go out as a
   * single UPDATE … FROM (VALUES …) per 500 rows rather than one statement per
   * activity: a thousand-activity programme was a thousand round trips.
   */
  async function recomputeSchedule(schedule: { id: string }): Promise<ComputeSummary> {
    return app.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`schedule:${schedule.id}`}))`);
      const [header] = await tx
        .select()
        .from(schedules)
        .where(eq(schedules.id, schedule.id))
        .limit(1);
      if (!header) throw notFound("Schedule not found");

      const tasks = await tx
        .select()
        .from(scheduleTasks)
        .where(eq(scheduleTasks.scheduleId, schedule.id))
        .orderBy(asc(scheduleTasks.sortOrder), asc(scheduleTasks.id));
      const deps = await tx
        .select()
        .from(scheduleDependencies)
        .where(eq(scheduleDependencies.scheduleId, schedule.id));
      const calendarRows = await tx
        .select()
        .from(scheduleCalendars)
        .where(
          and(
            eq(scheduleCalendars.companyId, header.companyId),
            eq(scheduleCalendars.projectId, header.projectId),
            or(eq(scheduleCalendars.scheduleId, schedule.id), sql`${scheduleCalendars.scheduleId} is null`)!,
          ),
        );
      const { specs, defaultId } = toCalendarSpecs(calendarRows);

      const result = computeCpm2(toCpmTasks(tasks), toCpmDeps(deps), {
        projectStart: header.projectStart,
        dataDate: header.dataDate,
        calendars: specs,
        defaultCalendarId: header.defaultCalendarId ?? defaultId,
      });
      const now = new Date().toISOString();
      if (!result.ok) {
        // A cycle aborts the pass; existing dates are left as-is and reported.
        return { projectFinishDate: null, durationDays: 0, criticalCount: 0, cycle: result.cycle };
      }

      const changed = tasks
        .map((t) => {
          const r = result.tasks.get(t.id);
          if (!r) return null;
          const critical = r.isCritical ? 1 : 0;
          if (
            t.startDate === r.startDate &&
            t.finishDate === r.finishDate &&
            t.totalFloat === r.totalFloat &&
            t.isCritical === critical
          ) {
            return null;
          }
          return {
            id: t.id,
            startDate: r.startDate,
            finishDate: r.finishDate,
            totalFloat: r.totalFloat,
            isCritical: critical,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      for (let i = 0; i < changed.length; i += 500) {
        const batch = changed.slice(i, i + 500);
        const values = batch.map(
          (b) =>
            sql`(${b.id}::text, ${b.startDate}::text, ${b.finishDate}::text, ${b.totalFloat}::integer, ${b.isCritical}::integer)`,
        );
        await tx.execute(sql`
          update schedule_tasks as t
          set start_date = v.start_date,
              finish_date = v.finish_date,
              total_float = v.total_float,
              is_critical = v.is_critical,
              updated_at = ${now}
          from (values ${sql.join(values, sql`, `)}) as v(id, start_date, finish_date, total_float, is_critical)
          where t.id = v.id
        `);
      }

      const computedFinish = tasks.length > 0 ? result.projectFinishDate : null;
      const computedDurationDays = tasks.length > 0 ? result.projectDurationDays : 0;
      await tx
        .update(schedules)
        .set({ computedFinish, computedDurationDays, lastComputedAt: now, updatedAt: now })
        .where(eq(schedules.id, schedule.id));
      return {
        projectFinishDate: computedFinish,
        durationDays: computedDurationDays,
        criticalCount: result.criticalIds.length,
        longestPath: result.longestPath,
      };
    });
  }

  /* ---------------------------------------------------------------- */
  /* Reference validation (#360 — assignment must mean something)       */
  /* ---------------------------------------------------------------- */

  /**
   * responsibleId / locationId used to be free text: any 100-character string
   * was stored, which made assignment undriveable (no notification could be
   * addressed) and let a caller park a foreign tenant's id on a task.
   */
  async function validateResponsibleId(responsibleId: string, companyId: string): Promise<void> {
    const [row] = await app.db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.userId, responsibleId)),
      )
      .limit(1);
    if (!row) throw badRequest("responsibleId must be a user of this company");
  }

  async function validateLocationId(locationId: string, companyId: string, projectId: string): Promise<void> {
    const [row] = await app.db
      .select({ id: locations.id })
      .from(locations)
      .where(
        and(
          eq(locations.id, locationId),
          eq(locations.companyId, companyId),
          eq(locations.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw badRequest("locationId must be a location of this project");
  }

  async function validateCalendarId(calendarId: string, companyId: string, projectId: string): Promise<void> {
    const [row] = await app.db
      .select({ id: scheduleCalendars.id })
      .from(scheduleCalendars)
      .where(
        and(
          eq(scheduleCalendars.id, calendarId),
          eq(scheduleCalendars.companyId, companyId),
          eq(scheduleCalendars.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw badRequest("calendarId must be a calendar of this project");
  }

  async function validateBudgetLineId(lineId: string, companyId: string, projectId: string): Promise<void> {
    const [row] = await app.db
      .select({ id: budgetLineItems.id })
      .from(budgetLineItems)
      .where(
        and(
          eq(budgetLineItems.id, lineId),
          eq(budgetLineItems.companyId, companyId),
          eq(budgetLineItems.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw badRequest("budgetLineItemId must be a budget line of this project");
  }

  /* ---------------------------------------------------------------- */
  /* Schedules (#351)                                                  */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/schedules", { preHandler: standardGate }, async (req, reply) => {
    const body = scheduleCreateSchema.parse(req.body);
    if (body.defaultCalendarId) {
      await validateCalendarId(body.defaultCalendarId, req.companyId!, req.projectId!);
    }
    const [existing] = await app.db
      .select({ n: count() })
      .from(schedules)
      .where(and(eq(schedules.companyId, req.companyId!), eq(schedules.projectId, req.projectId!)));
    const isActive = Number(existing?.n ?? 0) === 0 ? 1 : 0; // the first schedule becomes active
    const id = newId("sch");
    await app.db.insert(schedules).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      name: body.name,
      projectStart: body.projectStart,
      dataDate: body.dataDate ?? null,
      defaultCalendarId: body.defaultCalendarId ?? null,
      isActive,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "schedule",
      objectId: id,
      projectId: req.projectId!,
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
    const calendars = await loadCalendars(req.companyId!, req.projectId!, scheduleId);
    const resources = await app.db
      .select()
      .from(scheduleTaskResources)
      .where(eq(scheduleTaskResources.scheduleId, scheduleId));
    return {
      ...schedule,
      tasks,
      dependencies,
      calendars,
      resources,
      summary: {
        taskCount: tasks.length,
        dependencyCount: dependencies.length,
        criticalCount: tasks.filter((t) => t.isCritical === 1).length,
        milestoneCount: tasks.filter((t) => t.isKeyMilestone === 1).length,
        resourceCount: resources.length,
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
      if (body.defaultCalendarId) {
        await validateCalendarId(body.defaultCalendarId, req.companyId!, req.projectId!);
      }
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      if (body.name !== undefined) set["name"] = body.name;
      if (body.projectStart !== undefined) set["projectStart"] = body.projectStart;
      if (body.dataDate !== undefined) set["dataDate"] = body.dataDate;
      if (body.defaultCalendarId !== undefined) set["defaultCalendarId"] = body.defaultCalendarId;
      await app.db.update(schedules).set(set).where(eq(schedules.id, scheduleId));
      // Moving day 0, the data date or the calendar moves every computed date.
      const recomputeNeeded =
        (body.projectStart !== undefined && body.projectStart !== schedule.projectStart) ||
        (body.dataDate !== undefined && body.dataDate !== schedule.dataDate) ||
        (body.defaultCalendarId !== undefined && body.defaultCalendarId !== schedule.defaultCalendarId);
      if (recomputeNeeded) await recomputeSchedule({ id: scheduleId });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "schedule",
        objectId: scheduleId,
        projectId: req.projectId!,
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
        projectId: req.projectId!,
        payload: { name: schedule.name, isActive: true },
      });
      return fetchSchedule(scheduleId, req.companyId!, req.projectId!);
    },
  );

  /**
   * Deleting a schedule used to orphan every delay event and risk that
   * pointed at its tasks: the forensic TIA then failed with a confusing
   * message and the cached impact numbers silently described a programme that
   * no longer existed. The delete now refuses while references exist, and
   * `?detach=true` severs them explicitly — each severance ledgered.
   */
  app.delete(
    "/projects/:projectId/schedules/:scheduleId",
    { preHandler: standardGate },
    async (req, reply) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const detach = (req.query as { detach?: string }).detach === "true";
      const schedule = await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      const tasks = await listTasks(scheduleId);
      const taskIds = tasks.map((t) => t.id);

      const referencingEvents = await app.db
        .select({ id: delayEvents.id, number: delayEvents.number, title: delayEvents.title })
        .from(delayEvents)
        .where(
          and(eq(delayEvents.projectId, req.projectId!), eq(delayEvents.scheduleId, scheduleId)),
        );
      const referencingRisks =
        taskIds.length > 0
          ? await app.db
              .select({ id: risks.id, number: risks.number, title: risks.title })
              .from(risks)
              .where(
                and(eq(risks.projectId, req.projectId!), inArray(risks.scheduleTaskId, taskIds)),
              )
          : [];

      if (!detach && (referencingEvents.length > 0 || referencingRisks.length > 0)) {
        throw conflict(
          `This schedule is referenced by ${referencingEvents.length} delay event(s) and ` +
            `${referencingRisks.length} risk(s). Re-point or withdraw them first, or repeat the ` +
            "request with ?detach=true to sever the references (each severance is ledgered).",
        );
      }

      await app.db.transaction(async (tx) => {
        if (referencingEvents.length > 0) {
          await tx
            .update(delayEvents)
            .set({
              taskId: null,
              scheduleId: null,
              tiaResult: null,
              updatedAt: new Date().toISOString(),
            })
            .where(
              inArray(
                delayEvents.id,
                referencingEvents.map((e) => e.id),
              ),
            );
        }
        if (referencingRisks.length > 0) {
          await tx
            .update(risks)
            .set({ scheduleTaskId: null, updatedAt: new Date().toISOString() })
            .where(
              inArray(
                risks.id,
                referencingRisks.map((r) => r.id),
              ),
            );
        }
        await tx.delete(scheduleTaskResources).where(eq(scheduleTaskResources.scheduleId, scheduleId));
        await tx.delete(scheduleConstraints).where(eq(scheduleConstraints.scheduleId, scheduleId));
        await tx.delete(scheduleNarratives).where(eq(scheduleNarratives.scheduleId, scheduleId));
        await tx.delete(scheduleDependencies).where(eq(scheduleDependencies.scheduleId, scheduleId));
        await tx.delete(scheduleBaselines).where(eq(scheduleBaselines.scheduleId, scheduleId));
        await tx.delete(scheduleTasks).where(eq(scheduleTasks.scheduleId, scheduleId));
        await tx.delete(schedules).where(eq(schedules.id, scheduleId));
      });

      for (const ev of referencingEvents) {
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "update",
          objectType: "delay_event",
          objectId: ev.id,
          projectId: req.projectId!,
          payload: {
            detachedFromSchedule: scheduleId,
            reason: "the referenced schedule was deleted",
            clearedTia: true,
          },
        });
      }
      for (const r of referencingRisks) {
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "update",
          objectType: "risk",
          objectId: r.id,
          projectId: req.projectId!,
          payload: { detachedScheduleTask: true, reason: "the referenced schedule was deleted" },
        });
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "schedule",
        objectId: scheduleId,
        projectId: req.projectId!,
        payload: {
          name: schedule.name,
          taskCount: tasks.length,
          detachedDelayEvents: referencingEvents.length,
          detachedRisks: referencingRisks.length,
        },
      });
      return reply.status(204).send();
    },
  );

  /* ---------------------------------------------------------------- */
  /* Tasks (#351, #358, #360, #361, #362)                              */
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

  async function validateTaskRefs(
    body: { responsibleId?: string | null; locationId?: string | null; calendarId?: string | null; budgetLineItemId?: string | null },
    companyId: string,
    projectId: string,
  ): Promise<void> {
    if (body.responsibleId) await validateResponsibleId(body.responsibleId, companyId);
    if (body.locationId) await validateLocationId(body.locationId, companyId, projectId);
    if (body.calendarId) await validateCalendarId(body.calendarId, companyId, projectId);
    if (body.budgetLineItemId) await validateBudgetLineId(body.budgetLineItemId, companyId, projectId);
  }

  app.post(
    "/projects/:projectId/schedules/:scheduleId/tasks",
    { preHandler: standardGate },
    async (req, reply) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const body = taskCreateSchema.parse(req.body);
      const schedule = await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      validateConstraint(body.constraintType, body.constraintDate);
      await validateTaskRefs(body, req.companyId!, req.projectId!);
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
        wbsPath: body.wbsPath ?? null,
        durationDays: body.durationDays,
        taskType: body.taskType ?? (body.durationDays === 0 ? "finish_milestone" : "task"),
        calendarId: body.calendarId ?? null,
        constraintType: body.constraintType ?? null,
        constraintDate: body.constraintDate ?? null,
        responsibleId: body.responsibleId ?? null,
        locationId: body.locationId ?? null,
        isKeyMilestone: body.isKeyMilestone ? 1 : 0,
        contractualDate: body.contractualDate ?? null,
        budgetLineItemId: body.budgetLineItemId ?? null,
        budgetedCost: body.budgetedCost ?? null,
        budgetedHours: body.budgetedHours ?? null,
        notes: body.notes ?? null,
        sortOrder,
      });
      await recomputeSchedule(schedule);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "schedule_task",
        objectId: id,
        projectId: req.projectId!,
        payload: { scheduleId, name: body.name, durationDays: body.durationDays },
      });
      const { task } = await fetchTask(id, req.companyId!, req.projectId!);
      return reply.status(201).send(task);
    },
  );

  /**
   * One activity by id. Exists so a link that names an activity — a search
   * hit, a forensics fragnet anchor, a risk's scheduleTaskId — can resolve
   * which programme it lives in without the caller listing every schedule.
   */
  app.get(
    "/projects/:projectId/schedule-tasks/:taskId",
    { preHandler: readGate },
    async (req) => {
      const { taskId } = req.params as { taskId: string };
      const { task, schedule } = await fetchTask(taskId, req.companyId!, req.projectId!);
      return {
        ...task,
        scheduleName: schedule.name,
        scheduleIsActive: schedule.isActive === 1,
      };
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
      await validateTaskRefs(body, req.companyId!, req.projectId!);

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
        if (v === undefined) continue;
        if (k === "isKeyMilestone") set[k] = v ? 1 : 0;
        else set[k] = v;
      }
      // A moved contractual date is a different promise — the previous slip
      // alert no longer describes it.
      if (body.contractualDate !== undefined && body.contractualDate !== task.contractualDate) {
        set["slipAlertedDays"] = null;
        set["slipAlertedAt"] = null;
      }
      await app.db.update(scheduleTasks).set(set).where(eq(scheduleTasks.id, taskId));
      await recomputeSchedule(schedule);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "schedule_task",
        objectId: taskId,
        projectId: req.projectId!,
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
        await tx.delete(scheduleTaskResources).where(eq(scheduleTaskResources.taskId, taskId));
        await tx
          .update(scheduleConstraints)
          .set({ taskId: null, updatedAt: new Date().toISOString() })
          .where(eq(scheduleConstraints.taskId, taskId));
        await tx
          .update(delayEvents)
          .set({ taskId: null, tiaResult: null, updatedAt: new Date().toISOString() })
          .where(and(eq(delayEvents.projectId, req.projectId!), eq(delayEvents.taskId, taskId)));
        await tx
          .update(risks)
          .set({ scheduleTaskId: null, updatedAt: new Date().toISOString() })
          .where(and(eq(risks.projectId, req.projectId!), eq(risks.scheduleTaskId, taskId)));
        await tx.delete(scheduleTasks).where(eq(scheduleTasks.id, taskId));
      });
      await recomputeSchedule(schedule);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "schedule_task",
        objectId: taskId,
        projectId: req.projectId!,
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
      await app.db.transaction(async (tx) => {
        for (let i = 0; i < body.orderedIds.length; i += 1) {
          const id = body.orderedIds[i]!;
          if (byId.get(id)!.sortOrder !== i) {
            await tx
              .update(scheduleTasks)
              .set({ sortOrder: i, updatedAt: now })
              .where(eq(scheduleTasks.id, id));
          }
        }
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "schedule",
        objectId: scheduleId,
        projectId: req.projectId!,
        payload: { reordered: body.orderedIds.length },
      });
      return { items: await listTasks(scheduleId) };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Dependencies (#354)                                               */
  /* ---------------------------------------------------------------- */

  /** Postgres unique-violation — the duplicate raced past the read check. */
  function isUniqueViolation(err: unknown): boolean {
    const code = (err as { code?: unknown } | null)?.code;
    return code === "23505" || String((err as Error | null)?.message ?? "").includes("schedule_deps_uq");
  }

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
      const trial = computeCpm2(
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
        { projectStart: schedule.projectStart, dataDate: schedule.dataDate },
      );
      if (!trial.ok) {
        throw conflict(`would create a cycle: ${trial.cycle.join(", ")}`);
      }

      const id = newId("dep");
      try {
        await app.db.insert(scheduleDependencies).values({
          id,
          scheduleId,
          predecessorId: body.predecessorId,
          successorId: body.successorId,
          depType: body.depType,
          lagDays: body.lagDays,
        });
      } catch (err) {
        // Two simultaneous identical posts both pass the read check; the loser
        // hits the unique index and must read as a conflict, not a 500.
        if (isUniqueViolation(err)) throw conflict("This dependency already exists");
        throw err;
      }
      await recomputeSchedule(schedule);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "schedule_dependency",
        objectId: id,
        projectId: req.projectId!,
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

  /**
   * Editing a link used to be delete-then-recreate in the browser, which lost
   * the link outright when the recreate failed and wrote a delete + create
   * pair into the ledger for what is one edit. One route, cycle-checked with
   * the modified edge, ledgered as an update.
   */
  app.patch(
    "/projects/:projectId/schedule-dependencies/:depId",
    { preHandler: standardGate },
    async (req) => {
      const { depId } = req.params as { depId: string };
      const body = dependencyPatchSchema.parse(req.body);
      const [dep] = await app.db
        .select()
        .from(scheduleDependencies)
        .where(eq(scheduleDependencies.id, depId))
        .limit(1);
      if (!dep) throw notFound("Schedule dependency not found");
      const schedule = await fetchSchedule(dep.scheduleId, req.companyId!, req.projectId!);
      const depType = body.depType ?? (dep.depType as DependencyType);
      const lagDays = body.lagDays ?? dep.lagDays;
      if (depType === dep.depType && lagDays === dep.lagDays) return dep;

      const tasks = await listTasks(schedule.id);
      const deps = await listDependencies(schedule.id);
      if (
        depType !== dep.depType &&
        deps.some(
          (d) =>
            d.id !== depId &&
            d.predecessorId === dep.predecessorId &&
            d.successorId === dep.successorId &&
            d.depType === depType,
        )
      ) {
        throw conflict("This dependency already exists");
      }
      const trial = computeCpm2(
        toCpmTasks(tasks),
        toCpmDeps(deps).map((d, i) =>
          deps[i]!.id === depId ? { ...d, type: depType, lagDays } : d,
        ),
        { projectStart: schedule.projectStart, dataDate: schedule.dataDate },
      );
      if (!trial.ok) throw conflict(`would create a cycle: ${trial.cycle.join(", ")}`);

      try {
        await app.db
          .update(scheduleDependencies)
          .set({ depType, lagDays })
          .where(eq(scheduleDependencies.id, depId));
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict("This dependency already exists");
        throw err;
      }
      await recomputeSchedule(schedule);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "schedule_dependency",
        objectId: depId,
        projectId: req.projectId!,
        payload: {
          scheduleId: schedule.id,
          from: { depType: dep.depType, lagDays: dep.lagDays },
          to: { depType, lagDays },
        },
      });
      const [updated] = await app.db
        .select()
        .from(scheduleDependencies)
        .where(eq(scheduleDependencies.id, depId))
        .limit(1);
      return updated;
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
        projectId: req.projectId!,
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
        projectId: req.projectId!,
        payload: { computed: { ...summary, longestPath: summary.longestPath?.length ?? 0 } },
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
        projectId: req.projectId!,
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

  /** Revision comparison: two schedules of the same project, diffed (#357). */
  app.get("/projects/:projectId/schedules-compare", { preHandler: readGate }, async (req) => {
    const q = compareQuerySchema.parse(req.query);
    const from = await fetchSchedule(q.fromScheduleId, req.companyId!, req.projectId!);
    const to = await fetchSchedule(q.toScheduleId, req.companyId!, req.projectId!);
    const [fromTasks, toTasks, fromDeps, toDeps] = await Promise.all([
      listTasks(from.id),
      listTasks(to.id),
      listDependencies(from.id),
      listDependencies(to.id),
    ]);
    const asDiff = (rows: Awaited<ReturnType<typeof listTasks>>): DiffTask[] =>
      rows.map((t) => ({
        id: t.id,
        externalId: t.externalId,
        name: t.name,
        wbsCode: t.wbsCode,
        durationDays: t.durationDays,
        startDate: t.startDate,
        finishDate: t.finishDate,
        percentComplete: t.percentComplete,
        isCritical: t.isCritical === 1,
        totalFloat: t.totalFloat,
      }));
    const diff = diffRevisions(
      { tasks: asDiff(fromTasks), dependencies: fromDeps },
      { tasks: asDiff(toTasks), dependencies: toDeps },
    );
    return {
      from: { id: from.id, name: from.name, revision: from.revision, computedFinish: from.computedFinish, dataDate: from.dataDate },
      to: { id: to.id, name: to.name, revision: to.revision, computedFinish: to.computedFinish, dataDate: to.dataDate },
      completionMovementDays:
        from.computedFinish && to.computedFinish ? diffDays(to.computedFinish, from.computedFinish) : null,
      diff,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Lookahead (#359)                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * A lookahead used to select tasks whose START or FINISH fell inside the
   * window, which dropped exactly the work in progress: a twelve-week activity
   * three weeks in has neither date inside a three-week window, yet it is what
   * the crews are doing. The filter is now an interval overlap.
   */
  app.get(
    "/projects/:projectId/schedules/:scheduleId/lookahead",
    { preHandler: readGate },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const q = lookaheadQuerySchema.parse(req.query);
      await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      const from = q.from ?? todayISO();
      const to = addDaysISO(from, q.weeks * 7); // exclusive
      const tasks = await listTasks(scheduleId);
      const overlaps = (t: (typeof tasks)[number]): boolean => {
        const start = t.actualStart ?? t.startDate;
        const finish = t.actualFinish ?? t.finishDate;
        if (!start && !finish) return false;
        const s = start ?? finish!;
        const f = finish ?? start!;
        return s < to && f >= from;
      };
      const selected = tasks.filter((t) => t.percentComplete < 100 && overlaps(t));
      const constraintRows =
        selected.length > 0
          ? await app.db
              .select()
              .from(scheduleConstraints)
              .where(
                and(
                  eq(scheduleConstraints.scheduleId, scheduleId),
                  ne(scheduleConstraints.status, "cleared"),
                  ne(scheduleConstraints.status, "void"),
                ),
              )
          : [];
      const constraintsByTask = new Map<string, typeof constraintRows>();
      for (const c of constraintRows) {
        if (!c.taskId) continue;
        const list = constraintsByTask.get(c.taskId) ?? [];
        list.push(c);
        constraintsByTask.set(c.taskId, list);
      }
      const items = selected
        .map((t) => ({
          ...t,
          inProgress: t.actualStart !== null && t.actualFinish === null,
          constraints: constraintsByTask.get(t.id) ?? [],
        }))
        .sort((a, b) => {
          const sa = a.startDate ?? "9999-12-31";
          const sb = b.startDate ?? "9999-12-31";
          return sa < sb ? -1 : sa > sb ? 1 : a.sortOrder - b.sortOrder;
        });
      return {
        weeks: q.weeks,
        from,
        to,
        items,
        total: items.length,
        constraintsOpen: constraintRows.filter((c) => !c.taskId || constraintsByTask.has(c.taskId)).length,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Quality / DCMA health check (#371, Domain D #283)                  */
  /* ---------------------------------------------------------------- */

  async function buildQualityReport(
    companyId: string,
    projectId: string,
    scheduleId: string,
    baselineId?: string,
  ) {
    const schedule = await fetchSchedule(scheduleId, companyId, projectId);
    const tasks = await listTasks(scheduleId);
    const deps = await listDependencies(scheduleId);
    const calendarRows = await loadCalendars(companyId, projectId, scheduleId);
    const { specs, defaultId } = toCalendarSpecs(calendarRows);
    const resourceRows = await app.db
      .select({ taskId: scheduleTaskResources.taskId })
      .from(scheduleTaskResources)
      .where(eq(scheduleTaskResources.scheduleId, scheduleId));
    const resourceCountByTask: Record<string, number> = {};
    for (const r of resourceRows) {
      resourceCountByTask[r.taskId] = (resourceCountByTask[r.taskId] ?? 0) + 1;
    }

    let baselineRows: QualityBaselineRow[] | null = null;
    let baselineName: string | null = null;
    const baselineQuery = baselineId
      ? and(
          eq(scheduleBaselines.id, baselineId),
          eq(scheduleBaselines.scheduleId, scheduleId),
          eq(scheduleBaselines.projectId, projectId),
        )
      : and(eq(scheduleBaselines.scheduleId, scheduleId), eq(scheduleBaselines.projectId, projectId));
    const [baseline] = await app.db
      .select()
      .from(scheduleBaselines)
      .where(baselineQuery)
      .orderBy(asc(scheduleBaselines.capturedAt), asc(scheduleBaselines.id))
      .limit(1);
    if (baselineId && !baseline) throw notFound("Schedule baseline not found");
    if (baseline) {
      baselineName = baseline.name;
      baselineRows = ((baseline.snapshot ?? []) as BaselineTaskRow[]).map((s) => ({
        taskId: s.taskId,
        finishDate: s.finishDate,
      }));
    }

    const report = assessScheduleQuality(
      tasks.map((t) => ({
        id: t.id,
        name: t.name,
        durationDays: t.durationDays,
        remainingDurationDays: t.remainingDurationDays,
        constraintType: t.constraintType,
        constraintDate: t.constraintDate,
        percentComplete: t.percentComplete,
        actualStart: t.actualStart,
        actualFinish: t.actualFinish,
        startDate: t.startDate,
        finishDate: t.finishDate,
        totalFloat: t.totalFloat,
        sortOrder: t.sortOrder,
        taskType: t.taskType,
        calendarId: t.calendarId,
      })),
      deps.map((d) => ({
        id: d.id,
        predecessorId: d.predecessorId,
        successorId: d.successorId,
        depType: d.depType,
        lagDays: d.lagDays,
      })),
      {
        projectStart: schedule.projectStart,
        dataDate: schedule.dataDate,
        calendars: specs,
        defaultCalendarId: schedule.defaultCalendarId ?? defaultId,
        baseline: baselineRows,
        resourceCountByTask: resourceRows.length > 0 ? resourceCountByTask : null,
      },
    );
    return { schedule, report, baselineId: baseline?.id ?? null, baselineName };
  }

  app.get(
    "/projects/:projectId/schedules/:scheduleId/quality",
    { preHandler: readGate },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const q = qualityQuerySchema.parse(req.query);
      const { schedule, report, baselineId, baselineName } = await buildQualityReport(
        req.companyId!,
        req.projectId!,
        scheduleId,
        q.baselineId,
      );
      return {
        scheduleId,
        scheduleName: schedule.name,
        dataDate: schedule.dataDate,
        baselineId,
        baselineName,
        ...report,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Calendars                                                         */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/schedule-calendars", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(scheduleCalendars)
      .where(
        and(
          eq(scheduleCalendars.companyId, req.companyId!),
          eq(scheduleCalendars.projectId, req.projectId!),
        ),
      )
      .orderBy(desc(scheduleCalendars.isDefault), asc(scheduleCalendars.name));
    return { items: rows, total: rows.length };
  });

  app.post("/projects/:projectId/schedule-calendars", { preHandler: standardGate }, async (req, reply) => {
    const body = calendarCreateSchema.parse(req.body);
    if (body.scheduleId) await fetchSchedule(body.scheduleId, req.companyId!, req.projectId!);
    if (body.workdays && body.workdays.every((d) => d === 0)) {
      throw badRequest("A calendar must have at least one working day");
    }
    const id = newId("cal");
    const now = new Date().toISOString();
    await app.db.transaction(async (tx) => {
      if (body.isDefault) {
        await tx
          .update(scheduleCalendars)
          .set({ isDefault: 0, updatedAt: now })
          .where(
            and(
              eq(scheduleCalendars.companyId, req.companyId!),
              eq(scheduleCalendars.projectId, req.projectId!),
            ),
          );
      }
      await tx.insert(scheduleCalendars).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        scheduleId: body.scheduleId ?? null,
        name: body.name,
        workdays: body.workdays ?? [0, 1, 1, 1, 1, 1, 0],
        holidays: body.holidays ?? [],
        exceptions: body.exceptions ?? [],
        hoursPerDay: body.hoursPerDay ?? 8,
        isDefault: body.isDefault ? 1 : 0,
      });
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "schedule_calendar",
      objectId: id,
      projectId: req.projectId!,
      payload: { name: body.name, isDefault: Boolean(body.isDefault) },
    });
    const [created] = await app.db
      .select()
      .from(scheduleCalendars)
      .where(eq(scheduleCalendars.id, id))
      .limit(1);
    return reply.status(201).send(created);
  });

  async function fetchCalendar(calendarId: string, companyId: string, projectId: string) {
    const [row] = await app.db
      .select()
      .from(scheduleCalendars)
      .where(
        and(
          eq(scheduleCalendars.id, calendarId),
          eq(scheduleCalendars.companyId, companyId),
          eq(scheduleCalendars.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Schedule calendar not found");
    return row;
  }

  app.patch(
    "/projects/:projectId/schedule-calendars/:calendarId",
    { preHandler: standardGate },
    async (req) => {
      const { calendarId } = req.params as { calendarId: string };
      const body = calendarPatchSchema.parse(req.body);
      const cal = await fetchCalendar(calendarId, req.companyId!, req.projectId!);
      if (body.workdays && body.workdays.every((d) => d === 0)) {
        throw badRequest("A calendar must have at least one working day");
      }
      const now = new Date().toISOString();
      const set: Record<string, unknown> = { updatedAt: now };
      if (body.name !== undefined) set["name"] = body.name;
      if (body.workdays !== undefined) set["workdays"] = body.workdays;
      if (body.holidays !== undefined) set["holidays"] = body.holidays;
      if (body.exceptions !== undefined) set["exceptions"] = body.exceptions;
      if (body.hoursPerDay !== undefined) set["hoursPerDay"] = body.hoursPerDay;
      if (body.isDefault !== undefined) set["isDefault"] = body.isDefault ? 1 : 0;
      await app.db.transaction(async (tx) => {
        if (body.isDefault) {
          await tx
            .update(scheduleCalendars)
            .set({ isDefault: 0, updatedAt: now })
            .where(
              and(
                eq(scheduleCalendars.companyId, req.companyId!),
                eq(scheduleCalendars.projectId, req.projectId!),
              ),
            );
        }
        await tx.update(scheduleCalendars).set(set).where(eq(scheduleCalendars.id, calendarId));
      });
      // Working-week changes move every date on every schedule that uses it.
      const affected = await app.db
        .select({ id: schedules.id })
        .from(schedules)
        .where(
          and(
            eq(schedules.companyId, req.companyId!),
            eq(schedules.projectId, req.projectId!),
            cal.scheduleId ? eq(schedules.id, cal.scheduleId) : sql`true`,
          ),
        );
      for (const s of affected) await recomputeSchedule({ id: s.id });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "schedule_calendar",
        objectId: calendarId,
        projectId: req.projectId!,
        payload: { changed: Object.keys(body), recomputedSchedules: affected.length },
      });
      return fetchCalendar(calendarId, req.companyId!, req.projectId!);
    },
  );

  app.delete(
    "/projects/:projectId/schedule-calendars/:calendarId",
    { preHandler: standardGate },
    async (req, reply) => {
      const { calendarId } = req.params as { calendarId: string };
      const cal = await fetchCalendar(calendarId, req.companyId!, req.projectId!);
      const [used] = await app.db
        .select({ n: count() })
        .from(scheduleTasks)
        .where(
          and(eq(scheduleTasks.projectId, req.projectId!), eq(scheduleTasks.calendarId, calendarId)),
        );
      if (Number(used?.n ?? 0) > 0) {
        throw conflict(`${used?.n} activit${Number(used?.n) === 1 ? "y uses" : "ies use"} this calendar — reassign them first`);
      }
      await app.db.delete(scheduleCalendars).where(eq(scheduleCalendars.id, calendarId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "schedule_calendar",
        objectId: calendarId,
        projectId: req.projectId!,
        payload: { name: cal.name },
      });
      return reply.status(204).send();
    },
  );

  /* ---------------------------------------------------------------- */
  /* Resource-loaded activities (#370)                                 */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/schedules/:scheduleId/resources",
    { preHandler: readGate },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      const rows = await app.db
        .select()
        .from(scheduleTaskResources)
        .where(eq(scheduleTaskResources.scheduleId, scheduleId))
        .orderBy(asc(scheduleTaskResources.name));
      const byType = new Map<string, { budgetedUnits: number; actualUnits: number; budgetedCost: number; actualCost: number }>();
      for (const r of rows) {
        const agg = byType.get(r.resourceType) ?? {
          budgetedUnits: 0,
          actualUnits: 0,
          budgetedCost: 0,
          actualCost: 0,
        };
        agg.budgetedUnits += r.budgetedUnits;
        agg.actualUnits += r.actualUnits;
        agg.budgetedCost += r.budgetedCost;
        agg.actualCost += r.actualCost;
        byType.set(r.resourceType, agg);
      }
      /* Money needs a currency: the project's active budget decides it, and
       * when there is none the panel is told so rather than being handed a
       * silent default. */
      const [activeBudget] = await app.db
        .select({ currency: budgets.currency })
        .from(budgets)
        .where(and(eq(budgets.projectId, req.projectId!), eq(budgets.status, "active")))
        .limit(1);
      const reasons: string[] = [];
      if (!activeBudget) {
        reasons.push("No active budget was found — costs are reported in USD by default");
      }
      if (rows.length > 0 && rows.every((r) => r.unitRate === null && r.budgetedCost === 0)) {
        reasons.push("No assignment carries a rate, so cost is not available for this programme");
      }
      return {
        items: rows,
        total: rows.length,
        currency: activeBudget?.currency ?? "USD",
        reasons,
        byType: [...byType.entries()].map(([resourceType, agg]) => ({ resourceType, ...agg })),
      };
    },
  );

  app.post(
    "/projects/:projectId/schedule-tasks/:taskId/resources",
    { preHandler: standardGate },
    async (req, reply) => {
      const { taskId } = req.params as { taskId: string };
      const body = resourceCreateSchema.parse(req.body);
      const { task, schedule } = await fetchTask(taskId, req.companyId!, req.projectId!);
      const id = newId("res");
      const budgetedCost =
        body.budgetedCost ?? (body.unitRate != null ? body.unitRate * body.budgetedUnits : 0);
      const actualCost =
        body.actualCost ?? (body.unitRate != null ? body.unitRate * body.actualUnits : 0);
      await app.db.insert(scheduleTaskResources).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        scheduleId: schedule.id,
        taskId: task.id,
        name: body.name,
        resourceType: body.resourceType,
        unit: body.unit ?? null,
        budgetedUnits: body.budgetedUnits,
        actualUnits: body.actualUnits,
        remainingUnits: body.remainingUnits ?? null,
        unitRate: body.unitRate ?? null,
        budgetedCost,
        actualCost,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "schedule_task_resource",
        objectId: id,
        projectId: req.projectId!,
        payload: { taskId, name: body.name, resourceType: body.resourceType, budgetedCost },
      });
      const [created] = await app.db
        .select()
        .from(scheduleTaskResources)
        .where(eq(scheduleTaskResources.id, id))
        .limit(1);
      return reply.status(201).send(created);
    },
  );

  app.patch(
    "/projects/:projectId/schedule-task-resources/:resourceId",
    { preHandler: standardGate },
    async (req) => {
      const { resourceId } = req.params as { resourceId: string };
      const body = resourcePatchSchema.parse(req.body);
      const [row] = await app.db
        .select()
        .from(scheduleTaskResources)
        .where(
          and(
            eq(scheduleTaskResources.id, resourceId),
            eq(scheduleTaskResources.companyId, req.companyId!),
            eq(scheduleTaskResources.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!row) throw notFound("Schedule resource not found");
      await fetchSchedule(row.scheduleId, req.companyId!, req.projectId!);
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) if (v !== undefined) set[k] = v;
      await app.db.update(scheduleTaskResources).set(set).where(eq(scheduleTaskResources.id, resourceId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "schedule_task_resource",
        objectId: resourceId,
        projectId: req.projectId!,
        payload: { changed: Object.keys(body) },
      });
      const [updated] = await app.db
        .select()
        .from(scheduleTaskResources)
        .where(eq(scheduleTaskResources.id, resourceId))
        .limit(1);
      return updated;
    },
  );

  app.delete(
    "/projects/:projectId/schedule-task-resources/:resourceId",
    { preHandler: standardGate },
    async (req, reply) => {
      const { resourceId } = req.params as { resourceId: string };
      const [row] = await app.db
        .select()
        .from(scheduleTaskResources)
        .where(
          and(
            eq(scheduleTaskResources.id, resourceId),
            eq(scheduleTaskResources.companyId, req.companyId!),
            eq(scheduleTaskResources.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!row) throw notFound("Schedule resource not found");
      await app.db.delete(scheduleTaskResources).where(eq(scheduleTaskResources.id, resourceId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "schedule_task_resource",
        objectId: resourceId,
        projectId: req.projectId!,
        payload: { taskId: row.taskId, name: row.name },
      });
      return reply.status(204).send();
    },
  );

  /* ---------------------------------------------------------------- */
  /* Lookahead constraints log (#359)                                  */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/schedule-constraints", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        scheduleId: z.string().min(1).optional(),
        status: z.enum(CONSTRAINT_LOG_STATUSES).optional(),
        category: z.enum(CONSTRAINT_LOG_CATEGORIES).optional(),
        openOnly: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query);
    const clauses = [
      eq(scheduleConstraints.companyId, req.companyId!),
      eq(scheduleConstraints.projectId, req.projectId!),
    ];
    if (q.scheduleId) clauses.push(eq(scheduleConstraints.scheduleId, q.scheduleId));
    if (q.status) clauses.push(eq(scheduleConstraints.status, q.status));
    if (q.category) clauses.push(eq(scheduleConstraints.category, q.category));
    if (q.openOnly === "true") {
      clauses.push(ne(scheduleConstraints.status, "cleared"), ne(scheduleConstraints.status, "void"));
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(scheduleConstraints).where(where);
    const items = await app.db
      .select()
      .from(scheduleConstraints)
      .where(where)
      .orderBy(desc(scheduleConstraints.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/projects/:projectId/schedule-constraints", { preHandler: standardGate }, async (req, reply) => {
    const body = constraintCreateSchema.parse(req.body);
    const schedule = await fetchSchedule(body.scheduleId, req.companyId!, req.projectId!);
    if (body.taskId) {
      const { task } = await fetchTask(body.taskId, req.companyId!, req.projectId!);
      if (task.scheduleId !== schedule.id) {
        throw badRequest("taskId does not belong to the given schedule");
      }
    }
    if (body.ownerId) await validateResponsibleId(body.ownerId, req.companyId!);
    const number = await nextRecordNumber(app.db, req.projectId!, "schedule_constraint");
    const id = newId("scn");
    await app.db.insert(scheduleConstraints).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      scheduleId: schedule.id,
      taskId: body.taskId ?? null,
      number,
      description: body.description,
      category: body.category,
      ownerId: body.ownerId ?? null,
      needByDate: body.needByDate ?? null,
      raisedBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "schedule_constraint",
      objectId: id,
      projectId: req.projectId!,
      payload: { number, description: body.description, category: body.category, needByDate: body.needByDate ?? null },
    });
    const [created] = await app.db
      .select()
      .from(scheduleConstraints)
      .where(eq(scheduleConstraints.id, id))
      .limit(1);
    return reply.status(201).send(created);
  });

  app.patch(
    "/projects/:projectId/schedule-constraints/:constraintId",
    { preHandler: standardGate },
    async (req) => {
      const { constraintId } = req.params as { constraintId: string };
      const body = constraintPatchSchema.parse(req.body);
      const [row] = await app.db
        .select()
        .from(scheduleConstraints)
        .where(
          and(
            eq(scheduleConstraints.id, constraintId),
            eq(scheduleConstraints.companyId, req.companyId!),
            eq(scheduleConstraints.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!row) throw notFound("Schedule constraint not found");
      if (body.ownerId) await validateResponsibleId(body.ownerId, req.companyId!);
      if (body.status && body.status !== row.status) {
        const allowed = CONSTRAINT_TRANSITIONS[row.status] ?? [];
        if (!allowed.includes(body.status)) {
          throw badRequest(`Cannot move a ${row.status} constraint to ${body.status}`);
        }
      }
      const now = new Date().toISOString();
      const set: Record<string, unknown> = { updatedAt: now };
      for (const [k, v] of Object.entries(body)) if (v !== undefined) set[k] = v;
      if (body.status === "cleared") {
        set["clearedAt"] = now;
        set["clearedBy"] = req.user!.id;
      }
      if (body.status === "open" && row.status === "cleared") {
        set["clearedAt"] = null;
        set["clearedBy"] = null;
        set["escalatedAt"] = null;
      }
      // A moved need-by date is a new promise: let the sweep escalate again.
      if (body.needByDate !== undefined && body.needByDate !== row.needByDate) {
        set["escalatedAt"] = null;
      }
      await app.db.update(scheduleConstraints).set(set).where(eq(scheduleConstraints.id, constraintId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: body.status && body.status !== row.status ? "state_change" : "update",
        objectType: "schedule_constraint",
        objectId: constraintId,
        projectId: req.projectId!,
        payload: { changed: Object.keys(body), from: row.status, to: body.status ?? row.status },
      });
      const [updated] = await app.db
        .select()
        .from(scheduleConstraints)
        .where(eq(scheduleConstraints.id, constraintId))
        .limit(1);
      return updated;
    },
  );

  /* ---------------------------------------------------------------- */
  /* Update narratives                                                 */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/schedules/:scheduleId/narratives",
    { preHandler: readGate },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      const rows = await app.db
        .select()
        .from(scheduleNarratives)
        .where(eq(scheduleNarratives.scheduleId, scheduleId))
        .orderBy(desc(scheduleNarratives.createdAt))
        .limit(100);
      return { items: rows, total: rows.length };
    },
  );

  app.post(
    "/projects/:projectId/schedules/:scheduleId/narratives",
    { preHandler: standardGate },
    async (req, reply) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const body = narrativeCreateSchema.parse(req.body);
      const schedule = await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      const tasks = await listTasks(scheduleId);
      const id = newId("nar");
      // Freeze the figures the narrative is written against, so a later
      // recompute cannot make the prose describe a programme that never was.
      const metrics = {
        computedFinish: schedule.computedFinish,
        computedDurationDays: schedule.computedDurationDays,
        dataDate: schedule.dataDate,
        taskCount: tasks.length,
        criticalCount: tasks.filter((t) => t.isCritical === 1).length,
        completeCount: tasks.filter((t) => t.actualFinish !== null).length,
        capturedAt: new Date().toISOString(),
      };
      await app.db.insert(scheduleNarratives).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        scheduleId,
        title: body.title,
        periodStart: body.periodStart ?? null,
        periodEnd: body.periodEnd ?? null,
        dataDate: body.dataDate ?? schedule.dataDate,
        body: body.body,
        metrics,
        authorId: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "schedule_narrative",
        objectId: id,
        projectId: req.projectId!,
        payload: { scheduleId, title: body.title, metrics },
      });
      const [created] = await app.db
        .select()
        .from(scheduleNarratives)
        .where(eq(scheduleNarratives.id, id))
        .limit(1);
      return reply.status(201).send(created);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Import (#349-350) — P6 XER and MS Project XML                      */
  /* ---------------------------------------------------------------- */

  const ALLOWED_IMPORT_MIME = new Set([
    "text/xml",
    "application/xml",
    "text/plain",
    "application/octet-stream",
    "application/x-msproject",
    "",
  ]);

  /** Decide the format from the declared field, the filename, then the bytes. */
  function sniffFormat(declared: string | undefined, fileName: string, text: string): "xer" | "mspdi" {
    if (declared === "xer" || declared === "mspdi") return declared;
    const lower = fileName.toLowerCase();
    if (lower.endsWith(".xer")) return "xer";
    if (lower.endsWith(".xml")) return "mspdi";
    const head = text.slice(0, 4000);
    if (head.includes("ERMHDR") || /(^|\n)%T\t/.test(head)) return "xer";
    if (head.includes("<Project")) return "mspdi";
    throw badRequest("Could not tell whether this is a P6 XER or an MS Project XML file — pass format explicitly");
  }

  /** Persist a parsed programme as a new schedule (optionally a revision). */
  async function materialiseImport(
    parsed: ParsedSchedule,
    ctx: {
      companyId: string;
      projectId: string;
      userId: string;
      name: string;
      target: Awaited<ReturnType<typeof fetchSchedule>> | null;
    },
  ): Promise<{ scheduleId: string; calendars: number; tasks: number; dependencies: number; resources: number }> {
    const scheduleId = newId("sch");
    const calendarIdByExternal = new Map<string, string>();
    const taskIdByExternal = new Map<string, string>();

    await app.db.transaction(async (tx) => {
      for (const c of parsed.calendars) {
        const id = newId("cal");
        calendarIdByExternal.set(c.externalId, id);
        await tx.insert(scheduleCalendars).values({
          id,
          companyId: ctx.companyId,
          projectId: ctx.projectId,
          scheduleId,
          name: c.name,
          externalId: c.externalId,
          workdays: c.workdays,
          holidays: c.holidays,
          exceptions: c.exceptions,
          hoursPerDay: c.hoursPerDay,
          isDefault: c.isDefault ? 1 : 0,
        });
      }
      const defaultCalendarId =
        parsed.calendars.find((c) => c.isDefault)?.externalId ?? parsed.calendars[0]?.externalId ?? null;

      await tx.insert(schedules).values({
        id: scheduleId,
        companyId: ctx.companyId,
        projectId: ctx.projectId,
        name: ctx.name,
        projectStart: parsed.projectStart,
        dataDate: parsed.dataDate,
        source: parsed.format,
        revision: ctx.target ? ctx.target.revision + 1 : 1,
        parentScheduleId: ctx.target ? (ctx.target.parentScheduleId ?? ctx.target.id) : null,
        defaultCalendarId: defaultCalendarId ? (calendarIdByExternal.get(defaultCalendarId) ?? null) : null,
        externalRef: parsed.externalRef,
        isActive: 0,
        createdBy: ctx.userId,
      });

      for (const t of parsed.tasks) {
        const id = newId("tsk");
        taskIdByExternal.set(t.externalId, id);
        await tx.insert(scheduleTasks).values({
          id,
          scheduleId,
          projectId: ctx.projectId,
          name: t.name.slice(0, 300),
          wbsCode: t.wbsCode?.slice(0, 60) ?? null,
          wbsPath: t.wbsPath?.slice(0, 300) ?? null,
          durationDays: t.durationDays,
          remainingDurationDays: t.remainingDurationDays,
          taskType: t.taskType,
          calendarId: t.calendarExternalId ? (calendarIdByExternal.get(t.calendarExternalId) ?? null) : null,
          externalId: t.externalId,
          constraintType: t.constraintType,
          constraintDate: t.constraintDate,
          actualStart: t.actualStart,
          actualFinish: t.actualFinish,
          percentComplete: t.percentComplete,
          isKeyMilestone: t.taskType === "start_milestone" || t.taskType === "finish_milestone" ? 1 : 0,
          sortOrder: t.sortOrder,
        });
      }

      for (const d of parsed.dependencies) {
        const predecessorId = taskIdByExternal.get(d.predecessorExternalId);
        const successorId = taskIdByExternal.get(d.successorExternalId);
        if (!predecessorId || !successorId || predecessorId === successorId) continue;
        await tx
          .insert(scheduleDependencies)
          .values({
            id: newId("dep"),
            scheduleId,
            predecessorId,
            successorId,
            depType: d.depType,
            lagDays: d.lagDays,
          })
          .onConflictDoNothing();
      }

      for (const r of parsed.resources) {
        const taskId = taskIdByExternal.get(r.taskExternalId);
        if (!taskId) continue;
        await tx.insert(scheduleTaskResources).values({
          id: newId("res"),
          companyId: ctx.companyId,
          projectId: ctx.projectId,
          scheduleId,
          taskId,
          name: r.name.slice(0, 200),
          resourceType: r.resourceType,
          externalId: r.externalId,
          unit: r.unit,
          budgetedUnits: r.budgetedUnits,
          actualUnits: r.actualUnits,
          remainingUnits: r.remainingUnits,
          unitRate: r.unitRate,
          budgetedCost: r.budgetedCost,
          actualCost: r.actualCost,
        });
      }
    });

    return {
      scheduleId,
      calendars: parsed.calendars.length,
      tasks: parsed.tasks.length,
      dependencies: parsed.dependencies.length,
      resources: parsed.resources.length,
    };
  }

  app.post("/projects/:projectId/schedules/import", { preHandler: standardGate }, async (req, reply) => {
    if (!req.isMultipart()) {
      throw badRequest("Expected multipart/form-data with a file (and optional fields format, name, targetScheduleId, dryRun)");
    }
    const mp = await req.file();
    if (!mp) throw badRequest("Expected a multipart file upload");
    if (!ALLOWED_IMPORT_MIME.has(mp.mimetype ?? "")) {
      throw badRequest(`Unsupported content type "${mp.mimetype}" — upload a P6 .xer or an MS Project .xml file`);
    }
    const buf = await mp.toBuffer();
    if (buf.byteLength === 0) throw badRequest("The uploaded file is empty");
    if (buf.byteLength > MAX_IMPORT_BYTES) {
      throw badRequest(`The file is ${Math.round(buf.byteLength / 1_048_576)} MiB — the limit is ${MAX_IMPORT_BYTES / 1_048_576} MiB`);
    }
    const fieldVal = (name: string): string | undefined => {
      const raw = (mp.fields as Record<string, unknown>)[name];
      const f = Array.isArray(raw) ? raw[0] : raw;
      const v = (f as { value?: unknown } | undefined)?.value;
      return typeof v === "string" && v.length > 0 ? v : undefined;
    };
    const text = buf.toString("utf8");
    const fileName = mp.filename ?? "upload";
    const format = sniffFormat(fieldVal("format"), fileName, text);
    const dryRun = fieldVal("dryRun") === "true";
    const targetScheduleId = fieldVal("targetScheduleId");
    const target = targetScheduleId
      ? await fetchSchedule(targetScheduleId, req.companyId!, req.projectId!)
      : null;

    let parsed: ParsedSchedule;
    try {
      parsed = format === "xer" ? parseXer(text) : parseMspdi(text);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "The file could not be parsed");
    }
    if (parsed.tasks.length === 0) {
      throw badRequest("The file contains no activities — nothing to import");
    }

    const name = fieldVal("name") ?? parsed.projectName ?? fileName.replace(/\.[^.]+$/, "");

    /* ---- diff against the target revision, before or after writing ---- */
    const targetTasks = target ? await listTasks(target.id) : [];
    const targetDeps = target ? await listDependencies(target.id) : [];
    const parsedAsDiff: DiffTask[] = parsed.tasks.map((t) => ({
      id: t.externalId,
      externalId: t.externalId,
      name: t.name,
      wbsCode: t.wbsCode,
      durationDays: t.durationDays,
      startDate: t.plannedStart,
      finishDate: t.plannedFinish,
      percentComplete: t.percentComplete,
    }));
    const targetAsDiff: DiffTask[] = targetTasks.map((t) => ({
      id: t.id,
      externalId: t.externalId,
      name: t.name,
      wbsCode: t.wbsCode,
      durationDays: t.durationDays,
      startDate: t.startDate,
      finishDate: t.finishDate,
      percentComplete: t.percentComplete,
      isCritical: t.isCritical === 1,
      totalFloat: t.totalFloat,
    }));
    const externalKeyed = new Map(parsed.tasks.map((t) => [t.externalId, t.externalId] as const));
    const diff = target
      ? diffRevisions(
          { tasks: targetAsDiff, dependencies: targetDeps },
          {
            tasks: parsedAsDiff,
            dependencies: parsed.dependencies
              .filter(
                (d) =>
                  externalKeyed.has(d.predecessorExternalId) && externalKeyed.has(d.successorExternalId),
              )
              .map((d) => ({
                predecessorId: d.predecessorExternalId,
                successorId: d.successorExternalId,
                depType: d.depType,
                lagDays: d.lagDays,
              })),
          },
        )
      : null;

    if (dryRun) {
      return {
        dryRun: true,
        format,
        fileName,
        byteSize: buf.byteLength,
        name,
        projectStart: parsed.projectStart,
        dataDate: parsed.dataDate,
        stats: {
          tasks: parsed.tasks.length,
          dependencies: parsed.dependencies.length,
          calendars: parsed.calendars.length,
          resources: parsed.resources.length,
        },
        warnings: parsed.warnings,
        targetScheduleId: target?.id ?? null,
        diff,
      };
    }

    const created = await materialiseImport(parsed, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      userId: req.user!.id,
      name,
      target,
    });
    const summary = await recomputeSchedule({ id: created.scheduleId });

    const importId = newId("imp");
    await app.db.insert(scheduleImports).values({
      id: importId,
      companyId: req.companyId!,
      projectId: req.projectId!,
      scheduleId: created.scheduleId,
      targetScheduleId: target?.id ?? null,
      format,
      fileName: fileName.slice(0, 300),
      byteSize: buf.byteLength,
      stats: {
        tasks: created.tasks,
        dependencies: created.dependencies,
        calendars: created.calendars,
        resources: created.resources,
      },
      diff: diff ? (diff as unknown as Record<string, unknown>) : null,
      warnings: parsed.warnings,
      importedBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "schedule_import",
      objectId: importId,
      projectId: req.projectId!,
      payload: {
        format,
        fileName,
        scheduleId: created.scheduleId,
        targetScheduleId: target?.id ?? null,
        tasks: created.tasks,
        dependencies: created.dependencies,
        warnings: parsed.warnings.length,
      },
    });

    const schedule = await fetchSchedule(created.scheduleId, req.companyId!, req.projectId!);
    return reply.status(201).send({
      importId,
      schedule,
      stats: { ...created, computed: summary },
      warnings: parsed.warnings,
      diff,
    });
  });

  app.get("/projects/:projectId/schedule-imports", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = and(
      eq(scheduleImports.companyId, req.companyId!),
      eq(scheduleImports.projectId, req.projectId!),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(scheduleImports).where(where);
    const items = await app.db
      .select()
      .from(scheduleImports)
      .where(where)
      .orderBy(desc(scheduleImports.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /* ---------------------------------------------------------------- */
  /* Export (#350)                                                      */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/schedules/:scheduleId/export",
    { preHandler: readGate },
    async (req, reply) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const q = z.object({ format: z.enum(SCHEDULE_FILE_FORMATS).default("mspdi") }).parse(req.query);
      if (q.format !== "mspdi") {
        throw badRequest("Only MS Project XML (mspdi) export is supported — P6 XER export is not implemented");
      }
      const schedule = await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      const tasks = await listTasks(scheduleId);
      const deps = await listDependencies(scheduleId);
      const calendarRows = await loadCalendars(req.companyId!, req.projectId!, scheduleId);
      const hoursPerDay =
        calendarRows.find((c) => c.id === schedule.defaultCalendarId)?.hoursPerDay ??
        calendarRows.find((c) => c.isDefault === 1)?.hoursPerDay ??
        8;
      const xml = exportMspdi({
        name: schedule.name,
        projectStart: schedule.projectStart,
        dataDate: schedule.dataDate,
        hoursPerDay,
        tasks: tasks.map((t) => ({
          id: t.id,
          name: t.name,
          wbsCode: t.wbsCode,
          durationDays: t.durationDays,
          startDate: t.startDate,
          finishDate: t.finishDate,
          actualStart: t.actualStart,
          actualFinish: t.actualFinish,
          percentComplete: t.percentComplete,
          taskType: t.taskType,
          totalFloat: t.totalFloat,
          isCritical: t.isCritical === 1,
          sortOrder: t.sortOrder,
        })),
        dependencies: deps.map((d) => ({
          predecessorId: d.predecessorId,
          successorId: d.successorId,
          depType: d.depType,
          lagDays: d.lagDays,
        })),
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "access",
        objectType: "schedule",
        objectId: scheduleId,
        projectId: req.projectId!,
        payload: { exported: "mspdi", taskCount: tasks.length },
      });
      const safeName = schedule.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "schedule";
      return reply
        .header("content-type", "application/xml; charset=utf-8")
        .header("content-disposition", `attachment; filename="${safeName}.xml"`)
        .send(xml);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Earned value (#363-369)                                           */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/schedules/:scheduleId/earned-value",
    { preHandler: readGate },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const q = earnedValueQuerySchema.parse(req.query);
      const schedule = await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      const tasks = await listTasks(scheduleId);
      const dataDate = q.dataDate ?? schedule.dataDate ?? todayISO();
      const reasons: string[] = [];

      /* ---- planned dates: a baseline when there is one ---- */
      const baselineWhere = q.baselineId
        ? and(
            eq(scheduleBaselines.id, q.baselineId),
            eq(scheduleBaselines.scheduleId, scheduleId),
            eq(scheduleBaselines.projectId, req.projectId!),
          )
        : and(
            eq(scheduleBaselines.scheduleId, scheduleId),
            eq(scheduleBaselines.projectId, req.projectId!),
          );
      const [baseline] = await app.db
        .select()
        .from(scheduleBaselines)
        .where(baselineWhere)
        .orderBy(asc(scheduleBaselines.capturedAt), asc(scheduleBaselines.id))
        .limit(1);
      if (q.baselineId && !baseline) throw notFound("Schedule baseline not found");
      const plannedById = new Map<string, { startDate: string | null; finishDate: string | null }>();
      if (baseline) {
        for (const s of (baseline.snapshot ?? []) as BaselineTaskRow[]) {
          plannedById.set(s.taskId, { startDate: s.startDate, finishDate: s.finishDate });
        }
      } else {
        reasons.push("No baseline exists — planned value is measured against the current programme dates, not an as-planned position");
      }

      /* ---- cost basis ---- */
      const resources = await app.db
        .select()
        .from(scheduleTaskResources)
        .where(eq(scheduleTaskResources.scheduleId, scheduleId));
      const resourceBudget = new Map<string, number>();
      const resourceActual = new Map<string, number>();
      for (const r of resources) {
        resourceBudget.set(r.taskId, (resourceBudget.get(r.taskId) ?? 0) + r.budgetedCost);
        resourceActual.set(r.taskId, (resourceActual.get(r.taskId) ?? 0) + r.actualCost);
      }

      const lineIds = [...new Set(tasks.map((t) => t.budgetLineItemId).filter((x): x is string => x !== null))];
      const lines =
        lineIds.length > 0
          ? await app.db
              .select()
              .from(budgetLineItems)
              .where(
                and(
                  inArray(budgetLineItems.id, lineIds),
                  eq(budgetLineItems.companyId, req.companyId!),
                  eq(budgetLineItems.projectId, req.projectId!),
                ),
              )
          : [];
      const lineById = new Map(lines.map((l) => [l.id, l] as const));
      const tasksPerLine = new Map<string, number>();
      for (const t of tasks) {
        if (!t.budgetLineItemId) continue;
        tasksPerLine.set(t.budgetLineItemId, (tasksPerLine.get(t.budgetLineItemId) ?? 0) + 1);
      }
      const sharedLines = [...tasksPerLine.entries()].filter(([, n]) => n > 1);
      if (sharedLines.length > 0) {
        reasons.push(
          `${sharedLines.length} budget line(s) are mapped to more than one activity — their budget and cost are split equally across those activities`,
        );
      }

      /* ---- currency: the project's active budget decides, never a guess ---- */
      const [activeBudget] = await app.db
        .select({ currency: budgets.currency })
        .from(budgets)
        .where(
          and(
            eq(budgets.companyId, req.companyId!),
            eq(budgets.projectId, req.projectId!),
            eq(budgets.isActive, 1),
          ),
        )
        .limit(1);
      const currency = q.currency ?? activeBudget?.currency ?? "USD";
      if (!q.currency && !activeBudget) {
        reasons.push("No active budget was found — figures are reported in USD by default; pass ?currency= to override");
      }

      const activities: EvActivity[] = tasks
        .filter((t) => t.taskType !== "wbs_summary")
        .map((t) => {
          const planned = plannedById.get(t.id) ?? { startDate: t.startDate, finishDate: t.finishDate };
          const line = t.budgetLineItemId ? lineById.get(t.budgetLineItemId) : undefined;
          const share = t.budgetLineItemId ? (tasksPerLine.get(t.budgetLineItemId) ?? 1) : 1;
          const bac =
            t.budgetedCost ??
            (resourceBudget.has(t.id) ? resourceBudget.get(t.id)! : undefined) ??
            (line ? line.revisedBudget / share : null);
          const actualCost =
            (resourceActual.has(t.id) ? resourceActual.get(t.id)! : undefined) ??
            (line ? line.jobToDateCosts / share : null);
          return {
            id: t.id,
            name: t.name,
            bac: bac ?? null,
            actualCost,
            percentComplete: t.percentComplete,
            plannedStart: planned.startDate,
            plannedFinish: planned.finishDate,
            durationDays: t.durationDays,
            isCritical: t.isCritical === 1,
          };
        });

      const result = computeEarnedValue({ dataDate, currency, activities });
      return {
        scheduleId,
        scheduleName: schedule.name,
        baselineId: baseline?.id ?? null,
        baselineName: baseline?.name ?? null,
        basis: baseline ? "baseline dates" : "current programme dates",
        ...result,
        reasons: [...reasons, ...result.reasons],
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Milestones & calendar view (#362)                                  */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/schedules/:scheduleId/milestones",
    { preHandler: readGate },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const schedule = await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      const tasks = await listTasks(scheduleId);
      const milestones = tasks.filter(
        (t) =>
          t.isKeyMilestone === 1 ||
          t.taskType === "start_milestone" ||
          t.taskType === "finish_milestone" ||
          t.durationDays === 0,
      );
      const items = milestones.map((t) => {
        const forecast = t.actualFinish ?? t.finishDate;
        const slipDays =
          t.contractualDate && forecast ? diffDays(forecast, t.contractualDate) : null;
        return {
          id: t.id,
          name: t.name,
          wbsCode: t.wbsCode,
          isKeyMilestone: t.isKeyMilestone === 1,
          contractualDate: t.contractualDate,
          forecastDate: forecast,
          actualFinish: t.actualFinish,
          slipDays,
          status:
            t.actualFinish !== null
              ? "achieved"
              : slipDays === null
                ? "untracked"
                : slipDays > 0
                  ? "late"
                  : "on_track",
          totalFloat: t.totalFloat,
          isCritical: t.isCritical === 1,
          responsibleId: t.responsibleId,
          slipAlertedDays: t.slipAlertedDays,
        };
      });
      return {
        scheduleId,
        scheduleName: schedule.name,
        items,
        total: items.length,
        untracked: items.filter((m) => m.status === "untracked").length,
        late: items.filter((m) => m.status === "late").length,
      };
    },
  );

  /** Run the milestone-slip sweep on demand (the scheduler runs it hourly). */
  app.post(
    "/projects/:projectId/schedules/:scheduleId/milestone-sweep",
    { preHandler: standardGate },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      return sweepMilestoneSlips(app.db, req.companyId!, new Date(), {
        projectId: req.projectId!,
        scheduleId,
      });
    },
  );

  /**
   * Calendar view data (#352): activities and milestones bucketed by day for
   * the requested window, plus the non-working days of the governing calendar
   * so the client can shade them without re-deriving the week.
   */
  app.get(
    "/projects/:projectId/schedules/:scheduleId/calendar-view",
    { preHandler: readGate },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const q = calendarViewQuerySchema.parse(req.query);
      const schedule = await fetchSchedule(scheduleId, req.companyId!, req.projectId!);
      const from = q.from ?? schedule.dataDate ?? todayISO();
      const to = q.to ?? addDaysISO(from, 42);
      if (to <= from) throw badRequest("to must be after from");
      if (dayFromIso(to, from) > 400) throw badRequest("The calendar window may not exceed 400 days");

      const tasks = await listTasks(scheduleId);
      const calendarRows = await loadCalendars(req.companyId!, req.projectId!, scheduleId);
      const governing =
        calendarRows.find((c) => c.id === schedule.defaultCalendarId) ??
        calendarRows.find((c) => c.isDefault === 1) ??
        null;
      const holidays = new Set(governing?.holidays ?? []);
      const exceptions = new Set(governing?.exceptions ?? []);
      const workdays = governing?.workdays ?? [1, 1, 1, 1, 1, 1, 1];

      const days: {
        date: string;
        working: boolean;
        starting: { id: string; name: string; isCritical: boolean }[];
        finishing: { id: string; name: string; isCritical: boolean; isMilestone: boolean }[];
        inProgress: number;
      }[] = [];
      const spanDays = dayFromIso(to, from);
      for (let i = 0; i < spanDays; i += 1) {
        const date = addDaysISO(from, i);
        const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
        const working = exceptions.has(date) || (!holidays.has(date) && workdays[dow] === 1);
        const starting = tasks
          .filter((t) => (t.actualStart ?? t.startDate) === date)
          .map((t) => ({ id: t.id, name: t.name, isCritical: t.isCritical === 1 }));
        const finishing = tasks
          .filter((t) => (t.actualFinish ?? t.finishDate) === date)
          .map((t) => ({
            id: t.id,
            name: t.name,
            isCritical: t.isCritical === 1,
            isMilestone: t.durationDays === 0 || t.isKeyMilestone === 1,
          }));
        const inProgress = tasks.filter((t) => {
          const s = t.actualStart ?? t.startDate;
          const f = t.actualFinish ?? t.finishDate;
          return s !== null && f !== null && s <= date && f >= date;
        }).length;
        days.push({ date, working, starting, finishing, inProgress });
      }
      return {
        scheduleId,
        from,
        to,
        calendarId: governing?.id ?? null,
        calendarName: governing?.name ?? null,
        days,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Health inputs (contract 3.5)                                      */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/schedule/health-inputs", { preHandler: readGate }, async (req) => {
    const reasons: string[] = [];
    const [active] = await app.db
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.companyId, req.companyId!),
          eq(schedules.projectId, req.projectId!),
          eq(schedules.isActive, 1),
        ),
      )
      .orderBy(desc(schedules.createdAt))
      .limit(1);
    if (!active) {
      return {
        metrics: {
          scheduleQualityScore: null,
          criticalTaskCount: null,
          negativeFloatTaskCount: null,
          milestoneSlipMaxDays: null,
          milestonesLate: null,
          completionMovementDays: null,
          openConstraints: null,
          overdueConstraints: null,
          percentComplete: null,
        },
        reasons: ["The project has no active schedule"],
      };
    }

    const tasks = await listTasks(active.id);
    const { report } = await buildQualityReport(req.companyId!, req.projectId!, active.id);
    const constraints = await countOpenConstraints(app.db, req.companyId!, req.projectId!, new Date());
    const untracked = await untrackedMilestones(app.db, active.id);
    if (untracked > 0) {
      reasons.push(`${untracked} key milestone(s) carry no contractual date and cannot be tracked for slip`);
    }

    const [baseline] = await app.db
      .select()
      .from(scheduleBaselines)
      .where(eq(scheduleBaselines.scheduleId, active.id))
      .orderBy(asc(scheduleBaselines.capturedAt))
      .limit(1);
    const completionMovementDays =
      baseline?.computedFinish && active.computedFinish
        ? diffDays(active.computedFinish, baseline.computedFinish)
        : null;
    if (completionMovementDays === null) {
      reasons.push("No baseline has been captured — completion movement is not available");
    }

    const milestoneSlips = tasks
      .filter((t) => t.isKeyMilestone === 1 && t.contractualDate)
      .map((t) => {
        const forecast = t.actualFinish ?? t.finishDate;
        return forecast ? diffDays(forecast, t.contractualDate!) : null;
      })
      .filter((n): n is number => n !== null);

    const durationTotal = tasks.reduce((sum, t) => sum + Math.max(t.durationDays, 0), 0);
    const earned = tasks.reduce(
      (sum, t) => sum + (Math.max(t.durationDays, 0) * t.percentComplete) / 100,
      0,
    );

    return {
      scheduleId: active.id,
      scheduleName: active.name,
      metrics: {
        scheduleQualityScore: report.score,
        criticalTaskCount: tasks.filter((t) => t.isCritical === 1).length,
        negativeFloatTaskCount: tasks.filter((t) => t.totalFloat !== null && t.totalFloat < 0).length,
        milestoneSlipMaxDays: milestoneSlips.length > 0 ? Math.max(...milestoneSlips) : null,
        milestonesLate: milestoneSlips.filter((d) => d > 0).length,
        completionMovementDays,
        openConstraints: constraints.open,
        overdueConstraints: constraints.overdue,
        percentComplete: durationTotal > 0 ? Math.round((earned / durationTotal) * 1000) / 10 : null,
      },
      reasons,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Scheduler jobs (§6.1 — no sweep may depend on a page being open)  */
  /* ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- */
  /* Company-wide search (contract §3.3)                               */
  /*                                                                    */
  /* "Where is 'Level 3 slab pour'?" is one of the most common questions */
  /* on a live job. schedule_tasks carries no companyId of its own, so   */
  /* this is a hand-written source that joins the schedule header for    */
  /* the tenant filter rather than a tableSource.                        */
  /* ---------------------------------------------------------------- */

  registerSearchSource({
    type: "schedule_task",
    label: "Schedule activities",
    tool: "schedule",
    scope: "project",
    /* An activity is a weaker hit than the record it belongs to. */
    weight: 0.8,
    href: (r) => (r.projectId ? `/projects/${r.projectId}/schedule?taskId=${r.id}` : "/"),
    query: async (db, ctx) => {
      if (ctx.terms.length === 0) return [];
      if (ctx.projectIds !== null && ctx.projectIds.length === 0) return [];
      const conds = [eq(schedules.companyId, ctx.companyId)];
      if (ctx.projectId) conds.push(eq(scheduleTasks.projectId, ctx.projectId));
      else if (ctx.projectIds !== null) conds.push(inArray(scheduleTasks.projectId, ctx.projectIds));
      for (const term of ctx.terms) {
        const pattern = likePattern(term);
        conds.push(
          or(
            sql`${scheduleTasks.name} ilike ${pattern}`,
            sql`${scheduleTasks.wbsCode} ilike ${pattern}`,
          )!,
        );
      }
      const rows = await db
        .select({
          id: scheduleTasks.id,
          projectId: scheduleTasks.projectId,
          name: scheduleTasks.name,
          wbsCode: scheduleTasks.wbsCode,
          scheduleName: schedules.name,
          startDate: scheduleTasks.startDate,
          finishDate: scheduleTasks.finishDate,
          updatedAt: scheduleTasks.updatedAt,
        })
        .from(scheduleTasks)
        .innerJoin(schedules, eq(schedules.id, scheduleTasks.scheduleId))
        .where(and(...conds))
        .limit(ctx.limit);
      return rows.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        title: r.name,
        subtitle:
          r.startDate && r.finishDate
            ? `${r.scheduleName} · ${r.startDate} → ${r.finishDate}`
            : r.scheduleName,
        reference: r.wbsCode,
        status: null,
        updatedAt: r.updatedAt,
      }));
    },
  });

  app.scheduler.register({
    name: "schedule.milestone-slip",
    description:
      "Compare key milestones against their contractual dates and raise a signal when a slip appears or grows",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => {
      let slipped = 0;
      let alerted = 0;
      const result = await forEachCompany(db, async (companyId) => {
        const summary = await sweepMilestoneSlips(db, companyId, now);
        slipped += summary.slipped;
        alerted += summary.alerted;
      });
      return { ...result, slipped, alerted };
    },
  });

  app.scheduler.register({
    name: "schedule.constraints",
    description: "Escalate lookahead constraints that are past their need-by date and still open",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => {
      let escalated = 0;
      const result = await forEachCompany(db, async (companyId) => {
        const summary = await sweepConstraints(db, companyId, now);
        escalated += summary.escalated;
      });
      return { ...result, escalated };
    },
  });
};
