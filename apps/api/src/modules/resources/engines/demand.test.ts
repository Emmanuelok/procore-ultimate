import { describe, expect, it } from "vitest";
import { DEFAULT_WORK_PATTERN } from "./calendar.js";
import {
  collapseByTypeWeek,
  deriveDemand,
  headcountFor,
  type DemandTask,
} from "./demand.js";

const task = (over: Partial<DemandTask> = {}): DemandTask => ({
  id: "t1",
  name: "Slab pour",
  startDate: "2026-02-09", // Monday
  finishDate: "2026-02-20", // Friday of the following week
  percentComplete: 0,
  totalFloat: 10,
  isCritical: false,
  budgetedHours: 400,
  resourceTypeId: "rt_conc",
  resources: [],
  ...over,
});

describe("deriveDemand", () => {
  it("spreads hours over working days and buckets them by week", () => {
    const result = deriveDemand([task()], { pattern: DEFAULT_WORK_PATTERN });
    expect(result.skipped).toEqual([]);
    expect(result.derivedTaskCount).toBe(1);
    // 10 working days, 40 h/day, 5 days in each of two weeks
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.weekStart)).toEqual(["2026-02-09", "2026-02-16"]);
    expect(result.rows[0]!.demandHours).toBe(200);
    expect(result.rows[1]!.demandHours).toBe(200);
    expect(result.totalDemandHours).toBe(400);
    expect(result.rows[0]!.basis).toContain("10 working day(s)");
  });

  it("puts a part-week task's hours only in the weeks it touches", () => {
    // Wed 11th → Tue 17th: 3 days in week 1, 2 days in week 2
    const result = deriveDemand([task({ startDate: "2026-02-11", finishDate: "2026-02-17", budgetedHours: 100 })]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.demandHours).toBe(60);
    expect(result.rows[1]!.demandHours).toBe(40);
  });

  it("skips an activity with no dates rather than producing a zero row", () => {
    const result = deriveDemand([task({ startDate: null })]);
    expect(result.rows).toEqual([]);
    expect(result.skipped[0]!.reason).toContain("no computed start and finish");
    expect(result.reasons.join(" ")).toContain("excluded rather than counted as zero");
  });

  it("skips an activity with no hours, no resource type, or already complete", () => {
    const noHours = deriveDemand([task({ budgetedHours: null })]);
    expect(noHours.skipped[0]!.reason).toContain("no planned hours");

    const noType = deriveDemand([task({ resourceTypeId: null })]);
    expect(noType.skipped[0]!.reason).toContain("could not be matched to a resource type");

    const done = deriveDemand([task({ percentComplete: 100 })]);
    expect(done.skipped[0]!.reason).toContain("complete");
  });

  it("refuses to convert a non-hour unit into hours", () => {
    const result = deriveDemand([
      task({
        resources: [
          {
            resourceTypeId: "rt_conc",
            name: "Concrete",
            budgetedUnits: 120,
            unit: "m3",
            remainingUnits: null,
            actualUnits: null,
          },
        ],
      }),
    ]);
    expect(result.rows).toEqual([]);
    expect(result.skipped[0]!.reason).toContain("measured in m3");
  });

  it("uses explicit resource lines in preference to the activity's own hours", () => {
    const result = deriveDemand([
      task({
        budgetedHours: 9999,
        resources: [
          {
            resourceTypeId: "rt_conc",
            name: "Concretors",
            budgetedUnits: 200,
            unit: "hours",
            remainingUnits: null,
            actualUnits: null,
          },
          {
            resourceTypeId: "rt_crane",
            name: "Crane",
            budgetedUnits: 40,
            unit: "hours",
            remainingUnits: null,
            actualUnits: null,
          },
        ],
      }),
    ]);
    expect(result.totalDemandHours).toBe(240);
    expect(new Set(result.rows.map((r) => r.resourceTypeId))).toEqual(
      new Set(["rt_conc", "rt_crane"]),
    );
  });

  it("spreads only the remaining share when remainingOnly is set", () => {
    const explicit = deriveDemand(
      [
        task({
          resources: [
            {
              resourceTypeId: "rt_conc",
              name: "Concretors",
              budgetedUnits: 400,
              unit: "hours",
              remainingUnits: 100,
              actualUnits: 300,
            },
          ],
        }),
      ],
      { remainingOnly: true },
    );
    expect(explicit.totalDemandHours).toBe(100);

    const derived = deriveDemand([task({ percentComplete: 25 })], { remainingOnly: true });
    expect(derived.totalDemandHours).toBe(300);
    expect(derived.rows[0]!.basis).toContain("25% complete");
  });

  it("skips a window with no working days instead of dividing by zero", () => {
    // Saturday to Sunday under a Mon-Fri calendar
    const result = deriveDemand([task({ startDate: "2026-02-14", finishDate: "2026-02-15" })]);
    expect(result.rows).toEqual([]);
    expect(result.skipped[0]!.reason).toContain("no working days");
  });

  it("honours a Sunday-start week", () => {
    const result = deriveDemand([task({ startDate: "2026-02-13", finishDate: "2026-02-16", budgetedHours: 16 })], {
      weekStartsOn: 0,
    });
    // Fri 13th (week of Sun 8th) + Mon 16th (week of Sun 15th)
    expect(result.rows.map((r) => r.weekStart)).toEqual(["2026-02-08", "2026-02-15"]);
  });

  it("collapses per-activity rows to one row per type and week", () => {
    const rows = deriveDemand([
      task({ id: "a", budgetedHours: 100 }),
      task({ id: "b", name: "Rebar", budgetedHours: 100 }),
    ]).rows;
    expect(rows).toHaveLength(4);
    const collapsed = collapseByTypeWeek(rows);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]!.demandHours).toBe(100);
    expect(collapsed[0]!.basis).toContain("2 activities");
  });

  it("reports headcount as unknown when the type has no standard day", () => {
    expect(headcountFor(200, null, 5).value).toBeNull();
    expect(headcountFor(200, null, 5).reason).toContain("no standard hours per day");
    expect(headcountFor(200, 8, 5).value).toBe(5);
    expect(headcountFor(200, 10, 5).value).toBe(4);
    expect(headcountFor(200, 8, 0).value).toBeNull();
  });

  it("reports a reason when nothing at all could be derived", () => {
    const result = deriveDemand([]);
    expect(result.reasons.join(" ")).toContain("No demand could be derived");
  });
});
