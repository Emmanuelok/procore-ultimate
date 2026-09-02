import { describe, expect, it } from "vitest";
import {
  buildCertifiedPayroll,
  buildDailyCsv,
  buildGenericCsv,
  certifiedPayrollToCsv,
  csvField,
  type PayrollCard,
  type PayrollExportContext,
} from "./payrollexport.js";

const ctx: PayrollExportContext = {
  projectName: "Northern Interchange",
  projectId: "prj_1",
  batchReference: "TB-001",
  periodStart: "2026-03-02",
  periodEnd: "2026-03-08",
  payrollBatchRef: null,
  generatedAt: "2026-03-09T09:00:00.000Z",
  contractorName: "Builder Ltd",
  contractNumber: "C-42",
};

const card = (over: Partial<PayrollCard> = {}): PayrollCard => ({
  id: "tcd_1",
  reference: "TC-001",
  workDate: "2026-03-02",
  shift: "day",
  workerId: "wkr_1",
  workerReference: "W-001",
  workerName: "A Worker",
  vendorId: "ven_1",
  vendorName: "Sub, Ltd",
  crewReference: "CR-001",
  trade: "steelfixer",
  classification: "Ironworker",
  regularHours: 8,
  overtimeHours: 0,
  doubleTimeHours: 0,
  premiumHours: 0,
  premiumKind: "none",
  totalHours: 8,
  hourlyRate: 25,
  overtimeRate: 37.5,
  doubleTimeRate: null,
  premiumRate: null,
  burdenRate: 0.3,
  totalCost: 260,
  currency: "USD",
  status: "approved",
  costCodes: ["05-1200"],
  ...over,
});

describe("csvField", () => {
  it("quotes a field with a comma and doubles inner quotes", () => {
    expect(csvField('Sub, Ltd "trading"')).toBe('"Sub, Ltd ""trading"""');
  });

  it("neutralises a leading formula character", () => {
    expect(csvField("=SUM(A1)")).toBe("'=SUM(A1)");
  });
});

describe("buildGenericCsv", () => {
  it("aggregates a worker's week into one row", () => {
    const out = buildGenericCsv(
      [card(), card({ id: "tcd_2", reference: "TC-002", workDate: "2026-03-03", overtimeHours: 2, totalHours: 10, totalCost: 335 })],
      ctx,
    );
    expect(out.rowCount).toBe(1);
    const body = out.body.split("\n")[1]!;
    expect(body).toContain("W-001");
    expect(body).toContain('"Sub, Ltd"');
    expect(body.split(",")).toContain("18"); // total hours
    expect(out.incompleteRows).toHaveLength(0);
  });

  it("leaves the amount EMPTY, never zero, when a card could not be costed", () => {
    const out = buildGenericCsv([card({ totalCost: null })], ctx);
    expect(out.incompleteRows).toEqual(["TC-001"]);
    const cells = out.body.split("\n")[1]!.split(",");
    // gross_amount column is index 17 in the declared header order
    expect(cells[17]).toBe("");
    expect(out.reasons.join(" ")).toContain("an empty cell gets");
  });

  it("refuses to let a cross-currency export pass unremarked", () => {
    const out = buildGenericCsv(
      [card(), card({ workerId: "wkr_2", workerReference: "W-002", currency: "GBP" })],
      ctx,
    );
    expect(out.currencies.sort()).toEqual(["GBP", "USD"]);
    expect(out.reasons.join(" ")).toContain("one export per currency");
  });
});

describe("buildDailyCsv", () => {
  it("writes one row per card, date-ordered", () => {
    const out = buildDailyCsv(
      [card({ workDate: "2026-03-04", reference: "TC-003" }), card()],
      ctx,
    );
    expect(out.rowCount).toBe(2);
    const rows = out.body.trim().split("\n");
    expect(rows[1]).toContain("2026-03-02");
    expect(rows[2]).toContain("2026-03-04");
  });
});

describe("buildCertifiedPayroll", () => {
  it("never pre-signs the statement of compliance", () => {
    const report = buildCertifiedPayroll([card()], { ...ctx, weekEnding: "2026-03-08" }, new Map());
    expect(report.statementOfCompliance.signed).toBe(false);
    expect(report.statementOfCompliance.note).toContain("penalty");
  });

  it("leaves deductions and net pay blank when no payroll entry has landed", () => {
    const report = buildCertifiedPayroll([card()], { ...ctx, weekEnding: "2026-03-08" }, new Map());
    const row = report.rows[0]!;
    expect(row.deductions).toBeNull();
    expect(row.netPay).toBeNull();
    expect(row.incomplete.join(" ")).toContain("no payroll entry");
  });

  it("fills deductions from an ingested payroll entry in the same currency", () => {
    const report = buildCertifiedPayroll(
      [card()],
      { ...ctx, weekEnding: "2026-03-08" },
      new Map([["wkr_1", { deductions: 40, netPay: 220, currency: "USD" }]]),
    );
    expect(report.rows[0]!.deductions).toBe(40);
    expect(report.rows[0]!.netPay).toBe(220);
    expect(report.rows[0]!.incomplete).toHaveLength(0);
  });

  it("never converts a payroll entry filed in another currency", () => {
    const report = buildCertifiedPayroll(
      [card()],
      { ...ctx, weekEnding: "2026-03-08" },
      new Map([["wkr_1", { deductions: 40, netPay: 220, currency: "GBP" }]]),
    );
    expect(report.rows[0]!.deductions).toBeNull();
    expect(report.rows[0]!.incomplete.join(" ")).toContain("never converted");
  });

  it("splits the week into per-day regular and overtime columns", () => {
    const report = buildCertifiedPayroll(
      [
        card(),
        card({ id: "t2", reference: "TC-002", workDate: "2026-03-03", regularHours: 8, overtimeHours: 4, totalHours: 12 }),
      ],
      { ...ctx, weekEnding: "2026-03-08" },
      new Map(),
    );
    const row = report.rows[0]!;
    expect(row.dayHours).toHaveLength(2);
    expect(row.totalRegularHours).toBe(16);
    expect(row.totalOvertimeHours).toBe(4);
    const csv = certifiedPayrollToCsv(report);
    expect(csv.body.split("\n")[0]).toContain("2026-03-03_overtime");
  });

  it("refuses one WH-347 line for a worker with two classifications", () => {
    const report = buildCertifiedPayroll(
      [card(), card({ id: "t2", reference: "TC-002", classification: "Labourer" })],
      { ...ctx, weekEnding: "2026-03-08" },
      new Map(),
    );
    expect(report.rows[0]!.incomplete.join(" ")).toContain("one line per classification");
  });
});
