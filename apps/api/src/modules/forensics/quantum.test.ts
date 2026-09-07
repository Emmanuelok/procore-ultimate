import { describe, expect, it } from "vitest";
import {
  computeProvision,
  eichleay,
  emden,
  financeCharge,
  hudson,
  lossOfProfit,
  siteOverhead,
} from "./quantum.js";

describe("Hudson formula", () => {
  it("computes the daily rate from the tendered percentage", () => {
    const r = hudson({ contractSum: 10_000_000, contractPeriodDays: 500, hoProfitPercent: 7, delayDays: 30 });
    expect(r.ok).toBe(true);
    // 0.07 × (10,000,000 / 500) = 1,400/day × 30 = 42,000
    expect(r.amount).toBe(42_000);
    expect(r.workings).toContain("42,000");
    expect(r.assumptions.join(" ")).toMatch(/PRICED/);
  });

  it("refuses to guess a missing input", () => {
    const r = hudson({ contractSum: null, contractPeriodDays: 500, hoProfitPercent: 7, delayDays: 30 });
    expect(r.ok).toBe(false);
    expect(r.amount).toBeNull();
    expect(r.missing).toEqual(["contractSum"]);
  });

  it("refuses a zero delay", () => {
    const r = hudson({ contractSum: 1000, contractPeriodDays: 10, hoProfitPercent: 5, delayDays: 0 });
    expect(r.missing).toContain("delayDays");
  });
});

describe("Emden formula", () => {
  it("uses the actual overhead rate and names its source", () => {
    const r = emden({
      contractSum: 5_000_000,
      contractPeriodDays: 250,
      actualOverheadPercent: 4,
      delayDays: 20,
      accountsPeriod: "FY2025",
    });
    expect(r.ok).toBe(true);
    expect(r.amount).toBe(16_000); // 0.04 × 20,000/day × 20
    expect(r.assumptions.join(" ")).toContain("FY2025");
  });
});

describe("Eichleay formula", () => {
  it("allocates overhead by billings share and spreads it over performance days", () => {
    const r = eichleay({
      contractBillings: 2_000_000,
      totalBillings: 10_000_000,
      totalOverhead: 1_000_000,
      performanceDays: 400,
      delayDays: 50,
    });
    expect(r.ok).toBe(true);
    // 0.2 × 1,000,000 = 200,000 allocable; /400 = 500/day; ×50 = 25,000
    expect(r.amount).toBe(25_000);
    expect(r.assumptions.join(" ")).toMatch(/standby/);
  });

  it("rejects contract billings greater than total billings", () => {
    const r = eichleay({
      contractBillings: 20_000_000,
      totalBillings: 10_000_000,
      totalOverhead: 1_000_000,
      performanceDays: 400,
      delayDays: 50,
    });
    expect(r.ok).toBe(false);
    expect(r.missing[0]).toMatch(/exceeds/);
  });
});

describe("site overhead", () => {
  it("derives the daily rate from time-related preliminaries", () => {
    const r = siteOverhead({ prelimsTimeTotal: 1_200_000, programmeDays: 600, delayDays: 45 });
    expect(r.ok).toBe(true);
    expect(r.amount).toBe(90_000); // 2,000/day × 45
    expect(r.workings).toContain("2,000");
  });

  it("prefers an explicit rate and adds attributable fixed preliminaries", () => {
    const r = siteOverhead({
      prelimsTimeTotal: 1_200_000,
      programmeDays: 600,
      ratePerDay: 2500,
      fixedPrelimsAttributable: 10_000,
      delayDays: 10,
    });
    expect(r.amount).toBe(35_000);
    expect(r.assumptions.join(" ")).toMatch(/fixed preliminaries/);
  });

  it("says what is missing when it can neither derive nor be told the rate", () => {
    const r = siteOverhead({ prelimsTimeTotal: null, programmeDays: null, delayDays: 10 });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["prelimsTimeTotal", "programmeDays"]);
  });
});

describe("finance charge", () => {
  it("computes simple interest", () => {
    const r = financeCharge({ principal: 365_000, annualRatePercent: 10, days: 365, basis: "simple" });
    expect(r.amount).toBe(36_500);
  });

  it("compounds daily when asked", () => {
    const simple = financeCharge({ principal: 100_000, annualRatePercent: 10, days: 365, basis: "simple" });
    const compound = financeCharge({ principal: 100_000, annualRatePercent: 10, days: 365, basis: "compound" });
    expect(compound.amount!).toBeGreaterThan(simple.amount!);
    expect(compound.formula).toContain("^");
  });

  it("records the rate's source in the assumptions", () => {
    const r = financeCharge({
      principal: 1000,
      annualRatePercent: 8,
      days: 30,
      basis: "simple",
      rateSource: "Late Payment of Commercial Debts Act",
    });
    expect(r.assumptions.join(" ")).toContain("Late Payment");
  });
});

describe("loss of profit", () => {
  it("derives displaced turnover from the contract when not supplied", () => {
    const r = lossOfProfit({
      marginPercent: 5,
      contractSum: 3_650_000,
      contractPeriodDays: 365,
      delayDays: 100,
    });
    expect(r.ok).toBe(true);
    expect(r.amount).toBe(50_000); // 1,000,000 displaced × 5%
  });

  it("warns when there is no lost-opportunity evidence", () => {
    const r = lossOfProfit({ marginPercent: 5, displacedTurnover: 100_000, delayDays: 10 });
    expect(r.assumptions.join(" ")).toMatch(/usually fails without it/);
  });
});

describe("provision (#312-313)", () => {
  it("computes provision from the likely case and the probability of success", () => {
    const r = computeProvision({ best: 100_000, likely: 250_000, worst: 500_000, successProbability: 0.6 });
    expect(r.ok).toBe(true);
    expect(r.provision).toBe(150_000);
    expect(r.expectedValue).toBe(266_666.67);
  });

  it("returns null rather than zero when the range is missing", () => {
    const r = computeProvision({ best: null, likely: null, worst: null, successProbability: 0.5 });
    expect(r.ok).toBe(false);
    expect(r.provision).toBeNull();
    expect(r.reasons.join(" ")).toMatch(/No likely valuation/);
  });

  it("flags an incoherent range", () => {
    const r = computeProvision({ best: 100, likely: 50, worst: 200, successProbability: 0.5 });
    expect(r.reasons.join(" ")).toMatch(/outside the best-worst range/);
  });
});
