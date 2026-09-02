/**
 * Unit tests for the budget engines added in the platform upgrade wave:
 * calculated-field expressions, earned value + anomaly detection, cash-flow
 * spreading, the job-to-date arithmetic behind the reconciliation, the
 * variance report and the ERP mapper. Every figure below is hand-worked.
 */
import { describe, expect, it } from "vitest";
import { buildCashFlow, monthRange, spreadLinear } from "./cashflow.js";
import { derivedColumns, settleForecast } from "./derive.js";
import { ERP_DIALECTS, mapErpRows, parseErpRows, resolveErpHeader } from "./erp.js";
import {
  DEFAULT_THRESHOLDS,
  detectContingencyBurn,
  detectLineAnomalies,
  driftFinding,
  earnedValue,
  forecastSwing,
  plannedFraction,
  rollUpEarnedValue,
  sortFindings,
  type InsightLine,
} from "./insights.js";
import { computeJobToDate, latestInvoiceLinePerSovLine, paidCommitmentAllocations } from "./reconcile.js";
import { varianceReport } from "./reports.js";
import { compileCalculatedFields, evaluateExpression, evaluateFields, expressionColumns, parseExpression } from "./views.js";

const line = (over: Partial<InsightLine> = {}): InsightLine => ({
  id: "bli_1",
  costCode: "03300",
  costType: "subcontract",
  description: "Cast-in-place concrete",
  lineKind: "standard",
  status: "active",
  wbsPath: "03/03300",
  originalBudget: 1_000_000,
  budgetModifications: 0,
  approvedChanges: 0,
  revisedBudget: 1_000_000,
  committedCost: 900_000,
  pendingCommitments: 0,
  directCosts: 0,
  jobToDateCosts: 400_000,
  forecastMethod: "remaining_budget",
  forecastToComplete: 600_000,
  forecastFinal: 1_000_000,
  projectedOverUnder: 0,
  percentComplete: 0.5,
  ...over,
});

/* ------------------------------------------------------------------ */
/* views.ts                                                            */
/* ------------------------------------------------------------------ */

describe("views.ts — calculated field expressions", () => {
  const cols = { revisedBudget: 1_000_000, committedCost: 900_000, jobToDateCosts: 400_000, forecastFinal: 1_050_000, percentComplete: 0.5, directCosts: 0 };

  it("evaluates arithmetic with precedence and parentheses", () => {
    expect(evaluateExpression(parseExpression("revisedBudget - committedCost"), cols).value).toBe(100_000);
    expect(evaluateExpression(parseExpression("(revisedBudget - jobToDateCosts) * 2 / 4"), cols).value).toBe(300_000);
    expect(evaluateExpression(parseExpression("-jobToDateCosts + 1_000"), cols).value).toBe(-399_000);
  });

  it("offers pct() and ratio(), returning null with a reason on division by zero", () => {
    expect(evaluateExpression(parseExpression("pct(jobToDateCosts, revisedBudget)"), cols).value).toBe(40);
    const zero = evaluateExpression(parseExpression("pct(jobToDateCosts, directCosts)"), cols);
    expect(zero.value).toBeNull();
    expect(zero.reasons.join(" ")).toMatch(/division by zero/i);
    const div = evaluateExpression(parseExpression("revisedBudget / directCosts"), cols);
    expect(div.value).toBeNull();
    expect(div.reasons[0]).toMatch(/denominator is 0/);
  });

  it("refuses unknown identifiers, unknown functions and stray tokens at parse time", () => {
    expect(() => parseExpression("revisedBudget - profit")).toThrow(/not a budget column/);
    expect(() => parseExpression("sqrt(revisedBudget)")).toThrow(/Unknown function/);
    expect(() => parseExpression("revisedBudget +")).toThrow(/Unexpected end/);
    expect(() => parseExpression("revisedBudget ; 1")).toThrow(/Unexpected character/);
    expect(() => parseExpression("abs(1, 2)")).toThrow(/takes 1 argument/);
    expect(() => parseExpression("")).toThrow(/empty/);
  });

  it("propagates a missing column as null with the reason, never NaN", () => {
    const r = evaluateExpression(parseExpression("revisedBudget - quantity"), cols);
    expect(r.value).toBeNull();
    expect(r.reasons[0]).toMatch(/quantity is not recorded/);
  });

  it("lists the columns an expression reads", () => {
    expect(expressionColumns(parseExpression("max(revisedBudget, forecastFinal) - jobToDateCosts")).sort()).toEqual(["forecastFinal", "jobToDateCosts", "revisedBudget"]);
  });

  it("compiles a field set, refusing shadowed, duplicate and malformed keys", () => {
    const good = compileCalculatedFields([
      { key: "headroom", label: "Headroom", expression: "revisedBudget - committedCost", format: "currency" },
      { key: "spent_pct", label: "Spent %", expression: "pct(jobToDateCosts, revisedBudget)", format: "percent" },
    ]);
    expect(good.errors).toEqual([]);
    expect(good.fields).toHaveLength(2);
    const values = evaluateFields(good.fields, cols);
    expect(values["headroom"]?.value).toBe(100_000);
    expect(values["spent_pct"]?.value).toBe(40);

    const bad = compileCalculatedFields([
      { key: "revisedBudget", expression: "1" },
      { key: "x", expression: "1" },
      { key: "x", expression: "2" },
      { key: "Bad key", expression: "1" },
      { key: "broken", expression: "revisedBudget *" },
    ]);
    expect(bad.errors).toHaveLength(4);
    expect(bad.errors.join("\n")).toMatch(/shadows a stored budget column/);
    expect(bad.errors.join("\n")).toMatch(/defined twice/);
    expect(bad.errors.join("\n")).toMatch(/must be an identifier/);
    expect(bad.errors.join("\n")).toMatch(/broken/);
  });
});

/* ------------------------------------------------------------------ */
/* insights.ts                                                         */
/* ------------------------------------------------------------------ */

describe("insights.ts — earned value", () => {
  it("time-phases planned value linearly and clamps outside the window", () => {
    expect(plannedFraction("2026-01-01", "2026-12-31", "2026-07-02").value).toBeCloseTo(0.5, 2);
    expect(plannedFraction("2026-01-01", "2026-12-31", "2025-06-01").value).toBe(0);
    expect(plannedFraction("2026-01-01", "2026-12-31", "2027-06-01").value).toBe(1);
    expect(plannedFraction(null, "2026-12-31", "2026-07-02").value).toBeNull();
  });

  it("computes the PMBOK ladder by hand: BAC 1m, 50% complete, AC 400k, half-way through the window", () => {
    const ev = earnedValue(line(), { taskIds: ["t1"], start: "2026-01-01", finish: "2026-12-31", taskPercentComplete: null }, "2026-07-02");
    expect(ev.bac).toBe(1_000_000);
    expect(ev.ev.value).toBe(500_000);
    expect(ev.pv.value).toBeCloseTo(500_000, -3);
    expect(ev.cpi.value).toBe(1.25); // 500k / 400k
    expect(ev.spi.value).toBeCloseTo(1, 1);
    expect(ev.eacBudgeted.value).toBe(900_000); // 400k + (1m − 500k)
    expect(ev.eacCpi.value).toBe(800_000); // 400k + 500k / 1.25
    expect(ev.vac.value).toBe(200_000);
    expect(ev.tcpi.value).toBeCloseTo(0.8333, 3); // 500k / 600k
    expect(ev.eacLinear.value).toBeCloseTo(800_000, -4); // 400k / 0.5
  });

  it("never fabricates: no window means no PV/SPI, no cost means no CPI", () => {
    const ev = earnedValue(line({ jobToDateCosts: 0 }), null, "2026-07-02");
    expect(ev.pv.value).toBeNull();
    expect(ev.pv.reasons[0]).toMatch(/No schedule window/);
    expect(ev.spi.value).toBeNull();
    expect(ev.cpi.value).toBeNull();
    expect(ev.cpi.reasons[0]).toMatch(/undefined rather than infinite/);
    expect(ev.eacLinear.value).toBeNull();
  });

  it("rolls up money by summing and ratios by re-deriving", () => {
    const a = earnedValue(line({ id: "a" }), { taskIds: [], start: "2026-01-01", finish: "2026-12-31", taskPercentComplete: null }, "2026-07-02");
    const b = earnedValue(line({ id: "b", revisedBudget: 500_000, jobToDateCosts: 300_000, percentComplete: 0.4 }), null, "2026-07-02");
    const roll = rollUpEarnedValue([
      { line: line({ id: "a" }), ev: a },
      { line: line({ id: "b" }), ev: b },
    ]);
    expect(roll.bac).toBe(1_500_000);
    expect(roll.ac).toBe(700_000);
    expect(roll.ev.value).toBe(700_000); // 500k + 200k
    expect(roll.cpi.value).toBe(1);
    expect(roll.linesWithPv).toBe(1);
    // SPI compares only the lines that have a planned value
    expect(roll.spi.inputs["ev"]).toBe(500_000);
  });
});

describe("insights.ts — swings and anomalies", () => {
  const history = (finals: number[]) =>
    finals.map((f, i) => ({ snapshotId: `s${i}`, reference: `BS-00${i + 1}`, asOfDate: `2026-0${i + 1}-28`, forecastFinal: f, jobToDateCosts: 0, revisedBudget: 1_000_000, percentComplete: 0 }));

  it("counts a run of significant one-directional movements, live figure included", () => {
    const swing = forecastSwing({ forecastFinal: 1_300_000, revisedBudget: 1_000_000 }, history([1_000_000, 1_060_000, 1_130_000, 1_200_000]));
    expect(swing.direction).toBe("up");
    expect(swing.run).toBe(4); // 60k, 70k, 70k, 100k — all ≥ 5%
    expect(swing.netMovement).toBe(300_000);
    const flat = forecastSwing({ forecastFinal: 1_001_000, revisedBudget: 1_000_000 }, history([1_000_000, 1_002_000, 1_003_000]));
    expect(flat.run).toBe(0);
    expect(flat.direction).toBe("flat");
  });

  it("flags the classic anomalies with their inputs and citations", () => {
    const l = line({ committedCost: 1_150_000, jobToDateCosts: 1_100_000, forecastFinal: 1_000_000, percentComplete: 0 });
    const ev = earnedValue(l, null, "2026-07-02");
    const swing = forecastSwing(l, []);
    const findings = detectLineAnomalies(l, ev, swing);
    const kinds = findings.map((f) => f.kind).sort();
    expect(kinds).toEqual(["committed_exceeds_revised", "cost_without_progress", "jtd_exceeds_forecast"]);
    const over = findings.find((f) => f.kind === "committed_exceeds_revised")!;
    expect(over.inputs["over"]).toBe(150_000);
    expect(over.severity).toBe("high"); // 15% of revised
    expect(over.citations[0]).toEqual({ type: "budget_line_item", id: "bli_1", reference: "03300" });
  });

  it("flags an exhausted allowance and a poor CPI/SPI, and is silent on a healthy line", () => {
    const allowance = line({ lineKind: "allowance", jobToDateCosts: 1_200_000, forecastFinal: 1_200_000, percentComplete: 1 });
    const evA = earnedValue(allowance, null, "2026-07-02");
    expect(detectLineAnomalies(allowance, evA, forecastSwing(allowance, [])).map((f) => f.kind)).toContain("allowance_exceeded");

    const slow = line({ jobToDateCosts: 800_000, percentComplete: 0.5, forecastFinal: 1_400_000 });
    const evS = earnedValue(slow, { taskIds: [], start: "2026-01-01", finish: "2026-12-31", taskPercentComplete: null }, "2026-11-30");
    const kinds = detectLineAnomalies(slow, evS, forecastSwing(slow, [])).map((f) => f.kind);
    expect(kinds).toContain("cpi_below_threshold"); // 500k / 800k = 0.625
    expect(kinds).toContain("spi_below_threshold"); // 500k / ~915k

    const healthy = line();
    expect(detectLineAnomalies(healthy, earnedValue(healthy, null, "2026-07-02"), forecastSwing(healthy, []))).toEqual([]);
  });

  it("flags contingency burning ahead of progress, and says why when it cannot", () => {
    const working = [line({ id: "w1", percentComplete: 0.2, jobToDateCosts: 200_000 })];
    const contingency = line({ id: "c1", lineKind: "contingency", originalBudget: 100_000, revisedBudget: 40_000, budgetModifications: -60_000, jobToDateCosts: 0, percentComplete: 0 });
    const burn = detectContingencyBurn([...working, contingency]);
    expect(burn.drawnShare).toBe(0.6);
    expect(burn.progressShare).toBe(0.2);
    expect(burn.finding?.kind).toBe("contingency_burn");
    expect(burn.finding?.severity).toBe("critical"); // 40 points ahead
    const none = detectContingencyBurn(working);
    expect(none.finding).toBeNull();
    expect(none.reasons[0]).toMatch(/no contingency line/);
  });

  it("turns reconciliation drift into a finding and sorts by severity", () => {
    const drift = driftFinding([{ lineItemId: "a", costCode: "03300", component: "jobToDateCosts", stored: 180_000, rebuilt: 90_000, delta: -90_000 }], 1_000_000);
    expect(drift?.kind).toBe("cost_drift");
    expect(drift?.inputs["driftAmount"]).toBe(90_000);
    const sorted = sortFindings([{ ...drift!, severity: "low" }, { ...drift!, severity: "critical" }]);
    expect(sorted[0]?.severity).toBe("critical");
    expect(DEFAULT_THRESHOLDS.cpiFloor).toBe(0.9);
  });
});

/* ------------------------------------------------------------------ */
/* cashflow.ts                                                         */
/* ------------------------------------------------------------------ */

describe("cashflow.ts — S-curve spreading", () => {
  it("spreads by days in month and absorbs rounding in the last month", () => {
    const spread = spreadLinear(1_000, "2026-01-01", "2026-03-31"); // 31 + 28 + 31 = 90 days
    expect([...spread.keys()]).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(spread.get("2026-01")).toBe(344.44);
    expect(spread.get("2026-02")).toBe(311.11);
    expect(spread.get("2026-03")).toBe(344.45);
    expect(Math.round([...spread.values()].reduce((s, v) => s + v, 0) * 100) / 100).toBe(1_000);
    expect(spreadLinear(500, "2026-05-10", "2026-05-10").get("2026-05")).toBe(500);
    expect(monthRange("2026-11", "2027-02")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
  });

  it("builds the four curves, cumulates them and reports what it could not phase", () => {
    const flow = buildCashFlow({
      currency: "USD",
      asOf: "2026-03-15",
      defaultWindow: { start: "2026-01-01", finish: "2026-04-30" },
      planned: [{ id: "p", reference: "BUD", amount: 1_200, start: null, finish: null }],
      committed: [
        { id: "c1", reference: "SC-001", amount: 600, start: "2026-02-01", finish: "2026-02-28" },
        { id: "c2", reference: "SC-002", amount: 100, start: null, finish: null },
      ],
      actual: [
        { id: "i1", reference: "INV-1", amount: 300, date: "2026-02-20" },
        { id: "i2", reference: "INV-2", amount: 50, date: null },
      ],
      forecastToComplete: 900,
    });
    expect(flow.periods.map((p) => p.month)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    expect(flow.totals.planned).toBe(1_200);
    expect(flow.periods[1]?.committed).toBe(600);
    expect(flow.periods[1]?.actual).toBe(300);
    expect(flow.periods[3]?.cumulativePlanned).toBe(1_200);
    // forecast = actual to date (300) + FTC spread over 15 Mar → 30 Apr (900)
    expect(flow.totals.forecast).toBe(1_200);
    expect(flow.periods[1]?.forecast).toBe(300);
    expect(flow.unphased.actual).toEqual([{ id: "i2", reference: "INV-2", amount: 50 }]);
    expect(flow.reasons.join(" ")).toMatch(/carry no billing date/);
    // committed with no dates fell back to the default window, so nothing unphased there
    expect(flow.unphased.committed).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* reconcile.ts — the arithmetic behind the double-count fix           */
/* ------------------------------------------------------------------ */

describe("reconcile.ts — job-to-date arithmetic", () => {
  const inv = (invoiceNumber: number, sov: string | null, total: number, approvedAt = "2026-01-01") => ({
    invoiceId: `inv${invoiceNumber}`,
    invoiceNumber,
    invoiceReference: `INV-${invoiceNumber}`,
    invoiceStatus: "approved",
    approvedAt,
    commitmentId: "cmt",
    commitmentSovLineId: sov,
    budgetLineItemId: "bli",
    totalCompletedAndStored: total,
    currency: "USD",
  });

  it("takes the LATEST cumulative invoice line per SOV line — 100k then 250k is 250k, not 350k", () => {
    const chosen = latestInvoiceLinePerSovLine([inv(1, "sov1", 100_000), inv(2, "sov1", 250_000), inv(1, null, 5_000)]);
    expect(chosen).toHaveLength(2);
    const sov = chosen.find((c) => c.commitmentSovLineId === "sov1")!;
    expect(sov.invoiceNumber).toBe(2);
    expect(sov.totalCompletedAndStored).toBe(250_000);
    expect(chosen.reduce((s, c) => s + c.totalCompletedAndStored, 0)).toBe(255_000);
  });

  it("reads the payments module's own allocation stamps, skipping void and unposted payments", () => {
    const allocations = paidCommitmentAllocations([
      { id: "p1", reference: "PAY-1", status: "paid", currency: "USD", invoiceId: "inv1", commitmentId: "cmt", detail: { budgetPostedAt: "2026-02-01T00:00:00Z", budgetAllocation: [{ budgetLineItemId: "bli", amount: 81_000 }] } },
      { id: "p2", reference: "PAY-2", status: "paid", currency: "USD", invoiceId: "inv2", commitmentId: "cmt", detail: {} },
      { id: "p3", reference: "PAY-3", status: "void", currency: "USD", invoiceId: null, commitmentId: "cmt", detail: { budgetPostedAt: "2026-02-01T00:00:00Z", budgetAllocation: [{ budgetLineItemId: "bli", amount: 999 }] } },
    ]);
    expect(allocations).toEqual([{ paymentId: "p1", reference: "PAY-1", budgetLineItemId: "bli", amount: 81_000, currency: "USD", invoiceId: "inv1", commitmentId: "cmt" }]);
  });

  it("counts a paid invoice once: 90k invoiced and 90k paid is 90k spent, not 180k", () => {
    // payments.ts posted the 90k payment into directCosts AND jobToDateCosts
    const r = computeJobToDate({ invoicedToDate: 90_000, paidToDate: 90_000, directCosts: 90_000 });
    expect(r.jobToDateCosts).toBe(90_000);
    expect(r.nonCommitmentDirectCosts).toBe(0);
    expect(r.commitmentCost).toBe(90_000);
  });

  it("keeps genuine direct cost (labour, equipment) on top of commitment cost", () => {
    // 250k invoiced, 225k paid (10% retention), plus 40k payroll posted straight to directCosts
    const r = computeJobToDate({ invoicedToDate: 250_000, paidToDate: 225_000, directCosts: 265_000 });
    expect(r.nonCommitmentDirectCosts).toBe(40_000);
    expect(r.jobToDateCosts).toBe(290_000);
  });

  it("falls back to paid when the invoiced figure is unknown, and to direct cost when both are", () => {
    expect(computeJobToDate({ invoicedToDate: null, paidToDate: 30_000, directCosts: 30_000 }).jobToDateCosts).toBe(30_000);
    expect(computeJobToDate({ invoicedToDate: null, paidToDate: 0, directCosts: 12_000 }).jobToDateCosts).toBe(12_000);
  });

  it("settles a manual forecast without recomputing, and re-derives a formula method", () => {
    const manual = settleForecast({ originalBudget: 100, budgetModifications: 0, approvedChanges: 0, pendingBudgetChanges: 0, committedCost: 0, pendingCommitments: 0, directCosts: 0, jobToDateCosts: 40, percentComplete: 0, forecastMethod: "manual", forecastToComplete: 95 });
    expect(manual.forecastToComplete).toBe(95);
    const remaining = derivedColumns({ originalBudget: 100, budgetModifications: 0, approvedChanges: 0, pendingBudgetChanges: 0, committedCost: 0, pendingCommitments: 0, directCosts: 0, jobToDateCosts: 40, percentComplete: 0, forecastMethod: "remaining_budget", forecastToComplete: 0 });
    expect(remaining.set.forecastToComplete).toBe(60);
    expect(remaining.set.forecastFinal).toBe(100);
  });
});

/* ------------------------------------------------------------------ */
/* reports.ts                                                          */
/* ------------------------------------------------------------------ */

describe("reports.ts — variance report", () => {
  const rows = [
    { id: "a", costCode: "03300", costType: "subcontract", description: "Concrete", lineKind: "standard", subJob: null, wbsPath: "03/03300", originalBudget: 1_000, budgetModifications: 0, approvedChanges: 0, pendingBudgetChanges: 0, committedCost: 900, pendingCommitments: 0, directCosts: 0, jobToDateCosts: 400, percentComplete: 0.4, revisedBudget: 1_000, forecastToComplete: 700, forecastFinal: 1_100, projectedOverUnder: -100 },
    { id: "b", costCode: "03310", costType: "material", description: "Rebar", lineKind: "standard", subJob: null, wbsPath: "03/03310", originalBudget: 500, budgetModifications: 0, approvedChanges: 0, pendingBudgetChanges: 0, committedCost: 0, pendingCommitments: 100, directCosts: 0, jobToDateCosts: 100, percentComplete: 0.2, revisedBudget: 500, forecastToComplete: 350, forecastFinal: 450, projectedOverUnder: 50 },
  ];

  it("groups by division with percentages and the movement since a capture", () => {
    const report = varianceReport(rows, "division", {
      snapshotId: "s1",
      reference: "BS-001",
      asOfDate: "2026-07-31",
      lines: [{ lineItemId: "a", costCode: "03300", costType: "subcontract", description: "", wbsPath: null, lineKind: "standard", originalBudget: 1_000, budgetModifications: 0, approvedChanges: 0, revisedBudget: 1_000, committedCost: 0, pendingCommitments: 0, directCosts: 0, jobToDateCosts: 200, forecastMethod: "remaining_budget", forecastToComplete: 800, forecastFinal: 1_000, projectedOverUnder: 0, percentComplete: 0.2 }],
    });
    expect(report.groups).toHaveLength(1);
    const g = report.groups[0]!;
    expect(g.key).toBe("03");
    expect(g.revisedBudget).toBe(1_500);
    expect(g.variance).toBe(-50);
    expect(g.variancePct).toBeCloseTo(-0.0333, 3);
    expect(g.obligatedPct).toBeCloseTo(0.6667, 3);
    expect(g.movement).toEqual({ revisedBudget: 500, jobToDateCosts: 300, forecastFinal: 550, variance: -50 });
    expect(report.worst[0]?.id).toBe("a");
    expect(report.totals.variancePct).toBeCloseTo(-0.0333, 3);
  });
});

/* ------------------------------------------------------------------ */
/* erp.ts                                                              */
/* ------------------------------------------------------------------ */

describe("erp.ts — GL-mapped import", () => {
  const maps = [
    { id: "m1", projectId: null, erpSystem: "sage", glAccount: "5100", glSubAccount: null, costCodeId: "cc1", costCode: "03300", costType: "subcontract", isActive: 1 },
    { id: "m2", projectId: "prj", erpSystem: "sage", glAccount: "5100", glSubAccount: "M", costCodeId: "cc2", costCode: "03310", costType: "material", isActive: 1 },
    { id: "m3", projectId: null, erpSystem: "sage", glAccount: "9999", glSubAccount: null, costCodeId: "cc9", costCode: "99", costType: "other", isActive: 0 },
  ];

  it("recognises the Sage dialect headers and reports unknown/missing columns", () => {
    const h = resolveErpHeader(["Job", "Cost Code", "Category", "Description", "Original Estimate", "Colour"], "sage");
    expect(h.mapped).toEqual([null, "account", "subAccount", "description", "amount", null]);
    expect(h.unknown).toEqual(["Job", "Colour"]);
    expect(h.missing).toEqual([]);
    expect(resolveErpHeader(["Description"], "quickbooks").missing).toEqual(["account", "amount"]);
    expect(ERP_DIALECTS.viewpoint.template).toContain("phase");
  });

  it("parses amounts in accounting notation and refuses the rows it cannot read", () => {
    const parsed = parseErpRows(
      [
        ["cost_code", "category", "description", "original_estimate"],
        ["5100", "", "Concrete sub", "1,250,000.50"],
        ["5100", "M", "Rebar", "(2,000)"],
        ["5100", "L", "Bad", "abc"],
        ["", "", "No account", "10"],
      ],
      "sage",
    );
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]?.amount).toBe(1_250_000.5);
    expect(parsed.rows[1]?.amount).toBe(-2_000);
    expect(parsed.issues.map((i) => i.row)).toEqual([4, 5]);
  });

  it("maps through project-then-company rows, sums onto one coordinate, and names the unmapped", () => {
    const { lines, unmapped } = mapErpRows(
      [
        { rowNumber: 2, glAccount: "5100", glSubAccount: null, description: "Concrete sub", amount: 100, quantity: null, unit: null },
        { rowNumber: 3, glAccount: "5100", glSubAccount: "M", description: "Rebar", amount: 50, quantity: 10, unit: "t" },
        { rowNumber: 4, glAccount: "5100", glSubAccount: "X", description: "Also concrete", amount: 25, quantity: null, unit: null },
        { rowNumber: 5, glAccount: "9999", glSubAccount: null, description: "Inactive", amount: 1, quantity: null, unit: null },
        { rowNumber: 6, glAccount: "7000", glSubAccount: null, description: "Nowhere", amount: 9, quantity: null, unit: null },
      ],
      maps,
      "prj",
      "sage",
    );
    expect(lines).toHaveLength(2);
    const concrete = lines.find((l) => l.costCode === "03300")!;
    expect(concrete.originalBudget).toBe(125); // rows 2 + 4 (sub-account X falls back to the bare account)
    expect(concrete.provenance.map((p) => p.row)).toEqual([2, 4]);
    expect(lines.find((l) => l.costCode === "03310")?.quantity).toBe(10);
    expect(unmapped.map((u) => u.glAccount)).toEqual(["9999", "7000"]);
    expect(unmapped[0]?.reason).toMatch(/No GL → cost-code mapping/);
  });
});
