import { describe, expect, it } from "vitest";
import {
  computeProductivity,
  detectProductivityDeviation,
  type ProductivityAllocation,
  type ProductivityBudgetLine,
} from "./productivity.js";

const line = (over: Partial<ProductivityBudgetLine> = {}): ProductivityBudgetLine => ({
  id: "bli_1",
  code: "03-3000",
  description: "In-situ concrete",
  budgetHours: 400,
  budgetQuantity: 200,
  unit: "m3",
  budgetAmount: 20000,
  currency: "GBP",
  ...over,
});

const alloc = (over: Partial<ProductivityAllocation> = {}): ProductivityAllocation => ({
  budgetLineItemId: "bli_1",
  costCodeId: "cc_1",
  workDate: "2026-03-02",
  crewId: "crw_1",
  crewName: "Concrete gang",
  hours: 40,
  quantity: 20,
  unit: "m3",
  ...over,
});

describe("computeProductivity", () => {
  it("earns hours at the planned rate and states the factor", () => {
    const out = computeProductivity([alloc()], [line()]);
    const l = out.lines[0]!;
    expect(l.plannedUnitRate).toBe(2); // 400h / 200m3
    expect(l.achievedUnitRate).toBe(2); // 40h / 20m3
    expect(l.earnedHours).toBe(40);
    expect(l.productivityFactor).toBe(1);
    expect(l.percentComplete).toBe(10);
    expect(l.forecastHoursAtCompletion).toBe(400);
    expect(out.totals.productivityFactor).toBe(1);
  });

  it("shows a losing line as a factor below 1 and forecasts the overrun", () => {
    const out = computeProductivity([alloc({ hours: 60, quantity: 20 })], [line()]);
    const l = out.lines[0]!;
    expect(l.achievedUnitRate).toBe(3);
    expect(l.productivityFactor).toBe(0.667);
    expect(l.forecastHoursAtCompletion).toBe(600);
    expect(l.forecastVarianceHours).toBe(200);
  });

  it("returns null — never 1.0 — when the budget line carries no planned hours", () => {
    const out = computeProductivity([alloc()], [line({ budgetHours: null })]);
    const l = out.lines[0]!;
    expect(l.plannedUnitRate).toBeNull();
    expect(l.earnedHours).toBeNull();
    expect(l.productivityFactor).toBeNull();
    expect(l.reasons.join(" ")).toContain("no planned hours");
    expect(out.totals.earnedHours).toBeNull();
  });

  it("returns null when no quantity has been installed against the hours", () => {
    const out = computeProductivity([alloc({ quantity: null })], [line()]);
    expect(out.lines[0]!.installedQuantity).toBeNull();
    expect(out.lines[0]!.earnedHours).toBeNull();
    expect(out.lines[0]!.reasons.join(" ")).toContain("No installed quantity");
  });

  it("refuses to divide across mismatched units", () => {
    const out = computeProductivity([alloc({ unit: "m2" })], [line()]);
    expect(out.lines[0]!.earnedHours).toBeNull();
    expect(out.lines[0]!.reasons.join(" ")).toContain("different units are never added");
  });

  it("excludes uncoded hours and says how many", () => {
    const out = computeProductivity(
      [alloc(), alloc({ budgetLineItemId: null, hours: 12, quantity: null })],
      [line()],
    );
    expect(out.totals.actualHours).toBe(40);
    expect(out.reasons.join(" ")).toContain("12 hour(s) in this window carry no budget line");
  });

  it("buckets the weekly trend on the configured pay week", () => {
    const out = computeProductivity(
      [
        alloc({ workDate: "2026-03-02", hours: 40, quantity: 20 }),
        alloc({ workDate: "2026-03-09", hours: 40, quantity: 10 }),
      ],
      [line()],
    );
    expect(out.weeks.map((w) => w.weekStart)).toEqual(["2026-03-02", "2026-03-09"]);
    expect(out.weeks[0]!.productivityFactor).toBe(1);
    expect(out.weeks[1]!.productivityFactor).toBe(0.5);
  });

  it("compares crews", () => {
    const out = computeProductivity(
      [
        alloc({ crewId: "crw_1", crewName: "Gang A", hours: 40, quantity: 20 }),
        alloc({ crewId: "crw_2", crewName: "Gang B", hours: 40, quantity: 12 }),
      ],
      [line()],
    );
    const a = out.crews.find((c) => c.crewId === "crw_1")!;
    const b = out.crews.find((c) => c.crewId === "crw_2")!;
    expect(a.productivityFactor).toBe(1);
    expect(b.productivityFactor).toBe(0.6);
  });
});

describe("detectProductivityDeviation", () => {
  const week = (weekStart: string, pf: number | null) => ({
    weekStart,
    actualHours: 100,
    earnedHours: pf === null ? null : pf * 100,
    productivityFactor: pf,
  });

  it("needs a run, not one bad week", () => {
    expect(
      detectProductivityDeviation([week("2026-03-02", 0.5), week("2026-03-09", 1.1)]),
    ).toBeNull();
  });

  it("reports the run with the hours that bought no progress", () => {
    const out = detectProductivityDeviation([
      week("2026-03-02", 0.7),
      week("2026-03-09", 0.6),
      week("2026-03-16", 0.5),
    ])!;
    expect(out.weeks).toBe(3);
    expect(out.worstFactor).toBe(0.5);
    expect(out.lostHours).toBe(120);
    expect(out.explanation).toContain("three is a method");
  });

  it("breaks the run on a week that could not be measured", () => {
    expect(
      detectProductivityDeviation([
        week("2026-03-02", 0.5),
        week("2026-03-09", null),
        week("2026-03-16", 0.5),
      ]),
    ).toBeNull();
  });
});
