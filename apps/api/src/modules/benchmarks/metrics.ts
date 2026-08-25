import { and, eq, isNotNull } from "drizzle-orm";
import {
  contracts,
  paymentClaims,
  projects,
  punchItems,
  rfis,
  scheduleBaselines,
  schedules,
  variations,
} from "@constructos/db";
import type { Db } from "../../lib/db.js";

/* ------------------------------------------------------------------ */
/* Numeric helpers                                                     */
/* ------------------------------------------------------------------ */

export const round2 = (n: number): number => Math.round(n * 100) / 100;

const MS_PER_DAY = 86_400_000;

/** Whole+fractional days between two ISO date / timestamp strings. */
export function daysBetween(startISO: string, endISO: string): number {
  return (Date.parse(endISO) - Date.parse(startISO)) / MS_PER_DAY;
}

/**
 * Percentile by linear interpolation over the sorted sample (the "n-1"
 * method). `p` in [0, 100]. The caller sorts once and reuses.
 */
export function percentileOf(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (idx - lo) * (sorted[hi]! - sorted[lo]!);
}

export function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return percentileOf(sorted, 50);
}

/**
 * Percentile RANK of `value` within the sample: the share of samples at or
 * below it, with ties counted half (so a value equal to the median ranks
 * ~50, not 100). Returned in [0, 100].
 */
export function percentileRank(values: readonly number[], value: number): number {
  if (values.length === 0) return Number.NaN;
  let below = 0;
  let equal = 0;
  for (const v of values) {
    if (v < value) below += 1;
    else if (v === value) equal += 1;
  }
  return round2(((below + equal / 2) / values.length) * 100);
}

export interface HistogramBin {
  lo: number;
  hi: number;
  count: number;
}

/**
 * Fixed 10-bin equal-width histogram over [min, max]. A degenerate sample
 * (all values identical) collapses to a single bin rather than ten
 * zero-width ones.
 */
export function histogramOf(values: readonly number[]): HistogramBin[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (values.length === 0) return [];
  if (min === max) return [{ lo: round2(min), hi: round2(max), count: values.length }];
  const bins = 10;
  const width = (max - min) / bins;
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    const i = Math.min(bins - 1, Math.floor((v - min) / width));
    counts[i]! += 1;
  }
  return counts.map((count, i) => ({
    lo: round2(min + i * width),
    hi: round2(i === bins - 1 ? max : min + (i + 1) * width),
    count,
  }));
}

export interface DistributionStats {
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  max: number;
  histogram: HistogramBin[];
}

export function computeStats(values: readonly number[]): DistributionStats {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: round2(sorted[0]!),
    p25: round2(percentileOf(sorted, 25)),
    median: round2(percentileOf(sorted, 50)),
    p75: round2(percentileOf(sorted, 75)),
    p90: round2(percentileOf(sorted, 90)),
    max: round2(sorted[sorted.length - 1]!),
    histogram: histogramOf(sorted),
  };
}

/* ------------------------------------------------------------------ */
/* Registry contract                                                   */
/* ------------------------------------------------------------------ */

/**
 * Any distribution cell (metric × assetClass × region) with fewer than this
 * many CONTRIBUTED samples is suppressed — aggregates over a handful of
 * contributors would let one contributor infer another's number. The sample
 * size itself is always disclosed (#831).
 */
export const MIN_SAMPLE_N = 5;

export interface MetricComputation {
  /** null when the platform does not hold the inputs — never a fabricated 0 */
  value: number | null;
  unit: string;
  /** the exact figures the computation read, persisted for auditability */
  inputs: Record<string, unknown>;
  /** why value is null; empty when a value was computed */
  reasons: string[];
}

export interface MetricContext {
  companyId: string;
  projectId: string;
}

export interface BenchmarkMetricDef {
  key: string;
  name: string;
  unit: string;
  /** direction of merit — drives which tail of the distribution is adverse */
  higherIsBetter: boolean;
  description: string;
  /** which platform records the computation reads, in prose */
  inputs: string;
  compute: (db: Db, ctx: MetricContext) => Promise<MetricComputation>;
}

/* ------------------------------------------------------------------ */
/* Shared input readers                                                */
/* ------------------------------------------------------------------ */

/**
 * Cost basis shared by the cost metrics. "Original" is the sum of contract
 * sums across the project's executed/completed contracts (a draft contract
 * is a proposal, not a budget); "approved variations" are `agreed`
 * variations valued at agreedValue, falling back to costEstimate when a
 * variation was agreed without a settled figure.
 */
async function readCostBasis(db: Db, ctx: MetricContext) {
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
  const originalContractSum = counted.reduce((s, c) => s + (c.contractSum ?? 0), 0);

  const variationRows = await db
    .select({
      status: variations.status,
      agreedValue: variations.agreedValue,
      costEstimate: variations.costEstimate,
    })
    .from(variations)
    .where(and(eq(variations.companyId, ctx.companyId), eq(variations.projectId, ctx.projectId)));
  const agreed = variationRows.filter((v) => v.status === "agreed");
  const approvedVariationsValue = agreed.reduce(
    (s, v) => s + (v.agreedValue ?? v.costEstimate ?? 0),
    0,
  );

  return {
    originalContractSum,
    approvedVariationsValue,
    currentApprovedBudget: originalContractSum + approvedVariationsValue,
    contractsCounted: counted.length,
    variationsCounted: agreed.length,
    currency: counted[0]?.currency ?? null,
  };
}

/** Active schedule + its earliest baseline — the as-planned reference. */
async function readScheduleBasis(db: Db, ctx: MetricContext) {
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
  if (!schedule) return { schedule: null, baseline: null };
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
  return { schedule, baseline: baselineRows[0] ?? null };
}

/* ------------------------------------------------------------------ */
/* The metrics                                                         */
/* ------------------------------------------------------------------ */

const costPerGfaM2: BenchmarkMetricDef = {
  key: "cost_per_gfa_m2",
  name: "Cost per gross floor area",
  unit: "currency/m2",
  higherIsBetter: false,
  description:
    "Current approved budget (original contract sum plus agreed variations) divided by the " +
    "project's declared gross floor area in square metres.",
  inputs:
    "contracts.contractSum (executed/completed), agreed variations (agreedValue, falling back " +
    "to costEstimate), projects.settings.gfaM2",
  async compute(db, ctx) {
    const reasons: string[] = [];
    const basis = await readCostBasis(db, ctx);
    const projectRows = await db
      .select({ settings: projects.settings })
      .from(projects)
      .where(and(eq(projects.id, ctx.projectId), eq(projects.companyId, ctx.companyId)))
      .limit(1);
    const raw = projectRows[0]?.settings?.["gfaM2"];
    const gfaM2 = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : null;
    if (basis.contractsCounted === 0) {
      reasons.push("No executed or completed contract with a contract sum on this project.");
    }
    if (gfaM2 == null || !Number.isFinite(gfaM2) || gfaM2 <= 0) {
      reasons.push(
        "Project settings.gfaM2 is not set — declare the gross floor area (m²) in project settings.",
      );
    }
    const inputs = { ...basis, gfaM2: gfaM2 ?? null };
    if (reasons.length > 0) return { value: null, unit: this.unit, inputs, reasons };
    return {
      value: round2(basis.currentApprovedBudget / gfaM2!),
      unit: this.unit,
      inputs,
      reasons,
    };
  },
};

const costGrowthPct: BenchmarkMetricDef = {
  key: "cost_growth_pct",
  name: "Cost growth",
  unit: "%",
  higherIsBetter: false,
  description:
    "Growth of the current approved budget (original contract sum plus agreed variations) over " +
    "the original contract sum, as a percentage.",
  inputs:
    "contracts.contractSum (executed/completed) as the original approved budget; agreed " +
    "variations (agreedValue, falling back to costEstimate) as the approved growth",
  async compute(db, ctx) {
    const basis = await readCostBasis(db, ctx);
    const inputs = { ...basis };
    if (basis.contractsCounted === 0 || basis.originalContractSum <= 0) {
      return {
        value: null,
        unit: this.unit,
        inputs,
        reasons: ["No executed or completed contract with a contract sum on this project."],
      };
    }
    return {
      value: round2(
        ((basis.currentApprovedBudget - basis.originalContractSum) / basis.originalContractSum) *
          100,
      ),
      unit: this.unit,
      inputs,
      reasons: [],
    };
  },
};

const scheduleGrowthPct: BenchmarkMetricDef = {
  key: "schedule_growth_pct",
  name: "Schedule growth",
  unit: "%",
  higherIsBetter: false,
  description:
    "Growth of the active schedule's CPM-computed duration over the earliest captured baseline's " +
    "duration, as a percentage.",
  inputs:
    "schedules (isActive, projectStart, computedFinish) and the earliest scheduleBaselines " +
    "snapshot (projectStart, computedFinish)",
  async compute(db, ctx) {
    const reasons: string[] = [];
    const { schedule, baseline } = await readScheduleBasis(db, ctx);
    if (!schedule) {
      return {
        value: null,
        unit: this.unit,
        inputs: {},
        reasons: ["No active schedule on this project."],
      };
    }
    if (!schedule.computedFinish) {
      reasons.push("Active schedule has no computed finish — run the CPM engine first.");
    }
    if (!baseline) {
      reasons.push("No schedule baseline captured — capture an as-planned baseline first.");
    } else if (!baseline.computedFinish) {
      reasons.push("Earliest baseline has no computed finish.");
    }
    const inputs: Record<string, unknown> = {
      scheduleId: schedule.id,
      projectStart: schedule.projectStart,
      computedFinish: schedule.computedFinish,
      baselineId: baseline?.id ?? null,
      baselineProjectStart: baseline?.projectStart ?? null,
      baselineComputedFinish: baseline?.computedFinish ?? null,
    };
    if (reasons.length > 0) return { value: null, unit: this.unit, inputs, reasons };
    const baselineDays = daysBetween(baseline!.projectStart, baseline!.computedFinish!);
    const currentDays = daysBetween(schedule.projectStart, schedule.computedFinish!);
    inputs["baselineDurationDays"] = round2(baselineDays);
    inputs["currentDurationDays"] = round2(currentDays);
    if (baselineDays <= 0) {
      return {
        value: null,
        unit: this.unit,
        inputs,
        reasons: ["Baseline duration is zero or negative — the baseline snapshot is unusable."],
      };
    }
    return {
      value: round2(((currentDays - baselineDays) / baselineDays) * 100),
      unit: this.unit,
      inputs,
      reasons: [],
    };
  },
};

const rfiResponseDaysMedian: BenchmarkMetricDef = {
  key: "rfi_response_days_median",
  name: "RFI response time (median)",
  unit: "days",
  higherIsBetter: false,
  description: "Median days from RFI creation to the official response, over answered RFIs.",
  inputs: "rfis.createdAt and rfis.respondedAt for RFIs with an official response",
  async compute(db, ctx) {
    const rows = await db
      .select({ createdAt: rfis.createdAt, respondedAt: rfis.respondedAt })
      .from(rfis)
      .where(
        and(
          eq(rfis.companyId, ctx.companyId),
          eq(rfis.projectId, ctx.projectId),
          isNotNull(rfis.respondedAt),
        ),
      );
    const durations = rows
      .map((r) => daysBetween(r.createdAt, r.respondedAt!))
      .filter((d) => Number.isFinite(d) && d >= 0);
    const inputs = { respondedRfis: durations.length };
    if (durations.length === 0) {
      return {
        value: null,
        unit: this.unit,
        inputs,
        reasons: ["No RFIs with an official response on this project."],
      };
    }
    return { value: round2(medianOf(durations)), unit: this.unit, inputs, reasons: [] };
  },
};

const variationRatePct: BenchmarkMetricDef = {
  key: "variation_rate_pct",
  name: "Variation rate",
  unit: "%",
  higherIsBetter: false,
  description:
    "Value of agreed variations as a percentage of the original contract sum. Zero variations " +
    "on a project with a contract sum is a genuine 0, not missing data.",
  inputs:
    "agreed variations (agreedValue, falling back to costEstimate) over contracts.contractSum " +
    "(executed/completed)",
  async compute(db, ctx) {
    const basis = await readCostBasis(db, ctx);
    const inputs = { ...basis };
    if (basis.contractsCounted === 0 || basis.originalContractSum <= 0) {
      return {
        value: null,
        unit: this.unit,
        inputs,
        reasons: ["No executed or completed contract with a contract sum on this project."],
      };
    }
    return {
      value: round2((basis.approvedVariationsValue / basis.originalContractSum) * 100),
      unit: this.unit,
      inputs,
      reasons: [],
    };
  },
};

const punchOpenRate: BenchmarkMetricDef = {
  key: "punch_open_rate",
  name: "Punch open rate",
  unit: "%",
  higherIsBetter: false,
  description:
    "Share of punch items still unresolved (open, in progress, or awaiting review) among all " +
    "non-void punch items.",
  inputs: "punchItems.status — open/in_progress/ready_for_review over all non-void items",
  async compute(db, ctx) {
    const rows = await db
      .select({ status: punchItems.status })
      .from(punchItems)
      .where(and(eq(punchItems.companyId, ctx.companyId), eq(punchItems.projectId, ctx.projectId)));
    const counted = rows.filter((r) => r.status !== "void");
    const open = counted.filter(
      (r) => r.status === "open" || r.status === "in_progress" || r.status === "ready_for_review",
    );
    const inputs = { totalItems: counted.length, openItems: open.length, voidItems: rows.length - counted.length };
    if (counted.length === 0) {
      return {
        value: null,
        unit: this.unit,
        inputs,
        reasons: ["No punch items recorded on this project."],
      };
    }
    return {
      value: round2((open.length / counted.length) * 100),
      unit: this.unit,
      inputs,
      reasons: [],
    };
  },
};

const paymentCycleDaysMedian: BenchmarkMetricDef = {
  key: "payment_cycle_days_median",
  name: "Payment cycle time (median)",
  unit: "days",
  higherIsBetter: false,
  description: "Median days from a payment claim being served to it being paid, over paid claims.",
  inputs: "paymentClaims.servedAt and paymentClaims.paidAt for claims that reached payment",
  async compute(db, ctx) {
    const rows = await db
      .select({ servedAt: paymentClaims.servedAt, paidAt: paymentClaims.paidAt })
      .from(paymentClaims)
      .where(
        and(
          eq(paymentClaims.companyId, ctx.companyId),
          eq(paymentClaims.projectId, ctx.projectId),
          isNotNull(paymentClaims.servedAt),
          isNotNull(paymentClaims.paidAt),
        ),
      );
    const durations = rows
      .map((r) => daysBetween(r.servedAt!, r.paidAt!))
      .filter((d) => Number.isFinite(d) && d >= 0);
    const inputs = { paidClaims: durations.length };
    if (durations.length === 0) {
      return {
        value: null,
        unit: this.unit,
        inputs,
        reasons: ["No payment claims with both a served date and a paid date on this project."],
      };
    }
    return { value: round2(medianOf(durations)), unit: this.unit, inputs, reasons: [] };
  },
};

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export const BENCHMARK_METRICS: readonly BenchmarkMetricDef[] = [
  costPerGfaM2,
  costGrowthPct,
  scheduleGrowthPct,
  rfiResponseDaysMedian,
  variationRatePct,
  punchOpenRate,
  paymentCycleDaysMedian,
];

const byKey = new Map(BENCHMARK_METRICS.map((m) => [m.key, m]));

export function metricByKey(key: string): BenchmarkMetricDef | undefined {
  return byKey.get(key);
}

export const BENCHMARK_METRIC_KEYS: readonly string[] = BENCHMARK_METRICS.map((m) => m.key);
