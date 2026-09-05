import { describe, expect, it } from "vitest";
import {
  COVENANT_FORMULA_LIBRARY,
  computeCovenantReading,
  evaluateDrawStop,
  formulaSpec,
  waiverInForce,
  type CovenantStanding,
} from "./covenants.js";
import {
  buildAccrualSchedule,
  dayCountBasis,
  daysInPeriod,
  quarterEnds,
} from "./interest.js";
import {
  FORECAST_LAG_TOLERANCE_PERCENT,
  assessEligibility,
  bucketByCurrency,
  compareForecast,
  singleCurrencyTotal,
} from "./money.js";

/* ------------------------------------------------------------------ */
/* Per-currency money (production blocker regression)                  */
/* ------------------------------------------------------------------ */

describe("bucketByCurrency (#739-741)", () => {
  it("keeps currencies apart instead of adding them", () => {
    const buckets = bucketByCurrency([
      { amount: 100_000_000, currency: "USD" },
      { amount: 50_000_000, currency: "EUR" },
      { amount: 25_000_000, currency: "USD" },
    ]);
    expect(buckets).toEqual([
      { currency: "EUR", amount: 50_000_000, recordCount: 1 },
      { currency: "USD", amount: 125_000_000, recordCount: 2 },
    ]);
  });

  it("skips non-finite amounts rather than treating them as zero", () => {
    const buckets = bucketByCurrency([
      { amount: null, currency: "GBP" },
      { amount: Number.NaN, currency: "GBP" },
      { amount: 10, currency: "GBP" },
    ]);
    expect(buckets).toEqual([{ currency: "GBP", amount: 10, recordCount: 1 }]);
  });

  it("falls back to a stated default currency, not an invented one", () => {
    expect(bucketByCurrency([{ amount: 5, currency: null }], "NGN")[0]!.currency).toBe("NGN");
  });
});

describe("singleCurrencyTotal", () => {
  it("gives a total when everything is in one currency", () => {
    const total = singleCurrencyTotal(
      bucketByCurrency([
        { amount: 10, currency: "GBP" },
        { amount: 20, currency: "GBP" },
      ]),
      "committed funding",
    );
    expect(total).toEqual({ value: 30, currency: "GBP" });
  });

  it("refuses a total across currencies and says why", () => {
    const total = singleCurrencyTotal(
      bucketByCurrency([
        { amount: 100_000_000, currency: "USD" },
        { amount: 50_000_000, currency: "EUR" },
      ]),
      "committed funding",
    );
    expect(total.value).toBeNull();
    expect((total as { reasons: string[] }).reasons[0]).toContain("2 currencies");
    expect((total as { reasons: string[] }).reasons[0]).toContain("EUR, USD");
  });

  it("says nothing has been recorded rather than reporting 0", () => {
    const total = singleCurrencyTotal([], "committed funding");
    expect(total.value).toBeNull();
    expect((total as { reasons: string[] }).reasons[0]).toContain("No committed funding");
  });
});

/* ------------------------------------------------------------------ */
/* Eligibility                                                          */
/* ------------------------------------------------------------------ */

describe("expenditure eligibility (#736-737)", () => {
  it("passes an application whose items are all classified eligible", () => {
    const a = assessEligibility(
      ["e1", "e2"],
      [
        { evidenceId: "e1", eligibility: "eligible" },
        { evidenceId: "e2", eligibility: "eligible" },
      ],
    );
    expect(a.submittable).toBe(true);
    expect(a.eligible).toBe(2);
    expect(a.reasons).toEqual([]);
  });

  it("refuses an application carrying an ineligible item and names the reason", () => {
    const a = assessEligibility(
      ["e1", "e2"],
      [
        { evidenceId: "e1", eligibility: "eligible" },
        { evidenceId: "e2", eligibility: "ineligible", reason: "taxes_and_duties", amount: 4_000 },
      ],
    );
    expect(a.submittable).toBe(false);
    expect(a.ineligible).toBe(1);
    expect(a.ineligibleAmount).toBe(4_000);
    expect(a.reasons[0]).toContain("taxes_and_duties");
  });

  it("treats an unclassified item as a blocker, not a pass", () => {
    const a = assessEligibility(["e1", "e2"], [{ evidenceId: "e1", eligibility: "eligible" }]);
    expect(a.submittable).toBe(false);
    expect(a.unassessedEvidenceIds).toEqual(["e2"]);
    expect(a.reasons.join(" ")).toContain("not been assessed");
  });

  it("reports null — not 0 — for ineligible money when no amounts were stated", () => {
    const a = assessEligibility(
      ["e1"],
      [{ evidenceId: "e1", eligibility: "ineligible", reason: "outside_scope" }],
    );
    expect(a.ineligibleAmount).toBeNull();
  });

  it("an application with no evidence at all is submittable (evidence is optional at draft)", () => {
    expect(assessEligibility([], []).submittable).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Covenants                                                            */
/* ------------------------------------------------------------------ */

describe("computed covenants (#743)", () => {
  it("publishes a library entry for every named formula", () => {
    expect(COVENANT_FORMULA_LIBRARY.length).toBeGreaterThanOrEqual(7);
    expect(formulaSpec("dscr")!.inputs).toEqual(["cfads", "debtService"]);
    expect(formulaSpec("nope")).toBeNull();
  });

  it("computes DSCR from the period inputs and echoes what it used", () => {
    const r = computeCovenantReading("dscr", { cfads: 1_200_000, debtService: 1_000_000 });
    expect(r.value).toBe(1.2);
    expect(r.used).toEqual({ cfads: 1_200_000, debtService: 1_000_000 });
    expect(r.basis).toContain("cfads=1200000");
    expect(r.unavailableReason).toBeNull();
  });

  it("computes gearing as debt over total capital", () => {
    expect(computeCovenantReading("gearing", { totalDebt: 70, totalEquity: 30 }).value).toBe(0.7);
  });

  it("computes interest cover, current ratio, LLCR and debt/EBITDA", () => {
    expect(computeCovenantReading("interest_cover", { ebitda: 500, interestPaid: 100 }).value).toBe(5);
    expect(
      computeCovenantReading("current_ratio", { currentAssets: 300, currentLiabilities: 200 }).value,
    ).toBe(1.5);
    expect(computeCovenantReading("llcr", { npvOfCfads: 240, totalDebt: 200 }).value).toBe(1.2);
    expect(computeCovenantReading("debt_to_ebitda", { totalDebt: 900, ebitda: 300 }).value).toBe(3);
  });

  it("returns null with the reason when an input is missing", () => {
    const r = computeCovenantReading("dscr", { cfads: 1_000_000 });
    expect(r.value).toBeNull();
    expect(r.unavailableReason).toContain("debtService");
  });

  it("returns null — never 0 — on a zero denominator", () => {
    const r = computeCovenantReading("dscr", { cfads: 1_000_000, debtService: 0 });
    expect(r.value).toBeNull();
    expect(r.unavailableReason).toContain("debt service is 0");
  });

  it("leaves custom covenants to the manual path", () => {
    const r = computeCovenantReading("custom", { cfads: 1 });
    expect(r.value).toBeNull();
    expect(r.unavailableReason).toContain("manual readings");
  });

  it("rejects an unknown formula by name", () => {
    expect(computeCovenantReading("cashflow_vibes", {}).unavailableReason).toContain("Unknown");
  });
});

describe("draw-stop evaluation (#741, #747)", () => {
  const covenant = (over: Partial<CovenantStanding> = {}): CovenantStanding => ({
    covenantId: "c1",
    name: "DSCR ≥ 1.2",
    compliant: true,
    readingDate: "2026-06-30",
    headroom: 0.1,
    waivedBy: null,
    ...over,
  });

  it("lets money move when the facility is open and compliant", () => {
    const stop = evaluateDrawStop({
      availabilityEndDate: "2027-12-31",
      today: "2026-09-05",
      covenants: [covenant()],
    });
    expect(stop.stopped).toBe(false);
    expect(stop.reasons).toEqual([]);
  });

  it("stops after the availability end date", () => {
    const stop = evaluateDrawStop({
      availabilityEndDate: "2026-06-30",
      today: "2026-09-05",
      covenants: [covenant()],
    });
    expect(stop.stopped).toBe(true);
    expect(stop.pastAvailability).toBe(true);
    expect(stop.reasons[0]).toContain("availability period ended");
  });

  it("stops on an unwaived covenant breach", () => {
    const stop = evaluateDrawStop({
      availabilityEndDate: null,
      today: "2026-09-05",
      covenants: [covenant({ compliant: false, headroom: -0.3 })],
    });
    expect(stop.stopped).toBe(true);
    expect(stop.breachedCovenantIds).toEqual(["c1"]);
    expect(stop.reasons[0]).toContain("no lender waiver");
  });

  it("lets money move when the breach carries a lender waiver", () => {
    const stop = evaluateDrawStop({
      availabilityEndDate: null,
      today: "2026-09-05",
      covenants: [
        covenant({
          compliant: false,
          waivedBy: { id: "w1", reference: "LW-2026-04", effectiveTo: "2026-12-31" },
        }),
      ],
    });
    expect(stop.stopped).toBe(false);
  });

  it("does not stop on a covenant that has never been read — unknown is not breached", () => {
    const stop = evaluateDrawStop({
      availabilityEndDate: null,
      today: "2026-09-05",
      covenants: [covenant({ compliant: null, readingDate: null, headroom: null })],
    });
    expect(stop.stopped).toBe(false);
  });

  it("reports every reason, not just the first", () => {
    const stop = evaluateDrawStop({
      availabilityEndDate: "2026-01-01",
      today: "2026-09-05",
      covenants: [covenant({ compliant: false }), covenant({ covenantId: "c2", compliant: false })],
    });
    expect(stop.reasons).toHaveLength(3);
    expect(stop.breachedCovenantIds).toEqual(["c1", "c2"]);
  });

  it("waivers respect their effective window", () => {
    expect(waiverInForce({ effectiveFrom: "2026-01-01", effectiveTo: null }, "2026-09-05")).toBe(true);
    expect(waiverInForce({ effectiveFrom: "2026-10-01", effectiveTo: null }, "2026-09-05")).toBe(false);
    expect(
      waiverInForce({ effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30" }, "2026-09-05"),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Cost of finance                                                      */
/* ------------------------------------------------------------------ */

describe("interest and commitment fee accrual (#748-751)", () => {
  it("uses the right day-count basis", () => {
    expect(dayCountBasis("actual_365")).toBe(365);
    expect(dayCountBasis("actual_360")).toBe(360);
    expect(dayCountBasis("thirty_360")).toBe(360);
    expect(daysInPeriod("2026-01-01", "2026-04-01", "actual_365")).toBe(90);
    expect(daysInPeriod("2026-01-01", "2026-04-01", "thirty_360")).toBe(90);
    expect(daysInPeriod("2026-01-31", "2026-02-28", "thirty_360")).toBe(28);
  });

  it("accrues on the time-weighted average balance, not the closing one", () => {
    // 100 drawn on the very last day of a 365-day year: almost no interest.
    const s = buildAccrualSchedule({
      committedAmount: 1000,
      currency: "GBP",
      baseRatePercent: 0,
      marginPercent: 10,
      commitmentFeePercent: null,
      convention: "actual_365",
      capitalise: false,
      periodStart: "2026-01-01",
      periodEnds: ["2027-01-01"],
      draws: [{ date: "2026-12-31", amount: 100 }],
    });
    expect(s.periods).toHaveLength(1);
    expect(s.periods[0]!.averageDrawn).toBeCloseTo(100 / 365, 2);
    expect(s.totalInterest).toBeLessThan(0.1);
    expect(s.periods[0]!.closingDrawn).toBe(100);
  });

  it("charges a commitment fee on the undrawn balance", () => {
    const s = buildAccrualSchedule({
      committedAmount: 1000,
      currency: "GBP",
      baseRatePercent: null,
      marginPercent: null,
      commitmentFeePercent: 1,
      convention: "actual_365",
      capitalise: false,
      periodStart: "2026-01-01",
      periodEnds: ["2027-01-01"],
      draws: [],
    });
    expect(s.totalCommitmentFees).toBeCloseTo(10, 1);
    expect(s.totalInterest).toBe(0);
  });

  it("capitalises interest into the drawn balance when configured", () => {
    const plain = buildAccrualSchedule({
      committedAmount: 10_000,
      currency: "GBP",
      baseRatePercent: 5,
      marginPercent: 5,
      commitmentFeePercent: null,
      convention: "actual_365",
      capitalise: false,
      periodStart: "2026-01-01",
      periodEnds: ["2027-01-01", "2028-01-01"],
      draws: [{ date: "2026-01-01", amount: 1000 }],
    });
    const capitalised = buildAccrualSchedule({
      committedAmount: 10_000,
      currency: "GBP",
      baseRatePercent: 5,
      marginPercent: 5,
      commitmentFeePercent: null,
      convention: "actual_365",
      capitalise: true,
      periodStart: "2026-01-01",
      periodEnds: ["2027-01-01", "2028-01-01"],
      draws: [{ date: "2026-01-01", amount: 1000 }],
    });
    expect(capitalised.totalInterest).toBeGreaterThan(plain.totalInterest);
    expect(capitalised.periods[0]!.capitalised).toBeGreaterThan(0);
    expect(capitalised.periods[1]!.openingDrawn).toBeGreaterThan(1000);
  });

  it("refuses to report 0 cost of finance on a facility with no rates configured", () => {
    const s = buildAccrualSchedule({
      committedAmount: 1000,
      currency: "GBP",
      baseRatePercent: null,
      marginPercent: null,
      commitmentFeePercent: null,
      convention: "actual_365",
      capitalise: false,
      periodStart: "2026-01-01",
      periodEnds: ["2027-01-01"],
      draws: [],
    });
    expect(s.periods).toEqual([]);
    expect(s.unavailableReason).toContain("No base rate");
  });

  it("states its basis, including what it does not model", () => {
    const s = buildAccrualSchedule({
      committedAmount: 1000,
      currency: "GBP",
      baseRatePercent: 4,
      marginPercent: 2,
      commitmentFeePercent: 0.5,
      convention: "actual_360",
      capitalise: false,
      periodStart: "2026-01-01",
      periodEnds: ["2026-04-01"],
      draws: [],
    });
    expect(s.basis).toContain("6% p.a.");
    expect(s.basis).toContain("actual_360");
    expect(s.basis).toContain("No compounding within a period");
  });

  it("generates quarter-end boundaries that end on the requested date", () => {
    const q = quarterEnds("2026-01-01", "2026-12-31");
    expect(q).toContain("2026-03-31");
    expect(q).toContain("2026-06-30");
    expect(q).toContain("2026-09-30");
    expect(q[q.length - 1]).toBe("2026-12-31");
  });
});

/* ------------------------------------------------------------------ */
/* Forecast vs actual                                                   */
/* ------------------------------------------------------------------ */

describe("disbursement forecast vs actual (#745-746)", () => {
  const forecasts = [
    { periodStart: "2026-01-01", periodEnd: "2026-03-31", plannedAmount: 1000, milestoneTaskId: null, milestoneComplete: null },
    { periodStart: "2026-03-31", periodEnd: "2026-06-30", plannedAmount: 2000, milestoneTaskId: null, milestoneComplete: null },
    { periodStart: "2026-06-30", periodEnd: "2026-09-30", plannedAmount: 3000, milestoneTaskId: null, milestoneComplete: null },
  ];

  it("matches actuals into their periods and accumulates", () => {
    const c = compareForecast(
      forecasts,
      [
        { date: "2026-02-15", amount: 800 },
        { date: "2026-05-01", amount: 2200 },
      ],
      "2026-06-30",
    );
    expect(c.points[0]!.actual).toBe(800);
    expect(c.points[1]!.actual).toBe(2200);
    expect(c.points[1]!.cumulativeActual).toBe(3000);
    expect(c.points[1]!.cumulativePlanned).toBe(3000);
    expect(c.lagAmount).toBe(0);
    expect(c.behindPlan).toBe(false);
  });

  it("only counts elapsed periods toward the lag", () => {
    const c = compareForecast(forecasts, [{ date: "2026-02-15", amount: 1000 }], "2026-03-31");
    expect(c.lagAmount).toBe(0);
    expect(c.totalPlanned).toBe(6000);
  });

  it("reports being behind plan beyond the tolerance", () => {
    const c = compareForecast(forecasts, [{ date: "2026-02-15", amount: 100 }], "2026-06-30");
    expect(c.lagAmount).toBe(2900);
    expect(c.lagPercent).toBeCloseTo(96.67, 1);
    expect(c.behindPlan).toBe(true);
    expect(FORECAST_LAG_TOLERANCE_PERCENT).toBe(20);
  });

  it("flags a milestone-triggered tranche whose milestone is not complete", () => {
    const c = compareForecast(
      [
        {
          periodStart: "2026-01-01",
          periodEnd: "2026-03-31",
          plannedAmount: 1000,
          milestoneTaskId: "t1",
          milestoneComplete: false,
        },
      ],
      [],
      "2026-06-30",
    );
    expect(c.points[0]!.milestoneOutstanding).toBe(true);
    expect(c.milestoneBreaches[0]).toContain("not complete");
  });

  it("does not flag a future milestone tranche", () => {
    const c = compareForecast(
      [
        {
          periodStart: "2026-09-30",
          periodEnd: "2026-12-31",
          plannedAmount: 1000,
          milestoneTaskId: "t1",
          milestoneComplete: false,
        },
      ],
      [],
      "2026-06-30",
    );
    expect(c.milestoneBreaches).toEqual([]);
  });
});
