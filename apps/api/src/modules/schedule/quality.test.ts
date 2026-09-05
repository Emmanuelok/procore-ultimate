import { describe, expect, it } from "vitest";
import {
  assessScheduleQuality,
  CRITICAL_PATH_TEST_DAYS,
  type QualityDependencyInput,
  type QualityTaskInput,
} from "./quality.js";

const START = "2026-01-05";

function task(id: string, extra: Partial<QualityTaskInput> = {}): QualityTaskInput {
  return {
    id,
    name: id,
    durationDays: 5,
    constraintType: null,
    percentComplete: 0,
    actualStart: null,
    actualFinish: null,
    startDate: "2026-01-05",
    finishDate: "2026-01-09",
    totalFloat: 0,
    sortOrder: 0,
    ...extra,
  };
}

function dep(id: string, p: string, s: string, extra: Partial<QualityDependencyInput> = {}): QualityDependencyInput {
  return { id, predecessorId: p, successorId: s, depType: "FS", lagDays: 0, ...extra };
}

describe("DCMA logic check (#283 — regression for the vacuous exclusion bug)", () => {
  it("counts unlinked open-start activities instead of excusing every task on the earliest date", () => {
    // Four tasks all sitting on the schedule's earliest start with no logic at
    // all. The old rule excused every one of them and reported a clean pass.
    const tasks = [task("a"), task("b"), task("c"), task("d")];
    const report = assessScheduleQuality(tasks, [], { projectStart: START });
    expect(report.checks["missingPredecessors"]!.count).toBe(3); // one start activity excepted
    expect(report.checks["missingPredecessors"]!.pass).toBe(false);
    expect(report.checks["missingPredecessors"]!.ids).not.toContain("a");
    expect(report.checks["missingSuccessors"]!.count).toBe(3);
  });

  it("excepts exactly one start and one finish activity in a fully linked chain", () => {
    const tasks = [
      task("a", { sortOrder: 0, startDate: "2026-01-05", finishDate: "2026-01-09" }),
      task("b", { sortOrder: 1, startDate: "2026-01-12", finishDate: "2026-01-16" }),
      task("c", { sortOrder: 2, startDate: "2026-01-19", finishDate: "2026-01-23" }),
    ];
    const deps = [dep("d1", "a", "b"), dep("d2", "b", "c")];
    const report = assessScheduleQuality(tasks, deps, { projectStart: START });
    expect(report.checks["missingPredecessors"]!.count).toBe(0);
    expect(report.checks["missingSuccessors"]!.count).toBe(0);
    expect(report.checks["missingPredecessors"]!.pass).toBe(true);
  });

  it("excludes level-of-effort activities from the population checks", () => {
    const tasks = [
      task("a"),
      task("loe", { taskType: "level_of_effort", durationDays: 300, totalFloat: 200 }),
    ];
    const report = assessScheduleQuality(tasks, [], { projectStart: START });
    expect(report.checks["highDuration"]!.count).toBe(0);
    expect(report.checks["highFloat"]!.count).toBe(0);
  });
});

describe("DCMA checks 9-14", () => {
  const chain = [
    task("a", { sortOrder: 0, durationDays: 5, startDate: "2026-01-05", finishDate: "2026-01-09" }),
    task("b", { sortOrder: 1, durationDays: 5, startDate: "2026-01-10", finishDate: "2026-01-14" }),
  ];
  const chainDeps = [dep("d1", "a", "b")];

  it("marks data-date, resource, baseline and BEI checks not-applicable rather than failing them", () => {
    const report = assessScheduleQuality(chain, chainDeps, { projectStart: START });
    expect(report.checks["invalidDates"]!.applicable).toBe(false);
    expect(report.checks["resources"]!.applicable).toBe(false);
    expect(report.checks["missedTasks"]!.applicable).toBe(false);
    expect(report.checks["bei"]!.applicable).toBe(false);
    expect(report.notApplicable.sort()).toEqual(["bei", "invalidDates", "missedTasks", "resources"]);
    // The score is computed over the checks that could actually run.
    expect(report.total).toBe(12);
  });

  it("flags actual dates ahead of the data date and forecast work behind it", () => {
    const tasks = [
      task("a", { actualStart: "2026-01-05", actualFinish: "2026-02-20" }),
      task("b", { finishDate: "2026-01-20", actualFinish: null }),
    ];
    const report = assessScheduleQuality(tasks, [], { projectStart: START, dataDate: "2026-02-01" });
    expect(report.checks["invalidDates"]!.applicable).toBe(true);
    expect(report.checks["invalidDates"]!.count).toBe(2);
    expect(report.checks["invalidDates"]!.pass).toBe(false);
  });

  it("flags unresourced working activities once the programme is resource loaded", () => {
    const report = assessScheduleQuality(chain, chainDeps, {
      projectStart: START,
      resourceCountByTask: { a: 2, b: 0 },
    });
    expect(report.checks["resources"]!.applicable).toBe(true);
    expect(report.checks["resources"]!.ids).toEqual(["b"]);
  });

  it("counts missed tasks against a baseline", () => {
    const tasks = [
      task("a", { actualFinish: "2026-01-20", actualStart: "2026-01-05", percentComplete: 100 }),
      task("b", { finishDate: "2026-01-14" }),
    ];
    const report = assessScheduleQuality(tasks, [], {
      projectStart: START,
      baseline: [
        { taskId: "a", finishDate: "2026-01-09" },
        { taskId: "b", finishDate: "2026-01-14" },
      ],
    });
    expect(report.checks["missedTasks"]!.ids).toEqual(["a"]);
    expect(report.checks["missedTasks"]!.pass).toBe(false);
  });

  it("computes BEI from activities baselined to finish by the data date", () => {
    const tasks = [
      task("a", { actualStart: "2026-01-05", actualFinish: "2026-01-09", percentComplete: 100 }),
      task("b", { finishDate: "2026-01-16" }),
      task("c", { finishDate: "2026-01-16" }),
    ];
    const report = assessScheduleQuality(tasks, [], {
      projectStart: START,
      dataDate: "2026-01-20",
      baseline: [
        { taskId: "a", finishDate: "2026-01-09" },
        { taskId: "b", finishDate: "2026-01-16" },
        { taskId: "c", finishDate: "2026-01-16" },
      ],
    });
    // one of three due activities is complete
    expect(report.checks["bei"]!.value).toBeCloseTo(0.3333, 3);
    expect(report.checks["bei"]!.pass).toBe(false);
  });

  it("passes the critical path test on sound logic and reports the movement", () => {
    const report = assessScheduleQuality(chain, chainDeps, { projectStart: START });
    const cpt = report.checks["criticalPathTest"]!;
    expect(cpt.applicable).toBe(true);
    expect(cpt.pass).toBe(true);
    expect(cpt.value).toBe(CRITICAL_PATH_TEST_DAYS);
  });

  it("cannot run the critical path test when no incomplete critical activity carries a duration", () => {
    // Everything is complete: there is no activity left whose inflation could
    // move completion, so the check reports why rather than passing vacuously.
    const tasks = [
      task("a", { actualStart: "2026-01-05", actualFinish: "2026-01-09", percentComplete: 100 }),
      task("b", {
        sortOrder: 1,
        actualStart: "2026-01-10",
        actualFinish: "2026-01-14",
        percentComplete: 100,
        startDate: "2026-01-10",
        finishDate: "2026-01-14",
      }),
    ];
    const report = assessScheduleQuality(tasks, [dep("d1", "a", "b")], { projectStart: START });
    expect(report.checks["criticalPathTest"]!.applicable).toBe(false);
    expect(report.checks["criticalPathTest"]!.basis).toMatch(/no incomplete critical activity/);
  });

  it("names the activity it injected the delay into", () => {
    const report = assessScheduleQuality(chain, chainDeps, { projectStart: START });
    expect(report.checks["criticalPathTest"]!.basis).toContain("600d");
    expect(report.checks["criticalPathTest"]!.basis).toMatch(/"a"|"b"/);
  });

  it("computes CPLI from the remaining critical path and completion float", () => {
    const report = assessScheduleQuality(chain, chainDeps, { projectStart: START, dataDate: "2026-01-05" });
    const cpli = report.checks["cpli"]!;
    expect(cpli.applicable).toBe(true);
    expect(cpli.value).toBe(1); // no float on the completion activity
    expect(cpli.pass).toBe(true);
  });

  it("does not run the live checks without a schedule start", () => {
    const report = assessScheduleQuality(chain, chainDeps, {});
    expect(report.checks["criticalPathTest"]!.applicable).toBe(false);
    expect(report.checks["cpli"]!.applicable).toBe(false);
  });

  it("degrades honestly when the logic contains a cycle", () => {
    const report = assessScheduleQuality(chain, [dep("d1", "a", "b"), dep("d2", "b", "a")], {
      projectStart: START,
    });
    expect(report.checks["criticalPathTest"]!.applicable).toBe(false);
    expect(report.checks["criticalPathTest"]!.basis).toMatch(/cycle/);
  });
});

describe("scoring", () => {
  it("scores over applicable checks only", () => {
    const report = assessScheduleQuality(
      [
        task("a", { sortOrder: 0, startDate: "2026-01-05", finishDate: "2026-01-09" }),
        task("b", { sortOrder: 1, startDate: "2026-01-12", finishDate: "2026-01-16" }),
      ],
      [dep("d1", "a", "b")],
      { projectStart: START },
    );
    expect(report.total).toBe(12);
    expect(report.passed).toBe(12);
    expect(report.score).toBe(1);
  });
});
