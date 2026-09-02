import { describe, expect, it } from "vitest";
import {
  classifyExposure,
  daysInclusive,
  mergeRanges,
  projectBreachDate,
  subtractMonthsISO,
  summarisePresence,
} from "./pe.js";

describe("PE day-count engine", () => {
  it("counts inclusive days and refuses inverted ranges", () => {
    expect(daysInclusive("2026-01-01", "2026-01-01")).toBe(1);
    expect(daysInclusive("2026-01-01", "2026-01-31")).toBe(31);
    expect(daysInclusive("2026-02-01", "2026-01-01")).toBe(0);
    expect(daysInclusive("bad", "2026-01-01")).toBe(0);
  });

  it("merges overlapping and adjacent ranges so a day is never counted twice", () => {
    const merged = mergeRanges([
      { startDate: "2026-03-10", endDate: "2026-03-20" },
      { startDate: "2026-03-01", endDate: "2026-03-05" },
      { startDate: "2026-03-06", endDate: "2026-03-08" }, // adjacent to the first
      { startDate: "2026-03-15", endDate: "2026-03-25" }, // overlaps the 10–20 range
      { startDate: "2026-04-02", endDate: "2026-04-01" }, // inverted, dropped
    ]);
    expect(merged).toEqual([
      { startDate: "2026-03-01", endDate: "2026-03-08" },
      { startDate: "2026-03-10", endDate: "2026-03-25" },
    ]);
  });

  it("subtracts months with end-of-month clamping", () => {
    expect(subtractMonthsISO("2026-03-31", 1)).toBe("2026-02-28");
    expect(subtractMonthsISO("2026-09-01", 12)).toBe("2025-09-01");
    expect(subtractMonthsISO("2026-01-15", 2)).toBe("2025-11-15");
  });

  it("counts only the days inside a rolling window, and everything when the window is 0", () => {
    const ranges = [
      { startDate: "2025-01-01", endDate: "2025-03-31" }, // 90 days, outside a 12-month window ending 2026-09-01
      { startDate: "2026-01-01", endDate: "2026-01-31" }, // 31 days inside
      { startDate: "2026-08-25", endDate: "2026-09-10" }, // straddles asOf: 8 days count (25 Aug–1 Sep)
    ];
    const rolling = summarisePresence(ranges, "2026-09-01", 12);
    expect(rolling.windowStart).toBe("2025-09-02");
    expect(rolling.daysInWindow).toBe(31 + 8);
    expect(rolling.daysTotal).toBe(90 + 31 + 17);
    expect(rolling.firstPresenceDate).toBe("2025-01-01");
    expect(rolling.lastPresenceDate).toBe("2026-09-10");
    const whole = summarisePresence(ranges, "2026-09-01", 0);
    expect(whole.windowStart).toBeNull();
    expect(whole.daysInWindow).toBe(90 + 31 + 8);
  });

  it("classifies against the threshold, keeps human dispositions sticky except on a real breach", () => {
    expect(classifyExposure(10, 183, 0.75, "monitoring")).toBe("monitoring");
    expect(classifyExposure(138, 183, 0.75, "monitoring")).toBe("approaching"); // ceil(137.25) = 138
    expect(classifyExposure(137, 183, 0.75, "monitoring")).toBe("monitoring");
    expect(classifyExposure(183, 183, 0.75, "approaching")).toBe("breached");
    expect(classifyExposure(150, 183, 0.75, "mitigated")).toBe("mitigated");
    expect(classifyExposure(190, 183, 0.75, "mitigated")).toBe("breached");
    expect(classifyExposure(500, 183, 0.75, "closed")).toBe("closed");
  });

  it("projects a breach date at the observed run-rate and returns null without enough history", () => {
    const summary = summarisePresence([{ startDate: "2026-06-01", endDate: "2026-08-30" }], "2026-09-01", 12);
    // 91 days present over 93 elapsed days → ~0.978 days/day; 183-91 = 92 remaining → ceil(92/0.978)=95
    const projected = projectBreachDate(summary, 183, "2026-09-01");
    expect(projected).toBe("2026-12-05");
    const thin = summarisePresence([{ startDate: "2026-08-25", endDate: "2026-08-30" }], "2026-09-01", 12);
    expect(projectBreachDate(thin, 183, "2026-09-01")).toBeNull();
    const breached = summarisePresence([{ startDate: "2026-01-01", endDate: "2026-08-30" }], "2026-09-01", 12);
    expect(projectBreachDate(breached, 183, "2026-09-01")).toBeNull();
    expect(projectBreachDate(summarisePresence([], "2026-09-01", 12), 183, "2026-09-01")).toBeNull();
  });
});
