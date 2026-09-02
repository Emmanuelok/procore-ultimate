import { describe, expect, it } from "vitest";
import {
  buildRateLookup,
  convert,
  normalizeCurrency,
  resolveRate,
  splitPayment,
  validatePortions,
  type Portion,
  type RateQuote,
} from "./fx.js";

const quote = (
  fromCurrency: string,
  toCurrency: string,
  rate: number,
  rateDate: string,
  source = "market",
): RateQuote => ({ fromCurrency, toCurrency, rate, rateDate, source });

/* ------------------------------------------------------------------ */
/* Portions (#593-595)                                                 */
/* ------------------------------------------------------------------ */

describe("validatePortions", () => {
  it("accepts a split summing to exactly 100 and uppercases codes", () => {
    const res = validatePortions([
      { currency: "eur", proportionPercent: 60, baseRate: 1 },
      { currency: "ngn", proportionPercent: 40, baseRate: 0.8 },
    ]);
    expect(res.ok).toBe(true);
    expect(res.sum).toBe(100);
    expect(res.portions.map((p) => p.currency)).toEqual(["EUR", "NGN"]);
  });

  it("accepts thirds inside the ±0.01 tolerance", () => {
    const res = validatePortions([
      { currency: "USD", proportionPercent: 33.33, baseRate: 1 },
      { currency: "EUR", proportionPercent: 33.33, baseRate: 0.9 },
      { currency: "GBP", proportionPercent: 33.34, baseRate: 0.8 },
    ]);
    expect(res.ok).toBe(true);
  });

  it("rejects a split that misses 100 by more than the tolerance", () => {
    const res = validatePortions([
      { currency: "USD", proportionPercent: 60, baseRate: 1 },
      { currency: "EUR", proportionPercent: 39.5, baseRate: 0.9 },
    ]);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/sum to 100/);
  });

  it("rejects duplicate currencies and non-positive base rates", () => {
    expect(
      validatePortions([
        { currency: "USD", proportionPercent: 50, baseRate: 1 },
        { currency: "usd", proportionPercent: 50, baseRate: 1 },
      ]).message,
    ).toMatch(/more than once/);
    expect(
      validatePortions([
        { currency: "USD", proportionPercent: 50, baseRate: 1 },
        { currency: "EUR", proportionPercent: 50, baseRate: 0 },
      ]).message,
    ).toMatch(/baseRate for EUR/);
  });

  it("rejects an empty split and malformed codes", () => {
    expect(validatePortions([]).ok).toBe(false);
    expect(
      validatePortions([{ currency: "EURO", proportionPercent: 100, baseRate: 1 }]).message,
    ).toMatch(/3-letter/);
  });
});

/* ------------------------------------------------------------------ */
/* Rate resolution (#596-597)                                          */
/* ------------------------------------------------------------------ */

describe("resolveRate / convert", () => {
  const lookup = buildRateLookup([
    quote("USD", "EUR", 0.9, "2026-01-01"),
    quote("USD", "EUR", 0.92, "2026-02-01"),
    quote("USD", "KES", 130, "2026-02-01"),
  ]);

  it("uses the identity path for the same currency", () => {
    const res = convert(500, "usd", "USD", lookup);
    expect(res?.path).toBe("identity");
    expect(res?.rate).toBe(1);
    expect(res?.converted).toBe(500);
  });

  it("prefers a direct quote and reports its date", () => {
    const res = convert(1000, "USD", "EUR", lookup);
    expect(res?.path).toBe("direct");
    expect(res?.rate).toBe(0.92); // latest quote wins — later entries override
    expect(res?.rateDate).toBe("2026-02-01");
    expect(res?.converted).toBe(920);
  });

  it("falls back to the reciprocal of the opposite quote", () => {
    const res = convert(920, "EUR", "USD", lookup);
    expect(res?.path).toBe("inverse");
    expect(res?.rate).toBeCloseTo(1 / 0.92, 8);
    expect(res?.converted).toBe(1000);
  });

  it("triangulates through the base currency, reporting the staler leg date", () => {
    const res = convert(92, "EUR", "KES", lookup, "USD");
    expect(res?.path).toBe("triangulated");
    expect(res?.via).toBe("USD");
    // EUR->USD (inverse of 0.92) then USD->KES (130)
    expect(res?.rate).toBeCloseTo(130 / 0.92, 6);
    expect(res?.converted).toBe(13000);
    expect(res?.rateDate).toBe("2026-02-01");
    expect(res?.legs).toHaveLength(2);
  });

  it("returns null when no path exists", () => {
    expect(convert(100, "JPY", "BRL", lookup, "USD")).toBeNull();
    // triangulation is not attempted when the pivot IS one of the endpoints
    expect(resolveRate("USD", "JPY", lookup, "USD")).toBeNull();
  });

  it("normalizes currency codes on both sides of the lookup", () => {
    expect(normalizeCurrency(" eur ")).toBe("EUR");
    expect(convert(100, "usd", "eur", lookup)?.rate).toBe(0.92);
  });
});

/* ------------------------------------------------------------------ */
/* Payment splitting (#596) and FX gain/loss (#599)                    */
/* ------------------------------------------------------------------ */

describe("splitPayment", () => {
  const portions: Portion[] = [
    { currency: "USD", proportionPercent: 60, baseRate: 1.0 },
    { currency: "NGN", proportionPercent: 40, baseRate: 0.8 },
  ];

  it("splits by proportion and applies the contractual base rates", () => {
    const res = splitPayment(100_000, "USD", portions, buildRateLookup([]));
    const [usd, ngn] = res.lines;
    expect(usd?.baseAmount).toBe(60_000);
    expect(usd?.contractualAmount).toBe(60_000); // 60,000 x 1.0
    expect(ngn?.baseAmount).toBe(40_000);
    expect(ngn?.contractualAmount).toBe(32_000); // 40,000 x 0.8
    expect(res.totals.baseAmount).toBe(100_000);
    expect(res.totals.proportionPercent).toBe(100);
  });

  it("is null-safe when no market rate is on file", () => {
    const res = splitPayment(100_000, "USD", portions, buildRateLookup([]));
    // the USD line is the base currency itself — identity, always quoted
    expect(res.lines[0]?.marketRate).toBe(1);
    expect(res.lines[1]?.marketRate).toBeNull();
    expect(res.lines[1]?.marketAmount).toBeNull();
    expect(res.lines[1]?.fxVariance).toBeNull();
    expect(res.totals.missingRates).toEqual(["NGN"]);
    expect(res.note).toMatch(/No market rate/);
  });

  it("computes the market variance when a rate exists", () => {
    const lookup = buildRateLookup([quote("USD", "NGN", 1.0, "2026-03-01")]);
    const res = splitPayment(100_000, "USD", portions, lookup);
    const ngn = res.lines[1];
    expect(ngn?.marketRate).toBe(1);
    expect(ngn?.marketAmount).toBe(40_000);
    expect(ngn?.fxVariance).toBe(8_000); // 40,000 - 32,000
    // the contractual 32,000 NGN costs only 32,000 USD at market vs a
    // 40,000 USD share -> an 8,000 USD unrealised gain to the payer
    expect(ngn?.contractualBaseEquivalent).toBe(32_000);
    expect(ngn?.baseVariance).toBe(-8_000);
    expect(res.totals.baseVariance).toBe(-8_000);
    expect(res.totals.missingRates).toEqual([]);
    expect(res.note).toBeNull();
  });

  it("resolves a market rate through the inverse quote too", () => {
    const lookup = buildRateLookup([quote("NGN", "USD", 0.5, "2026-03-01")]);
    const res = splitPayment(100_000, "USD", portions, lookup);
    expect(res.lines[1]?.marketRate).toBe(2);
    expect(res.lines[1]?.marketRatePath).toBe("inverse");
    expect(res.lines[1]?.marketAmount).toBe(80_000);
  });
});
