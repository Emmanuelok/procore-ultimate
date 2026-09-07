import { describe, expect, it } from "vitest";
import {
  DEFAULT_DRIFT_TOLERANCE_PERCENT,
  assessDrift,
  consumedFraction,
  daysBetween,
  evaluateAppetite,
  generatePlanCurve,
  plannedAt,
  type AppetiteRiskInput,
  type AppetiteRule,
} from "./contingency.js";
import { checkRiskTransition } from "./transitions.js";

describe("planned drawdown curve (#451)", () => {
  it("linear consumption is the identity", () => {
    expect(consumedFraction("linear", 0)).toBe(0);
    expect(consumedFraction("linear", 0.5)).toBe(0.5);
    expect(consumedFraction("linear", 1)).toBe(1);
  });

  it("the s-curve is slow, fast, slow and still lands on 0 and 1", () => {
    expect(consumedFraction("s_curve", 0)).toBe(0);
    expect(consumedFraction("s_curve", 0.5)).toBeCloseTo(0.5, 10);
    expect(consumedFraction("s_curve", 1)).toBe(1);
    expect(consumedFraction("s_curve", 0.25)).toBeLessThan(0.25);
    expect(consumedFraction("s_curve", 0.75)).toBeGreaterThan(0.75);
  });

  it("front and back loading bracket the linear line", () => {
    expect(consumedFraction("front_loaded", 0.25)).toBeGreaterThan(0.25);
    expect(consumedFraction("back_loaded", 0.25)).toBeLessThan(0.25);
  });

  it("clamps out-of-range progress", () => {
    expect(consumedFraction("linear", -1)).toBe(0);
    expect(consumedFraction("back_loaded", 5)).toBe(1);
  });

  it("generates a remaining-balance series from full to empty", () => {
    const pts = generatePlanCurve({
      amount: 1_000_000,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      shape: "linear",
      points: 4,
    });
    expect(pts).toHaveLength(5);
    expect(pts[0]).toEqual({ date: "2026-01-01", plannedRemaining: 1_000_000 });
    expect(pts[4]!.plannedRemaining).toBe(0);
    expect(pts[2]!.plannedRemaining).toBe(500_000);
  });

  it("honours a non-zero planned end balance", () => {
    const pts = generatePlanCurve({
      amount: 500_000,
      startDate: "2026-01-01",
      endDate: "2026-07-01",
      shape: "linear",
      points: 2,
      endRemaining: 100_000,
    });
    expect(pts[2]!.plannedRemaining).toBe(100_000);
    expect(pts[1]!.plannedRemaining).toBe(300_000);
  });

  it("degenerates safely when the dates do not span forward", () => {
    const pts = generatePlanCurve({
      amount: 100,
      startDate: "2026-05-01",
      endDate: "2026-05-01",
      shape: "linear",
    });
    expect(pts).toEqual([{ date: "2026-05-01", plannedRemaining: 100 }]);
  });

  it("daysBetween counts whole UTC days", () => {
    expect(daysBetween("2026-01-01", "2026-01-31")).toBe(30);
    expect(daysBetween("2026-03-01", "2026-02-01")).toBe(-28);
  });
});

describe("planned interpolation and drift (#471)", () => {
  const plan = [
    { date: "2026-01-01", plannedRemaining: 1000 },
    { date: "2026-07-01", plannedRemaining: 500 },
    { date: "2026-12-31", plannedRemaining: 0 },
  ];

  it("clamps before the first and after the last point", () => {
    expect(plannedAt(plan, "2025-01-01")).toBe(1000);
    expect(plannedAt(plan, "2030-01-01")).toBe(0);
  });

  it("interpolates linearly between points", () => {
    expect(plannedAt(plan, "2026-07-01")).toBe(500);
    const mid = plannedAt(plan, "2026-04-01")!;
    expect(mid).toBeGreaterThan(700);
    expect(mid).toBeLessThan(800);
  });

  it("returns null with no plan and says so instead of assuming zero", () => {
    const d = assessDrift({ amount: 1000, actualRemaining: 400, plan: [], asOf: "2026-06-01" });
    expect(d.plannedRemaining).toBeNull();
    expect(d.variance).toBeNull();
    expect(d.breached).toBe(false);
    expect(d.basis).toContain("No planned drawdown curve");
  });

  it("flags a breach only when spending runs AHEAD of plan beyond tolerance", () => {
    const ahead = assessDrift({
      amount: 1000,
      actualRemaining: 300,
      plan,
      asOf: "2026-07-01",
      tolerancePercent: 10,
    });
    expect(ahead.aheadOfPlan).toBe(true);
    expect(ahead.variance).toBe(-200);
    expect(ahead.variancePercent).toBe(-20);
    expect(ahead.breached).toBe(true);

    const behind = assessDrift({
      amount: 1000,
      actualRemaining: 800,
      plan,
      asOf: "2026-07-01",
      tolerancePercent: 10,
    });
    expect(behind.aheadOfPlan).toBe(false);
    expect(behind.breached).toBe(false);

    const withinTolerance = assessDrift({
      amount: 1000,
      actualRemaining: 460,
      plan,
      asOf: "2026-07-01",
      tolerancePercent: 10,
    });
    expect(withinTolerance.aheadOfPlan).toBe(true);
    expect(withinTolerance.breached).toBe(false);
  });

  it("defaults its tolerance", () => {
    const d = assessDrift({ amount: 1000, actualRemaining: 500, plan, asOf: "2026-07-01" });
    expect(d.tolerancePercent).toBe(DEFAULT_DRIFT_TOLERANCE_PERCENT);
  });
});

describe("risk appetite evaluation (#472)", () => {
  const risk = (over: Partial<AppetiteRiskInput> = {}): AppetiteRiskInput => ({
    id: "r1",
    number: 1,
    title: "Ground conditions",
    category: "technical",
    status: "open",
    effectiveScore: 9,
    expectedValue: null,
    ...over,
  });

  const projectRule: AppetiteRule = {
    id: "ap1",
    scope: "project",
    category: null,
    maxScore: 12,
    maxExpectedValue: 500_000,
    currency: "GBP",
  };

  it("is silent when the register is inside appetite", () => {
    expect(evaluateAppetite([projectRule], [risk({ expectedValue: 100_000 })])).toEqual([]);
  });

  it("reports a score breach against the effective (post-mitigation) score", () => {
    const breaches = evaluateAppetite([projectRule], [risk({ effectiveScore: 20 })]);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]!.kind).toBe("score");
    expect(breaches[0]!.actual).toBe(20);
    expect(breaches[0]!.detail).toContain("appetite limit of 12");
  });

  it("reports both the per-risk and the aggregate expected-value breach", () => {
    const breaches = evaluateAppetite(
      [projectRule],
      [
        risk({ id: "r1", number: 1, expectedValue: 600_000 }),
        risk({ id: "r2", number: 2, expectedValue: 100_000 }),
      ],
    );
    expect(breaches.map((b) => b.kind).sort()).toEqual([
      "expected_value",
      "portfolio_expected_value",
    ]);
    const total = breaches.find((b) => b.kind === "portfolio_expected_value")!;
    expect(total.actual).toBe(700_000);
  });

  it("ignores closed and realised risks — they are no longer exposure", () => {
    const breaches = evaluateAppetite(
      [projectRule],
      [
        risk({ id: "r1", status: "closed", effectiveScore: 25 }),
        risk({ id: "r2", status: "realised", effectiveScore: 25 }),
      ],
    );
    expect(breaches).toEqual([]);
  });

  it("scopes a category rule to its category", () => {
    const catRule: AppetiteRule = {
      id: "ap2",
      scope: "category",
      category: "external",
      maxScore: 6,
      maxExpectedValue: null,
      currency: "GBP",
    };
    const breaches = evaluateAppetite(
      [catRule],
      [
        risk({ id: "r1", category: "technical", effectiveScore: 25 }),
        risk({ id: "r2", number: 2, category: "external", effectiveScore: 9 }),
      ],
    );
    expect(breaches).toHaveLength(1);
    expect(breaches[0]!.riskNumber).toBe(2);
    expect(breaches[0]!.detail).toContain("external");
  });

  it("does not aggregate expected value for a category rule (only the project rule does)", () => {
    const catRule: AppetiteRule = {
      id: "ap3",
      scope: "category",
      category: "technical",
      maxScore: null,
      maxExpectedValue: 100_000,
      currency: "GBP",
    };
    const breaches = evaluateAppetite(
      [catRule],
      [
        risk({ id: "r1", expectedValue: 60_000 }),
        risk({ id: "r2", number: 2, expectedValue: 60_000 }),
      ],
    );
    expect(breaches).toEqual([]);
  });
});

describe("risk status transitions (#450)", () => {
  it("allows the ordinary management moves", () => {
    expect(checkRiskTransition("open", "mitigating", { isAdmin: false, hasNote: false }).allowed).toBe(true);
    expect(checkRiskTransition("mitigating", "open", { isAdmin: false, hasNote: false }).allowed).toBe(true);
    expect(checkRiskTransition("open", "realised", { isAdmin: false, hasNote: false }).allowed).toBe(true);
    expect(checkRiskTransition("mitigating", "closed", { isAdmin: false, hasNote: false }).allowed).toBe(true);
    expect(checkRiskTransition("realised", "closed", { isAdmin: false, hasNote: false }).allowed).toBe(true);
  });

  it("refuses realised → open for a standard user", () => {
    const check = checkRiskTransition("realised", "open", { isAdmin: false, hasNote: true });
    expect(check.allowed).toBe(false);
    expect(check.requiresAdmin).toBe(true);
    expect(check.reason).toContain("risk:admin");
  });

  it("permits realised → open for an admin who explains it", () => {
    expect(checkRiskTransition("realised", "open", { isAdmin: true, hasNote: true }).allowed).toBe(true);
    const noNote = checkRiskTransition("realised", "open", { isAdmin: true, hasNote: false });
    expect(noNote.allowed).toBe(false);
    expect(noNote.requiresNote).toBe(true);
  });

  it("refuses a no-op", () => {
    const same = checkRiskTransition("open", "open", { isAdmin: true, hasNote: true });
    expect(same.allowed).toBe(false);
    expect(same.reason).toContain("already open");
  });

  it("reopening a closed risk is an admin move with a note", () => {
    expect(checkRiskTransition("closed", "open", { isAdmin: false, hasNote: true }).allowed).toBe(false);
    expect(checkRiskTransition("closed", "open", { isAdmin: true, hasNote: true }).allowed).toBe(true);
  });

  it("closed → realised is not a thing at all", () => {
    const check = checkRiskTransition("closed", "realised", { isAdmin: true, hasNote: true });
    expect(check.allowed).toBe(false);
    expect(check.requiresAdmin).toBe(false);
  });
});
