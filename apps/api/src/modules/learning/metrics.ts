import { and, eq, isNotNull, ne } from "drizzle-orm";
import {
  contracts,
  lessonTriggers,
  lessons,
  obligations,
  paymentCertificates,
  projects,
  punchItems,
  rfis,
  scheduleBaselines,
  scheduleTasks,
  schedules,
  signals,
  valuations,
  variations,
} from "@constructos/db";
import type { Db } from "../../lib/db.js";

/**
 * Post-project review metrics computed FROM PLATFORM RECORDS (#991).
 *
 * A post-project review whose numbers come from the room's memory is a
 * feelings exercise. Every figure here is read back out of the records the
 * project already wrote, and every figure the platform cannot compute comes
 * back as `null` with the reason it is null — never a fabricated zero. This
 * is the same contract as `modules/benchmarks/metrics.ts`; the shape is
 * deliberately identical so a reader who knows one knows both.
 */

export const round2 = (n: number): number => Math.round(n * 100) / 100;

const MS_PER_DAY = 86_400_000;

function daysBetweenDates(startISO: string, endISO: string): number {
  return (Date.parse(endISO) - Date.parse(startISO)) / MS_PER_DAY;
}

export interface ReviewMetric {
  key: string;
  name: string;
  unit: string;
  /** null when the platform does not hold the inputs — never a fabricated number */
  value: number | null;
  /** the exact figures the computation read, persisted for auditability */
  inputs: Record<string, unknown>;
  /** why value is null; empty when a value was computed */
  reasons: string[];
}

export interface ReviewMetricsResult {
  computedAt: string;
  projectId: string;
  currency: string | null;
  metrics: ReviewMetric[];
  /** keys the platform could not compute, so the UI can say so plainly */
  unavailable: string[];
  methodology: string;
}

export interface ReviewMetricsContext {
  companyId: string;
  projectId: string;
}

const metric = (
  key: string,
  name: string,
  unit: string,
  value: number | null,
  inputs: Record<string, unknown>,
  reasons: string[] = [],
): ReviewMetric => ({ key, name, unit, value, inputs, reasons });

/* ------------------------------------------------------------------ */
/* Input readers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Approved budget basis, read exactly the way the benchmarks module reads it:
 * executed/completed contract sums as the original budget, agreed variations
 * as the approved growth. A draft contract is a proposal, not a budget.
 */
async function readBudget(db: Db, ctx: ReviewMetricsContext) {
  const contractRows = await db
    .select({
      contractSum: contracts.contractSum,
      currency: contracts.currency,
      status: contracts.status,
    })
    .from(contracts)
    .where(and(eq(contracts.companyId, ctx.companyId), eq(contracts.projectId, ctx.projectId)));
  const counted = contractRows.filter(
    (c) =>
      (c.status === "executed" || c.status === "completed") &&
      c.contractSum != null &&
      c.contractSum > 0,
  );
  const originalContractSum = round2(counted.reduce((s, c) => s + (c.contractSum ?? 0), 0));

  const variationRows = await db
    .select({
      status: variations.status,
      agreedValue: variations.agreedValue,
      costEstimate: variations.costEstimate,
      timeImpactDays: variations.timeImpactDays,
    })
    .from(variations)
    .where(and(eq(variations.companyId, ctx.companyId), eq(variations.projectId, ctx.projectId)));
  const agreed = variationRows.filter((v) => v.status === "agreed");
  const agreedValue = round2(agreed.reduce((s, v) => s + (v.agreedValue ?? v.costEstimate ?? 0), 0));

  return {
    contractsCounted: counted.length,
    originalContractSum,
    agreedVariationsValue: agreedValue,
    currentApprovedBudget: round2(originalContractSum + agreedValue),
    currency: counted[0]?.currency ?? null,
    variationRows,
    agreedCount: agreed.length,
  };
}

/** Certified outturn: Σ netCertified over non-withdrawn payment certificates. */
async function readOutturn(db: Db, ctx: ReviewMetricsContext) {
  const rows = await db
    .select({
      netCertified: paymentCertificates.netCertified,
      number: paymentCertificates.number,
    })
    .from(paymentCertificates)
    .innerJoin(valuations, eq(valuations.id, paymentCertificates.valuationId))
    .where(
      and(
        eq(paymentCertificates.companyId, ctx.companyId),
        eq(paymentCertificates.projectId, ctx.projectId),
        ne(paymentCertificates.status, "withdrawn"),
      ),
    );
  return {
    certificateCount: rows.length,
    certifiedToDate: round2(rows.reduce((s, r) => s + r.netCertified, 0)),
  };
}

/** As-planned finish (earliest baseline) against the recorded actual finish. */
async function readScheduleOutturn(db: Db, ctx: ReviewMetricsContext) {
  const scheduleRows = await db
    .select()
    .from(schedules)
    .where(
      and(
        eq(schedules.companyId, ctx.companyId),
        eq(schedules.projectId, ctx.projectId),
        eq(schedules.isActive, 1),
      ),
    );
  const schedule = scheduleRows[scheduleRows.length - 1] ?? null;
  if (!schedule) return { schedule: null, baseline: null, actualFinish: null, tasksWithActual: 0 };

  const baselineRows = await db
    .select({
      id: scheduleBaselines.id,
      projectStart: scheduleBaselines.projectStart,
      computedFinish: scheduleBaselines.computedFinish,
      capturedAt: scheduleBaselines.capturedAt,
    })
    .from(scheduleBaselines)
    .where(eq(scheduleBaselines.scheduleId, schedule.id));
  baselineRows.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));

  const actualRows = await db
    .select({ actualFinish: scheduleTasks.actualFinish })
    .from(scheduleTasks)
    .where(
      and(eq(scheduleTasks.scheduleId, schedule.id), isNotNull(scheduleTasks.actualFinish)),
    );
  const finishes = actualRows
    .map((r) => r.actualFinish)
    .filter((f): f is string => Boolean(f))
    .sort();
  return {
    schedule,
    baseline: baselineRows[0] ?? null,
    actualFinish: finishes[finishes.length - 1] ?? null,
    tasksWithActual: finishes.length,
  };
}

/* ------------------------------------------------------------------ */
/* The computation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Build the whole metrics object for one project. Reads: contracts,
 * variations, payment certificates, the active schedule and its earliest
 * baseline, task actual finishes, signals, obligations, RFIs, punch items,
 * and this module's own lessons and triggers.
 */
export async function computeReviewMetrics(
  db: Db,
  ctx: ReviewMetricsContext,
): Promise<ReviewMetricsResult> {
  const computedAt = new Date().toISOString();
  const out: ReviewMetric[] = [];

  const [projectRow] = await db
    .select({ currency: projects.currency, stage: projects.stage })
    .from(projects)
    .where(and(eq(projects.id, ctx.projectId), eq(projects.companyId, ctx.companyId)))
    .limit(1);

  /* --- Budget vs outturn ------------------------------------------ */

  const budget = await readBudget(db, ctx);
  const outturn = await readOutturn(db, ctx);
  const currency = budget.currency ?? projectRow?.currency ?? null;

  out.push(
    metric(
      "approved_budget",
      "Approved budget at closeout",
      currency ?? "currency",
      budget.contractsCounted === 0 ? null : budget.currentApprovedBudget,
      {
        contractsCounted: budget.contractsCounted,
        originalContractSum: budget.originalContractSum,
        agreedVariationsValue: budget.agreedVariationsValue,
      },
      budget.contractsCounted === 0
        ? [
            "No executed or completed contract with a contract sum on this project — the " +
              "platform holds no approved budget to compare against.",
          ]
        : [],
    ),
  );

  out.push(
    metric(
      "outturn_cost",
      "Certified outturn cost",
      currency ?? "currency",
      outturn.certificateCount === 0 ? null : outturn.certifiedToDate,
      { certificateCount: outturn.certificateCount, certifiedToDate: outturn.certifiedToDate },
      outturn.certificateCount === 0
        ? [
            "No payment certificate has been issued on this project — outturn cost is not in " +
              "the platform. It was not assumed to equal the budget.",
          ]
        : [],
    ),
  );

  const canCompare =
    budget.contractsCounted > 0 &&
    budget.currentApprovedBudget > 0 &&
    outturn.certificateCount > 0;
  out.push(
    metric(
      "cost_variance_pct",
      "Outturn against approved budget",
      "%",
      canCompare
        ? round2(
            ((outturn.certifiedToDate - budget.currentApprovedBudget) /
              budget.currentApprovedBudget) *
              100,
          )
        : null,
      {
        approvedBudget: budget.contractsCounted === 0 ? null : budget.currentApprovedBudget,
        certifiedToDate: outturn.certificateCount === 0 ? null : outturn.certifiedToDate,
      },
      canCompare
        ? []
        : [
            budget.contractsCounted === 0 || budget.currentApprovedBudget <= 0
              ? "No approved budget on this project."
              : "No certified outturn on this project.",
          ],
    ),
  );

  /* --- Baseline vs actual finish ---------------------------------- */

  const sched = await readScheduleOutturn(db, ctx);
  const scheduleReasons: string[] = [];
  if (!sched.schedule) {
    scheduleReasons.push("No active schedule on this project.");
  } else {
    if (!sched.baseline) {
      scheduleReasons.push(
        "No schedule baseline was ever captured — there is no as-planned finish to measure against.",
      );
    } else if (!sched.baseline.computedFinish) {
      scheduleReasons.push("The earliest baseline has no computed finish — run the CPM engine.");
    }
    if (!sched.actualFinish) {
      scheduleReasons.push(
        "No task on the active schedule carries an actual finish date — the project's real " +
          "completion date is not in the platform.",
      );
    }
  }
  const scheduleInputs: Record<string, unknown> = {
    scheduleId: sched.schedule?.id ?? null,
    baselineId: sched.baseline?.id ?? null,
    baselineFinish: sched.baseline?.computedFinish ?? null,
    actualFinish: sched.actualFinish,
    tasksWithActualFinish: sched.tasksWithActual,
  };
  out.push(
    metric(
      "finish_variance_days",
      "Actual finish against baseline finish",
      "days",
      scheduleReasons.length === 0
        ? round2(daysBetweenDates(sched.baseline!.computedFinish!, sched.actualFinish!))
        : null,
      scheduleInputs,
      scheduleReasons,
    ),
  );

  /* --- Variations -------------------------------------------------- */

  const byStatus: Record<string, number> = {};
  for (const v of budget.variationRows) byStatus[v.status] = (byStatus[v.status] ?? 0) + 1;
  out.push(
    metric("variation_count", "Variations raised", "count", budget.variationRows.length, {
      byStatus,
      agreedCount: budget.agreedCount,
    }),
  );
  out.push(
    metric(
      "variation_value_agreed",
      "Value of agreed variations",
      currency ?? "currency",
      budget.agreedVariationsValue,
      { agreedCount: budget.agreedCount },
    ),
  );

  /* --- Assurance --------------------------------------------------- */

  const signalRows = await db
    .select({ severity: signals.severity, disposition: signals.disposition })
    .from(signals)
    .where(and(eq(signals.companyId, ctx.companyId), eq(signals.projectId, ctx.projectId)));
  const bySeverity: Record<string, number> = {};
  const byDisposition: Record<string, number> = {};
  for (const s of signalRows) {
    bySeverity[s.severity] = (bySeverity[s.severity] ?? 0) + 1;
    byDisposition[s.disposition] = (byDisposition[s.disposition] ?? 0) + 1;
  }
  out.push(
    metric("signals_raised", "Integrity signals raised", "count", signalRows.length, {
      bySeverity,
      byDisposition,
      confirmed: byDisposition["confirmed"] ?? 0,
    }),
  );

  const obligationRows = await db
    .select({ status: obligations.status })
    .from(obligations)
    .where(and(eq(obligations.companyId, ctx.companyId), eq(obligations.projectId, ctx.projectId)));
  const obligationsByStatus: Record<string, number> = {};
  for (const o of obligationRows) {
    obligationsByStatus[o.status] = (obligationsByStatus[o.status] ?? 0) + 1;
  }
  out.push(
    metric(
      "obligations_missed",
      "Obligations breached",
      "count",
      obligationsByStatus["breached"] ?? 0,
      { total: obligationRows.length, byStatus: obligationsByStatus },
    ),
  );

  /* --- Field volume ------------------------------------------------ */

  const rfiRows = await db
    .select({ status: rfis.status, respondedAt: rfis.respondedAt })
    .from(rfis)
    .where(and(eq(rfis.companyId, ctx.companyId), eq(rfis.projectId, ctx.projectId)));
  out.push(
    metric("rfi_count", "RFIs raised", "count", rfiRows.length, {
      responded: rfiRows.filter((r) => r.respondedAt != null).length,
      unanswered: rfiRows.filter((r) => r.respondedAt == null).length,
    }),
  );

  const punchRows = await db
    .select({ status: punchItems.status })
    .from(punchItems)
    .where(and(eq(punchItems.companyId, ctx.companyId), eq(punchItems.projectId, ctx.projectId)));
  const punchByStatus: Record<string, number> = {};
  for (const p of punchRows) punchByStatus[p.status] = (punchByStatus[p.status] ?? 0) + 1;
  out.push(
    metric("punch_count", "Punch items raised", "count", punchRows.length, {
      byStatus: punchByStatus,
    }),
  );

  /* --- Learning's own honesty check -------------------------------- */

  const lessonRows = await db
    .select({ status: lessons.status })
    .from(lessons)
    .where(
      and(eq(lessons.companyId, ctx.companyId), eq(lessons.originProjectId, ctx.projectId)),
    );
  const lessonsByStatus: Record<string, number> = {};
  for (const l of lessonRows) lessonsByStatus[l.status] = (lessonsByStatus[l.status] ?? 0) + 1;
  out.push(
    metric("lessons_captured", "Lessons captured on this project", "count", lessonRows.length, {
      byStatus: lessonsByStatus,
      published: lessonsByStatus["published"] ?? 0,
    }),
  );

  const triggerRows = await db
    .select({ status: lessonTriggers.status })
    .from(lessonTriggers)
    .where(
      and(
        eq(lessonTriggers.companyId, ctx.companyId),
        eq(lessonTriggers.projectId, ctx.projectId),
      ),
    );
  const raised = triggerRows.length;
  const captured = triggerRows.filter((t) => t.status === "captured").length;
  out.push(
    metric(
      "lesson_capture_rate_pct",
      "Mandatory triggers discharged by a lesson",
      "%",
      raised === 0 ? null : round2((captured / raised) * 100),
      {
        raised,
        captured,
        dismissed: triggerRows.filter((t) => t.status === "dismissed").length,
        open: triggerRows.filter((t) => t.status === "open").length,
      },
      raised === 0
        ? [
            "No mandatory-capture trigger has been raised on this project — run the trigger " +
              "sweep before reading a capture rate.",
          ]
        : [],
    ),
  );

  return {
    computedAt,
    projectId: ctx.projectId,
    currency,
    metrics: out,
    unavailable: out.filter((m) => m.value == null).map((m) => m.key),
    methodology:
      "Every figure is read from platform records at compute time: contracts and agreed " +
      "variations for budget, non-withdrawn payment certificates for outturn, the earliest " +
      "schedule baseline against recorded task actual finishes for programme, and the signal, " +
      "obligation, RFI, punch, lesson and trigger registers for the rest. Where an input is " +
      "absent the metric is null with the reason stated — it is never inferred.",
  };
}
