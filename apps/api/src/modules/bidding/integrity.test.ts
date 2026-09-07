import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTEGRITY_THRESHOLDS,
  alternationRate,
  assessAbnormalPricing,
  assessUnbalancedBids,
  detectApprovalBehaviour,
  detectConstantRatio,
  detectCoverBidding,
  detectIdenticalRates,
  detectLateSubmissionWins,
  detectPriceClustering,
  detectRepeatInvitationSets,
  detectSubmissionClustering,
  detectWinnerRotation,
  detectWithdrawalPatterns,
  dispersionOf,
  medianUnsorted,
  normalisedEntropy,
  resolveThresholds,
  runCompanyIntegrity,
  runPackageIntegrity,
  type ContenderFacts,
  type PackageFacts,
  type PackageHistoryFacts,
  type RateFacts,
} from "./integrity.js";

/**
 * MEASURED PRECISION FIXTURES.
 *
 * Every detector is tested twice: once against a PLANTED scheme it must
 * catch, and once against an honest tender it must leave alone. The second
 * half is the half that matters — a detector that fires on ordinary
 * competition produces false-positive fatigue, and a register nobody reads
 * is worse than no register, because it looks like assurance.
 */

const pkg: PackageFacts = {
  packageId: "bpk_1",
  reference: "BP-0001",
  title: "Substructure",
  currency: "GBP",
  engineersEstimate: 200_000,
  tradeCode: "GROUNDWORKS",
  comparisonBasis: "levelled",
};

const contender = (
  id: string,
  vendorId: string,
  amount: number | null,
  over: Partial<ContenderFacts> = {},
): ContenderFacts => ({
  submissionId: id,
  reference: `BP-0001-${id}`,
  vendorId,
  vendorName: vendorId.toUpperCase(),
  amount,
  currency: "GBP",
  receivedAt: "2026-03-01T09:00:00.000Z",
  isLate: false,
  lateAccepted: false,
  status: "received",
  ...over,
});

const rate = (
  submissionId: string,
  vendorId: string,
  key: string,
  position: number,
  unitRate: number | null,
  quantity = 10,
): RateFacts => ({
  submissionId,
  vendorId,
  lineId: `${submissionId}:${key}`,
  key,
  position,
  description: `Item ${key}`,
  unitRate,
  amount: unitRate === null ? null : unitRate * quantity,
  quantity,
});

/* ================================================================== */
/* Statistics                                                          */
/* ================================================================== */

describe("dispersion statistics", () => {
  it("computes mean, population sd, cv and median", () => {
    const d = dispersionOf([100, 110, 120]);
    expect(d.n).toBe(3);
    expect(d.mean).toBe(110);
    expect(d.median).toBe(110);
    expect(d.min).toBe(100);
    expect(d.max).toBe(120);
    // population sd of 100/110/120 = sqrt(200/3) ≈ 8.165
    expect(d.sd).toBeCloseTo(8.16, 1);
    expect(d.cvPercent).toBeCloseTo(7.42, 1);
  });

  it("returns nulls rather than zeros for an empty set", () => {
    const d = dispersionOf([]);
    expect(d.n).toBe(0);
    expect(d.mean).toBeNull();
    expect(d.cvPercent).toBeNull();
  });

  it("medians an even-length set by averaging the middle pair", () => {
    expect(medianUnsorted([4, 1, 3, 2])).toBe(2.5);
    expect(medianUnsorted([])).toBeNull();
  });

  it("normalises entropy to 1 for a perfectly even distribution", () => {
    expect(normalisedEntropy([3, 3, 3])).toBe(1);
    expect(normalisedEntropy([9, 1, 1])).toBeLessThan(0.8);
    expect(normalisedEntropy([5])).toBeNull();
  });

  it("measures alternation as the share of consecutive changes", () => {
    expect(alternationRate(["a", "b", "a", "b"])).toBe(1);
    expect(alternationRate(["a", "a", "a", "a"])).toBe(0);
    expect(alternationRate(["a", "b"])).toBeNull();
  });
});

describe("threshold resolution", () => {
  it("takes numeric overrides and ignores everything else", () => {
    const t = resolveThresholds({ clusteringCvPercent: 1.5, nonsense: "x", dispersionCvPercent: -1 });
    expect(t.clusteringCvPercent).toBe(1.5);
    expect(t.dispersionCvPercent).toBe(DEFAULT_INTEGRITY_THRESHOLDS.dispersionCvPercent);
    expect(t).not.toHaveProperty("nonsense");
  });

  it("falls back to the defaults for a non-object", () => {
    expect(resolveThresholds(null)).toEqual(DEFAULT_INTEGRITY_THRESHOLDS);
    expect(resolveThresholds("no")).toEqual(DEFAULT_INTEGRITY_THRESHOLDS);
  });
});

/* ================================================================== */
/* 1. Price clustering                                                 */
/* ================================================================== */

describe("price clustering (Domain A #1)", () => {
  it("flags three bids inside 3% as a complementary-bidding signature", () => {
    const findings = detectPriceClustering(pkg, [
      contender("s1", "alpha", 200_000),
      contender("s2", "bravo", 202_000),
      contender("s3", "charlie", 204_000),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detector).toBe("bid_integrity_price_clustering");
    expect(findings[0]!.statistic["coefficientOfVariationPercent"]).toBeLessThan(3);
    expect(findings[0]!.key).toBe("clustering:bpk_1");
    expect(findings[0]!.explanation).toMatch(/complementary-bidding signature/i);
    // The innocent explanations are named, because a finding is a question.
    expect(findings[0]!.explanation).toMatch(/schedule of rates|published rates/i);
  });

  it("leaves an ordinary competitive spread alone", () => {
    const findings = detectPriceClustering(pkg, [
      contender("s1", "alpha", 180_000),
      contender("s2", "bravo", 205_000),
      contender("s3", "charlie", 226_000),
    ]);
    expect(findings).toHaveLength(0);
  });

  it("flags an implausibly wide spread as a dispersion anomaly instead", () => {
    const findings = detectPriceClustering(pkg, [
      contender("s1", "alpha", 90_000),
      contender("s2", "bravo", 200_000),
      contender("s3", "charlie", 330_000),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detector).toBe("bid_integrity_price_dispersion");
  });

  it("refuses to run on fewer than three priced bids", () => {
    expect(
      detectPriceClustering(pkg, [contender("s1", "alpha", 200_000), contender("s2", "b", 201_000)]),
    ).toHaveLength(0);
  });

  it("refuses to run across currencies", () => {
    expect(
      detectPriceClustering(pkg, [
        contender("s1", "alpha", 200_000),
        contender("s2", "bravo", 201_000, { currency: "USD" }),
        contender("s3", "charlie", 202_000),
      ]),
    ).toHaveLength(0);
  });
});

/* ================================================================== */
/* 2. Rate-level detectors                                             */
/* ================================================================== */

describe("identical unit rates (Domain A #4)", () => {
  const contenders = [
    contender("s1", "alpha", 200_000),
    contender("s2", "bravo", 210_000),
    contender("s3", "charlie", 195_000),
  ];

  it("flags a pair sharing rates across most of the bill", () => {
    const lines: RateFacts[] = [];
    const shared = [12.5, 40, 88.25, 190, 7.4, 61];
    shared.forEach((r, i) => {
      lines.push(rate("s1", "alpha", `A${i}`, i, r));
      lines.push(rate("s2", "bravo", `A${i}`, i, r));
      lines.push(rate("s3", "charlie", `A${i}`, i, r * 1.17 + 3));
    });
    const findings = detectIdenticalRates(pkg, contenders, lines);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detector).toBe("bid_integrity_identical_rates");
    expect(findings[0]!.statistic["exactMatches"]).toBe(6);
    expect(findings[0]!.evidence["vendorIds"]).toEqual(["alpha", "bravo"]);
  });

  it("treats rates within half a percent as matched, and says so", () => {
    const lines: RateFacts[] = [];
    [100, 200, 300, 400].forEach((r, i) => {
      lines.push(rate("s1", "alpha", `A${i}`, i, r));
      lines.push(rate("s2", "bravo", `A${i}`, i, r * 1.003));
    });
    const findings = detectIdenticalRates(pkg, contenders.slice(0, 2), lines);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.statistic["nearMatches"]).toBe(4);
    expect(findings[0]!.statistic["exactMatches"]).toBe(0);
  });

  it("does not fire on a couple of coincidental round rates", () => {
    const lines: RateFacts[] = [];
    // Six lines; only two agree — the ordinary "everyone charges £25/m for
    // this" case, which must not raise anything.
    [
      [25, 25],
      [50, 50],
      [88, 131],
      [140, 96],
      [12, 44],
      [310, 205],
    ].forEach(([a, b], i) => {
      lines.push(rate("s1", "alpha", `A${i}`, i, a ?? 0));
      lines.push(rate("s2", "bravo", `A${i}`, i, b ?? 0));
    });
    expect(detectIdenticalRates(pkg, contenders.slice(0, 2), lines)).toHaveLength(0);
  });

  it("ignores two zeroes agreeing with each other", () => {
    const lines: RateFacts[] = [];
    for (let i = 0; i < 6; i += 1) {
      lines.push(rate("s1", "alpha", `A${i}`, i, 0));
      lines.push(rate("s2", "bravo", `A${i}`, i, 0));
    }
    expect(detectIdenticalRates(pkg, contenders.slice(0, 2), lines)).toHaveLength(0);
  });
});

describe("constant-ratio bills (Domain A #5)", () => {
  const contenders = [contender("s1", "alpha", 200_000), contender("s2", "bravo", 214_000)];

  it("flags one bill that is a fixed multiple of another", () => {
    const lines: RateFacts[] = [];
    [11.5, 43, 87.2, 190, 7.4, 61, 250].forEach((r, i) => {
      lines.push(rate("s1", "alpha", `A${i}`, i, r));
      lines.push(rate("s2", "bravo", `A${i}`, i, Number((r * 1.07).toFixed(4))));
    });
    const findings = detectConstantRatio(pkg, contenders, lines);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detector).toBe("bid_integrity_constant_ratio");
    expect(Number(findings[0]!.statistic["medianRatio"])).toBeCloseTo(1.07, 3);
    expect(Number(findings[0]!.statistic["impliedUpliftPercent"])).toBeCloseTo(7, 1);
  });

  it("does not fire when the two bidders price items differently from each other", () => {
    const lines: RateFacts[] = [];
    const a = [11.5, 43, 87.2, 190, 7.4, 61, 250];
    const b = [13.1, 39, 96.0, 175, 9.9, 58, 291];
    a.forEach((r, i) => {
      lines.push(rate("s1", "alpha", `A${i}`, i, r));
      lines.push(rate("s2", "bravo", `A${i}`, i, b[i] ?? 0));
    });
    expect(detectConstantRatio(pkg, contenders, lines)).toHaveLength(0);
  });

  it("leaves identical bills to the identical-rate detector", () => {
    const lines: RateFacts[] = [];
    [11.5, 43, 87.2, 190, 7.4, 61].forEach((r, i) => {
      lines.push(rate("s1", "alpha", `A${i}`, i, r));
      lines.push(rate("s2", "bravo", `A${i}`, i, r));
    });
    expect(detectConstantRatio(pkg, contenders, lines)).toHaveLength(0);
  });

  it("needs at least five comparable lines", () => {
    const lines: RateFacts[] = [];
    [10, 20, 30].forEach((r, i) => {
      lines.push(rate("s1", "alpha", `A${i}`, i, r));
      lines.push(rate("s2", "bravo", `A${i}`, i, r * 1.1));
    });
    expect(detectConstantRatio(pkg, contenders, lines)).toHaveLength(0);
  });
});

/* ================================================================== */
/* 3. Submission clustering                                            */
/* ================================================================== */

describe("submission timing (Domain A #7)", () => {
  it("flags bids from different companies arriving minutes apart", () => {
    const findings = detectSubmissionClustering(pkg, [
      contender("s1", "alpha", 200_000, { receivedAt: "2026-03-01T16:58:00.000Z" }),
      contender("s2", "bravo", 210_000, { receivedAt: "2026-03-01T17:01:00.000Z" }),
      contender("s3", "charlie", 190_000, { receivedAt: "2026-02-27T11:00:00.000Z" }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.statistic["bidders"]).toBe(2);
    expect(Number(findings[0]!.statistic["spanMinutes"])).toBe(3);
  });

  it("does not flag two revisions from the same bidder", () => {
    const findings = detectSubmissionClustering(pkg, [
      contender("s1", "alpha", 200_000, { receivedAt: "2026-03-01T16:58:00.000Z" }),
      contender("s2", "alpha", 199_000, { receivedAt: "2026-03-01T17:01:00.000Z" }),
    ]);
    expect(findings).toHaveLength(0);
  });

  it("does not flag bids spread across the last day", () => {
    const findings = detectSubmissionClustering(pkg, [
      contender("s1", "alpha", 200_000, { receivedAt: "2026-03-01T09:00:00.000Z" }),
      contender("s2", "bravo", 210_000, { receivedAt: "2026-03-01T13:30:00.000Z" }),
      contender("s3", "charlie", 190_000, { receivedAt: "2026-03-01T16:45:00.000Z" }),
    ]);
    expect(findings).toHaveLength(0);
  });
});

/* ================================================================== */
/* 4. Abnormally low and high tenders                                  */
/* ================================================================== */

describe("abnormally low and high tenders (Domain A #16-19)", () => {
  const field = [
    contender("s1", "alpha", 150_000),
    contender("s2", "bravo", 200_000),
    contender("s3", "charlie", 205_000),
    contender("s4", "delta", 260_000),
  ];

  it("flags a bid far below the median and demands a justification", () => {
    const { median, assessments } = assessAbnormalPricing(pkg, field);
    expect(median).toBe(202_500);
    const low = assessments.find((a) => a.submissionId === "s1")!;
    expect(low.verdict).toBe("abnormally_low");
    expect(low.requiresJustification).toBe(true);
    expect(low.note).toMatch(/explain the price in writing/i);
  });

  it("clears the low bid once its price explanation is on the record", () => {
    const { assessments } = assessAbnormalPricing(pkg, field, new Set(["s1"]));
    const low = assessments.find((a) => a.submissionId === "s1")!;
    expect(low.verdict).toBe("abnormally_low");
    expect(low.requiresJustification).toBe(false);
  });

  it("flags a bid far above the field as a possible cover price", () => {
    const { assessments } = assessAbnormalPricing(pkg, field);
    const high = assessments.find((a) => a.submissionId === "s4")!;
    expect(high.verdict).toBe("abnormally_high");
    expect(high.note).toMatch(/cover price/i);
  });

  it("leaves the bids in the middle alone", () => {
    const { assessments } = assessAbnormalPricing(pkg, field);
    expect(assessments.find((a) => a.submissionId === "s2")!.verdict).toBe("normal");
    expect(assessments.find((a) => a.submissionId === "s3")!.verdict).toBe("normal");
  });

  it("falls back to the estimate where the field is too small to have a median", () => {
    const { assessments } = assessAbnormalPricing(pkg, [contender("s1", "alpha", 150_000)]);
    expect(assessments[0]!.verdict).toBe("abnormally_low");
    expect(assessments[0]!.note).toMatch(/pre-tender estimate/);
  });

  it("says it could not test where there is neither a field nor an estimate", () => {
    const { assessments } = assessAbnormalPricing(
      { ...pkg, engineersEstimate: null },
      [contender("s1", "alpha", 150_000)],
    );
    expect(assessments[0]!.verdict).toBe("normal");
    expect(assessments[0]!.note).toMatch(/No abnormality test could be applied/);
  });

  it("refuses to compare across currencies", () => {
    const { assessments } = assessAbnormalPricing(pkg, [
      contender("s1", "alpha", 150_000),
      contender("s2", "bravo", 200_000, { currency: "EUR" }),
    ]);
    expect(assessments).toHaveLength(0);
  });
});

/* ================================================================== */
/* 5. Unbalanced bids                                                  */
/* ================================================================== */

describe("unbalanced bids and front-loading", () => {
  const nine = Array.from({ length: 9 }, (_, i) => `L${i}`);
  const contenders = [
    contender("s1", "alpha", 200_000),
    contender("s2", "bravo", 200_000),
    contender("s3", "charlie", 200_000),
  ];

  function buildLines(front: number[]): RateFacts[] {
    const lines: RateFacts[] = [];
    nine.forEach((key, i) => {
      lines.push(rate("s2", "bravo", key, i, 100));
      lines.push(rate("s3", "charlie", key, i, 100));
      lines.push(rate("s1", "alpha", key, i, front[i] ?? 100));
    });
    return lines;
  }

  it("flags early rates at 3x the median with late rates starved", () => {
    const lines = buildLines([300, 300, 300, 100, 100, 100, 40, 40, 40]);
    const result = assessUnbalancedBids(pkg, contenders, lines);
    const alpha = result.find((r) => r.submissionId === "s1")!;
    expect(alpha.unbalanced).toBe(true);
    expect(alpha.frontLoadedLines).toBe(3);
    expect(alpha.starvedLines).toBe(3);
    expect(alpha.frontLoadingShiftPercent).not.toBeNull();
    expect(alpha.frontLoadingShiftPercent!).toBeGreaterThan(10);
    expect(alpha.note).toMatch(/paid most of its money before it has done most of its work/i);
  });

  it("leaves a bidder who simply prices higher throughout alone", () => {
    const lines = buildLines([130, 130, 130, 130, 130, 130, 130, 130, 130]);
    const result = assessUnbalancedBids(pkg, contenders, lines);
    expect(result.find((r) => r.submissionId === "s1")!.unbalanced).toBe(false);
  });

  it("says so where a bidder priced none of the comparable rows", () => {
    // Three bidders price every row (so each row has a median); the fourth
    // priced none of them and therefore cannot be tested for balance.
    const withDelta = [...contenders, contender("s4", "delta", 205_000)];
    const lines: RateFacts[] = [];
    nine.forEach((key, i) => {
      lines.push(rate("s1", "alpha", key, i, 100));
      lines.push(rate("s2", "bravo", key, i, 110));
      lines.push(rate("s3", "charlie", key, i, 95));
    });
    const result = assessUnbalancedBids(pkg, withDelta, lines);
    const delta = result.find((r) => r.submissionId === "s4")!;
    expect(delta.comparedLines).toBe(0);
    expect(delta.unbalanced).toBe(false);
    expect(delta.note).toMatch(/did not price the rows the others did/i);
  });

  it("declines to run on a bill too short to have a first and last third", () => {
    const lines: RateFacts[] = [];
    ["A", "B", "C"].forEach((key, i) => {
      contenders.forEach((c) => lines.push(rate(c.submissionId, c.vendorId, key, i, 100)));
    });
    expect(assessUnbalancedBids(pkg, contenders, lines)).toHaveLength(0);
  });
});

/* ================================================================== */
/* 6. Cross-package patterns                                           */
/* ================================================================== */

const names = new Map([
  ["alpha", "Alpha Groundworks"],
  ["bravo", "Bravo Civils"],
  ["charlie", "Charlie Piling"],
  ["delta", "Delta Excavation"],
]);

function historyRow(
  id: string,
  winner: string,
  bidders: string[],
  over: Partial<PackageHistoryFacts> = {},
): PackageHistoryFacts {
  return {
    packageId: id,
    reference: id.toUpperCase(),
    tradeCode: "GROUNDWORKS",
    awardedAt: `2026-0${id.slice(-1)}-01T00:00:00.000Z`,
    winnerVendorId: winner,
    bidderVendorIds: bidders,
    invitedVendorIds: bidders,
    withdrawnVendorIds: [],
    winnerWasLate: false,
    winnerSubmissionId: `${id}-sub`,
    ...over,
  };
}

describe("cover bidding (Domain A #12)", () => {
  it("flags a bidder who loses to the same winner every time and never wins", () => {
    const history = [
      historyRow("p1", "alpha", ["alpha", "bravo", "charlie"]),
      historyRow("p2", "alpha", ["alpha", "bravo", "charlie"]),
      historyRow("p3", "alpha", ["alpha", "bravo", "delta"]),
    ];
    const findings = detectCoverBidding(history, names);
    const bravo = findings.find((f) => f.subjectId === "bravo");
    expect(bravo).toBeDefined();
    expect(bravo!.detector).toBe("bid_integrity_cover_bidding");
    expect(bravo!.statistic["losses"]).toBe(3);
    expect(bravo!.explanation).toMatch(/shared directors|shared|address|bank account/i);
  });

  it("does not flag a bidder who also wins", () => {
    const history = [
      historyRow("p1", "alpha", ["alpha", "bravo", "charlie"]),
      historyRow("p2", "alpha", ["alpha", "bravo", "charlie"]),
      historyRow("p3", "bravo", ["alpha", "bravo", "charlie"]),
    ];
    expect(detectCoverBidding(history, names).some((f) => f.subjectId === "bravo")).toBe(false);
  });

  it("needs at least three packages in the trade", () => {
    const history = [
      historyRow("p1", "alpha", ["alpha", "bravo"]),
      historyRow("p2", "alpha", ["alpha", "bravo"]),
    ];
    expect(detectCoverBidding(history, names)).toHaveLength(0);
  });
});

describe("winner rotation (Domain A #14)", () => {
  it("flags a perfect rota between three bidders", () => {
    const history = [
      historyRow("p1", "alpha", ["alpha", "bravo", "charlie"]),
      historyRow("p2", "bravo", ["alpha", "bravo", "charlie"]),
      historyRow("p3", "charlie", ["alpha", "bravo", "charlie"]),
      historyRow("p4", "alpha", ["alpha", "bravo", "charlie"]),
      historyRow("p5", "bravo", ["alpha", "bravo", "charlie"]),
      historyRow("p6", "charlie", ["alpha", "bravo", "charlie"]),
    ];
    const findings = detectWinnerRotation(history, names);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detector).toBe("bid_integrity_winner_rotation");
    expect(findings[0]!.statistic["alternationRate"]).toBe(1);
    expect(findings[0]!.statistic["normalisedEntropy"]).toBe(1);
  });

  it("leaves an ordinary lumpy run of wins alone", () => {
    const history = [
      historyRow("p1", "alpha", ["alpha", "bravo", "charlie"]),
      historyRow("p2", "alpha", ["alpha", "bravo", "charlie"]),
      historyRow("p3", "alpha", ["alpha", "bravo", "charlie"]),
      historyRow("p4", "bravo", ["alpha", "bravo", "charlie"]),
      historyRow("p5", "alpha", ["alpha", "bravo", "charlie"]),
      historyRow("p6", "charlie", ["alpha", "bravo", "charlie"]),
    ];
    expect(detectWinnerRotation(history, names)).toHaveLength(0);
  });
});

describe("repeat invitation sets, withdrawals and late wins", () => {
  it("flags the same three bidders invited to three packages", () => {
    const set = ["alpha", "bravo", "charlie"];
    const history = [
      historyRow("p1", "alpha", set),
      historyRow("p2", "bravo", set),
      historyRow("p3", "charlie", set),
    ];
    const findings = detectRepeatInvitationSets(history, names);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.statistic["packages"]).toBe(3);
    // The innocent explanation is stated, not implied.
    expect(findings[0]!.explanation).toMatch(/simply the shortlist of firms who are any good/i);
  });

  it("does not flag varied invitation lists", () => {
    const history = [
      historyRow("p1", "alpha", ["alpha", "bravo", "charlie"]),
      historyRow("p2", "bravo", ["alpha", "bravo", "delta"]),
      historyRow("p3", "charlie", ["bravo", "charlie", "delta"]),
    ];
    expect(detectRepeatInvitationSets(history, names)).toHaveLength(0);
  });

  it("flags a bidder who repeatedly commits and then withdraws", () => {
    const history = [
      historyRow("p1", "alpha", ["alpha"], { withdrawnVendorIds: ["bravo"] }),
      historyRow("p2", "alpha", ["alpha"], { withdrawnVendorIds: ["bravo"] }),
      historyRow("p3", "alpha", ["alpha"], { withdrawnVendorIds: ["bravo"] }),
    ];
    const findings = detectWithdrawalPatterns(history, names);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.subjectId).toBe("bravo");
    expect(findings[0]!.statistic["withdrawals"]).toBe(3);
  });

  it("flags a late bid that won", () => {
    const findings = detectLateSubmissionWins(
      [historyRow("p1", "alpha", ["alpha", "bravo"], { winnerWasLate: true })],
      names,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.explanation).toMatch(/knowledge nobody else had/i);
  });

  it("does not flag an on-time win", () => {
    expect(
      detectLateSubmissionWins([historyRow("p1", "alpha", ["alpha", "bravo"])], names),
    ).toHaveLength(0);
  });
});

/* ================================================================== */
/* 7. Approval behaviour                                               */
/* ================================================================== */

describe("approval behaviour (Domain A #37, #38)", () => {
  const base = {
    awardId: "bwd_1",
    reference: "AWD-0001",
    packageId: "bpk_1",
    projectId: "prj_1",
    vendorId: "alpha",
    awardAmount: 500_000,
    currency: "GBP",
    approvedBy: "usr_2",
  };

  it("flags an approval four minutes after the recommendation", () => {
    const findings = detectApprovalBehaviour({
      ...base,
      recommendedAt: "2026-03-02T10:00:00.000Z",
      approvedAt: "2026-03-02T10:04:00.000Z",
    });
    const velocity = findings.find((f) => f.detector === "bid_integrity_approval_velocity");
    expect(velocity).toBeDefined();
    expect(velocity!.statistic["minutesBetween"]).toBe(4);
  });

  it("does not flag an approval the next working day", () => {
    const findings = detectApprovalBehaviour({
      ...base,
      recommendedAt: "2026-03-02T10:00:00.000Z",
      approvedAt: "2026-03-03T10:00:00.000Z",
    });
    expect(findings.some((f) => f.detector === "bid_integrity_approval_velocity")).toBe(false);
  });

  it("flags an approval signed at 03:40", () => {
    const findings = detectApprovalBehaviour({
      ...base,
      recommendedAt: "2026-03-01T10:00:00.000Z",
      approvedAt: "2026-03-02T03:40:00.000Z",
    });
    expect(findings.some((f) => f.detector === "bid_integrity_out_of_hours_approval")).toBe(true);
  });

  it("says nothing about an ordinary weekday approval in working hours", () => {
    // 2026-03-02 is a Monday.
    const findings = detectApprovalBehaviour({
      ...base,
      recommendedAt: "2026-02-27T10:00:00.000Z",
      approvedAt: "2026-03-02T11:00:00.000Z",
    });
    expect(findings).toHaveLength(0);
  });
});

/* ================================================================== */
/* 8. The whole-package run                                            */
/* ================================================================== */

describe("runPackageIntegrity", () => {
  it("reports what could not be run instead of silently finding nothing", () => {
    const result = runPackageIntegrity(pkg, [contender("s1", "alpha", 200_000)], []);
    expect(result.findings).toHaveLength(0);
    expect(result.notRun.map((n) => n.reason).join(" ")).toMatch(/fewer than three/i);
    expect(result.notRun.map((n) => n.reason).join(" ")).toMatch(/no unit rate|unit rate/i);
  });

  it("finds nothing on an honest, well-dispersed tender with independent rates", () => {
    const contenders = [
      contender("s1", "alpha", 186_000),
      contender("s2", "bravo", 204_000, { receivedAt: "2026-02-28T10:00:00.000Z" }),
      contender("s3", "charlie", 221_000, { receivedAt: "2026-02-26T15:00:00.000Z" }),
    ];
    const lines: RateFacts[] = [];
    const rates: Record<string, number[]> = {
      s1: [98, 51, 210, 33, 77, 142, 19, 64, 88],
      s2: [112, 46, 233, 37, 71, 158, 22, 59, 96],
      s3: [104, 57, 198, 41, 84, 133, 25, 71, 79],
    };
    Array.from({ length: 9 }, (_, i) => i).forEach((i) => {
      contenders.forEach((c) =>
        lines.push(
          rate(c.submissionId, c.vendorId, `L${i}`, i, rates[c.submissionId]?.[i] ?? 100),
        ),
      );
    });
    const result = runPackageIntegrity(pkg, contenders, lines);
    expect(result.findings).toHaveLength(0);
    expect(result.notRun).toHaveLength(0);
    expect(result.dispersion.n).toBe(3);
  });

  it("finds the planted scheme end to end", () => {
    const contenders = [
      contender("s1", "alpha", 200_000, { receivedAt: "2026-03-01T16:55:00.000Z" }),
      contender("s2", "bravo", 202_500, { receivedAt: "2026-03-01T16:58:00.000Z" }),
      contender("s3", "charlie", 204_000, { receivedAt: "2026-03-01T17:00:00.000Z" }),
    ];
    const lines: RateFacts[] = [];
    const shared = [98, 51, 210, 33, 77, 142, 19, 64, 88];
    shared.forEach((r, i) => {
      lines.push(rate("s1", "alpha", `L${i}`, i, r));
      lines.push(rate("s2", "bravo", `L${i}`, i, r));
      lines.push(rate("s3", "charlie", `L${i}`, i, Number((r * 1.05).toFixed(4))));
    });
    const result = runPackageIntegrity(pkg, contenders, lines);
    const detectors = result.findings.map((f) => f.detector);
    expect(detectors).toContain("bid_integrity_price_clustering");
    expect(detectors).toContain("bid_integrity_identical_rates");
    expect(detectors).toContain("bid_integrity_constant_ratio");
    expect(detectors).toContain("bid_integrity_submission_clustering");
    // Every finding is identified deterministically so a re-run raises nothing.
    const keys = result.findings.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    const again = runPackageIntegrity(pkg, contenders, lines);
    expect(again.findings.map((f) => f.key).sort()).toEqual(keys.sort());
  });
});

describe("runCompanyIntegrity", () => {
  it("runs every cross-package detector and finds nothing on a healthy history", () => {
    const history = [
      historyRow("p1", "alpha", ["alpha", "bravo"], { invitedVendorIds: ["alpha", "bravo"] }),
      historyRow("p2", "bravo", ["bravo", "charlie"], { invitedVendorIds: ["bravo", "charlie"] }),
      historyRow("p3", "charlie", ["charlie", "delta"], { invitedVendorIds: ["charlie", "delta"] }),
    ];
    expect(runCompanyIntegrity(history, names)).toHaveLength(0);
  });
});

/* ================================================================== */
/* A LABELLED CORPUS — measured precision and recall per detector      */
/* ================================================================== */

/**
 * THE DETECTORS ARE MEASURED AGAINST GROUND TRUTH, NOT AGAINST OPINION.
 *
 * The live register reports each detector's precision from what reviewers
 * dispositioned (`GET /companies/current/bid-integrity/precision`). That
 * measures REVIEWER behaviour, which is worth knowing and is not the same
 * question as "is this detector any good": a company that dismisses
 * everything drives every detector to zero, and a company that confirms
 * everything drives every detector to one.
 *
 * This is the other measurement. Each fixture below is a package whose truth
 * is known because it was constructed: `schemes` names the pattern that was
 * planted in it, and a clean package names none. Precision is then
 *
 *     TP / (TP + FP)  over the corpus, per detector
 *
 * where a firing is a true positive only on a package labelled with that
 * scheme. A threshold change that starts firing the clustering detector on
 * an honest 8%-spread field, or that stops it firing on a 0.3% cluster,
 * fails here — which is the point: it is a test that a tuning change cannot
 * quietly pass.
 *
 * The corpus is deliberately small and deliberately explicit. A fixture whose
 * label is arguable is worse than no fixture, so every package here is one
 * a quantity surveyor would label the same way without hesitating.
 */
interface LabelledPackage {
  name: string;
  /** the patterns actually planted — empty means an honest tender */
  schemes: string[];
  facts: PackageFacts;
  contenders: ContenderFacts[];
  lines: RateFacts[];
}

/** Rates that differ item by item, as two independent estimators' rates do. */
function independentRates(
  submissionId: string,
  vendorId: string,
  rates: readonly number[],
): RateFacts[] {
  return rates.map((r, i) => rate(submissionId, vendorId, `I${i + 1}`, i + 1, r));
}

const day = (n: number, hour = 9, minute = 0) =>
  `2026-03-${String(n).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;

const facts = (packageId: string, estimate: number | null = null): PackageFacts => ({
  packageId,
  reference: packageId.toUpperCase(),
  title: "Corpus package",
  currency: "GBP",
  engineersEstimate: estimate,
  tradeCode: "GROUNDWORKS",
  comparisonBasis: "levelled",
});

const CORPUS: LabelledPackage[] = [
  /* ---------------- planted: complementary bidding ---------------- */
  {
    name: "rigged: three totals inside 0.4% of each other",
    schemes: ["bid_integrity_price_clustering"],
    facts: facts("rig1"),
    contenders: [
      contender("r1a", "v1", 300_000, { receivedAt: day(2, 9) }),
      contender("r1b", "v2", 301_200, { receivedAt: day(4, 11) }),
      contender("r1c", "v3", 302_100, { receivedAt: day(6, 15) }),
    ],
    lines: [],
  },
  /* ---------------- planted: one priced document, shared ---------- */
  {
    name: "rigged: two bidders quoting the same rates across the bill",
    schemes: ["bid_integrity_identical_rates"],
    facts: facts("rig2"),
    contenders: [
      contender("r2a", "v1", 210_000, { receivedAt: day(2, 9) }),
      contender("r2b", "v2", 244_000, { receivedAt: day(5, 16) }),
    ],
    lines: [
      ...independentRates("r2a", "v1", [40, 55, 70, 85, 100, 120]),
      // Four of the six rates are identical to the cent.
      ...independentRates("r2b", "v2", [40, 55, 70, 85, 133, 151]),
    ],
  },
  /* ---------------- planted: a cover price with a margin ---------- */
  {
    name: "rigged: one bill priced, the other the same bill times 1.12",
    schemes: ["bid_integrity_constant_ratio"],
    facts: facts("rig3"),
    contenders: [
      contender("r3a", "v1", 220_000, { receivedAt: day(3, 10) }),
      contender("r3b", "v2", 246_400, { receivedAt: day(7, 14) }),
    ],
    lines: [
      ...independentRates("r3a", "v1", [40, 57, 73, 88, 104, 121]),
      ...independentRates(
        "r3b",
        "v2",
        [40, 57, 73, 88, 104, 121].map((r) => Math.round(r * 1.12 * 100) / 100),
      ),
    ],
  },
  /* ---------------- planted: one person sent them all ------------- */
  {
    name: "rigged: three bids inside four minutes at the end of a six-week tender",
    schemes: ["bid_integrity_submission_clustering"],
    facts: facts("rig4"),
    contenders: [
      contender("r4a", "v1", 180_000, { receivedAt: day(9, 16, 2) }),
      contender("r4b", "v2", 205_000, { receivedAt: day(9, 16, 4) }),
      contender("r4c", "v3", 231_000, { receivedAt: day(9, 16, 6) }),
    ],
    lines: [],
  },
  /* ---------------- honest tenders -------------------------------- */
  {
    name: "clean: four independent bids spread 9% about the median",
    schemes: [],
    facts: facts("cln1"),
    contenders: [
      contender("c1a", "v1", 200_000, { receivedAt: day(2, 9) }),
      contender("c1b", "v2", 214_000, { receivedAt: day(4, 14) }),
      contender("c1c", "v3", 228_000, { receivedAt: day(6, 10) }),
      contender("c1d", "v4", 243_000, { receivedAt: day(8, 17) }),
    ],
    lines: [],
  },
  {
    name: "clean: three bidders whose rates differ item by item",
    schemes: [],
    facts: facts("cln2"),
    contenders: [
      contender("c2a", "v1", 150_000, { receivedAt: day(3, 9) }),
      contender("c2b", "v2", 163_000, { receivedAt: day(5, 13) }),
      contender("c2c", "v3", 177_000, { receivedAt: day(7, 11) }),
    ],
    lines: [
      ...independentRates("c2a", "v1", [40, 57, 73, 88, 104, 121]),
      ...independentRates("c2b", "v2", [44, 55, 79, 84, 113, 118]),
      ...independentRates("c2c", "v3", [37, 61, 70, 95, 99, 130]),
    ],
  },
  {
    name: "clean: a couple of coincidental round rates on a six-line bill",
    schemes: [],
    facts: facts("cln3"),
    contenders: [
      contender("c3a", "v1", 190_000, { receivedAt: day(2, 10) }),
      contender("c3b", "v2", 208_000, { receivedAt: day(6, 15) }),
    ],
    lines: [
      // Two of six rates coincide — the round numbers a common supplier sets.
      ...independentRates("c3a", "v1", [50, 100, 73, 88, 104, 121]),
      ...independentRates("c3b", "v2", [50, 100, 81, 79, 117, 133]),
    ],
  },
  {
    name: "clean: two bidders — a quotation, not a market",
    schemes: [],
    facts: facts("cln4"),
    contenders: [
      contender("c4a", "v1", 120_000, { receivedAt: day(4, 9) }),
      contender("c4b", "v2", 121_000, { receivedAt: day(9, 16) }),
    ],
    lines: [],
  },
];

describe("detector precision against a labelled corpus", () => {
  const fired = new Map<string, { tp: number; fp: number; packages: string[] }>();
  const missed: string[] = [];

  for (const item of CORPUS) {
    const result = runPackageIntegrity(item.facts, item.contenders, item.lines);
    const detectors = new Set(result.findings.map((f) => f.detector));
    for (const detector of detectors) {
      const row = fired.get(detector) ?? { tp: 0, fp: 0, packages: [] };
      if (item.schemes.includes(detector)) row.tp += 1;
      else {
        row.fp += 1;
        row.packages.push(item.name);
      }
      fired.set(detector, row);
    }
    for (const scheme of item.schemes) {
      if (!detectors.has(scheme)) missed.push(`${item.name} → ${scheme}`);
    }
  }

  it("fires on every planted scheme — recall is 1.00 across the corpus", () => {
    expect(missed).toEqual([]);
  });

  it("fires on nothing else — precision is 1.00 across the corpus", () => {
    const falsePositives = [...fired.entries()]
      .filter(([, v]) => v.fp > 0)
      .map(([detector, v]) => `${detector} on ${v.packages.join(", ")}`);
    expect(falsePositives).toEqual([]);
  });

  it("leaves an honest tender with a completely empty register", () => {
    for (const item of CORPUS.filter((c) => c.schemes.length === 0)) {
      const result = runPackageIntegrity(item.facts, item.contenders, item.lines);
      expect({ name: item.name, findings: result.findings.map((f) => f.detector) }).toEqual({
        name: item.name,
        findings: [],
      });
    }
  });

  it("reports a measured precision of 1.00 per detector, from counts rather than opinion", () => {
    const measured = [...fired.entries()]
      .map(([detector, v]) => ({
        detector,
        tp: v.tp,
        fp: v.fp,
        precision: v.tp / (v.tp + v.fp),
      }))
      .sort((a, b) => a.detector.localeCompare(b.detector));
    // Every planted scheme is represented, and nothing else fired at all.
    expect(measured.map((m) => m.detector)).toEqual([
      "bid_integrity_constant_ratio",
      "bid_integrity_identical_rates",
      "bid_integrity_price_clustering",
      "bid_integrity_submission_clustering",
    ]);
    for (const m of measured) expect(m.precision).toBe(1);
  });

  it("says which detectors could not run rather than reporting a clean package", () => {
    const twoBidders = CORPUS.find((c) => c.facts.packageId === "cln4")!;
    const result = runPackageIntegrity(
      twoBidders.facts,
      twoBidders.contenders,
      twoBidders.lines,
    );
    expect(result.findings).toEqual([]);
    // Two bids are a quotation, not a market: the dispersion detectors are
    // NOT reported as having found nothing.
    expect(result.notRun.map((n) => n.detector)).toContain("bid_integrity_price_clustering");
  });
});
