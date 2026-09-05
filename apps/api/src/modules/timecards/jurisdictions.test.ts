import { describe, expect, it } from "vitest";
import {
  assessWagePayment,
  assessWorkingTime,
  getJurisdiction,
  rateAgeDays,
  WAGE_JURISDICTIONS,
} from "./jurisdictions.js";

const gb = getJurisdiction("gb")!;
const ca = getJurisdiction("us-ca")!;
const ae = getJurisdiction("ae")!;

const day = (date: string, hours: number) =>
  ({ date, hours, source: "timecard" }) as const;

describe("the library itself", () => {
  it("gives every jurisdiction a citation", () => {
    for (const j of WAGE_JURISDICTIONS) {
      expect(j.citation.length).toBeGreaterThan(20);
      expect(j.key).toMatch(/^[a-z]{2,3}(-[a-z]{2})?$/);
    }
  });

  it("does not invent a jurisdiction that is not in the library", () => {
    expect(getJurisdiction("atlantis")).toBeNull();
    expect(getJurisdiction(null)).toBeNull();
    expect(getJurisdiction("GB")).toBe(gb);
  });

  it("measures how stale a stored statutory rate is", () => {
    expect(rateAgeDays({ amount: 1, currency: "GBP", unit: "hour", rateAsOf: "2024-01-01" }, "2024-01-31")).toBe(30);
  });
});

describe("working time — rest days", () => {
  it("finds a run past the jurisdiction's limit and names the days", () => {
    const days = Array.from({ length: 8 }, (_, i) => day(`2026-03-${String(i + 1).padStart(2, "0")}`, 9));
    const out = assessWorkingTime({
      jurisdiction: ca,
      workerReference: "W-1",
      workerName: "A Worker",
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      days,
    });
    expect(out.longestRunDays).toBe(8);
    const finding = out.findings.find((f) => f.detector === "labour_no_rest_day");
    expect(finding).toBeDefined();
    expect(finding!.inputs["limit"]).toBe(6);
    expect(finding!.indicator).toBe("no_rest_day");
    expect(finding!.citation).toContain("551");
  });

  it("counts a rest day as breaking the run", () => {
    const out = assessWorkingTime({
      jurisdiction: ca,
      workerReference: "W-1",
      workerName: "A Worker",
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      days: [
        day("2026-03-01", 8),
        day("2026-03-02", 8),
        day("2026-03-03", 8),
        // rest day on the 4th
        day("2026-03-05", 8),
        day("2026-03-06", 8),
      ],
    });
    expect(out.longestRunDays).toBe(3);
    expect(out.findings.some((f) => f.detector === "labour_no_rest_day")).toBe(false);
  });
});

describe("working time — weekly and daily hours", () => {
  it("judges only weeks that sit wholly inside the window", () => {
    // Mon 2026-03-02 .. Sun 2026-03-08 is a whole week; 6x10 = 60 h > 48.
    const out = assessWorkingTime({
      jurisdiction: gb,
      workerReference: "W-2",
      workerName: "B Worker",
      periodStart: "2026-03-02",
      periodEnd: "2026-03-08",
      days: [
        day("2026-03-02", 10),
        day("2026-03-03", 10),
        day("2026-03-04", 10),
        day("2026-03-05", 10),
        day("2026-03-06", 10),
        day("2026-03-07", 10),
      ],
    });
    const weekly = out.findings.find((f) => f.detector === "labour_excessive_weekly_hours");
    expect(weekly).toBeDefined();
    expect(weekly!.inputs["hours"]).toBe(60);
  });

  it("does not judge a week clipped by the window", () => {
    const out = assessWorkingTime({
      jurisdiction: gb,
      workerReference: "W-2",
      workerName: "B Worker",
      periodStart: "2026-03-05",
      periodEnd: "2026-03-08",
      days: [day("2026-03-05", 20), day("2026-03-06", 20), day("2026-03-07", 20)],
    });
    expect(out.findings.some((f) => f.detector === "labour_excessive_weekly_hours")).toBe(false);
  });

  it("makes no daily finding where the jurisdiction caps no day", () => {
    const us = getJurisdiction("us")!;
    const out = assessWorkingTime({
      jurisdiction: us,
      workerReference: "W-3",
      workerName: "C Worker",
      periodStart: "2026-03-02",
      periodEnd: "2026-03-08",
      days: [day("2026-03-02", 16)],
    });
    expect(out.maxDailyHours).toBe(16);
    expect(out.findings).toHaveLength(0);
  });
});

describe("wage payment", () => {
  const base = {
    jurisdiction: ae,
    workerReference: "W-9",
    workerName: "D Worker",
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    grossPay: 3000,
    deductions: 0,
    netPay: 3000,
    currency: "AED",
    hoursClaimed: 240,
    daysClaimed: 26,
    paidAt: null as string | null,
    asOf: "2026-03-01",
  };

  it("raises non-payment only after the statutory window has passed", () => {
    const late = assessWagePayment(base);
    expect(late.findings.some((f) => f.detector === "labour_wage_unpaid")).toBe(true);

    const early = assessWagePayment({ ...base, asOf: "2026-02-10" });
    expect(early.findings.some((f) => f.detector === "labour_wage_unpaid")).toBe(false);
  });

  it("raises late payment with the number of days", () => {
    const out = assessWagePayment({ ...base, paidAt: "2026-03-01" });
    const f = out.findings.find((x) => x.detector === "labour_wage_paid_late");
    expect(f).toBeDefined();
    expect(f!.inputs["lateDays"]).toBe(14);
  });

  it("caps deductions and states what is over the cap", () => {
    const out = assessWagePayment({
      ...base,
      paidAt: "2026-02-05",
      deductions: 900,
      netPay: 2100,
    });
    const f = out.findings.find((x) => x.detector === "labour_excessive_deductions");
    expect(f).toBeDefined();
    expect(f!.inputs["deductionPercent"]).toBe(30);
    expect(f!.amountAtRisk).toBe(300);
  });

  it("treats a coded recruitment fee as critical whatever the amount", () => {
    const out = assessWagePayment({
      ...base,
      paidAt: "2026-02-05",
      deductions: 100,
      netPay: 2900,
      deductionLines: [{ code: "recruitment_fee", label: "Agency recovery", amount: 100 }],
    });
    const f = out.findings.find((x) => x.detector === "labour_recruitment_fee_deduction");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("critical");
    expect(f!.indicator).toBe("recruitment_fee_paid");
  });

  it("refuses a minimum-wage comparison across currencies rather than converting", () => {
    const out = assessWagePayment({
      ...base,
      jurisdiction: gb,
      currency: "AED",
      paidAt: "2026-02-05",
    });
    expect(out.findings.some((f) => f.detector === "labour_wage_below_minimum")).toBe(false);
    expect(out.reasons.join(" ")).toContain("never converted");
  });

  it("finds an hourly underpayment and quantifies the shortfall", () => {
    const out = assessWagePayment({
      ...base,
      jurisdiction: gb,
      currency: "GBP",
      grossPay: 1000,
      netPay: 1000,
      hoursClaimed: 100,
      paidAt: "2026-02-05",
    });
    const f = out.findings.find((x) => x.detector === "labour_wage_below_minimum");
    expect(f).toBeDefined();
    expect(f!.inputs["impliedRate"]).toBe(10);
    expect(f!.amountAtRisk).toBe(144);
  });

  it("says why no comparison was made when the jurisdiction sets no rate", () => {
    const out = assessWagePayment({ ...base, paidAt: "2026-02-05" });
    expect(out.findings.some((f) => f.detector === "labour_wage_below_minimum")).toBe(false);
    expect(out.reasons.join(" ")).toContain("no minimum wage in the library");
  });
});
