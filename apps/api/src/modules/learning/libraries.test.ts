import { describe, expect, it } from "vitest";
import {
  accuracyMetric,
  accuracyRatio,
  centralImpact,
  buildDurationProposals,
  buildRateProposals,
  median,
  MIN_SUFFICIENT_SAMPLE,
  inclusiveDays,
  percentile,
  rateKey,
  realisationStats,
  summarise,
  verdictFor,
  type DurationSample,
  type RateSample,
} from "./libraries.js";

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

describe("percentile / median / summarise", () => {
  it("interpolates between order statistics (R-7), the definition every sheet uses", () => {
    const sorted = [10, 20, 30, 40];
    expect(percentile(sorted, 0)).toBe(10);
    expect(percentile(sorted, 1)).toBe(40);
    expect(percentile(sorted, 0.5)).toBe(25);
    // (n-1)*0.8 = 2.4 → 30 + (40-30)*0.4
    expect(percentile(sorted, 0.8)).toBeCloseTo(34, 10);
  });

  it("answers null for an empty sample rather than zero", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(median([])).toBeNull();
    expect(summarise([])).toBeNull();
  });

  it("ignores non-finite observations instead of poisoning the mean", () => {
    const d = summarise([10, Number.NaN, 20, Number.POSITIVE_INFINITY, 30])!;
    expect(d.n).toBe(3);
    expect(d.mean).toBe(20);
  });

  it("reports the spread it saw, and admits when one observation cannot have one", () => {
    const single = summarise([42])!;
    expect(single.n).toBe(1);
    expect(single.cv).toBeNull();
    const spread = summarise([90, 100, 110])!;
    expect(spread.cv).toBeCloseTo(10 / 100, 6);
  });

  it("does not trim outliers — min and max carry the argument", () => {
    const d = summarise([100, 100, 100, 900])!;
    expect(d.max).toBe(900);
    expect(d.median).toBe(100);
    expect(d.mean).toBe(300);
  });
});

describe("accuracyRatio", () => {
  it("is positive when the estimate was optimistic", () => {
    expect(accuracyRatio(120, 100)).toBeCloseTo(0.2, 10);
    expect(accuracyRatio(80, 100)).toBeCloseTo(-0.2, 10);
  });

  it("refuses to divide by a zero estimate rather than printing an infinity as bias", () => {
    expect(accuracyRatio(120, 0)).toBeNull();
    expect(accuracyRatio(120, null)).toBeNull();
    expect(accuracyRatio(null, 100)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Rate proposals                                                      */
/* ------------------------------------------------------------------ */

function rate(over: Partial<RateSample> & { projectId: string; recordId: string }): RateSample {
  return {
    elementCode: "E10",
    description: "Excavation",
    unit: "m3",
    currency: "GBP",
    quantity: 100,
    amount: 10_000,
    estimatedRate: 90,
    observedAt: "2026-01-31",
    ...over,
  };
}

describe("buildRateProposals", () => {
  it("groups by element, unit and currency and never mixes currencies", () => {
    const out = buildRateProposals([
      rate({ projectId: "p1", recordId: "v1" }),
      rate({ projectId: "p2", recordId: "v2", currency: "EUR" }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.currency).sort()).toEqual(["EUR", "GBP"]);
    expect(out.every((p) => p.distribution.n === 1)).toBe(true);
  });

  it("computes the rate from certified amount ÷ certified quantity", () => {
    const [p] = buildRateProposals([
      rate({ projectId: "p1", recordId: "v1", quantity: 200, amount: 24_000 }),
      rate({ projectId: "p2", recordId: "v2", quantity: 100, amount: 10_000 }),
    ]);
    expect(p!.distribution.min).toBe(100);
    expect(p!.distribution.max).toBe(120);
    expect(p!.distribution.median).toBe(110);
  });

  it("drops observations that cannot produce a rate (zero or negative quantity, contra amounts)", () => {
    const out = buildRateProposals([
      rate({ projectId: "p1", recordId: "v1", quantity: 0 }),
      rate({ projectId: "p1", recordId: "v2", amount: -500 }),
      rate({ projectId: "p1", recordId: "v3", elementCode: "  " }),
      rate({ projectId: "p2", recordId: "v4" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.distribution.n).toBe(1);
    expect(out[0]!.samples.map((s) => s.recordId)).toEqual(["v4"]);
  });

  it("measures estimate accuracy against the priced rate and says which way it is wrong", () => {
    const [p] = buildRateProposals([
      rate({ projectId: "p1", recordId: "v1", quantity: 100, amount: 12_000, estimatedRate: 100 }),
      rate({ projectId: "p2", recordId: "v2", quantity: 100, amount: 12_000, estimatedRate: 100 }),
    ]);
    expect(p!.estimatedRate).toBe(100);
    expect(p!.accuracyRatio).toBeCloseTo(0.2, 10);
    expect(p!.note).toContain("optimistic by 20%");
  });

  it("says estimate accuracy is not available rather than assuming the estimate was right", () => {
    const [p] = buildRateProposals([
      rate({ projectId: "p1", recordId: "v1", estimatedRate: null }),
      rate({ projectId: "p2", recordId: "v2", estimatedRate: null }),
    ]);
    expect(p!.estimatedRate).toBeNull();
    expect(p!.accuracyRatio).toBeNull();
    expect(p!.note).toContain("no priced rate");
  });

  it("publishes a thin sample but marks it insufficient, naming the floor", () => {
    const [p] = buildRateProposals([
      rate({ projectId: "p1", recordId: "v1" }),
      rate({ projectId: "p2", recordId: "v2" }),
    ]);
    expect(p!.sufficient).toBe(false);
    expect(p!.note).toContain(`floor of ${MIN_SUFFICIENT_SAMPLE}`);
  });

  it("refuses to call a single-project sample a company rate", () => {
    const samples = [1, 2, 3, 4, 5].map((i) => rate({ projectId: "p1", recordId: `v${i}` }));
    const [p] = buildRateProposals(samples);
    expect(p!.distribution.n).toBe(5);
    expect(p!.sufficient).toBe(false);
    expect(p!.note).toContain("one project");
  });

  it("is sufficient once the sample clears the floor across more than one project", () => {
    const samples = [1, 2, 3, 4].map((i) =>
      rate({ projectId: i <= 2 ? "p1" : "p2", recordId: `v${i}` }),
    );
    const [p] = buildRateProposals(samples);
    expect(p!.sufficient).toBe(true);
    expect(p!.sourceProjectIds).toEqual(["p1", "p2"]);
  });

  it("is deterministic: the same samples in any order give the same output", () => {
    const a = [1, 2, 3].map((i) => rate({ projectId: `p${i}`, recordId: `v${i}` }));
    const first = buildRateProposals(a);
    const second = buildRateProposals([...a].reverse());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("normalises the grouping key so casing and padding do not fork a library entry", () => {
    expect(rateKey(" e10 ", " M3 ", "gbp")).toBe("E10|m3|GBP");
    const out = buildRateProposals([
      rate({ projectId: "p1", recordId: "v1", elementCode: "e10", unit: "M3" }),
      rate({ projectId: "p2", recordId: "v2", elementCode: "E10 ", unit: "m3" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.distribution.n).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Duration proposals                                                  */
/* ------------------------------------------------------------------ */

function dur(over: Partial<DurationSample> & { projectId: string; taskId: string }): DurationSample {
  return {
    activityCode: "A100",
    name: "Piling",
    plannedDays: 10,
    actualDays: 12,
    actualStart: "2026-01-05",
    actualFinish: "2026-01-17",
    ...over,
  };
}

describe("buildDurationProposals", () => {
  it("measures optimism bias against the planned duration", () => {
    const [p] = buildDurationProposals([
      dur({ projectId: "p1", taskId: "t1" }),
      dur({ projectId: "p2", taskId: "t2" }),
    ]);
    expect(p!.distribution.median).toBe(12);
    expect(p!.plannedDays).toBe(10);
    expect(p!.accuracyRatio).toBeCloseTo(0.2, 10);
    expect(p!.note).toContain("optimistic by 20%");
  });

  it("drops activities that never actually ran", () => {
    const out = buildDurationProposals([
      dur({ projectId: "p1", taskId: "t1", actualDays: 0 }),
      dur({ projectId: "p1", taskId: "t2", activityCode: "" }),
    ]);
    expect(out).toHaveLength(0);
  });

  it("reports no bias when nothing was planned, instead of scoring the plan perfect", () => {
    const [p] = buildDurationProposals([
      dur({ projectId: "p1", taskId: "t1", plannedDays: 0 }),
      dur({ projectId: "p2", taskId: "t2", plannedDays: 0 }),
    ]);
    expect(p!.plannedDays).toBeNull();
    expect(p!.accuracyRatio).toBeNull();
    expect(p!.note).toContain("no planned duration");
  });
});

/* ------------------------------------------------------------------ */
/* Verdicts — when a proposal is worth writing                         */
/* ------------------------------------------------------------------ */

describe("verdictFor", () => {
  const proposal = { distribution: summarise([100, 100, 100])! };

  it("inserts when the library has nothing for the key", () => {
    expect(verdictFor(proposal, null).action).toBe("insert");
  });

  it("replaces an unaccepted proposal outright — nobody agreed to it", () => {
    const v = verdictFor(proposal, { id: "x", sampleSize: 2, median: 50, status: "proposed" });
    expect(v.action).toBe("supersede");
  });

  it("never re-proposes a key an admin rejected", () => {
    const v = verdictFor(proposal, { id: "x", sampleSize: 2, median: 50, status: "rejected" });
    expect(v.action).toBe("skip");
    expect(v.reasons[0]).toContain("rejected");
  });

  it("leaves an accepted entry alone when the evidence has not moved", () => {
    const v = verdictFor(proposal, { id: "x", sampleSize: 3, median: 100.5, status: "accepted" });
    expect(v.action).toBe("skip");
  });

  it("supersedes an accepted entry when the median moves or the sample grows", () => {
    expect(verdictFor(proposal, { id: "x", sampleSize: 3, median: 80, status: "accepted" }).action)
      .toBe("supersede");
    expect(verdictFor(proposal, { id: "x", sampleSize: 2, median: 100, status: "accepted" }).action)
      .toBe("supersede");
  });
});

/* ------------------------------------------------------------------ */
/* Estimate accuracy metric                                            */
/* ------------------------------------------------------------------ */

describe("accuracyMetric", () => {
  it("counts what it could not compare instead of scoring it accurate", () => {
    const m = accuracyMetric("rates", [null, null, 0.1]);
    expect(m.comparable).toBe(1);
    expect(m.notComparable).toBe(2);
    expect(m.medianBias).toBeCloseTo(0.1, 10);
  });

  it("says why there is no number when nothing is comparable", () => {
    expect(accuracyMetric("rates", []).reason).toContain("never been measured");
    expect(accuracyMetric("durations", [null, null]).reason).toContain("recorded estimate");
    expect(accuracyMetric("durations", [null]).medianBias).toBeNull();
  });

  it("reports the share of entries where the estimate was optimistic", () => {
    const m = accuracyMetric("rates", [0.1, 0.2, -0.3, 0.4]);
    expect(m.optimisticShare).toBeCloseTo(0.75, 10);
  });
});

/* ------------------------------------------------------------------ */
/* Risk realisation                                                    */
/* ------------------------------------------------------------------ */

describe("realisationStats", () => {
  it("buckets impacts by currency and never adds across them", () => {
    const [stat] = realisationStats([
      {
        category: "ground",
        predictedProbability: 0.1,
        predictedImpact: 100,
        predictedCurrency: "GBP",
        realisedImpact: 200,
        realisedCurrency: "GBP",
      },
      {
        category: "ground",
        predictedProbability: 0.2,
        predictedImpact: 50,
        predictedCurrency: "EUR",
        realisedImpact: 500,
        realisedCurrency: "EUR",
      },
    ]);
    expect(stat!.realised).toBe(2);
    expect(stat!.impactByCurrency.map((c) => c.currency)).toEqual(["EUR", "GBP"]);
    expect(stat!.meanPredictedProbability).toBeCloseTo(0.15, 10);
    expect(stat!.impactByCurrency.find((c) => c.currency === "GBP")!.bias).toBeCloseTo(1, 10);
  });

  it("says calibration cannot be measured when nothing carried a score", () => {
    const [stat] = realisationStats([
      {
        category: null,
        predictedProbability: null,
        predictedImpact: null,
        predictedCurrency: null,
        realisedImpact: null,
        realisedCurrency: null,
      },
    ]);
    expect(stat!.category).toBe("uncategorised");
    expect(stat!.meanPredictedProbability).toBeNull();
    expect(stat!.reason).toContain("calibration cannot be measured");
    expect(stat!.impactByCurrency).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Risk impact distributions and activity durations                    */
/* ------------------------------------------------------------------ */

describe("centralImpact", () => {
  it("reads the number the register's author was thinking of, per shape", () => {
    expect(centralImpact({ kind: "triangular", min: 1, mode: 5, max: 20 })).toBe(5);
    expect(centralImpact({ kind: "pert", min: 1, mode: 7, max: 20 })).toBe(7);
    expect(centralImpact({ kind: "normal", mean: 12, stdDev: 3 })).toBe(12);
    expect(centralImpact({ kind: "uniform", min: 10, max: 20 })).toBe(15);
    expect(
      centralImpact({ kind: "discrete", values: [{ value: 10, weight: 1 }, { value: 20, weight: 3 }] }),
    ).toBe(17.5);
  });

  it("returns null rather than guessing at a shape it does not know", () => {
    expect(centralImpact(null)).toBeNull();
    expect(centralImpact({ kind: "lognormal", logMean: 1, logStdDev: 1 })).toBeNull();
    expect(centralImpact({ kind: "triangular", min: 1, max: 2 })).toBeNull();
    expect(centralImpact({ kind: "discrete", values: [] })).toBeNull();
    expect(centralImpact("500")).toBeNull();
  });
});

describe("inclusiveDays", () => {
  it("counts a one-day activity as one day", () => {
    expect(inclusiveDays("2026-01-05", "2026-01-05")).toBe(1);
    expect(inclusiveDays("2026-01-05", "2026-01-09")).toBe(5);
  });

  it("has no answer when the dates are missing, unparseable or backwards", () => {
    expect(inclusiveDays(null, "2026-01-05")).toBeNull();
    expect(inclusiveDays("2026-01-05", null)).toBeNull();
    expect(inclusiveDays("not-a-date", "2026-01-05")).toBeNull();
    expect(inclusiveDays("2026-01-09", "2026-01-05")).toBeNull();
  });
});
