import { describe, expect, it } from "vitest";
import {
  buildHistogram,
  suggestLevelling,
  type HistogramType,
  type LevellingTask,
} from "./histogram.js";

const conc: HistogramType = {
  id: "rt_conc",
  code: "CONC",
  name: "Concretors",
  kind: "labour",
  unit: "hours",
  standardHoursPerDay: 8,
  workingDaysPerWeek: 5,
};
const crane: HistogramType = {
  id: "rt_crane",
  code: "CRANE",
  name: "Tower crane",
  kind: "equipment",
  unit: "hours",
  standardHoursPerDay: null,
  workingDaysPerWeek: null,
};

const weeks = ["2026-02-09", "2026-02-16", "2026-02-23"];

describe("buildHistogram", () => {
  it("marks a week with no availability row as unknown, not as an overload", () => {
    const result = buildHistogram({
      weeks,
      types: [conc],
      demand: [{ resourceTypeId: "rt_conc", weekStart: "2026-02-09", demandHours: 200, sourceTaskId: "t1" }],
      supply: [],
      workingDaysPerWeek: 5,
    });
    const cell = result.series[0]!.cells[0]!;
    expect(cell.state).toBe("unknown");
    expect(cell.overAllocationHours).toBeNull();
    expect(cell.utilisationPercent).toBeNull();
    expect(cell.reasons.join(" ")).toContain("unknown rather than short");
    expect(result.totals.availableHours).toBeNull();
  });

  it("classifies over, tight, ok and idle weeks", () => {
    const result = buildHistogram({
      weeks,
      types: [conc],
      demand: [
        { resourceTypeId: "rt_conc", weekStart: "2026-02-09", demandHours: 240, sourceTaskId: "t1" },
        { resourceTypeId: "rt_conc", weekStart: "2026-02-16", demandHours: 190, sourceTaskId: "t1" },
        { resourceTypeId: "rt_conc", weekStart: "2026-02-23", demandHours: 60, sourceTaskId: "t1" },
      ],
      supply: weeks.map((weekStart) => ({
        resourceTypeId: "rt_conc",
        weekStart,
        availableHours: 200,
        availableHeadcount: 5,
        source: "roster",
      })),
      workingDaysPerWeek: 5,
    });
    const [over, tight, idle] = result.series[0]!.cells;
    expect(over!.state).toBe("over");
    expect(over!.overAllocationHours).toBe(40);
    expect(over!.utilisationPercent).toBe(120);
    expect(tight!.state).toBe("tight");
    expect(idle!.state).toBe("idle");
    expect(result.totals.availableHours).toBe(600);
    expect(result.totals.overAllocatedCells).toBe(1);
  });

  it("derives headcount only when the type states a standard day", () => {
    const result = buildHistogram({
      weeks: ["2026-02-09"],
      types: [conc, crane],
      demand: [
        { resourceTypeId: "rt_conc", weekStart: "2026-02-09", demandHours: 200, sourceTaskId: "t1" },
        { resourceTypeId: "rt_crane", weekStart: "2026-02-09", demandHours: 40, sourceTaskId: "t1" },
      ],
      supply: [],
      workingDaysPerWeek: 5,
    });
    expect(result.series[0]!.cells[0]!.demandHeadcount).toBe(5);
    expect(result.series[1]!.cells[0]!.demandHeadcount).toBeNull();
    expect(result.series[1]!.cells[0]!.reasons.join(" ")).toContain("no standard hours per day");
  });

  it("treats demand against zero recorded supply as over with undefined utilisation", () => {
    const result = buildHistogram({
      weeks: ["2026-02-09"],
      types: [conc],
      demand: [{ resourceTypeId: "rt_conc", weekStart: "2026-02-09", demandHours: 80, sourceTaskId: "t1" }],
      supply: [
        {
          resourceTypeId: "rt_conc",
          weekStart: "2026-02-09",
          availableHours: 0,
          availableHeadcount: 0,
          source: "roster",
        },
      ],
      workingDaysPerWeek: 5,
    });
    const cell = result.series[0]!.cells[0]!;
    expect(cell.state).toBe("over");
    expect(cell.utilisationPercent).toBeNull();
    expect(cell.overAllocationHours).toBe(80);
    expect(cell.reasons.join(" ")).toContain("undefined rather than infinite");
  });

  it("flags assumed supply on the cell and the series", () => {
    const result = buildHistogram({
      weeks: ["2026-02-09"],
      types: [conc],
      demand: [],
      supply: [
        {
          resourceTypeId: "rt_conc",
          weekStart: "2026-02-09",
          availableHours: 200,
          availableHeadcount: 5,
          source: "assumed",
        },
      ],
      workingDaysPerWeek: 5,
    });
    expect(result.series[0]!.cells[0]!.reasons.join(" ")).toContain("ASSUMED");
    expect(result.series[0]!.assumedSupplyWeeks).toBe(1);
  });

  it("says so when there are no resource types at all", () => {
    const result = buildHistogram({
      weeks,
      types: [],
      demand: [],
      supply: [],
      workingDaysPerWeek: 5,
    });
    expect(result.reasons.join(" ")).toContain("No resource types are in scope");
  });
});

describe("suggestLevelling", () => {
  const overloaded = () =>
    buildHistogram({
      weeks: ["2026-02-09"],
      types: [conc],
      demand: [
        { resourceTypeId: "rt_conc", weekStart: "2026-02-09", demandHours: 120, sourceTaskId: "float" },
        { resourceTypeId: "rt_conc", weekStart: "2026-02-09", demandHours: 120, sourceTaskId: "crit" },
      ],
      supply: [
        {
          resourceTypeId: "rt_conc",
          weekStart: "2026-02-09",
          availableHours: 200,
          availableHeadcount: 5,
          source: "roster",
        },
      ],
      workingDaysPerWeek: 5,
    });

  const tasks: LevellingTask[] = [
    {
      id: "float",
      name: "Non-critical fit-out",
      totalFloat: 15,
      isCritical: false,
      startDate: "2026-02-09",
      finishDate: "2026-02-13",
    },
    {
      id: "crit",
      name: "Critical core pour",
      totalFloat: 0,
      isCritical: true,
      startDate: "2026-02-09",
      finishDate: "2026-02-13",
    },
  ];

  const contributions = [
    { resourceTypeId: "rt_conc", weekStart: "2026-02-09", sourceTaskId: "float", demandHours: 120 },
    { resourceTypeId: "rt_conc", weekStart: "2026-02-09", sourceTaskId: "crit", demandHours: 120 },
  ];

  it("proposes deferring the float-bearing activity and never the critical one", () => {
    const suggestions = suggestLevelling({
      histogram: overloaded(),
      contributions,
      tasks,
    });
    const defer = suggestions.filter((s) => s.action === "defer_task");
    expect(defer).toHaveLength(1);
    expect(defer[0]!.taskId).toBe("float");
    expect(defer[0]!.moveHours).toBe(40);
    expect(defer[0]!.floatDays).toBe(15);
    expect(defer[0]!.explanation).toContain("without moving the completion date");
    expect(suggestions.some((s) => s.taskId === "crit")).toBe(false);
  });

  it("falls back to adding supply when nothing carries enough float", () => {
    const suggestions = suggestLevelling({
      histogram: overloaded(),
      contributions,
      tasks: tasks.map((t) => ({ ...t, totalFloat: 1, isCritical: t.id === "crit" })),
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.action).toBe("add_supply");
    expect(suggestions[0]!.moveHours).toBe(40);
    expect(suggestions[0]!.explanation).toContain("critical");
  });

  it("suggests nothing when no week is over-allocated", () => {
    const histogram = buildHistogram({
      weeks: ["2026-02-09"],
      types: [conc],
      demand: [{ resourceTypeId: "rt_conc", weekStart: "2026-02-09", demandHours: 100, sourceTaskId: "float" }],
      supply: [
        {
          resourceTypeId: "rt_conc",
          weekStart: "2026-02-09",
          availableHours: 200,
          availableHeadcount: 5,
          source: "roster",
        },
      ],
      workingDaysPerWeek: 5,
    });
    expect(suggestLevelling({ histogram, contributions, tasks })).toEqual([]);
  });
});
