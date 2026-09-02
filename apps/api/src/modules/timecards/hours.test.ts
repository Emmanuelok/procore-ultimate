import { describe, expect, it } from "vitest";
import {
  ACCESS_GAP_MIN_DAYS,
  OVERCLAIM_PATTERN_MIN_DAYS,
  VARIANCE_TOLERANCE_HOURS,
  accessVariance,
  classifyHours,
  costHours,
  detectVariancePatterns,
  elapsedHours,
  reconcileAllocations,
  type OvertimeRule,
  type VarianceRow,
} from "./hours.js";

const daily = (threshold: number | null, dt: number | null = null): OvertimeRule => ({
  kind: "daily",
  thresholdHours: threshold,
  doubleTimeThresholdHours: dt,
  source: "Crew CRW-001 (Concrete gang)",
});

const weekly = (threshold: number | null, dt: number | null = null): OvertimeRule => ({
  kind: "weekly",
  thresholdHours: threshold,
  doubleTimeThresholdHours: dt,
  source: "Crew CRW-002 (Steel fixers)",
});

/* ------------------------------------------------------------------ */
/* Hour classification — the daily rule                                */
/* ------------------------------------------------------------------ */

describe("classifyHours — daily rule at the threshold boundary", () => {
  it("treats exactly the threshold as plain time, and the next minute as overtime", () => {
    const at = classifyHours({ workedHours: 8, rule: daily(8) });
    expect(at.value).toEqual({
      regularHours: 8,
      overtimeHours: 0,
      doubleTimeHours: 0,
      premiumHours: 0,
      totalHours: 8,
    });

    const under = classifyHours({ workedHours: 7.75, rule: daily(8) });
    expect(under.value?.regularHours).toBe(7.75);
    expect(under.value?.overtimeHours).toBe(0);

    const over = classifyHours({ workedHours: 8.5, rule: daily(8) });
    expect(over.value?.regularHours).toBe(8);
    expect(over.value?.overtimeHours).toBe(0.5);
    expect(over.value?.totalHours).toBe(8.5);
  });

  it("opens a double-time band above the double-time threshold", () => {
    const r = classifyHours({ workedHours: 14, rule: daily(8, 12) });
    expect(r.value).toEqual({
      regularHours: 8,
      overtimeHours: 4,
      doubleTimeHours: 2,
      premiumHours: 0,
      totalHours: 14,
    });
    // exactly on the double-time threshold is still overtime
    expect(classifyHours({ workedHours: 12, rule: daily(8, 12) }).value).toMatchObject({
      overtimeHours: 4,
      doubleTimeHours: 0,
    });
  });

  it("collapses the overtime band when double time starts at the same hour", () => {
    const r = classifyHours({ workedHours: 11, rule: daily(8, 8) });
    expect(r.value).toMatchObject({ regularHours: 8, overtimeHours: 0, doubleTimeHours: 3 });
  });

  it("returns the rule it applied, in words, rather than burying it", () => {
    const r = classifyHours({ workedHours: 10, rule: daily(8, 12) });
    expect(r.rule).toMatchObject({ kind: "daily", basis: "day", thresholdHours: 8 });
    expect(r.rule?.explanation).toContain("daily overtime rule");
    expect(r.rule?.explanation).toContain("beyond 8 per day");
    expect(r.rule?.explanation).toContain("Crew CRW-001");
    expect(r.reasons).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Hour classification — the weekly rule                               */
/* ------------------------------------------------------------------ */

describe("classifyHours — weekly rule at the threshold boundary", () => {
  it("splits the day that straddles the weekly threshold", () => {
    const r = classifyHours({ workedHours: 8, priorWeekLadderHours: 36, rule: weekly(40) });
    expect(r.value).toMatchObject({ regularHours: 4, overtimeHours: 4, totalHours: 8 });
    expect(r.rule?.cumulativeFrom).toBe(36);
    expect(r.rule?.cumulativeTo).toBe(44);
  });

  it("treats a week that lands exactly on the threshold as all plain time", () => {
    const r = classifyHours({ workedHours: 8, priorWeekLadderHours: 32, rule: weekly(40) });
    expect(r.value).toMatchObject({ regularHours: 8, overtimeHours: 0 });
  });

  it("puts a whole day into overtime once the week is already over the threshold", () => {
    const r = classifyHours({ workedHours: 8, priorWeekLadderHours: 40, rule: weekly(40) });
    expect(r.value).toMatchObject({ regularHours: 0, overtimeHours: 8, doubleTimeHours: 0 });
  });

  it("carries a day across the overtime and double-time bands in one week", () => {
    const r = classifyHours({ workedHours: 8, priorWeekLadderHours: 44, rule: weekly(40, 48) });
    expect(r.value).toMatchObject({ regularHours: 0, overtimeHours: 4, doubleTimeHours: 4 });
  });

  it("gives a materially different answer from the daily rule on the same day", () => {
    // A 10-hour Wednesday in a slow week: all plain time weekly, 2 h overtime daily.
    const asWeekly = classifyHours({ workedHours: 10, priorWeekLadderHours: 10, rule: weekly(40) });
    const asDaily = classifyHours({ workedHours: 10, rule: daily(8) });
    expect(asWeekly.value).toMatchObject({ regularHours: 10, overtimeHours: 0 });
    expect(asDaily.value).toMatchObject({ regularHours: 8, overtimeHours: 2 });
    expect(asWeekly.rule?.basis).toBe("week");
    expect(asDaily.rule?.basis).toBe("day");
  });
});

/* ------------------------------------------------------------------ */
/* Hour classification — refusals and premium                          */
/* ------------------------------------------------------------------ */

describe("classifyHours — refusals rather than plausible guesses", () => {
  it("refuses to classify when the crew records no threshold, naming the fix", () => {
    const r = classifyHours({ workedHours: 10, rule: daily(null) });
    expect(r.value).toBeNull();
    expect(r.rule).toBeNull();
    expect(r.reasons.join(" ")).toContain("records no overtime threshold");
    expect(r.reasons.join(" ")).toContain("overtimeThresholdHours");
    expect(r.inputs).toMatchObject({ workedHours: 10, ruleKind: "daily" });
  });

  it("refuses a double-time threshold that sits below the overtime threshold", () => {
    const r = classifyHours({ workedHours: 10, rule: daily(8, 6) });
    expect(r.value).toBeNull();
    expect(r.reasons.join(" ")).toContain("below its overtime");
  });

  it('classifies every hour as plain time under an explicit "none" rule', () => {
    const r = classifyHours({
      workedHours: 12,
      rule: { kind: "none", thresholdHours: null, doubleTimeThresholdHours: null, source: "Crew CRW-003" },
    });
    expect(r.value).toMatchObject({ regularHours: 12, overtimeHours: 0, totalHours: 12 });
    expect(r.rule?.explanation).toContain("runs no overtime rule");
  });

  it("carves premium hours out before the ladder and keeps the total identity", () => {
    const r = classifyHours({
      workedHours: 10,
      premiumHours: 2,
      premiumKind: "night_shift",
      rule: daily(8),
    });
    expect(r.value).toEqual({
      regularHours: 8,
      overtimeHours: 0,
      doubleTimeHours: 0,
      premiumHours: 2,
      totalHours: 10,
    });
    expect(r.rule?.explanation).toContain("night_shift premium");
  });

  it("refuses unnamed premium hours and premium beyond the day worked", () => {
    const unnamed = classifyHours({ workedHours: 10, premiumHours: 2, rule: daily(8) });
    expect(unnamed.value).toBeNull();
    expect(unnamed.reasons.join(" ")).toContain('premiumKind "none"');

    const tooMuch = classifyHours({
      workedHours: 6,
      premiumHours: 8,
      premiumKind: "hazard",
      rule: daily(8),
    });
    expect(tooMuch.value).toBeNull();
    expect(tooMuch.reasons.join(" ")).toContain("exceeds the 6 hour(s) worked");
  });
});

/* ------------------------------------------------------------------ */
/* Clock times                                                         */
/* ------------------------------------------------------------------ */

describe("elapsedHours", () => {
  it("nets the break out of a day shift and reads an overnight shift as crossing midnight", () => {
    expect(elapsedHours("07:00", "17:30", 30).value).toBe(10);
    expect(elapsedHours("19:00", "05:00", 60).value).toBe(9);
  });

  it("refuses a break longer than the shift and an unreadable time", () => {
    const swallowed = elapsedHours("08:00", "10:00", 180);
    expect(swallowed.value).toBeNull();
    expect(swallowed.reasons.join(" ")).toContain("negative");
    expect(elapsedHours("8am", "17:00").value).toBeNull();
    expect(elapsedHours("07:00", "99:99").value).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Claimed vs present                                                  */
/* ------------------------------------------------------------------ */

describe("accessVariance — the missing-record rule", () => {
  it("returns null with a reason when no access record exists, never zero hours present", () => {
    const r = accessVariance({ claimedHours: 10, hasAccessRecord: false });
    expect(r.value).toBeNull();
    expect(r.accessHours).toBeNull();
    expect(r.direction).toBeNull();
    expect(r.withinTolerance).toBeNull();
    // the whole point: a data gap must not become a finding
    expect(r.requiresExplanation).toBe(false);
    expect(r.reasons.join(" ")).toContain("not zero hours");
    expect(r.reasons.join(" ")).toContain("gap in the evidence stream");
  });

  it("returns null when the record exists but carries no usable hours", () => {
    const r = accessVariance({ claimedHours: 9, hasAccessRecord: true, accessHoursOnSite: null });
    expect(r.value).toBeNull();
    expect(r.reasons.join(" ")).toContain("neither confirmed nor contradicted");
  });

  it("computes the variance from the recorded hours, or derives it from the gate times", () => {
    const recorded = accessVariance({
      claimedHours: 10,
      hasAccessRecord: true,
      accessHoursOnSite: 7.5,
    });
    expect(recorded.value).toBe(2.5);
    expect(recorded.direction).toBe("over");
    expect(recorded.accessHoursSource).toBe("recorded");

    const derived = accessVariance({
      claimedHours: 8,
      hasAccessRecord: true,
      accessHoursOnSite: null,
      firstIn: "07:00",
      lastOut: "16:00",
    });
    expect(derived.accessHours).toBe(9);
    expect(derived.value).toBe(-1);
    expect(derived.direction).toBe("under");
    expect(derived.accessHoursSource).toBe("derived_from_gate_times");
  });

  it("requires an explanation only beyond tolerance, and accepts one when given", () => {
    const within = accessVariance({
      claimedHours: 8.4,
      hasAccessRecord: true,
      accessHoursOnSite: 8,
    });
    expect(within.withinTolerance).toBe(true);
    expect(within.requiresExplanation).toBe(false);

    const beyond = accessVariance({
      claimedHours: 10,
      hasAccessRecord: true,
      accessHoursOnSite: 8,
    });
    expect(beyond.withinTolerance).toBe(false);
    expect(beyond.requiresExplanation).toBe(true);

    const explained = accessVariance({
      claimedHours: 10,
      hasAccessRecord: true,
      accessHoursOnSite: 8,
      explanation: "Worked two hours in the basement plant room; no exit swipe on that door.",
    });
    expect(explained.value).toBe(2);
    expect(explained.explained).toBe(true);
    expect(explained.requiresExplanation).toBe(false);
    expect(explained.toleranceHours).toBe(VARIANCE_TOLERANCE_HOURS);
  });
});

/* ------------------------------------------------------------------ */
/* Pattern detection                                                   */
/* ------------------------------------------------------------------ */

const row = (over: Partial<VarianceRow> = {}): VarianceRow => ({
  timecardId: "tcd_1",
  reference: "TC-001",
  workerId: "wkr_1",
  workerReference: "W-001",
  workerName: "A Worker",
  vendorId: null,
  workDate: "2026-03-02",
  shift: "day",
  claimedHours: 10,
  accessHours: 8,
  varianceHours: 2,
  explained: false,
  explanation: null,
  reasons: [],
  ...over,
});

describe("detectVariancePatterns", () => {
  it("flags a repeated unexplained positive variance as an overclaim pattern", () => {
    const rows = [
      row({ timecardId: "a", workDate: "2026-03-02" }),
      row({ timecardId: "b", workDate: "2026-03-03" }),
      row({ timecardId: "c", workDate: "2026-03-04" }),
    ];
    const s = detectVariancePatterns(rows, { periodStart: "2026-03-01", periodEnd: "2026-03-07" });
    const w = s.workers[0]!;
    expect(w.isOverclaimPattern).toBe(true);
    expect(w.unexplainedOverDays).toBe(OVERCLAIM_PATTERN_MIN_DAYS);
    expect(w.unexplainedOverHours).toBe(6);
    expect(w.isAccessGap).toBe(false);
    expect(s.overclaimPatterns).toBe(1);
    expect(w.reason).toContain("nobody has explained");
  });

  it("does not flag days somebody explained", () => {
    const rows = [
      row({ timecardId: "a", workDate: "2026-03-02", explained: true, explanation: "plant room" }),
      row({ timecardId: "b", workDate: "2026-03-03", explained: true, explanation: "plant room" }),
      row({ timecardId: "c", workDate: "2026-03-04", explained: true, explanation: "plant room" }),
    ];
    const s = detectVariancePatterns(rows, { periodStart: "2026-03-01", periodEnd: "2026-03-07" });
    expect(s.overclaimPatterns).toBe(0);
    expect(s.workers[0]!.explainedOverDays).toBe(3);
  });

  it("reports missing access records as a DATA GAP and never as an overclaim", () => {
    const rows = Array.from({ length: ACCESS_GAP_MIN_DAYS }, (_, i) =>
      row({
        timecardId: `m${i}`,
        workDate: `2026-03-0${i + 2}`,
        accessHours: null,
        varianceHours: null,
        reasons: ["No site-access record exists for this worker on this date"],
      }),
    );
    const s = detectVariancePatterns(rows, { periodStart: "2026-03-01", periodEnd: "2026-03-07" });
    const w = s.workers[0]!;
    expect(w.isAccessGap).toBe(true);
    expect(w.isOverclaimPattern).toBe(false);
    expect(w.unexplainedOverHours).toBe(0);
    expect(w.daysWithoutAccessRecord).toBe(ACCESS_GAP_MIN_DAYS);
    expect(w.reason).toContain("NOT a finding against the worker");
    expect(s.compared).toBe(0);
    expect(s.withoutAccessRecord).toBe(ACCESS_GAP_MIN_DAYS);
  });

  it("says nothing about a worker whose days are all within tolerance", () => {
    const rows = [
      row({ timecardId: "a", claimedHours: 8, accessHours: 8, varianceHours: 0 }),
      row({ timecardId: "b", claimedHours: 8.2, accessHours: 8, varianceHours: 0.2 }),
    ];
    const s = detectVariancePatterns(rows, { periodStart: "2026-03-01", periodEnd: "2026-03-07" });
    expect(s.overclaimPatterns).toBe(0);
    expect(s.accessGaps).toBe(0);
    expect(s.workers[0]!.reason).toContain("within tolerance");
  });
});

/* ------------------------------------------------------------------ */
/* Allocation reconciliation                                           */
/* ------------------------------------------------------------------ */

const claimed = {
  regularHours: 8,
  overtimeHours: 2,
  doubleTimeHours: 0,
  premiumHours: 0,
  totalHours: 10,
};

describe("reconcileAllocations", () => {
  it("accepts a set that adds up bucket by bucket", () => {
    const r = reconcileAllocations(claimed, [
      { regularHours: 5 },
      { regularHours: 3, overtimeHours: 2 },
    ]);
    expect(r.ok).toBe(true);
    expect(r.message).toBeNull();
    expect(r.allocated.totalHours).toBe(10);
  });

  it("refuses a short set and NAMES the difference", () => {
    const r = reconcileAllocations(claimed, [{ regularHours: 8 }, { overtimeHours: 1.5 }]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("9.5 hour(s) allocated against 10 hour(s) claimed");
    expect(r.message).toContain("short by 0.5 hour(s)");
    expect(r.message).toContain("overtime: 1.5 allocated vs 2 claimed (-0.5)");
    expect(r.differences).toContainEqual({
      bucket: "overtimeHours",
      claimed: 2,
      allocated: 1.5,
      difference: -0.5,
    });
  });

  it("refuses an over-allocated set", () => {
    const r = reconcileAllocations(claimed, [{ regularHours: 8, overtimeHours: 2 }, { regularHours: 1 }]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("over by 1 hour(s)");
  });

  it("refuses a set that balances on the total but moves hours between pay treatments", () => {
    const r = reconcileAllocations(claimed, [{ regularHours: 10 }]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("balance in total but not by pay treatment");
    expect(r.message).toContain("regular: 10 allocated vs 8 claimed (+2)");
    expect(r.message).toContain("overtime: 0 allocated vs 2 claimed (-2)");
  });

  it("refuses an empty set against a card with hours", () => {
    expect(reconcileAllocations(claimed, []).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Costing                                                             */
/* ------------------------------------------------------------------ */

describe("costHours", () => {
  it("applies the burden multiplier to the sum of the priced buckets", () => {
    const r = costHours(claimed, {
      hourlyRate: 30,
      overtimeRate: 45,
      doubleTimeRate: null,
      premiumRate: null,
      burdenRate: 1.35,
      currency: "USD",
    });
    expect(r.value).toBe(445.5); // (8×30 + 2×45) × 1.35
    expect(r.reasons).toEqual([]);
  });

  it("refuses rather than costing an overtime hour at nothing", () => {
    const r = costHours(claimed, {
      hourlyRate: 30,
      overtimeRate: null,
      doubleTimeRate: null,
      premiumRate: null,
      burdenRate: null,
      currency: "USD",
    });
    expect(r.value).toBeNull();
    expect(r.reasons.join(" ")).toContain("no overtimeRate is recorded");
    expect(r.reasons.join(" ")).toContain("unknown rather than zero");
  });
});
