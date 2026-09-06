/**
 * Unit tests for the designated-account and availability-payment engines.
 *
 * Both are pure arithmetic over recorded facts, so they are tested here with
 * exact expected values rather than through the API — a change in either
 * that moves a number should fail loudly at this level first.
 */
import { describe, expect, it } from "vitest";
import { computeAccountPosition, entrySign, reconcileAccount } from "./accounts.js";
import { computeAvailabilityPayment } from "./availability.js";

/* ------------------------------------------------------------------ */
/* Designated account                                                  */
/* ------------------------------------------------------------------ */

describe("entrySign", () => {
  it("treats money in as positive and everything else as negative", () => {
    expect(entrySign("advance")).toBe(1);
    expect(entrySign("replenishment")).toBe(1);
    expect(entrySign("interest_earned")).toBe(1);
    expect(entrySign("eligible_expenditure")).toBe(-1);
    expect(entrySign("ineligible_expenditure")).toBe(-1);
    expect(entrySign("bank_charge")).toBe(-1);
    expect(entrySign("refund_to_lender")).toBe(-1);
    expect(entrySign("transfer_out")).toBe(-1);
  });

  it("refuses to count an unknown kind as money in", () => {
    // A kind the enum does not know must not silently increase the balance:
    // an unrecognised deposit is a far worse error than an unrecognised
    // withdrawal.
    expect(entrySign("something_new")).toBe(-1);
  });
});

describe("computeAccountPosition", () => {
  const entries = [
    { entryDate: "2026-01-05", kind: "advance", amount: 500_000 },
    { entryDate: "2026-02-10", kind: "eligible_expenditure", amount: 180_000 },
    { entryDate: "2026-02-28", kind: "bank_charge", amount: 250 },
    { entryDate: "2026-03-15", kind: "ineligible_expenditure", amount: 20_000 },
    { entryDate: "2026-03-31", kind: "interest_earned", amount: 1_200 },
    { entryDate: "2026-04-15", kind: "replenishment", amount: 150_000 },
  ];

  it("rolls the ledger forward with the right signs", () => {
    const p = computeAccountPosition(
      { openingBalance: 0, authorisedCeiling: 600_000 },
      entries,
      "2026-04-30",
    );
    // 500,000 − 180,000 − 250 − 20,000 + 1,200 + 150,000
    expect(p.balance).toBe(450_950);
    expect(p.advances).toBe(500_000);
    expect(p.replenishments).toBe(150_000);
    expect(p.eligibleExpenditure).toBe(180_000);
    expect(p.ineligibleExpenditure).toBe(20_000);
    expect(p.interestEarned).toBe(1_200);
    expect(p.entryCount).toBe(6);
    expect(p.overCeiling).toBe(false);
    expect(p.ceilingHeadroom).toBe(149_050);
  });

  it("excludes entries after the as-at date rather than netting them", () => {
    const p = computeAccountPosition(
      { openingBalance: 0, authorisedCeiling: 600_000 },
      entries,
      "2026-03-01",
    );
    // Only the advance, the eligible expenditure and the bank charge are in.
    expect(p.balance).toBe(319_750);
    expect(p.entryCount).toBe(3);
    expect(p.replenishments).toBe(0);
  });

  it("reports the outstanding advance and how much of it is documented", () => {
    const p = computeAccountPosition(
      { openingBalance: 0, authorisedCeiling: null },
      entries,
      "2026-04-30",
    );
    // advanced 650,000; documented as eligible 180,000
    expect(p.outstandingAdvance).toBe(470_000);
    expect(p.documentedPercent).toBeCloseTo(27.69, 2);
    expect(p.ceilingHeadroom).toBeNull();
    expect(p.overCeiling).toBe(false);
  });

  it("returns null rather than zero for documented percent when nothing was advanced", () => {
    const p = computeAccountPosition(
      { openingBalance: 10_000, authorisedCeiling: 10_000 },
      [{ entryDate: "2026-01-02", kind: "bank_charge", amount: 100 }],
      "2026-01-31",
    );
    expect(p.documentedPercent).toBeNull();
    expect(p.balance).toBe(9_900);
  });

  it("flags a balance above the authorised ceiling", () => {
    const p = computeAccountPosition(
      { openingBalance: 0, authorisedCeiling: 400_000 },
      [{ entryDate: "2026-01-05", kind: "advance", amount: 450_000 }],
      "2026-01-31",
    );
    expect(p.overCeiling).toBe(true);
    expect(p.ceilingHeadroom).toBe(-50_000);
  });
});

describe("reconcileAccount", () => {
  it("reconciles within tolerance and names the difference outside it", () => {
    const ok = reconcileAccount({ statementBalance: 100_000, computedBalance: 100_000 });
    expect(ok.outcome).toBe("reconciled");
    expect(ok.difference).toBe(0);

    const near = reconcileAccount({
      statementBalance: 100_000.01,
      computedBalance: 100_000,
      tolerance: 0.05,
    });
    expect(near.outcome).toBe("reconciled");

    const off = reconcileAccount({ statementBalance: 97_500, computedBalance: 100_000 });
    expect(off.outcome).toBe("unreconciled");
    expect(off.difference).toBe(-2_500);
    expect(off.explanation).toMatch(/lower than the account ledger by 2500/);
  });
});

/* ------------------------------------------------------------------ */
/* Availability payment mechanism                                      */
/* ------------------------------------------------------------------ */

const MODEL = {
  unitaryCharge: 1_000_000,
  currency: "GBP",
  availabilityWeightPercent: 70,
  performanceWeightPercent: 30,
  performancePointValuePercent: 0.1,
  deductionCapPercent: null,
  persistentBreachPoints: null,
};

describe("computeAvailabilityPayment", () => {
  it("pays the whole charge for a period with no failures", () => {
    const r = computeAvailabilityPayment(MODEL, {
      requiredHours: 720,
      events: [],
      performancePoints: 0,
    });
    expect(r.availabilityDeduction).toBe(0);
    expect(r.performanceDeduction).toBe(0);
    expect(r.netPayment).toBe(1_000_000);
    expect(r.availabilityRatio).toBe(1);
  });

  it("weights unavailability by area", () => {
    const r = computeAvailabilityPayment(MODEL, {
      requiredHours: 720,
      events: [
        { area: "Ward block", hours: 72, weight: 0.5 },
        { area: "Plant room", hours: 72, weight: 0.05 },
      ],
      performancePoints: 0,
    });
    // weighted hours = 36 + 3.6 = 39.6 of 720 → 5.5% unavailable
    expect(r.weightedUnavailableHours).toBeCloseTo(39.6, 4);
    expect(r.availabilityRatio).toBeCloseTo(0.945, 4);
    // 1,000,000 × 70% × 0.055
    expect(r.availabilityDeduction).toBeCloseTo(38_500, 2);
    expect(r.netPayment).toBeCloseTo(961_500, 2);
  });

  it("deducts performance points at their contractual value", () => {
    const r = computeAvailabilityPayment(MODEL, {
      requiredHours: 720,
      events: [],
      performancePoints: 40,
    });
    // 40 points × 0.1% = 4% of the performance element (30% of the charge)
    expect(r.performanceDeduction).toBeCloseTo(12_000, 2);
    expect(r.netPayment).toBeCloseTo(988_000, 2);
  });

  it("applies the contractual cap and reports the uncapped figure", () => {
    const r = computeAvailabilityPayment(
      { ...MODEL, deductionCapPercent: 5 },
      {
        requiredHours: 720,
        events: [{ area: "Whole asset", hours: 360, weight: 1 }],
        performancePoints: 100,
      },
    );
    expect(r.rawDeduction).toBeGreaterThan(50_000);
    expect(r.totalDeduction).toBe(50_000);
    expect(r.capApplied).toBe(true);
    expect(r.netPayment).toBe(950_000);
    expect(r.warnings.join(" ")).toMatch(/cap/i);
  });

  it("never deducts more than the whole element it applies to", () => {
    const r = computeAvailabilityPayment(MODEL, {
      requiredHours: 100,
      events: [{ area: "Whole asset", hours: 500, weight: 1 }],
      performancePoints: 5_000,
    });
    expect(r.availabilityDeduction).toBeCloseTo(700_000, 2);
    expect(r.performanceDeduction).toBeCloseTo(300_000, 2);
    expect(r.netPayment).toBe(0);
    expect(r.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("leaves availability uncomputable — not zero — when no hours were required", () => {
    const r = computeAvailabilityPayment(MODEL, {
      requiredHours: 0,
      events: [{ area: "Ward block", hours: 10, weight: 1 }],
      performancePoints: 0,
    });
    expect(r.availabilityRatio).toBeNull();
    expect(r.availabilityDeduction).toBe(0);
    expect(r.warnings.join(" ")).toMatch(/no required availability hours/i);
  });

  it("reports a persistent breach without applying a remedy of its own", () => {
    const r = computeAvailabilityPayment(
      { ...MODEL, persistentBreachPoints: 100 },
      { requiredHours: 720, events: [], performancePoints: 120 },
    );
    expect(r.persistentBreach).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/persistent-breach threshold/i);
    // The payment is still computed normally — the remedy is the contract's.
    expect(r.netPayment).toBeGreaterThan(0);
  });
});
