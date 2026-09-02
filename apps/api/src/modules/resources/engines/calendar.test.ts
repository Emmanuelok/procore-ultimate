import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORK_PATTERN,
  addDays,
  daysBetween,
  enumerateWeeks,
  isIsoDate,
  isWorkday,
  overlapDays,
  overlapWindow,
  weekStartOf,
  workingDaysBetween,
  workingDaysInWeek,
} from "./calendar.js";

describe("calendar", () => {
  it("adds days across a month boundary in UTC", () => {
    expect(addDays("2026-01-30", 3)).toBe("2026-02-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("counts whole days between dates", () => {
    expect(daysBetween("2026-01-01", "2026-01-08")).toBe(7);
    expect(daysBetween("2026-01-08", "2026-01-01")).toBe(-7);
  });

  it("validates ISO dates", () => {
    expect(isIsoDate("2026-02-11")).toBe(true);
    expect(isIsoDate("11/02/2026")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
  });

  it("finds the week start for the configured first day", () => {
    // 2026-02-11 is a Wednesday
    expect(weekStartOf("2026-02-11", 1)).toBe("2026-02-09"); // Monday
    expect(weekStartOf("2026-02-11", 0)).toBe("2026-02-08"); // Sunday
    expect(weekStartOf("2026-02-09", 1)).toBe("2026-02-09");
  });

  it("a Saturday lands in different weeks under different week starts", () => {
    // 2026-02-14 is a Saturday
    expect(weekStartOf("2026-02-14", 1)).toBe("2026-02-09");
    expect(weekStartOf("2026-02-14", 0)).toBe("2026-02-08");
  });

  it("enumerates weeks inclusively and returns nothing for an inverted range", () => {
    expect(enumerateWeeks("2026-02-09", "2026-02-23", 1)).toEqual([
      "2026-02-09",
      "2026-02-16",
      "2026-02-23",
    ]);
    expect(enumerateWeeks("2026-02-23", "2026-02-09", 1)).toEqual([]);
  });

  it("treats weekends as non-working and honours holidays and exceptions", () => {
    const pattern = {
      ...DEFAULT_WORK_PATTERN,
      holidays: ["2026-02-11"],
      exceptions: ["2026-02-14"],
    };
    expect(isWorkday("2026-02-10", pattern)).toBe(true);
    expect(isWorkday("2026-02-11", pattern)).toBe(false); // holiday
    expect(isWorkday("2026-02-14", pattern)).toBe(true); // worked Saturday
    expect(isWorkday("2026-02-15", pattern)).toBe(false); // Sunday
  });

  it("counts working days inclusively and refuses inverted ranges", () => {
    // Mon 9th to Fri 13th February 2026
    expect(workingDaysBetween("2026-02-09", "2026-02-13", DEFAULT_WORK_PATTERN)).toBe(5);
    // spans a weekend
    expect(workingDaysBetween("2026-02-09", "2026-02-16", DEFAULT_WORK_PATTERN)).toBe(6);
    expect(workingDaysBetween("2026-02-16", "2026-02-09", DEFAULT_WORK_PATTERN)).toBe(0);
  });

  it("computes overlaps", () => {
    expect(overlapDays("2026-02-09", "2026-02-13", "2026-02-11", "2026-02-20")).toBe(3);
    expect(overlapDays("2026-02-09", "2026-02-10", "2026-02-11", "2026-02-20")).toBe(0);
    expect(overlapWindow("2026-02-09", "2026-02-13", "2026-02-11", "2026-02-20")).toEqual({
      from: "2026-02-11",
      to: "2026-02-13",
    });
    expect(overlapWindow("2026-02-09", "2026-02-10", "2026-02-11", "2026-02-20")).toBeNull();
  });

  it("counts a task's working days inside a single week", () => {
    // task runs Wed 11th → Tue 17th; week beginning Mon 9th holds Wed-Fri = 3
    expect(workingDaysInWeek("2026-02-09", "2026-02-11", "2026-02-17", DEFAULT_WORK_PATTERN)).toBe(3);
    // the following week holds Mon + Tue = 2
    expect(workingDaysInWeek("2026-02-16", "2026-02-11", "2026-02-17", DEFAULT_WORK_PATTERN)).toBe(2);
    // a week the task does not touch
    expect(workingDaysInWeek("2026-03-02", "2026-02-11", "2026-02-17", DEFAULT_WORK_PATTERN)).toBe(0);
  });
});
