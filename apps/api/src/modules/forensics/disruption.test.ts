import { describe, expect, it } from "vitest";
import {
  IBBS_CURVE,
  MCAA_FACTORS,
  earnedValueDisruption,
  industryCurve,
  interpolateCurve,
  measuredMile,
  suggestBaselineWindow,
  type ProductivityPoint,
} from "./disruption.js";

function week(weekStart: string, quantity: number, hours: number, impacted = false): ProductivityPoint {
  return { weekStart, quantity, hours, sourceIds: [`tc-${weekStart}`], impacted };
}

const SERIES: ProductivityPoint[] = [
  week("2026-01-05", 100, 100), // 1.0 units/hour
  week("2026-01-12", 110, 100),
  week("2026-01-19", 105, 100),
  week("2026-01-26", 90, 100),
  week("2026-02-02", 60, 100, true), // impacted: 0.6
  week("2026-02-09", 50, 100, true),
  week("2026-02-16", 55, 100, true),
];

describe("measured mile (#290)", () => {
  it("prices the productivity difference between an unimpacted and an impacted window", () => {
    const r = measuredMile({
      trade: "Steel fixing",
      unit: "tonne",
      series: SERIES,
      baselineFrom: "2026-01-05",
      baselineTo: "2026-01-26",
      impactedFrom: "2026-02-02",
      impactedTo: "2026-02-16",
      hourlyRate: 40,
      currency: "GBP",
    });
    expect(r.ok).toBe(true);
    expect(r.baselineProductivity).toBeCloseTo(1.0125, 4); // 405 / 400
    expect(r.impactedProductivity).toBeCloseTo(0.55, 4); // 165 / 300
    expect(r.expectedHours).toBeCloseTo(162.96, 1); // 165 / 1.0125
    expect(r.lostHours).toBeCloseTo(137.04, 1);
    expect(r.amount).toBeCloseTo(5481.6, 0);
    expect(r.currency).toBe("GBP");
    expect(r.sourceIds).toContain("tc-2026-01-05");
    expect(r.productivityLossPercent).toBeGreaterThan(40);
  });

  it("reports lost hours without money when no rate is supplied", () => {
    const r = measuredMile({
      trade: "Steel fixing",
      unit: "tonne",
      series: SERIES,
      baselineFrom: "2026-01-05",
      baselineTo: "2026-01-26",
      impactedFrom: "2026-02-02",
      impactedTo: "2026-02-16",
    });
    expect(r.lostHours).not.toBeNull();
    expect(r.amount).toBeNull();
    expect(r.reasons.join(" ")).toMatch(/No labour rate/);
  });

  it("objects when the baseline window is impacted or too short", () => {
    const r = measuredMile({
      trade: "Steel fixing",
      unit: "tonne",
      series: SERIES,
      baselineFrom: "2026-02-02",
      baselineTo: "2026-02-02",
      impactedFrom: "2026-02-09",
      impactedTo: "2026-02-16",
    });
    expect(r.reasons.join(" ")).toMatch(/fewer than three weeks/);
    expect(r.reasons.join(" ")).toMatch(/not unimpacted/);
  });

  it("says so when the impacted period was actually more productive", () => {
    const r = measuredMile({
      trade: "Steel fixing",
      unit: "tonne",
      series: SERIES,
      baselineFrom: "2026-02-02",
      baselineTo: "2026-02-16",
      impactedFrom: "2026-01-05",
      impactedTo: "2026-01-26",
    });
    expect(r.lostHours!).toBeLessThan(0);
    expect(r.reasons.join(" ")).toMatch(/MORE productive/);
  });

  it("reports honestly when a window contains no weeks", () => {
    const r = measuredMile({
      trade: "Steel fixing",
      unit: "tonne",
      series: SERIES,
      baselineFrom: "2025-01-01",
      baselineTo: "2025-02-01",
      impactedFrom: "2026-02-02",
      impactedTo: "2026-02-16",
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/No weeks fall inside the chosen baseline window/);
  });
});

describe("baseline window suggestion", () => {
  it("finds the best-productivity contiguous unimpacted run", () => {
    const s = suggestBaselineWindow(SERIES, 3);
    expect(s).not.toBeNull();
    expect(s!.from).toBe("2026-01-05");
    expect(s!.weeks).toBeGreaterThanOrEqual(3);
    expect(s!.productivity).toBeGreaterThan(1);
  });

  it("returns null when there are not enough unimpacted weeks", () => {
    expect(suggestBaselineWindow([week("2026-01-05", 10, 10)], 3)).toBeNull();
  });
});

describe("earned-value disruption (#291)", () => {
  it("computes lost hours from earned versus actual", () => {
    const r = earnedValueDisruption({
      activities: [
        { id: "a", name: "Riser 1", budgetedHours: 100, actualHours: 150, percentComplete: 50 },
        { id: "b", name: "Riser 2", budgetedHours: 200, actualHours: 100, percentComplete: 50 },
      ],
      hourlyRate: 50,
    });
    expect(r.ok).toBe(true);
    expect(r.earnedHours).toBe(150); // 50 + 100
    expect(r.actualHours).toBe(250);
    expect(r.lostHours).toBe(100);
    expect(r.amount).toBe(5000);
    expect(r.productivityFactor).toBeCloseTo(0.6, 4);
  });

  it("excludes activities with no hours rather than treating them as zero", () => {
    const r = earnedValueDisruption({
      activities: [
        { id: "a", name: "Riser 1", budgetedHours: 100, actualHours: 150, percentComplete: 50 },
        { id: "b", name: "Riser 2", budgetedHours: null, actualHours: null, percentComplete: 100 },
      ],
    });
    expect(r.excluded).toBe(1);
    expect(r.activities).toHaveLength(1);
    expect(r.reasons.join(" ")).toMatch(/excluded/);
  });
});

describe("industry curves (#292-293)", () => {
  it("interpolates a published curve", () => {
    expect(interpolateCurve(IBBS_CURVE, 0)).toBe(0);
    expect(interpolateCurve(IBBS_CURVE, 15)).toBeCloseTo(0.14, 4);
    expect(interpolateCurve(IBBS_CURVE, 1000)).toBe(0.33); // clamped
  });

  it("applies MCAA factors and names each one", () => {
    const r = industryCurve({
      method: "industry_curve_mcaa",
      baseHours: 1000,
      factors: [
        { key: "stacking_of_trades", severity: "average" },
        { key: "dilution_of_supervision", severity: "minor" },
      ],
      hourlyRate: 40,
      justification: "Three trades were compelled into the same riser zone for eleven weeks by the late release of the M&E design.",
    });
    expect(r.ok).toBe(true);
    expect(r.lossFactor).toBeCloseTo(0.3, 4); // 0.2 + 0.1
    expect(r.lostHours).toBe(300);
    expect(r.amount).toBe(12_000);
    expect(r.applied.map((a) => a.label)).toContain("Stacking of trades");
    expect(r.source).toMatch(/MCAA/);
  });

  it("refuses to produce a number without a justification", () => {
    const r = industryCurve({
      method: "industry_curve_mcaa",
      baseHours: 1000,
      factors: [{ key: "stacking_of_trades", severity: "average" }],
      justification: "because",
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/written justification/);
  });

  it("warns when many factors are stacked and caps the total at 100%", () => {
    const r = industryCurve({
      method: "industry_curve_mcaa",
      baseHours: 100,
      factors: MCAA_FACTORS.map((f) => ({ key: f.key, severity: "severe" as const })),
      justification: "Every MCAA factor is asserted, which is exactly the pattern tribunals reject out of hand.",
    });
    expect(r.lossFactor).toBe(1);
    expect(r.reasons.join(" ")).toMatch(/capped at 100%/);
    expect(r.reasons.join(" ")).toMatch(/discount stacked MCAA factors/);
  });

  it("uses the Leonard curve against a change-order percentage", () => {
    const r = industryCurve({
      method: "industry_curve_leonard",
      baseHours: 2000,
      changePercent: 20,
      hourlyRate: 30,
      justification: "Variations totalled 20% of the base electrical contract, with other causes of impact present throughout.",
    });
    expect(r.ok).toBe(true);
    expect(r.lossFactor).toBe(0.19);
    expect(r.lostHours).toBe(380);
    expect(r.amount).toBe(11_400);
    expect(r.source).toMatch(/Leonard/);
  });

  it("reports an unknown factor rather than silently ignoring it", () => {
    const r = industryCurve({
      method: "industry_curve_mcaa",
      baseHours: 100,
      factors: [{ key: "invented_factor", severity: "average" }],
      justification: "A justification long enough to pass the length check for this test case.",
    });
    expect(r.reasons.join(" ")).toMatch(/Unknown MCAA factor/);
  });
});
