import { describe, expect, it } from "vitest";
import { runQcra, runQsra, type QcraRiskInput, type QsraTaskInput } from "../../lib/montecarlo.js";
import type { CpmDependencyInput } from "../../lib/cpm.js";
import {
  CONVERGENCE_STABLE_BATCHES,
  DEFAULT_BATCH_SIZE,
  isConverged,
  riskAdjustedCost,
  runQcraBatched,
  runQsraBatched,
  type ConvergencePoint,
} from "./simulation.js";
import { executeSimulation } from "./runner.js";

const RISKS: QcraRiskInput[] = [
  { id: "r1", name: "Ground conditions", probability: 0.4, impact: { kind: "pert", min: 50_000, mode: 120_000, max: 400_000 } },
  { id: "r2", name: "Late information", probability: 0.6, impact: { kind: "triangular", min: 10_000, mode: 30_000, max: 90_000 } },
  { id: "r3", name: "Price inflation", probability: 0.8, impact: { kind: "uniform", min: 5_000, max: 25_000 } },
];

const TASKS: QsraTaskInput[] = [
  { id: "a", duration: 10, durationDistribution: { kind: "triangular", min: 8, mode: 10, max: 20 } },
  { id: "b", duration: 6, durationDistribution: { kind: "pert", min: 5, mode: 6, max: 14 } },
  { id: "c", duration: 4 },
];
const DEPS: CpmDependencyInput[] = [
  { predecessorId: "a", successorId: "b", type: "FS", lagDays: 0 },
  { predecessorId: "b", successorId: "c", type: "FS", lagDays: 0 },
];

describe("batched QCRA reproduces the library engine exactly", () => {
  for (const batchSize of [100, 250, 500, 1000]) {
    it(`batchSize=${batchSize} matches runQcra bit for bit`, async () => {
      const reference = runQcra(RISKS, { iterations: 1000, seed: 42 });
      const batched = await runQcraBatched(RISKS, { iterations: 1000, seed: 42, batchSize });
      expect(batched.result).toEqual(reference);
      expect(batched.iterationsRun).toBe(1000);
    });
  }

  it("clamps iterations exactly as the library does", async () => {
    const reference = runQcra(RISKS, { iterations: 10, seed: 7 });
    const batched = await runQcraBatched(RISKS, { iterations: 10, seed: 7, batchSize: 25 });
    expect(batched.result.summary.iterations).toBe(reference.summary.iterations);
    expect(batched.result.summary.percentiles).toEqual(reference.summary.percentiles);
  });
});

describe("batched QSRA reproduces the library engine exactly", () => {
  for (const batchSize of [50, 200, 500]) {
    it(`batchSize=${batchSize} matches runQsra bit for bit`, async () => {
      const reference = runQsra(TASKS, DEPS, { projectStart: "2026-01-05", iterations: 500, seed: 11 });
      const batched = await runQsraBatched(TASKS, DEPS, {
        projectStart: "2026-01-05",
        iterations: 500,
        seed: 11,
        batchSize,
      });
      expect(batched.result).toEqual(reference);
    });
  }
});

describe("convergence tracking", () => {
  it("records a running P50/P80 per batch with a delta after the first", async () => {
    const run = await runQcraBatched(RISKS, { iterations: 2000, seed: 3, batchSize: 500 });
    expect(run.convergence).toHaveLength(4);
    expect(run.convergence[0]!.iterations).toBe(500);
    expect(run.convergence[0]!.p80DeltaPercent).toBeNull();
    expect(run.convergence[3]!.iterations).toBe(2000);
    for (const p of run.convergence.slice(1)) {
      expect(p.p80DeltaPercent).not.toBeNull();
      expect(p.p80DeltaPercent!).toBeGreaterThanOrEqual(0);
    }
  });

  it("yields between batches", async () => {
    const seen: number[] = [];
    await runQcraBatched(RISKS, {
      iterations: 1500,
      seed: 9,
      batchSize: 500,
      onBatch: (done) => {
        seen.push(done);
      },
    });
    expect(seen).toEqual([500, 1000, 1500]);
  });

  it("stops early when shouldStop returns true and reports the partial run", async () => {
    let batches = 0;
    const run = await runQcraBatched(RISKS, {
      iterations: 5000,
      seed: 5,
      batchSize: 500,
      shouldStop: () => {
        batches += 1;
        return batches >= 2;
      },
    });
    expect(run.stopped).toBe(true);
    expect(run.iterationsRun).toBe(1000);
    expect(run.result.summary.iterations).toBe(1000);
  });

  it("isConverged needs stable batches, not just any batches", () => {
    const flat: ConvergencePoint[] = [
      { iterations: 500, p50: 100, p80: 200, p80DeltaPercent: null },
      { iterations: 1000, p50: 100, p80: 200.1, p80DeltaPercent: 0.05 },
      { iterations: 1500, p50: 100, p80: 200.2, p80DeltaPercent: 0.05 },
      { iterations: 2000, p50: 100, p80: 200.3, p80DeltaPercent: 0.05 },
    ];
    expect(flat).toHaveLength(CONVERGENCE_STABLE_BATCHES + 1);
    expect(isConverged(flat)).toBe(true);
    expect(isConverged(flat.slice(0, 3))).toBe(false);

    const moving: ConvergencePoint[] = [
      { iterations: 500, p50: 100, p80: 200, p80DeltaPercent: null },
      { iterations: 1000, p50: 100, p80: 240, p80DeltaPercent: 20 },
      { iterations: 1500, p50: 100, p80: 201, p80DeltaPercent: 16 },
      { iterations: 2000, p50: 100, p80: 260, p80DeltaPercent: 29 },
    ];
    expect(isConverged(moving)).toBe(false);
  });

  it("a well-behaved run of many batches converges", async () => {
    const run = await runQcraBatched(RISKS, { iterations: 20000, seed: 1234, batchSize: 2000 });
    expect(run.converged).toBe(true);
  });
});

describe("risk-adjusted cost join (#475)", () => {
  it("adds exposure to the deterministic EAC at each confidence", async () => {
    const run = await runQcraBatched(RISKS, { iterations: 1000, seed: 2, batchSize: DEFAULT_BATCH_SIZE });
    const adj = riskAdjustedCost(run.result.summary, { eac: 10_000_000, currency: "GBP" });
    expect(adj.baseEac).toBe(10_000_000);
    expect(adj.p50).toBeCloseTo(10_000_000 + run.result.summary.percentiles.p50, 2);
    expect(adj.p80!).toBeGreaterThan(adj.p50!);
    expect(adj.unavailableReason).toBeNull();
  });

  it("refuses to invent a total when there is no deterministic base", async () => {
    const run = await runQcraBatched(RISKS, { iterations: 200, seed: 2 });
    const adj = riskAdjustedCost(run.result.summary, { eac: null, currency: "GBP" });
    expect(adj.p50).toBeNull();
    expect(adj.p80).toBeNull();
    expect(adj.unavailableReason).toContain("No deterministic estimate at completion");
  });

  it("says so when there is no simulation at all", () => {
    const adj = riskAdjustedCost(null, { eac: 5_000_000, currency: "GBP" });
    expect(adj.p80).toBeNull();
    expect(adj.unavailableReason).toContain("No cost simulation");
  });
});

describe("executeSimulation (inline path)", () => {
  it("runs a QCRA payload and reports the inline executor", async () => {
    const outcome = await executeSimulation(
      { kind: "qcra", risks: RISKS, riskIds: RISKS.map((r) => r.id) },
      { iterations: 1000, seed: 42, batchSize: 500, preferWorker: false },
    );
    expect(outcome.executor).toBe("inline");
    expect(outcome.kind).toBe("qcra");
    expect(outcome.result).toEqual(runQcra(RISKS, { iterations: 1000, seed: 42 }));
  });

  it("runs a QSRA payload", async () => {
    const outcome = await executeSimulation(
      {
        kind: "qsra",
        scheduleId: "sch1",
        projectStart: "2026-01-05",
        tasks: TASKS,
        deps: DEPS,
        distributionSources: {},
      },
      { iterations: 300, seed: 11, batchSize: 100, preferWorker: false },
    );
    expect(outcome.kind).toBe("qsra");
    expect(outcome.result).toEqual(
      runQsra(TASKS, DEPS, { projectStart: "2026-01-05", iterations: 300, seed: 11 }),
    );
  });

  it("falls back to the inline path when the worker cannot start", async () => {
    const outcome = await executeSimulation(
      { kind: "qcra", risks: RISKS, riskIds: RISKS.map((r) => r.id) },
      { iterations: 200, seed: 8, preferWorker: true },
    );
    // Under vitest the sibling sim-worker.js does not exist, so the worker
    // attempt fails and the inline runner produces the answer anyway.
    expect(outcome.executor).toBe("inline");
    expect(outcome.result.summary.iterations).toBe(200);
  });
});
