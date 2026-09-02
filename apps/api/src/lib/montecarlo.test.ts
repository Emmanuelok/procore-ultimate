import { describe, expect, it } from "vitest";
import {
  createRng,
  percentile,
  runQcra,
  runQsra,
  sampleDistribution,
  summarize,
} from "./montecarlo.js";

describe("prng", () => {
  it("is deterministic for a given seed and differs across seeds", () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    const seqC = [c(), c(), c()];
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const v of seqA) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of seqA) expect(v).toBeLessThan(1);
  });
});

describe("distributions", () => {
  const N = 20000;

  function mean(samples: number[]): number {
    return samples.reduce((s, v) => s + v, 0) / samples.length;
  }

  it("triangular mean ≈ (min+mode+max)/3 and stays in range", () => {
    const rng = createRng(1);
    const samples = Array.from({ length: N }, () =>
      sampleDistribution({ kind: "triangular", min: 10, mode: 20, max: 40 }, rng),
    );
    expect(mean(samples)).toBeCloseTo((10 + 20 + 40) / 3, 0);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...samples)).toBeLessThanOrEqual(40);
  });

  it("PERT mean ≈ (min+4·mode+max)/6", () => {
    const rng = createRng(2);
    const samples = Array.from({ length: N }, () =>
      sampleDistribution({ kind: "pert", min: 10, mode: 20, max: 40 }, rng),
    );
    expect(mean(samples)).toBeCloseTo((10 + 4 * 20 + 40) / 6, 0);
  });

  it("uniform, normal and discrete behave sanely", () => {
    const rng = createRng(3);
    const uni = Array.from({ length: N }, () =>
      sampleDistribution({ kind: "uniform", min: 0, max: 10 }, rng),
    );
    expect(mean(uni)).toBeCloseTo(5, 0);

    const norm = Array.from({ length: N }, () =>
      sampleDistribution({ kind: "normal", mean: 100, stdDev: 15 }, rng),
    );
    expect(mean(norm)).toBeCloseTo(100, 0);

    const disc = Array.from({ length: N }, () =>
      sampleDistribution(
        { kind: "discrete", values: [{ value: 1, weight: 1 }, { value: 3, weight: 3 }] },
        rng,
      ),
    );
    // E = (1·1 + 3·3)/4 = 2.5
    expect(mean(disc)).toBeCloseTo(2.5, 1);
  });
});

describe("summarize / percentile", () => {
  it("orders percentiles and buckets the histogram completely", () => {
    const samples = Array.from({ length: 1000 }, (_, i) => i);
    const s = summarize(samples, 10);
    expect(s.percentiles.p10).toBeLessThan(s.percentiles.p50);
    expect(s.percentiles.p50).toBeLessThan(s.percentiles.p80);
    expect(s.percentiles.p80).toBeLessThan(s.percentiles.p95);
    expect(s.histogram.reduce((n, b) => n + b.count, 0)).toBe(1000);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });
});

describe("runQcra", () => {
  it("a certain uniform risk yields P50 ≈ midpoint; results reproduce by seed", () => {
    const risks = [
      { id: "r1", name: "Ground", probability: 1, impact: { kind: "uniform" as const, min: 100, max: 200 } },
    ];
    const a = runQcra(risks, { iterations: 5000, seed: 7 });
    const b = runQcra(risks, { iterations: 5000, seed: 7 });
    expect(a.summary.percentiles.p50).toBeCloseTo(150, -1);
    expect(a.summary.percentiles.p50).toBe(b.summary.percentiles.p50);
    expect(a.perRisk[0]!.occurredShare).toBe(1);
    expect(a.correlationModelled).toBe(false);
  });

  it("occurrence frequency tracks probability and tornado ranks the bigger driver first", () => {
    const risks = [
      { id: "small", name: "Small", probability: 0.5, impact: { kind: "uniform" as const, min: 1, max: 2 } },
      { id: "big", name: "Big", probability: 0.5, impact: { kind: "uniform" as const, min: 500, max: 1000 } },
    ];
    const r = runQcra(risks, { iterations: 8000, seed: 11 });
    const small = r.perRisk.find((p) => p.id === "small")!;
    const big = r.perRisk.find((p) => p.id === "big")!;
    expect(small.occurredShare).toBeCloseTo(0.5, 1);
    expect(r.perRisk[0]!.id).toBe("big");
    expect(big.expectedValue).toBeGreaterThan(small.expectedValue);
    // P80 exceeds P50 exceeds expected floor
    expect(r.contingencyAt.p80).toBeGreaterThan(r.contingencyAt.p50);
  });
});

describe("runQsra", () => {
  const START = "2026-01-01";
  const tasks = [
    { id: "A", duration: 5 },
    { id: "B", duration: 10 },
    { id: "C", duration: 3 },
    { id: "D", duration: 5 },
  ];
  const deps = [
    { predecessorId: "A", successorId: "B", type: "FS" as const, lagDays: 0 },
    { predecessorId: "A", successorId: "C", type: "FS" as const, lagDays: 0 },
    { predecessorId: "B", successorId: "D", type: "FS" as const, lagDays: 0 },
    { predecessorId: "C", successorId: "D", type: "FS" as const, lagDays: 0 },
  ];

  it("with zero uncertainty every iteration equals the deterministic CPM", () => {
    const r = runQsra(tasks, deps, { projectStart: START, iterations: 100, seed: 5 });
    expect(r.deterministicDurationDays).toBe(20);
    expect(r.summary.min).toBe(20);
    expect(r.summary.max).toBe(20);
    const crit = Object.fromEntries(r.perTask.map((t) => [t.id, t.criticalityIndex]));
    expect(crit["A"]).toBe(1);
    expect(crit["B"]).toBe(1);
    expect(crit["D"]).toBe(1);
    expect(crit["C"]).toBe(0);
  });

  it("uncertainty on the critical task widens completion and shows top sensitivity", () => {
    const uncertain = tasks.map((t) =>
      t.id === "B"
        ? { ...t, durationDistribution: { kind: "triangular" as const, min: 8, mode: 10, max: 20 } }
        : t,
    );
    const r = runQsra(uncertain, deps, { projectStart: START, iterations: 800, seed: 9 });
    expect(r.summary.max).toBeGreaterThan(20);
    expect(r.summary.percentiles.p80).toBeGreaterThanOrEqual(20);
    expect(r.perTask[0]!.id).toBe("B");
    // near-critical C can become critical when B samples short — index in [0,1]
    for (const t of r.perTask) {
      expect(t.criticalityIndex).toBeGreaterThanOrEqual(0);
      expect(t.criticalityIndex).toBeLessThanOrEqual(1);
    }
    // reproducibility
    const r2 = runQsra(uncertain, deps, { projectStart: START, iterations: 800, seed: 9 });
    expect(r2.summary.percentiles.p80).toBe(r.summary.percentiles.p80);
  });
});
