import { describe, expect, it } from "vitest";
import { HEALTH_DIMENSIONS } from "@constructos/shared";
import {
  DIMENSION_WEIGHTS,
  levelForScore,
  scoreAssurance,
  scoreCommercial,
  scoreContract,
  scoreCost,
  scoreField,
  scoreFinance,
  scoreHealth,
  scoreQuality,
  scoreRisk,
  scoreSafety,
  scoreSchedule,
  type HealthInputs,
} from "./health-engine.js";

const emptyInputs = (): HealthInputs => ({
  asOf: "2026-09-01T00:00:00.000Z",
  schedule: null,
  cost: null,
  commercial: null,
  assurance: null,
  safety: null,
  quality: null,
  field: null,
  contract: null,
  risk: null,
  finance: null,
  reasons: {},
});

describe("levelForScore", () => {
  it("maps the bands and treats null as unrated", () => {
    expect(levelForScore(null)).toBe("unrated");
    expect(levelForScore(100)).toBe("on_track");
    expect(levelForScore(75)).toBe("on_track");
    expect(levelForScore(74)).toBe("watch");
    expect(levelForScore(50)).toBe("watch");
    expect(levelForScore(49)).toBe("off_track");
    expect(levelForScore(0)).toBe("off_track");
  });
});

describe("dimension scorers — honesty on missing inputs", () => {
  it("returns unrated with the loader's reason when a dimension has no records", () => {
    const d = scoreSchedule(null, "No active schedule for this project.");
    expect(d.score).toBeNull();
    expect(d.level).toBe("unrated");
    expect(d.basis).toContain("No active schedule");
    expect(scoreCost(null).level).toBe("unrated");
    expect(scoreRisk({ open: 0, high: 0, realised: 0, mitigating: 0 }).level).toBe("unrated");
    expect(scoreSafety({ recordCount: 0, incidents90d: 0, fatalities: 0, majorOrCatastrophic: 0, serious: 0, lostTime: 0, openIncidents: 0, openObservations: 0, overdueActions: 0 }).level).toBe("unrated");
  });

  it("never scores a budget with no revised total", () => {
    const d = scoreCost({ budgetName: "B1", currency: "GBP", revisedBudget: 0, forecastFinal: 0, variance: 0, pendingChanges: 0, jobToDate: 0 });
    expect(d.score).toBeNull();
    expect(d.basis).toContain("no revised total");
  });
});

describe("schedule", () => {
  const base = {
    scheduleName: "Master",
    computedFinish: "2026-12-20",
    projectFinish: "2026-12-01",
    tasks: 10,
    overdueTasks: 0,
    criticalOverdue: 0,
    milestonesSlipped: 0,
    percentComplete: 40,
  };
  it("penalises slip by two points a day, capped at 60", () => {
    expect(scoreSchedule({ ...base, slipDays: 0 }).score).toBe(100);
    expect(scoreSchedule({ ...base, slipDays: 10 }).score).toBe(80);
    expect(scoreSchedule({ ...base, slipDays: 500 }).score).toBe(40);
  });
  it("penalises overdue tasks proportionally and critical overdue on top", () => {
    const d = scoreSchedule({ ...base, slipDays: 0, overdueTasks: 5, criticalOverdue: 2 });
    // 40 * 0.5 = 20, + 2*5 = 10 → 70
    expect(d.score).toBe(70);
    expect(d.level).toBe("watch");
    expect(d.basis).toContain("5 of 10 tasks");
    expect(d.inputs["criticalOverdue"]).toBe(2);
  });
  it("explains an unknown slip rather than assuming zero", () => {
    const d = scoreSchedule({ ...base, slipDays: null, projectFinish: null });
    expect(d.basis).toContain("no finish date");
    expect(d.score).toBe(100);
  });
});

describe("cost", () => {
  it("scores an overrun at ten points per percent and pending changes at two", () => {
    const d = scoreCost({ budgetName: "B", currency: "USD", revisedBudget: 1_000_000, forecastFinal: 1_030_000, variance: -30_000, pendingChanges: 50_000, jobToDate: 400_000 });
    // 3% overrun → -30; pending 5% → -10 → 60
    expect(d.score).toBe(60);
    expect(d.inputs["variancePercent"]).toBe(-3);
    expect(d.basis).toContain("exceeds the revised budget by 3%");
  });
  it("is on track with headroom", () => {
    const d = scoreCost({ budgetName: "B", currency: "USD", revisedBudget: 1_000_000, forecastFinal: 950_000, variance: 50_000, pendingChanges: 0, jobToDate: 0 });
    expect(d.score).toBe(100);
    expect(d.level).toBe("on_track");
  });
});

describe("commercial", () => {
  it("measures change exposure against the budget when one exists", () => {
    const d = scoreCommercial({ currency: "USD", commitments: 3, committedTotal: 500_000, pendingCommitments: 0, openChangeEvents: 2, changeExposure: 50_000, agedChangeEvents: 1, revisedBudget: 1_000_000 });
    // exposure 5% → -30; aged 1 → -3 → 67
    expect(d.score).toBe(67);
    expect(d.inputs["changeExposurePercent"]).toBe(5);
  });
  it("falls back to counts without a budget and says so", () => {
    const d = scoreCommercial({ currency: null, commitments: 0, committedTotal: 0, pendingCommitments: 0, openChangeEvents: 4, changeExposure: 0, agedChangeEvents: 0, revisedBudget: null });
    expect(d.score).toBe(88);
    expect(d.basis).toContain("no budget to measure");
  });
});

describe("assurance / safety / quality / field / contract / risk / finance", () => {
  it("assurance weighs open signals and bad reconciliations", () => {
    const d = scoreAssurance({ openSignals: { critical: 1, high: 1, medium: 2, low: 0, info: 0 }, reconciliations: { total: 4, contradicted: 1, unsupported: 0, insufficient: 0 } });
    // 25+12+10 = 47, recon 15 → 38
    expect(d.score).toBe(38);
    expect(d.level).toBe("off_track");
  });
  it("assurance is unrated with no signals and no reconciliations", () => {
    expect(scoreAssurance({ openSignals: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, reconciliations: { total: 0, contradicted: 0, unsupported: 0, insufficient: 0 } }).level).toBe("unrated");
  });
  it("a fatality scores zero", () => {
    const d = scoreSafety({ recordCount: 5, incidents90d: 1, fatalities: 1, majorOrCatastrophic: 1, serious: 0, lostTime: 0, openIncidents: 1, openObservations: 0, overdueActions: 0 });
    expect(d.score).toBe(0);
    expect(d.basis).toContain("fatality");
  });
  it("safety with records but no incidents is on track", () => {
    const d = scoreSafety({ recordCount: 12, incidents90d: 0, fatalities: 0, majorOrCatastrophic: 0, serious: 0, lostTime: 0, openIncidents: 0, openObservations: 2, overdueActions: 0 });
    expect(d.score).toBe(98);
    expect(d.level).toBe("on_track");
  });
  it("quality weighs NCR severity and ITP failures", () => {
    const d = scoreQuality({ ncrsOpen: { critical: 1, major: 1, minor: 2 }, overdueNcrResponses: 1, itpActivities: 10, itpFailed: 1, holdPointsPending: 3 });
    // 25+10+6+5+10 = 56 → 44
    expect(d.score).toBe(44);
  });
  it("field penalises overdue items", () => {
    const d = scoreField({ rfisOpen: 5, rfisOverdue: 2, submittalsOpen: 4, submittalsOverdue: 1, punchOpen: 20, punchOverdue: 4 });
    // 12 + 5 + 6 = 23 → 77
    expect(d.score).toBe(77);
    expect(d.basis).toContain("2 of 5 open RFIs overdue");
  });
  it("contract penalises time bars hardest", () => {
    const d = scoreContract({ events: 3, timeBarred: 1, deadlinesWithin7d: 1, obligationsOpen: 5, obligationsBreached: 1, obligationsDue7d: 2 });
    // 25+8+15+8 = 56 → 44
    expect(d.score).toBe(44);
  });
  it("risk weighs high and realised risks", () => {
    const d = scoreRisk({ open: 6, high: 2, realised: 1, mitigating: 1 });
    expect(d.score).toBe(65);
    expect(d.basis).toContain("7 live risks");
  });
  it("finance weighs covenant breaches and deemed claims", () => {
    const d = scoreFinance({ covenants: 2, breached: 1, unread: 1, claimsDeemed: 1, claimsSuspended: 0, conditionsOverdue: 0 });
    // 40 + 10 + 20 = 70 → 30
    expect(d.score).toBe(30);
  });
});

describe("scoreHealth — overall verdict", () => {
  it("is unrated when nothing is rated and lists every dimension in order", () => {
    const h = scoreHealth(emptyInputs());
    expect(h.score).toBeNull();
    expect(h.level).toBe("unrated");
    expect(h.ratedDimensions).toBe(0);
    expect(h.dimensions.map((d) => d.key)).toEqual([...HEALTH_DIMENSIONS]);
    expect(h.dimensions.every((d) => d.level === "unrated")).toBe(true);
  });

  it("weights rated dimensions only", () => {
    const inputs = emptyInputs();
    inputs.field = { rfisOpen: 5, rfisOverdue: 0, submittalsOpen: 0, submittalsOverdue: 0, punchOpen: 0, punchOverdue: 0 }; // 100
    inputs.risk = { open: 4, high: 3, realised: 0, mitigating: 0 }; // 70
    const h = scoreHealth(inputs);
    const expected = Math.round(
      (100 * DIMENSION_WEIGHTS.field + 70 * DIMENSION_WEIGHTS.risk) /
        (DIMENSION_WEIGHTS.field + DIMENSION_WEIGHTS.risk),
    );
    expect(h.score).toBe(expected);
    expect(h.ratedDimensions).toBe(2);
    expect(h.basis).toContain("2 rated dimensions");
  });

  it("never calls a project on track while any dimension is off track", () => {
    const inputs = emptyInputs();
    inputs.field = { rfisOpen: 5, rfisOverdue: 0, submittalsOpen: 0, submittalsOverdue: 0, punchOpen: 0, punchOverdue: 0 }; // 100
    inputs.cost = { budgetName: "B", currency: "USD", revisedBudget: 100, forecastFinal: 100, variance: 0, pendingChanges: 0, jobToDate: 0 }; // 100
    inputs.schedule = { scheduleName: "S", slipDays: 0, computedFinish: "2026-01-01", projectFinish: "2026-01-01", tasks: 10, overdueTasks: 0, criticalOverdue: 0, milestonesSlipped: 0, percentComplete: 0 }; // 100
    inputs.finance = { covenants: 1, breached: 1, unread: 0, claimsDeemed: 1, claimsSuspended: 1, conditionsOverdue: 0 }; // 15 → off track
    const h = scoreHealth(inputs);
    expect(h.score).toBeGreaterThanOrEqual(75);
    expect(h.level).toBe("watch");
    expect(h.basis).toContain("finance");
  });

  it("is deterministic for identical inputs", () => {
    const inputs = emptyInputs();
    inputs.safety = { recordCount: 3, incidents90d: 1, fatalities: 0, majorOrCatastrophic: 0, serious: 1, lostTime: 1, openIncidents: 1, openObservations: 0, overdueActions: 0 };
    const a = scoreHealth(inputs);
    const b = scoreHealth(JSON.parse(JSON.stringify(inputs)) as HealthInputs);
    expect(a).toEqual(b);
  });
});
