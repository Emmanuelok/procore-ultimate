import { describe, expect, it } from "vitest";
import {
  analyseBuildUp,
  analyseRateAgainstBenchmarks,
  descriptionTokens,
  tokenOverlap,
} from "./rates.js";
import {
  computeLdExposure,
  computeValuationTotals,
  paymentDueRule,
  retentionSchedule,
} from "./valuation-engine.js";
import { computeFluctuation, indexAt } from "./fluctuations.js";
import { computeCvr, computeSCurve } from "./cvr.js";
import { buildFinalAccount } from "./final-account.js";

/* ------------------------------------------------------------------ */
/* Valuation arithmetic                                                */
/* ------------------------------------------------------------------ */

describe("valuation totals", () => {
  it("builds the gross from BQ work, materials and typed sections", () => {
    const t = computeValuationTotals({
      workDoneToDate: 100_000,
      materialsOnSite: 10_000,
      materialsOffSite: 5_000,
      sections: [
        { kind: "variation", amountToDate: 20_000, retentionApplies: true },
        { kind: "contra_charge", amountToDate: -3_000, retentionApplies: false },
      ],
      retentionPercent: 5,
      retentionCap: null,
      retentionReleased: 0,
      previousNet: 40_000,
    });
    expect(t.sectionsTotal).toBe(17_000);
    expect(t.grossTotal).toBe(132_000);
    // the contra charge is outside the retention base
    expect(t.retentionBase).toBe(135_000);
    expect(t.retentionHeld).toBe(6_750);
    expect(t.netDue).toBe(132_000 - 6_750 - 40_000);
  });

  it("caps retention at the contract cap", () => {
    const uncapped = computeValuationTotals({
      workDoneToDate: 20_000_000,
      materialsOnSite: 0,
      materialsOffSite: 0,
      sections: [],
      retentionPercent: 5,
      retentionCap: null,
      retentionReleased: 0,
      previousNet: 0,
    });
    expect(uncapped.retentionHeld).toBe(1_000_000);
    expect(uncapped.retentionCapped).toBe(false);

    const capped = computeValuationTotals({
      workDoneToDate: 20_000_000,
      materialsOnSite: 0,
      materialsOffSite: 0,
      sections: [],
      retentionPercent: 5,
      retentionCap: 500_000,
      retentionReleased: 0,
      previousNet: 0,
    });
    expect(capped.retentionHeld).toBe(500_000);
    expect(capped.retentionCapped).toBe(true);
    expect(capped.netDue).toBe(19_500_000);
  });

  it("nets released retention off the held balance without going negative", () => {
    const t = computeValuationTotals({
      workDoneToDate: 1_000_000,
      materialsOnSite: 0,
      materialsOffSite: 0,
      sections: [],
      retentionPercent: 5,
      retentionCap: null,
      retentionReleased: 80_000,
      previousNet: 0,
    });
    expect(t.retentionHeld).toBe(0);
  });
});

describe("payment due rules", () => {
  it("prefers the contract's own stated period and cites it", () => {
    const rule = paymentDueRule("fidic_red_2017", 30);
    expect(rule?.days).toBe(30);
    expect(rule?.basis).toContain("Contract particulars");
  });

  it("falls back to the standard form's payment clause", () => {
    expect(paymentDueRule("fidic_red_2017", null)?.days).toBe(56);
    expect(paymentDueRule("nec4_ecc", null)?.days).toBe(21);
    expect(paymentDueRule("bespoke", null)).toBeNull();
  });
});

describe("retention release schedule", () => {
  it("releases half at taking-over and the balance at the end of the defects period", () => {
    const s = retentionSchedule({
      retentionHeld: 100_000,
      takingOverDate: "2025-01-31",
      defectsPeriodMonths: 12,
      releaseAtTakingOver: 0.5,
      asOf: "2025-02-01",
      alreadyReleased: 0,
    });
    expect(s.firstTranche).toBe(50_000);
    expect(s.secondTrancheDate).toBe("2026-01-31");
    expect(s.dueNow).toBe(50_000);

    const later = retentionSchedule({
      retentionHeld: 50_000,
      takingOverDate: "2025-01-31",
      defectsPeriodMonths: 12,
      releaseAtTakingOver: 0.5,
      asOf: "2026-02-01",
      alreadyReleased: 50_000,
    });
    expect(later.dueNow).toBe(50_000);
  });

  it("releases nothing and says why without a taking-over date", () => {
    const s = retentionSchedule({
      retentionHeld: 100_000,
      takingOverDate: null,
      defectsPeriodMonths: 12,
      releaseAtTakingOver: 0.5,
      asOf: "2025-06-01",
      alreadyReleased: 0,
    });
    expect(s.dueNow).toBe(0);
    expect(s.reasons[0]).toContain("No taking-over date");
  });
});

describe("liquidated damages exposure", () => {
  const base = {
    completionDate: "2025-01-01",
    takingOverDate: null,
    actualCompletionDate: null,
    ldRatePerDay: 1_000,
    ldCap: 100_000,
    contractStatus: "executed",
    today: "2025-03-02",
  };

  it("accrues to today while the works are incomplete", () => {
    const ld = computeLdExposure(base);
    expect(ld.applicable).toBe(true);
    expect(ld.daysLate).toBe(60);
    expect(ld.accrued).toBe(60_000);
    expect(ld.frozen).toBe(false);
  });

  it("stops accruing at taking-over", () => {
    const ld = computeLdExposure({ ...base, takingOverDate: "2025-01-11" });
    expect(ld.daysLate).toBe(10);
    expect(ld.accrued).toBe(10_000);
    expect(ld.frozen).toBe(true);
    expect(ld.accrualEndBasis).toContain("taking-over");
  });

  it("freezes a completed contract instead of accruing forever", () => {
    const ld = computeLdExposure({
      ...base,
      contractStatus: "completed",
      today: "2026-09-02",
    });
    expect(ld.daysLate).toBe(0);
    expect(ld.accrued).toBe(0);
    expect(ld.frozen).toBe(true);
  });

  it("applies the cap and reports it", () => {
    const ld = computeLdExposure({ ...base, today: "2026-01-01" });
    expect(ld.accrued).toBe(100_000);
    expect(ld.capReached).toBe(true);
  });

  it("is not applicable without a rate or a completion date", () => {
    expect(computeLdExposure({ ...base, ldRatePerDay: null }).applicable).toBe(false);
    expect(computeLdExposure({ ...base, completionDate: null }).applicable).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Rate analysis                                                       */
/* ------------------------------------------------------------------ */

describe("rate build-up analysis", () => {
  it("totals the build-up, splits it by kind and reconciles against the rate", () => {
    const a = analyseBuildUp(100, [
      { kind: "labour", description: "gang", qty: 2, rate: 25 },
      { kind: "material", description: "concrete", qty: 1, rate: 30 },
      { kind: "plant", description: "pump", qty: 1, rate: 10 },
      { kind: "overhead", description: "site oh", qty: 1, rate: 5 },
      { kind: "profit", description: "profit", qty: 1, rate: 5 },
    ]);
    expect(a.total).toBe(100);
    expect(a.reconciles).toBe(true);
    expect(a.splitPercent["labour"]).toBe(50);
    expect(a.observations).toHaveLength(0);
  });

  it("reports a build-up that does not reconcile with the item rate", () => {
    const a = analyseBuildUp(999, [{ kind: "labour", description: "gang", qty: 1, rate: 100 }]);
    expect(a.reconciles).toBe(false);
    expect(a.difference).toBe(899);
    expect(a.observations.join(" ")).toContain("labour carries 100%");
  });

  it("notes a missing profit and overhead recovery", () => {
    const a = analyseBuildUp(60, [
      { kind: "labour", description: "gang", qty: 1, rate: 30 },
      { kind: "material", description: "mat", qty: 1, rate: 30 },
    ]);
    expect(a.observations.join(" ")).toContain("No profit component");
    expect(a.observations.join(" ")).toContain("No overhead component");
  });
});

describe("rate benchmarking", () => {
  const samples = (values: number[]) =>
    values.map((rate, i) => ({ rate, source: "internal_history", label: `sample ${i}`, currency: "GBP" }));

  it("refuses a verdict below the minimum sample size and says so", () => {
    const a = analyseRateAgainstBenchmarks(100, samples([98, 102]));
    expect(a.verdict).toBe("no_benchmark");
    expect(a.basis).toContain("2 comparable");
  });

  it("calls an ordinary rate in range", () => {
    const a = analyseRateAgainstBenchmarks(101, samples([95, 98, 100, 102, 105]));
    expect(a.verdict).toBe("in_range");
    expect(a.median).toBe(100);
  });

  it("flags an outlier high rate with the deviation and the fence", () => {
    const a = analyseRateAgainstBenchmarks(400, samples([95, 98, 100, 102, 105]));
    expect(a.verdict).toBe("high");
    expect(a.deviationPercent).toBe(300);
    expect(a.basis).toContain("above the median");
  });

  it("flags an outlier low rate", () => {
    const a = analyseRateAgainstBenchmarks(10, samples([95, 98, 100, 102, 105]));
    expect(a.verdict).toBe("low");
  });

  it("has no verdict when the item carries no rate", () => {
    const a = analyseRateAgainstBenchmarks(null, samples([95, 98, 100]));
    expect(a.verdict).toBe("no_benchmark");
    expect(a.basis).toContain("no rate");
  });

  it("tokenises descriptions for comparability", () => {
    const a = descriptionTokens("Excavating trenches width not exceeding 2m in firm ground");
    expect(a).toContain("excavating");
    expect(a).toContain("trenches");
    expect(a).not.toContain("not");
    expect(tokenOverlap(a, descriptionTokens("Excavating trenches in soft ground"))).toBeGreaterThanOrEqual(2);
  });
});

/* ------------------------------------------------------------------ */
/* Fluctuations                                                        */
/* ------------------------------------------------------------------ */

describe("fluctuation formula", () => {
  const labour = {
    seriesCode: "LAB",
    label: "Labour",
    weighting: 0.4,
    points: [
      { period: "2024-01", value: 100 },
      { period: "2025-01", value: 110 },
    ],
  };
  const steel = {
    seriesCode: "STL",
    label: "Steel",
    weighting: 0.4,
    points: [
      { period: "2024-01", value: 200 },
      { period: "2025-01", value: 220 },
    ],
  };

  it("computes Pn and the adjustment with every index shown", () => {
    const r = computeFluctuation({
      formula: "fidic_13_8",
      basePeriod: "2024-01",
      currentPeriod: "2025-01",
      nonAdjustable: 0.2,
      components: [labour, steel],
      workDoneAmount: 1_000_000,
    });
    expect(r.ok).toBe(true);
    expect(r.factor).toBe(1.08);
    expect(r.adjustment).toBe(80_000);
    expect(r.components[0]?.baseIndex).toBe(100);
    expect(r.explanation).toContain("Pn =");
  });

  it("refuses when the weightings do not total one", () => {
    const r = computeFluctuation({
      formula: "fidic_13_8",
      basePeriod: "2024-01",
      currentPeriod: "2025-01",
      nonAdjustable: 0.5,
      components: [labour],
      workDoneAmount: 1_000,
    });
    expect(r.ok).toBe(false);
    expect(r.factor).toBeNull();
    expect(r.reasons.join(" ")).toContain("must total 1");
  });

  it("refuses rather than substituting 1.0 for a missing index", () => {
    const r = computeFluctuation({
      formula: "fidic_13_8",
      basePeriod: "2023-01",
      currentPeriod: "2025-01",
      nonAdjustable: 0.6,
      components: [labour],
      workDoneAmount: 1_000,
    });
    expect(r.ok).toBe(false);
    expect(r.adjustment).toBeNull();
    expect(r.reasons.join(" ")).toContain("base period");
  });

  it("uses the latest published value on or before the period", () => {
    expect(indexAt(labour.points, "2025-06")?.period).toBe("2025-01");
    expect(indexAt(labour.points, "2023-12")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* CVR + S-curve                                                       */
/* ------------------------------------------------------------------ */

describe("cost–value reconciliation", () => {
  it("reconciles value, cost and certification into margin and WIP", () => {
    const cvr = computeCvr({
      currency: "GBP",
      periodEnd: "2025-06-30",
      valueToDate: 1_000_000,
      certifiedToDate: 900_000,
      directCosts: [{ label: "Own labour", amount: 200_000 }],
      packages: [
        {
          key: "cmt1",
          label: "Groundworks",
          valueToDate: 400_000,
          committed: 500_000,
          costToDate: 350_000,
          accruals: 20_000,
          basis: {},
          gaps: [],
        },
      ],
    });
    expect(cvr.costToDate).toBe(550_000);
    expect(cvr.margin).toBe(1_000_000 - 550_000 - 20_000);
    expect(cvr.wip).toBe(100_000);
    expect(cvr.overUnderCertification).toBe(-100_000);
    expect(cvr.rows[0]?.scope).toBe("project");
  });

  it("returns a null margin with a reason rather than pretending cost is zero", () => {
    const cvr = computeCvr({
      currency: "GBP",
      periodEnd: "2025-06-30",
      valueToDate: 1_000_000,
      certifiedToDate: 0,
      directCosts: [{ label: "Own labour", amount: null, gap: "No approved timecards in the period." }],
      packages: [],
    });
    expect(cvr.costToDate).toBeNull();
    expect(cvr.margin).toBeNull();
    expect(cvr.gaps.join(" ")).toContain("No approved timecards");
  });

  it("reports over-certification as a positive number", () => {
    const cvr = computeCvr({
      currency: "GBP",
      periodEnd: "2025-06-30",
      valueToDate: 800_000,
      certifiedToDate: 900_000,
      directCosts: [],
      packages: [],
    });
    expect(cvr.overUnderCertification).toBe(100_000);
  });
});

describe("cash-flow S-curve", () => {
  it("spreads task money evenly across the months it spans and accumulates", () => {
    const s = computeSCurve(
      "GBP",
      [
        { taskId: "t1", name: "Substructure", start: "2025-01-10", finish: "2025-03-20", amount: 300 },
      ],
      0,
    );
    expect(s.points.map((p) => p.period)).toEqual(["2025-01", "2025-02", "2025-03"]);
    expect(s.points[2]?.plannedCumulative).toBe(300);
    expect(s.totalAllocated).toBe(300);
  });

  it("declares money that is not linked to the programme instead of smearing it", () => {
    const s = computeSCurve("GBP", [], 500_000);
    expect(s.unallocated).toBe(500_000);
    expect(s.reasons.join(" ")).toContain("not linked to any programme task");
  });

  it("overlays actual certified value from the period it first appears", () => {
    const s = computeSCurve(
      "GBP",
      [{ taskId: "t1", name: "T", start: "2025-01-01", finish: "2025-02-28", amount: 200 }],
      0,
      [{ period: "2025-02-15", amount: 80 }],
    );
    expect(s.points[0]?.actualCumulative).toBeNull();
    expect(s.points[1]?.actualCumulative).toBe(80);
  });
});

/* ------------------------------------------------------------------ */
/* Final account                                                       */
/* ------------------------------------------------------------------ */

describe("final account statement", () => {
  it("orders the adjustment schedule and reconciles against certificates", () => {
    const st = buildFinalAccount({
      contractSum: 10_000_000,
      certifiedToDate: 9_800_000,
      gaps: [],
      lines: [
        { category: "omission", description: "Omitted landscaping", amount: -250_000 },
        { category: "variation", description: "VO-001", amount: 400_000 },
        { category: "daywork", description: "DW sheets", amount: 35_000 },
        { category: "liquidated_damages", description: "42 days at 5,000", amount: -210_000 },
      ],
    });
    expect(st.categories.map((c) => c.category)).toEqual([
      "omission",
      "variation",
      "daywork",
      "liquidated_damages",
    ]);
    expect(st.finalContractSum).toBe(9_975_000);
    expect(st.balanceDue).toBe(175_000);
    expect(st.overCertified).toBe(false);
  });

  it("reports over-certification when certificates exceed the final sum", () => {
    const st = buildFinalAccount({
      contractSum: 1_000_000,
      certifiedToDate: 1_200_000,
      gaps: ["VO-004 is instructed but not agreed."],
      lines: [],
    });
    expect(st.balanceDue).toBe(-200_000);
    expect(st.overCertified).toBe(true);
    expect(st.gaps).toHaveLength(1);
  });
});
