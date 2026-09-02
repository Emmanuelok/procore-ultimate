import { describe, expect, it } from "vitest";
import {
  assessPour,
  assessableSpecimens,
  consecutiveGroups,
  rollingGroups,
  slumpVerdict,
  strengthStatistics,
  type SpecimenLike,
} from "./concreteStats.js";

const specimen = (over: Partial<SpecimenLike> & { specimenRef: string }): SpecimenLike => ({
  id: `spec-${over.specimenRef}`,
  specimenType: "cube",
  testAgeDays: 28,
  testDate: "2026-07-01",
  strengthMpa: null,
  result: "pending",
  ...over,
});

const tested = (ref: string, strength: number, testDate = "2026-07-01"): SpecimenLike =>
  specimen({ specimenRef: ref, strengthMpa: strength, result: "pass", testDate });

describe("strengthStatistics", () => {
  it("refuses to compute anything from an untested pour", () => {
    const stats = strengthStatistics([specimen({ specimenRef: "C1" })], 28);
    expect(stats.mean).toBeNull();
    expect(stats.testedCount).toBe(0);
    expect(stats.pendingCount).toBe(1);
    expect(stats.reasons.join(" ")).toContain("no statistics can be computed");
  });

  it("computes mean, min, max and the sample standard deviation", () => {
    const stats = strengthStatistics(
      [tested("C1", 40), tested("C2", 44), tested("C3", 42)],
      28,
    );
    expect(stats.testedCount).toBe(3);
    expect(stats.mean).toBe(42);
    expect(stats.min).toBe(40);
    expect(stats.max).toBe(44);
    expect(stats.standardDeviation).toBe(2);
  });

  it("excludes voided specimens and says so", () => {
    const stats = strengthStatistics(
      [
        tested("C1", 40),
        specimen({ specimenRef: "C2", strengthMpa: 12, result: "void", testDate: "2026-07-01" }),
      ],
      28,
    );
    expect(stats.testedCount).toBe(1);
    expect(stats.voidCount).toBe(1);
    expect(stats.reasons.join(" ")).toContain("voided specimen is not a failed one");
  });

  it("only counts specimens at the specified test age", () => {
    const stats = strengthStatistics(
      [tested("C1", 40), { ...tested("C2", 25), testAgeDays: 7 }],
      28,
    );
    expect(stats.testedCount).toBe(1);
    expect(assessableSpecimens([tested("C1", 40)], 28)).toHaveLength(1);
  });

  it("orders results by test date so the consecutive rules mean something", () => {
    const stats = strengthStatistics(
      [tested("C3", 50, "2026-07-03"), tested("C1", 40, "2026-07-01"), tested("C2", 45, "2026-07-02")],
      28,
    );
    expect(stats.values).toEqual([40, 45, 50]);
  });
});

describe("grouping helpers", () => {
  it("forms non-overlapping consecutive groups", () => {
    expect(consecutiveGroups([1, 2, 3, 4, 5], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
  it("forms rolling groups", () => {
    expect(rollingGroups([1, 2, 3, 4], 3)).toEqual([
      [1, 2, 3],
      [2, 3, 4],
    ]);
  });
});

describe("assessPour — EN 206", () => {
  const spec = { specifiedStrengthMpa: 40, testAgeDays: 28, acceptanceCode: "en_206" };

  it("accepts a run whose three-result mean clears fck + 4 with no low individual", () => {
    const out = assessPour(spec, [
      tested("C1", 46, "2026-07-01"),
      tested("C2", 47, "2026-07-02"),
      tested("C3", 45, "2026-07-03"),
    ]);
    expect(out.verdict).toBe("accepted");
    expect(out.checks.every((c) => c.passed === true)).toBe(true);
  });

  it("rejects a run with an individual result more than 4 MPa below fck", () => {
    const out = assessPour(spec, [
      tested("C1", 35, "2026-07-01"),
      tested("C2", 48, "2026-07-02"),
      tested("C3", 50, "2026-07-03"),
    ]);
    expect(out.verdict).toBe("rejected");
    const individual = out.checks.find((c) => c.name === "individual result");
    expect(individual?.passed).toBe(false);
    expect(out.reasons.join(" ")).toContain("non-conformance");
  });

  it("rejects a run whose three-result mean is short even with every individual in range", () => {
    const out = assessPour(spec, [
      tested("C1", 42, "2026-07-01"),
      tested("C2", 43, "2026-07-02"),
      tested("C3", 43, "2026-07-03"),
    ]);
    expect(out.verdict).toBe("rejected");
    expect(out.checks.find((c) => c.name.startsWith("mean"))?.passed).toBe(false);
  });

  it("is inconclusive with fewer than three results and nothing failing", () => {
    const out = assessPour(spec, [tested("C1", 50, "2026-07-01"), tested("C2", 51, "2026-07-02")]);
    expect(out.verdict).toBe("inconclusive");
    expect(out.checks.find((c) => c.name.startsWith("mean"))?.passed).toBeNull();
  });

  it("uses the continuous-production sigma rule once the run is long enough", () => {
    const prior = Array.from({ length: 40 }, () => 50);
    const out = assessPour(
      { ...spec, priorResults: prior },
      [tested("C1", 45, "2026-07-01"), tested("C2", 46, "2026-07-02"), tested("C3", 47, "2026-07-03")],
    );
    const meanCheck = out.checks.find((c) => c.name.includes("continuous"));
    expect(meanCheck).toBeDefined();
    expect(meanCheck?.passed).toBe(true);
    expect(out.verdict).toBe("accepted");
  });
});

describe("assessPour — ACI 318", () => {
  const spec = { specifiedStrengthMpa: 30, testAgeDays: 28, acceptanceCode: "aci_318" };

  it("accepts averages of three at or above f'c with no test below f'c - 3.45", () => {
    const out = assessPour(spec, [
      tested("C1", 31, "2026-07-01"),
      tested("C2", 30, "2026-07-02"),
      tested("C3", 32, "2026-07-03"),
    ]);
    expect(out.verdict).toBe("accepted");
  });

  it("rejects a single test more than 3.45 MPa below f'c", () => {
    const out = assessPour(spec, [
      tested("C1", 26, "2026-07-01"),
      tested("C2", 36, "2026-07-02"),
      tested("C3", 36, "2026-07-03"),
    ]);
    expect(out.verdict).toBe("rejected");
    expect(out.checks.find((c) => c.name === "individual test")?.passed).toBe(false);
  });

  it("uses the 0.90 f'c floor above 35 MPa", () => {
    const out = assessPour(
      { specifiedStrengthMpa: 50, testAgeDays: 28, acceptanceCode: "aci_318" },
      [tested("C1", 44, "2026-07-01"), tested("C2", 56, "2026-07-02"), tested("C3", 56, "2026-07-03")],
    );
    expect(out.checks.find((c) => c.name === "individual test")?.requirement).toContain("0.90");
    expect(out.checks.find((c) => c.name === "individual test")?.passed).toBe(false);
  });
});

describe("assessPour — IS 456 and the specified-only fallback", () => {
  it("needs four non-overlapping results before the IS 456 group rule applies", () => {
    const out = assessPour(
      { specifiedStrengthMpa: 25, testAgeDays: 28, acceptanceCode: "is_456" },
      [tested("C1", 32, "2026-07-01"), tested("C2", 33, "2026-07-02")],
    );
    expect(out.verdict).toBe("inconclusive");
  });

  it("judges every result against the bare specified strength when no code is chosen", () => {
    const out = assessPour(
      { specifiedStrengthMpa: 40, testAgeDays: 28, acceptanceCode: "specified_only" },
      [tested("C1", 39.5, "2026-07-01")],
    );
    expect(out.verdict).toBe("rejected");
    expect(out.checks[0]!.requirement).toContain("no statistical allowance");
  });
});

describe("assessPour — refusals", () => {
  it("is not assessable without a specified strength", () => {
    const out = assessPour(
      { specifiedStrengthMpa: null, testAgeDays: 28, acceptanceCode: "en_206" },
      [tested("C1", 50)],
    );
    expect(out.verdict).toBe("not_assessable");
    expect(out.reasons.join(" ")).toContain("just numbers");
  });

  it("is not assessable with no tested specimen", () => {
    const out = assessPour(
      { specifiedStrengthMpa: 40, testAgeDays: 28, acceptanceCode: "en_206" },
      [specimen({ specimenRef: "C1" })],
    );
    expect(out.verdict).toBe("not_assessable");
  });

  it("downgrades an otherwise passing verdict while specimens are outstanding", () => {
    const out = assessPour(
      { specifiedStrengthMpa: 40, testAgeDays: 28, acceptanceCode: "en_206" },
      [
        tested("C1", 46, "2026-07-01"),
        tested("C2", 47, "2026-07-02"),
        tested("C3", 48, "2026-07-03"),
        specimen({ specimenRef: "C4" }),
      ],
    );
    expect(out.verdict).toBe("inconclusive");
    expect(out.reasons.join(" ")).toContain("not finally accepted");
  });

  it("falls back to the specified-only rule on an unknown code rather than throwing", () => {
    const out = assessPour(
      { specifiedStrengthMpa: 40, testAgeDays: 28, acceptanceCode: "made_up" },
      [tested("C1", 41)],
    );
    expect(out.code).toBe("specified_only");
    expect(out.verdict).toBe("accepted");
  });
});

describe("slumpVerdict", () => {
  it("passes inside the window, fails outside it, and refuses without one", () => {
    expect(slumpVerdict(120, 100, 150).passed).toBe(true);
    expect(slumpVerdict(90, 100, 150).passed).toBe(false);
    expect(slumpVerdict(160, 100, 150).passed).toBe(false);
    expect(slumpVerdict(120, null, null).passed).toBeNull();
    expect(slumpVerdict(null, 100, 150).passed).toBeNull();
  });
});
