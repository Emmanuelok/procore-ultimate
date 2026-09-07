/**
 * FEEDBACK INTO THE LIBRARIES — rate, duration, estimate accuracy and risk
 * realisation statistics (spec #981–984).
 *
 * WHAT THIS IS
 * The half of the learning loop everybody draws on the slide and nobody
 * builds. A company estimates a job, builds it, measures what it actually
 * cost and how long it actually took — and then estimates the next job from
 * the same library of opinions it started with. This file turns finished work
 * into distributions: per element code, what the rate really was; per
 * activity, what the duration really was; and against each, what the estimate
 * had said, so the ORGANISATION'S OWN OPTIMISM BIAS becomes a number instead
 * of a suspicion.
 *
 * WHY IT IS PURE
 * Everything here is arithmetic over samples the caller supplies. No database,
 * no clock, no randomness: the same samples always give the same statistics in
 * the same order, which is the only way a library entry can be argued with
 * ("your p80 comes from four jobs, three of which were the same client").
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *  • It does not trim outliers. A rate three times the median is either a real
 *    event worth seeing or a data error worth fixing; silently dropping it
 *    makes the library look tighter than the evidence is. `min`, `max` and the
 *    coefficient of variation are published instead, and the samples travel
 *    with the entry.
 *  • It does not mix currencies, and it does not convert them. Two rates in
 *    different currencies are two libraries, not one — cross-currency
 *    aggregation is exactly the fabricated number this platform refuses.
 *  • It does not decide anything. Everything it emits is a PROPOSAL; a person
 *    with the authority accepts it, and until they do the library is unchanged.
 */

/* ------------------------------------------------------------------ */
/* Samples — the observations the statistics are computed from          */
/* ------------------------------------------------------------------ */

/** One measured element on one project: what was certified for what quantity. */
export interface RateSample {
  projectId: string;
  /** the valuation line / BQ item the observation came from */
  recordId: string;
  elementCode: string;
  description: string | null;
  unit: string | null;
  currency: string;
  /** measured quantity certified to date */
  quantity: number;
  /** amount certified to date for that quantity */
  amount: number;
  /** the rate the BQ was priced at, when one was recorded */
  estimatedRate: number | null;
  /** ISO date of the valuation the observation was taken from */
  observedAt: string | null;
}

/** One activity that started and finished: planned against actual. */
export interface DurationSample {
  projectId: string;
  taskId: string;
  activityCode: string;
  name: string;
  plannedDays: number;
  actualDays: number;
  actualStart: string | null;
  actualFinish: string | null;
}

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

export interface Distribution {
  n: number;
  median: number;
  p80: number;
  mean: number;
  min: number;
  max: number;
  /** standard deviation ÷ mean; how much the sample disagrees with itself */
  cv: number | null;
}

/**
 * Percentile by linear interpolation between order statistics (the "R-7"
 * definition, the one every spreadsheet uses). Named explicitly because
 * "p80" means at least four different things across the estimating
 * literature and a library entry that does not say which is not reproducible.
 */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (p <= 0) return sorted[0]!;
  if (p >= 1) return sorted[sorted.length - 1]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loV = sorted[lo]!;
  if (lo === hi) return loV;
  const hiV = sorted[hi]!;
  return loV + (hiV - loV) * (idx - lo);
}

export function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 0.5);
}

/** Null for an empty sample: a distribution of nothing is not zero. */
export function summarise(values: readonly number[]): Distribution | null {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  let cv: number | null = null;
  if (n > 1 && mean !== 0) {
    const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1);
    cv = Math.sqrt(variance) / Math.abs(mean);
  }
  return {
    n,
    median: percentile(sorted, 0.5)!,
    p80: percentile(sorted, 0.8)!,
    mean,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    cv,
  };
}

/**
 * Actual ÷ estimate − 1, as a fraction. Positive means the estimate was
 * optimistic. Null when there is no estimate to compare against, or when the
 * estimate is zero — dividing by it would manufacture an infinity and print
 * it as a bias.
 */
export function accuracyRatio(actual: number | null, estimate: number | null): number | null {
  if (actual === null || estimate === null) return null;
  if (!Number.isFinite(actual) || !Number.isFinite(estimate)) return null;
  if (estimate === 0) return null;
  return actual / estimate - 1;
}

/* ------------------------------------------------------------------ */
/* Proposals                                                           */
/* ------------------------------------------------------------------ */

/**
 * A sample smaller than this is published, but marked insufficient. Hiding it
 * would be worse: "we have three observations and they disagree" is useful,
 * and an empty library teaches nobody that the data was never collected.
 */
export const MIN_SUFFICIENT_SAMPLE = 4;

export interface RateProposal {
  key: string;
  elementCode: string;
  description: string | null;
  unit: string;
  currency: string;
  distribution: Distribution;
  /** median of the priced rates across the same sample */
  estimatedRate: number | null;
  accuracyRatio: number | null;
  sourceProjectIds: string[];
  samples: Array<{
    projectId: string;
    recordId: string;
    rate: number;
    quantity: number;
    amount: number;
    estimatedRate: number | null;
    observedAt: string | null;
  }>;
  sufficient: boolean;
  note: string;
}

export interface DurationProposal {
  key: string;
  activityCode: string;
  description: string | null;
  distribution: Distribution;
  plannedDays: number | null;
  accuracyRatio: number | null;
  sourceProjectIds: string[];
  samples: Array<{
    projectId: string;
    taskId: string;
    name: string;
    plannedDays: number;
    actualDays: number;
    actualStart: string | null;
    actualFinish: string | null;
  }>;
  sufficient: boolean;
  note: string;
}

/** Deterministic grouping key. Unit and currency are part of the identity. */
export function rateKey(elementCode: string, unit: string, currency: string): string {
  return `${elementCode.trim().toUpperCase()}|${unit.trim().toLowerCase()}|${currency.toUpperCase()}`;
}

function describeSpread(d: Distribution, unitLabel: string): string {
  const spread =
    d.cv === null
      ? "a single observation, so nothing is known about the spread"
      : `spread ${(d.cv * 100).toFixed(0)}% (coefficient of variation)`;
  return `${d.n} observation${d.n === 1 ? "" : "s"}, median ${round(d.median)} ${unitLabel}, p80 ${round(d.p80)}, range ${round(d.min)}–${round(d.max)}, ${spread}`;
}

function round(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

/**
 * Group measured elements into one proposal per (code, unit, currency).
 *
 * A sample is only usable when a positive quantity was certified for a finite
 * amount: a zero quantity gives an infinite rate, and a negative one is a
 * contra charge, which is a different animal from a rate.
 */
export function buildRateProposals(
  samples: readonly RateSample[],
  opts: { minSampleSize?: number } = {},
): RateProposal[] {
  const minSample = opts.minSampleSize ?? MIN_SUFFICIENT_SAMPLE;
  const groups = new Map<string, RateSample[]>();
  for (const s of samples) {
    if (!s.elementCode || !s.elementCode.trim()) continue;
    if (!Number.isFinite(s.quantity) || s.quantity <= 0) continue;
    if (!Number.isFinite(s.amount) || s.amount <= 0) continue;
    const key = rateKey(s.elementCode, s.unit ?? "unit", s.currency);
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  const out: RateProposal[] = [];
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const rates = group.map((s) => s.amount / s.quantity);
    const distribution = summarise(rates);
    if (!distribution) continue;
    const estimates = group
      .map((s) => s.estimatedRate)
      .filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
    const estimatedRate = estimates.length > 0 ? median(estimates) : null;
    const first = group[0]!;
    const projects = [...new Set(group.map((s) => s.projectId))].sort();
    const sufficient = distribution.n >= minSample && projects.length > 1;
    out.push({
      key,
      elementCode: first.elementCode.trim().toUpperCase(),
      description: first.description,
      unit: (first.unit ?? "unit").trim().toLowerCase(),
      currency: first.currency.toUpperCase(),
      distribution,
      estimatedRate,
      accuracyRatio: accuracyRatio(distribution.median, estimatedRate),
      sourceProjectIds: projects,
      samples: group
        .map((s) => ({
          projectId: s.projectId,
          recordId: s.recordId,
          rate: round(s.amount / s.quantity),
          quantity: s.quantity,
          amount: s.amount,
          estimatedRate: s.estimatedRate,
          observedAt: s.observedAt,
        }))
        .sort((a, b) => (a.recordId < b.recordId ? -1 : 1)),
      sufficient,
      note: sufficientNote(sufficient, distribution.n, projects.length, minSample, [
        describeSpread(distribution, `per ${(first.unit ?? "unit").trim().toLowerCase()}`),
        estimatedRate === null
          ? "no priced rate was recorded against these items, so estimate accuracy is not available"
          : `priced at ${round(estimatedRate)}, so the estimate was ${describeBias(accuracyRatio(distribution.median, estimatedRate))}`,
      ]),
    });
  }
  return out;
}

export function buildDurationProposals(
  samples: readonly DurationSample[],
  opts: { minSampleSize?: number } = {},
): DurationProposal[] {
  const minSample = opts.minSampleSize ?? MIN_SUFFICIENT_SAMPLE;
  const groups = new Map<string, DurationSample[]>();
  for (const s of samples) {
    if (!s.activityCode || !s.activityCode.trim()) continue;
    if (!Number.isFinite(s.actualDays) || s.actualDays <= 0) continue;
    const key = s.activityCode.trim().toUpperCase();
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  const out: DurationProposal[] = [];
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const distribution = summarise(group.map((s) => s.actualDays));
    if (!distribution) continue;
    const planned = group
      .map((s) => s.plannedDays)
      .filter((v) => Number.isFinite(v) && v > 0);
    const plannedDays = planned.length > 0 ? median(planned) : null;
    const projects = [...new Set(group.map((s) => s.projectId))].sort();
    const sufficient = distribution.n >= minSample && projects.length > 1;
    const first = group[0]!;
    out.push({
      key,
      activityCode: key,
      description: first.name,
      distribution,
      plannedDays,
      accuracyRatio: accuracyRatio(distribution.median, plannedDays),
      sourceProjectIds: projects,
      samples: group
        .map((s) => ({
          projectId: s.projectId,
          taskId: s.taskId,
          name: s.name,
          plannedDays: s.plannedDays,
          actualDays: s.actualDays,
          actualStart: s.actualStart,
          actualFinish: s.actualFinish,
        }))
        .sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
      sufficient,
      note: sufficientNote(sufficient, distribution.n, projects.length, minSample, [
        describeSpread(distribution, "days"),
        plannedDays === null
          ? "no planned duration was recorded, so optimism bias is not available"
          : `planned at ${round(plannedDays)} days, so the plan was ${describeBias(accuracyRatio(distribution.median, plannedDays))}`,
      ]),
    });
  }
  return out;
}

function describeBias(ratio: number | null): string {
  if (ratio === null) return "not comparable";
  if (Math.abs(ratio) < 0.02) return "within 2% of outturn";
  return ratio > 0
    ? `optimistic by ${(ratio * 100).toFixed(0)}%`
    : `pessimistic by ${(Math.abs(ratio) * 100).toFixed(0)}%`;
}

function sufficientNote(
  sufficient: boolean,
  n: number,
  projects: number,
  minSample: number,
  parts: string[],
): string {
  const head = sufficient
    ? "Usable sample"
    : n < minSample
      ? `Thin sample: ${n} observation${n === 1 ? "" : "s"} against a floor of ${minSample}. Published so the gap is visible, not because it is reliable`
      : `Single-project sample: all ${n} observations come from one project, so this measures that job rather than the company`;
  return [head, ...parts].join(". ") + ".";
}

/* ------------------------------------------------------------------ */
/* Comparing a proposal with what the library already holds            */
/* ------------------------------------------------------------------ */

export interface ExistingEntry {
  id: string;
  sampleSize: number;
  median: number | null;
  status: string;
}

export interface ProposalVerdict {
  action: "insert" | "supersede" | "skip";
  reasons: string[];
}

/**
 * Whether a freshly computed proposal is worth writing.
 *
 * Rewriting an identical entry every sweep would fill the register with noise
 * and reset every acceptance, so an entry only supersedes an accepted one when
 * the evidence actually moved: a materially different median (>2%) or a larger
 * sample. An existing PROPOSED entry is replaced outright — nobody has agreed
 * to it, so there is nothing to preserve.
 */
export function verdictFor(
  proposal: { distribution: Distribution },
  existing: ExistingEntry | null,
): ProposalVerdict {
  if (!existing) return { action: "insert", reasons: ["No entry exists for this key yet"] };
  if (existing.status === "proposed") {
    return {
      action: "supersede",
      reasons: ["The existing entry is an unaccepted proposal and is replaced by the newer sample"],
    };
  }
  if (existing.status === "rejected") {
    return {
      action: "skip",
      reasons: ["An entry for this key was rejected; re-proposing it would ignore that decision"],
    };
  }
  const reasons: string[] = [];
  const movedMedian =
    existing.median !== null &&
    existing.median !== 0 &&
    Math.abs(proposal.distribution.median / existing.median - 1) > 0.02;
  if (movedMedian) {
    reasons.push(
      `The median moved from ${round(existing.median!)} to ${round(proposal.distribution.median)}`,
    );
  }
  if (proposal.distribution.n > existing.sampleSize) {
    reasons.push(
      `The sample grew from ${existing.sampleSize} to ${proposal.distribution.n} observations`,
    );
  }
  if (reasons.length === 0) {
    return {
      action: "skip",
      reasons: [
        "The accepted entry already reflects this sample: same size, median within 2%",
      ],
    };
  }
  return { action: "supersede", reasons };
}

/* ------------------------------------------------------------------ */
/* Estimate accuracy, published as a company metric (#983)             */
/* ------------------------------------------------------------------ */

export interface AccuracyMetric {
  scope: "rates" | "durations";
  /** entries that had something to compare against */
  comparable: number;
  /** entries with no estimate recorded — counted, never assumed accurate */
  notComparable: number;
  medianBias: number | null;
  p80Bias: number | null;
  optimisticShare: number | null;
  reason: string;
}

export function accuracyMetric(
  scope: "rates" | "durations",
  ratios: ReadonlyArray<number | null>,
): AccuracyMetric {
  const usable = ratios.filter((r): r is number => r !== null && Number.isFinite(r));
  const notComparable = ratios.length - usable.length;
  if (usable.length === 0) {
    return {
      scope,
      comparable: 0,
      notComparable,
      medianBias: null,
      p80Bias: null,
      optimisticShare: null,
      reason:
        notComparable === 0
          ? "No library entries exist yet, so estimate accuracy has never been measured"
          : `None of the ${notComparable} entries carries a recorded estimate to compare outturn against`,
    };
  }
  const sorted = [...usable].sort((a, b) => a - b);
  const optimistic = usable.filter((r) => r > 0).length;
  return {
    scope,
    comparable: usable.length,
    notComparable,
    medianBias: percentile(sorted, 0.5),
    p80Bias: percentile(sorted, 0.8),
    optimisticShare: optimistic / usable.length,
    reason: `Measured across ${usable.length} librar${usable.length === 1 ? "y entry" : "y entries"} with a recorded estimate; ${notComparable} entr${notComparable === 1 ? "y has" : "ies have"} none.`,
  };
}

/* ------------------------------------------------------------------ */
/* Risk realisation (#984)                                             */
/* ------------------------------------------------------------------ */

export interface RealisationSample {
  category: string | null;
  predictedProbability: number | null;
  realisedImpact: number | null;
  realisedCurrency: string | null;
  predictedImpact: number | null;
  predictedCurrency: string | null;
}

export interface RealisationStat {
  category: string;
  realised: number;
  /** mean predicted probability of the ones that actually happened */
  meanPredictedProbability: number | null;
  /** impact statistics, bucketed by currency — never summed across them */
  impactByCurrency: Array<{
    currency: string;
    n: number;
    medianRealised: number;
    medianPredicted: number | null;
    bias: number | null;
  }>;
  reason: string;
}

/**
 * What the register said about the risks that came true.
 *
 * A low mean predicted probability across realised risks is the measurable
 * form of "we score everything green": if the things that happened were all
 * scored unlikely, the scoring is not calibrated. Impacts are bucketed by
 * currency because adding pounds to naira produces a number that means
 * nothing.
 */
export function realisationStats(samples: readonly RealisationSample[]): RealisationStat[] {
  const byCategory = new Map<string, RealisationSample[]>();
  for (const s of samples) {
    const cat = (s.category ?? "uncategorised").trim() || "uncategorised";
    const list = byCategory.get(cat);
    if (list) list.push(s);
    else byCategory.set(cat, [s]);
  }
  const out: RealisationStat[] = [];
  for (const [category, group] of [...byCategory.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const probs = group
      .map((s) => s.predictedProbability)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const currencies = new Map<string, RealisationSample[]>();
    for (const s of group) {
      if (s.realisedImpact === null || !Number.isFinite(s.realisedImpact)) continue;
      const cur = (s.realisedCurrency ?? "unknown").toUpperCase();
      const list = currencies.get(cur);
      if (list) list.push(s);
      else currencies.set(cur, [s]);
    }
    const impactByCurrency = [...currencies.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([currency, rows]) => {
        const realised = rows.map((r) => r.realisedImpact!);
        const predicted = rows
          .filter((r) => (r.predictedCurrency ?? "unknown").toUpperCase() === currency)
          .map((r) => r.predictedImpact)
          .filter((v): v is number => v !== null && Number.isFinite(v));
        const medianRealised = median(realised)!;
        const medianPredicted = predicted.length > 0 ? median(predicted) : null;
        return {
          currency,
          n: rows.length,
          medianRealised,
          medianPredicted,
          bias: accuracyRatio(medianRealised, medianPredicted),
        };
      });
    out.push({
      category,
      realised: group.length,
      meanPredictedProbability:
        probs.length > 0 ? probs.reduce((a, b) => a + b, 0) / probs.length : null,
      impactByCurrency,
      reason:
        probs.length === 0
          ? `${group.length} risk${group.length === 1 ? "" : "s"} in this category were realised; none carried a scored probability, so calibration cannot be measured`
          : `${group.length} realised; the ${probs.length} that carried a score averaged ${(probs.reduce((a, b) => a + b, 0) / probs.length).toFixed(2)} predicted probability`,
    });
  }
  return out;
}

/**
 * The central value of a risk's cost-impact distribution (lib/montecarlo.ts
 * shapes), for comparison against what the risk actually cost.
 *
 * A distribution has no single "the number", so this returns the one the
 * register's authors were thinking of when they typed it: the mode for the
 * triangular and PERT shapes people actually use, the mean for a normal, the
 * midpoint for a uniform, and the weighted mean for a discrete set. Anything
 * else — including a shape this function does not recognise — returns null
 * rather than a guess.
 */
export function centralImpact(dist: unknown): number | null {
  if (!dist || typeof dist !== "object") return null;
  const d = dist as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  switch (d["kind"]) {
    case "triangular":
    case "pert":
      return num(d["mode"]);
    case "normal":
      return num(d["mean"]);
    case "uniform": {
      const min = num(d["min"]);
      const max = num(d["max"]);
      return min === null || max === null ? null : (min + max) / 2;
    }
    case "discrete": {
      const values = Array.isArray(d["values"]) ? d["values"] : null;
      if (!values || values.length === 0) return null;
      let weight = 0;
      let total = 0;
      for (const raw of values) {
        if (!raw || typeof raw !== "object") continue;
        const v = num((raw as Record<string, unknown>)["value"]);
        const w = num((raw as Record<string, unknown>)["weight"]);
        if (v === null || w === null || w <= 0) continue;
        weight += w;
        total += v * w;
      }
      return weight === 0 ? null : total / weight;
    }
    default:
      return null;
  }
}

/**
 * Calendar days from start to finish, inclusive of both — the way a
 * programme reads a bar, and the only definition that makes a one-day
 * activity one day long. Null when either end is missing or unparseable:
 * an activity with no recorded dates did not take zero days.
 */
export function inclusiveDays(start: string | null, finish: string | null): number | null {
  if (!start || !finish) return null;
  const a = Date.parse(start);
  const b = Date.parse(finish);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (b < a) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}
