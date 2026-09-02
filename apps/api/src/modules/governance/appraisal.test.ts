import { describe, expect, it } from "vitest";
import {
  appraiseOption,
  benefitProgressPercent,
  benefitStatusFor,
  padToYears,
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
