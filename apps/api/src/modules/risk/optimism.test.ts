import { describe, expect, it } from "vitest";
import {
  OPTIMISM_BIAS_TABLE,
  RCF_THIN_SAMPLE,
  optimismBand,
  percentileOf,
  referenceClassForecast,
  upliftFor,
  type ReferenceProjectInput,
} from "./optimism.js";

describe("HM Treasury optimism bias table (#402)", () => {
  it("carries the published upper/lower bounds for all six categories", () => {
    expect(OPTIMISM_BIAS_TABLE).toHaveLength(6);
    const map = Object.fromEntries(
      OPTIMISM_BIAS_TABLE.map((b) => [b.category, [b.upperPercent, b.lowerPercent]]),
    );
    expect(map["standard_building"]).toEqual([24, 2]);
    expect(map["non_standard_building"]).toEqual([51, 4]);
    expect(map["standard_civil_engineering"]).toEqual([44, 3]);
    expect(map["non_standard_civil_engineering"]).toEqual([66, 6]);
    expect(map["equipment_development"]).toEqual([200, 10]);
    expect(map["outsourcing"]).toEqual([41, 0]);
  });

  it("returns null for an unknown category rather than guessing", () => {
    expect(optimismBand("space_elevator")).toBeNull();
    expect(upliftFor("space_elevator", 0.5)).toBeNull();
  });
});

describe("uplift interpolation (#402-403)", () => {
  it("position 0 is the upper bound, 1 the lower bound", () => {
    expect(upliftFor("standard_building", 0)!.upliftPercent).toBe(24);
    expect(upliftFor("standard_building", 1)!.upliftPercent).toBe(2);
  });

  it("interpolates linearly in between", () => {
    expect(upliftFor("standard_building", 0.5)!.upliftPercent).toBe(13);
    expect(upliftFor("non_standard_civil_engineering", 0.25)!.upliftPercent).toBe(51);
  });

  it("clamps a position outside 0..1", () => {
    expect(upliftFor("outsourcing", -3)!.upliftPercent).toBe(41);
    expect(upliftFor("outsourcing", 9)!.upliftPercent).toBe(0);
  });

  it("states its basis so the number can be challenged", () => {
    const u = upliftFor("standard_civil_engineering", 0.5)!;
    expect(u.basis).toContain("Green Book");
    expect(u.basis).toContain("44%");
    expect(u.basis).toContain("3%");
  });
});

describe("nearest-rank percentile", () => {
  it("returns an order statistic, never an interpolated value", () => {
    const s = [1, 2, 3, 4, 5];
    expect(percentileOf(s, 0.5)).toBe(3);
    expect(percentileOf(s, 0.8)).toBe(4);
    expect(percentileOf(s, 0.9)).toBe(5);
    expect(percentileOf(s, 0)).toBe(1);
  });

  it("is null on an empty sample", () => {
    expect(percentileOf([], 0.5)).toBeNull();
  });
});

const ref = (
  id: string,
  category: string,
  estimatedCost: number | null,
  outturnCost: number | null,
  extra: Partial<ReferenceProjectInput> = {},
): ReferenceProjectInput => ({
  id,
  name: id,
  category,
  estimatedCost,
  outturnCost,
  estimatedDurationDays: null,
  outturnDurationDays: null,
  ...extra,
});

describe("reference class forecasting (#403-404)", () => {
  it("computes empirical uplift percentiles from outturn/estimate ratios", () => {
    const refs = [
      ref("a", "standard_building", 100, 100), // 1.0 → 0%
      ref("b", "standard_building", 100, 110), // 1.1 → 10%
      ref("c", "standard_building", 100, 120), // 1.2 → 20%
      ref("d", "standard_building", 100, 150), // 1.5 → 50%
    ];
    const f = referenceClassForecast(refs, { category: "standard_building" });
    expect(f.sampleSize).toBe(4);
    expect(f.p50UpliftPercent).toBe(10);
    expect(f.p80UpliftPercent).toBe(50);
    expect(f.meanUpliftPercent).toBe(20);
    expect(f.unavailableReason).toBeNull();
  });

  it("ignores references outside the class", () => {
    const refs = [
      ref("a", "standard_building", 100, 200),
      ref("b", "non_standard_building", 100, 400),
    ];
    const f = referenceClassForecast(refs, { category: "standard_building" });
    expect(f.sampleSize).toBe(1);
    expect(f.p50UpliftPercent).toBe(100);
  });

  it("excludes references missing a number rather than defaulting it to zero", () => {
    const refs = [
      ref("a", "standard_building", 100, 150),
      ref("b", "standard_building", null, 150),
      ref("c", "standard_building", 100, null),
      ref("d", "standard_building", 0, 150), // non-positive estimate
    ];
    const f = referenceClassForecast(refs, { category: "standard_building" });
    expect(f.sampleSize).toBe(1);
  });

  it("reports the reason when nothing can be computed, and never a 0", () => {
    const empty = referenceClassForecast([], { category: "standard_building" });
    expect(empty.p50UpliftPercent).toBeNull();
    expect(empty.p80UpliftPercent).toBeNull();
    expect(empty.unavailableReason).toContain("No completed reference projects");

    const unusable = referenceClassForecast([ref("a", "standard_building", null, null)], {
      category: "standard_building",
    });
    expect(unusable.sampleSize).toBe(0);
    expect(unusable.unavailableReason).toContain("none carry both");
  });

  it("flags a thin sample instead of pretending it is a distribution", () => {
    const few = referenceClassForecast(
      [ref("a", "standard_building", 100, 120), ref("b", "standard_building", 100, 130)],
      { category: "standard_building" },
    );
    expect(few.thin).toBe(true);
    expect(few.basisNote).toContain(`Fewer than ${RCF_THIN_SAMPLE}`);

    const many = referenceClassForecast(
      Array.from({ length: RCF_THIN_SAMPLE }, (_, i) =>
        ref(`r${i}`, "standard_building", 100, 100 + i * 5),
      ),
      { category: "standard_building" },
    );
    expect(many.thin).toBe(false);
    expect(many.basisNote).toContain("large enough");
  });

  it("forecasts duration when asked for the duration basis", () => {
    const refs = [
      ref("a", "standard_building", null, null, {
        estimatedDurationDays: 100,
        outturnDurationDays: 130,
      }),
      ref("b", "standard_building", null, null, {
        estimatedDurationDays: 200,
        outturnDurationDays: 220,
      }),
    ];
    const f = referenceClassForecast(refs, { category: "standard_building", basis: "duration" });
    expect(f.basis).toBe("duration");
    expect(f.sampleSize).toBe(2);
    expect(f.p50UpliftPercent).toBe(10);
  });
});
