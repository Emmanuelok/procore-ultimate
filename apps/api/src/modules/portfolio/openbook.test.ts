import { describe, expect, it } from "vitest";
import {
  componentLabel,
  disallowedSummary,
  extrapolate,
  verificationTotals,
  type DefinedCostItemRow,
  type DisallowedRow,
} from "./openbook.js";

const item = (over: Partial<DefinedCostItemRow> & { id: string }): DefinedCostItemRow => ({
  component: "people",
  currency: "GBP",
  claimedAmount: 0,
  verifiedAmount: 0,
  verdict: "pending",
  evidenceRef: "TS-001",
  evidenceId: null,
  ...over,
});

describe("verificationTotals (#1065)", () => {
  it("classifies each verdict into the right bucket", () => {
    const totals = verificationTotals(
      [
        item({ id: "1", claimedAmount: 1000, verifiedAmount: 1000, verdict: "verified" }),
        item({ id: "2", claimedAmount: 500, verdict: "queried" }),
        item({ id: "3", claimedAmount: 400, verdict: "disallowed" }),
        item({ id: "4", claimedAmount: 300, verifiedAmount: 200, verdict: "partially_disallowed" }),
        item({ id: "5", claimedAmount: 100, verdict: "pending" }),
      ],
      "GBP",
    );
    expect(totals.claimed).toBe(2300);
    expect(totals.verified).toBe(1200);
    expect(totals.queried).toBe(500);
    expect(totals.disallowed).toBe(500); // 400 + the 100 balance of item 4
    expect(totals.pending).toBe(100);
    expect(totals.verificationRatePercent).toBeCloseTo(52.17, 2);
    expect(totals.disallowanceRatePercent).toBeCloseTo(21.74, 2);
  });

  it("treats a verified item with no explicit verified amount as fully verified", () => {
    const totals = verificationTotals([item({ id: "1", claimedAmount: 800, verdict: "verified" })], "GBP");
    expect(totals.verified).toBe(800);
  });

  it("excludes items in another currency rather than converting them", () => {
    const totals = verificationTotals(
      [item({ id: "1", claimedAmount: 100, verifiedAmount: 100, verdict: "verified" }), item({ id: "2", claimedAmount: 999, currency: "EUR" })],
      "GBP",
    );
    expect(totals.claimed).toBe(100);
    expect(totals.currencyMismatches).toBe(1);
    expect(totals.reasons.join(" ")).toMatch(/excluded from every total/);
  });

  it("counts items with no evidence and says why that matters", () => {
    const totals = verificationTotals(
      [item({ id: "1", claimedAmount: 100, verifiedAmount: 100, verdict: "verified", evidenceRef: null })],
      "GBP",
    );
    expect(totals.itemsWithoutEvidence).toBe(1);
    expect(totals.reasons.join(" ")).toMatch(/assertion, not a verification/);
  });

  it("aggregates by SoCC component, largest claim first", () => {
    const totals = verificationTotals(
      [
        item({ id: "1", component: "people", claimedAmount: 100, verifiedAmount: 100, verdict: "verified" }),
        item({ id: "2", component: "equipment", claimedAmount: 500, verifiedAmount: 250, verdict: "partially_disallowed" }),
        item({ id: "3", component: "equipment", claimedAmount: 200, verdict: "queried" }),
      ],
      "GBP",
    );
    expect(totals.byComponent.map((c) => c.component)).toEqual(["equipment", "people"]);
    const equipment = totals.byComponent[0]!;
    expect(equipment.items).toBe(2);
    expect(equipment.claimed).toBe(700);
    expect(equipment.disallowed).toBe(250);
    expect(equipment.verificationRatePercent).toBeCloseTo(35.71, 2);
  });

  it("returns null rates when nothing was claimed", () => {
    const totals = verificationTotals([], "GBP");
    expect(totals.verificationRatePercent).toBeNull();
    expect(totals.disallowanceRatePercent).toBeNull();
  });
});

describe("extrapolate (#1063)", () => {
  const totals = verificationTotals(
    [
      item({ id: "1", claimedAmount: 900, verifiedAmount: 900, verdict: "verified" }),
      item({ id: "2", claimedAmount: 100, verdict: "disallowed" }),
    ],
    "GBP",
  );

  it("projects the observed rate onto the untested value with its assumptions stated", () => {
    const out = extrapolate(totals, { populationValue: 10_000, populationCount: 200, sampleCount: 20, confidence: 90 });
    expect(out.extrapolable).toBe(true);
    expect(out.observedRatePercent).toBe(10);
    expect(out.untestedValue).toBe(9_000);
    expect(out.projectedDisallowance).toBe(900);
    expect(out.coveragePercent).toBe(10);
    expect(out.basis.join(" ")).toMatch(/projection from a sample, not a finding/);
  });

  it("refuses to project without a population value", () => {
    const out = extrapolate(totals, {});
    expect(out.extrapolable).toBe(false);
    expect(out.observedRatePercent).toBe(10);
    expect(out.projectedDisallowance).toBeNull();
    expect(out.reasons.join(" ")).toMatch(/population value was not recorded/);
  });

  it("refuses when the tested value exceeds the stated population", () => {
    const out = extrapolate(totals, { populationValue: 500 });
    expect(out.extrapolable).toBe(false);
    expect(out.reasons.join(" ")).toMatch(/sampling plan and the items disagree/);
  });

  it("refuses when nothing has been tested", () => {
    const out = extrapolate(verificationTotals([], "GBP"), { populationValue: 1000 });
    expect(out.extrapolable).toBe(false);
    expect(out.reasons[0]).toMatch(/Nothing has been tested/);
  });

  it("notes a missing confidence level and missing counts", () => {
    const out = extrapolate(totals, { populationValue: 10_000 });
    expect(out.extrapolable).toBe(true);
    expect(out.reasons.join(" ")).toMatch(/No confidence level/);
    expect(out.reasons.join(" ")).toMatch(/counts are not both recorded/);
  });
});

describe("disallowedSummary (#1066)", () => {
  const row = (over: Partial<DisallowedRow> & { id: string }): DisallowedRow => ({
    category: "not_defined_cost",
    status: "raised",
    currency: "GBP",
    amount: 0,
    deductedAmount: 0,
    raisedAt: "2026-08-01",
    responseDueAt: null,
    groundClause: "NEC4 11.2(25)",
    ...over,
  });

  it("buckets by currency and never combines them", () => {
    const summary = disallowedSummary(
      [
        row({ id: "1", amount: 1000 }),
        row({ id: "2", amount: 500, status: "disputed" }),
        row({ id: "3", amount: 250, status: "deducted", deductedAmount: 250 }),
        row({ id: "4", amount: 700, currency: "EUR" }),
      ],
      "2026-09-02",
    );
    const gbp = summary.byCurrency.find((b) => b.currency === "GBP")!;
    expect(gbp.raised).toBe(1750);
    expect(gbp.disputed).toBe(500);
    expect(gbp.deducted).toBe(250);
    expect(gbp.outstanding).toBe(1500); // raised + disputed, not the deducted one
    expect(summary.byCurrency).toHaveLength(2);
    expect(summary.reasons.join(" ")).toMatch(/never combined/);
  });

  it("counts unresolved, overdue responses and the oldest age", () => {
    const summary = disallowedSummary(
      [
        row({ id: "1", amount: 100, raisedAt: "2026-06-01", responseDueAt: "2026-07-01" }),
        row({ id: "2", amount: 100, raisedAt: "2026-08-20", responseDueAt: "2026-10-01" }),
        row({ id: "3", amount: 100, status: "accepted", raisedAt: "2026-01-01" }),
      ],
      "2026-09-02",
    );
    expect(summary.unresolved).toBe(2);
    expect(summary.overdueResponses).toBe(1);
    expect(summary.oldestUnresolvedDays).toBe(93);
  });

  it("names disallowances that cite no clause", () => {
    const summary = disallowedSummary([row({ id: "1", amount: 10, groundClause: null })], "2026-09-02");
    expect(summary.withoutGround).toBe(1);
    expect(summary.reasons.join(" ")).toMatch(/an opinion and will not survive adjudication/);
  });

  it("groups by category, most frequent first", () => {
    const summary = disallowedSummary(
      [
        row({ id: "1", category: "insufficient_records" }),
        row({ id: "2", category: "insufficient_records", currency: "EUR" }),
        row({ id: "3", category: "duplicate_claim" }),
      ],
      "2026-09-02",
    );
    expect(summary.byCategory[0]).toEqual({ category: "insufficient_records", count: 2, currencies: ["EUR", "GBP"] });
  });

  it("returns an empty summary for an empty register", () => {
    const summary = disallowedSummary([], "2026-09-02");
    expect(summary.byCurrency).toEqual([]);
    expect(summary.oldestUnresolvedDays).toBeNull();
  });
});

describe("componentLabel", () => {
  it("humanises a SoCC heading", () => {
    expect(componentLabel("plant_and_materials")).toBe("Plant And Materials");
  });
});
