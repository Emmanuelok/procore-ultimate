import { describe, expect, it } from "vitest";
import {
  MIN_WIN_MODEL_SAMPLE,
  WIN_MODEL_FEATURES,
  buildWinFeatures,
  competitorProfiles,
  costOfSale,
  estimateWinProbability,
  findScopeGaps,
  fitLogistic,
  predictLogistic,
  scoreBidNoBid,
  winRates,
  type CostRow,
  type FeatureVector,
  type OutcomeRow,
  type PricingObservation,
  type ScopeCoverageFacts,
  type TrainingRow,
} from "./analytics-math.js";

/**
 * The arithmetic of winning work, tested against the two things it must do:
 * produce the right number where the evidence supports one, and REFUSE to
 * produce a number where it does not — with the reason attached. Almost every
 * test below is one of the two.
 */

const zeroFeatures = (): FeatureVector => ({
  priorWinRateWithClient: 0,
  priorWinRateInWorkType: 0,
  logRelativeValue: 0,
  competitorPressure: 0,
  leadTimeAdequacy: 0,
  isRepeatClient: 0,
});

/* ================================================================== */
/* Bid / no-bid scoring                                                */
/* ================================================================== */

describe("bid/no-bid scoring", () => {
  it("weights the factors and names the strongest and weakest", () => {
    const result = scoreBidNoBid([
      { factor: "client_relationship", score: 9, weight: 30 },
      { factor: "capacity", score: 3, weight: 30 },
      { factor: "margin_potential", score: 7, weight: 40 },
    ]);
    expect(result.score.value).toBeCloseTo(9 * 3 + 3 * 3 + 7 * 4, 1);
    expect(result.strongest).toBe("margin_potential");
    expect(result.weakest).toBe("capacity");
    expect(result.basis).toMatch(/the score suggests and the bid/i);
  });

  it("suggests bidding above the threshold and declining below it", () => {
    expect(
      scoreBidNoBid([{ factor: "capacity", score: 9, weight: 100 }]).suggested,
    ).toBe("bid");
    expect(
      scoreBidNoBid([{ factor: "capacity", score: 2, weight: 100 }]).suggested,
    ).toBe("no_bid");
    expect(
      scoreBidNoBid([{ factor: "capacity", score: 5, weight: 100 }]).suggested,
    ).toBe("marginal");
  });

  it("refuses to score with no factors, and says why", () => {
    const result = scoreBidNoBid([]);
    expect(result.score.value).toBeNull();
    expect(result.score.reasons[0]).toMatch(/hunch/i);
    expect(result.suggested).toBeNull();
  });

  it("refuses to score when every factor carries zero weight", () => {
    const result = scoreBidNoBid([{ factor: "capacity", score: 10, weight: 0 }]);
    expect(result.score.value).toBeNull();
    expect(result.score.reasons[0]).toMatch(/weight of zero/i);
  });

  it("clamps a score outside 0..10 rather than letting it dominate", () => {
    const result = scoreBidNoBid([{ factor: "capacity", score: 500, weight: 100 }]);
    expect(result.score.value).toBe(100);
  });
});

/* ================================================================== */
/* Logistic win model                                                  */
/* ================================================================== */

describe("logistic win model", () => {
  function row(client: number, lead: number, label: 0 | 1): TrainingRow {
    return {
      features: { ...zeroFeatures(), priorWinRateWithClient: client, leadTimeAdequacy: lead },
      label,
    };
  }

  it("is deterministic: the same rows give the same weights every time", () => {
    const rows = [row(0.9, 0.9, 1), row(0.1, 0.2, 0), row(0.8, 0.7, 1), row(0.2, 0.1, 0)];
    const a = fitLogistic(rows);
    const b = fitLogistic(rows);
    expect(a.weights).toEqual(b.weights);
    expect(a.bias).toBe(b.bias);
    expect(a.logLoss).toBe(b.logLoss);
  });

  it("learns the direction of a separable signal", () => {
    const rows: TrainingRow[] = [];
    for (let i = 0; i < 6; i += 1) {
      rows.push(row(0.9, 0.8, 1));
      rows.push(row(0.1, 0.2, 0));
    }
    const model = fitLogistic(rows);
    expect(model.weights.priorWinRateWithClient).toBeGreaterThan(0);
    const strong = predictLogistic(model, {
      ...zeroFeatures(),
      priorWinRateWithClient: 0.9,
      leadTimeAdequacy: 0.8,
    });
    const weak = predictLogistic(model, {
      ...zeroFeatures(),
      priorWinRateWithClient: 0.1,
      leadTimeAdequacy: 0.2,
    });
    expect(strong).toBeGreaterThan(weak);
    expect(model.accuracy).toBe(1);
  });

  it("keeps a perfectly separating feature from acquiring an infinite weight", () => {
    const rows: TrainingRow[] = [];
    for (let i = 0; i < 20; i += 1) {
      rows.push(row(1, 0, 1));
      rows.push(row(0, 0, 0));
    }
    const model = fitLogistic(rows);
    expect(Number.isFinite(model.weights.priorWinRateWithClient)).toBe(true);
    expect(Math.abs(model.weights.priorWinRateWithClient)).toBeLessThan(20);
  });

  it("carries every declared feature in the weight vector", () => {
    const model = fitLogistic([row(0.5, 0.5, 1), row(0.4, 0.4, 0)]);
    for (const key of WIN_MODEL_FEATURES) {
      expect(model.weights).toHaveProperty(key);
    }
  });
});

describe("estimateWinProbability", () => {
  const candidate: FeatureVector = { ...zeroFeatures(), priorWinRateWithClient: 0.8 };

  it("refuses to estimate on a thin history and names the shortfall", () => {
    const history: TrainingRow[] = [
      { features: zeroFeatures(), label: 1 },
      { features: zeroFeatures(), label: 0 },
    ];
    const result = estimateWinProbability(candidate, history);
    expect(result.probability.value).toBeNull();
    expect(result.probability.reasons[0]).toMatch(
      new RegExp(`at least ${MIN_WIN_MODEL_SAMPLE}`, "i"),
    );
    expect(result.model).toBeNull();
    expect(result.basis).toMatch(/we do not know/i);
  });

  it("refuses to estimate when the history is all wins", () => {
    const history: TrainingRow[] = Array.from({ length: 10 }, () => ({
      features: zeroFeatures(),
      label: 1 as const,
    }));
    const result = estimateWinProbability(candidate, history);
    expect(result.probability.value).toBeNull();
    expect(result.probability.reasons[0]).toMatch(/one-sided|10 win/i);
  });

  it("produces a probability with its contributions once there is enough history", () => {
    const history: TrainingRow[] = [];
    for (let i = 0; i < 6; i += 1) {
      history.push({
        features: { ...zeroFeatures(), priorWinRateWithClient: 0.9 },
        label: 1,
      });
      history.push({
        features: { ...zeroFeatures(), priorWinRateWithClient: 0.1 },
        label: 0,
      });
    }
    const result = estimateWinProbability(candidate, history);
    expect(result.probability.value).not.toBeNull();
    expect(result.probability.value!).toBeGreaterThan(0.5);
    expect(result.model!.sampleSize).toBe(12);
    expect(result.contributions[0]!.feature).toBe("priorWinRateWithClient");
    expect(result.basis).toMatch(/In-sample accuracy is always flattering/i);
  });
});

describe("buildWinFeatures", () => {
  it("treats an unknown prior rate as 0.5 rather than as a loss", () => {
    const f = buildWinFeatures({
      clientWins: 0,
      clientBids: 0,
      workTypeWins: 0,
      workTypeBids: 0,
      value: null,
      medianDecidedValue: null,
      competitorCount: null,
      leadTimeDays: null,
    });
    expect(f.priorWinRateWithClient).toBe(0.5);
    expect(f.isRepeatClient).toBe(0);
  });

  it("bounds the relative-value feature so one outlier cannot dominate", () => {
    const f = buildWinFeatures({
      clientWins: 1,
      clientBids: 2,
      workTypeWins: 1,
      workTypeBids: 2,
      value: 1_000_000_000,
      medianDecidedValue: 10,
      competitorCount: 400,
      leadTimeDays: 4000,
    });
    expect(f.logRelativeValue).toBe(2);
    expect(f.competitorPressure).toBe(1);
    expect(f.leadTimeAdequacy).toBe(1);
  });
});

/* ================================================================== */
/* Win rates                                                           */
/* ================================================================== */

describe("win rates", () => {
  const rows: OutcomeRow[] = [
    { key: "acme", label: "Acme", outcome: "won", value: 100, currency: "GBP" },
    { key: "acme", label: "Acme", outcome: "won", value: 200, currency: "GBP" },
    { key: "acme", label: "Acme", outcome: "lost", value: 300, currency: "GBP" },
    { key: "acme", label: "Acme", outcome: "pending", value: 400, currency: "GBP" },
    { key: "beta", label: "Beta", outcome: "won", value: 50, currency: "GBP" },
    { key: "beta", label: "Beta", outcome: "no_bid", value: 60, currency: "GBP" },
  ];

  it("computes a rate over decided bids only", () => {
    const { groups } = winRates(rows);
    const acme = groups.find((g) => g.key === "acme")!;
    expect(acme.wins).toBe(2);
    expect(acme.losses).toBe(1);
    expect(acme.pending).toBe(1);
    expect(acme.winRatePercent.value).toBeCloseTo(66.67, 1);
  });

  it("refuses a rate over fewer than three decided bids", () => {
    const { groups } = winRates(rows);
    const beta = groups.find((g) => g.key === "beta")!;
    expect(beta.winRatePercent.value).toBeNull();
    expect(beta.winRatePercent.reasons[0]).toMatch(/1 decided bid/);
  });

  it("buckets value per currency and never sums across one", () => {
    const mixed: OutcomeRow[] = [
      ...rows,
      { key: "acme", label: "Acme", outcome: "won", value: 900, currency: "EUR" },
    ];
    const { groups } = winRates(mixed);
    const acme = groups.find((g) => g.key === "acme")!;
    expect(acme.valueByCurrency.map((v) => v.currency).sort()).toEqual(["EUR", "GBP"]);
    const gbp = acme.valueByCurrency.find((v) => v.currency === "GBP")!;
    expect(gbp.bidValue).toBe(600);
    expect(gbp.wonValue).toBe(300);
    expect(gbp.winRateByValuePercent).toBe(50);
  });

  it("produces an overall group alongside the breakdown", () => {
    const { overall } = winRates(rows);
    expect(overall.wins).toBe(3);
    expect(overall.losses).toBe(1);
    expect(overall.winRatePercent.value).toBe(75);
  });
});

/* ================================================================== */
/* Competitor pricing                                                  */
/* ================================================================== */

describe("competitor profiles", () => {
  const obs = (
    vendorId: string,
    amount: number,
    median: number,
    won: boolean,
    rank: number | null = null,
  ): PricingObservation => ({
    packageId: `p-${vendorId}-${amount}`,
    packageReference: "BP-0001",
    tradeCode: "GROUNDWORKS",
    vendorId,
    vendorName: vendorId,
    amount,
    currency: "GBP",
    fieldMedian: median,
    engineersEstimate: 100,
    rank,
    fieldSize: 3,
    won,
  });

  it("places a consistently cheap bidder below the market", () => {
    const profiles = competitorProfiles([
      obs("alpha", 90, 100, true, 1),
      obs("alpha", 91, 100, false, 1),
      obs("alpha", 89, 100, true, 1),
    ]);
    const alpha = profiles.find((p) => p.vendorId === "alpha")!;
    expect(alpha.medianDeviationPercent.value).toBeCloseTo(-10, 0);
    expect(alpha.winRatePercent.value).toBeCloseTo(66.67, 1);
    expect(alpha.averageRank.value).toBe(1);
    expect(alpha.note).toMatch(/below the median/);
  });

  it("refuses a win rate from too few appearances", () => {
    const profiles = competitorProfiles([obs("bravo", 120, 100, false)]);
    expect(profiles[0]!.winRatePercent.value).toBeNull();
    expect(profiles[0]!.winRatePercent.reasons[0]).toMatch(/1 bid/);
  });

  it("calls out a suspiciously consistent pricing spread", () => {
    const profiles = competitorProfiles([
      obs("charlie", 110, 100, false),
      obs("charlie", 110, 100, false),
      obs("charlie", 110, 100, false),
    ]);
    expect(profiles[0]!.deviationSpread).toBe(0);
    expect(profiles[0]!.note).toMatch(/formula rather than an estimate/i);
  });
});

/* ================================================================== */
/* Scope gaps                                                          */
/* ================================================================== */

describe("scope gaps", () => {
  const item = (
    id: string,
    answers: ScopeCoverageFacts["answers"],
    over: Partial<ScopeCoverageFacts> = {},
  ): ScopeCoverageFacts => ({
    itemId: id,
    itemCode: id,
    description: `Row ${id}`,
    isMandatory: true,
    engineersEstimate: 1000,
    answers,
    ...over,
  });

  const answer = (
    vendorId: string,
    includedStatus: string,
    adjustmentAmount = 0,
  ) => ({
    submissionId: `s-${vendorId}`,
    vendorId,
    vendorName: vendorId,
    includedStatus,
    levelledAmount: null,
    adjustmentAmount,
  });

  it("calls a row nobody priced a critical gap", () => {
    const { gaps, summary } = findScopeGaps(
      [
        item("A", [
          answer("alpha", "excluded"),
          answer("bravo", "excluded"),
          answer("charlie", "excluded"),
        ]),
      ],
      3,
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.severity).toBe("critical");
    expect(gaps[0]!.note).toMatch(/No bidder has this scope in their price/);
    expect(summary.universalGaps).toBe(1);
    expect(summary.exposure).toBe(1000);
  });

  it("flags a row only some bidders carry", () => {
    const { gaps } = findScopeGaps(
      [item("A", [answer("alpha", "included"), answer("bravo", "excluded")])],
      3,
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.severity).toBe("high");
    expect(gaps[0]!.unanswered).toBe(1);
    expect(gaps[0]!.uncoveredVendorIds).toEqual(["bravo"]);
  });

  it("says nothing about a row everybody carried", () => {
    const { gaps, summary } = findScopeGaps(
      [
        item("A", [
          answer("alpha", "included"),
          answer("bravo", "included"),
          answer("charlie", "included"),
        ]),
      ],
      3,
    );
    expect(gaps).toHaveLength(0);
    expect(summary.gapRows).toBe(0);
  });

  it("does not treat an adjusted exclusion as uncovered", () => {
    const { gaps } = findScopeGaps(
      [
        item("A", [
          answer("alpha", "included"),
          answer("bravo", "excluded", 4200),
          answer("charlie", "included"),
        ]),
      ],
      3,
    );
    expect(gaps[0]!.uncoveredVendorIds).toEqual([]);
  });

  it("orders the gaps by severity", () => {
    const { gaps } = findScopeGaps(
      [
        item("A", [answer("alpha", "included"), answer("bravo", "unclear")], {
          isMandatory: false,
        }),
        item("B", [answer("alpha", "excluded"), answer("bravo", "excluded")]),
      ],
      2,
    );
    expect(gaps[0]!.itemId).toBe("B");
    expect(gaps[0]!.severity).toBe("critical");
  });
});

/* ================================================================== */
/* Cost of sale                                                        */
/* ================================================================== */

describe("cost of sale", () => {
  const rows: CostRow[] = [
    { subjectId: "o1", outcome: "won", amount: 4000, currency: "GBP", hours: 40, kind: "estimating_labour" },
    { subjectId: "o2", outcome: "lost", amount: 9000, currency: "GBP", hours: 90, kind: "estimating_labour" },
    { subjectId: "o3", outcome: "lost", amount: 2000, currency: "GBP", hours: null, kind: "printing" },
    { subjectId: "o4", outcome: "won", amount: 1500, currency: "EUR", hours: 12, kind: "design_fee" },
  ];

  it("splits cost by outcome and by kind, per currency", () => {
    const [gbp] = costOfSale(
      rows,
      new Map([
        ["GBP", 500_000],
        ["EUR", 100_000],
      ]),
      new Map([
        ["GBP", 1],
        ["EUR", 1],
      ]),
    ).filter((c) => c.currency === "GBP");
    expect(gbp!.totalCost).toBe(15_000);
    expect(gbp!.wonCost).toBe(4000);
    expect(gbp!.lostCost).toBe(11_000);
    expect(gbp!.totalHours).toBe(130);
    expect(gbp!.costPerWin.value).toBe(15_000);
    expect(gbp!.costOfSalePercent.value).toBe(3);
    expect(gbp!.byKind.find((k) => k.kind === "printing")!.sharePercent).toBeCloseTo(13.33, 1);
  });

  it("refuses cost per win where nothing was won in that currency", () => {
    const summaries = costOfSale(rows, new Map(), new Map());
    const gbp = summaries.find((c) => c.currency === "GBP")!;
    expect(gbp.costPerWin.value).toBeNull();
    expect(gbp.costPerWin.reasons[0]).toMatch(/unrecovered/i);
    expect(gbp.costOfSalePercent.value).toBeNull();
  });

  it("never sums across currencies", () => {
    const summaries = costOfSale(rows, new Map(), new Map());
    expect(summaries.map((s) => s.currency).sort()).toEqual(["EUR", "GBP"]);
    expect(summaries.find((s) => s.currency === "EUR")!.totalCost).toBe(1500);
  });
});
