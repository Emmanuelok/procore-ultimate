import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import {
  boqItems,
  boqs,
  contractEvents,
  contracts,
  dailyLogs,
  delayEvents,
  evidence,
  forensicClaims,
  rfis,
  scheduleBaselines,
  scheduleDependencies,
  scheduleTasks,
  schedules,
  variations,
} from "@constructos/db";
import { CLAIM_KINDS, CLAIM_STATUSES, DELAY_CAUSES, DELAY_EVENT_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema } from "../field/dates.js";
import { dayFromIso, type CpmDependencyInput, type CpmTaskInput } from "../../lib/cpm.js";
import { runFragnetTia } from "./tia.js";
import { computeProlongation } from "./prolongation.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const boolQuery = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .optional();

const delayEventCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  cause: z.enum(DELAY_CAUSES),
  excusable: z.boolean(),
  compensable: z.boolean(),
  taskId: z.string().min(1).nullable().optional(),
  scheduleId: z.string().min(1).nullable().optional(),
  startDate: isoDateSchema,
  durationDays: z.number().int().min(1).max(10000),
  contractEventId: z.string().min(1).nullable().optional(),
  evidenceIds: z.array(z.string().min(1)).max(200).optional(),
});

const delayEventPatchSchema = delayEventCreateSchema.partial();

const delayEventListQuery = pageQuerySchema.extend({
  cause: z.enum(DELAY_CAUSES).optional(),
  status: z.enum(DELAY_EVENT_STATUSES).optional(),
  excusable: boolQuery,
  compensable: boolQuery,
});

const delayEventStatusSchema = z.object({ status: z.enum(DELAY_EVENT_STATUSES) });

const chainSchema = z.object({
  cause: z.string().max(20000).optional(),
  effect: z.string().max(20000).optional(),
  entitlement: z.string().max(20000).optional(),
  quantum: z.string().max(20000).optional(),
});

const prolongationBlockSchema = z.object({
  compensableDays: z.number().min(0).optional(),
  prelimsRatePerDay: z.number().min(0).optional(),
  amount: z.number().min(0).optional(),
  derivation: z.string().max(2000).optional(),
});

const claimCreateSchema = z.object({
  title: z.string().min(1).max(300),
  kind: z.enum(CLAIM_KINDS),
  contractId: z.string().min(1).nullable().optional(),
  clauseRef: z.string().min(1).max(40).nullable().optional(),
  delayEventIds: z.array(z.string().min(1)).max(200).optional(),
  chain: chainSchema.optional(),
  daysClaimed: z.number().int().min(0).max(10000).nullable().optional(),
  amountClaimed: z.number().min(0).nullable().optional(),
  prolongation: prolongationBlockSchema.nullable().optional(),
});

const claimPatchSchema = claimCreateSchema.omit({ kind: true }).partial();

const claimListQuery = pageQuerySchema.extend({
  kind: z.enum(CLAIM_KINDS).optional(),
  status: z.enum(CLAIM_STATUSES).optional(),
});

const claimStatusSchema = z.object({
  status: z.enum(["submitted", "assessed", "agreed", "rejected", "withdrawn"]),
  daysAssessed: z.number().int().min(0).max(10000).optional(),
  amountAssessed: z.number().min(0).optional(),
});

/** draft → submitted → assessed → agreed | rejected; withdrawn pre-agreement. */
const CLAIM_TRANSITIONS: Record<string, string[]> = {
  draft: ["submitted", "withdrawn"],
  submitted: ["assessed", "withdrawn"],
  assessed: ["agreed", "rejected", "withdrawn"],
  agreed: [],
  rejected: [],
  withdrawn: [],
};

const prolongationBodySchema = z.object({
  compensableDays: z.number().int().min(0).max(10000),
  prelimsRatePerDay: z.number().positive().optional(),
});

const analysisQuerySchema = z.object({
  scheduleId: z.string().min(1).optional(),
  baselineId: z.string().min(1).optional(),
});

const windowsQuerySchema = analysisQuerySchema.extend({
  boundaries: z.string().min(1),
});

interface BaselineTaskSnapshot {
  taskId: string;
  name?: string;
  wbsCode?: string | null;
  durationDays?: number;
  startDate?: string | null;
  finishDate?: string | null;
  totalFloat?: number | null;
  isCritical?: boolean | number;
}

const maxIso = (dates: (string | null | undefined)[]): string | null => {
  let max: string | null = null;
  for (const d of dates) if (d && (max === null || d > max)) max = d;
  return max;
};

/**
 * Delay & disruption forensics — spec Vol II Domain D / M9 (#265-320
 * foundation subset): delay event register with entitlement classification
 * (#265-268), per-event Time Impact Analysis by fragnet insertion (#272),
 * as-planned vs as-built comparison against a captured baseline (#269),
 * windows attribution of delay events (#273, honestly scoped), a prolongation
 * calculator seeded from time-related preliminaries (#299-301), and a claims
 * workspace enforcing the cause-effect-entitlement-quantum chain with
 * chronology auto-assembly from platform records (#304-320).
 */
export const forensicsModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("forensics", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("forensics", "standard"),
  ];

  /* ---------------------------------------------------------------- */
  /* Shared fetch / validation helpers                                 */
  /* ---------------------------------------------------------------- */

  async function fetchDelayEvent(eventId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(delayEvents)
      .where(
        and(
          eq(delayEvents.id, eventId),
          eq(delayEvents.companyId, companyId),
          eq(delayEvents.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Delay event not found");
    return rows[0];
  }

  async function fetchClaim(claimId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(forensicClaims)
      .where(
        and(
          eq(forensicClaims.id, claimId),
          eq(forensicClaims.companyId, companyId),
          eq(forensicClaims.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Claim not found");
    return rows[0];
  }

  /**
   * Resolve and validate the (taskId, scheduleId) pair of a delay event:
   * a bare taskId resolves against the project's active schedule and the
   * resolved scheduleId is stored so the fragnet insertion point is stable.
   */
  async function resolveTaskSchedule(
    companyId: string,
    projectId: string,
    taskId: string | null,
    scheduleId: string | null,
  ): Promise<{ taskId: string | null; scheduleId: string | null }> {
    if (!taskId && !scheduleId) return { taskId: null, scheduleId: null };
    let resolvedScheduleId = scheduleId;
    if (resolvedScheduleId) {
      const [sched] = await app.db
        .select({ id: schedules.id })
        .from(schedules)
        .where(
          and(
            eq(schedules.id, resolvedScheduleId),
            eq(schedules.companyId, companyId),
            eq(schedules.projectId, projectId),
          ),
        )
        .limit(1);
      if (!sched) throw badRequest("scheduleId does not reference a schedule in this project");
    } else {
      const [active] = await app.db
        .select({ id: schedules.id })
        .from(schedules)
        .where(
          and(
            eq(schedules.companyId, companyId),
            eq(schedules.projectId, projectId),
            eq(schedules.isActive, 1),
          ),
        )
        .orderBy(desc(schedules.createdAt))
        .limit(1);
      if (!active) {
        throw badRequest(
          "taskId was given without scheduleId and the project has no active schedule",
        );
      }
      resolvedScheduleId = active.id;
    }
    if (taskId) {
      const [task] = await app.db
        .select({ id: scheduleTasks.id })
        .from(scheduleTasks)
        .where(
          and(
            eq(scheduleTasks.id, taskId),
            eq(scheduleTasks.scheduleId, resolvedScheduleId),
            eq(scheduleTasks.projectId, projectId),
          ),
        )
        .limit(1);
      if (!task) throw badRequest("taskId does not belong to the resolved schedule");
    }
    return { taskId: taskId ?? null, scheduleId: resolvedScheduleId };
  }

  async function validateContractEventId(
    contractEventId: string,
    companyId: string,
    projectId: string,
  ): Promise<void> {
    const [row] = await app.db
      .select({ id: contractEvents.id })
      .from(contractEvents)
      .where(
        and(
          eq(contractEvents.id, contractEventId),
          eq(contractEvents.companyId, companyId),
          eq(contractEvents.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw badRequest("contractEventId does not reference a contract event in this project");
  }

  async function validateEvidenceIds(
    ids: string[],
    companyId: string,
    projectId: string,
  ): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const rows = await app.db
      .select({ id: evidence.id })
      .from(evidence)
      .where(
        and(
          inArray(evidence.id, unique),
          eq(evidence.companyId, companyId),
          eq(evidence.projectId, projectId),
        ),
      );
    if (rows.length !== unique.length) {
      throw badRequest("One or more evidenceIds do not reference evidence in this project");
    }
    return unique;
  }

  async function resolveSchedule(companyId: string, projectId: string, scheduleId?: string) {
    if (scheduleId) {
      const [row] = await app.db
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
      if (!row) throw badRequest("scheduleId does not reference a schedule in this project");
      return row;
    }
    const [active] = await app.db
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.companyId, companyId),
          eq(schedules.projectId, projectId),
          eq(schedules.isActive, 1),
        ),
      )
      .orderBy(desc(schedules.createdAt))
      .limit(1);
    if (!active) {
      throw badRequest("The project has no active schedule — provide scheduleId explicitly");
    }
    return active;
  }

  async function resolveBaseline(scheduleId: string, projectId: string, baselineId?: string) {
    if (baselineId) {
      const [row] = await app.db
        .select()
        .from(scheduleBaselines)
        .where(
          and(eq(scheduleBaselines.id, baselineId), eq(scheduleBaselines.projectId, projectId)),
        )
        .limit(1);
      if (!row || row.scheduleId !== scheduleId) {
        throw badRequest("baselineId does not reference a baseline of this schedule");
      }
      return row;
    }
    const [earliest] = await app.db
      .select()
      .from(scheduleBaselines)
      .where(
        and(
          eq(scheduleBaselines.scheduleId, scheduleId),
          eq(scheduleBaselines.projectId, projectId),
        ),
      )
      .orderBy(asc(scheduleBaselines.capturedAt), asc(scheduleBaselines.id))
      .limit(1);
    return earliest;
  }

  async function loadCpmInputs(
    scheduleId: string,
    projectId: string,
  ): Promise<{ tasks: CpmTaskInput[]; deps: CpmDependencyInput[] }> {
    const taskRows = await app.db
      .select()
      .from(scheduleTasks)
      .where(and(eq(scheduleTasks.scheduleId, scheduleId), eq(scheduleTasks.projectId, projectId)));
    const depRows = await app.db
      .select()
      .from(scheduleDependencies)
      .where(eq(scheduleDependencies.scheduleId, scheduleId));
    return {
      tasks: taskRows.map((t) => ({
        id: t.id,
        duration: t.durationDays,
        constraintType: (t.constraintType ?? null) as CpmTaskInput["constraintType"],
        constraintDate: t.constraintDate,
        actualStart: t.actualStart,
        actualFinish: t.actualFinish,
      })),
      deps: depRows.map((d) => ({
        predecessorId: d.predecessorId,
        successorId: d.successorId,
        type: d.depType as CpmDependencyInput["type"],
        lagDays: d.lagDays,
      })),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Delay event register (#265-268)                                   */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/delay-events", { preHandler: standardGate }, async (req, reply) => {
    const body = delayEventCreateSchema.parse(req.body);
    // Entitlement classification rule (#267): compensability presupposes
    // excusability — a non-excusable compensable delay is a contradiction.
    if (body.compensable && !body.excusable) {
      throw badRequest("A delay cannot be compensable without being excusable");
    }
    const { taskId, scheduleId } = await resolveTaskSchedule(
      req.companyId!,
      req.projectId!,
      body.taskId ?? null,
      body.scheduleId ?? null,
    );
    if (body.contractEventId) {
      await validateContractEventId(body.contractEventId, req.companyId!, req.projectId!);
    }
    const evidenceIds = await validateEvidenceIds(
      body.evidenceIds ?? [],
      req.companyId!,
      req.projectId!,
    );
    const number = await nextRecordNumber(app.db, req.projectId!, "delay_event");
    const id = newId("dly");
    await app.db.insert(delayEvents).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      number,
      title: body.title,
      description: body.description ?? null,
      cause: body.cause,
      excusable: body.excusable ? 1 : 0,
      compensable: body.compensable ? 1 : 0,
      status: "open",
      taskId,
      scheduleId,
      startDate: body.startDate,
      durationDays: body.durationDays,
      contractEventId: body.contractEventId ?? null,
      evidenceIds,
      raisedBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "delay_event",
      objectId: id,
      payload: {
        number,
        title: body.title,
        cause: body.cause,
        excusable: body.excusable,
        compensable: body.compensable,
        startDate: body.startDate,
        durationDays: body.durationDays,
        taskId,
        scheduleId,
        contractEventId: body.contractEventId ?? null,
        evidenceIds,
      },
      storePayload: true,
    });
    const created = await fetchDelayEvent(id, req.companyId!, req.projectId!);
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/delay-events", { preHandler: readGate }, async (req) => {
    const q = delayEventListQuery.parse(req.query);
    const clauses = [
      eq(delayEvents.companyId, req.companyId!),
      eq(delayEvents.projectId, req.projectId!),
    ];
    if (q.cause) clauses.push(eq(delayEvents.cause, q.cause));
    if (q.status) clauses.push(eq(delayEvents.status, q.status));
    if (q.excusable !== undefined) clauses.push(eq(delayEvents.excusable, q.excusable ? 1 : 0));
    if (q.compensable !== undefined) {
      clauses.push(eq(delayEvents.compensable, q.compensable ? 1 : 0));
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(delayEvents).where(where);
    const items = await app.db
      .select()
      .from(delayEvents)
      .where(where)
      .orderBy(desc(delayEvents.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/delay-events/:eventId", { preHandler: readGate }, async (req) => {
    const { eventId } = req.params as { eventId: string };
    const ev = await fetchDelayEvent(eventId, req.companyId!, req.projectId!);

    let task: { id: string; name: string } | null = null;
    if (ev.taskId) {
      const [t] = await app.db
        .select({ id: scheduleTasks.id, name: scheduleTasks.name })
        .from(scheduleTasks)
        .where(and(eq(scheduleTasks.id, ev.taskId), eq(scheduleTasks.projectId, req.projectId!)))
        .limit(1);
      task = t ?? null;
    }

    let contractEvent: { id: string; number: number; title: string } | null = null;
    if (ev.contractEventId) {
      const [ce] = await app.db
        .select({
          id: contractEvents.id,
          number: contractEvents.number,
          title: contractEvents.title,
        })
        .from(contractEvents)
        .where(
          and(
            eq(contractEvents.id, ev.contractEventId),
            eq(contractEvents.projectId, req.projectId!),
          ),
        )
        .limit(1);
      contractEvent = ce ?? null;
    }

    const evidenceIds = ev.evidenceIds ?? [];
    const evidenceRows =
      evidenceIds.length > 0
        ? await app.db
            .select({
              id: evidence.id,
              kind: evidence.kind,
              source: evidence.source,
              capturedAt: evidence.capturedAt,
              independenceScore: evidence.independenceScore,
            })
            .from(evidence)
            .where(
              and(inArray(evidence.id, evidenceIds), eq(evidence.projectId, req.projectId!)),
            )
        : [];

    return { ...ev, task, contractEvent, evidence: evidenceRows };
  });

  app.patch("/projects/:projectId/delay-events/:eventId", { preHandler: standardGate }, async (req) => {
    const { eventId } = req.params as { eventId: string };
    const body = delayEventPatchSchema.parse(req.body);
    const ev = await fetchDelayEvent(eventId, req.companyId!, req.projectId!);

    const nextExcusable = body.excusable !== undefined ? body.excusable : ev.excusable === 1;
    const nextCompensable = body.compensable !== undefined ? body.compensable : ev.compensable === 1;
    if (nextCompensable && !nextExcusable) {
      throw badRequest("A delay cannot be compensable without being excusable");
    }

    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.title !== undefined) set["title"] = body.title;
    if (body.description !== undefined) set["description"] = body.description;
    if (body.cause !== undefined) set["cause"] = body.cause;
    if (body.excusable !== undefined) set["excusable"] = body.excusable ? 1 : 0;
    if (body.compensable !== undefined) set["compensable"] = body.compensable ? 1 : 0;
    if (body.startDate !== undefined) set["startDate"] = body.startDate;
    if (body.durationDays !== undefined) set["durationDays"] = body.durationDays;
    if (body.startDate !== undefined || body.durationDays !== undefined) {
      // the modelled delay changed — a previously computed TIA is stale
      set["tiaResult"] = null;
    }

    if (body.taskId !== undefined || body.scheduleId !== undefined) {
      const resolved = await resolveTaskSchedule(
        req.companyId!,
        req.projectId!,
        body.taskId !== undefined ? body.taskId : ev.taskId,
        body.scheduleId !== undefined ? body.scheduleId : ev.scheduleId,
      );
      set["taskId"] = resolved.taskId;
      set["scheduleId"] = resolved.scheduleId;
      // the fragnet insertion point moved — a previous TIA no longer applies
      set["tiaResult"] = null;
    }
    if (body.contractEventId !== undefined) {
      if (body.contractEventId) {
        await validateContractEventId(body.contractEventId, req.companyId!, req.projectId!);
      }
      set["contractEventId"] = body.contractEventId;
    }
    if (body.evidenceIds !== undefined) {
      set["evidenceIds"] = await validateEvidenceIds(
        body.evidenceIds,
        req.companyId!,
        req.projectId!,
      );
    }

    await app.db.update(delayEvents).set(set).where(eq(delayEvents.id, eventId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "delay_event",
      objectId: eventId,
      payload: { changed: Object.keys(body) },
    });
    return fetchDelayEvent(eventId, req.companyId!, req.projectId!);
  });

  app.post(
    "/projects/:projectId/delay-events/:eventId/status",
    { preHandler: standardGate },
    async (req) => {
      const { eventId } = req.params as { eventId: string };
      const body = delayEventStatusSchema.parse(req.body);
      const ev = await fetchDelayEvent(eventId, req.companyId!, req.projectId!);
      if (ev.status === body.status) {
        throw badRequest(`Delay event is already ${body.status}`);
      }
      await app.db
        .update(delayEvents)
        .set({ status: body.status, updatedAt: new Date().toISOString() })
        .where(eq(delayEvents.id, eventId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "delay_event",
        objectId: eventId,
        payload: { from: ev.status, to: body.status },
      });
      return fetchDelayEvent(eventId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Time Impact Analysis (#272)                                       */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/delay-events/:eventId/tia",
    { preHandler: standardGate },
    async (req) => {
      const { eventId } = req.params as { eventId: string };
      const ev = await fetchDelayEvent(eventId, req.companyId!, req.projectId!);
      if (!ev.taskId || !ev.scheduleId) {
        throw badRequest(
          "TIA requires the delay event to reference a schedule task (taskId and scheduleId)",
        );
      }
      const schedule = await resolveSchedule(req.companyId!, req.projectId!, ev.scheduleId);
      const { tasks, deps } = await loadCpmInputs(ev.scheduleId, req.projectId!);
      if (!tasks.some((t) => t.id === ev.taskId)) {
        throw badRequest("The delay event's task no longer exists in its schedule");
      }
      const result = runFragnetTia({
        tasks,
        deps,
        projectStart: schedule.projectStart,
        struckTaskId: ev.taskId,
        fragnetDurationDays: ev.durationDays,
        fragnetStartDate: ev.startDate,
      });
      if (!result.ok) {
        throw badRequest("Schedule logic contains a dependency cycle — TIA cannot run", {
          cycle: result.cycle,
        });
      }
      const tiaResult = {
        completionDeltaDays: result.completionDeltaDays,
        beforeFinish: result.beforeFinish,
        afterFinish: result.afterFinish,
        computedAt: new Date().toISOString(),
      };
      await app.db
        .update(delayEvents)
        .set({ tiaResult, updatedAt: new Date().toISOString() })
        .where(eq(delayEvents.id, eventId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "delay_event",
        objectId: eventId,
        payload: { tia: tiaResult, scheduleId: ev.scheduleId, taskId: ev.taskId },
      });
      return { eventId, scheduleId: ev.scheduleId, taskId: ev.taskId, ...tiaResult };
    },
  );

  /* ---------------------------------------------------------------- */
  /* As-planned vs as-built (#269)                                     */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/forensics/as-planned-vs-as-built",
    { preHandler: readGate },
    async (req) => {
      const q = analysisQuerySchema.parse(req.query);
      const schedule = await resolveSchedule(req.companyId!, req.projectId!, q.scheduleId);
      const baseline = await resolveBaseline(schedule.id, req.projectId!, q.baselineId);
      if (!baseline) {
        throw badRequest(
          `Schedule "${schedule.name}" has no baseline — capture a baseline to compare ` +
            "as-planned against as-built",
        );
      }
      const snapshot = (baseline.snapshot ?? []) as BaselineTaskSnapshot[];
      const planned = new Map(snapshot.map((s) => [s.taskId, s] as const));
      const current = await app.db
        .select()
        .from(scheduleTasks)
        .where(
          and(
            eq(scheduleTasks.scheduleId, schedule.id),
            eq(scheduleTasks.projectId, req.projectId!),
          ),
        )
        .orderBy(asc(scheduleTasks.sortOrder), asc(scheduleTasks.id));

      const tasks = current.map((t) => {
        const p = planned.get(t.id);
        const plannedStart = p?.startDate ?? null;
        const plannedFinish = p?.finishDate ?? null;
        const actualOrForecastStart = t.actualStart ?? t.startDate ?? null;
        const actualOrForecastFinish = t.actualFinish ?? t.finishDate ?? null;
        return {
          taskId: t.id,
          name: t.name,
          wbsCode: t.wbsCode,
          plannedStart,
          plannedFinish,
          actualOrForecastStart,
          actualOrForecastFinish,
          startSlipDays:
            plannedStart && actualOrForecastStart
              ? dayFromIso(actualOrForecastStart, plannedStart)
              : null,
          finishSlipDays:
            plannedFinish && actualOrForecastFinish
              ? dayFromIso(actualOrForecastFinish, plannedFinish)
              : null,
          isCritical: t.isCritical === 1,
          hasStarted: t.actualStart !== null,
          hasFinished: t.actualFinish !== null,
          inBaseline: p !== undefined,
        };
      });

      const plannedFinish =
        baseline.computedFinish ?? maxIso(snapshot.map((s) => s.finishDate ?? null));
      const currentForecastFinish =
        schedule.computedFinish ?? maxIso(tasks.map((t) => t.actualOrForecastFinish));
      return {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        baselineId: baseline.id,
        baselineName: baseline.name,
        capturedAt: baseline.capturedAt,
        plannedFinish,
        currentForecastFinish,
        totalSlipDays:
          plannedFinish && currentForecastFinish
            ? dayFromIso(currentForecastFinish, plannedFinish)
            : null,
        tasks,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Windows analysis (#273 — honestly scoped)                         */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/forensics/windows", { preHandler: readGate }, async (req) => {
    const q = windowsQuerySchema.parse(req.query);
    const schedule = await resolveSchedule(req.companyId!, req.projectId!, q.scheduleId);
    const baseline = await resolveBaseline(schedule.id, req.projectId!, q.baselineId);

    const boundaryList = [
      ...new Set(
        q.boundaries
          .split(",")
          .map((b) => b.trim())
          .filter((b) => b.length > 0),
      ),
    ].sort();
    if (boundaryList.length === 0) {
      throw badRequest("boundaries must contain at least one ISO date (comma-separated)");
    }
    for (const b of boundaryList) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b)) {
        throw badRequest(`Invalid window boundary "${b}" — expected ISO dates (YYYY-MM-DD)`);
      }
    }

    const events = await app.db
      .select()
      .from(delayEvents)
      .where(
        and(eq(delayEvents.companyId, req.companyId!), eq(delayEvents.projectId, req.projectId!)),
      )
      .orderBy(asc(delayEvents.startDate), asc(delayEvents.number));

    const starts = [schedule.projectStart, ...boundaryList];
    const windows = starts.map((start, i) => ({
      start,
      /** null = open-ended final window */
      end: boundaryList[i] ?? null,
      events: [] as {
        id: string;
        number: number;
        title: string;
        cause: string;
        excusable: boolean;
        compensable: boolean;
        status: string;
        startDate: string;
        durationDays: number;
        tiaDeltaDays: number | null;
      }[],
      totals: {
        events: 0,
        excusableDays: 0,
        compensableDays: 0,
        nonExcusableDays: 0,
        tiaDeltaDays: 0,
      },
    }));

    let unattributed = 0;
    for (const ev of events) {
      const w = windows.find(
        (win) => ev.startDate >= win.start && (win.end === null || ev.startDate < win.end),
      );
      if (!w) {
        unattributed += 1;
        continue;
      }
      const tiaDelta =
        ev.tiaResult && typeof ev.tiaResult["completionDeltaDays"] === "number"
          ? (ev.tiaResult["completionDeltaDays"] as number)
          : null;
      w.events.push({
        id: ev.id,
        number: ev.number,
        title: ev.title,
        cause: ev.cause,
        excusable: ev.excusable === 1,
        compensable: ev.compensable === 1,
        status: ev.status,
        startDate: ev.startDate,
        durationDays: ev.durationDays,
        tiaDeltaDays: tiaDelta,
      });
      w.totals.events += 1;
      if (ev.compensable === 1) w.totals.compensableDays += ev.durationDays;
      else if (ev.excusable === 1) w.totals.excusableDays += ev.durationDays;
      else w.totals.nonExcusableDays += ev.durationDays;
      if (tiaDelta !== null) w.totals.tiaDeltaDays += tiaDelta;
    }

    return {
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      baselineId: baseline?.id ?? null,
      projectStart: schedule.projectStart,
      boundaries: boundaryList,
      method:
        "delay events attributed to windows by start date; movement quantified by per-event " +
        "TIA against the current programme — not a full retrospective windows TIA",
      unattributedEvents: unattributed,
      windows,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Prolongation calculator (#299-301 seed)                           */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/forensics/prolongation",
    { preHandler: standardGate },
    async (req) => {
      const body = prolongationBodySchema.parse(req.body);

      let prelimsTimeTotal: number | null = null;
      let scheduleDurationDays: number | null = null;
      let scheduleId: string | null = null;
      if (body.prelimsRatePerDay === undefined) {
        const projectBoqs = await app.db
          .select({ id: boqs.id })
          .from(boqs)
          .where(and(eq(boqs.companyId, req.companyId!), eq(boqs.projectId, req.projectId!)));
        if (projectBoqs.length > 0) {
          const items = await app.db
            .select({ amount: boqItems.amount, quantity: boqItems.quantity, rate: boqItems.rate })
            .from(boqItems)
            .where(
              and(
                inArray(
                  boqItems.boqId,
                  projectBoqs.map((b) => b.id),
                ),
                eq(boqItems.itemType, "prelims_time"),
              ),
            );
          const total = items.reduce((sum, it) => {
            const amount = it.amount ?? (it.quantity != null && it.rate != null ? it.quantity * it.rate : 0);
            return sum + amount;
          }, 0);
          prelimsTimeTotal = total > 0 ? total : null;
        }
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
        if (active) {
          scheduleId = active.id;
          if (active.computedDurationDays != null && active.computedDurationDays > 0) {
            scheduleDurationDays = active.computedDurationDays;
          } else {
            // fall back to the persisted task dates when the roll-up is stale
            const rows = await app.db
              .select({ finishDate: scheduleTasks.finishDate })
              .from(scheduleTasks)
              .where(eq(scheduleTasks.scheduleId, active.id));
            const maxFinish = maxIso(rows.map((r) => r.finishDate));
            if (maxFinish) {
              scheduleDurationDays = dayFromIso(maxFinish, active.projectStart) + 1;
            }
          }
        }
      }

      const result = computeProlongation({
        compensableDays: body.compensableDays,
        prelimsRatePerDay: body.prelimsRatePerDay ?? null,
        prelimsTimeTotal,
        scheduleDurationDays,
      });
      if (!result.ok) throw badRequest(result.reason);
      return {
        compensableDays: result.compensableDays,
        prelimsRatePerDay: result.prelimsRatePerDay,
        amount: result.amount,
        derivation: result.derivation,
        sources:
          body.prelimsRatePerDay !== undefined
            ? null
            : { prelimsTimeTotal, scheduleDurationDays, scheduleId },
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Claims workspace (#304-320)                                       */
  /* ---------------------------------------------------------------- */

  async function validateDelayEventIds(
    ids: string[],
    companyId: string,
    projectId: string,
  ): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const rows = await app.db
      .select({ id: delayEvents.id })
      .from(delayEvents)
      .where(
        and(
          inArray(delayEvents.id, unique),
          eq(delayEvents.companyId, companyId),
          eq(delayEvents.projectId, projectId),
        ),
      );
    if (rows.length !== unique.length) {
      throw badRequest("One or more delayEventIds do not reference delay events in this project");
    }
    return unique;
  }

  app.post("/projects/:projectId/claims", { preHandler: standardGate }, async (req, reply) => {
    const body = claimCreateSchema.parse(req.body);
    if (body.contractId) {
      const [c] = await app.db
        .select({ id: contracts.id })
        .from(contracts)
        .where(
          and(
            eq(contracts.id, body.contractId),
            eq(contracts.companyId, req.companyId!),
            eq(contracts.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!c) throw badRequest("contractId does not reference a contract in this project");
    }
    const delayEventIds = await validateDelayEventIds(
      body.delayEventIds ?? [],
      req.companyId!,
      req.projectId!,
    );
    const number = await nextRecordNumber(app.db, req.projectId!, "claim");
    const id = newId("clm");
    await app.db.insert(forensicClaims).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      number,
      title: body.title,
      kind: body.kind,
      status: "draft",
      contractId: body.contractId ?? null,
      clauseRef: body.clauseRef ?? null,
      delayEventIds,
      chain: body.chain ?? {},
      daysClaimed: body.daysClaimed ?? null,
      amountClaimed: body.amountClaimed ?? null,
      prolongation: body.prolongation ?? null,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "forensic_claim",
      objectId: id,
      payload: {
        number,
        title: body.title,
        kind: body.kind,
        delayEventIds,
        daysClaimed: body.daysClaimed ?? null,
        amountClaimed: body.amountClaimed ?? null,
      },
      storePayload: true,
    });
    const created = await fetchClaim(id, req.companyId!, req.projectId!);
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/claims", { preHandler: readGate }, async (req) => {
    const q = claimListQuery.parse(req.query);
    const clauses = [
      eq(forensicClaims.companyId, req.companyId!),
      eq(forensicClaims.projectId, req.projectId!),
    ];
    if (q.kind) clauses.push(eq(forensicClaims.kind, q.kind));
    if (q.status) clauses.push(eq(forensicClaims.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(forensicClaims).where(where);
    const items = await app.db
      .select()
      .from(forensicClaims)
      .where(where)
      .orderBy(desc(forensicClaims.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/claims/:claimId", { preHandler: readGate }, async (req) => {
    const { claimId } = req.params as { claimId: string };
    const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
    const ids = claim.delayEventIds ?? [];
    const events =
      ids.length > 0
        ? await app.db
            .select({
              id: delayEvents.id,
              number: delayEvents.number,
              title: delayEvents.title,
              cause: delayEvents.cause,
              excusable: delayEvents.excusable,
              compensable: delayEvents.compensable,
              status: delayEvents.status,
              startDate: delayEvents.startDate,
              durationDays: delayEvents.durationDays,
              tiaResult: delayEvents.tiaResult,
            })
            .from(delayEvents)
            .where(
              and(inArray(delayEvents.id, ids), eq(delayEvents.projectId, req.projectId!)),
            )
            .orderBy(asc(delayEvents.number))
        : [];
    return { ...claim, delayEvents: events };
  });

  app.patch("/projects/:projectId/claims/:claimId", { preHandler: standardGate }, async (req) => {
    const { claimId } = req.params as { claimId: string };
    const body = claimPatchSchema.parse(req.body);
    const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
    if (["agreed", "rejected", "withdrawn"].includes(claim.status)) {
      throw badRequest(`A ${claim.status} claim cannot be edited`);
    }
    // The cause-effect-entitlement-quantum chain and the supporting event set
    // (#305) are frozen once the claim leaves draft — the submitted narrative
    // is the narrative that gets assessed.
    if ((body.chain !== undefined || body.delayEventIds !== undefined) && claim.status !== "draft") {
      throw badRequest("chain and delayEventIds may only be changed while the claim is draft");
    }
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.title !== undefined) set["title"] = body.title;
    if (body.clauseRef !== undefined) set["clauseRef"] = body.clauseRef;
    if (body.chain !== undefined) set["chain"] = body.chain;
    if (body.daysClaimed !== undefined) set["daysClaimed"] = body.daysClaimed;
    if (body.amountClaimed !== undefined) set["amountClaimed"] = body.amountClaimed;
    if (body.prolongation !== undefined) set["prolongation"] = body.prolongation;
    if (body.contractId !== undefined) {
      if (body.contractId) {
        const [c] = await app.db
          .select({ id: contracts.id })
          .from(contracts)
          .where(
            and(
              eq(contracts.id, body.contractId),
              eq(contracts.companyId, req.companyId!),
              eq(contracts.projectId, req.projectId!),
            ),
          )
          .limit(1);
        if (!c) throw badRequest("contractId does not reference a contract in this project");
      }
      set["contractId"] = body.contractId;
    }
    if (body.delayEventIds !== undefined) {
      set["delayEventIds"] = await validateDelayEventIds(
        body.delayEventIds,
        req.companyId!,
        req.projectId!,
      );
    }
    await app.db.update(forensicClaims).set(set).where(eq(forensicClaims.id, claimId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "forensic_claim",
      objectId: claimId,
      payload: { changed: Object.keys(body) },
    });
    return fetchClaim(claimId, req.companyId!, req.projectId!);
  });

  app.post(
    "/projects/:projectId/claims/:claimId/status",
    { preHandler: standardGate },
    async (req) => {
      const { claimId } = req.params as { claimId: string };
      const body = claimStatusSchema.parse(req.body);
      const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
      const allowed = CLAIM_TRANSITIONS[claim.status] ?? [];
      if (!allowed.includes(body.status)) {
        throw badRequest(`Cannot transition a ${claim.status} claim to ${body.status}`);
      }
      const now = new Date().toISOString();
      const set: Record<string, unknown> = { status: body.status, updatedAt: now };
      if (body.status === "assessed") {
        // Determination independence (#310): the assessor must not be the
        // party who prepared the claim.
        if (req.user!.id === claim.createdBy) {
          throw forbidden("A claim cannot be assessed by the user who created it");
        }
        if (body.daysAssessed !== undefined) set["daysAssessed"] = body.daysAssessed;
        if (body.amountAssessed !== undefined) set["amountAssessed"] = body.amountAssessed;
        set["assessedBy"] = req.user!.id;
      }
      await app.db.update(forensicClaims).set(set).where(eq(forensicClaims.id, claimId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "forensic_claim",
        objectId: claimId,
        payload: {
          from: claim.status,
          to: body.status,
          daysAssessed: body.status === "assessed" ? (body.daysAssessed ?? null) : claim.daysAssessed,
          amountAssessed:
            body.status === "assessed" ? (body.amountAssessed ?? null) : claim.amountAssessed,
        },
      });
      return fetchClaim(claimId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Chronology auto-assembly (#318)                                   */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/claims/:claimId/chronology",
    { preHandler: standardGate },
    async (req) => {
      const { claimId } = req.params as { claimId: string };
      const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const entries: { date: string; source: string; ref: string; title: string }[] = [];

      const dEvents = await app.db
        .select()
        .from(delayEvents)
        .where(and(eq(delayEvents.companyId, companyId), eq(delayEvents.projectId, projectId)));
      for (const ev of dEvents) {
        entries.push({
          date: ev.startDate,
          source: "delay_event",
          ref: `DE-${ev.number}`,
          title: ev.title,
        });
      }

      const cEvents = await app.db
        .select()
        .from(contractEvents)
        .where(
          and(eq(contractEvents.companyId, companyId), eq(contractEvents.projectId, projectId)),
        );
      for (const ev of cEvents) {
        entries.push({
          date: ev.eventDate,
          source: "contract_event",
          ref: `CE-${ev.number}`,
          title: ev.title,
        });
        if (ev.noticeServedAt) {
          entries.push({
            date: ev.noticeServedAt.slice(0, 10),
            source: "contract_event",
            ref: `CE-${ev.number}`,
            title: `Notice served — ${ev.title}`,
          });
        }
      }

      const rfiRows = await app.db
        .select()
        .from(rfis)
        .where(and(eq(rfis.companyId, companyId), eq(rfis.projectId, projectId)));
      for (const r of rfiRows) {
        entries.push({
          date: r.createdAt.slice(0, 10),
          source: "rfi",
          ref: `RFI-${r.number}`,
          title: `RFI raised — ${r.subject}`,
        });
        if (r.respondedAt) {
          entries.push({
            date: r.respondedAt.slice(0, 10),
            source: "rfi",
            ref: `RFI-${r.number}`,
            title: `RFI answered — ${r.subject}`,
          });
        }
      }

      const logRows = await app.db
        .select()
        .from(dailyLogs)
        .where(and(eq(dailyLogs.companyId, companyId), eq(dailyLogs.projectId, projectId)));
      for (const log of logRows) {
        const delays = (log.sections ?? {})["delays"];
        if (Array.isArray(delays) && delays.length > 0) {
          entries.push({
            date: log.logDate,
            source: "daily_log",
            ref: `LOG-${log.logDate}`,
            title: `Daily log records ${delays.length} delay ${delays.length === 1 ? "entry" : "entries"}`,
          });
        }
      }

      const varRows = await app.db
        .select()
        .from(variations)
        .where(
          and(
            eq(variations.companyId, companyId),
            eq(variations.projectId, projectId),
            isNotNull(variations.instructedAt),
          ),
        );
      for (const v of varRows) {
        entries.push({
          date: v.instructedAt!,
          source: "variation",
          ref: `VO-${v.number}`,
          title: `Variation instructed — ${v.title}`,
        });
      }

      entries.sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          a.source.localeCompare(b.source) ||
          a.ref.localeCompare(b.ref),
      );

      const chronologyAt = new Date().toISOString();
      await app.db
        .update(forensicClaims)
        .set({ chronology: entries, chronologyAt, updatedAt: chronologyAt })
        .where(eq(forensicClaims.id, claimId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "update",
        objectType: "forensic_claim",
        objectId: claimId,
        payload: { chronologyAt, entryCount: entries.length },
      });
      return { claimId: claim.id, chronologyAt, count: entries.length, items: entries };
    },
  );
};
