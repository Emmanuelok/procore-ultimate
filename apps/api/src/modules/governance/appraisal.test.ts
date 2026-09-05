import { describe, expect, it } from "vitest";
import {
  appraiseOption,
  benefitProgressPercent,
  benefitStatusFor,
  economicIrr,
  netCashflows,
  npvOf,
  padToYears,
  sensitivityAnalysis,
  switchingValue,
} from "./appraisal.js";
import { addDaysISO, todayISO } from "../field/dates.js";

const config = (over: Partial<Parameters<typeof appraiseOption>[1]> = {}) => ({
  discountRatePercent: 10,
  appraisalYears: 2,
  optimismBiasPercent: 0,
  ...over,
});

describe("appraiseOption — NPV / BCR (#398-399)", () => {
  it("matches the hand-checked case: r=10%, 2 years, capex 100, benefits [60,60]", () => {
    const out = appraiseOption(
      { capex: 100, annualBenefits: [60, 60], annualCosts: [] },
      config(),
    );
    // NPV = -100 + 60/1.1 + 60/1.21 = 4.1322...
    expect(out.npv).toBeCloseTo(4.13, 2);
    // BCR = 104.1322 / 100 = 1.0413...
    expect(out.bcr).toBeCloseTo(1.0413, 3);
    expect(out.capexAdjusted).toBe(100);
    expect(out.pvBenefits).toBeCloseTo(104.13, 2);
    expect(out.pvCosts).toBe(0);
  });

  it("discounts recurring costs into both NPV and the BCR denominator", () => {
    const out = appraiseOption(
      { capex: 100, annualBenefits: [60, 60], annualCosts: [10, 10] },
      config(),
    );
    // PV(costs) = 10/1.1 + 10/1.21 = 17.3554
    expect(out.pvCosts).toBeCloseTo(17.36, 2);
    expect(out.npv).toBeCloseTo(4.13 - 17.36, 1);
    expect(out.bcr).toBeCloseTo(104.1322 / 117.3554, 3);
  });

  it("optimism bias uplifts capex only and moves both NPV and BCR (#402)", () => {
    const base = appraiseOption({ capex: 100, annualBenefits: [60, 60], annualCosts: [] }, config());
    const uplifted = appraiseOption(
      { capex: 100, annualBenefits: [60, 60], annualCosts: [] },
      config({ optimismBiasPercent: 20 }),
    );
    expect(uplifted.capexAdjusted).toBe(120);
    // NPV drops by exactly the uplift; benefits PV untouched
    expect(uplifted.pvBenefits).toBe(base.pvBenefits);
    expect(uplifted.npv).toBeCloseTo(base.npv - 20, 2);
    expect(uplifted.bcr).toBeCloseTo(104.1322 / 120, 3);
    expect(uplifted.bcr!).toBeLessThan(base.bcr!);
  });

  it("computes simple (undiscounted) payback year, null when never recovered", () => {
    const paysBackYear2 = appraiseOption(
      { capex: 100, annualBenefits: [60, 60], annualCosts: [] },
      config(),
    );
    expect(paysBackYear2.paybackYear).toBe(2); // -100 + 60 = -40; +60 = 20 >= 0
    const paysBackYear1 = appraiseOption(
      { capex: 50, annualBenefits: [60, 60], annualCosts: [] },
      config(),
    );
    expect(paysBackYear1.paybackYear).toBe(1);
    const never = appraiseOption(
      { capex: 500, annualBenefits: [60, 60], annualCosts: [] },
      config(),
    );
    expect(never.paybackYear).toBeNull();
    // costs eat into the yearly net
    const eroded = appraiseOption(
      { capex: 100, annualBenefits: [60, 60], annualCosts: [30, 30] },
      config(),
    );
    expect(eroded.paybackYear).toBeNull();
    // no capex to recover
    const free = appraiseOption({ capex: 0, annualBenefits: [10], annualCosts: [] }, config());
    expect(free.paybackYear).toBe(0);
  });

  it("pads and truncates annual series to the appraisal horizon", () => {
    expect(padToYears([1, 2], 4)).toEqual([1, 2, 0, 0]);
    expect(padToYears([1, 2, 3, 4], 2)).toEqual([1, 2]);
    // a benefit stream longer than the horizon is ignored beyond it
    const truncated = appraiseOption(
      { capex: 100, annualBenefits: [60, 60, 1000], annualCosts: [] },
      config(),
    );
    expect(truncated.npv).toBeCloseTo(4.13, 2);
    // a short stream counts as zero in later years
    const padded = appraiseOption(
      { capex: 100, annualBenefits: [60], annualCosts: [] },
      config({ appraisalYears: 3 }),
    );
    expect(padded.pvBenefits).toBeCloseTo(60 / 1.1, 2);
  });

  it("returns null BCR when the denominator is zero", () => {
    const out = appraiseOption({ capex: 0, annualBenefits: [10], annualCosts: [] }, config());
    expect(out.bcr).toBeNull();
    expect(out.npv).toBeCloseTo(10 / 1.1, 2);
  });
});

describe("benefitProgressPercent (#416-420)", () => {
  it("measures progress from baseline toward a growing target, clamped to [0,100]", () => {
    expect(benefitProgressPercent(0, 100, 50)).toBe(50);
    expect(benefitProgressPercent(0, 100, 150)).toBe(100); // overshoot clamps
    expect(benefitProgressPercent(0, 100, -20)).toBe(0); // wrong direction clamps
    expect(benefitProgressPercent(20, 120, 45)).toBe(25);
  });

  it("is direction-aware for reduction targets (disbenefits, #420)", () => {
    // disbenefit driven DOWN from 100 toward a target of 40
    expect(benefitProgressPercent(100, 40, 70)).toBe(50);
    expect(benefitProgressPercent(100, 40, 40)).toBe(100);
    expect(benefitProgressPercent(100, 40, 10)).toBe(100); // better than target clamps at 100
    expect(benefitProgressPercent(100, 40, 130)).toBe(0); // got worse — no progress
  });

  it("handles the degenerate target == baseline case", () => {
    expect(benefitProgressPercent(50, 50, 50)).toBe(100);
    expect(benefitProgressPercent(50, 50, 60)).toBe(0);
  });
});

describe("benefitStatusFor thresholds (#418)", () => {
  const today = todayISO();
  it("is planned with no readings and realised at >= 100%", () => {
    expect(benefitStatusFor(null, null, today)).toBe("planned");
    expect(benefitStatusFor(100, null, today)).toBe("realised");
    expect(benefitStatusFor(100, addDaysISO(today, -400), today)).toBe("realised");
  });
  it("tracks before the target date regardless of progress", () => {
    expect(benefitStatusFor(5, addDaysISO(today, 30), today)).toBe("tracking");
    expect(benefitStatusFor(5, null, today)).toBe("tracking");
  });
  it("goes at_risk past the target date below 70%", () => {
    expect(benefitStatusFor(69.9, addDaysISO(today, -1), today)).toBe("at_risk");
    expect(benefitStatusFor(70, addDaysISO(today, -1), today)).toBe("tracking");
  });
  it("goes missed more than 90 days past the target date below 100%", () => {
    expect(benefitStatusFor(99, addDaysISO(today, -91), today)).toBe("missed");
    expect(benefitStatusFor(30, addDaysISO(today, -91), today)).toBe("missed");
    expect(benefitStatusFor(30, addDaysISO(today, -90), today)).toBe("at_risk");
  });
});

/* ================================================================== */
/* Platform upgrade wave — EIRR, sensitivity, switching values (#400,  */
/* #406)                                                               */
/* ================================================================== */

describe("net cashflows", () => {
  it("puts the optimism-bias-adjusted capex in year 0 and nets each year after", () => {
    const cf = netCashflows(
      { capex: 1000, annualBenefits: [500, 500], annualCosts: [100, 100] },
      { discountRatePercent: 3.5, appraisalYears: 2, optimismBiasPercent: 20 },
    );
    expect(cf).toEqual([-1200, 400, 400]);
  });

  it("pads and truncates the series to the horizon", () => {
    const cf = netCashflows(
      { capex: 0, annualBenefits: [10], annualCosts: [1, 2, 3, 4] },
      { discountRatePercent: 0, appraisalYears: 3, optimismBiasPercent: 0 },
    );
    expect(cf).toEqual([-0, 9, -2, -3]);
  });
});

describe("economic IRR (#400)", () => {
  it("finds the rate where NPV is zero", () => {
    // -1000 now, +600 for three years → IRR ≈ 36.3%
    const irr = economicIrr([-1000, 600, 600, 600]);
    expect(irr).not.toBeNull();
    expect(irr!).toBeGreaterThan(36);
    expect(irr!).toBeLessThan(37);
    expect(Math.abs(npvOf([-1000, 600, 600, 600], irr! / 100))).toBeLessThan(1);
  });

  it("is exactly the discount rate that zeroes a simple two-period series", () => {
    // -100 now, +110 next year → IRR = 10%
    expect(economicIrr([-100, 110])).toBeCloseTo(10, 4);
  });

  it("returns null — not 0 — when the series never turns positive", () => {
    expect(economicIrr([-100, -50, -25])).toBeNull();
  });

  it("returns null when the series is all inflow (no investment to return on)", () => {
    expect(economicIrr([100, 50])).toBeNull();
  });

  it("returns null when no root sits inside the search bracket", () => {
    // Payback so small the IRR is below −99%
    expect(economicIrr([-1_000_000, 1])).toBeNull();
  });

  it("works end to end from an option", () => {
    const option = { capex: 1000, annualBenefits: [500, 500, 500], annualCosts: [0, 0, 0] };
    const config = { discountRatePercent: 3.5, appraisalYears: 3, optimismBiasPercent: 0 };
    const irr = economicIrr(netCashflows(option, config));
    expect(irr).not.toBeNull();
    expect(irr!).toBeGreaterThan(20);
  });
});

describe("sensitivity grid (#406)", () => {
  const option = { capex: 1000, annualBenefits: [400, 400, 400], annualCosts: [50, 50, 50] };
  const config = { discountRatePercent: 3.5, appraisalYears: 3, optimismBiasPercent: 0 };

  it("flexes one variable at a time across six steps", () => {
    const s = sensitivityAnalysis(option, config);
    expect(s.grid).toHaveLength(4 * 6);
    const capexCells = s.grid.filter((c) => c.variable === "capex");
    expect(capexCells.map((c) => c.changePercent)).toEqual([-30, -20, -10, 10, 20, 30]);
  });

  it("more capex lowers NPV; more benefits raise it", () => {
    const s = sensitivityAnalysis(option, config);
    const capexUp = s.grid.find((c) => c.variable === "capex" && c.changePercent === 30)!;
    const capexDown = s.grid.find((c) => c.variable === "capex" && c.changePercent === -30)!;
    expect(capexUp.npv).toBeLessThan(capexDown.npv);
    const benUp = s.grid.find((c) => c.variable === "benefits" && c.changePercent === 30)!;
    const benDown = s.grid.find((c) => c.variable === "benefits" && c.changePercent === -30)!;
    expect(benUp.npv).toBeGreaterThan(benDown.npv);
  });

  it("ranks the tornado by NPV swing at ±20%", () => {
    const s = sensitivityAnalysis(option, config);
    expect(s.tornado).toHaveLength(4);
    for (let i = 1; i < s.tornado.length; i += 1) {
      expect(s.tornado[i - 1]!.swing).toBeGreaterThanOrEqual(s.tornado[i]!.swing);
    }
    // benefits dominate this option's NPV
    expect(s.tornado[0]!.variable).toBe("benefits");
  });

  it("states what it did and did not model", () => {
    expect(sensitivityAnalysis(option, config).basis).toContain("Correlated movement");
  });
});

describe("switching values (#406)", () => {
  // Base NPV is comfortably positive, so the switching direction is
  // unambiguous: capex has to rise, or benefits fall, to break even.
  const option = { capex: 1000, annualBenefits: [500, 500, 500], annualCosts: [50, 50, 50] };
  const config = { discountRatePercent: 3.5, appraisalYears: 3, optimismBiasPercent: 0 };

  it("the base case is viable, so the option has something to switch away from", () => {
    expect(appraiseOption(option, config).npv).toBeGreaterThan(0);
  });

  it("finds the capex increase that drives NPV to zero", () => {
    const sv = switchingValue(option, config, "capex");
    expect(sv.changePercent).not.toBeNull();
    expect(sv.changePercent!).toBeGreaterThan(0);
    const flexed = {
      ...option,
      capex: option.capex * (1 + sv.changePercent! / 100),
    };
    expect(Math.abs(appraiseOption(flexed, config).npv)).toBeLessThan(1);
    expect(sv.switchesAt).toBeCloseTo(flexed.capex, 0);
  });

  it("finds the benefits reduction that drives NPV to zero", () => {
    const sv = switchingValue(option, config, "benefits");
    expect(sv.changePercent!).toBeLessThan(0);
    const flexed = {
      ...option,
      annualBenefits: option.annualBenefits.map((v) => v * (1 + sv.changePercent! / 100)),
    };
    expect(Math.abs(appraiseOption(flexed, config).npv)).toBeLessThan(1);
  });

  it("reports null with an explanation when the decision never switches", () => {
    // Benefits so large that even +1000% costs cannot make NPV negative.
    const robust = { capex: 1, annualBenefits: [1_000_000], annualCosts: [0] };
    const sv = switchingValue(robust, { ...config, appraisalYears: 1 }, "costs");
    expect(sv.changePercent).toBeNull();
    expect(sv.note).toContain("does not switch");
  });

  it("recognises an option already sitting exactly on zero", () => {
    const breakeven = { capex: 0, annualBenefits: [0], annualCosts: [0] };
    const sv = switchingValue(breakeven, { ...config, appraisalYears: 1 }, "capex");
    expect(sv.changePercent).toBe(0);
    expect(sv.note).toContain("already zero");
  });

  it("produces one switching value per variable in the analysis block", () => {
    const s = sensitivityAnalysis(option, config);
    expect(s.switching.map((v) => v.variable)).toEqual([
      "capex",
      "benefits",
      "costs",
      "discountRate",
    ]);
  });
});
