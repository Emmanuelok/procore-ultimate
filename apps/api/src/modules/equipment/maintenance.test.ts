import { describe, expect, it } from "vitest";
import {
  addMonths,
  averageDailyUsage,
  computeNextDue,
  earliestDue,
  type NextDueInput,
  type ScheduleDue,
} from "./maintenance.js";

const input = (over: Partial<NextDueInput> = {}): NextDueInput => ({
  intervalKind: "operating_hours",
  intervalValue: 500,
  warnAheadValue: 50,
  lastPerformedAt: null,
  lastPerformedMeter: null,
  currentMeter: null,
  meterType: "hours",
  asOf: "2026-08-25",
  ...over,
});

describe("addMonths", () => {
  it("clamps to the end of a short month rather than rolling into the next", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28");
  });

  it("crosses a year boundary correctly", () => {
    expect(addMonths("2026-11-15", 6)).toBe("2027-05-15");
  });
});

describe("computeNextDue — meter intervals", () => {
  it("adds the interval to the last performed meter", () => {
    const r = computeNextDue(input({ lastPerformedMeter: 1200, currentMeter: 1400 }));
    expect(r.nextDueMeter).toBe(1700);
    expect(r.meterRemaining).toBe(300);
    expect(r.status).toBe("scheduled");
    expect(r.basis).toBe("meter");
  });

  it("reads due_soon exactly at the warn-ahead boundary", () => {
    const r = computeNextDue({
      ...input({ lastPerformedMeter: 1200, currentMeter: 1650 }),
      warnAheadValue: 50,
    });
    expect(r.meterRemaining).toBe(50);
    expect(r.status).toBe("due_soon");
  });

  it("is scheduled, not overdue, exactly ON the due meter", () => {
    const r = computeNextDue(input({ lastPerformedMeter: 1200, currentMeter: 1700 }));
    expect(r.meterRemaining).toBe(0);
    expect(r.status).toBe("due_soon");
    expect(r.overdueBy).toBeNull();
  });

  it("reports overdue with the margin in meter units", () => {
    const r = computeNextDue(input({ lastPerformedMeter: 1200, currentMeter: 1830 }));
    expect(r.status).toBe("overdue");
    expect(r.overdueBy).toEqual({ value: 130, unit: "hours" });
  });

  it("abstains when the machine's meter has never been read", () => {
    const r = computeNextDue(input({ lastPerformedMeter: 1200, currentMeter: null }));
    expect(r.status).toBe("not_scheduled");
    expect(r.nextDueMeter).toBe(1700);
    expect(r.reasons.join(" ")).toContain("no current meter reading");
  });

  it("abstains when the schedule has never been performed and has no baseline", () => {
    const r = computeNextDue(input({ currentMeter: 900 }));
    expect(r.status).toBe("not_scheduled");
    expect(r.nextDueMeter).toBeNull();
    expect(r.reasons.join(" ")).toContain("no baseline meter");
  });

  it("counts from a baseline meter when one is supplied, and says it did", () => {
    const r = computeNextDue(input({ baselineMeter: 1000, currentMeter: 1100 }));
    expect(r.nextDueMeter).toBe(1500);
    expect(r.reasons.join(" ")).toContain("baseline meter 1000");
  });

  it("projects a meter interval onto a date when a usage rate is known", () => {
    const r = computeNextDue(
      input({ lastPerformedMeter: 1200, currentMeter: 1600, averageDailyUsage: 10 }),
    );
    expect(r.meterRemaining).toBe(100);
    expect(r.projectedDueAt).toBe("2026-09-04");
    expect(r.nextDueAt).toBeNull();
  });

  it("flags a distance interval on an hours meter as mismatched", () => {
    const r = computeNextDue(
      input({ intervalKind: "distance", meterType: "hours", lastPerformedMeter: 0, currentMeter: 10 }),
    );
    expect(r.reasons.join(" ")).toContain("not the same quantity");
  });

  it("never falls due on a machine with no meter", () => {
    const r = computeNextDue(input({ meterType: "none", lastPerformedMeter: 0, currentMeter: 10 }));
    expect(r.status).toBe("not_scheduled");
    expect(r.reasons.join(" ")).toContain("no meter at all");
  });
});

describe("computeNextDue — calendar intervals", () => {
  it("adds calendar days from the last service", () => {
    const r = computeNextDue(
      input({
        intervalKind: "calendar_days",
        intervalValue: 90,
        warnAheadValue: 14,
        lastPerformedAt: "2026-06-01",
      }),
    );
    expect(r.nextDueAt).toBe("2026-08-30");
    expect(r.daysRemaining).toBe(5);
    expect(r.status).toBe("due_soon");
  });

  it("adds calendar months and reports overdue in days", () => {
    const r = computeNextDue(
      input({ intervalKind: "calendar_months", intervalValue: 6, lastPerformedAt: "2026-01-31" }),
    );
    expect(r.nextDueAt).toBe("2026-07-31");
    expect(r.status).toBe("overdue");
    expect(r.overdueBy).toEqual({ value: 25, unit: "days" });
  });

  it("uses the baseline date when the schedule has never been performed", () => {
    const r = computeNextDue(
      input({
        intervalKind: "calendar_months",
        intervalValue: 12,
        baselineDate: "2026-03-01",
      }),
    );
    expect(r.nextDueAt).toBe("2027-03-01");
    expect(r.reasons.join(" ")).toContain("counted from the baseline date");
  });

  it("refuses to compute for a condition-based schedule", () => {
    const r = computeNextDue(input({ intervalKind: "condition_based" }));
    expect(r.status).toBe("not_scheduled");
    expect(r.nextDueAt).toBeNull();
    expect(r.reasons.join(" ")).toContain("condition-based");
  });
});

describe("earliestDue — calendar and meter intervals race each other", () => {
  const row = (over: Partial<ScheduleDue>): ScheduleDue => ({
    scheduleId: "s1",
    name: "s1",
    intervalKind: "calendar_days",
    isStatutory: false,
    nextDueAt: null,
    nextDueMeter: null,
    basis: "calendar",
    status: "scheduled",
    meterRemaining: null,
    daysRemaining: null,
    projectedDueAt: null,
    overdueBy: null,
    reasons: [],
    ...over,
  });

  it("puts an overdue schedule ahead of everything else", () => {
    const winner = earliestDue([
      row({ scheduleId: "a", name: "a", nextDueAt: "2026-09-01" }),
      row({ scheduleId: "b", name: "b", status: "overdue", overdueBy: { value: 3, unit: "days" } }),
    ]);
    expect(winner?.scheduleId).toBe("b");
  });

  it("picks the earlier date, counting a projected meter date", () => {
    const winner = earliestDue([
      row({ scheduleId: "a", name: "a", nextDueAt: "2026-10-01" }),
      row({ scheduleId: "b", name: "b", basis: "meter", projectedDueAt: "2026-09-04" }),
    ]);
    expect(winner?.scheduleId).toBe("b");
  });

  it("returns null for a machine with no schedules", () => {
    expect(earliestDue([])).toBeNull();
  });
});

describe("averageDailyUsage", () => {
  it("divides the meter delta by the elapsed days", () => {
    expect(
      averageDailyUsage(
        { value: 1000, at: "2026-08-01T00:00:00.000Z" },
        { value: 1100, at: "2026-08-11T00:00:00.000Z" },
      ),
    ).toBe(10);
  });

  it("returns null rather than 0 when the meter went backwards", () => {
    expect(
      averageDailyUsage(
        { value: 1100, at: "2026-08-01T00:00:00.000Z" },
        { value: 1000, at: "2026-08-11T00:00:00.000Z" },
      ),
    ).toBeNull();
  });

  it("returns null for a degenerate window", () => {
    expect(
      averageDailyUsage(
        { value: 1000, at: "2026-08-01T00:00:00.000Z" },
        { value: 1100, at: "2026-08-01T00:00:00.000Z" },
      ),
    ).toBeNull();
  });
});
