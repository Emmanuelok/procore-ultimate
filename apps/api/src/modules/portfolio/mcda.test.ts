import { describe, expect, it } from "vitest";
import { McdaError, parseCriteria, rankPortfolio, type McdaCandidate, type McdaCriterion } from "./mcda.js";

const criteria: McdaCriterion[] = [
  { key: "strategic", label: "Strategic fit", weight: 3, direction: "benefit", min: 0, max: 10 },
  { key: "risk", label: "Delivery risk", weight: 1, direction: "cost", min: 0, max: 10 },
];

describe("parseCriteria", () => {
  it("accepts a well-formed model and defaults label, direction and scale", () => {
    const parsed = parseCriteria([{ key: "a", weight: 2 }]);
    expect(parsed).toEqual([
      { key: "a", label: "a", description: null, weight: 2, direction: "benefit", min: 0, max: 10 },
    ]);
  });

  it("refuses malformed models rather than scoring on a guess", () => {
    expect(() => parseCriteria("nope")).toThrow(McdaError);
    expect(() => parseCriteria([])).toThrow(/at least one criterion/);
    expect(() => parseCriteria([{ weight: 1 }])).toThrow(/needs a key/);
    expect(() => parseCriteria([{ key: "a", weight: 1 }, { key: "a", weight: 1 }])).toThrow(/Duplicate/);
    expect(() => parseCriteria([{ key: "a", weight: -1 }])).toThrow(/negative weight/);
    expect(() => parseCriteria([{ key: "a", weight: 1, min: 5, max: 5 }])).toThrow(/max greater than min/);
    expect(() => parseCriteria([{ key: "a", weight: 0 }])).toThrow(/positive weight/);
  });
});

describe("rankPortfolio — weighting and direction", () => {
  it("weights criteria and inverts cost-direction ones", () => {
    const candidates: McdaCandidate[] = [
      { projectId: "p1", projectName: "Alpha", scores: { strategic: 10, risk: 0 } },
      { projectId: "p2", projectName: "Beta", scores: { strategic: 0, risk: 10 } },
      { projectId: "p3", projectName: "Gamma", scores: { strategic: 5, risk: 5 } },
    ];
    const run = rankPortfolio(criteria, candidates);
    const byId = new Map(run.ranked.map((r) => [r.projectId, r]));
    // Alpha scores 1.0 on both (risk 0 inverted to 1.0) → 100
    expect(byId.get("p1")!.score).toBeCloseTo(100, 6);
    // Beta scores 0 on both → 0
    expect(byId.get("p2")!.score).toBeCloseTo(0, 6);
    expect(byId.get("p3")!.score).toBeCloseTo(50, 6);
    expect(run.ranked.map((r) => r.projectId)).toEqual(["p1", "p3", "p2"]);
    expect(run.ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("applies the declared weights, not an equal split", () => {
    const candidates: McdaCandidate[] = [
      { projectId: "high-strategic", projectName: "A", scores: { strategic: 10, risk: 10 } },
      { projectId: "low-risk", projectName: "B", scores: { strategic: 0, risk: 0 } },
    ];
    const run = rankPortfolio(criteria, candidates);
    const a = run.ranked.find((r) => r.projectId === "high-strategic")!;
    const b = run.ranked.find((r) => r.projectId === "low-risk")!;
    // A: 3/4 × 1.0 + 1/4 × 0.0 = 0.75; B: 3/4 × 0 + 1/4 × 1.0 = 0.25
    expect(a.score).toBeCloseTo(75, 6);
    expect(b.score).toBeCloseTo(25, 6);
    expect(a.criteria.find((c) => c.key === "strategic")!.weightShare).toBeCloseTo(0.75, 6);
  });

  it("clamps out-of-range entries and says so instead of silently accepting them", () => {
    const run = rankPortfolio(criteria, [
      { projectId: "p", projectName: "P", scores: { strategic: 40, risk: -5 } },
    ]);
    const row = run.ranked[0]!;
    expect(row.score).toBeCloseTo(100, 6);
    expect(row.criteria.every((c) => c.reason?.includes("outside"))).toBe(true);
  });
});

describe("rankPortfolio — honesty about gaps", () => {
  it("scores over the covered weight and reports coverage, never zero-filling", () => {
    const run = rankPortfolio(criteria, [
      { projectId: "partial", projectName: "Partial", scores: { strategic: 10 } },
    ]);
    const row = run.ranked[0]!;
    expect(row.score).toBeCloseTo(100, 6); // 100% of the 75% of weight it was scored on
    expect(row.coverage).toBeCloseTo(0.75, 6);
    expect(row.scoredCriteria).toBe(1);
    expect(row.reasons.join(" ")).toMatch(/Delivery risk/);
    expect(row.criteria.find((c) => c.key === "risk")!.reason).toBe("not scored");
  });

  it("returns a null score and a reason for an unscored project, and ranks it last", () => {
    const run = rankPortfolio(criteria, [
      { projectId: "scored", projectName: "Scored", scores: { strategic: 5, risk: 5 } },
      { projectId: "blank", projectName: "Blank", scores: {} },
    ]);
    const blank = run.ranked.find((r) => r.projectId === "blank")!;
    expect(blank.score).toBeNull();
    expect(blank.rank).toBeNull();
    expect(blank.reasons[0]).toMatch(/no criterion carrying weight/);
    expect(run.ranked[run.ranked.length - 1]!.projectId).toBe("blank");
  });

  it("gives tied projects the same rank and skips the next (competition ranking)", () => {
    const run = rankPortfolio(criteria, [
      { projectId: "a", projectName: "A", scores: { strategic: 5, risk: 5 } },
      { projectId: "b", projectName: "B", scores: { strategic: 5, risk: 5 } },
      { projectId: "c", projectName: "C", scores: { strategic: 1, risk: 9 } },
    ]);
    expect(run.ranked.map((r) => [r.projectId, r.rank])).toEqual([
      ["a", 1],
      ["b", 1],
      ["c", 3],
    ]);
  });
});

describe("rankPortfolio — normalisation methods", () => {
  it("relative normalisation stretches the observed spread", () => {
    const candidates: McdaCandidate[] = [
      { projectId: "a", projectName: "A", scores: { strategic: 6, risk: 3 } },
      { projectId: "b", projectName: "B", scores: { strategic: 7, risk: 4 } },
    ];
    const fixed = rankPortfolio(criteria, candidates, "fixed_scale");
    const relative = rankPortfolio(criteria, candidates, "relative");
    // Under fixed scale both sit mid-range; under relative, A is best on risk
    // (lowest) and worst on strategic, so the extremes are 0 and 100.
    expect(fixed.ranked.find((r) => r.projectId === "b")!.score).toBeGreaterThan(
      fixed.ranked.find((r) => r.projectId === "a")!.score!,
    );
    const relA = relative.ranked.find((r) => r.projectId === "a")!;
    expect(relA.criteria.find((c) => c.key === "strategic")!.normalised).toBeCloseTo(0, 6);
    expect(relA.criteria.find((c) => c.key === "risk")!.normalised).toBeCloseTo(1, 6);
  });

  it("drops a relative criterion with no spread and records the reason", () => {
    const run = rankPortfolio(
      criteria,
      [
        { projectId: "a", projectName: "A", scores: { strategic: 5, risk: 2 } },
        { projectId: "b", projectName: "B", scores: { strategic: 5, risk: 8 } },
      ],
      "relative",
    );
    expect(run.excludedCriteria.map((e) => e.key)).toEqual(["strategic"]);
    expect(run.excludedCriteria[0]!.reason).toMatch(/same value/);
    expect(run.criteria.map((c) => c.key)).toEqual(["risk"]);
  });

  it("warns when relative normalisation has fewer than two candidates", () => {
    const run = rankPortfolio(criteria, [{ projectId: "a", projectName: "A", scores: { strategic: 5, risk: 5 } }], "relative");
    expect(run.warnings.join(" ")).toMatch(/fewer than two candidates/);
  });

  it("excludes zero-weight criteria from the run", () => {
    const run = rankPortfolio(
      [...criteria, { key: "noise", label: "Noise", weight: 0, direction: "benefit", min: 0, max: 10 }],
      [{ projectId: "a", projectName: "A", scores: { strategic: 5, risk: 5, noise: 10 } }],
    );
    expect(run.excludedCriteria.map((e) => e.key)).toEqual(["noise"]);
    expect(run.ranked[0]!.score).toBeCloseTo(50, 6);
  });
});

describe("rankPortfolio — influence", () => {
  it("reports which criterion actually moves the ranking", () => {
    const model: McdaCriterion[] = [
      { key: "value", label: "Value", weight: 5, direction: "benefit", min: 0, max: 10 },
      { key: "tiebreak", label: "Tiebreak", weight: 1, direction: "benefit", min: 0, max: 10 },
    ];
    const run = rankPortfolio(model, [
      { projectId: "a", projectName: "A", scores: { value: 10, tiebreak: 0 } },
      { projectId: "b", projectName: "B", scores: { value: 9, tiebreak: 10 } },
    ]);
    // Weighted: A = 5/6 × 1 = 0.833; B = 5/6 × 0.9 + 1/6 × 1 = 0.916 → B leads.
    expect(run.ranked[0]!.projectId).toBe("b");
    const tiebreak = run.influence.find((i) => i.key === "tiebreak")!;
    expect(tiebreak.changesLeader).toBe(true);
    expect(tiebreak.rankChanges).toBe(2);
  });

  it("produces no influence table for a single-criterion model", () => {
    const run = rankPortfolio(
      [{ key: "only", label: "Only", weight: 1, direction: "benefit", min: 0, max: 10 }],
      [{ projectId: "a", projectName: "A", scores: { only: 4 } }],
    );
    expect(run.influence).toEqual([]);
  });
});
