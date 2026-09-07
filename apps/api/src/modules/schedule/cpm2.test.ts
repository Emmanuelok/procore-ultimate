import { describe, expect, it } from "vitest";
import { computeCpm } from "../../lib/cpm.js";
import {
  CONTINUOUS_CALENDAR,
  FIVE_DAY_CALENDAR,
  computeCpm2,
  deriveRemaining,
  hoursToDays,
  workingDaysBetweenIso,
  type Cpm2DependencyInput,
  type Cpm2TaskInput,
} from "./cpm2.js";

const START = "2026-01-05"; // a Monday

function t(id: string, duration: number, extra: Partial<Cpm2TaskInput> = {}): Cpm2TaskInput {
  return { id, duration, ...extra };
}

function fs(p: string, s: string, lag = 0): Cpm2DependencyInput {
  return { predecessorId: p, successorId: s, type: "FS", lagDays: lag };
}

describe("cpm2 — continuous calendar equivalence with lib/cpm.ts", () => {
  it("produces identical dates, float and criticality for a mixed network", () => {
    const tasks: Cpm2TaskInput[] = [
      t("a", 5),
      t("b", 3),
      t("c", 0),
      t("d", 7, { constraintType: "start_no_earlier_than", constraintDate: "2026-01-20" }),
      t("e", 2),
    ];
    const deps: Cpm2DependencyInput[] = [
      fs("a", "b"),
      { predecessorId: "a", successorId: "e", type: "SS", lagDays: 2 },
      fs("b", "c"),
      fs("c", "d", 1),
    ];
    const legacy = computeCpm(
      tasks.map((x) => ({
        id: x.id,
        duration: x.duration,
        constraintType: x.constraintType ?? null,
        constraintDate: x.constraintDate ?? null,
        actualStart: x.actualStart ?? null,
        actualFinish: x.actualFinish ?? null,
      })),
      deps,
      { projectStart: START },
    );
    const next = computeCpm2(tasks, deps, { projectStart: START });
    expect(next.ok).toBe(true);
    expect(next.projectFinishDate).toBe(legacy.projectFinishDate);
    expect(next.projectDurationDays).toBe(legacy.projectDurationDays);
    for (const [id, r] of legacy.tasks) {
      const n = next.tasks.get(id)!;
      expect({ id, s: n.startDate, f: n.finishDate, tf: n.totalFloat }).toEqual({
        id,
        s: r.startDate,
        f: r.finishDate,
        tf: r.totalFloat,
      });
    }
    expect([...next.criticalIds].sort()).toEqual([...legacy.criticalIds].sort());
  });

  it("reports the cycle instead of scheduling it", () => {
    const res = computeCpm2([t("a", 1), t("b", 1)], [fs("a", "b"), fs("b", "a")], {
      projectStart: START,
    });
    expect(res.ok).toBe(false);
    expect(res.cycle.sort()).toEqual(["a", "b"]);
    expect(res.projectFinishDate).toBeNull();
  });
});

describe("cpm2 — work calendars", () => {
  it("skips weekends on a five-day calendar", () => {
    // 5 working days from Mon 5 Jan finish Fri 9 Jan; the successor starts Mon 12.
    const res = computeCpm2([t("a", 5, { calendarId: "w5" }), t("b", 1, { calendarId: "w5" })], [fs("a", "b")], {
      projectStart: START,
      calendars: [{ ...FIVE_DAY_CALENDAR, id: "w5" }],
    });
    expect(res.tasks.get("a")!.startDate).toBe("2026-01-05");
    expect(res.tasks.get("a")!.finishDate).toBe("2026-01-09");
    expect(res.tasks.get("b")!.startDate).toBe("2026-01-12");
    expect(res.tasks.get("b")!.finishDate).toBe("2026-01-12");
  });

  it("a ten-day activity spans two weekends", () => {
    const res = computeCpm2([t("a", 10, { calendarId: "w5" })], [], {
      projectStart: START,
      calendars: [{ ...FIVE_DAY_CALENDAR, id: "w5" }],
    });
    expect(res.tasks.get("a")!.finishDate).toBe("2026-01-16");
  });

  it("honours holidays and working exceptions", () => {
    const cal = { ...FIVE_DAY_CALENDAR, id: "w5", holidays: ["2026-01-07"] };
    const res = computeCpm2([t("a", 5, { calendarId: "w5" })], [], {
      projectStart: START,
      calendars: [cal],
    });
    expect(res.tasks.get("a")!.finishDate).toBe("2026-01-12"); // pushed by the Wednesday holiday

    const withSaturday = {
      ...FIVE_DAY_CALENDAR,
      id: "w5",
      holidays: ["2026-01-07"],
      exceptions: ["2026-01-10"],
    };
    const res2 = computeCpm2([t("a", 5, { calendarId: "w5" })], [], {
      projectStart: START,
      calendars: [withSaturday],
    });
    expect(res2.tasks.get("a")!.finishDate).toBe("2026-01-10"); // Saturday recovered the holiday
  });

  it("measures total float in working days", () => {
    // a(2d) and b(2d) both feed c; b has a week of slack over the weekend.
    const tasks = [
      t("a", 10, { calendarId: "w5" }),
      t("b", 2, { calendarId: "w5" }),
      t("c", 1, { calendarId: "w5" }),
    ];
    const res = computeCpm2(tasks, [fs("a", "c"), fs("b", "c")], {
      projectStart: START,
      calendars: [{ ...FIVE_DAY_CALENDAR, id: "w5" }],
    });
    expect(res.tasks.get("a")!.totalFloat).toBe(0);
    // b finishes 8 working days before it must — calendar days would say 12.
    expect(res.tasks.get("b")!.totalFloat).toBe(8);
    expect(res.tasks.get("a")!.isCritical).toBe(true);
    expect(res.tasks.get("b")!.isCritical).toBe(false);
  });

  it("falls back to the schedule default calendar for tasks that name none", () => {
    const res = computeCpm2([t("a", 5)], [], {
      projectStart: START,
      calendars: [{ ...FIVE_DAY_CALENDAR, id: "w5" }],
      defaultCalendarId: "w5",
    });
    expect(res.tasks.get("a")!.finishDate).toBe("2026-01-09");
  });
});

describe("cpm2 — data date and remaining duration", () => {
  it("pushes unstarted work to the data date", () => {
    const res = computeCpm2([t("a", 5), t("b", 5)], [fs("a", "b")], {
      projectStart: START,
      dataDate: "2026-01-15",
    });
    expect(res.tasks.get("a")!.startDate).toBe("2026-01-15");
    expect(res.tasks.get("b")!.startDate).toBe("2026-01-20");
    expect(res.dataDate).toBe("2026-01-15");
  });

  it("forecasts in-progress work from the data date using remaining duration", () => {
    const res = computeCpm2(
      [
        t("a", 10, { actualStart: "2026-01-05", percentComplete: 50 }),
        t("b", 2),
      ],
      [fs("a", "b")],
      { projectStart: START, dataDate: "2026-01-20" },
    );
    const a = res.tasks.get("a")!;
    expect(a.startDate).toBe("2026-01-05"); // the actual start is a fact
    expect(a.remainingDuration).toBe(5);
    expect(a.finishDate).toBe("2026-01-24"); // 5 remaining days from the data date
    expect(res.tasks.get("b")!.startDate).toBe("2026-01-25");
  });

  it("explicit remaining duration wins over percent complete", () => {
    const res = computeCpm2(
      [t("a", 10, { actualStart: "2026-01-05", percentComplete: 50, remainingDuration: 12 })],
      [],
      { projectStart: START, dataDate: "2026-01-20" },
    );
    expect(res.tasks.get("a")!.remainingDuration).toBe(12);
    expect(res.tasks.get("a")!.finishDate).toBe("2026-01-31");
  });

  it("a completed task keeps its actual dates and is never critical", () => {
    const res = computeCpm2(
      [t("a", 5, { actualStart: "2026-01-05", actualFinish: "2026-01-07" }), t("b", 3)],
      [fs("a", "b")],
      { projectStart: START, dataDate: "2026-01-10" },
    );
    const a = res.tasks.get("a")!;
    expect(a.startDate).toBe("2026-01-05");
    expect(a.finishDate).toBe("2026-01-07");
    expect(a.complete).toBe(true);
    expect(a.isCritical).toBe(false);
    expect(res.tasks.get("b")!.startDate).toBe("2026-01-10");
  });

  it("deriveRemaining covers the not-started / part-done / done cases", () => {
    expect(deriveRemaining({ id: "x", duration: 10 })).toBe(10);
    expect(deriveRemaining({ id: "x", duration: 10, actualStart: "2026-01-01", percentComplete: 35 })).toBe(7);
    expect(deriveRemaining({ id: "x", duration: 10, actualStart: "2026-01-01", percentComplete: 100 })).toBe(0);
    expect(deriveRemaining({ id: "x", duration: 10, actualFinish: "2026-01-05" })).toBe(0);
  });
});

describe("cpm2 — float and driving path", () => {
  it("computes free float distinct from total float", () => {
    // a -> c and b -> c; a has 4 days of both total and free float.
    const res = computeCpm2([t("a", 1), t("b", 5), t("c", 1)], [fs("a", "c"), fs("b", "c")], {
      projectStart: START,
    });
    expect(res.tasks.get("a")!.totalFloat).toBe(4);
    expect(res.tasks.get("a")!.freeFloat).toBe(4);
    expect(res.tasks.get("b")!.freeFloat).toBe(0);
  });

  it("reports the driving chain as the longest path", () => {
    const res = computeCpm2(
      [t("a", 5), t("b", 1), t("c", 10), t("d", 2)],
      [fs("a", "b"), fs("a", "c"), fs("b", "d"), fs("c", "d")],
      { projectStart: START },
    );
    expect(res.longestPath).toEqual(["a", "c", "d"]);
  });

  it("level-of-effort activities never appear on the critical path", () => {
    const res = computeCpm2(
      [t("a", 5), t("loe", 5, { taskType: "level_of_effort" })],
      [],
      { projectStart: START },
    );
    expect(res.tasks.get("loe")!.totalFloat).toBe(0);
    expect(res.tasks.get("loe")!.isCritical).toBe(false);
    expect(res.criticalIds).toEqual(["a"]);
  });
});

describe("cpm2 — helpers", () => {
  it("converts source-file hours to days", () => {
    expect(hoursToDays(80, 8)).toBe(10);
    expect(hoursToDays(0, 8)).toBe(0);
    expect(hoursToDays(60, 0)).toBe(7.5); // hoursPerDay 0 falls back to 8
  });

  it("counts working days between two dates", () => {
    expect(workingDaysBetweenIso({ ...CONTINUOUS_CALENDAR }, "2026-01-05", "2026-01-12")).toBe(7);
    expect(workingDaysBetweenIso({ ...FIVE_DAY_CALENDAR }, "2026-01-05", "2026-01-12")).toBe(5);
  });
});
