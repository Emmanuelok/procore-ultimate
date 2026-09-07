/**
 * Unit tests for the pure jurisdiction engines: IAS 21 / IAS 29
 * consolidation, the permit state machine, local-content derivation and the
 * market-vs-contractual rate selection that the exposure statement rests on.
 */
import { describe, expect, it } from "vitest";
import {
  MARKET_SOURCE_PRIORITY,
  NON_MARKET_SOURCES,
  buildRateLookup,
  splitPayment,
  type Portion,
  type RateQuote,
} from "./fx.js";
import { consolidate, restatementFactor, type ConsolidationEntity } from "./consolidation.js";
import {
  PERMIT_REAPPLY_FROM,
  PERMIT_TRANSITIONS,
  LOCAL_CONTENT_METRIC_RULES,
  localContentRule,
} from "./reference.js";
import {
  computeLocalHeadcount,
  computeLocalSpend,
  matchesJurisdiction,
  type SpendRow,
  type WorkerRow,
} from "./localcontent.js";

/* ================================================================== */
/* Rate selection — the exposure statement's foundation (#599)          */
/* ================================================================== */

const quote = (over: Partial<RateQuote> = {}): RateQuote => ({
  fromCurrency: "EUR",
  toCurrency: "USD",
  rate: 1.1,
  rateDate: "2026-01-01",
  source: "market",
  ...over,
});

describe("buildRateLookup source priority", () => {
  it("lets a later date win regardless of source", () => {
    const l = buildRateLookup(
      [
        quote({ rate: 1.0, rateDate: "2026-01-01", source: "central_bank" }),
        quote({ rate: 1.3, rateDate: "2026-06-01", source: "manual" }),
      ],
      { sourcePriority: MARKET_SOURCE_PRIORITY },
    );
    expect(l("EUR", "USD")?.rate).toBe(1.3);
  });

  it("breaks a same-date tie by source rank, not by row order", () => {
    const rows = [
      quote({ rate: 1.5, source: "manual" }),
      quote({ rate: 1.2, source: "central_bank" }),
    ];
    expect(
      buildRateLookup(rows, { sourcePriority: MARKET_SOURCE_PRIORITY })("EUR", "USD")?.rate,
    ).toBe(1.2);
    // and the reverse ordering must give the same answer
    expect(
      buildRateLookup([...rows].reverse(), { sourcePriority: MARKET_SOURCE_PRIORITY })(
        "EUR",
        "USD",
      )?.rate,
    ).toBe(1.2);
  });

  it("keeps 'contractual' out of the market source ordering entirely", () => {
    expect(MARKET_SOURCE_PRIORITY).not.toContain("contractual");
    expect(NON_MARKET_SOURCES).toContain("contractual");
  });

  it("normalises currency case on both sides of the lookup", () => {
    const l = buildRateLookup([quote({ fromCurrency: "eur", toCurrency: "usd" })]);
    expect(l("EUR", "USD")?.rate).toBe(1.1);
  });
});

describe("splitPayment", () => {
  const portions: Portion[] = [
    { currency: "USD", proportionPercent: 60, baseRate: 1 },
    { currency: "EUR", proportionPercent: 40, baseRate: 0.9 },
  ];

  it("reports the market source on every priced line", () => {
    const lookup = buildRateLookup([
      { fromCurrency: "USD", toCurrency: "EUR", rate: 0.8, rateDate: "2026-06-01", source: "central_bank" },
    ]);
    const r = splitPayment(1_000_000, "USD", portions, lookup);
    const eurLine = r.lines.find((l) => l.currency === "EUR")!;
    expect(eurLine.marketRateSource).toBe("central_bank");
    // 400,000 base × contractual 0.9 = 360,000 EUR entitlement
    expect(eurLine.contractualAmount).toBe(360_000);
    // the same 400,000 base buys only 320,000 EUR at 0.8
    expect(eurLine.marketAmount).toBe(320_000);
    expect(eurLine.fxVariance).toBe(-40_000);
  });

  it("leaves an unquoted portion unpriced with no market source", () => {
    const r = splitPayment(1_000_000, "USD", portions, buildRateLookup([]));
    const eurLine = r.lines.find((l) => l.currency === "EUR")!;
    expect(eurLine.marketRate).toBeNull();
    expect(eurLine.marketRateSource).toBeNull();
    expect(eurLine.fxVariance).toBeNull();
    expect(r.totals.missingRates).toContain("EUR");
  });

  it("marks the base-currency portion as identity rather than looking it up", () => {
    const r = splitPayment(1_000_000, "USD", portions, buildRateLookup([]));
    const usdLine = r.lines.find((l) => l.currency === "USD")!;
    expect(usdLine.marketRatePath).toBe("identity");
    expect(usdLine.marketRateSource).toBe("identity");
  });
});

/* ================================================================== */
/* Consolidation (IAS 21 / IAS 29)                                     */
/* ================================================================== */

const entity = (over: Partial<ConsolidationEntity> = {}): ConsolidationEntity => ({
  id: "e1",
  name: "OpCo",
  role: "subsidiary",
  country: "DE",
  functionalCurrency: "EUR",
  ownershipPercent: 100,
  hyperinflationary: false,
  priceIndex: [],
  amount: 1_000_000,
  amountPeriod: null,
  ...over,
});

describe("restatementFactor", () => {
  it("is closing index ÷ opening index", () => {
    const r = restatementFactor(
      [
        { period: "2025-01", index: 100 },
        { period: "2026-01", index: 250 },
      ],
      "2025-01",
      "2026-06-30",
    )!;
    expect(r.factor).toBe(2.5);
    expect(r.basis).toContain("IAS 29");
  });

  it("returns null when the series cannot support the calculation", () => {
    expect(restatementFactor([], "2025-01", "2026-01")).toBeNull();
    expect(
      restatementFactor([{ period: "2026-01", index: 100 }], null, "2026-06"),
    ).toBeNull();
    // no opening point on or before the amount period
    expect(
      restatementFactor([{ period: "2026-01", index: 100 }], "2024-01", "2026-06"),
    ).toBeNull();
  });
});

describe("consolidate", () => {
  const lookup = buildRateLookup([
    { fromCurrency: "EUR", toCurrency: "USD", rate: 1.1, rateDate: "2026-06-30", source: "central_bank" },
  ]);

  it("translates at the closing rate and applies the ownership share", () => {
    const r = consolidate({
      asOf: "2026-06-30",
      presentationCurrency: "USD",
      method: "closing_rate",
      entities: [entity({ ownershipPercent: 60 })],
      lookup,
    });
    const line = r.lines[0]!;
    expect(line.groupShareAmount).toBe(600_000);
    expect(line.translatedAmount).toBe(660_000);
    expect(line.rateSource).toBe("central_bank");
    expect(r.totals.presentationTotal).toBe(660_000);
    expect(line.notes.join(" ")).toContain("60%");
  });

  it("excludes an entity with no rate on file and states the reason", () => {
    const r = consolidate({
      asOf: "2026-06-30",
      presentationCurrency: "USD",
      method: "closing_rate",
      entities: [entity({ functionalCurrency: "NGN" })],
      lookup,
    });
    expect(r.totals.presentationTotal).toBe(0);
    expect(r.unpriced).toHaveLength(1);
    expect(r.unpriced[0]!.reason).toContain("guessed rate");
    // the position is still stated in its own currency
    expect(r.totals.byFunctionalCurrency).toEqual([
      { currency: "NGN", entities: 1, amount: 1_000_000 },
    ]);
    expect(r.lines[0]!.translatedAmount).toBeNull();
  });

  it("restates a hyperinflationary entity before translating it", () => {
    const r = consolidate({
      asOf: "2026-06-30",
      presentationCurrency: "USD",
      method: "closing_rate",
      entities: [
        entity({
          hyperinflationary: true,
          amountPeriod: "2025-01",
          priceIndex: [
            { period: "2025-01", index: 100 },
            { period: "2026-06", index: 200 },
          ],
        }),
      ],
      lookup,
    });
    const line = r.lines[0]!;
    expect(line.restatementFactor).toBe(2);
    expect(line.restatedFunctionalAmount).toBe(2_000_000);
    expect(line.translatedAmount).toBe(2_200_000);
    expect(r.totals.ias29Entities).toBe(1);
    expect(r.note).toContain("IAS 29");
  });

  it("EXCLUDES a hyperinflationary entity with no usable index rather than translating it unrestated", () => {
    const r = consolidate({
      asOf: "2026-06-30",
      presentationCurrency: "USD",
      method: "closing_rate",
      entities: [entity({ hyperinflationary: true, priceIndex: [], amountPeriod: null })],
      lookup,
    });
    expect(r.lines).toHaveLength(0);
    expect(r.unpriced[0]!.reason).toContain("IAS 29");
    expect(r.totals.presentationTotal).toBe(0);
  });

  it("computes the translation reserve as the difference between rate bases", () => {
    const alt = buildRateLookup([
      { fromCurrency: "EUR", toCurrency: "USD", rate: 1.0, rateDate: "2026-06-30", source: "market" },
    ]);
    const r = consolidate({
      asOf: "2026-06-30",
      presentationCurrency: "USD",
      method: "closing_rate",
      entities: [entity()],
      lookup,
      alternativeLookup: alt,
    });
    expect(r.totals.presentationTotal).toBe(1_100_000);
    expect(r.totals.alternativeBasisTotal).toBe(1_000_000);
    expect(r.totals.translationReserve).toBe(100_000);
  });

  it("reports the reserve as unknowable when the alternative basis is incomplete", () => {
    const r = consolidate({
      asOf: "2026-06-30",
      presentationCurrency: "USD",
      method: "closing_rate",
      entities: [entity()],
      lookup,
      alternativeLookup: buildRateLookup([]),
    });
    expect(r.totals.translationReserve).toBeNull();
    expect(r.totals.alternativeBasisTotal).toBeNull();
  });

  it("never sums across functional currencies in the by-currency view", () => {
    const r = consolidate({
      asOf: "2026-06-30",
      presentationCurrency: "USD",
      method: "closing_rate",
      entities: [
        entity({ id: "e1", functionalCurrency: "EUR", amount: 100 }),
        entity({ id: "e2", functionalCurrency: "GBP", amount: 200 }),
      ],
      lookup,
    });
    expect(r.totals.byFunctionalCurrency).toEqual([
      { currency: "EUR", entities: 1, amount: 100 },
      { currency: "GBP", entities: 1, amount: 200 },
    ]);
  });

  it("treats an identity translation (same currency) as priced", () => {
    const r = consolidate({
      asOf: "2026-06-30",
      presentationCurrency: "EUR",
      method: "closing_rate",
      entities: [entity()],
      lookup: buildRateLookup([]),
    });
    expect(r.lines[0]!.translatedAmount).toBe(1_000_000);
    expect(r.unpriced).toHaveLength(0);
  });
});

/* ================================================================== */
/* Permit state machine                                                */
/* ================================================================== */

describe("PERMIT_TRANSITIONS", () => {
  it("refuses the transitions that used to corrupt the determination clock", () => {
    // granted → applied left the obligation satisfied and grantedAt set
    expect(PERMIT_TRANSITIONS.granted).not.toContain("applied");
    // not_started → expired recorded the lapse of a consent never granted
    expect(PERMIT_TRANSITIONS.not_started).not.toContain("expired");
    expect(PERMIT_TRANSITIONS.not_started).toEqual(["applied"]);
    // refused → granted must go back through a re-application
    expect(PERMIT_TRANSITIONS.refused).not.toContain("granted");
  });

  it("allows the real statutory path", () => {
    expect(PERMIT_TRANSITIONS.applied).toContain("in_review");
    expect(PERMIT_TRANSITIONS.applied).toContain("granted");
    expect(PERMIT_TRANSITIONS.in_review).toContain("refused");
    expect(PERMIT_TRANSITIONS.granted).toEqual(["expired"]);
  });

  it("makes both dead ends escapable only by re-applying", () => {
    for (const from of PERMIT_REAPPLY_FROM) {
      expect(PERMIT_TRANSITIONS[from], from).toEqual(["applied"]);
    }
  });

  it("never lets a status transition to itself", () => {
    for (const [from, tos] of Object.entries(PERMIT_TRANSITIONS)) {
      expect(tos, from).not.toContain(from);
    }
  });
});

/* ================================================================== */
/* Local content derivation (#612-613)                                 */
/* ================================================================== */

describe("local content rules", () => {
  it("marks the ICV score as not derivable — the platform records it", () => {
    expect(localContentRule("icv_score")?.computable).toBe(false);
    expect(localContentRule("local_spend_percent")?.computable).toBe(true);
    expect(localContentRule("nonsense")).toBeNull();
  });

  it("gives every metric a stated derivation", () => {
    for (const r of LOCAL_CONTENT_METRIC_RULES) {
      expect(r.derivation.length, r.key).toBeGreaterThan(20);
    }
  });

  it("matches jurisdictions case- and whitespace-insensitively", () => {
    expect(matchesJurisdiction(" nigeria ", "Nigeria")).toBe(true);
    expect(matchesJurisdiction("Ghana", "Nigeria")).toBe(false);
    expect(matchesJurisdiction(null, "Nigeria")).toBe(false);
  });
});

describe("computeLocalSpend", () => {
  const rows = (over: Partial<SpendRow>[] = []): SpendRow[] =>
    over.map((o, i) => ({
      invoiceId: `inv_${i}`,
      vendorId: `v_${i}`,
      vendorName: `Vendor ${i}`,
      vendorCountry: "Nigeria",
      currency: "USD",
      amount: 100,
      date: "2026-06-01",
      ...o,
    }));

  it("computes the local share and states the arithmetic", () => {
    const r = computeLocalSpend({
      rows: rows([{ amount: 700 }, { amount: 300, vendorCountry: "France" }]),
      jurisdiction: "Nigeria",
      targetValue: 60,
      periodStart: null,
      periodEnd: null,
    });
    expect(r.value).toBe(70);
    expect(r.compliant).toBe(true);
    expect(r.basis).toContain("700");
    expect(r.inputs["localAmount"]).toBe(700);
  });

  it("refuses to sum across currencies and says why", () => {
    const r = computeLocalSpend({
      rows: rows([{ currency: "USD" }, { currency: "NGN" }]),
      jurisdiction: "Nigeria",
      targetValue: 60,
      periodStart: null,
      periodEnd: null,
    });
    expect(r.value).toBeNull();
    expect(r.unavailableReason).toContain("does not add");
  });

  it("returns an unavailable reason, not zero, when the period is empty", () => {
    const r = computeLocalSpend({
      rows: rows([{ date: "2025-01-01" }]),
      jurisdiction: "Nigeria",
      targetValue: 60,
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
    });
    expect(r.value).toBeNull();
    expect(r.compliant).toBeNull();
    expect(r.unavailableReason).toContain("No approved or paid invoices");
  });

  it("counts vendors with no country as non-local and warns that it understates", () => {
    const r = computeLocalSpend({
      rows: rows([{ amount: 500 }, { amount: 500, vendorCountry: null }]),
      jurisdiction: "Nigeria",
      targetValue: 60,
      periodStart: null,
      periodEnd: null,
    });
    expect(r.value).toBe(50);
    expect(r.compliant).toBe(false);
    expect(r.basis).toContain("understates");
    expect(r.inputs["vendorsWithoutCountry"]).toBe(1);
  });

  it("does not divide by a zero-value population", () => {
    const r = computeLocalSpend({
      rows: rows([{ amount: 0 }]),
      jurisdiction: "Nigeria",
      targetValue: 60,
      periodStart: null,
      periodEnd: null,
    });
    expect(r.value).toBeNull();
    expect(r.unavailableReason).toContain("totals zero");
  });
});

describe("computeLocalHeadcount", () => {
  const workers = (rows: Partial<WorkerRow>[]): WorkerRow[] =>
    rows.map((r, i) => ({
      workerId: `w_${i}`,
      nationality: "Nigeria",
      status: "active",
      ...r,
    }));

  it("counts only active workers", () => {
    const r = computeLocalHeadcount({
      workers: workers([{}, {}, { nationality: "India", status: "demobilised" }]),
      jurisdiction: "Nigeria",
      targetValue: 80,
      metric: "local_headcount_percent",
    });
    expect(r.value).toBe(100);
    expect(r.inputs["workers"]).toBe(2);
  });

  it("explains that a quota is about citizenship, not residency", () => {
    const r = computeLocalHeadcount({
      workers: workers([{}, { nationality: "India" }]),
      jurisdiction: "Nigeria",
      targetValue: 80,
      metric: "national_quota",
    });
    expect(r.value).toBe(50);
    expect(r.compliant).toBe(false);
    expect(r.basis).toContain("citizenship");
  });

  it("returns a reason, not zero, with no active workers", () => {
    const r = computeLocalHeadcount({
      workers: workers([{ status: "demobilised" }]),
      jurisdiction: "Nigeria",
      targetValue: 80,
      metric: "local_headcount_percent",
    });
    expect(r.value).toBeNull();
    expect(r.unavailableReason).toContain("No active workers");
  });
});
