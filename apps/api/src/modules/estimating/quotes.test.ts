import { describe, expect, it } from "vitest";
import {
  levelQuotes,
  medianAbsoluteDeviation,
  normaliseScopeKey,
  type QuoteInput,
} from "./quotes.js";

/** Sub-quote levelling (spec Vol I #202–203). */

const quote = (
  id: string,
  vendorName: string,
  lines: Array<{ scope: string; amount: number; excluded?: boolean; rate?: number }>,
  over: Partial<QuoteInput> = {},
): QuoteInput => ({
  id,
  vendorName,
  tradePackage: "Groundworks",
  status: "received",
  currency: "GBP",
  quotedTotal: lines.filter((l) => !l.excluded).reduce((s, l) => s + l.amount, 0),
  adjustmentAmount: 0,
  lines: lines.map((l, i) => ({
    quoteId: id,
    vendorName,
    lineId: `${id}-${i}`,
    scopeKey: l.scope,
    description: l.scope,
    unit: "m3",
    quantity: 100,
    unitRate: l.rate ?? null,
    amount: l.amount,
    excluded: l.excluded ?? false,
  })),
  ...over,
});

describe("helpers", () => {
  it("normalises a scope key", () => {
    expect(normaliseScopeKey("  Bulk   EXCAVATION ")).toBe("bulk excavation");
  });

  it("computes a scaled median absolute deviation", () => {
    expect(medianAbsoluteDeviation([])).toBeNull();
    expect(medianAbsoluteDeviation([10, 10, 10])).toBe(0);
    expect(medianAbsoluteDeviation([1, 2, 3, 4])).toBeCloseTo(1.4826, 4);
  });
});

describe("levelQuotes", () => {
  const quotes = [
    quote("q1", "Alpha", [
      { scope: "Bulk excavation", amount: 10000 },
      { scope: "Disposal", amount: 4000 },
      { scope: "Piling mat", amount: 3000 },
    ]),
    quote("q2", "Beta", [
      { scope: "Bulk excavation", amount: 10500 },
      { scope: "Disposal", amount: 4200 },
    ]),
    quote("q3", "Gamma", [
      { scope: "Bulk excavation", amount: 9800 },
      { scope: "Disposal", amount: 40000 },
      { scope: "Piling mat", amount: 3100 },
    ]),
  ];

  it("builds a scope row per neutral key with low/high/median", () => {
    const res = levelQuotes(quotes);
    const bulk = res.rows.find((r) => r.scopeKey === "bulk excavation");
    expect(bulk?.pricedCount).toBe(3);
    expect(bulk?.low).toBe(9800);
    expect(bulk?.high).toBe(10500);
    expect(bulk?.median).toBe(10000);
    expect(bulk?.verdict).toBe("Prices are consistent.");
  });

  it("names the bidders who never mentioned a row — the real scope gap", () => {
    const res = levelQuotes(quotes);
    const mat = res.rows.find((r) => r.scopeKey === "piling mat");
    expect(mat?.missingVendors).toEqual(["Beta"]);
    expect(res.scopeGaps.map((g) => g.scopeKey)).toContain("piling mat");
  });

  it("flags an outlier by median absolute deviation", () => {
    const res = levelQuotes(quotes);
    expect(res.outliers).toHaveLength(1);
    expect(res.outliers[0]?.vendorName).toBe("Gamma");
    expect(res.outliers[0]?.direction).toBe("high");
    expect(res.outliers[0]?.median).toBe(4200);
  });

  it("refuses to call an outlier with too few prices", () => {
    const res = levelQuotes([
      quote("a", "A", [{ scope: "X", amount: 100 }]),
      quote("b", "B", [{ scope: "X", amount: 9000 }]),
    ]);
    expect(res.outliers).toHaveLength(0);
    expect(res.rows[0]?.verdict).toMatch(/too few to call an outlier/);
  });

  it("calls out identical pricing as a cover-pricing smell", () => {
    const res = levelQuotes([
      quote("a", "A", [{ scope: "X", amount: 1000 }]),
      quote("b", "B", [{ scope: "X", amount: 1000 }]),
      quote("c", "C", [{ scope: "X", amount: 1000 }]),
    ]);
    expect(res.rows[0]?.verdict).toMatch(/cover pricing/);
  });

  it("calls out a wide spread as a scope-reading difference", () => {
    const res = levelQuotes([
      quote("a", "A", [{ scope: "X", amount: 1000 }]),
      quote("b", "B", [{ scope: "X", amount: 1400 }]),
      quote("c", "C", [{ scope: "X", amount: 2000 }]),
    ]);
    expect(res.rows[0]?.verdict).toMatch(/read differently/);
  });

  it("fills unpriced rows at the pack median so the totals compare", () => {
    const res = levelQuotes(quotes);
    const beta = res.totals.find((t) => t.vendorName === "Beta");
    expect(beta?.missingRows).toBe(1);
    // 10500 + 4200 + the pack median of the piling mat (3050)
    expect(beta?.comparableTotal).toBe(17750);
    expect(beta?.comparableBasis).toMatch(/pack median/);
  });

  it("states that no comparable total exists when a gap has no pack median", () => {
    const res = levelQuotes([
      quote("a", "A", [{ scope: "X", amount: 100 }, { scope: "Y", amount: 200, excluded: true }]),
      quote("b", "B", [{ scope: "X", amount: 120 }]),
    ]);
    const a = res.totals.find((t) => t.vendorName === "A");
    expect(a?.comparableTotal).toBeNull();
    expect(a?.comparableBasis).toMatch(/no pack median/);
  });

  it("applies a levelling adjustment to the quoted total", () => {
    const res = levelQuotes([
      quote("a", "A", [{ scope: "X", amount: 1000 }], { adjustmentAmount: 250 }),
    ]);
    expect(res.totals[0]?.levelledTotal).toBe(1250);
  });

  it("refuses to compare across currencies and says so", () => {
    const res = levelQuotes([
      quote("a", "A", [{ scope: "X", amount: 1000 }]),
      quote("b", "B", [{ scope: "X", amount: 1200 }], { currency: "EUR" }),
    ]);
    expect(res.currency).toBeNull();
    expect(res.currencies).toEqual(["EUR", "GBP"]);
    expect(res.warnings.join(" ")).toMatch(/NOT summed or converted/);
  });

  it("warns when the quotes span different packages", () => {
    const res = levelQuotes([
      quote("a", "A", [{ scope: "X", amount: 1 }]),
      quote("b", "B", [{ scope: "X", amount: 1 }], { tradePackage: "Roofing" }),
    ]);
    expect(res.tradePackage).toBeNull();
    expect(res.warnings.join(" ")).toMatch(/trade packages/);
  });

  it("keeps only the first of a duplicated scope row and says so", () => {
    const res = levelQuotes([
      quote("a", "A", [
        { scope: "X", amount: 100 },
        { scope: "X", amount: 900 },
      ]),
    ]);
    expect(res.rows[0]?.entries).toHaveLength(1);
    expect(res.rows[0]?.entries[0]?.amount).toBe(100);
    expect(res.warnings.join(" ")).toMatch(/more than once/);
  });

  it("counts an explicit exclusion apart from a silent omission", () => {
    const res = levelQuotes([
      quote("a", "A", [{ scope: "X", amount: 100 }, { scope: "Y", amount: 0, excluded: true }]),
      quote("b", "B", [{ scope: "X", amount: 110 }, { scope: "Y", amount: 500 }]),
      quote("c", "C", [{ scope: "X", amount: 105 }, { scope: "Y", amount: 520 }]),
    ]);
    const y = res.rows.find((r) => r.scopeKey === "y");
    expect(y?.excludedCount).toBe(1);
    expect(y?.pricedCount).toBe(2);
    const a = res.totals.find((t) => t.vendorName === "A");
    expect(a?.excludedRows).toBe(1);
    expect(a?.missingRows).toBe(0);
  });

  it("sorts totals cheapest-comparable first", () => {
    const res = levelQuotes(quotes);
    expect(res.totals[0]?.vendorName).toBe("Alpha");
  });
});
