import { describe, expect, it } from "vitest";
import {
  buildComparison,
  derivePriceScores,
  levelEntry,
  levelSubmission,
  rankByScore,
  scoreSubmission,
  type ComparisonSubmissionFacts,
  type CriterionDef,
  type LevellingEntryFacts,
  type LevellingItemFacts,
} from "./levelling-math.js";
import { known, unknowable } from "./shared.js";

/* ------------------------------------------------------------------ */
/* A hand-worked package                                               */
/*                                                                     */
/* Four neutral scope rows and two bidders. The whole point of the      */
/* worked example: bidder B looks GBP 54,000 cheaper as bid and is      */
/* GBP 8,000 more expensive once the scaffold they excluded is priced.  */
/* ------------------------------------------------------------------ */

const items: LevellingItemFacts[] = [
  {
    id: "i1",
    itemCode: "A10",
    description: "Groundworks",
    category: "base_scope",
    isMandatory: true,
    engineersEstimate: 100_000,
    currency: "GBP",
  },
  {
    id: "i2",
    itemCode: "A20",
    description: "Scaffold",
    category: "base_scope",
    isMandatory: true,
    engineersEstimate: 55_000,
    currency: "GBP",
  },
  {
    id: "i3",
    itemCode: "A30",
    description: "Drainage provisional sum",
    category: "provisional_sum",
    isMandatory: true,
    engineersEstimate: 20_000,
    currency: "GBP",
  },
  {
    id: "i4",
    itemCode: "X10",
    description: "Temporary works design — in or out?",
    category: "exclusion_check",
    isMandatory: true,
    engineersEstimate: null,
    currency: "GBP",
  },
];

const entry = (over: Partial<LevellingEntryFacts> & { levellingItemId: string; submissionId: string }): LevellingEntryFacts => ({
  includedStatus: "included",
  asBidAmount: null,
  adjustmentAmount: 0,
  adjustmentReason: null,
  currency: "GBP",
  ...over,
});

/** Bidder A prices everything as asked: 100,000 + 50,000 + 20,000 = 170,000 */
const bidderA: LevellingEntryFacts[] = [
  entry({ levellingItemId: "i1", submissionId: "sA", asBidAmount: 100_000 }),
  entry({ levellingItemId: "i2", submissionId: "sA", asBidAmount: 50_000 }),
  entry({ levellingItemId: "i3", submissionId: "sA", asBidAmount: 20_000 }),
  entry({ levellingItemId: "i4", submissionId: "sA", includedStatus: "included" }),
];

/** Bidder B excludes the scaffold; buying it elsewhere costs 62,000 */
const bidderB: LevellingEntryFacts[] = [
  entry({ levellingItemId: "i1", submissionId: "sB", asBidAmount: 95_000 }),
  entry({
    levellingItemId: "i2",
    submissionId: "sB",
    includedStatus: "excluded",
    asBidAmount: null,
    adjustmentAmount: 62_000,
    adjustmentReason: "scope_gap",
  }),
  entry({ levellingItemId: "i3", submissionId: "sB", asBidAmount: 21_000 }),
  entry({ levellingItemId: "i4", submissionId: "sB", includedStatus: "excluded" }),
];

const facts: ComparisonSubmissionFacts[] = [
  {
    id: "sA",
    vendorId: "vA",
    reference: "BP-0001-A",
    status: "opened",
    currency: "GBP",
    totalAmount: 170_000,
    inContention: true,
  },
  {
    id: "sB",
    vendorId: "vB",
    reference: "BP-0001-B",
    status: "opened",
    currency: "GBP",
    totalAmount: 116_000,
    inContention: true,
  },
];

describe("levelEntry — the rule table", () => {
  it("levels an included line as as-bid plus adjustment", () => {
    const cell = levelEntry(
      items[0]!,
      entry({
        levellingItemId: "i1",
        submissionId: "sA",
        asBidAmount: 100_000,
        adjustmentAmount: 2_500,
        adjustmentReason: "quantity_correction",
      }),
    );
    expect(cell.levelledAmount).toBe(102_500);
    expect(cell.covered).toBe(true);
    expect(cell.reasons).toEqual([]);
  });

  it('refuses a figure for "included" with no amount — a claim is not a price', () => {
    const cell = levelEntry(
      items[0]!,
      entry({ levellingItemId: "i1", submissionId: "sA", asBidAmount: null }),
    );
    expect(cell.levelledAmount).toBeNull();
    expect(cell.covered).toBe(false);
    expect(cell.reasons[0]).toMatch(/included but carries no amount/i);
  });

  it("levels an exclusion at the cost of buying the scope elsewhere", () => {
    const cell = levelEntry(items[1]!, bidderB[1]!);
    expect(cell.levelledAmount).toBe(62_000);
    expect(cell.covered).toBe(true);
  });

  it("refuses to treat an exclusion with no adjustment as free", () => {
    const cell = levelEntry(
      items[1]!,
      entry({ levellingItemId: "i2", submissionId: "sB", includedStatus: "excluded" }),
    );
    expect(cell.levelledAmount).toBeNull();
    expect(cell.covered).toBe(false);
    expect(cell.reasons[0]).toMatch(/excluded the most becomes.*cheapest|treat the missing scope as free/i);
  });

  it("refuses an adjustment that carries no stated reason", () => {
    const cell = levelEntry(
      items[0]!,
      entry({
        levellingItemId: "i1",
        submissionId: "sA",
        asBidAmount: 100_000,
        adjustmentAmount: -9_000,
        adjustmentReason: null,
      }),
    );
    expect(cell.levelledAmount).toBeNull();
    expect(cell.reasons[0]).toMatch(/no stated reason/i);
  });

  it("refuses a partial inclusion left at its face value", () => {
    const cell = levelEntry(
      items[0]!,
      entry({
        levellingItemId: "i1",
        submissionId: "sA",
        includedStatus: "partially_included",
        asBidAmount: 80_000,
      }),
    );
    expect(cell.levelledAmount).toBeNull();
    expect(cell.reasons[0]).toMatch(/partially included but carries no adjustment/i);
  });

  it("levels a partial inclusion once the missing part is priced", () => {
    const cell = levelEntry(
      items[0]!,
      entry({
        levellingItemId: "i1",
        submissionId: "sA",
        includedStatus: "partially_included",
        asBidAmount: 80_000,
        adjustmentAmount: 25_000,
        adjustmentReason: "scope_gap",
      }),
    );
    expect(cell.levelledAmount).toBe(105_000);
  });

  it("produces no figure for unclear or unpriced answers", () => {
    for (const status of ["unclear", "not_priced"] as const) {
      const cell = levelEntry(
        items[0]!,
        entry({ levellingItemId: "i1", submissionId: "sA", includedStatus: status, asBidAmount: 100_000 }),
      );
      expect(cell.levelledAmount).toBeNull();
      expect(cell.covered).toBe(false);
      expect(cell.reasons.length).toBeGreaterThan(0);
    }
  });

  it("treats an exclusion_check row as answered, never as money", () => {
    const inRow = levelEntry(items[3]!, bidderA[3]!);
    expect(inRow.priceable).toBe(false);
    expect(inRow.levelledAmount).toBeNull();
    expect(inRow.covered).toBe(true);

    const vague = levelEntry(
      items[3]!,
      entry({ levellingItemId: "i4", submissionId: "sB", includedStatus: "unclear" }),
    );
    expect(vague.covered).toBe(false);
    expect(vague.reasons[0]).toMatch(/in-or-out check/i);
  });

  it("refuses an exclusion that nonetheless carries an as-bid amount", () => {
    const cell = levelEntry(
      items[1]!,
      entry({
        levellingItemId: "i2",
        submissionId: "sB",
        includedStatus: "excluded",
        asBidAmount: 50_000,
        adjustmentAmount: 1_000,
        adjustmentReason: "scope_gap",
      }),
    );
    expect(cell.levelledAmount).toBeNull();
    expect(cell.reasons[0]).toMatch(/excluded yet carries an as-bid amount/i);
  });
});

describe("levelSubmission — hand-worked totals", () => {
  it("totals bidder A at 170,000", () => {
    const levelled = levelSubmission("sA", items, bidderA);
    expect(levelled.levelledTotal.value).toBe(170_000);
    expect(levelled.pricedSubtotal.value).toBe(170_000);
    expect(levelled.asBidSubtotal.value).toBe(170_000);
    expect(levelled.adjustmentSubtotal.value).toBe(0);
    expect(levelled.gaps).toEqual([]);
    expect(levelled.itemsCovered).toBe(3);
    expect(levelled.itemsTotal).toBe(3);
    expect(levelled.mandatoryCovered).toBe(4);
  });

  it("totals bidder B at 178,000 — 8,000 MORE than A despite bidding 54,000 less", () => {
    const levelled = levelSubmission("sB", items, bidderB);
    expect(levelled.levelledTotal.value).toBe(178_000);
    expect(levelled.asBidSubtotal.value).toBe(116_000);
    expect(levelled.adjustmentSubtotal.value).toBe(62_000);
    // as-bid B (116,000) is 54,000 below as-bid A (170,000); levelled B is above it
    expect(levelled.levelledTotal.value!).toBeGreaterThan(170_000);
  });

  it("treats a missing entry exactly as not_priced — silence is not agreement", () => {
    const partial = bidderB.filter((e) => e.levellingItemId !== "i3");
    const levelled = levelSubmission("sB", items, partial);
    expect(levelled.levelledTotal.value).toBeNull();
    expect(levelled.gaps.map((g) => g.itemCode)).toContain("A30");
    // the partial figure is still available, explicitly labelled
    expect(levelled.pricedSubtotal.value).toBe(157_000);
  });

  it("refuses to sum across currencies", () => {
    const mixed = [
      entry({ levellingItemId: "i1", submissionId: "sC", asBidAmount: 100_000, currency: "GBP" }),
      entry({ levellingItemId: "i2", submissionId: "sC", asBidAmount: 50_000, currency: "USD" }),
      entry({ levellingItemId: "i3", submissionId: "sC", asBidAmount: 20_000, currency: "GBP" }),
      entry({ levellingItemId: "i4", submissionId: "sC" }),
    ];
    const levelled = levelSubmission("sC", items, mixed);
    expect(levelled.currency).toBeNull();
    expect(levelled.levelledTotal.value).toBeNull();
    expect(levelled.pricedSubtotal.value).toBeNull();
    expect(levelled.levelledTotal.reasons.join(" ")).toMatch(/GBP, USD/);
  });
});

describe("buildComparison — the grid, coverage and completeness", () => {
  it("ranks on the levelled amount, not the as-bid amount", () => {
    const comparison = buildComparison(items, [...bidderA, ...bidderB], facts);
    expect(comparison.complete).toBe(true);
    expect(comparison.ranking).toEqual([
      { submissionId: "sA", levelledAmount: 170_000, rank: 1 },
      { submissionId: "sB", levelledAmount: 178_000, rank: 2 },
    ]);
  });

  it("reports coverage per scope row", () => {
    const partial = bidderB.filter((e) => e.levellingItemId !== "i3");
    const comparison = buildComparison(items, [...bidderA, ...partial], facts);
    const drainage = comparison.coverage.find((c) => c.itemCode === "A30")!;
    expect(drainage.coveredBy).toEqual(["sA"]);
    expect(drainage.missingFrom).toEqual(["sB"]);
  });

  it("refuses completeness while a contender has an unpriced mandatory row, naming both", () => {
    const partial = bidderB.filter((e) => e.levellingItemId !== "i3");
    const comparison = buildComparison(items, [...bidderA, ...partial], facts);
    expect(comparison.complete).toBe(false);
    expect(comparison.ranking).toBeNull();
    expect(comparison.blockers.join(" ")).toContain("BP-0001-B");
    expect(comparison.blockers.join(" ")).toContain("A30");
  });

  it("stops blocking once the gapped bidder is out of contention", () => {
    const partial = bidderB.filter((e) => e.levellingItemId !== "i3");
    const out = facts.map((f) => (f.id === "sB" ? { ...f, status: "unsuccessful", inContention: false } : f));
    const comparison = buildComparison(items, [...bidderA, ...partial], out);
    expect(comparison.complete).toBe(true);
    expect(comparison.ranking).toEqual([{ submissionId: "sA", levelledAmount: 170_000, rank: 1 }]);
  });

  it("refuses to rank bids priced in different currencies", () => {
    const mixed = facts.map((f) => (f.id === "sB" ? { ...f, currency: "USD" } : f));
    const comparison = buildComparison(items, [...bidderA, ...bidderB], mixed);
    expect(comparison.complete).toBe(false);
    expect(comparison.blockers.join(" ")).toMatch(/never ranked against each other/i);
  });

  it("refuses completeness when no scope rows have been defined at all", () => {
    const comparison = buildComparison([], [], facts);
    expect(comparison.complete).toBe(false);
    expect(comparison.blockers[0]).toMatch(/No levelling items/i);
  });
});

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

const criteria: CriterionDef[] = [
  { key: "method", label: "Method statement", weight: 60, kind: "quality" },
  { key: "programme", label: "Programme", weight: 40, kind: "quality" },
];

describe("derivePriceScores", () => {
  it("gives the lowest bid 100 and scores the rest proportionally", () => {
    const scores = derivePriceScores([
      { submissionId: "sA", amount: 170_000 },
      { submissionId: "sB", amount: 178_000 },
    ]);
    expect(scores.get("sA")!.value).toBe(100);
    // 170000 / 178000 * 100 = 95.5056...
    expect(scores.get("sB")!.value).toBe(95.51);
  });

  it("gives no price score at all to a bid with no comparable amount", () => {
    const scores = derivePriceScores([
      { submissionId: "sA", amount: 170_000 },
      { submissionId: "sB", amount: null },
    ]);
    expect(scores.get("sB")!.value).toBeNull();
    expect(scores.get("sB")!.reasons[0]).toMatch(/no comparable \(levelled\) amount/i);
  });
});

describe("scoreSubmission — an unscored criterion is never a zero", () => {
  it("computes the weighted total from a full set of scores", () => {
    const result = scoreSubmission({
      criteria,
      scores: [
        { key: "method", score: 8, maxScore: 10 },
        { key: "programme", score: 6, maxScore: 10 },
      ],
      priceWeight: 60,
      qualityWeight: 40,
      priceScore: known(100),
    });
    // quality = (0.8*60 + 0.6*40)/100 * 100 = 72
    expect(result.technicalScore.value).toBe(72);
    expect(result.commercialScore.value).toBe(100);
    // total = (100*60 + 72*40) / 100 = 88.8
    expect(result.totalScore.value).toBe(88.8);
  });

  it("returns NULL with the criterion named when one is unscored", () => {
    const result = scoreSubmission({
      criteria,
      scores: [{ key: "method", score: 9, maxScore: 10 }],
      priceWeight: 60,
      qualityWeight: 40,
      priceScore: known(95.51),
    });
    expect(result.technicalScore.value).toBeNull();
    expect(result.totalScore.value).toBeNull();
    expect(result.totalScore.reasons.join(" ")).toContain("Programme");
    expect(result.totalScore.reasons.join(" ")).toMatch(/counted as zero decides awards wrongly/i);
    // and the criterion row itself is marked missing rather than weighted 0
    const programme = result.criteria.find((c) => c.key === "programme")!;
    expect(programme.missing).toBe(true);
    expect(programme.weighted).toBeNull();
  });

  it("carries a null price score through to a null total", () => {
    const result = scoreSubmission({
      criteria,
      scores: [
        { key: "method", score: 9, maxScore: 10 },
        { key: "programme", score: 9, maxScore: 10 },
      ],
      priceWeight: 60,
      qualityWeight: 40,
      priceScore: unknowable("This bid has no comparable amount."),
    });
    expect(result.technicalScore.value).toBe(90);
    expect(result.totalScore.value).toBeNull();
    expect(result.totalScore.reasons.join(" ")).toMatch(/no comparable amount/i);
  });

  it("refuses a total where the package declares no weights", () => {
    const result = scoreSubmission({
      criteria,
      scores: [
        { key: "method", score: 9, maxScore: 10 },
        { key: "programme", score: 9, maxScore: 10 },
      ],
      priceWeight: null,
      qualityWeight: null,
      priceScore: known(100),
    });
    expect(result.totalScore.value).toBeNull();
    expect(result.totalScore.reasons.join(" ")).toMatch(/does not declare a price weight/i);
  });

  it("normalises weights that do not sum to 100 and says so", () => {
    const result = scoreSubmission({
      criteria,
      scores: [
        { key: "method", score: 10, maxScore: 10 },
        { key: "programme", score: 10, maxScore: 10 },
      ],
      priceWeight: 30,
      qualityWeight: 30,
      priceScore: known(80),
    });
    expect(result.totalScore.value).toBe(90);
    expect(result.reasons.join(" ")).toMatch(/sum to 60, not 100/i);
  });
});

describe("rankByScore", () => {
  it("ranks the scored and leaves the unscored unranked with reasons", () => {
    const ranked = rankByScore([
      { submissionId: "sA", totalScore: known(88.8) },
      { submissionId: "sB", totalScore: known(93.31) },
      { submissionId: "sC", totalScore: unknowable('Criterion "Programme" has not been scored.') },
    ]);
    expect(ranked.find((r) => r.submissionId === "sB")!.rank).toBe(1);
    expect(ranked.find((r) => r.submissionId === "sA")!.rank).toBe(2);
    const unscored = ranked.find((r) => r.submissionId === "sC")!;
    expect(unscored.rank).toBeNull();
    expect(unscored.totalScore).toBeNull();
    expect(unscored.reasons.join(" ")).toContain("Programme");
  });

  it("gives tied scores the same rank", () => {
    const ranked = rankByScore([
      { submissionId: "a", totalScore: known(80) },
      { submissionId: "b", totalScore: known(80) },
    ]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 1]);
  });
});
