import { describe, expect, it } from "vitest";
import {
  REGIMES,
  addBusinessDays,
  addCalendarDays,
  buildNominationRequest,
  generateTimetable,
  regimeFor,
} from "./regimes.js";
import {
  analyseSettlement,
  evaluateDecisionTree,
  isOfferLive,
  litigationProvision,
  type OfferForAnalysis,
} from "./settlement.js";
import {
  MIN_SAMPLE,
  draftingRecommendations,
  outcomeAnalytics,
  type DisputeOutcomeRow,
} from "./analytics.js";

/* ------------------------------------------------------------------ */
/* Regimes                                                             */
/* ------------------------------------------------------------------ */

describe("adjudication regimes (#322-333)", () => {
  it("carries every jurisdiction the enum names, with an authority per step", () => {
    expect(REGIMES.length).toBe(7);
    for (const r of REGIMES) {
      expect(r.steps.length).toBeGreaterThan(0);
      for (const s of r.steps) {
        expect(s.authority.length).toBeGreaterThan(5);
        expect(s.offsetDays).toBeGreaterThan(0);
      }
      // steps must be in chronological order within their own basis
      const calendar = r.steps.filter((s) => s.basis === "calendar").map((s) => s.offsetDays);
      const business = r.steps.filter((s) => s.basis === "business").map((s) => s.offsetDays);
      for (const series of [calendar, business]) {
        for (let i = 1; i < series.length; i += 1) {
          expect(series[i]!).toBeGreaterThanOrEqual(series[i - 1]!);
        }
      }
    }
  });

  it("returns null for an unknown jurisdiction rather than inventing deadlines", () => {
    expect(regimeFor("atlantis_sopa")).toBeNull();
    expect(generateTimetable("atlantis_sopa", "2026-01-05")).toBeNull();
  });

  it("UK HGCRA: referral 7 days after the notice, decision 35, extendable to 49", () => {
    const t = generateTimetable("uk_hgcra", "2026-03-02")!;
    const referral = t.steps.find((s) => s.key === "referral")!;
    const decision = t.steps.find((s) => s.key === "decision")!;
    expect(referral.dueDate).toBe("2026-03-09");
    expect(decision.dueDate).toBe("2026-04-06");
    expect(decision.extendedDueDate).toBe("2026-04-20");
    expect(t.weekendsOnly).toBe(false); // no business-day steps in this regime
  });

  it("NSW SOPA counts business days, skipping weekends", () => {
    // 2026-03-02 is a Monday. 10 business days later is Monday 2026-03-16.
    const t = generateTimetable("nsw_sopa", "2026-03-02")!;
    const schedule = t.steps.find((s) => s.key === "payment_schedule")!;
    expect(schedule.basis).toBe("business");
    expect(schedule.dueDate).toBe("2026-03-16");
    expect(t.weekendsOnly).toBe(true);
  });

  it("honours a supplied holiday calendar and stops flagging weekends-only", () => {
    const withoutHolidays = generateTimetable("nsw_sopa", "2026-03-02")!;
    const withHolidays = generateTimetable("nsw_sopa", "2026-03-02", ["2026-03-09", "2026-03-10"])!;
    const a = withoutHolidays.steps.find((s) => s.key === "payment_schedule")!.dueDate;
    const b = withHolidays.steps.find((s) => s.key === "payment_schedule")!.dueDate;
    expect(b > a).toBe(true);
    expect(withHolidays.weekendsOnly).toBe(false);
  });

  it("FIDIC DAAB: 84-day decision, 28-day dissatisfaction window, 28-day amicable period", () => {
    const t = generateTimetable("fidic_daab", "2026-01-01")!;
    expect(t.steps.find((s) => s.key === "decision")!.dueDate).toBe("2026-03-26");
    expect(t.steps.find((s) => s.key === "notice_of_dissatisfaction")!.dueDate).toBe("2026-04-23");
    expect(t.steps.find((s) => s.key === "amicable_settlement")!.dueDate).toBe("2026-05-21");
  });

  it("business-day arithmetic starts the day after the trigger and is idempotent at zero", () => {
    const none = new Set<string>();
    expect(addBusinessDays("2026-03-02", 0, none)).toBe("2026-03-02");
    expect(addBusinessDays("2026-03-06", 1, none)).toBe("2026-03-09"); // Fri → Mon
    expect(addBusinessDays("2026-03-06", 1, new Set(["2026-03-09"]))).toBe("2026-03-10");
    expect(addCalendarDays("2026-02-27", 3)).toBe("2026-03-02");
  });
});

describe("adjudicator nomination request (#328)", () => {
  const base = {
    disputeNumber: 4,
    disputeTitle: "Valuation of variation 27",
    jurisdiction: "uk_hgcra",
    forum: "RICS",
    rules: "Scheme for Construction Contracts",
    contractReference: "C-2024-11",
    contractFamily: "JCT DB 2016",
    projectName: "Northern Interchange",
    referringParty: "Contractor Ltd",
    respondingParty: "Employer plc",
    amountInDispute: 420_000,
    currency: "GBP",
    triggerDate: "2026-03-02",
    natureOfDispute: "Disputed valuation of an instructed variation.",
    requestedAt: "2026-03-03T09:00:00Z",
  };

  it("assembles the request from recorded fields and computes the deadlines", () => {
    const req = buildNominationRequest(base);
    expect(req.title).toContain("dispute #4");
    expect(req.sections.find((s) => s.heading === "Nominating body")!.body).toBe("RICS");
    expect(req.sections.find((s) => s.heading === "Quantum")!.body).toContain("420,000");
    expect(req.deadlines.map((d) => d.dueDate)).toContain("2026-03-09");
    expect(req.basis).toContain("nothing has been drafted or inferred");
  });

  it("says what is missing instead of inventing it", () => {
    const req = buildNominationRequest({
      ...base,
      forum: null,
      contractReference: null,
      amountInDispute: null,
      triggerDate: null,
    });
    expect(req.sections.find((s) => s.heading === "Nominating body")!.body).toContain(
      "No nominating body has been recorded",
    );
    expect(req.sections.find((s) => s.heading === "Quantum")!.body).toContain("not been quantified");
    expect(req.deadlines).toEqual([]);
  });

  it("says so when there is no statutory regime at all", () => {
    const req = buildNominationRequest({ ...base, jurisdiction: "custom" });
    expect(req.sections.find((s) => s.heading === "Statutory framework")!.body).toContain(
      "No statutory regime",
    );
  });
});

/* ------------------------------------------------------------------ */
/* Settlement                                                          */
/* ------------------------------------------------------------------ */

const offer = (over: Partial<OfferForAnalysis> = {}): OfferForAnalysis => ({
  id: "o1",
  direction: "received",
  status: "open",
  amount: 100_000,
  currency: "GBP",
  basis: "without_prejudice",
  offeredAt: "2026-01-01",
  expiresAt: null,
  ...over,
});

describe("offer liveness (#352)", () => {
  it("an expired open offer is not live", () => {
    expect(isOfferLive(offer({ expiresAt: "2026-01-22" }), "2026-09-05")).toBe(false);
    expect(isOfferLive(offer({ expiresAt: "2026-12-31" }), "2026-09-05")).toBe(true);
    expect(isOfferLive(offer({ expiresAt: null }), "2026-09-05")).toBe(true);
  });

  it("a rejected or lapsed offer is never live", () => {
    expect(isOfferLive(offer({ status: "rejected" }), "2026-01-02")).toBe(false);
    expect(isOfferLive(offer({ status: "lapsed" }), "2026-01-02")).toBe(false);
  });
});

describe("analyseSettlement excludes what is not on the table", () => {
  it("keeps the pre-existing arithmetic exactly", () => {
    const a = analyseSettlement(
      { winProbability: 0.55, expectedAward: 100_000, legalCosts: 12_345.5 },
      [offer({ id: "o1", amount: 50_000 }), offer({ id: "o2", amount: 999_999, status: "rejected" })],
    );
    expect(a.expectedValueOfProceeding).toBe(42_654.5);
    expect(a.bestOpenOffer!.id).toBe("o1");
    expect(a.recommendation).toBe("settle");
  });

  it("drops an expired offer and says so", () => {
    const a = analyseSettlement(
      { winProbability: 0.3, expectedAward: 100_000, legalCosts: 0 },
      [offer({ id: "expired", amount: 90_000, offeredAt: "2026-01-01", expiresAt: "2026-01-22" })],
      { today: "2026-09-05" },
    );
    expect(a.bestOpenOffer).toBeNull();
    expect(a.expiredOffers.map((o) => o.id)).toEqual(["expired"]);
    expect(a.recommendation).toBe("proceed");
    expect(a.caveats[0]).toContain("expired");
  });

  it("does not let a foreign-currency offer beat a domestic expected value", () => {
    const a = analyseSettlement(
      { winProbability: 0.5, expectedAward: 700_000, legalCosts: 0 },
      [
        offer({ id: "usd", amount: 400_000, currency: "USD" }),
        offer({ id: "gbp", amount: 350_000, currency: "GBP" }),
      ],
      { today: "2026-09-05", disputeCurrency: "GBP" },
    );
    expect(a.bestOpenOffer!.id).toBe("gbp");
    expect(a.otherCurrencyOffers.map((o) => o.id)).toEqual(["usd"]);
    expect(a.caveats.join(" ")).toContain("excluded rather than converted");
  });

  it("compares nothing when every offer is in another currency", () => {
    const a = analyseSettlement(
      { winProbability: 0.5, expectedAward: 100_000, legalCosts: 0 },
      [offer({ currency: "EUR" })],
      { today: "2026-09-05", disputeCurrency: "GBP" },
    );
    expect(a.bestOpenOffer).toBeNull();
  });
});

describe("decision tree (#351-353)", () => {
  const stages = [
    { id: "s1", name: "Pleadings", ownCosts: 40_000, opponentCosts: 35_000 },
    { id: "s2", name: "Trial", ownCosts: 120_000, opponentCosts: 140_000 },
  ];

  it("weights branches to a present value with costs on every branch", () => {
    const tree = evaluateDecisionTree({
      currency: "GBP",
      branches: [
        { id: "b1", kind: "win_full", label: "Win in full", probability: 0.4, award: 800_000 },
        { id: "b2", kind: "win_partial", label: "Win in part", probability: 0.35, award: 400_000 },
        { id: "b3", kind: "lose", label: "Lose", probability: 0.25, award: 0 },
      ],
      stages,
      discountRatePercent: 0,
      yearsToResolution: 0,
    });
    expect(tree.valid).toBe(true);
    expect(tree.totalOwnCosts).toBe(160_000);
    expect(tree.totalOpponentCosts).toBe(175_000);
    // win full: 800k − 160k = 640k; win partial: 400k − 160k = 240k;
    // lose: 0 − 160k − 175k = −335k
    expect(tree.branches[0]!.netOutcome).toBe(640_000);
    expect(tree.branches[2]!.netOutcome).toBe(-335_000);
    expect(tree.expectedValue).toBe(0.4 * 640_000 + 0.35 * 240_000 + 0.25 * -335_000);
  });

  it("discounts to present value", () => {
    const undiscounted = evaluateDecisionTree({
      currency: "GBP",
      branches: [{ id: "b1", kind: "win_full", label: "Win", probability: 1, award: 1_000_000 }],
      stages: [],
      discountRatePercent: 0,
      yearsToResolution: 0,
    });
    const discounted = evaluateDecisionTree({
      currency: "GBP",
      branches: [{ id: "b1", kind: "win_full", label: "Win", probability: 1, award: 1_000_000 }],
      stages: [],
      discountRatePercent: 10,
      yearsToResolution: 2,
    });
    expect(discounted.expectedValue).toBeLessThan(undiscounted.expectedValue);
    expect(discounted.expectedValue).toBeCloseTo(1_000_000 / 1.1 ** 2, 0);
  });

  it("applies Part 36 uplift and enhanced interest only when the offer is beaten", () => {
    const inputs = {
      currency: "GBP",
      branches: [
        { id: "b1", kind: "win_full", label: "Beat the offer", probability: 0.5, award: 600_000 },
        { id: "b2", kind: "win_partial", label: "Below the offer", probability: 0.5, award: 300_000 },
      ],
      stages,
      discountRatePercent: 0,
      yearsToResolution: 1,
      costsRules: {
        enabled: true,
        indemnityCostsPercent: 25,
        enhancedInterestPercent: 10,
        ownOfferAmount: 500_000,
      },
    };
    const tree = evaluateDecisionTree(inputs);
    expect(tree.branches[0]!.costsUplift).toBe(40_000); // 25% of 160,000
    expect(tree.branches[0]!.enhancedInterest).toBe(60_000); // 10% of 600,000 for 1 year
    expect(tree.branches[1]!.costsUplift).toBe(0);
    expect(tree.branches[1]!.enhancedInterest).toBe(0);
    expect(tree.basis).toContain("Part 36");
  });

  it("refuses to recommend on a tree whose probabilities do not close", () => {
    const tree = evaluateDecisionTree({
      currency: "GBP",
      branches: [
        { id: "b1", kind: "win_full", label: "Win", probability: 0.4, award: 100 },
        { id: "b2", kind: "lose", label: "Lose", probability: 0.4, award: 0 },
      ],
      stages: [],
      discountRatePercent: 0,
      yearsToResolution: 0,
    });
    expect(tree.valid).toBe(false);
    expect(tree.probabilitySum).toBe(0.8);
    expect(tree.recommendation).toBe("insufficient_model");
    expect(tree.caveats[0]).toContain("does not close");
  });

  it("compares against the best live offer only", () => {
    const branches = [
      { id: "b1", kind: "win_full", label: "Win", probability: 0.5, award: 100_000 },
      { id: "b2", kind: "lose", label: "Lose", probability: 0.5, award: 0 },
    ];
    const tree = evaluateDecisionTree(
      { currency: "GBP", branches, stages: [], discountRatePercent: 0, yearsToResolution: 0 },
      [
        offer({ id: "live", amount: 60_000 }),
        offer({ id: "dead", amount: 500_000, expiresAt: "2026-01-02" }),
      ],
      { today: "2026-09-05", disputeCurrency: "GBP" },
    );
    expect(tree.expectedValue).toBe(50_000);
    expect(tree.bestOffer!.id).toBe("live");
    expect(tree.recommendation).toBe("settle");
    expect(tree.caveats.join(" ")).toContain("expired");
  });
});

describe("litigation provision (#355)", () => {
  it("provides for the downside and reports the upside separately", () => {
    const tree = evaluateDecisionTree({
      currency: "GBP",
      branches: [
        { id: "b1", kind: "win_full", label: "Win", probability: 0.6, award: 500_000 },
        { id: "b2", kind: "lose", label: "Lose", probability: 0.4, award: 0 },
      ],
      stages: [{ id: "s1", name: "All in", ownCosts: 100_000, opponentCosts: 200_000 }],
      discountRatePercent: 0,
      yearsToResolution: 0,
    });
    const p = litigationProvision(tree);
    // lose branch net = −300,000 × 0.4 = −120,000
    expect(p.provision).toBe(120_000);
    // win branch net = 400,000 × 0.6 = 240,000
    expect(p.contingentAsset).toBe(240_000);
    expect(p.basis).toContain("NOT netted off");
  });

  it("returns null with a reason for an invalid tree", () => {
    const tree = evaluateDecisionTree({
      currency: "GBP",
      branches: [{ id: "b1", kind: "win_full", label: "Win", probability: 0.2, award: 1 }],
      stages: [],
      discountRatePercent: 0,
      yearsToResolution: 0,
    });
    const p = litigationProvision(tree);
    expect(p.provision).toBeNull();
    expect(p.unavailableReason).toContain("does not close");
  });
});

/* ------------------------------------------------------------------ */
/* Outcome analytics                                                   */
/* ------------------------------------------------------------------ */

const row = (over: Partial<DisputeOutcomeRow> = {}): DisputeOutcomeRow => ({
  id: "d1",
  projectId: "p1",
  number: 1,
  title: "Dispute",
  kind: "adjudication",
  forum: "RICS",
  status: "decided",
  jurisdiction: "uk_hgcra",
  contractFamily: "JCT",
  governingClause: "cl. 2.26",
  rootCause: "late_information",
  currency: "GBP",
  amountClaimed: 100_000,
  amountAwarded: 60_000,
  costsAwarded: null,
  notifiedAt: "2026-01-01",
  resolvedAt: "2026-03-02",
  ownCosts: 20_000,
  ...over,
});

describe("dispute outcome analytics (#356-357)", () => {
  it("excludes live disputes and counts them", () => {
    const a = outcomeAnalytics([row(), row({ id: "d2", status: "hearing" })]);
    expect(a.overall.disputes).toBe(1);
    expect(a.excludedNotTerminal).toBe(1);
  });

  it("computes win rate, award ratio and duration over the rows that carry the fields", () => {
    const a = outcomeAnalytics([
      row({ id: "d1", amountAwarded: 60_000, amountClaimed: 100_000 }),
      row({ id: "d2", amountAwarded: 0, amountClaimed: 100_000 }),
      row({ id: "d3", amountAwarded: null, amountClaimed: 100_000 }),
    ]);
    expect(a.overall.winRate).toBe(0.5);
    expect(a.overall.winRateSample).toBe(2);
    expect(a.overall.awardRatio).toBe(0.3);
    expect(a.overall.averageDurationDays).toBe(60);
  });

  it("returns null — not 0 — when no dispute carries the field", () => {
    const a = outcomeAnalytics([row({ amountAwarded: null, notifiedAt: null, resolvedAt: null })]);
    expect(a.overall.winRate).toBeNull();
    expect(a.overall.averageDurationDays).toBeNull();
  });

  it("buckets recovered and cost money by currency, never adding across them", () => {
    const a = outcomeAnalytics([
      row({ id: "d1", currency: "GBP", amountAwarded: 100, ownCosts: 40 }),
      row({ id: "d2", currency: "USD", amountAwarded: 200, ownCosts: 50 }),
    ]);
    expect(a.overall.recoveredByCurrency).toEqual([
      { currency: "GBP", amount: 100 },
      { currency: "USD", amount: 200 },
    ]);
    expect(a.overall.costPerUnitRecovered).toEqual([
      { currency: "GBP", ratio: 0.4, sample: 1 },
      { currency: "USD", ratio: 0.25, sample: 1 },
    ]);
  });

  it("reports a null cost-per-unit ratio when nothing was recovered", () => {
    const a = outcomeAnalytics([row({ amountAwarded: 0, ownCosts: 50_000 })]);
    expect(a.overall.costPerUnitRecovered[0]!.ratio).toBeNull();
  });

  it("groups by the requested dimension and flags thin groups", () => {
    const a = outcomeAnalytics(
      [
        row({ id: "d1", forum: "RICS" }),
        row({ id: "d2", forum: "RICS" }),
        row({ id: "d3", forum: "TCC" }),
      ],
      "forum",
    );
    expect(a.groupedBy).toBe("forum");
    expect(a.groups.map((g) => g.key)).toEqual(["RICS", "TCC"]);
    expect(a.groups.every((g) => g.thin)).toBe(true);
    expect(MIN_SAMPLE).toBe(5);
  });

  it("labels an unrecorded dimension rather than dropping the dispute", () => {
    const a = outcomeAnalytics([row({ rootCause: null })], "rootCause");
    expect(a.groups[0]!.key).toBe("(not recorded)");
  });
});

describe("drafting recommendations (#357)", () => {
  it("cites the disputes behind every recommendation", () => {
    const recs = draftingRecommendations([
      row({ id: "d1", governingClause: "cl. 2.26", rootCause: "late_information" }),
      row({ id: "d2", governingClause: "cl. 2.26", rootCause: "late_information" }),
      row({ id: "d3", governingClause: "cl. 4.12", rootCause: "payment_default" }),
    ]);
    const clause = recs.find((r) => r.subject === "cl. 2.26" && r.dimension === "governingClause")!;
    expect(clause.disputes).toBe(2);
    expect(clause.citedDisputeIds.sort()).toEqual(["d1", "d2"]);
    expect(clause.headline).toContain("cl. 2.26");
    expect(clause.headline).toContain("GBP");
  });

  it("skips dimensions that were never recorded and singletons", () => {
    const recs = draftingRecommendations([
      row({ id: "d1", governingClause: null, rootCause: null }),
      row({ id: "d2", governingClause: "cl. 9.1", rootCause: "other" }),
    ]);
    expect(recs.every((r) => r.subject !== "(not recorded)")).toBe(true);
    expect(recs.every((r) => r.subject !== "cl. 9.1")).toBe(true);
  });

  it("honours the limit and minimum sample options", () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      row({ id: `d${i}`, governingClause: `cl. ${i}`, rootCause: "other" }),
    );
    expect(draftingRecommendations(rows, { minDisputes: 1, limit: 3 })).toHaveLength(3);
  });
});
