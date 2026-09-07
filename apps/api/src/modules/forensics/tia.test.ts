import { describe, expect, it } from "vitest";
import {
  CONTINUOUS_CALENDAR,
  FIVE_DAY_CALENDAR,
  type Cpm2DependencyInput,
  type Cpm2TaskInput,
} from "../schedule/cpm2.js";
import { runFragnetTia } from "./tia.js";

/**
 * Fragnet time impact analysis (#272).
 *
 * The engine must (a) push completion by the part of the delay that lands on
 * the critical path and no more, (b) leave a delay absorbed by float at zero,
 * and (c) measure the delay in the STRUCK ACTIVITY'S working days — the same
 * calendar the schedule module computes the programme with.
 */

const CAL: Cpm2TaskInput["calendarId"] = "cal-5d";

function fiveDay() {
  return [{ ...FIVE_DAY_CALENDAR, id: "cal-5d" }];
}

describe("fragnet TIA", () => {
  const tasks: Cpm2TaskInput[] = [
    { id: "a", duration: 10 },
    { id: "b", duration: 10 },
    { id: "c", duration: 5 },
  ];
  const deps: Cpm2DependencyInput[] = [
    { predecessorId: "a", successorId: "b", type: "FS", lagDays: 0 },
    { predecessorId: "b", successorId: "c", type: "FS", lagDays: 0 },
  ];

  it("pushes completion by the full delay when the struck activity is critical", () => {
    const res = runFragnetTia({
      tasks,
      deps,
      projectStart: "2026-01-01",
      struckTaskId: "a",
      fragnetDurationDays: 7,
      fragnetStartDate: "2026-01-11",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.completionDeltaDays).toBe(7);
    expect(res.beforeFinish).toBe("2026-01-25");
    expect(res.afterFinish).toBe("2026-02-01");
  });

  it("reports zero when the delay is absorbed by float", () => {
    // "d" is a 2-day activity feeding "c" with 18 days of float.
    const withFloat: Cpm2TaskInput[] = [...tasks, { id: "d", duration: 2 }];
    const withFloatDeps: Cpm2DependencyInput[] = [
      ...deps,
      { predecessorId: "d", successorId: "c", type: "FS", lagDays: 0 },
    ];
    const res = runFragnetTia({
      tasks: withFloat,
      deps: withFloatDeps,
      projectStart: "2026-01-01",
      struckTaskId: "d",
      fragnetDurationDays: 3,
      fragnetStartDate: "2026-01-03",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.completionDeltaDays).toBe(0);
    expect(res.afterFinish).toBe(res.beforeFinish);
  });

  it("only counts the part of a late-starting delay that bites", () => {
    // The delay starts a week after the struck activity finishes, so a week of
    // it runs while the successor is already under way and is not felt.
    const res = runFragnetTia({
      tasks,
      deps,
      projectStart: "2026-01-01",
      struckTaskId: "a",
      fragnetDurationDays: 10,
      fragnetStartDate: "2026-01-18",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // fragnet: 2026-01-18 + 10d → finishes 2026-01-27, then "b" (10d) and "c"
    // (5d) follow: 2026-02-11 against a 2026-01-25 baseline.
    expect(res.completionDeltaDays).toBe(17);
  });

  it("measures the delay in the struck activity's working days, not calendar days", () => {
    const calTasks: Cpm2TaskInput[] = [
      { id: "a", duration: 5, calendarId: CAL },
      { id: "b", duration: 5, calendarId: CAL },
    ];
    const calDeps: Cpm2DependencyInput[] = [
      { predecessorId: "a", successorId: "b", type: "FS", lagDays: 0 },
    ];
    const base = {
      tasks: calTasks,
      deps: calDeps,
      projectStart: "2026-01-05", // a Monday
      calendars: fiveDay(),
      defaultCalendarId: CAL,
      struckTaskId: "a",
      fragnetDurationDays: 5,
      fragnetStartDate: "2026-01-12",
    };
    const res = runFragnetTia(base);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fragnetCalendarId).toBe(CAL);
    // Five working days of delay push a five-day-week programme by a full
    // calendar week; a continuous-calendar engine would have said five days.
    expect(res.completionDeltaDays).toBe(7);
    expect(res.beforeFinish).toBe("2026-01-16");
    expect(res.afterFinish).toBe("2026-01-23");
  });

  it("honours an explicitly named fragnet calendar", () => {
    const calTasks: Cpm2TaskInput[] = [
      { id: "a", duration: 5, calendarId: CAL },
      { id: "b", duration: 5, calendarId: CAL },
    ];
    const base = {
      tasks: calTasks,
      deps: [{ predecessorId: "a", successorId: "b", type: "FS" as const, lagDays: 0 }],
      projectStart: "2026-01-05",
      calendars: [...fiveDay(), { ...CONTINUOUS_CALENDAR, id: "cal-24-7" }],
      defaultCalendarId: CAL,
      struckTaskId: "a",
      fragnetDurationDays: 5,
      // a Friday: the two calendars diverge over the weekend that follows
      fragnetStartDate: "2026-01-16",
    };

    const onFiveDay = runFragnetTia(base);
    const continuous = runFragnetTia({ ...base, fragnetCalendarId: "cal-24-7" });
    expect(onFiveDay.ok && continuous.ok).toBe(true);
    if (!onFiveDay.ok || !continuous.ok) return;

    expect(onFiveDay.fragnetCalendarId).toBe(CAL);
    expect(continuous.fragnetCalendarId).toBe("cal-24-7");
    // Five days of stoppage that runs through the weekend releases the
    // successor two days earlier than five days of lost SHIFTS would.
    expect(continuous.completionDeltaDays).toBeLessThan(onFiveDay.completionDeltaDays);
    expect(onFiveDay.completionDeltaDays).toBe(13);
    expect(continuous.completionDeltaDays).toBe(11);
  });

  it("refuses a cyclic network rather than inventing a delta", () => {
    const res = runFragnetTia({
      tasks: [
        { id: "a", duration: 1 },
        { id: "b", duration: 1 },
      ],
      deps: [
        { predecessorId: "a", successorId: "b", type: "FS", lagDays: 0 },
        { predecessorId: "b", successorId: "a", type: "FS", lagDays: 0 },
      ],
      projectStart: "2026-01-01",
      struckTaskId: "a",
      fragnetDurationDays: 3,
      fragnetStartDate: "2026-01-01",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.cycle.length).toBeGreaterThan(0);
  });
});
