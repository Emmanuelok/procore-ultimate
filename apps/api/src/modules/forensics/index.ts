import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";
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
