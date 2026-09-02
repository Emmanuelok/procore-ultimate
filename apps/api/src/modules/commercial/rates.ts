/**
 * Rate build-up analysis and benchmarking (spec Vol II Domain B #145-149).
 *
 * Two questions, both answered from the record:
 *   1. Does this item's rate reconcile with its build-up, and what is it made
 *      of (labour / material / plant / overhead / profit split)?
 *   2. Is the rate consistent with comparable rates — the company's own
 *      history for the same unit and work, plus any recorded benchmark?
 *
 * Deliberately NOT a price database: the comparison set is whatever the tenant
 * already has (its own priced BQ items and its own benchmark rows). When there
 * is nothing to compare against, the verdict is `no_benchmark` with the reason
 * — never a fabricated "market rate".
 */
import type { RateVerdict } from "@constructos/shared";

export interface RateSampleInput {
  rate: number;
  source: string;
  label: string;
  currency: string;
}

export interface BuildUpComponentInput {
  kind: string;
  description: string;
  qty: number;
  rate: number;
  amount?: number;
}

export interface BuildUpAnalysis {
  total: number;
  reconciles: boolean;
  /** difference between the item rate and Σ build-up components */
  difference: number;
  split: Record<string, number>;
  splitPercent: Record<string, number>;
  /** observations about the composition, each a plain sentence */
  observations: string[];
}

export interface RateBenchmarkAnalysis {
  verdict: RateVerdict;
  rate: number | null;
  sampleSize: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
  min: number | null;
  max: number | null;
  /** (rate − median) / median × 100, null without a comparison set */
  deviationPercent: number | null;
  /** why the verdict is what it is, in words */
  basis: string;
  samples: RateSampleInput[];
}

const KNOWN_KINDS = ["labour", "material", "plant", "overhead", "profit"];

/** Round money to 2dp without accumulating float error. */
const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Decompose a rate build-up: totals, the split by kind, and observations a
 * commercial reviewer would make (no profit, no overhead, one component
 * carrying almost everything).
 */
export function analyseBuildUp(
  itemRate: number | null,
  components: BuildUpComponentInput[],
): BuildUpAnalysis {
  const split: Record<string, number> = {};
  let total = 0;
  for (const c of components) {
    const amount = c.amount ?? c.qty * c.rate;
    total += amount;
    const kind = KNOWN_KINDS.includes(c.kind) ? c.kind : "other";
    split[kind] = r2((split[kind] ?? 0) + amount);
  }
  total = r2(total);
  const splitPercent: Record<string, number> = {};
  for (const [kind, amount] of Object.entries(split)) {
    splitPercent[kind] = total === 0 ? 0 : Math.round((amount / total) * 1000) / 10;
  }

  const observations: string[] = [];
  if (components.length === 0) {
    observations.push("No build-up recorded — the rate has no audit trail.");
  } else {
    if (!("profit" in split)) {
      observations.push("No profit component: the rate recovers cost and overhead only.");
    }
    if (!("overhead" in split)) {
      observations.push("No overhead component: site and head-office recovery is not shown.");
    }
    const dominant = Object.entries(splitPercent).sort((a, b) => b[1] - a[1])[0];
    if (dominant && dominant[1] >= 85) {
      observations.push(
        `${dominant[0]} carries ${dominant[1]}% of the rate — check the build-up is complete.`,
      );
    }
    if ((splitPercent["profit"] ?? 0) > 25) {
      observations.push(
        `Profit is ${splitPercent["profit"]}% of the rate, well above a normal build-up.`,
      );
    }
  }

  const difference = itemRate == null ? 0 : r2(itemRate - total);
  return {
    total,
    reconciles: itemRate == null ? components.length === 0 : Math.abs(difference) <= 0.01,
    difference,
    split,
    splitPercent,
    observations,
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return r2(a + (b - a) * (idx - lo));
}

/**
 * Compare one rate against a comparison set. `high`/`low` are reported when
 * the rate sits outside the inter-quartile fence (Tukey, k = 1.5) AND more
 * than 20% from the median — two independent reasons, so a tight sample of
 * near-identical rates does not flag every ordinary variation.
 */
export function analyseRateAgainstBenchmarks(
  rate: number | null,
  samples: RateSampleInput[],
  options: { minSample?: number } = {},
): RateBenchmarkAnalysis {
  const minSample = options.minSample ?? 3;
  const values = samples.map((s) => s.rate).filter((v) => Number.isFinite(v) && v > 0);
  const sorted = [...values].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  const p25 = percentile(sorted, 0.25);
  const p75 = percentile(sorted, 0.75);
  const min = sorted[0] ?? null;
  const max = sorted[sorted.length - 1] ?? null;

  if (rate == null) {
    return {
      verdict: "no_benchmark",
      rate: null,
      sampleSize: sorted.length,
      median,
      p25,
      p75,
      min,
      max,
      deviationPercent: null,
      basis: "The item carries no rate, so there is nothing to compare.",
      samples,
    };
  }
  if (sorted.length < minSample || median == null || median === 0) {
    return {
      verdict: "no_benchmark",
      rate,
      sampleSize: sorted.length,
      median,
      p25,
      p75,
      min,
      max,
      deviationPercent: null,
      basis:
        sorted.length === 0
          ? "No comparable rates: no benchmark rows and no priced items with the same unit."
          : `Only ${sorted.length} comparable rate${sorted.length === 1 ? "" : "s"} found; ${minSample} are needed before a rate is called high or low.`,
      samples,
    };
  }

  const deviationPercent = Math.round(((rate - median) / median) * 1000) / 10;
  const iqr = (p75 ?? median) - (p25 ?? median);
  const upperFence = (p75 ?? median) + 1.5 * iqr;
  const lowerFence = (p25 ?? median) - 1.5 * iqr;
  let verdict: RateVerdict = "in_range";
  if (rate > upperFence && deviationPercent > 20) verdict = "high";
  else if (rate < lowerFence && deviationPercent < -20) verdict = "low";

  const basis =
    verdict === "in_range"
      ? `${rate} sits inside the comparison range (${p25} – ${p75}, median ${median}) over ${sorted.length} comparable rates.`
      : `${rate} is ${Math.abs(deviationPercent)}% ${verdict === "high" ? "above" : "below"} the median of ${median} and outside the inter-quartile fence (${r2(lowerFence)} – ${r2(upperFence)}) over ${sorted.length} comparable rates.`;

  return {
    verdict,
    rate,
    sampleSize: sorted.length,
    median,
    p25,
    p75,
    min,
    max,
    deviationPercent,
    basis,
    samples,
  };
}

/**
 * Normalise a BQ description into comparison keywords: lower-cased, stripped
 * of punctuation and stop words, the first four significant tokens. Two items
 * are comparable when they share a unit and at least two tokens.
 */
const STOP_WORDS = new Set([
  "the","and","of","in","to","for","with","on","at","by","as","or","a","an","not","exceeding","ne",
  "including","incl","excluding","per","mm","thick","wide","deep","high","over","under","from",
]);

export function descriptionTokens(description: string): string[] {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t) && !/^\d+$/.test(t))
    .slice(0, 8);
}

/** Overlap count between two token lists. */
export function tokenOverlap(a: string[], b: string[]): number {
  const set = new Set(a);
  let n = 0;
  for (const t of new Set(b)) if (set.has(t)) n += 1;
  return n;
}
