import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  boqItems,
  boqs,
  contractEvents,
  contracts,
  dailyLogs,
  delayEvents,
  disruptionAnalyses,
  evidence,
  forensicAnalyses,
  forensicClaims,
  projectFloatRules,
  quantumCalculations,
  rfis,
  scheduleBaselines,
  scheduleCalendars,
  scheduleDependencies,
  scheduleTasks,
  schedules,
  timecards,
  variations,
} from "@constructos/db";
import {
  AACE_MIP_CODES,
  CLAIM_KINDS,
  CLAIM_STATUSES,
  CONCURRENCY_RULES,
  CULPABLE_PARTIES,
  DELAY_CAUSES,
  DELAY_EVENT_STATUSES,
  DISRUPTION_METHODS,
  FLOAT_OWNERSHIP_RULES,
  FORENSIC_METHODS,
  INTEREST_BASES,
  QUANTUM_METHODS,
  type ConcurrencyRule,
  type FloatOwnershipRule,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema } from "../field/dates.js";
import {
  computeCpm2,
  dayFromIso,
  type CalendarSpec,
  type Cpm2DependencyInput,
  type Cpm2TaskInput,
} from "../schedule/cpm2.js";
import { runFragnetTia } from "./tia.js";
import { computeProlongation } from "./prolongation.js";
import {
  collapsedAsBuilt,
  impactedAsPlanned,
  recommendMethods,
  retrospectiveLongestPath,
  windowsAnalysis,
  type ForensicEvent,
  type ForensicNetwork,
  type WindowInput,
} from "./methods.js";
import { DEFAULT_FLOAT_RULES, analyseConcurrency, type FloatRules } from "./concurrency.js";
import {
  computeProvision,
  eichleay,
  emden,
  financeCharge,
  hudson,
  lossOfProfit,
  siteOverhead,
} from "./quantum.js";
import {
  earnedValueDisruption,
  industryCurve,
  measuredMile,
  suggestBaselineWindow,
  type ProductivityPoint,
} from "./disruption.js";
import {
  buildScottSchedule,
  scoreClaimSufficiency,
  type ChainLimbInput,
  type EventSufficiencyInput,
} from "./sufficiency.js";

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
  party: z.enum(CULPABLE_PARTIES).optional(),
  taskId: z.string().min(1).nullable().optional(),
  scheduleId: z.string().min(1).nullable().optional(),
  startDate: isoDateSchema,
  durationDays: z.number().int().min(1).max(10000),
  contractEventId: z.string().min(1).nullable().optional(),
  noticeDueDate: isoDateSchema.nullable().optional(),
  pacingOfEventId: z.string().min(1).nullable().optional(),
  evidenceIds: z.array(z.string().min(1)).max(200).optional(),
});

const delayEventPatchSchema = delayEventCreateSchema.partial();

const delayEventListQuery = pageQuerySchema.extend({
  cause: z.enum(DELAY_CAUSES).optional(),
  status: z.enum(DELAY_EVENT_STATUSES).optional(),
  party: z.enum(CULPABLE_PARTIES).optional(),
  excusable: boolQuery,
  compensable: boolQuery,
  includeWithdrawn: boolQuery,
});

const delayEventStatusSchema = z.object({
  status: z.enum(DELAY_EVENT_STATUSES),
  reason: z.string().max(2000).optional(),
});

/**
 * Delay event lifecycle. Before this, any status could become any other:
 * a withdrawn event could be quietly reopened, and withdrawn events kept
 * feeding claims, windows and chronology as though they were live.
 */
const DELAY_EVENT_TRANSITIONS: Record<string, string[]> = {
  open: ["assessed", "withdrawn", "closed"],
  assessed: ["closed", "withdrawn"],
  closed: ["open"],
  withdrawn: ["open"],
};
/** Terminal states whose reversal has to be justified in the ledger. */
const DELAY_EVENT_REOPEN_FROM = new Set(["closed", "withdrawn"]);

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
  currency: z.string().length(3).optional(),
  delayEventIds: z.array(z.string().min(1)).max(200).optional(),
  chain: chainSchema.optional(),
  daysClaimed: z.number().int().min(0).max(10000).nullable().optional(),
  amountClaimed: z.number().min(0).nullable().optional(),
  prolongation: prolongationBlockSchema.nullable().optional(),
});

const claimPatchSchema = claimCreateSchema.omit({ kind: true }).partial();

const claimValuationSchema = z.object({
  quantumBest: z.number().min(0).nullable().optional(),
  quantumLikely: z.number().min(0).nullable().optional(),
  quantumWorst: z.number().min(0).nullable().optional(),
  successProbability: z.number().min(0).max(1).nullable().optional(),
});

const claimListQuery = pageQuerySchema.extend({
  kind: z.enum(CLAIM_KINDS).optional(),
  status: z.enum(CLAIM_STATUSES).optional(),
});

const claimStatusSchema = z.object({
  status: z.enum(["submitted", "assessed", "agreed", "rejected", "withdrawn", "draft"]),
  daysAssessed: z.number().int().min(0).max(10000).optional(),
  amountAssessed: z.number().min(0).optional(),
  reason: z.string().max(2000).optional(),
});

/**
 * draft → submitted → assessed → agreed | rejected; withdrawn pre-agreement.
 * `draft` from submitted/assessed is the explicit REVISE transition: it clears
 * the assessment, so a changed claim can never carry an assessment that never
 * considered the changed figures.
 */
const CLAIM_TRANSITIONS: Record<string, string[]> = {
  draft: ["submitted", "withdrawn"],
  submitted: ["assessed", "withdrawn", "draft"],
  assessed: ["agreed", "rejected", "withdrawn", "draft"],
  agreed: [],
  rejected: [],
  withdrawn: [],
};

/** Fields frozen once a claim leaves draft — the case that gets assessed. */
const FROZEN_AFTER_DRAFT = [
  "title",
  "chain",
  "delayEventIds",
  "daysClaimed",
  "amountClaimed",
  "prolongation",
  "contractId",
  "clauseRef",
  "currency",
] as const;

const prolongationBodySchema = z.object({
  compensableDays: z.number().int().min(0).max(10000),
  prelimsRatePerDay: z.number().positive().optional(),
  boqId: z.string().min(1).optional(),
});

const analysisQuerySchema = z.object({
  scheduleId: z.string().min(1).optional(),
  baselineId: z.string().min(1).optional(),
});

const windowsQuerySchema = analysisQuerySchema.extend({
  boundaries: z.string().min(1),
  statuses: z.string().min(1).optional(),
});

const runAnalysisSchema = z.object({
  method: z.enum(FORENSIC_METHODS),
  title: z.string().min(1).max(300),
  scheduleId: z.string().min(1).optional(),
  baselineId: z.string().min(1).optional(),
  claimId: z.string().min(1).nullable().optional(),
  eventIds: z.array(z.string().min(1)).max(200).optional(),
  party: z.enum(CULPABLE_PARTIES).optional(),
  boundaries: z.array(isoDateSchema).max(60).optional(),
  mipCode: z.enum(AACE_MIP_CODES).optional(),
  sclReference: z.string().max(300).optional(),
  rationale: z.string().max(5000).optional(),
});

const floatRulesSchema = z.object({
  ownership: z.enum(FLOAT_OWNERSHIP_RULES),
  concurrencyRule: z.enum(CONCURRENCY_RULES),
  concurrencyThresholdDays: z.number().int().min(0).max(90).optional(),
  pacingThresholdDays: z.number().int().min(0).max(90).optional(),
  basis: z.string().max(2000).nullable().optional(),
});

const methodSelectionSchema = z.object({
  perspective: z.enum(["prospective", "retrospective"]),
  updatesAvailable: z.boolean(),
  baselineAvailable: z.boolean(),
  asBuiltComplete: z.boolean(),
  concurrencyInIssue: z.boolean(),
});

const quantumSchema = z.object({
  method: z.enum(QUANTUM_METHODS),
  claimId: z.string().min(1).nullable().optional(),
  currency: z.string().length(3).optional(),
  delayDays: z.number().min(0).max(10000).optional(),
  contractId: z.string().min(1).nullable().optional(),
  contractSum: z.number().min(0).nullable().optional(),
  contractPeriodDays: z.number().int().min(1).nullable().optional(),
  hoProfitPercent: z.number().min(0).max(100).nullable().optional(),
  actualOverheadPercent: z.number().min(0).max(100).nullable().optional(),
  accountsPeriod: z.string().max(60).nullable().optional(),
  contractBillings: z.number().min(0).nullable().optional(),
  totalBillings: z.number().min(0).nullable().optional(),
  totalOverhead: z.number().min(0).nullable().optional(),
  performanceDays: z.number().int().min(1).nullable().optional(),
  prelimsTimeTotal: z.number().min(0).nullable().optional(),
  programmeDays: z.number().int().min(1).nullable().optional(),
  ratePerDay: z.number().min(0).nullable().optional(),
  fixedPrelimsAttributable: z.number().min(0).nullable().optional(),
  principal: z.number().min(0).nullable().optional(),
  annualRatePercent: z.number().min(0).max(100).nullable().optional(),
  days: z.number().int().min(0).max(20000).optional(),
  basis: z.enum(INTEREST_BASES).optional(),
  rateSource: z.string().max(200).nullable().optional(),
  marginPercent: z.number().min(0).max(100).nullable().optional(),
  displacedTurnover: z.number().min(0).nullable().optional(),
  evidenceOfLostOpportunity: z.string().max(2000).nullable().optional(),
});

const productivityQuerySchema = z.object({
  trade: z.string().max(100).optional(),
  unit: z.string().max(30).optional(),
  quantityMatch: z.string().max(200).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

const disruptionSchema = z.object({
  method: z.enum(DISRUPTION_METHODS),
  title: z.string().min(1).max(300),
  claimId: z.string().min(1).nullable().optional(),
  trade: z.string().max(100).nullable().optional(),
  unit: z.string().max(30).optional(),
  quantityMatch: z.string().max(200).optional(),
  currency: z.string().length(3).optional(),
  hourlyRate: z.number().min(0).nullable().optional(),
  baselineFrom: isoDateSchema.optional(),
  baselineTo: isoDateSchema.optional(),
  impactedFrom: isoDateSchema.optional(),
  impactedTo: isoDateSchema.optional(),
  scheduleId: z.string().min(1).optional(),
  baseHours: z.number().min(0).nullable().optional(),
  changePercent: z.number().min(0).max(500).nullable().optional(),
  factors: z
    .array(z.object({ key: z.string().min(1).max(60), severity: z.enum(["minor", "average", "severe"]) }))
    .max(20)
    .optional(),
  justification: z.string().max(5000).optional(),
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

const minIso = (dates: (string | null | undefined)[]): string | null => {
  let min: string | null = null;
  for (const d of dates) if (d && (min === null || d < min)) min = d;
  return min;
};

const DAY_MS = 86_400_000;
const addDaysIso = (iso: string, n: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** Monday of the ISO week containing `iso`. */
const weekStartIso = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  return addDaysIso(iso, -dow);
};

/** Statuses whose events are excluded from aggregation unless asked for. */
const EXCLUDED_EVENT_STATUSES = ["withdrawn"] as const;

/**
 * Delay & disruption forensics — spec Vol II Domain D / M9 (#265-320).
 *
 * The delay event register with entitlement and culpable-party classification
 * (#265-268); per-event Time Impact Analysis by fragnet insertion (#272); the
 * full method suite — impacted as-planned, collapsed as-built, windows/time
 * slice and retrospective longest path (#270-277) — each recorded with its
 * AACE 29R-03 MIP code, SCL Protocol reference, inputs and rationale so the
 * run is reproducible; concurrency, pacing and float-ownership assessment
 * against the project's recorded doctrine (#278-281); quantum engines for
 * prolongation, head-office overhead, finance charges and loss of profit
 * (#299-303); disruption quantification by measured mile, earned value and
 * industry curves (#290-293); the claims workspace with a frozen
 * cause-effect-entitlement-quantum chain (#304-320), record sufficiency
 * scoring, claim-scoped chronology, Scott Schedule generation and portfolio
 * claim exposure.
 *
 * Deliberately NOT here: the AI narrative drafter (WP-AGENTS owns agents; this
 * module exposes the records it would cite), and any automatic acceptance of
 * a claim — every determination is a human transition with segregation of
 * duties enforced.
 */
export const forensicsModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("forensics", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("forensics", "standard"),
  ];
  const adminGate = [app.authenticate, app.requireCompany, app.requireTool("forensics", "admin")];

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
  ): Promise<{ tasks: Cpm2TaskInput[]; deps: Cpm2DependencyInput[] }> {
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
        remainingDuration: t.remainingDurationDays,
        percentComplete: t.percentComplete,
        constraintType: (t.constraintType ?? null) as Cpm2TaskInput["constraintType"],
        constraintDate: t.constraintDate,
        actualStart: t.actualStart,
        actualFinish: t.actualFinish,
        calendarId: t.calendarId,
        taskType: t.taskType,
      })),
      deps: depRows.map((d) => ({
        predecessorId: d.predecessorId,
        successorId: d.successorId,
        type: d.depType as Cpm2DependencyInput["type"],
        lagDays: d.lagDays,
      })),
    };
  }

  async function loadCalendarSpecs(
    companyId: string,
    projectId: string,
    scheduleId: string,
  ): Promise<{ specs: CalendarSpec[]; defaultId: string | null }> {
    const rows = await app.db
      .select()
      .from(scheduleCalendars)
      .where(
        and(
          eq(scheduleCalendars.companyId, companyId),
          eq(scheduleCalendars.projectId, projectId),
          or(eq(scheduleCalendars.scheduleId, scheduleId), sql`${scheduleCalendars.scheduleId} is null`)!,
        ),
      );
    return {
      specs: rows.map((c) => ({
        id: c.id,
        workdays: Array.isArray(c.workdays) && c.workdays.length === 7 ? c.workdays : [0, 1, 1, 1, 1, 1, 0],
        holidays: c.holidays ?? [],
        exceptions: c.exceptions ?? [],
        hoursPerDay: c.hoursPerDay,
      })),
      defaultId: rows.find((c) => c.isDefault === 1)?.id ?? null,
    };
  }

  /** The as-built (current) network of a schedule. */
  async function asBuiltNetwork(
    companyId: string,
    projectId: string,
    schedule: { id: string; projectStart: string; dataDate: string | null; defaultCalendarId: string | null },
  ): Promise<ForensicNetwork> {
    const { tasks, deps } = await loadCpmInputs(schedule.id, projectId);
    const { specs, defaultId } = await loadCalendarSpecs(companyId, projectId, schedule.id);
    return {
      tasks,
      deps,
      projectStart: schedule.projectStart,
      dataDate: schedule.dataDate,
      calendars: specs,
      defaultCalendarId: schedule.defaultCalendarId ?? defaultId,
    };
  }

  /**
   * The as-planned network reconstructed from a baseline: baseline durations,
   * no actuals, no data date, and the schedule's CURRENT logic — a baseline
   * snapshot stores dates, not relationships, so the logic has to come from
   * somewhere and the analysis record says which.
   */
  async function baselineNetwork(
    companyId: string,
    projectId: string,
    schedule: { id: string; projectStart: string; defaultCalendarId: string | null },
    baseline: { snapshot: unknown[] | null; projectStart: string },
  ): Promise<ForensicNetwork> {
    const { tasks, deps } = await loadCpmInputs(schedule.id, projectId);
    const { specs, defaultId } = await loadCalendarSpecs(companyId, projectId, schedule.id);
    const snapshot = (baseline.snapshot ?? []) as BaselineTaskSnapshot[];
    const byId = new Map(snapshot.map((s) => [s.taskId, s] as const));
    const asPlanned: Cpm2TaskInput[] = tasks
      .filter((t) => byId.has(t.id))
      .map((t) => ({
        ...t,
        duration: byId.get(t.id)?.durationDays ?? t.duration,
        remainingDuration: null,
        percentComplete: 0,
        actualStart: null,
        actualFinish: null,
      }));
    const ids = new Set(asPlanned.map((t) => t.id));
    return {
      tasks: asPlanned,
      deps: deps.filter((d) => ids.has(d.predecessorId) && ids.has(d.successorId)),
      projectStart: baseline.projectStart,
      dataDate: null,
      calendars: specs,
      defaultCalendarId: schedule.defaultCalendarId ?? defaultId,
    };
  }

  /** Delay events shaped for the engines. */
  function toForensicEvents(rows: Awaited<ReturnType<typeof listEventRows>>): ForensicEvent[] {
    return rows.map((e) => ({
      id: e.id,
      number: e.number,
      title: e.title,
      startDate: e.startDate,
      durationDays: e.durationDays,
      struckTaskId: e.taskId,
      party: e.party,
      excusable: e.excusable === 1,
      compensable: e.compensable === 1,
    }));
  }

  async function listEventRows(
    companyId: string,
    projectId: string,
    options: { ids?: string[]; includeWithdrawn?: boolean; scheduleId?: string } = {},
  ) {
    const clauses = [eq(delayEvents.companyId, companyId), eq(delayEvents.projectId, projectId)];
    if (options.ids && options.ids.length > 0) clauses.push(inArray(delayEvents.id, options.ids));
    if (!options.includeWithdrawn) {
      for (const s of EXCLUDED_EVENT_STATUSES) clauses.push(ne(delayEvents.status, s));
    }
    if (options.scheduleId) clauses.push(eq(delayEvents.scheduleId, options.scheduleId));
    return app.db
      .select()
      .from(delayEvents)
      .where(and(...clauses))
      .orderBy(asc(delayEvents.startDate), asc(delayEvents.number))
      .limit(1000);
  }

  /** Project float doctrine, defaulted and explained when never configured. */
  async function loadFloatRules(companyId: string, projectId: string): Promise<FloatRules & { configured: boolean }> {
    const [row] = await app.db
      .select()
      .from(projectFloatRules)
      .where(
        and(eq(projectFloatRules.companyId, companyId), eq(projectFloatRules.projectId, projectId)),
      )
      .limit(1);
    if (!row) return { ...DEFAULT_FLOAT_RULES, configured: false };
    return {
      ownership: row.ownership as FloatOwnershipRule,
      concurrencyRule: row.concurrencyRule as ConcurrencyRule,
      concurrencyThresholdDays: row.concurrencyThresholdDays,
      pacingThresholdDays: row.pacingThresholdDays,
      basis: row.basis,
      configured: true,
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
    if (body.pacingOfEventId) {
      await fetchDelayEvent(body.pacingOfEventId, req.companyId!, req.projectId!);
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
      party: body.party ?? (body.compensable ? "owner" : "neither"),
      status: "open",
      taskId,
      scheduleId,
      startDate: body.startDate,
      durationDays: body.durationDays,
      contractEventId: body.contractEventId ?? null,
      noticeDueDate: body.noticeDueDate ?? null,
      pacingOfEventId: body.pacingOfEventId ?? null,
      evidenceIds,
      raisedBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "delay_event",
      objectId: id,
      projectId: req.projectId!,
      payload: {
        number,
        title: body.title,
        cause: body.cause,
        excusable: body.excusable,
        compensable: body.compensable,
        party: body.party ?? (body.compensable ? "owner" : "neither"),
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
    if (q.party) clauses.push(eq(delayEvents.party, q.party));
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

  /**
   * Is a cached TIA still describing the programme it was computed against?
   *
   * The result used to be cleared only when the EVENT changed. Editing task
   * durations, adding logic or capturing actuals left every event's cached
   * `completionDeltaDays` untouched, and windows and the claims drawer
   * presented those stale figures as current. The result is now stamped with
   * the schedule's `lastComputedAt`; a mismatch makes it stale, and stale is
   * reported rather than shown.
   */
  function tiaStaleness(
    tiaResult: Record<string, unknown> | null,
    scheduleLastComputedAt: string | null,
  ): { stale: boolean; deltaDays: number | null; computedAt: string | null; reason: string | null } {
    if (!tiaResult) return { stale: false, deltaDays: null, computedAt: null, reason: null };
    const delta =
      typeof tiaResult["completionDeltaDays"] === "number"
        ? (tiaResult["completionDeltaDays"] as number)
        : null;
    const computedAt = typeof tiaResult["computedAt"] === "string" ? (tiaResult["computedAt"] as string) : null;
    const against =
      typeof tiaResult["scheduleComputedAt"] === "string"
        ? (tiaResult["scheduleComputedAt"] as string)
        : null;
    if (scheduleLastComputedAt && against !== scheduleLastComputedAt) {
      return {
        stale: true,
        deltaDays: null,
        computedAt,
        reason: against
          ? "the schedule has been recomputed since this analysis ran"
          : "this analysis predates schedule-version stamping",
      };
    }
    return { stale: false, deltaDays: delta, computedAt, reason: null };
  }

  async function scheduleComputedAt(scheduleId: string | null): Promise<string | null> {
    if (!scheduleId) return null;
    const [row] = await app.db
      .select({ lastComputedAt: schedules.lastComputedAt })
      .from(schedules)
      .where(eq(schedules.id, scheduleId))
      .limit(1);
    return row?.lastComputedAt ?? null;
  }

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

    let contractEvent: { id: string; number: number; title: string; noticeServedAt: string | null } | null = null;
    if (ev.contractEventId) {
      const [ce] = await app.db
        .select({
          id: contractEvents.id,
          number: contractEvents.number,
          title: contractEvents.title,
          noticeServedAt: contractEvents.noticeServedAt,
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

    const tia = tiaStaleness(ev.tiaResult, await scheduleComputedAt(ev.scheduleId));
    return { ...ev, task, contractEvent, evidence: evidenceRows, tia };
  });

  app.patch("/projects/:projectId/delay-events/:eventId", { preHandler: standardGate }, async (req) => {
    const { eventId } = req.params as { eventId: string };
    const body = delayEventPatchSchema.parse(req.body);
    const ev = await fetchDelayEvent(eventId, req.companyId!, req.projectId!);
    if (ev.status === "withdrawn" || ev.status === "closed") {
      throw badRequest(`A ${ev.status} delay event cannot be edited — reopen it first`);
    }

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
    if (body.party !== undefined) set["party"] = body.party;
    if (body.startDate !== undefined) set["startDate"] = body.startDate;
    if (body.durationDays !== undefined) set["durationDays"] = body.durationDays;
    if (body.noticeDueDate !== undefined) set["noticeDueDate"] = body.noticeDueDate;
    if (body.startDate !== undefined || body.durationDays !== undefined) {
      // the modelled delay changed — a previously computed TIA is stale
      set["tiaResult"] = null;
    }
    if (body.pacingOfEventId !== undefined) {
      if (body.pacingOfEventId) {
        if (body.pacingOfEventId === eventId) throw badRequest("An event cannot pace itself");
        await fetchDelayEvent(body.pacingOfEventId, req.companyId!, req.projectId!);
      }
      set["pacingOfEventId"] = body.pacingOfEventId;
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
      projectId: req.projectId!,
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
      const allowed = DELAY_EVENT_TRANSITIONS[ev.status] ?? [];
      if (!allowed.includes(body.status)) {
        throw badRequest(
          `Cannot move a ${ev.status} delay event to ${body.status}` +
            (allowed.length > 0 ? ` — allowed: ${allowed.join(", ")}` : " — this state is terminal"),
        );
      }
      // Withdrawal removes the event from every downstream aggregation, and
      // reopening one puts it back: both need a recorded reason.
      if (body.status === "withdrawn" && !body.reason) {
        throw badRequest("A reason is required to withdraw a delay event");
      }
      if (DELAY_EVENT_REOPEN_FROM.has(ev.status) && !body.reason) {
        throw badRequest(`A reason is required to reopen a ${ev.status} delay event`);
      }
      await app.db
        .update(delayEvents)
        .set({
          status: body.status,
          statusReason: body.reason ?? null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(delayEvents.id, eventId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "delay_event",
        objectId: eventId,
        projectId: req.projectId!,
        payload: { from: ev.status, to: body.status, reason: body.reason ?? null },
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
        tasks: tasks.map((t) => ({
          id: t.id,
          duration: t.duration,
          constraintType: t.constraintType ?? null,
          constraintDate: t.constraintDate ?? null,
          actualStart: t.actualStart ?? null,
          actualFinish: t.actualFinish ?? null,
        })),
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
        // Stamp the schedule version this ran against so a later recompute
        // makes the cached figure detectably stale instead of quietly wrong.
        scheduleComputedAt: schedule.lastComputedAt,
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
        projectId: req.projectId!,
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
  /* Windows attribution — quick view (#273)                           */
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

    /*
     * Status filter. Withdrawn events used to keep contributing their days and
     * their cached TIA to every window: an event raised in error and formally
     * withdrawn still read as twenty compensable days. The applied filter is
     * reported in `method` so the reader knows what is in the totals.
     */
    const requested = q.statuses
      ? [...new Set(q.statuses.split(",").map((s) => s.trim()).filter((s) => s.length > 0))]
      : null;
    if (requested) {
      const invalid = requested.filter((s) => !DELAY_EVENT_STATUSES.includes(s as never));
      if (invalid.length > 0) {
        throw badRequest(`Unknown delay event status(es): ${invalid.join(", ")}`);
      }
    }
    const statusFilter = requested ?? DELAY_EVENT_STATUSES.filter((s) => s !== "withdrawn");

    const events = await app.db
      .select()
      .from(delayEvents)
      .where(
        and(
          eq(delayEvents.companyId, req.companyId!),
          eq(delayEvents.projectId, req.projectId!),
          inArray(delayEvents.status, statusFilter as string[]),
        ),
      )
      .orderBy(asc(delayEvents.startDate), asc(delayEvents.number));

    const lastComputedAt = schedule.lastComputedAt;
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
        party: string;
        excusable: boolean;
        compensable: boolean;
        status: string;
        startDate: string;
        durationDays: number;
        tiaDeltaDays: number | null;
        tiaStale: boolean;
      }[],
      totals: {
        events: 0,
        excusableDays: 0,
        compensableDays: 0,
        nonExcusableDays: 0,
        tiaDeltaDays: 0,
        staleTia: 0,
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
      const tia = tiaStaleness(ev.tiaResult, ev.scheduleId === schedule.id ? lastComputedAt : null);
      w.events.push({
        id: ev.id,
        number: ev.number,
        title: ev.title,
        cause: ev.cause,
        party: ev.party,
        excusable: ev.excusable === 1,
        compensable: ev.compensable === 1,
        status: ev.status,
        startDate: ev.startDate,
        durationDays: ev.durationDays,
        tiaDeltaDays: tia.deltaDays,
        tiaStale: tia.stale,
      });
      w.totals.events += 1;
      if (ev.compensable === 1) w.totals.compensableDays += ev.durationDays;
      else if (ev.excusable === 1) w.totals.excusableDays += ev.durationDays;
      else w.totals.nonExcusableDays += ev.durationDays;
      if (tia.deltaDays !== null) w.totals.tiaDeltaDays += tia.deltaDays;
      if (tia.stale) w.totals.staleTia += 1;
    }

    return {
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      baselineId: baseline?.id ?? null,
      projectStart: schedule.projectStart,
      boundaries: boundaryList,
      statuses: statusFilter,
      method:
        `delay events with status ${statusFilter.join("/")} attributed to windows by start date; ` +
        "movement quantified by per-event TIA against the current programme — run the windows " +
        "method (POST /forensics/analyses) for a per-window critical-path attribution",
      unattributedEvents: unattributed,
      windows,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Forensic method suite (#270-277)                                  */
  /* ---------------------------------------------------------------- */

  /** AACE MIP code and SCL reference the engines report for each method. */
  const METHOD_META: Record<string, { mipCode: string; sclReference: string }> = {
    as_planned_vs_as_built: { mipCode: "3.1", sclReference: "SCL Protocol Part B §11 (as-planned vs as-built)" },
    impacted_as_planned: { mipCode: "3.6", sclReference: "SCL Protocol Part B §11 (impacted as-planned)" },
    time_impact_analysis: { mipCode: "3.7", sclReference: "SCL Protocol Part B §11 (time impact analysis)" },
    windows: { mipCode: "3.4", sclReference: "SCL Protocol Part B §11 (time slice / windows)" },
    collapsed_as_built: { mipCode: "3.8", sclReference: "SCL Protocol Part B §11 (collapsed as-built)" },
    longest_path: { mipCode: "3.9", sclReference: "SCL Protocol Part B §11 (retrospective longest path)" },
    concurrency: { mipCode: "3.4", sclReference: "SCL Protocol Core Principles 10-14 (concurrency and pacing)" },
  };

  app.post("/projects/:projectId/forensics/method-selection", { preHandler: readGate }, async (req) => {
    const body = methodSelectionSchema.parse(req.body);
    return { factors: body, recommendations: recommendMethods(body) };
  });

  app.post("/projects/:projectId/forensics/analyses", { preHandler: standardGate }, async (req, reply) => {
    const body = runAnalysisSchema.parse(req.body);
    const schedule = await resolveSchedule(req.companyId!, req.projectId!, body.scheduleId);
    if (body.claimId) await fetchClaim(body.claimId, req.companyId!, req.projectId!);

    const eventRows = await listEventRows(req.companyId!, req.projectId!, {
      ids: body.eventIds,
      scheduleId: undefined,
    });
    if (body.eventIds && eventRows.length !== new Set(body.eventIds).size) {
      const found = new Set(eventRows.map((e) => e.id));
      const missing = [...new Set(body.eventIds)].filter((id) => !found.has(id));
      throw badRequest(
        `One or more eventIds do not reference live delay events in this project (withdrawn events are excluded): ${missing.join(", ")}`,
      );
    }
    const events = toForensicEvents(eventRows);

    const asBuilt = await asBuiltNetwork(req.companyId!, req.projectId!, schedule);
    const baselineRow = await resolveBaseline(schedule.id, req.projectId!, body.baselineId);
    const asPlanned = baselineRow
      ? await baselineNetwork(req.companyId!, req.projectId!, schedule, baselineRow)
      : null;

    let output: Record<string, unknown>;
    let resultDays: number | null = null;
    let summary: string;

    if (body.method === "impacted_as_planned") {
      const network = asPlanned ?? asBuilt;
      const res = impactedAsPlanned(network, events);
      if (!res.ok) throw badRequest(res.reason, { cycle: res.cycle });
      output = res as unknown as Record<string, unknown>;
      resultDays = res.totalDays;
      summary =
        `${res.steps.length} event(s) impacted into the ${asPlanned ? "as-planned baseline" : "current programme"}: ` +
        `completion moves ${res.totalDays} day(s) from ${res.baselineFinish ?? "?"} to ${res.impactedFinish ?? "?"}.` +
        (asPlanned ? "" : " No baseline exists, so the current programme was used — state this in the report.");
    } else if (body.method === "collapsed_as_built") {
      if (!body.party) throw badRequest("collapsed_as_built requires a party whose delay is removed");
      const res = collapsedAsBuilt(asBuilt, events, body.party);
      if (!res.ok) throw badRequest(res.reason, { cycle: res.cycle });
      output = res as unknown as Record<string, unknown>;
      resultDays = res.collapsedDays;
      summary =
        `Removing ${res.removed.length} ${body.party} event(s) from the as-built programme moves completion from ` +
        `${res.asBuiltFinish ?? "?"} to ${res.butForFinish ?? "?"} — ${res.collapsedDays} day(s) attributable to the ${body.party}.`;
    } else if (body.method === "longest_path") {
      const res = retrospectiveLongestPath(asBuilt);
      if (!res.ok) throw badRequest(res.reason, { cycle: res.cycle });
      const names = await app.db
        .select({ id: scheduleTasks.id, name: scheduleTasks.name })
        .from(scheduleTasks)
        .where(eq(scheduleTasks.scheduleId, schedule.id));
      const nameById = new Map(names.map((n) => [n.id, n.name] as const));
      output = {
        ...res,
        path: res.path.map((p) => ({ ...p, name: nameById.get(p.taskId) ?? p.taskId })),
      };
      summary = `The as-built driving chain runs through ${res.path.length} activit${res.path.length === 1 ? "y" : "ies"} to ${res.finish ?? "?"}.`;
    } else if (body.method === "windows") {
      if (!body.boundaries || body.boundaries.length === 0) {
        throw badRequest("windows requires at least one boundary date");
      }
      const boundaries = [...new Set(body.boundaries)].sort();
      // Each window boundary takes the revision (baseline) whose capture date
      // is nearest, falling back to the current programme.
      const baselines = await app.db
        .select()
        .from(scheduleBaselines)
        .where(eq(scheduleBaselines.scheduleId, schedule.id))
        .orderBy(asc(scheduleBaselines.capturedAt));
      const networkAt = async (
        at: string | null,
      ): Promise<{ network: ForensicNetwork; sourceId: string | null; sourceName: string | null }> => {
        if (at === null || baselines.length === 0) {
          return { network: asBuilt, sourceId: null, sourceName: "current programme" };
        }
        let best = baselines[0]!;
        for (const b of baselines) {
          const bAt = b.capturedAt.slice(0, 10);
          if (bAt <= at) best = b;
        }
        const n = await baselineNetwork(req.companyId!, req.projectId!, schedule, best);
        return { network: n, sourceId: best.id, sourceName: best.name };
      };
      const starts = [schedule.projectStart, ...boundaries];
      const windowInputs: WindowInput[] = [];
      for (let i = 0; i < starts.length; i += 1) {
        const start = starts[i]!;
        const end = boundaries[i] ?? null;
        const s = await networkAt(start);
        const e = await networkAt(end);
        windowInputs.push({
          start,
          end,
          startNetwork: s.network,
          startSourceId: s.sourceId,
          startSourceName: s.sourceName,
          endNetwork: e.network,
          endSourceId: e.sourceId,
          endSourceName: e.sourceName,
        });
      }
      const res = windowsAnalysis(windowInputs, events);
      if (!res.ok) throw badRequest(res.reason, { cycle: res.cycle });
      output = res as unknown as Record<string, unknown>;
      resultDays = res.windows.reduce((sum, w) => sum + (w.movementDays ?? 0), 0);
      summary =
        `${res.windows.length} window(s) analysed; total completion movement ${resultDays} day(s), of which ` +
        `${res.windows.reduce((s, w) => s + w.attributedDays, 0)} day(s) are attributable to driving delay events.`;
    } else if (body.method === "concurrency") {
      const rules = await loadFloatRules(req.companyId!, req.projectId!);
      const res = analyseConcurrency(asBuilt, events, rules);
      if (!res.ok) throw badRequest(res.reason, { cycle: res.cycle });
      output = { ...res, rulesConfigured: rules.configured } as unknown as Record<string, unknown>;
      summary =
        `${res.pairs.filter((p) => p.classification === "true_concurrency").length} concurrent pair(s) and ` +
        `${res.pairs.filter((p) => p.classification === "pacing").length} pacing relationship(s) identified under the ` +
        `${rules.concurrencyRule} doctrine${rules.configured ? "" : " (project default — no doctrine has been recorded)"}.`;
    } else if (body.method === "time_impact_analysis") {
      const network = asPlanned ?? asBuilt;
      const res = impactedAsPlanned(network, events);
      if (!res.ok) throw badRequest(res.reason, { cycle: res.cycle });
      output = res as unknown as Record<string, unknown>;
      resultDays = res.totalDays;
      summary = `Time impact analysis of ${res.steps.length} event(s): ${res.totalDays} day(s) of completion movement.`;
    } else {
      // as_planned_vs_as_built — the comparison the GET route renders, recorded.
      if (!baselineRow) throw badRequest("as_planned_vs_as_built requires a baseline");
      const planned = (baselineRow.snapshot ?? []) as BaselineTaskSnapshot[];
      const plannedFinish = baselineRow.computedFinish ?? maxIso(planned.map((p) => p.finishDate ?? null));
      const currentFinish = schedule.computedFinish;
      resultDays = plannedFinish && currentFinish ? dayFromIso(currentFinish, plannedFinish) : null;
      output = {
        baselineId: baselineRow.id,
        baselineName: baselineRow.name,
        plannedFinish,
        currentFinish,
        totalSlipDays: resultDays,
        taskCount: planned.length,
      };
      summary =
        resultDays === null
          ? "Completion movement is not available — the baseline or the current programme has no computed finish."
          : `Completion has moved ${resultDays} day(s) against baseline "${baselineRow.name}".`;
    }

    const meta = METHOD_META[body.method]!;
    const id = newId("fan");
    await app.db.insert(forensicAnalyses).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      claimId: body.claimId ?? null,
      scheduleId: schedule.id,
      baselineId: baselineRow?.id ?? null,
      method: body.method,
      mipCode: body.mipCode ?? meta.mipCode,
      sclReference: body.sclReference ?? meta.sclReference,
      title: body.title,
      inputs: {
        scheduleId: schedule.id,
        baselineId: baselineRow?.id ?? null,
        eventIds: events.map((e) => e.id),
        party: body.party ?? null,
        boundaries: body.boundaries ?? null,
        networkBasis: asPlanned ? "baseline durations with current logic" : "current programme",
      },
      output,
      resultDays,
      summary,
      rationale: body.rationale ?? null,
      runBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "forensic_analysis",
      objectId: id,
      projectId: req.projectId!,
      payload: {
        method: body.method,
        mipCode: body.mipCode ?? meta.mipCode,
        title: body.title,
        resultDays,
        eventCount: events.length,
        claimId: body.claimId ?? null,
      },
    });
    const [created] = await app.db
      .select()
      .from(forensicAnalyses)
      .where(eq(forensicAnalyses.id, id))
      .limit(1);
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/forensics/analyses", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ method: z.enum(FORENSIC_METHODS).optional(), claimId: z.string().min(1).optional() })
      .parse(req.query);
    const clauses = [
      eq(forensicAnalyses.companyId, req.companyId!),
      eq(forensicAnalyses.projectId, req.projectId!),
    ];
    if (q.method) clauses.push(eq(forensicAnalyses.method, q.method));
    if (q.claimId) clauses.push(eq(forensicAnalyses.claimId, q.claimId));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(forensicAnalyses).where(where);
    const items = await app.db
      .select({
        id: forensicAnalyses.id,
        method: forensicAnalyses.method,
        mipCode: forensicAnalyses.mipCode,
        sclReference: forensicAnalyses.sclReference,
        title: forensicAnalyses.title,
        resultDays: forensicAnalyses.resultDays,
        summary: forensicAnalyses.summary,
        rationale: forensicAnalyses.rationale,
        claimId: forensicAnalyses.claimId,
        scheduleId: forensicAnalyses.scheduleId,
        baselineId: forensicAnalyses.baselineId,
        inputs: forensicAnalyses.inputs,
        runBy: forensicAnalyses.runBy,
        createdAt: forensicAnalyses.createdAt,
      })
      .from(forensicAnalyses)
      .where(where)
      .orderBy(desc(forensicAnalyses.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/forensics/analyses/:analysisId", { preHandler: readGate }, async (req) => {
    const { analysisId } = req.params as { analysisId: string };
    const [row] = await app.db
      .select()
      .from(forensicAnalyses)
      .where(
        and(
          eq(forensicAnalyses.id, analysisId),
          eq(forensicAnalyses.companyId, req.companyId!),
          eq(forensicAnalyses.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Forensic analysis not found");
    return row;
  });

  /* ---------------------------------------------------------------- */
  /* Float ownership & concurrency doctrine (#278-281)                 */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/forensics/float-rules", { preHandler: readGate }, async (req) => {
    const rules = await loadFloatRules(req.companyId!, req.projectId!);
    return {
      ...rules,
      explanation: rules.configured
        ? "These rules are recorded for this project and are cited in every concurrency assessment."
        : "No float doctrine has been recorded for this project — the platform defaults are shown and will be cited as defaults.",
    };
  });

  app.put("/projects/:projectId/forensics/float-rules", { preHandler: adminGate }, async (req) => {
    const body = floatRulesSchema.parse(req.body);
    const [existing] = await app.db
      .select()
      .from(projectFloatRules)
      .where(
        and(eq(projectFloatRules.companyId, req.companyId!), eq(projectFloatRules.projectId, req.projectId!)),
      )
      .limit(1);
    const now = new Date().toISOString();
    const values = {
      ownership: body.ownership,
      concurrencyRule: body.concurrencyRule,
      concurrencyThresholdDays: body.concurrencyThresholdDays ?? 1,
      pacingThresholdDays: body.pacingThresholdDays ?? 2,
      basis: body.basis ?? null,
      updatedBy: req.user!.id,
      updatedAt: now,
    };
    let id: string;
    if (existing) {
      id = existing.id;
      await app.db.update(projectFloatRules).set(values).where(eq(projectFloatRules.id, id));
    } else {
      id = newId("pfr");
      await app.db.insert(projectFloatRules).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        ...values,
      });
    }
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: existing ? "update" : "create",
      objectType: "project_float_rules",
      objectId: id,
      projectId: req.projectId!,
      payload: { ...values, from: existing ? { ownership: existing.ownership, concurrencyRule: existing.concurrencyRule } : null },
    });
    return loadFloatRules(req.companyId!, req.projectId!);
  });

  /* ---------------------------------------------------------------- */
  /* Prolongation calculator (#299-301)                                */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/forensics/prolongation",
    { preHandler: standardGate },
    async (req) => {
      const body = prolongationBodySchema.parse(req.body);

      let prelimsTimeTotal: number | null = null;
      let scheduleDurationDays: number | null = null;
      let scheduleId: string | null = null;
      let currency: string | null = null;
      let usedBoqIds: string[] = [];
      let boqBasis: string | null = null;

      if (body.prelimsRatePerDay === undefined) {
        /*
         * The derivation used to sum prelims_time across EVERY bill in the
         * project — drafts, superseded versions and different currencies all
         * added together — and then spread the total over the programme. That
         * is wrong by construction: a project with a draft v1 and an issued v2
         * derived its daily rate from both. The bills are now restricted to
         * the agreed set (falling back to issued), a single currency is
         * required, and an ambiguous set has to be resolved by the caller.
         */
        const allBoqs = await app.db
          .select({
            id: boqs.id,
            name: boqs.name,
            status: boqs.status,
            version: boqs.version,
            currency: boqs.currency,
          })
          .from(boqs)
          .where(and(eq(boqs.companyId, req.companyId!), eq(boqs.projectId, req.projectId!)));

        let candidates = allBoqs;
        if (body.boqId) {
          candidates = allBoqs.filter((b) => b.id === body.boqId);
          if (candidates.length === 0) {
            throw badRequest("boqId does not reference a bill of quantities in this project");
          }
          boqBasis = `bill "${candidates[0]!.name}" (${candidates[0]!.status}) as requested`;
        } else {
          const agreed = allBoqs.filter((b) => b.status === "agreed");
          const issued = allBoqs.filter((b) => b.status === "issued");
          candidates = agreed.length > 0 ? agreed : issued;
          boqBasis =
            agreed.length > 0
              ? "agreed bills of quantities"
              : issued.length > 0
                ? "issued bills of quantities (no agreed bill exists)"
                : null;
          if (candidates.length === 0 && allBoqs.length > 0) {
            throw badRequest(
              "The project has bills of quantities but none is agreed or issued — a draft bill cannot price prolongation. " +
                "Provide prelimsRatePerDay, or pass boqId to use a specific bill deliberately.",
            );
          }
          if (candidates.length > 1) {
            const currencies = [...new Set(candidates.map((b) => b.currency))];
            if (currencies.length > 1) {
              throw badRequest(
                `The ${boqBasis} are priced in ${currencies.join(" and ")} — money is never summed across currencies. ` +
                  "Pass boqId to choose one bill.",
              );
            }
            throw badRequest(
              `${candidates.length} ${boqBasis} exist (${candidates.map((b) => `${b.name} v${b.version}`).join(", ")}) — ` +
                "pass boqId to say which one prices the preliminaries.",
            );
          }
        }

        if (candidates.length === 1) {
          const bill = candidates[0]!;
          currency = bill.currency;
          usedBoqIds = [bill.id];
          const items = await app.db
            .select({ amount: boqItems.amount, quantity: boqItems.quantity, rate: boqItems.rate })
            .from(boqItems)
            .where(and(eq(boqItems.boqId, bill.id), eq(boqItems.itemType, "prelims_time")));
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
        currency,
        derivation: result.derivation,
        sources:
          body.prelimsRatePerDay !== undefined
            ? null
            : { prelimsTimeTotal, scheduleDurationDays, scheduleId, boqIds: usedBoqIds, currency, basis: boqBasis },
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Quantum engines (#300-303)                                        */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/forensics/quantum", { preHandler: standardGate }, async (req, reply) => {
    const body = quantumSchema.parse(req.body);
    if (body.claimId) await fetchClaim(body.claimId, req.companyId!, req.projectId!);

    /* Pull what the platform already knows, so the analyst types less and the
     * provenance of every figure is recorded. */
    const sources: Record<string, unknown> = {};
    let contractSum = body.contractSum ?? null;
    let contractPeriodDays = body.contractPeriodDays ?? null;
    let currency = body.currency ?? null;
    if (body.contractId) {
      const [contract] = await app.db
        .select()
        .from(contracts)
        .where(
          and(
            eq(contracts.id, body.contractId),
            eq(contracts.companyId, req.companyId!),
            eq(contracts.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!contract) throw badRequest("contractId does not reference a contract in this project");
      if (contractSum === null && contract.contractSum != null) {
        contractSum = contract.contractSum;
        sources["contractSum"] = { from: "contract", contractId: contract.id };
      }
      if (currency === null) currency = contract.currency;
      const commencement = contract.commencementDate ?? contract.baseDate;
      if (contractPeriodDays === null && commencement && contract.completionDate) {
        contractPeriodDays = dayFromIso(contract.completionDate, commencement) + 1;
        sources["contractPeriodDays"] = {
          from: "contract dates",
          commencementDate: commencement,
          completionDate: contract.completionDate,
        };
      }
    }
    const delayDays = body.delayDays ?? 0;

    let result;
    switch (body.method) {
      case "hudson":
        result = hudson({ contractSum, contractPeriodDays, hoProfitPercent: body.hoProfitPercent ?? null, delayDays });
        break;
      case "emden":
        result = emden({
          contractSum,
          contractPeriodDays,
          actualOverheadPercent: body.actualOverheadPercent ?? null,
          delayDays,
          accountsPeriod: body.accountsPeriod ?? null,
        });
        break;
      case "eichleay":
        result = eichleay({
          contractBillings: body.contractBillings ?? null,
          totalBillings: body.totalBillings ?? null,
          totalOverhead: body.totalOverhead ?? null,
          performanceDays: body.performanceDays ?? null,
          delayDays,
        });
        break;
      case "site_overhead":
        result = siteOverhead({
          prelimsTimeTotal: body.prelimsTimeTotal ?? null,
          programmeDays: body.programmeDays ?? null,
          ratePerDay: body.ratePerDay ?? null,
          fixedPrelimsAttributable: body.fixedPrelimsAttributable ?? null,
          delayDays,
        });
        break;
      case "finance_charge":
        result = financeCharge({
          principal: body.principal ?? null,
          annualRatePercent: body.annualRatePercent ?? null,
          days: body.days ?? delayDays,
          basis: body.basis ?? "simple",
          rateSource: body.rateSource ?? null,
        });
        break;
      default:
        result = lossOfProfit({
          marginPercent: body.marginPercent ?? null,
          displacedTurnover: body.displacedTurnover ?? null,
          contractSum,
          contractPeriodDays,
          delayDays,
          evidenceOfLostOpportunity: body.evidenceOfLostOpportunity ?? null,
        });
    }

    if (!result.ok) {
      throw badRequest(
        `The ${body.method} calculation is missing: ${result.missing.join(", ")}. ` +
          "A quantum figure is never produced from assumed inputs.",
        { missing: result.missing, formula: result.formula },
      );
    }

    const id = newId("qtm");
    await app.db.insert(quantumCalculations).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      claimId: body.claimId ?? null,
      method: body.method,
      currency: currency ?? "USD",
      inputs: { ...body, contractSum, contractPeriodDays, delayDays } as Record<string, unknown>,
      assumptions: result.assumptions,
      sources,
      amount: result.amount,
      formula: result.formula,
      workings: result.workings,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "quantum_calculation",
      objectId: id,
      projectId: req.projectId!,
      payload: { method: body.method, amount: result.amount, currency: currency ?? "USD", claimId: body.claimId ?? null },
    });
    const [created] = await app.db
      .select()
      .from(quantumCalculations)
      .where(eq(quantumCalculations.id, id))
      .limit(1);
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/forensics/quantum", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ claimId: z.string().min(1).optional(), method: z.enum(QUANTUM_METHODS).optional() })
      .parse(req.query);
    const clauses = [
      eq(quantumCalculations.companyId, req.companyId!),
      eq(quantumCalculations.projectId, req.projectId!),
    ];
    if (q.claimId) clauses.push(eq(quantumCalculations.claimId, q.claimId));
    if (q.method) clauses.push(eq(quantumCalculations.method, q.method));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(quantumCalculations).where(where);
    const items = await app.db
      .select()
      .from(quantumCalculations)
      .where(where)
      .orderBy(desc(quantumCalculations.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /* ---------------------------------------------------------------- */
  /* Disruption (#290-293)                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Build a weekly productivity series from the project's own records:
   * hours from approved-or-better timecards, quantities from the daily log's
   * `quantities` section. Every point carries the ids it was built from, so an
   * expert report can be traced back to the underlying records.
   */
  async function buildProductivitySeries(
    companyId: string,
    projectId: string,
    opts: { trade?: string | null; unit?: string | null; quantityMatch?: string | null; from?: string; to?: string },
  ): Promise<{ points: ProductivityPoint[]; reasons: string[]; hourSources: number; quantitySources: number }> {
    const reasons: string[] = [];
    const clauses = [eq(timecards.companyId, companyId), eq(timecards.projectId, projectId)];
    if (opts.trade) clauses.push(eq(timecards.trade, opts.trade));
    if (opts.from) clauses.push(gte(timecards.workDate, opts.from));
    if (opts.to) clauses.push(lte(timecards.workDate, opts.to));
    const cards = await app.db
      .select({
        id: timecards.id,
        workDate: timecards.workDate,
        totalHours: timecards.totalHours,
        status: timecards.status,
      })
      .from(timecards)
      .where(and(...clauses))
      .limit(20000);

    const logClauses = [eq(dailyLogs.companyId, companyId), eq(dailyLogs.projectId, projectId)];
    if (opts.from) logClauses.push(gte(dailyLogs.logDate, opts.from));
    if (opts.to) logClauses.push(lte(dailyLogs.logDate, opts.to));
    const logs = await app.db
      .select({ id: dailyLogs.id, logDate: dailyLogs.logDate, sections: dailyLogs.sections })
      .from(dailyLogs)
      .where(and(...logClauses))
      .limit(5000);

    const byWeek = new Map<string, { hours: number; quantity: number; sourceIds: string[] }>();
    const bucket = (week: string) => {
      const b = byWeek.get(week) ?? { hours: 0, quantity: 0, sourceIds: [] };
      byWeek.set(week, b);
      return b;
    };
    let hourSources = 0;
    for (const c of cards) {
      if (c.status === "rejected" || c.status === "void") continue;
      const b = bucket(weekStartIso(c.workDate));
      b.hours += c.totalHours;
      if (b.sourceIds.length < 200) b.sourceIds.push(c.id);
      hourSources += 1;
    }
    let quantitySources = 0;
    for (const log of logs) {
      const rows = (log.sections ?? {})["quantities"];
      if (!Array.isArray(rows)) continue;
      for (const raw of rows) {
        if (typeof raw !== "object" || raw === null) continue;
        const row = raw as Record<string, unknown>;
        const qty = typeof row["quantity"] === "number" ? row["quantity"] : Number(row["quantity"]);
        if (!Number.isFinite(qty)) continue;
        if (opts.unit && typeof row["unit"] === "string" && row["unit"] !== opts.unit) continue;
        if (opts.quantityMatch) {
          const text = `${String(row["description"] ?? "")} ${String(row["item"] ?? "")}`.toLowerCase();
          if (!text.includes(opts.quantityMatch.toLowerCase())) continue;
        }
        const b = bucket(weekStartIso(log.logDate));
        b.quantity += qty;
        if (b.sourceIds.length < 200) b.sourceIds.push(log.id);
        quantitySources += 1;
      }
    }

    if (hourSources === 0) {
      reasons.push(
        opts.trade
          ? `No timecards were found for trade "${opts.trade}" in the period — labour hours are the denominator of every productivity figure`
          : "No timecards were found in the period — labour hours are the denominator of every productivity figure",
      );
    }
    if (quantitySources === 0) {
      reasons.push(
        "No quantity entries were found in the daily logs for the period — record installed quantities to measure productivity",
      );
    }

    const points = [...byWeek.entries()]
      .map(([weekStart, b]) => ({
        weekStart,
        hours: Math.round(b.hours * 100) / 100,
        quantity: Math.round(b.quantity * 100) / 100,
        sourceIds: b.sourceIds,
      }))
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    return { points, reasons, hourSources, quantitySources };
  }

  app.get(
    "/projects/:projectId/forensics/productivity-series",
    { preHandler: readGate },
    async (req) => {
      const q = productivityQuerySchema.parse(req.query);
      const series = await buildProductivitySeries(req.companyId!, req.projectId!, q);
      return {
        trade: q.trade ?? null,
        unit: q.unit ?? null,
        points: series.points,
        total: series.points.length,
        suggestedBaseline: suggestBaselineWindow(series.points, 3),
        sources: { timecards: series.hourSources, dailyLogQuantities: series.quantitySources },
        reasons: series.reasons,
      };
    },
  );

  app.post("/projects/:projectId/forensics/disruption", { preHandler: standardGate }, async (req, reply) => {
    const body = disruptionSchema.parse(req.body);
    if (body.claimId) await fetchClaim(body.claimId, req.companyId!, req.projectId!);
    const currency = body.currency ?? "USD";

    let output: Record<string, unknown>;
    let lostHours: number | null = null;
    let amount: number | null = null;
    let series: unknown[] = [];

    if (body.method === "measured_mile") {
      if (!body.baselineFrom || !body.baselineTo || !body.impactedFrom || !body.impactedTo) {
        throw badRequest("A measured mile needs baselineFrom, baselineTo, impactedFrom and impactedTo");
      }
      const built = await buildProductivitySeries(req.companyId!, req.projectId!, {
        trade: body.trade,
        unit: body.unit,
        quantityMatch: body.quantityMatch,
      });
      const res = measuredMile({
        trade: body.trade ?? "all trades",
        unit: body.unit ?? "unit",
        series: built.points,
        baselineFrom: body.baselineFrom,
        baselineTo: body.baselineTo,
        impactedFrom: body.impactedFrom,
        impactedTo: body.impactedTo,
        hourlyRate: body.hourlyRate ?? null,
        currency,
      });
      output = { ...res, reasons: [...built.reasons, ...res.reasons] } as unknown as Record<string, unknown>;
      series = res.series;
      lostHours = res.lostHours;
      amount = res.amount;
    } else if (body.method === "earned_value") {
      const schedule = await resolveSchedule(req.companyId!, req.projectId!, body.scheduleId);
      const tasks = await app.db
        .select({
          id: scheduleTasks.id,
          name: scheduleTasks.name,
          budgetedHours: scheduleTasks.budgetedHours,
          percentComplete: scheduleTasks.percentComplete,
        })
        .from(scheduleTasks)
        .where(eq(scheduleTasks.scheduleId, schedule.id));
      const cards = await app.db
        .select({ totalHours: timecards.totalHours, status: timecards.status })
        .from(timecards)
        .where(and(eq(timecards.companyId, req.companyId!), eq(timecards.projectId, req.projectId!)))
        .limit(20000);
      const actualTotal = cards
        .filter((c) => c.status !== "rejected" && c.status !== "void")
        .reduce((s, c) => s + c.totalHours, 0);
      const budgetedTotal = tasks.reduce((s, t) => s + (t.budgetedHours ?? 0), 0);
      // Actual hours are booked at project level, so they are apportioned to
      // activities by budgeted share; the response says so.
      const res = earnedValueDisruption({
        activities: tasks.map((t) => ({
          id: t.id,
          name: t.name,
          budgetedHours: t.budgetedHours,
          actualHours:
            t.budgetedHours != null && budgetedTotal > 0
              ? (actualTotal * t.budgetedHours) / budgetedTotal
              : null,
          percentComplete: t.percentComplete,
        })),
        hourlyRate: body.hourlyRate ?? null,
        currency,
      });
      output = {
        ...res,
        reasons: [
          ...res.reasons,
          "Actual hours are booked at project level and were apportioned to activities by budgeted-hours share",
        ],
        actualHoursSource: { timecards: cards.length, totalHours: Math.round(actualTotal * 100) / 100 },
      } as unknown as Record<string, unknown>;
      lostHours = res.lostHours;
      amount = res.amount;
    } else {
      if (!body.justification) {
        throw badRequest(
          "An industry-curve claim requires a written justification explaining why the published factors apply to this project",
        );
      }
      let changePercent = body.changePercent ?? null;
      const sources: Record<string, unknown> = {};
      if (changePercent === null && body.method !== "industry_curve_mcaa") {
        // Derive the change percentage from instructed variations vs contract sum.
        const vars = await app.db
          .select({ agreedValue: variations.agreedValue, costEstimate: variations.costEstimate })
          .from(variations)
          .where(
            and(
              eq(variations.companyId, req.companyId!),
              eq(variations.projectId, req.projectId!),
              isNotNull(variations.instructedAt),
            ),
          );
        const [contract] = await app.db
          .select({ contractSum: contracts.contractSum })
          .from(contracts)
          .where(
            and(eq(contracts.companyId, req.companyId!), eq(contracts.projectId, req.projectId!)),
          )
          .limit(1);
        const varTotal = vars.reduce((s, v) => s + (v.agreedValue ?? v.costEstimate ?? 0), 0);
        if (contract?.contractSum && contract.contractSum > 0 && varTotal > 0) {
          changePercent = Math.round((varTotal / contract.contractSum) * 1000) / 10;
          sources["changePercent"] = { from: "instructed variations vs contract sum", varTotal, contractSum: contract.contractSum };
        }
      }
      const res = industryCurve({
        method: body.method,
        baseHours: body.baseHours ?? null,
        factors: body.factors,
        changePercent,
        hourlyRate: body.hourlyRate ?? null,
        currency,
        justification: body.justification,
      });
      output = { ...res, sources } as unknown as Record<string, unknown>;
      lostHours = res.lostHours;
      amount = res.amount;
    }

    const id = newId("dsr");
    await app.db.insert(disruptionAnalyses).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      claimId: body.claimId ?? null,
      method: body.method,
      trade: body.trade ?? null,
      title: body.title,
      baselineFrom: body.baselineFrom ?? null,
      baselineTo: body.baselineTo ?? null,
      impactedFrom: body.impactedFrom ?? null,
      impactedTo: body.impactedTo ?? null,
      inputs: body as unknown as Record<string, unknown>,
      series,
      output,
      lostHours,
      amount,
      currency,
      justification: body.justification ?? null,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "disruption_analysis",
      objectId: id,
      projectId: req.projectId!,
      payload: { method: body.method, title: body.title, lostHours, amount, currency, claimId: body.claimId ?? null },
    });
    const [created] = await app.db
      .select()
      .from(disruptionAnalyses)
      .where(eq(disruptionAnalyses.id, id))
      .limit(1);
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/forensics/disruption", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.extend({ claimId: z.string().min(1).optional() }).parse(req.query);
    const clauses = [
      eq(disruptionAnalyses.companyId, req.companyId!),
      eq(disruptionAnalyses.projectId, req.projectId!),
    ];
    if (q.claimId) clauses.push(eq(disruptionAnalyses.claimId, q.claimId));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(disruptionAnalyses).where(where);
    const items = await app.db
      .select()
      .from(disruptionAnalyses)
      .where(where)
      .orderBy(desc(disruptionAnalyses.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

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
      .select({ id: delayEvents.id, status: delayEvents.status })
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
    const withdrawn = rows.filter((r) => r.status === "withdrawn").map((r) => r.id);
    if (withdrawn.length > 0) {
      throw badRequest(
        `Withdrawn delay events cannot be linked to a claim: ${withdrawn.join(", ")}. Reopen them first if they are live.`,
      );
    }
    return unique;
  }

  app.post("/projects/:projectId/claims", { preHandler: standardGate }, async (req, reply) => {
    const body = claimCreateSchema.parse(req.body);
    let currency = body.currency ?? null;
    if (body.contractId) {
      const [c] = await app.db
        .select({ id: contracts.id, currency: contracts.currency })
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
      if (currency === null) currency = c.currency;
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
      currency: currency ?? "USD",
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
      projectId: req.projectId!,
      payload: {
        number,
        title: body.title,
        kind: body.kind,
        delayEventIds,
        daysClaimed: body.daysClaimed ?? null,
        amountClaimed: body.amountClaimed ?? null,
        currency: currency ?? "USD",
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
              party: delayEvents.party,
              excusable: delayEvents.excusable,
              compensable: delayEvents.compensable,
              status: delayEvents.status,
              startDate: delayEvents.startDate,
              durationDays: delayEvents.durationDays,
              scheduleId: delayEvents.scheduleId,
              tiaResult: delayEvents.tiaResult,
            })
            .from(delayEvents)
            .where(and(inArray(delayEvents.id, ids), eq(delayEvents.projectId, req.projectId!)))
            .orderBy(asc(delayEvents.number))
        : [];

    // Stale-TIA awareness: the drawer must not present a delta computed
    // against a programme that has since been recomputed.
    const scheduleIds = [...new Set(events.map((e) => e.scheduleId).filter((s): s is string => s !== null))];
    const scheduleRows =
      scheduleIds.length > 0
        ? await app.db
            .select({ id: schedules.id, lastComputedAt: schedules.lastComputedAt })
            .from(schedules)
            .where(inArray(schedules.id, scheduleIds))
        : [];
    const computedAtById = new Map(scheduleRows.map((s) => [s.id, s.lastComputedAt] as const));
    const enriched = events.map((e) => ({
      ...e,
      tia: tiaStaleness(e.tiaResult, e.scheduleId ? (computedAtById.get(e.scheduleId) ?? null) : null),
    }));

    const live = enriched.filter((e) => e.status !== "withdrawn");
    const analyses = await app.db
      .select({
        id: forensicAnalyses.id,
        method: forensicAnalyses.method,
        mipCode: forensicAnalyses.mipCode,
        title: forensicAnalyses.title,
        resultDays: forensicAnalyses.resultDays,
        summary: forensicAnalyses.summary,
        createdAt: forensicAnalyses.createdAt,
      })
      .from(forensicAnalyses)
      .where(eq(forensicAnalyses.claimId, claimId))
      .orderBy(desc(forensicAnalyses.createdAt))
      .limit(50);
    const quantum = await app.db
      .select()
      .from(quantumCalculations)
      .where(eq(quantumCalculations.claimId, claimId))
      .orderBy(desc(quantumCalculations.createdAt))
      .limit(50);
    const disruption = await app.db
      .select({
        id: disruptionAnalyses.id,
        method: disruptionAnalyses.method,
        title: disruptionAnalyses.title,
        lostHours: disruptionAnalyses.lostHours,
        amount: disruptionAnalyses.amount,
        currency: disruptionAnalyses.currency,
        createdAt: disruptionAnalyses.createdAt,
      })
      .from(disruptionAnalyses)
      .where(eq(disruptionAnalyses.claimId, claimId))
      .orderBy(desc(disruptionAnalyses.createdAt))
      .limit(50);

    return {
      ...claim,
      delayEvents: enriched,
      analyses,
      quantumCalculations: quantum,
      disruptionAnalyses: disruption,
      /* Withdrawn events are excluded from the totals; the count says so. */
      totals: {
        liveEvents: live.length,
        withdrawnEvents: enriched.length - live.length,
        compensableDays: live.filter((e) => e.compensable === 1).reduce((s, e) => s + e.durationDays, 0),
        excusableDays: live
          .filter((e) => e.excusable === 1 && e.compensable !== 1)
          .reduce((s, e) => s + e.durationDays, 0),
        tiaDeltaDays: live.reduce((s, e) => s + (e.tia.deltaDays ?? 0), 0),
        staleTia: live.filter((e) => e.tia.stale).length,
      },
      editable: claim.status === "draft",
    };
  });

  app.patch("/projects/:projectId/claims/:claimId", { preHandler: standardGate }, async (req) => {
    const { claimId } = req.params as { claimId: string };
    const body = claimPatchSchema.parse(req.body);
    const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
    if (["agreed", "rejected", "withdrawn"].includes(claim.status)) {
      throw badRequest(`A ${claim.status} claim cannot be edited`);
    }
    /*
     * The case that gets assessed is the case that was submitted. Before this,
     * only the chain and the linked events were frozen after draft, so a
     * claimant could raise amountClaimed from 100k to 500k on a claim that had
     * already been assessed at 100k, and the record then showed an assessment
     * that never considered the claimed figure. Everything that defines the
     * claim is frozen; changing it means an explicit revise back to draft,
     * which clears the assessment.
     */
    if (claim.status !== "draft") {
      const attempted = FROZEN_AFTER_DRAFT.filter((k) => body[k] !== undefined);
      if (attempted.length > 0) {
        throw badRequest(
          `A ${claim.status} claim's ${attempted.join(", ")} cannot be changed. ` +
            "Move the claim back to draft (POST /claims/:id/status {status:\"draft\", reason}) — that clears the assessment — " +
            "and resubmit.",
        );
      }
    }
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.title !== undefined) set["title"] = body.title;
    if (body.clauseRef !== undefined) set["clauseRef"] = body.clauseRef;
    if (body.currency !== undefined) set["currency"] = body.currency;
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
      projectId: req.projectId!,
      payload: { changed: Object.keys(body) },
    });
    return fetchClaim(claimId, req.companyId!, req.projectId!);
  });

  /** Valuation range and provision (#312-313) — separate from the claimed sum. */
  app.put("/projects/:projectId/claims/:claimId/valuation", { preHandler: standardGate }, async (req) => {
    const { claimId } = req.params as { claimId: string };
    const body = claimValuationSchema.parse(req.body);
    const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
    const best = body.quantumBest !== undefined ? body.quantumBest : claim.quantumBest;
    const likely = body.quantumLikely !== undefined ? body.quantumLikely : claim.quantumLikely;
    const worst = body.quantumWorst !== undefined ? body.quantumWorst : claim.quantumWorst;
    const probability =
      body.successProbability !== undefined ? body.successProbability : claim.successProbability;
    const provision = computeProvision({ best, likely, worst, successProbability: probability });
    await app.db
      .update(forensicClaims)
      .set({
        quantumBest: best,
        quantumLikely: likely,
        quantumWorst: worst,
        successProbability: probability,
        provisionAmount: provision.provision,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(forensicClaims.id, claimId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "forensic_claim",
      objectId: claimId,
      projectId: req.projectId!,
      payload: { valuation: { best, likely, worst, probability }, provision: provision.provision, currency: claim.currency },
    });
    const updated = await fetchClaim(claimId, req.companyId!, req.projectId!);
    return { ...updated, provision };
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
      const set: Record<string, unknown> = { status: body.status, updatedAt: now, statusReason: body.reason ?? null };

      if (body.status === "submitted") {
        /*
         * #305: a claim is a cause → effect → entitlement → quantum chain.
         * Submitting an empty chain used to be allowed, and the chain was then
         * frozen empty forever — the claim could only ever be withdrawn.
         */
        const chain = (claim.chain ?? {}) as Record<string, string | undefined>;
        const missing = (["cause", "effect", "entitlement", "quantum"] as const).filter(
          (k) => !chain[k] || chain[k]!.trim().length === 0,
        );
        if (missing.length > 0) {
          throw badRequest(
            `A claim cannot be submitted with an incomplete chain — the ${missing.join(", ")} limb${missing.length === 1 ? " is" : "s are"} empty (#305).`,
          );
        }
        const hasEvents = (claim.delayEventIds ?? []).length > 0;
        if (!hasEvents && claim.daysClaimed === null && claim.amountClaimed === null) {
          throw badRequest(
            "A claim cannot be submitted with no delay events and neither a days nor an amount claimed — there is nothing to assess.",
          );
        }
      }

      if (body.status === "draft") {
        // The REVISE transition: clear the assessment so an assessed figure can
        // never survive against changed numbers, and count the revision.
        set["daysAssessed"] = null;
        set["amountAssessed"] = null;
        set["assessedBy"] = null;
        set["assessedAt"] = null;
        set["decidedBy"] = null;
        set["decidedAt"] = null;
        set["revisionCount"] = claim.revisionCount + 1;
        if (!body.reason) throw badRequest("A reason is required to take a claim back to draft");
      }

      if (body.status === "assessed") {
        // Determination independence (#310): the assessor must not be the
        // party who prepared the claim.
        if (req.user!.id === claim.createdBy) {
          throw forbidden("A claim cannot be assessed by the user who created it");
        }
        if (body.daysAssessed !== undefined) set["daysAssessed"] = body.daysAssessed;
        if (body.amountAssessed !== undefined) set["amountAssessed"] = body.amountAssessed;
        set["assessedBy"] = req.user!.id;
        set["assessedAt"] = now;
      }

      if (body.status === "agreed" || body.status === "rejected") {
        /*
         * Segregation of duties on the DETERMINATION, not just the assessment.
         * Before this, only "assessed" checked the creator, so the claimant
         * could post {status:"agreed"} on their own assessed claim and the
         * ledger recorded them agreeing their own claim.
         */
        if (req.user!.id === claim.createdBy) {
          throw forbidden(
            `A claim cannot be ${body.status} by the user who created it — the determination must be independent.`,
          );
        }
        if (claim.assessedBy && req.user!.id === claim.assessedBy) {
          throw forbidden(
            `A claim cannot be ${body.status} by the user who assessed it — assessment and determination are separate roles.`,
          );
        }
        set["decidedBy"] = req.user!.id;
        set["decidedAt"] = now;
      }

      await app.db.update(forensicClaims).set(set).where(eq(forensicClaims.id, claimId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "forensic_claim",
        objectId: claimId,
        projectId: req.projectId!,
        payload: {
          from: claim.status,
          to: body.status,
          reason: body.reason ?? null,
          daysAssessed: body.status === "assessed" ? (body.daysAssessed ?? null) : claim.daysAssessed,
          amountAssessed:
            body.status === "assessed" ? (body.amountAssessed ?? null) : claim.amountAssessed,
          currency: claim.currency,
        },
      });
      return fetchClaim(claimId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Claim-scoped chronology (#318)                                    */
  /* ---------------------------------------------------------------- */

  const CHRONOLOGY_MARGIN_DAYS = 30;
  const MAX_CHRONOLOGY_ENTRIES = 2000;

  app.post(
    "/projects/:projectId/claims/:claimId/chronology",
    { preHandler: standardGate },
    async (req) => {
      const { claimId } = req.params as { claimId: string };
      const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const entries: { date: string; source: string; ref: string; title: string; recordId: string }[] = [];
      const reasons: string[] = [];

      /*
       * The chronology used to be PROJECT-WIDE: every RFI, every daily log
       * (jsonb sections included), every contract event and variation on the
       * project, loaded into memory with no window. Two unrelated claims got
       * byte-identical chronologies, and on a live project the request pulled
       * every row. It is now scoped to the claim: its live delay events, their
       * date span plus a margin, its contract, and the tasks those events
       * strike.
       */
      const ids = claim.delayEventIds ?? [];
      const eventRows =
        ids.length > 0
          ? await app.db
              .select({
                id: delayEvents.id,
                number: delayEvents.number,
                title: delayEvents.title,
                startDate: delayEvents.startDate,
                durationDays: delayEvents.durationDays,
                status: delayEvents.status,
                taskId: delayEvents.taskId,
                contractEventId: delayEvents.contractEventId,
              })
              .from(delayEvents)
              .where(
                and(
                  inArray(delayEvents.id, ids),
                  eq(delayEvents.companyId, companyId),
                  eq(delayEvents.projectId, projectId),
                  ne(delayEvents.status, "withdrawn"),
                ),
              )
              .orderBy(asc(delayEvents.startDate))
          : [];
      if (ids.length > eventRows.length) {
        reasons.push(
          `${ids.length - eventRows.length} linked delay event(s) are withdrawn and were excluded from the chronology`,
        );
      }
      if (eventRows.length === 0) {
        reasons.push(
          "The claim links no live delay events, so the chronology falls back to the claim's contract only — link events to scope it",
        );
      }

      for (const ev of eventRows) {
        entries.push({
          date: ev.startDate,
          source: "delay_event",
          ref: `DE-${ev.number}`,
          title: ev.title,
          recordId: ev.id,
        });
      }

      const spanStart = minIso(eventRows.map((e) => e.startDate));
      const spanEnd = maxIso(eventRows.map((e) => addDaysIso(e.startDate, e.durationDays)));
      const from = spanStart ? addDaysIso(spanStart, -CHRONOLOGY_MARGIN_DAYS) : null;
      const to = spanEnd ? addDaysIso(spanEnd, CHRONOLOGY_MARGIN_DAYS) : null;

      /* ---- contract events: this claim's contract, inside the window ---- */
      const ceClauses = [eq(contractEvents.companyId, companyId), eq(contractEvents.projectId, projectId)];
      if (claim.contractId) ceClauses.push(eq(contractEvents.contractId, claim.contractId));
      if (from) ceClauses.push(gte(contractEvents.eventDate, from));
      if (to) ceClauses.push(lte(contractEvents.eventDate, to));
      const linkedContractEventIds = eventRows
        .map((e) => e.contractEventId)
        .filter((x): x is string => x !== null);
      const cEvents = await app.db
        .select({
          id: contractEvents.id,
          number: contractEvents.number,
          title: contractEvents.title,
          eventDate: contractEvents.eventDate,
          noticeServedAt: contractEvents.noticeServedAt,
        })
        .from(contractEvents)
        .where(
          linkedContractEventIds.length > 0
            ? or(and(...ceClauses), inArray(contractEvents.id, linkedContractEventIds))!
            : and(...ceClauses),
        )
        .limit(500);
      for (const ev of cEvents) {
        entries.push({
          date: ev.eventDate,
          source: "contract_event",
          ref: `CE-${ev.number}`,
          title: ev.title,
          recordId: ev.id,
        });
        if (ev.noticeServedAt) {
          entries.push({
            date: ev.noticeServedAt.slice(0, 10),
            source: "contract_event",
            ref: `CE-${ev.number}`,
            title: `Notice served — ${ev.title}`,
            recordId: ev.id,
          });
        }
      }

      if (from && to) {
        /* ---- RFIs raised or answered inside the window ---- */
        const rfiRows = await app.db
          .select({
            id: rfis.id,
            number: rfis.number,
            subject: rfis.subject,
            createdAt: rfis.createdAt,
            respondedAt: rfis.respondedAt,
          })
          .from(rfis)
          .where(
            and(
              eq(rfis.companyId, companyId),
              eq(rfis.projectId, projectId),
              gte(rfis.createdAt, `${from}T00:00:00Z`),
              lte(rfis.createdAt, `${to}T23:59:59Z`),
            ),
          )
          .limit(500);
        for (const r of rfiRows) {
          entries.push({
            date: r.createdAt.slice(0, 10),
            source: "rfi",
            ref: `RFI-${r.number}`,
            title: `RFI raised — ${r.subject}`,
            recordId: r.id,
          });
          if (r.respondedAt) {
            entries.push({
              date: r.respondedAt.slice(0, 10),
              source: "rfi",
              ref: `RFI-${r.number}`,
              title: `RFI answered — ${r.subject}`,
              recordId: r.id,
            });
          }
        }

        /* ---- daily logs recording a delay inside the window ---- */
        const logRows = await app.db
          .select({ id: dailyLogs.id, logDate: dailyLogs.logDate, sections: dailyLogs.sections })
          .from(dailyLogs)
          .where(
            and(
              eq(dailyLogs.companyId, companyId),
              eq(dailyLogs.projectId, projectId),
              gte(dailyLogs.logDate, from),
              lte(dailyLogs.logDate, to),
            ),
          )
          .limit(500);
        for (const log of logRows) {
          const delays = (log.sections ?? {})["delays"];
          if (Array.isArray(delays) && delays.length > 0) {
            entries.push({
              date: log.logDate,
              source: "daily_log",
              ref: `LOG-${log.logDate}`,
              title: `Daily log records ${delays.length} delay ${delays.length === 1 ? "entry" : "entries"}`,
              recordId: log.id,
            });
          }
        }

        /* ---- variations instructed inside the window ---- */
        const varClauses = [
          eq(variations.companyId, companyId),
          eq(variations.projectId, projectId),
          isNotNull(variations.instructedAt),
          gte(variations.instructedAt, from),
          lte(variations.instructedAt, to),
        ];
        // Scope to the claim's contract, but keep variations that name no
        // contract: excluding them would silently drop instructions that are
        // in the window and may well belong to this claim.
        if (claim.contractId) {
          varClauses.push(
            or(eq(variations.contractId, claim.contractId), isNull(variations.contractId))!,
          );
        }
        const varRows = await app.db
          .select({
            id: variations.id,
            number: variations.number,
            title: variations.title,
            instructedAt: variations.instructedAt,
          })
          .from(variations)
          .where(and(...varClauses))
          .limit(500);
        for (const v of varRows) {
          entries.push({
            date: v.instructedAt!,
            source: "variation",
            ref: `VO-${v.number}`,
            title: `Variation instructed — ${v.title}`,
            recordId: v.id,
          });
        }
      } else {
        reasons.push("No date window could be derived, so only the claim's contract events were assembled");
      }

      entries.sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          a.source.localeCompare(b.source) ||
          a.ref.localeCompare(b.ref),
      );
      const capped = entries.slice(0, MAX_CHRONOLOGY_ENTRIES);
      if (entries.length > capped.length) {
        reasons.push(`${entries.length - capped.length} further entries were omitted (cap ${MAX_CHRONOLOGY_ENTRIES})`);
      }

      const chronologyAt = new Date().toISOString();
      await app.db
        .update(forensicClaims)
        .set({ chronology: capped, chronologyAt, updatedAt: chronologyAt })
        .where(eq(forensicClaims.id, claimId));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "update",
        objectType: "forensic_claim",
        objectId: claimId,
        projectId,
        payload: { chronologyAt, entryCount: capped.length, window: { from, to } },
      });
      return {
        claimId: claim.id,
        chronologyAt,
        count: capped.length,
        window: { from, to },
        scope: {
          delayEvents: eventRows.length,
          contractId: claim.contractId,
        },
        reasons,
        items: capped,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Record sufficiency, gaps and the submission package (#307-309, #317-319) */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/claims/:claimId/sufficiency",
    { preHandler: standardGate },
    async (req) => {
      const { claimId } = req.params as { claimId: string };
      const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
      const ids = claim.delayEventIds ?? [];
      const eventRows =
        ids.length > 0
          ? await app.db
              .select()
              .from(delayEvents)
              .where(
                and(
                  inArray(delayEvents.id, ids),
                  eq(delayEvents.companyId, req.companyId!),
                  eq(delayEvents.projectId, req.projectId!),
                  ne(delayEvents.status, "withdrawn"),
                ),
              )
              .orderBy(asc(delayEvents.number))
          : [];

      const allEvidenceIds = [...new Set(eventRows.flatMap((e) => e.evidenceIds ?? []))];
      const evidenceRows =
        allEvidenceIds.length > 0
          ? await app.db
              .select({
                id: evidence.id,
                kind: evidence.kind,
                independenceScore: evidence.independenceScore,
                capturedAt: evidence.capturedAt,
              })
              .from(evidence)
              .where(
                and(inArray(evidence.id, allEvidenceIds), eq(evidence.projectId, req.projectId!)),
              )
          : [];
      const evidenceById = new Map(evidenceRows.map((e) => [e.id, e] as const));

      const contractEventIds = eventRows
        .map((e) => e.contractEventId)
        .filter((x): x is string => x !== null);
      const noticeRows =
        contractEventIds.length > 0
          ? await app.db
              .select({ id: contractEvents.id, noticeServedAt: contractEvents.noticeServedAt })
              .from(contractEvents)
              .where(
                and(
                  inArray(contractEvents.id, contractEventIds),
                  eq(contractEvents.projectId, req.projectId!),
                ),
              )
          : [];
      const noticeById = new Map(noticeRows.map((n) => [n.id, n.noticeServedAt] as const));

      const spanStart = minIso(eventRows.map((e) => e.startDate));
      const spanEnd = maxIso(eventRows.map((e) => addDaysIso(e.startDate, e.durationDays)));
      const logDates = new Set<string>();
      if (spanStart && spanEnd) {
        const logs = await app.db
          .select({ logDate: dailyLogs.logDate })
          .from(dailyLogs)
          .where(
            and(
              eq(dailyLogs.companyId, req.companyId!),
              eq(dailyLogs.projectId, req.projectId!),
              gte(dailyLogs.logDate, spanStart),
              lte(dailyLogs.logDate, spanEnd),
            ),
          )
          .limit(2000);
        for (const l of logs) logDates.add(l.logDate);
      }

      const events: EventSufficiencyInput[] = eventRows.map((e) => {
        const evidenceForEvent = (e.evidenceIds ?? [])
          .map((id) => evidenceById.get(id))
          .filter((x): x is NonNullable<typeof x> => x !== undefined);
        const recordTypes = new Set<string>(evidenceForEvent.map((x) => x.kind));
        const spanDays = Math.max(1, e.durationDays);
        const eventLogDates: string[] = [];
        for (let i = 0; i < spanDays; i += 1) {
          const day = addDaysIso(e.startDate, i);
          if (logDates.has(day)) eventLogDates.push(day);
        }
        if (eventLogDates.length > 0) recordTypes.add("daily_log");
        if (e.contractEventId) recordTypes.add("correspondence");
        return {
          eventId: e.id,
          number: e.number,
          title: e.title,
          startDate: e.startDate,
          durationDays: e.durationDays,
          evidence: evidenceForEvent.map((x) => ({
            id: x.id,
            kind: x.kind,
            independenceScore: x.independenceScore,
            capturedAt: x.capturedAt,
          })),
          noticeServedAt: e.contractEventId ? (noticeById.get(e.contractEventId) ?? null) : null,
          noticeDueDate: e.noticeDueDate,
          dailyLogDates: eventLogDates,
          recordTypes: [...recordTypes],
        };
      });

      const chain = (claim.chain ?? {}) as Record<string, string | undefined>;
      const allEvidence = events.flatMap((e) => e.evidence);
      const limbs: ChainLimbInput[] = (["cause", "effect", "entitlement", "quantum"] as const).map((key) => ({
        key,
        text: chain[key] ?? "",
        evidence: allEvidence,
      }));

      const result = scoreClaimSufficiency({ limbs, events });
      const scoredAt = result.scoredAt;
      await app.db
        .update(forensicClaims)
        .set({ sufficiency: result as unknown as Record<string, unknown>, sufficiencyAt: scoredAt, updatedAt: scoredAt })
        .where(eq(forensicClaims.id, claimId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "forensic_claim",
        objectId: claimId,
        projectId: req.projectId!,
        payload: {
          sufficiencyScore: result.overallScore,
          gaps: result.gaps.length,
          missingNotices: result.missingNotices.length,
        },
      });
      return { claimId, ...result };
    },
  );

  /** Scott Schedule generation (#317-319). */
  app.post(
    "/projects/:projectId/claims/:claimId/scott-schedule",
    { preHandler: standardGate },
    async (req) => {
      const { claimId } = req.params as { claimId: string };
      const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
      const ids = claim.delayEventIds ?? [];
      const eventRows =
        ids.length > 0
          ? await app.db
              .select()
              .from(delayEvents)
              .where(
                and(
                  inArray(delayEvents.id, ids),
                  eq(delayEvents.companyId, req.companyId!),
                  eq(delayEvents.projectId, req.projectId!),
                  ne(delayEvents.status, "withdrawn"),
                ),
              )
              .orderBy(asc(delayEvents.number))
          : [];
      if (eventRows.length === 0) {
        throw badRequest("The claim links no live delay events — a Scott Schedule needs items to schedule");
      }
      const scheduleIds = [...new Set(eventRows.map((e) => e.scheduleId).filter((s): s is string => s !== null))];
      const scheduleRows =
        scheduleIds.length > 0
          ? await app.db
              .select({ id: schedules.id, lastComputedAt: schedules.lastComputedAt })
              .from(schedules)
              .where(inArray(schedules.id, scheduleIds))
          : [];
      const computedAtById = new Map(scheduleRows.map((s) => [s.id, s.lastComputedAt] as const));

      const rows = buildScottSchedule({
        claimNumber: claim.number,
        claimTitle: claim.title,
        currency: claim.currency,
        events: eventRows.map((e) => {
          const tia = tiaStaleness(
            e.tiaResult,
            e.scheduleId ? (computedAtById.get(e.scheduleId) ?? null) : null,
          );
          return {
            id: e.id,
            number: e.number,
            title: e.title,
            description: e.description,
            cause: e.cause,
            party: e.party,
            excusable: e.excusable === 1,
            compensable: e.compensable === 1,
            startDate: e.startDate,
            durationDays: e.durationDays,
            evidenceIds: e.evidenceIds ?? [],
            tiaDeltaDays: tia.deltaDays,
          };
        }),
      });
      const now = new Date().toISOString();
      await app.db
        .update(forensicClaims)
        .set({ scottSchedule: rows, packageAt: now, updatedAt: now })
        .where(eq(forensicClaims.id, claimId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "forensic_claim",
        objectId: claimId,
        projectId: req.projectId!,
        payload: { scottSchedule: rows.length, generatedAt: now },
      });
      return { claimId, generatedAt: now, currency: claim.currency, rows };
    },
  );

  /** Submission package: everything the claim rests on, in one payload. */
  app.get("/projects/:projectId/claims/:claimId/package", { preHandler: readGate }, async (req) => {
    const { claimId } = req.params as { claimId: string };
    const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
    const ids = claim.delayEventIds ?? [];
    const eventRows =
      ids.length > 0
        ? await app.db
            .select()
            .from(delayEvents)
            .where(and(inArray(delayEvents.id, ids), eq(delayEvents.projectId, req.projectId!)))
            .orderBy(asc(delayEvents.number))
        : [];
    const analyses = await app.db
      .select()
      .from(forensicAnalyses)
      .where(eq(forensicAnalyses.claimId, claimId))
      .orderBy(asc(forensicAnalyses.createdAt))
      .limit(50);
    const quantum = await app.db
      .select()
      .from(quantumCalculations)
      .where(eq(quantumCalculations.claimId, claimId))
      .orderBy(asc(quantumCalculations.createdAt))
      .limit(50);
    const disruption = await app.db
      .select()
      .from(disruptionAnalyses)
      .where(eq(disruptionAnalyses.claimId, claimId))
      .orderBy(asc(disruptionAnalyses.createdAt))
      .limit(50);
    const missing: string[] = [];
    if (!claim.chronology) missing.push("chronology has not been assembled");
    if (!claim.sufficiency) missing.push("record sufficiency has not been scored");
    if (!claim.scottSchedule) missing.push("the Scott Schedule has not been generated");
    if (analyses.length === 0) missing.push("no delay analysis has been recorded against this claim");
    if (quantum.length === 0 && disruption.length === 0) missing.push("no quantum or disruption calculation is linked");

    return {
      claim,
      delayEvents: eventRows,
      analyses,
      quantumCalculations: quantum,
      disruptionAnalyses: disruption,
      chronology: claim.chronology ?? null,
      sufficiency: claim.sufficiency ?? null,
      scottSchedule: claim.scottSchedule ?? null,
      completeness: {
        ready: missing.length === 0,
        missing,
      },
      generatedAt: new Date().toISOString(),
    };
  });

  /* ---------------------------------------------------------------- */
  /* Exposure & health inputs                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Portfolio claim exposure (#313, #320). Money is bucketed BY CURRENCY and
   * never summed across them: a single "total exposure" over GBP and USD
   * claims would be a fabricated number.
   */
  app.get("/claims/exposure", { preHandler: [app.authenticate, app.requireCompany] }, async (req) => {
    const q = z.object({ projectId: z.string().min(1).optional() }).parse(req.query);
    const clauses = [eq(forensicClaims.companyId, req.companyId!)];
    if (q.projectId) clauses.push(eq(forensicClaims.projectId, q.projectId));
    const rows = await app.db
      .select({
        id: forensicClaims.id,
        projectId: forensicClaims.projectId,
        number: forensicClaims.number,
        title: forensicClaims.title,
        kind: forensicClaims.kind,
        status: forensicClaims.status,
        currency: forensicClaims.currency,
        daysClaimed: forensicClaims.daysClaimed,
        amountClaimed: forensicClaims.amountClaimed,
        amountAssessed: forensicClaims.amountAssessed,
        quantumLikely: forensicClaims.quantumLikely,
        successProbability: forensicClaims.successProbability,
        provisionAmount: forensicClaims.provisionAmount,
      })
      .from(forensicClaims)
      .where(and(...clauses))
      .orderBy(desc(forensicClaims.createdAt))
      .limit(2000);

    const open = rows.filter((r) => !["agreed", "rejected", "withdrawn"].includes(r.status));
    const byCurrency = new Map<
      string,
      { currency: string; claims: number; claimed: number; provision: number; unprovisioned: number }
    >();
    for (const r of open) {
      const b = byCurrency.get(r.currency) ?? {
        currency: r.currency,
        claims: 0,
        claimed: 0,
        provision: 0,
        unprovisioned: 0,
      };
      b.claims += 1;
      b.claimed += r.amountClaimed ?? 0;
      if (r.provisionAmount !== null) b.provision += r.provisionAmount;
      else b.unprovisioned += 1;
      byCurrency.set(r.currency, b);
    }
    const reasons: string[] = [];
    if (byCurrency.size > 1) {
      reasons.push(
        `Claims are held in ${byCurrency.size} currencies (${[...byCurrency.keys()].join(", ")}) — exposure is reported per currency and never summed across them`,
      );
    }
    const unvalued = open.filter((r) => r.quantumLikely === null || r.successProbability === null).length;
    if (unvalued > 0) {
      reasons.push(`${unvalued} open claim(s) have no valuation range or probability of success, so they carry no provision`);
    }

    return {
      generatedAt: new Date().toISOString(),
      openClaims: open.length,
      totalClaims: rows.length,
      byCurrency: [...byCurrency.values()],
      byStatus: Object.fromEntries(
        [...new Set(rows.map((r) => r.status))].map((s) => [s, rows.filter((r) => r.status === s).length]),
      ),
      claims: open,
      reasons,
    };
  });

  app.get("/projects/:projectId/forensics/health-inputs", { preHandler: readGate }, async (req) => {
    const reasons: string[] = [];
    const events = await app.db
      .select({
        id: delayEvents.id,
        status: delayEvents.status,
        excusable: delayEvents.excusable,
        compensable: delayEvents.compensable,
        durationDays: delayEvents.durationDays,
        noticeDueDate: delayEvents.noticeDueDate,
        contractEventId: delayEvents.contractEventId,
        tiaResult: delayEvents.tiaResult,
      })
      .from(delayEvents)
      .where(
        and(
          eq(delayEvents.companyId, req.companyId!),
          eq(delayEvents.projectId, req.projectId!),
          ne(delayEvents.status, "withdrawn"),
        ),
      )
      .limit(2000);
    const claims = await app.db
      .select({
        id: forensicClaims.id,
        status: forensicClaims.status,
        currency: forensicClaims.currency,
        amountClaimed: forensicClaims.amountClaimed,
        provisionAmount: forensicClaims.provisionAmount,
        sufficiency: forensicClaims.sufficiency,
      })
      .from(forensicClaims)
      .where(
        and(
          eq(forensicClaims.companyId, req.companyId!),
          eq(forensicClaims.projectId, req.projectId!),
        ),
      )
      .limit(2000);

    const openClaims = claims.filter((c) => !["agreed", "rejected", "withdrawn"].includes(c.status));
    const currencies = [...new Set(openClaims.map((c) => c.currency))];
    if (currencies.length > 1) {
      reasons.push(
        `Open claims are held in ${currencies.join(", ")} — claimed value is not available as a single figure`,
      );
    }
    const withoutNotice = events.filter((e) => !e.contractEventId).length;
    if (withoutNotice > 0) reasons.push(`${withoutNotice} live delay event(s) have no notice recorded`);

    const sufficiencyScores = claims
      .map((c) => (c.sufficiency as { overallScore?: number } | null)?.overallScore)
      .filter((n): n is number => typeof n === "number");
    if (sufficiencyScores.length === 0) {
      reasons.push("No claim has been scored for record sufficiency");
    }

    return {
      metrics: {
        liveDelayEvents: events.length,
        compensableDaysOpen: events
          .filter((e) => e.compensable === 1 && e.status === "open")
          .reduce((s, e) => s + e.durationDays, 0),
        excusableDaysOpen: events
          .filter((e) => e.excusable === 1 && e.compensable !== 1 && e.status === "open")
          .reduce((s, e) => s + e.durationDays, 0),
        eventsWithoutNotice: withoutNotice,
        eventsWithoutTia: events.filter((e) => !e.tiaResult).length,
        openClaims: openClaims.length,
        claimedValue:
          currencies.length === 1
            ? openClaims.reduce((s, c) => s + (c.amountClaimed ?? 0), 0)
            : null,
        provisionValue:
          currencies.length === 1
            ? openClaims.reduce((s, c) => s + (c.provisionAmount ?? 0), 0)
            : null,
        currency: currencies.length === 1 ? (currencies[0] ?? null) : null,
        meanSufficiencyScore:
          sufficiencyScores.length > 0
            ? Math.round((sufficiencyScores.reduce((a, b) => a + b, 0) / sufficiencyScores.length) * 100) / 100
            : null,
      },
      reasons,
    };
  });
};
