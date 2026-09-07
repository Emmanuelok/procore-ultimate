/**
 * Batched, convergence-tracked Monte Carlo (spec Vol II Domain H #464,
 * #475-476).
 *
 * WHY THIS EXISTS
 * `lib/montecarlo.ts` runs a whole simulation in one synchronous loop. On a
 * 2,000-task programme at 5,000 iterations that is seconds of blocked event
 * loop — every other tenant's request waits behind one person's "Run
 * simulation" click. These wrappers run the SAME arithmetic in batches,
 * awaiting a caller-supplied yield between them, and record the running
 * P50/P80 after each batch so the UI can answer "were there enough
 * iterations?" with evidence instead of a shrug.
 *
 * REPRODUCIBILITY
 * The batched form consumes the seeded RNG in exactly the order the library
 * engine does, so `runQcraBatched(risks, { iterations: N, seed, batchSize: N })`
 * is bit-for-bit `runQcra(risks, { iterations: N, seed })`. `simulation.test.ts`
 * asserts that equivalence at several batch sizes — it is the guard against
 * this file drifting from the engine it mirrors.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * It does not model correlation between risks (neither does the library
 * engine) and it does not change any distribution sampling. It is a
 * scheduler around the same mathematics.
 */
import {
  createRng,
  percentile,
  sampleDistribution,
  summarize,
  type QcraResult,
  type QcraRiskInput,
  type QsraResult,
  type QsraTaskInput,
  type SimulationSummary,
} from "../../lib/montecarlo.js";
import { computeCpm, type CpmDependencyInput, type CpmTaskInput } from "../../lib/cpm.js";

/* ------------------------------------------------------------------ */
/* Convergence                                                         */
/* ------------------------------------------------------------------ */

export interface ConvergencePoint {
  /** cumulative iterations completed at the end of this batch */
  iterations: number;
  p50: number;
  p80: number;
  /**
   * |P80 − previous P80| / |previous P80| × 100. null on the first batch
   * (nothing to compare with) and when the previous P80 was 0.
   */
  p80DeltaPercent: number | null;
}

/** P80 must move less than this (%) for the run to count as settled. */
export const CONVERGENCE_TOLERANCE_PERCENT = 0.5;
/** …across this many consecutive batches. */
export const CONVERGENCE_STABLE_BATCHES = 3;

/**
 * Has the P80 stopped moving? Returns false while there are too few batches
 * to tell — an unconverged verdict is the honest answer to a short run, not
 * a failure.
 */
export function isConverged(
  series: ConvergencePoint[],
  tolerancePercent = CONVERGENCE_TOLERANCE_PERCENT,
  stableBatches = CONVERGENCE_STABLE_BATCHES,
): boolean {
  if (series.length < stableBatches + 1) return false;
  const tail = series.slice(-stableBatches);
  return tail.every((p) => p.p80DeltaPercent !== null && p.p80DeltaPercent < tolerancePercent);
}

function pushConvergence(series: ConvergencePoint[], iterations: number, sorted: number[]): void {
  const p50 = percentile(sorted, 0.5);
  const p80 = percentile(sorted, 0.8);
  const prev = series[series.length - 1];
  const delta =
    prev === undefined || Math.abs(prev.p80) < 1e-12
      ? null
      : Math.round((Math.abs(p80 - prev.p80) / Math.abs(prev.p80)) * 100 * 10000) / 10000;
  series.push({ iterations, p50, p80, p80DeltaPercent: delta });
}

/* ------------------------------------------------------------------ */
/* Shared helpers mirrored from lib/montecarlo.ts                       */
/* ------------------------------------------------------------------ */

/** Pearson correlation — the library's own tornado metric, mirrored. */
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i += 1) {
    sa += a[i]!;
    sb += b[i]!;
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    dx += x * x;
    dy += y * y;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

export interface BatchOptions {
  iterations: number;
  seed: number;
  /** iterations per batch; the event loop is released between batches */
  batchSize?: number;
  /** called between batches — pass `() => new Promise(setImmediate)` in a server */
  onBatch?: (done: number, total: number, series: ConvergencePoint[]) => void | Promise<void>;
  /** aborts the run between batches when it returns true */
  shouldStop?: () => boolean;
}

export interface BatchedRun<T> {
  result: T;
  convergence: ConvergencePoint[];
  converged: boolean;
  iterationsRun: number;
  /** true when shouldStop() ended the run early */
  stopped: boolean;
}

export const DEFAULT_BATCH_SIZE = 500;

/* ------------------------------------------------------------------ */
/* QCRA                                                                 */
/* ------------------------------------------------------------------ */

/** The library engine's own iteration clamp, mirrored so prefixes match. */
function clampQcraIterations(n: number): number {
  return Math.max(100, Math.min(20000, Math.floor(n)));
}

function clampQsraIterations(n: number): number {
  return Math.max(50, Math.min(5000, Math.floor(n)));
}

export async function runQcraBatched(
  risks: QcraRiskInput[],
  options: BatchOptions,
): Promise<BatchedRun<QcraResult>> {
  const iterations = clampQcraIterations(options.iterations);
  const batchSize = Math.max(1, Math.min(iterations, options.batchSize ?? DEFAULT_BATCH_SIZE));
  const rng = createRng(options.seed);
  const totals: number[] = new Array(iterations);
  const perRiskSamples = new Map<string, number[]>(risks.map((r) => [r.id, new Array(iterations)]));
  const convergence: ConvergencePoint[] = [];
  let done = 0;
  let stopped = false;

  while (done < iterations) {
    const end = Math.min(iterations, done + batchSize);
    for (let i = done; i < end; i += 1) {
      let total = 0;
      for (const r of risks) {
        const occurs = rng() < r.probability;
        const v = occurs ? Math.max(0, sampleDistribution(r.impact, rng)) : 0;
        perRiskSamples.get(r.id)![i] = v;
        total += v;
      }
      totals[i] = total;
    }
    done = end;
    pushConvergence(convergence, done, totals.slice(0, done).sort((a, b) => a - b));
    if (options.onBatch) await options.onBatch(done, iterations, convergence);
    if (options.shouldStop?.()) {
      stopped = true;
      break;
    }
  }

  const used = done;
  const usedTotals = used === iterations ? totals : totals.slice(0, used);
  const summary = summarize(usedTotals);
  const perRisk = risks
    .map((r) => {
      const all = perRiskSamples.get(r.id)!;
      const samples = used === iterations ? all : all.slice(0, used);
      const ev = samples.reduce((s, v) => s + v, 0) / used;
      const occurred = samples.filter((v) => v > 0).length / used;
      return {
        id: r.id,
        name: r.name,
        expectedValue: ev,
        occurredShare: occurred,
        correlationWithTotal: Math.abs(pearson(samples, usedTotals)),
      };
    })
    .sort((a, b) => b.correlationWithTotal - a.correlationWithTotal);

  const result: QcraResult = {
    summary,
    perRisk,
    contingencyAt: {
      p50: summary.percentiles.p50,
      p80: summary.percentiles.p80,
      p90: summary.percentiles.p90,
    },
    correlationModelled: false,
  };
  return {
    result,
    convergence,
    converged: isConverged(convergence),
    iterationsRun: used,
    stopped,
  };
}

/* ------------------------------------------------------------------ */
/* QSRA                                                                 */
/* ------------------------------------------------------------------ */

export async function runQsraBatched(
  tasks: QsraTaskInput[],
  deps: CpmDependencyInput[],
  options: BatchOptions & { projectStart: string },
): Promise<BatchedRun<QsraResult>> {
  const iterations = clampQsraIterations(options.iterations);
  const batchSize = Math.max(1, Math.min(iterations, options.batchSize ?? DEFAULT_BATCH_SIZE));
  const rng = createRng(options.seed);
  const deterministic = computeCpm(tasks, deps, { projectStart: options.projectStart });
  const durations: number[] = new Array(iterations);
  const criticalCount = new Map<string, number>(tasks.map((t) => [t.id, 0]));
  const durationSamples = new Map<string, number[]>(
    tasks.filter((t) => t.durationDistribution).map((t) => [t.id, new Array(iterations)]),
  );
  const convergence: ConvergencePoint[] = [];
  let done = 0;
  let stopped = false;

  while (done < iterations) {
    const end = Math.min(iterations, done + batchSize);
    for (let i = done; i < end; i += 1) {
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
    done = end;
    pushConvergence(convergence, done, durations.slice(0, done).sort((a, b) => a - b));
    if (options.onBatch) await options.onBatch(done, iterations, convergence);
    if (options.shouldStop?.()) {
      stopped = true;
      break;
    }
  }

  const used = done;
  const usedDurations = used === iterations ? durations : durations.slice(0, used);
  const perTask = tasks.map((t) => {
    const all = durationSamples.get(t.id);
    const samples = all ? (used === iterations ? all : all.slice(0, used)) : null;
    return {
      id: t.id,
      criticalityIndex: (criticalCount.get(t.id) ?? 0) / used,
      sensitivity: samples ? Math.abs(pearson(samples, usedDurations)) : 0,
    };
  });
  perTask.sort((a, b) => b.sensitivity - a.sensitivity || b.criticalityIndex - a.criticalityIndex);

  const result: QsraResult = {
    summary: summarize(usedDurations),
    deterministicDurationDays: deterministic.projectDurationDays,
    perTask,
    correlationModelled: false,
  };
  return {
    result,
    convergence,
    converged: isConverged(convergence),
    iterationsRun: used,
    stopped,
  };
}

/* ------------------------------------------------------------------ */
/* Risk-adjusted joins (#475-476)                                       */
/* ------------------------------------------------------------------ */

export interface RiskAdjustedCost {
  /** deterministic estimate at completion the distribution sits on top of */
  baseEac: number | null;
  currency: string | null;
  p50: number | null;
  p80: number | null;
  p90: number | null;
  basis: string;
  /** why a number is missing, when it is */
  unavailableReason: string | null;
}

/**
 * Join a QCRA total-cost distribution to a deterministic budget EAC
 * (#475). The distribution is risk EXPOSURE, not total cost, so the
 * risk-adjusted figure is base + exposure at each confidence. With no base
 * EAC the exposure alone is returned and the reason is stated — never a 0.
 */
export function riskAdjustedCost(
  summary: SimulationSummary | null,
  base: { eac: number | null; currency: string | null },
): RiskAdjustedCost {
  if (!summary) {
    return {
      baseEac: base.eac,
      currency: base.currency,
      p50: null,
      p80: null,
      p90: null,
      basis: "",
      unavailableReason: "No cost simulation has been run on this project.",
    };
  }
  const p = summary.percentiles;
  if (base.eac === null) {
    return {
      baseEac: null,
      currency: base.currency,
      p50: null,
      p80: null,
      p90: null,
      basis: `Risk exposure at P50 ${p.p50}, P80 ${p.p80}, P90 ${p.p90}.`,
      unavailableReason:
        "No deterministic estimate at completion is available from the budget module, so a risk-adjusted total cannot be formed. The exposure figures are shown on their own.",
    };
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    baseEac: round2(base.eac),
    currency: base.currency,
    p50: round2(base.eac + p.p50),
    p80: round2(base.eac + p.p80),
    p90: round2(base.eac + p.p90),
    basis:
      `Deterministic EAC ${round2(base.eac)} plus modelled risk exposure at each confidence ` +
      `(P50 ${round2(p.p50)}, P80 ${round2(p.p80)}, P90 ${round2(p.p90)}). ` +
      `Correlation between risks is not modelled, so the spread is narrower than reality.`,
    unavailableReason: null,
  };
}
