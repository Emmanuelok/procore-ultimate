import { describe, expect, it } from "vitest";
import { computeLabourPosition, type LabourPositionWorker } from "./labourposition.js";

const worker = (over: Partial<LabourPositionWorker> = {}): LabourPositionWorker => ({
  workerId: "wkr_1",
  reference: "W-001",
  fullName: "A Worker",
  vendorId: "ven_1",
  vendorName: "Sub Ltd",
  approvedHours: 40,
  approvedDays: 5,
  pendingHours: 0,
  approvedCost: 800,
  timecardCurrency: "GBP",
  payrollBatchRefs: ["PR-2026-03"],
  paidHours: 40,
  paidDays: 5,
  grossPay: 800,
  payrollCurrency: "GBP",
  paidAt: "2026-03-10",
  payrollEntryCount: 1,
  accessDays: 5,
  crewHourlyRate: 20,
  ...over,
});

const opts = { periodStart: "2026-03-01", periodEnd: "2026-03-07", asOf: "2026-04-01" };

describe("computeLabourPosition", () => {
  it("reconciles a clean worker with no findings", () => {
    const out = computeLabourPosition([worker()], opts);
    expect(out.findings).toHaveLength(0);
    expect(out.rows[0]!.status).toBe("reconciled");
    expect(out.rows[0]!.hoursDifference).toBe(0);
    expect(out.totals.paidHours).toBe(40);
  });

  it("finds hours paid that the site never approved and prices them", () => {
    const out = computeLabourPosition(
      [worker({ paidHours: 60, grossPay: 1200 })],
      opts,
    );
    const f = out.findings.find((x) => x.detector === "labour_hours_paid_never_approved")!;
    expect(f).toBeDefined();
    expect(f.inputs["differenceHours"]).toBe(20);
    expect(f.amountAtRisk).toBe(400);
    expect(out.moneyAtRisk).toEqual([{ currency: "GBP", overpaid: 400, unpaid: 0 }]);
  });

  it("finds approved hours nobody paid, once the grace period has run", () => {
    const out = computeLabourPosition(
      [worker({ paidHours: null, grossPay: null, payrollCurrency: null, payrollEntryCount: 0, paidAt: null })],
      opts,
    );
    const f = out.findings.find((x) => x.detector === "labour_approved_never_paid")!;
    expect(f.severity).toBe("critical");
    expect(f.amountAtRisk).toBe(800);
    expect(out.moneyAtRisk[0]!.unpaid).toBe(800);
  });

  it("waits out the grace period before accusing anyone of non-payment", () => {
    const out = computeLabourPosition(
      [worker({ paidHours: null, grossPay: null, payrollCurrency: null, payrollEntryCount: 0, paidAt: null })],
      { ...opts, asOf: "2026-03-12" },
    );
    expect(out.findings).toHaveLength(0);
    expect(out.rows[0]!.status).toBe("awaiting_payroll");
    expect(out.rows[0]!.reasons.join(" ")).toContain("14 days to land");
  });

  it("does not treat a missing payroll leg as zero hours in the totals", () => {
    const out = computeLabourPosition(
      [worker(), worker({ workerId: "wkr_2", reference: "W-002", paidHours: null, payrollEntryCount: 0 })],
      { ...opts, asOf: "2026-03-10" },
    );
    expect(out.totals.paidHours).toBeNull();
    expect(out.reasons.join(" ")).toContain("no comparable payroll hours");
  });

  it("finds a pay rate below the crew rate the cost report was built on", () => {
    const out = computeLabourPosition([worker({ grossPay: 400 })], opts);
    const f = out.findings.find((x) => x.detector === "labour_pay_rate_below_crew_rate")!;
    expect(f.inputs["impliedHourlyRate"]).toBe(10);
    expect(f.inputs["gapPerHour"]).toBe(10);
    expect(f.amountAtRisk).toBe(400);
  });

  it("never converts currencies to make a money figure", () => {
    const out = computeLabourPosition(
      [worker({ payrollCurrency: "AED", paidHours: 60, grossPay: 4000 })],
      opts,
    );
    const f = out.findings.find((x) => x.detector === "labour_hours_paid_never_approved")!;
    expect(f.amountAtRisk).toBeNull();
    expect(out.rows[0]!.reasons.join(" ")).toContain("never converted");
    expect(out.moneyAtRisk).toHaveLength(0);
  });
});
