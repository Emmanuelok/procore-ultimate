import { describe, expect, it } from "vitest";
import {
  computeResourceProductivity,
  detectSustainedShortfall,
  forecastHoursAtCompletion,
  measuredMile,
  type PlannedLine,
  type ProductivityAllocation,
} from "./productivity.js";

const line = (over: Partial<PlannedLine> = {}): PlannedLine => ({
  id: "bl1",
  code: "03-300",
  description: "Concrete",
  budgetHours: 1000,
  budgetQuantity: 500,
  unit: "m3",
  ...over,
});

const alloc = (over: Partial<ProductivityAllocation> = {}): ProductivityAllocation => ({
  workDate: "2026-02-09",
  hours: 100,
  quantity: 50,
  unit: "m3",
  budgetLineItemId: "bl1",
  crewId: "crew_1",
  crewName: "Crew A",
  resourceTypeId: "rt_conc",
  resourceTypeName: "Concretors",
  ...over,
});

describe("computeResourceProductivity", () => {
  it("earns hours against the planned unit rate and reports the factor", () => {
    const report = computeResourceProductivity([alloc()], [line()]);
    // planned 2 h/m3; 50 m3 installed earns 100 h against 100 h spent
    expect(report.totals.actualHours).toBe(100);
    expect(report.totals.earnedHours).toBe(100);
    expect(report.totals.productivityFactor).toBe(1);
    expect(report.byResourceType[0]!.achievedUnitRate).toBe(2);
    expect(report.byResourceType[0]!.plannedUnitRate).toBe(2);
  });

  it("computes a factor below 1 when the crew is slower than planned", () => {
    const report = computeResourceProductivity([alloc({ hours: 200, quantity: 50 })], [line()]);
    expect(report.totals.earnedHours).toBe(100);
    expect(report.totals.productivityFactor).toBe(0.5);
    expect(report.byCrew[0]!.achievedUnitRate).toBe(4);
  });

  it("refuses a total when any hours could not be earned", () => {
    const report = computeResourceProductivity(
      [alloc(), alloc({ workDate: "2026-02-10", budgetLineItemId: null })],
      [line()],
    );
    expect(report.totals.actualHours).toBe(200);
    expect(report.totals.earnedHours).toBeNull();
    expect(report.totals.productivityFactor).toBeNull();
    expect(report.totals.unearnableHours).toBe(100);
    expect(report.reasons.join(" ")).toContain("carry no budget line");
  });

  it("does not earn against a budget line with no planned hours", () => {
    const report = computeResourceProductivity([alloc()], [line({ budgetHours: null })]);
    expect(report.totals.earnedHours).toBeNull();
    expect(report.byResourceType[0]!.reasons.join(" ")).toContain("no planned hours");
  });

  it("never converts between units", () => {
    const report = computeResourceProductivity([alloc({ unit: "m2" })], [line({ unit: "m3" })]);
    expect(report.totals.earnedHours).toBeNull();
    expect(report.byCrew[0]!.reasons.join(" ")).toContain("never converted");
  });

  it("counts hours with no installed quantity as spent but unearned", () => {
    const report = computeResourceProductivity([alloc({ quantity: null })], [line()]);
    expect(report.totals.actualHours).toBe(100);
    expect(report.totals.earnedHours).toBeNull();
    expect(report.byResourceType[0]!.reasons.join(" ")).toContain("no installed quantity");
  });

  it("buckets by week, resource type and crew consistently", () => {
    const report = computeResourceProductivity(
      [
        alloc({ workDate: "2026-02-09" }),
        alloc({ workDate: "2026-02-16", crewId: "crew_2", crewName: "Crew B" }),
      ],
      [line()],
    );
    expect(report.weeks.map((w) => w.weekStart)).toEqual(["2026-02-09", "2026-02-16"]);
    expect(report.weeks.every((w) => w.productivityFactor === 1)).toBe(true);
    expect(report.byCrew).toHaveLength(2);
    expect(report.byResourceType).toHaveLength(1);
    expect(report.byResourceType[0]!.actualHours).toBe(200);
  });

  it("labels unmapped hours rather than dropping them", () => {
    const report = computeResourceProductivity(
      [alloc({ resourceTypeId: null, resourceTypeName: null, crewId: null, crewName: null })],
      [line()],
    );
    expect(report.byResourceType[0]!.label).toContain("Not mapped");
    expect(report.byCrew[0]!.label).toContain("No crew");
  });

  it("explains an empty window instead of returning zeros", () => {
    const report = computeResourceProductivity([], []);
    expect(report.totals.actualHours).toBe(0);
    expect(report.reasons.join(" ")).toContain("No coded labour hours");
  });
});

describe("forecastHoursAtCompletion", () => {
  const base = { budgetHours: 1000, actualHours: 400, earnedHours: 320 };

  it("divides the budget by the achieved factor", () => {
    const f = forecastHoursAtCompletion(base, "productivity_factor");
    expect(f.productivityFactor).toBe(0.8);
    expect(f.forecastHoursAtCompletion).toBe(1250);
    expect(f.varianceHours).toBe(250);
    expect(f.remainingHours).toBe(850);
    expect(f.percentComplete).toBe(32);
    expect(f.confidence).toBe("high");
    expect(f.basis).toContain("÷ a productivity factor");
  });

  it("refuses to extrapolate from a zero factor", () => {
    const f = forecastHoursAtCompletion({ ...base, earnedHours: 0 }, "productivity_factor");
    expect(f.forecastHoursAtCompletion).toBeNull();
    expect(f.reasons.join(" ")).toContain("zero");
  });

  it("refuses when there is no productivity factor at all", () => {
    const f = forecastHoursAtCompletion({ ...base, earnedHours: null }, "productivity_factor");
    expect(f.forecastHoursAtCompletion).toBeNull();
    expect(f.reasons.join(" ")).toContain("inventing one");
  });

  it("projects the remainder at the achieved unit rate", () => {
    const f = forecastHoursAtCompletion(
      { ...base, budgetQuantity: 500, installedQuantity: 160 },
      "remaining_quantity",
    );
    // 400 h ÷ 160 = 2.5 h/unit; 340 remaining × 2.5 = 850; + 400 = 1250
    expect(f.forecastHoursAtCompletion).toBe(1250);
  });

  it("warns that planned burn assumes recovery when the factor is below one", () => {
    const f = forecastHoursAtCompletion(base, "planned_burn");
    expect(f.forecastHoursAtCompletion).toBe(1080);
    expect(f.reasons.join(" ")).toContain("assumes it returns to 1.0");
  });

  it("takes a manual figure and says it was manual", () => {
    const f = forecastHoursAtCompletion({ ...base, manualForecastHours: 1400 }, "manual");
    expect(f.forecastHoursAtCompletion).toBe(1400);
    expect(f.basis).toContain("Manually set");
  });

  it("downgrades confidence on a thin sample", () => {
    const f = forecastHoursAtCompletion(
      { budgetHours: 1000, actualHours: 40, earnedHours: 32 },
      "productivity_factor",
    );
    expect(f.confidence).toBe("low");
    expect(f.reasons.join(" ")).toContain("early indication");
  });
});

describe("measuredMile", () => {
  const week = (weekStart: string, actualHours: number, earnedHours: number | null) => ({
    weekStart,
    actualHours,
    earnedHours,
    productivityFactor: earnedHours === null || actualHours === 0 ? null : earnedHours / actualHours,
  });

  it("picks the best sustained run as the benchmark and quantifies the loss", () => {
    const result = measuredMile([
      week("2026-01-05", 100, 100),
      week("2026-01-12", 100, 100),
      week("2026-01-19", 100, 100),
      week("2026-01-26", 100, 50),
      week("2026-02-02", 100, 50),
    ]);
    expect(result.mile).not.toBeNull();
    expect(result.mile!.from).toBe("2026-01-05");
    expect(result.mile!.to).toBe("2026-01-19");
    expect(result.mile!.productivityFactor).toBe(1);
    expect(result.impacted!.weeks).toBe(2);
    // 100 earned at a factor of 1 would have needed 100 h, 200 were spent
    expect(result.lostHours).toBe(100);
    expect(result.lostHoursPercent).toBe(50);
    expect(result.explanation).toContain("bought no additional progress");
  });

  it("breaks a run on an unmeasurable week rather than counting it", () => {
    const result = measuredMile([
      week("2026-01-05", 100, 100),
      week("2026-01-12", 100, 100),
      week("2026-01-19", 100, null), // nobody recorded quantities this week
      week("2026-01-26", 100, 100),
      week("2026-02-02", 100, 40),
      week("2026-02-09", 100, 40),
      week("2026-02-16", 100, 40),
    ]);
    // Had the silent week been treated as good, 05 Jan -> 26 Jan would be a
    // four-week mile at 1.0. It is not: the run is broken, the two weeks
    // before the gap are too short to qualify, and the benchmark becomes the
    // best three-week window in the run that follows it.
    expect(result.mile!.from).toBe("2026-01-26");
    expect(result.mile!.to).toBe("2026-02-09");
    expect(result.mile!.productivityFactor).toBe(0.6);
    expect(result.unmeasurableWeeks).toBe(1);
    expect(result.reasons.join(" ")).toContain("break a run");
  });

  it("returns no mile when there are too few measured weeks", () => {
    const result = measuredMile([week("2026-01-05", 100, 100), week("2026-01-12", 100, 100)]);
    expect(result.mile).toBeNull();
    expect(result.lostHours).toBeNull();
    expect(result.explanation).toContain("No measured mile exists");
  });

  it("claims no loss when every measured week is inside the mile", () => {
    const result = measuredMile([
      week("2026-01-05", 100, 90),
      week("2026-01-12", 100, 90),
      week("2026-01-19", 100, 90),
    ]);
    expect(result.mile).not.toBeNull();
    expect(result.impacted).toBeNull();
    expect(result.lostHours).toBeNull();
    expect(result.explanation).toContain("no disruption loss is claimed");
  });
});

describe("detectSustainedShortfall", () => {
  const week = (weekStart: string, pf: number | null) => ({
    weekStart,
    actualHours: 100,
    earnedHours: pf === null ? null : pf * 100,
    productivityFactor: pf,
  });

  it("finds three consecutive weeks under the floor", () => {
    const d = detectSustainedShortfall([
      week("2026-01-05", 1),
      week("2026-01-12", 0.7),
      week("2026-01-19", 0.6),
      week("2026-01-26", 0.5),
      week("2026-02-02", 0.95),
    ]);
    expect(d).not.toBeNull();
    expect(d!.weeks).toBe(3);
    expect(d!.from).toBe("2026-01-12");
    expect(d!.to).toBe("2026-01-26");
    expect(d!.worstFactor).toBe(0.5);
    expect(d!.lostHours).toBe(120);
  });

  it("returns null for two bad weeks", () => {
    expect(
      detectSustainedShortfall([week("2026-01-05", 0.5), week("2026-01-12", 0.5), week("2026-01-19", 1)]),
    ).toBeNull();
  });

  it("does not treat an unmeasurable week as a bad week", () => {
    expect(
      detectSustainedShortfall([
        week("2026-01-05", 0.5),
        week("2026-01-12", null),
        week("2026-01-19", 0.5),
      ]),
    ).toBeNull();
  });
});
