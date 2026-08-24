/**
 * Monte Carlo engine for quantitative risk analysis (pure, seeded,
 * deterministic — spec Vol II Domain H / module M13).
 *
 * - All randomness flows from a caller-supplied seed (mulberry32 PRNG), so
 *   simulation results are reproducible: same inputs + seed → same numbers.
 *   That reproducibility is what makes a P80 defensible in front of a gate
 *   review or an auditor.
 * - Distributions: triangular, PERT (beta via Marsaglia–Tsang gamma),
 *   uniform, normal (Box–Muller), lognormal, discrete.
 * - QCRA: risks as (probability, impact distribution) pairs → total-cost
 *   distribution, percentiles, per-risk expected contribution and a tornado
 *   ranking by correlation with the total.
 * - QSRA: per-task duration distributions → CPM per iteration (lib/cpm.ts)
 *   → completion distribution, per-task criticality index and sensitivity.
 * - Correlation between risks is NOT modelled (documented limitation; an
 *   Iman–Conover rank correlation stage is the roadmap item). Results are
 *   therefore narrower than reality when risks are positively correlated —
 *   flagged in the result object so UIs can say so.
 */

import { computeCpm, type CpmDependencyInput, type CpmTaskInput } from "./cpm.js";

/* ------------------------------ PRNG ------------------------------- */

/** mulberry32 — small, fast, good-enough statistical quality, seedable. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* --------------------------- Distributions ------------------------- */

export type Distribution =
  | { kind: "triangular"; min: number; mode: number; max: number }
  | { kind: "pert"; min: number; mode: number; max: number }
  | { kind: "uniform"; min: number; max: number }
  | { kind: "normal"; mean: number; stdDev: number }
  | { kind: "lognormal"; logMean: number; logStdDev: number }
  | { kind: "discrete"; values: { value: number; weight: number }[] };

function sampleNormal(rng: () => number): number {
  // Box–Muller; guard against log(0)
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Marsaglia–Tsang gamma sampler (shape ≥ 0), scale 1. */
function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    const u = Math.max(rng(), 1e-12);
    return sampleGamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(Math.max(u, 1e-12)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleBeta(alpha: number, beta: number, rng: () => number): number {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  return x / (x + y);
}

export function sampleDistribution(d: Distribution, rng: () => number): number {
  switch (d.kind) {
    case "uniform":
      return d.min + (d.max - d.min) * rng();
    case "triangular": {
      const { min, mode, max } = d;
      if (max <= min) return min;
      const u = rng();
      const fc = (mode - min) / (max - min);
      return u < fc
        ? min + Math.sqrt(u * (max - min) * (mode - min))
        : max - Math.sqrt((1 - u) * (max - min) * (max - mode));
    }
    case "pert": {
      const { min, mode, max } = d;
      if (max <= min) return min;
      // classic PERT: alpha/beta from mode with lambda = 4
      const alpha = 1 + (4 * (mode - min)) / (max - min);
      const beta = 1 + (4 * (max - mode)) / (max - min);
      return min + sampleBeta(alpha, beta, rng) * (max - min);
    }
    case "normal":
      return d.mean + d.stdDev * sampleNormal(rng);
    case "lognormal":
      return Math.exp(d.logMean + d.logStdDev * sampleNormal(rng));
    case "discrete": {
      const total = d.values.reduce((s, v) => s + v.weight, 0);
      let r = rng() * total;
      for (const v of d.values) {
        r -= v.weight;
        if (r <= 0) return v.value;
      }
      return d.values[d.values.length - 1]?.value ?? 0;
    }
  }
}

/* ----------------------------- Summary ----------------------------- */

export interface SimulationSummary {
  iterations: number;
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  percentiles: { p10: number; p50: number; p80: number; p90: number; p95: number };
  /** equal-width histogram for charting */
  histogram: { from: number; to: number; count: number }[];
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const w = idx - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

export function summarize(samples: number[], bins = 30): SimulationSummary {
  const n = samples.length;
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / Math.max(1, n);
  const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, n - 1);
  const min = sorted[0] ?? 0;
  const max = sorted[n - 1] ?? 0;
  const width = (max - min) / bins || 1;
  const histogram = Array.from({ length: bins }, (_, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width,
    count: 0,
  }));
  for (const v of samples) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor((v - min) / width)));
    histogram[b]!.count += 1;
  }
  return {
    iterations: n,
    mean,
    stdDev: Math.sqrt(variance),
    min,
    max,
    percentiles: {
      p10: percentile(sorted, 0.1),
      p50: percentile(sorted, 0.5),
      p80: percentile(sorted, 0.8),
      p90: percentile(sorted, 0.9),
      p95: percentile(sorted, 0.95),
    },
    histogram,
  };
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

/* ------------------------------- QCRA ------------------------------ */

export interface QcraRiskInput {
  id: string;
  name: string;
  /** probability the risk occurs at all, 0..1 */
  probability: number;
  impact: Distribution;
}

export interface QcraResult {
  summary: SimulationSummary;
  perRisk: {
    id: string;
    name: string;
    expectedValue: number;
    occurredShare: number;
    /** tornado driver strength: |corr(risk sample, total)| */
    correlationWithTotal: number;
  }[];
  /** contingency needed at each confidence over the deterministic base of 0 */
  contingencyAt: { p50: number; p80: number; p90: number };
  correlationModelled: false;
}

export function runQcra(
  risks: QcraRiskInput[],
  options: { iterations: number; seed: number },
): QcraResult {
  const iterations = Math.max(100, Math.min(20000, Math.floor(options.iterations)));
  const rng = createRng(options.seed);
  const totals: number[] = new Array(iterations);
  const perRiskSamples = new Map<string, number[]>(risks.map((r) => [r.id, new Array(iterations)]));
  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (const r of risks) {
      const occurs = rng() < r.probability;
      const v = occurs ? Math.max(0, sampleDistribution(r.impact, rng)) : 0;
      perRiskSamples.get(r.id)![i] = v;
      total += v;
    }
    totals[i] = total;
  }
  const summary = summarize(totals);
  const perRisk = risks
    .map((r) => {
      const samples = perRiskSamples.get(r.id)!;
      const ev = samples.reduce((s, v) => s + v, 0) / iterations;
      const occurred = samples.filter((v) => v > 0).length / iterations;
      return {
        id: r.id,
        name: r.name,
        expectedValue: ev,
        occurredShare: occurred,
        correlationWithTotal: Math.abs(pearson(samples, totals)),
      };
    })
    .sort((a, b) => b.correlationWithTotal - a.correlationWithTotal);
  return {
    summary,
    perRisk,
    contingencyAt: {
      p50: summary.percentiles.p50,
      p80: summary.percentiles.p80,
      p90: summary.percentiles.p90,
    },
    correlationModelled: false,
  };
}

/* ------------------------------- QSRA ------------------------------ */

export interface QsraTaskInput extends CpmTaskInput {
  /** duration uncertainty; when absent the task duration is deterministic */
  durationDistribution?: Distribution;
}

export interface QsraResult {
  /** distribution of project duration in days */
  summary: SimulationSummary;
  deterministicDurationDays: number;
  perTask: {
    id: string;
    /** share of iterations in which the task was critical */
    criticalityIndex: number;
    /** |corr(task duration, project duration)| — duration sensitivity */
    sensitivity: number;
  }[];
  correlationModelled: false;
}

export function runQsra(
  tasks: QsraTaskInput[],
  deps: CpmDependencyInput[],
  options: { projectStart: string; iterations: number; seed: number },
): QsraResult {
  const iterations = Math.max(50, Math.min(5000, Math.floor(options.iterations)));
  const rng = createRng(options.seed);
  const deterministic = computeCpm(tasks, deps, { projectStart: options.projectStart });
  const durations: number[] = new Array(iterations);
  const criticalCount = new Map<string, number>(tasks.map((t) => [t.id, 0]));
  const durationSamples = new Map<string, number[]>(
    tasks.filter((t) => t.durationDistribution).map((t) => [t.id, new Array(iterations)]),
  );
  for (let i = 0; i < iterations; i++) {
    const sampled: CpmTaskInput[] = tasks.map((t) => {
      if (!t.durationDistribution) return t;
      const d = Math.max(0, Math.round(sampleDistribution(t.durationDistribution, rng)));
      durationSamples.get(t.id)![i] = d;
      return { ...t, duration: d };
    });
    const r = computeCpm(sampled, deps, { projectStart: options.projectStart });
    durations[i] = r.projectDurationDays;
    for (const id of r.criticalIds) {
      criticalCount.set(id, (criticalCount.get(id) ?? 0) + 1);
    }
  }
  const perTask = tasks.map((t) => ({
    id: t.id,
    criticalityIndex: (criticalCount.get(t.id) ?? 0) / iterations,
    sensitivity: durationSamples.has(t.id)
      ? Math.abs(pearson(durationSamples.get(t.id)!, durations))
      : 0,
  }));
  perTask.sort((a, b) => b.sensitivity - a.sensitivity || b.criticalityIndex - a.criticalityIndex);
  return {
    summary: summarize(durations),
    deterministicDurationDays: deterministic.projectDurationDays,
    perTask,
    correlationModelled: false,
  };
}
