import { describe, expect, it } from "vitest";
import {
  checkContractAgainstLimit,
  contractToTurnoverRatio,
  DEFAULT_FINANCIAL_LIMIT_RULE,
  deriveRatios,
  recommendSingleProjectLimit,
  type FinancialFigures,
} from "./financial-limits.js";

/**
 * One hand-worked set of accounts, varied one figure at a time.
 *
 *   turnover              10,000,000  -> turnover test    2,500,000  (25%)
 *   net assets               800,000  -> net-assets test  4,000,000  (x5)
 *   largest contract       1,500,000  -> track record     3,000,000  (x2)
 *   current assets         3,000,000
 *   current liabilities    2,000,000  -> current ratio 1.5, no haircut
 *   total debt               400,000  -> gearing 50%,     no haircut
 *   source           audited_accounts -> no provenance haircut
 *
 * Binding test: turnover. Recommendation: GBP 2,500,000.
 */
const base: FinancialFigures = {
  currency: "GBP",
  source: "audited_accounts",
  financialYearEnd: "2025-12-31",
  turnover: 10_000_000,
  operatingProfit: 400_000,
  profitBeforeTax: 350_000,
  netAssets: 800_000,
  currentAssets: 3_000_000,
  currentLiabilities: 2_000_000,
  cashAtBank: 500_000,
  totalDebt: 400_000,
  largestContractValue: 1_500_000,
  orderBookValue: 6_000_000,
};

describe("deriveRatios", () => {
  it("derives working capital, current ratio, gearing and margin", () => {
    const r = deriveRatios(base);
    expect(r.workingCapital.value).toBe(1_000_000);
    expect(r.currentRatio.value).toBe(1.5);
    expect(r.gearingPercent.value).toBe(50);
    expect(r.profitMarginPercent.value).toBe(3.5);
    expect(r.returnOnCapitalPercent.value).toBe(50);
  });

  it("returns null with a reason where an input is missing — never a zero", () => {
    const r = deriveRatios({ ...base, currentLiabilities: null });
    expect(r.workingCapital.value).toBeNull();
    expect(r.currentRatio.value).toBeNull();
    expect(r.workingCapital.reasons[0]).toMatch(/current liabilities was not supplied/i);
  });

  it("refuses the acid test when stock is not on the record", () => {
    const r = deriveRatios(base);
    expect(r.acidTestRatio.value).toBeNull();
    expect(r.acidTestRatio.reasons[0]).toMatch(/excludes stock/i);
  });

  it("derives the acid test once stock is supplied", () => {
    const r = deriveRatios({ ...base, inventory: 1_000_000 });
    // (3,000,000 - 1,000,000) / 2,000,000
    expect(r.acidTestRatio.value).toBe(1);
  });

  it("calls negative net assets undefined rather than reporting a gearing figure", () => {
    const r = deriveRatios({ ...base, netAssets: -50_000 });
    expect(r.gearingPercent.value).toBeNull();
    expect(r.gearingPercent.reasons[0]).toMatch(/balance sheet is itself the finding/i);
  });
});

describe("recommendSingleProjectLimit — the stated rule", () => {
  it("recommends the lowest applicable test and names which one bound it", () => {
    const limit = recommendSingleProjectLimit(base);
    expect(limit.value).toBe(2_500_000);
    expect(limit.bindingTest).toBe("turnover");
    expect(limit.currency).toBe("GBP");
    expect(limit.headroomBeforeFactors).toBe(2_500_000);
    expect(limit.factors).toEqual([]);
    expect(limit.tests.map((t) => t.value)).toEqual([2_500_000, 4_000_000, 3_000_000]);
  });

  it("exposes the basis as prose, never a bare number", () => {
    const limit = recommendSingleProjectLimit(base);
    expect(limit.basis).toContain("2500000");
    expect(limit.basis).toMatch(/Bound by: Turnover x 25%/);
    expect(limit.basis).toMatch(/Other tests allowed more/);
  });

  it("lets the balance sheet bind when net assets are thin", () => {
    // debt trimmed to 200,000 so gearing stays at 67% and does not also bite
    const limit = recommendSingleProjectLimit({ ...base, netAssets: 300_000, totalDebt: 200_000 });
    // 300,000 x 5 = 1,500,000, below the 2,500,000 turnover test
    expect(limit.value).toBe(1_500_000);
    expect(limit.bindingTest).toBe("net_assets");
    expect(limit.factors).toEqual([]);
  });

  it("compounds a thin balance sheet with the gearing it implies", () => {
    // net assets 300,000 against 400,000 of debt is 133% gearing: the
    // net-assets test binds at 1,500,000 and the gearing haircut halves it
    const limit = recommendSingleProjectLimit({ ...base, netAssets: 300_000 });
    expect(limit.bindingTest).toBe("net_assets");
    expect(limit.headroomBeforeFactors).toBe(1_500_000);
    expect(limit.value).toBe(750_000);
    expect(limit.factors.map((f) => f.key)).toEqual(["gearing"]);
  });

  it("lets the track record bind on a contractor stepping up", () => {
    const limit = recommendSingleProjectLimit({ ...base, largestContractValue: 900_000 });
    expect(limit.value).toBe(1_800_000);
    expect(limit.bindingTest).toBe("track_record");
    expect(limit.basis).toMatch(/step change beyond that is a delivery risk/i);
  });

  it("halves the limit for a current ratio below 1.0 and says why", () => {
    // current assets 1,600,000 / current liabilities 2,000,000 = 0.8
    const limit = recommendSingleProjectLimit({ ...base, currentAssets: 1_600_000 });
    expect(limit.value).toBe(1_250_000);
    expect(limit.headroomBeforeFactors).toBe(2_500_000);
    expect(limit.factors.map((f) => f.key)).toEqual(["liquidity"]);
    expect(limit.factors[0]!.why).toMatch(/below 1/i);
  });

  it("halves the limit for gearing above 100% of net assets", () => {
    const limit = recommendSingleProjectLimit({ ...base, totalDebt: 1_200_000 });
    expect(limit.value).toBe(1_250_000);
    expect(limit.factors.map((f) => f.key)).toEqual(["gearing"]);
  });

  it("discounts self-declared figures — evidence is not all the same", () => {
    const limit = recommendSingleProjectLimit({ ...base, source: "self_declared" });
    expect(limit.value).toBe(1_875_000);
    expect(limit.factors.map((f) => f.key)).toEqual(["provenance"]);
    expect(limit.factors[0]!.why).toMatch(/not the same evidence/i);
  });

  it("compounds the haircuts", () => {
    const limit = recommendSingleProjectLimit({
      ...base,
      currentAssets: 1_600_000,
      source: "self_declared",
    });
    // 2,500,000 x 0.5 x 0.75
    expect(limit.value).toBe(937_500);
    expect(limit.factors.map((f) => f.key)).toEqual(["liquidity", "provenance"]);
  });

  it("returns NULL with a reason where turnover is unknown — never a default", () => {
    const limit = recommendSingleProjectLimit({ ...base, turnover: null });
    expect(limit.value).toBeNull();
    expect(limit.bindingTest).toBeNull();
    expect(limit.reasons[0]).toMatch(/Turnover was not supplied/i);
    expect(limit.basis).toMatch(/No single-project limit can be recommended/i);
  });

  it("treats a going-concern qualification as a hard stop, not a score", () => {
    const limit = recommendSingleProjectLimit({ ...base, isGoingConcernQualified: true });
    expect(limit.value).toBe(0);
    expect(limit.bindingTest).toBe("hard_stop");
    expect(limit.basis).toMatch(/going concern/i);
    expect(limit.basis).toMatch(/hard stop, not a score/i);
  });

  it("treats a recorded insolvency event the same way", () => {
    const limit = recommendSingleProjectLimit({ ...base, insolvencyEventCount: 1 });
    expect(limit.value).toBe(0);
    expect(limit.bindingTest).toBe("hard_stop");
  });

  it("says which tests it could not apply", () => {
    const limit = recommendSingleProjectLimit({
      ...base,
      netAssets: null,
      largestContractValue: null,
    });
    expect(limit.value).toBe(2_500_000);
    expect(limit.reasons.join(" ")).toMatch(/Net assets were not supplied/i);
    expect(limit.reasons.join(" ")).toMatch(/largest contract delivered to date/i);
  });

  it("carries the rule it applied so the caller can show its working", () => {
    const limit = recommendSingleProjectLimit(base);
    expect(limit.rule).toEqual(DEFAULT_FINANCIAL_LIMIT_RULE);
    expect(limit.rule.turnoverShare).toBe(0.25);
  });

  it("honours an overridden rule", () => {
    const limit = recommendSingleProjectLimit(base, deriveRatios(base), {
      ...DEFAULT_FINANCIAL_LIMIT_RULE,
      turnoverShare: 0.33,
    });
    expect(limit.value).toBe(3_000_000); // 3,300,000 turnover test now beaten by track record
    expect(limit.bindingTest).toBe("track_record");
  });
});

describe("checkContractAgainstLimit", () => {
  const limit = 2_500_000;

  it("passes a contract inside the limit", () => {
    const check = checkContractAgainstLimit({
      contractValue: 2_000_000,
      contractCurrency: "GBP",
      limit,
      limitCurrency: "GBP",
      vendorName: "Groundworks Ltd",
    });
    expect(check.exceeds).toBe(false);
    expect(check.severity).toBe("none");
    expect(check.ratio).toBe(0.8);
  });

  it("warns on a contract over the limit", () => {
    const check = checkContractAgainstLimit({
      contractValue: 3_000_000,
      contractCurrency: "GBP",
      limit,
      limitCurrency: "GBP",
      vendorName: "Groundworks Ltd",
    });
    expect(check.exceeds).toBe(true);
    expect(check.severity).toBe("warning");
    expect(check.message).toMatch(/exceeds Groundworks Ltd's recommended single-project limit/i);
  });

  it("escalates to critical at 150% of the limit", () => {
    const check = checkContractAgainstLimit({
      contractValue: 4_000_000,
      contractCurrency: "GBP",
      limit,
      limitCurrency: "GBP",
      vendorName: "Groundworks Ltd",
    });
    expect(check.severity).toBe("critical");
    expect(check.ratio).toBe(1.6);
  });

  it("refuses to compare across currencies", () => {
    const check = checkContractAgainstLimit({
      contractValue: 2_000_000,
      contractCurrency: "USD",
      limit,
      limitCurrency: "GBP",
      vendorName: "Groundworks Ltd",
    });
    expect(check.exceeds).toBeNull();
    expect(check.message).toMatch(/never compared here/i);
  });

  it("says so when the vendor has no limit on the record", () => {
    const check = checkContractAgainstLimit({
      contractValue: 2_000_000,
      contractCurrency: "GBP",
      limit: null,
      limitCurrency: null,
      vendorName: "Groundworks Ltd",
    });
    expect(check.exceeds).toBeNull();
    expect(check.severity).toBe("warning");
    expect(check.message).toMatch(/no recommended single-project limit on the record/i);
  });

  it("treats a zero limit (hard stop) as exceeded by any value", () => {
    const check = checkContractAgainstLimit({
      contractValue: 1,
      contractCurrency: "GBP",
      limit: 0,
      limitCurrency: "GBP",
      vendorName: "Groundworks Ltd",
    });
    expect(check.exceeds).toBe(true);
    expect(check.severity).toBe("critical");
    expect(check.message).toMatch(/hard stop/i);
  });
});

describe("contractToTurnoverRatio", () => {
  it("expresses a contract as a share of turnover", () => {
    expect(contractToTurnoverRatio(2_500_000, 10_000_000).value).toBe(0.25);
  });

  it("refuses where turnover is unknown", () => {
    const r = contractToTurnoverRatio(2_500_000, null);
    expect(r.value).toBeNull();
    expect(r.reasons[0]).toMatch(/turnover is not recorded/i);
  });
});
