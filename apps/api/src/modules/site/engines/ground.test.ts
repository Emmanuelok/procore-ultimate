import { describe, expect, it } from "vitest";
import { compareGround, type Stratum } from "./ground.js";

const baseline: Stratum[] = [
  { fromM: 0, toM: 2, description: "Made ground", soilType: "made_ground" },
  { fromM: 2, toM: 6, description: "Firm clay", soilType: "clay", spt: 20, strengthKpa: 90 },
  { fromM: 6, toM: 12, description: "Dense sand", soilType: "sand", spt: 40 },
];

describe("compareGround", () => {
  it("finds no change when the logs agree", () => {
    const r = compareGround(baseline, baseline);
    expect(r.findings).toEqual([]);
    expect(r.slicesCompared).toBeGreaterThan(0);
    expect(r.maxDepthComparedM).toBe(12);
  });

  it("reports a strata change at the interval where the logs differ", () => {
    const observed: Stratum[] = [
      { fromM: 0, toM: 2, description: "Made ground", soilType: "made_ground" },
      { fromM: 2, toM: 4, description: "Firm clay", soilType: "clay", spt: 20, strengthKpa: 90 },
      { fromM: 4, toM: 6, description: "Soft silt", soilType: "silt", spt: 4, strengthKpa: 20 },
      { fromM: 6, toM: 12, description: "Dense sand", soilType: "sand", spt: 40 },
    ];
    const r = compareGround(observed, baseline);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.depthFromM).toBe(4);
    expect(r.findings[0]?.depthToM).toBe(6);
    expect(r.findings[0]?.differsFromBaseline).toBe(true);
    expect(r.findings[0]?.varianceNotes).toContain("Firm clay");
    expect(r.findings[0]?.varianceNotes).toContain("Soft silt");
  });

  it("categorises rock encountered where the baseline said soil", () => {
    const observed: Stratum[] = [
      { fromM: 0, toM: 2, description: "Made ground", soilType: "made_ground" },
      { fromM: 2, toM: 6, description: "Weathered sandstone bedrock", soilType: "rock" },
      { fromM: 6, toM: 12, description: "Dense sand", soilType: "sand", spt: 40 },
    ];
    const r = compareGround(observed, baseline);
    expect(r.findings[0]?.category).toBe("rock_level");
    expect(r.findings[0]?.severity).toBe("high");
  });

  it("treats contamination and voids as critical however thin", () => {
    const observed: Stratum[] = [
      { fromM: 0, toM: 2, description: "Made ground with hydrocarbon contamination", soilType: "made_ground_contaminated" },
      { fromM: 2, toM: 2.2, description: "Open void / cavity", soilType: "void" },
      { fromM: 2.2, toM: 6, description: "Firm clay", soilType: "clay" },
      { fromM: 6, toM: 12, description: "Dense sand", soilType: "sand" },
    ];
    const r = compareGround(observed, baseline);
    const categories = r.findings.map((f) => f.category);
    expect(categories).toContain("contamination");
    expect(categories).toContain("voids");
    for (const f of r.findings.filter((x) => x.category === "voids" || x.category === "contamination")) {
      expect(f.severity).toBe("critical");
    }
  });

  it("detects a strength collapse in the same material", () => {
    const observed: Stratum[] = [
      { fromM: 0, toM: 2, description: "Made ground", soilType: "made_ground" },
      { fromM: 2, toM: 6, description: "Firm clay", soilType: "clay", spt: 5, strengthKpa: 25 },
      { fromM: 6, toM: 12, description: "Dense sand", soilType: "sand", spt: 40 },
    ];
    const r = compareGround(observed, baseline);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.category).toBe("bearing_capacity");
    expect(r.findings[0]?.varianceNotes).toContain("SPT N observed 5");
  });

  it("never calls an interval the baseline is silent about a change", () => {
    const observed: Stratum[] = [
      { fromM: 0, toM: 2, description: "Made ground", soilType: "made_ground" },
      { fromM: 2, toM: 6, description: "Firm clay", soilType: "clay", spt: 20, strengthKpa: 90 },
      { fromM: 6, toM: 12, description: "Dense sand", soilType: "sand", spt: 40 },
      { fromM: 12, toM: 18, description: "Gravel", soilType: "gravel" },
    ];
    const r = compareGround(observed, baseline);
    expect(r.slicesWithoutBaseline).toBe(1);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.differsFromBaseline).toBe(false);
    expect(r.findings[0]?.baselineDescription).toBeNull();
  });

  it("compares the water table only when both depths are held", () => {
    const both = compareGround(baseline, baseline, { observedWaterStrikeM: 2, baselineWaterStrikeM: 6 });
    expect(both.findings.some((f) => f.category === "water_table")).toBe(true);
    expect(both.findings.find((f) => f.category === "water_table")?.varianceNotes).toContain("HIGHER");

    const one = compareGround(baseline, baseline, { observedWaterStrikeM: 2 });
    expect(one.findings.some((f) => f.category === "water_table")).toBe(false);
    expect(one.reasons.some((x) => x.includes("Only one"))).toBe(true);
  });

  it("ignores a water difference inside the tolerance", () => {
    const r = compareGround(baseline, baseline, {
      observedWaterStrikeM: 5.6,
      baselineWaterStrikeM: 6,
      waterToleranceM: 1,
    });
    expect(r.findings).toEqual([]);
  });

  it("refuses to compare an empty observed log and explains itself", () => {
    const r = compareGround([], baseline);
    expect(r.findings).toEqual([]);
    expect(r.reasons[0]).toContain("no usable strata intervals");
  });

  it("reports everything as unbaselined when no baseline log exists", () => {
    const r = compareGround(baseline, []);
    expect(r.reasons.some((x) => x.includes("No baseline strata log"))).toBe(true);
    expect(r.findings.every((f) => f.differsFromBaseline === false)).toBe(true);
  });
});
