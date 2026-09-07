import { describe, expect, it } from "vitest";
import {
  COMPARABLE_BAND,
  MIN_DAYS_TO_COMPARE,
  compareOwnership,
  type OwnershipDay,
} from "./ownership.js";

function day(over: Partial<OwnershipDay> = {}): OwnershipDay {
  return {
    equipmentId: "eq1",
    category: "earthmoving",
    ownership: "hired",
    currency: "GBP",
    workingHours: 8,
    idleHours: 2,
    standbyHours: 0,
    downtimeHours: 0,
    availableHours: 10,
    cost: 800,
    costIsComplete: true,
    ...over,
  };
}

function many(n: number, over: Partial<OwnershipDay>): OwnershipDay[] {
  return Array.from({ length: n }, (_, i) =>
    day({ ...over, equipmentId: `${over.equipmentId ?? "eq"}-${i % 2}` }),
  );
}

describe("compareOwnership", () => {
  it("says nothing at all when there are no plant days", () => {
    const result = compareOwnership([]);
    expect(result.buckets).toEqual([]);
    expect(result.totals.machineDays).toBe(0);
    expect(result.reasons.join(" ")).toContain("absence of plant sheets");
  });

  it("refuses a ratio on thin evidence rather than computing one", () => {
    const days = [
      ...many(2, { ownership: "hired", equipmentId: "h" }),
      ...many(2, { ownership: "owned", equipmentId: "o", cost: 400 }),
    ];
    const result = compareOwnership(days);
    const bucket = result.buckets[0]!;
    expect(bucket.verdict).toBe("not_comparable");
    expect(bucket.ratio).toBeNull();
    expect(bucket.reasons.join(" ")).toContain(String(MIN_DAYS_TO_COMPARE));
  });

  it("refuses when the owned fleet carries no internal rate, and says owned plant is not free", () => {
    const days = [
      ...many(6, { ownership: "hired", equipmentId: "h" }),
      ...many(6, { ownership: "owned", equipmentId: "o", cost: null, costIsComplete: false }),
    ];
    const bucket = compareOwnership(days).buckets[0]!;
    expect(bucket.verdict).toBe("not_comparable");
    expect(bucket.owned.cost).toBeNull();
    expect(bucket.owned.uncostedDays).toBe(6);
    expect(bucket.reasons.join(" ")).toContain("reads as free");
  });

  it("finds hired plant dearer per productive hour and prices the difference", () => {
    const days = [
      ...many(6, { ownership: "hired", equipmentId: "h", cost: 800, workingHours: 8 }),
      ...many(6, { ownership: "owned", equipmentId: "o", cost: 400, workingHours: 8 }),
    ];
    const bucket = compareOwnership(days).buckets[0]!;
    expect(bucket.verdict).toBe("hired_dearer");
    expect(bucket.hired.costPerWorkingHour).toBe(100);
    expect(bucket.owned.costPerWorkingHour).toBe(50);
    expect(bucket.ratio).toBe(2);
    // 48 hired productive hours × £50 of difference
    expect(bucket.differenceOnHiredHours).toBe(2400);
  });

  it("finds the owned fleet dearer when it stands", () => {
    const days = [
      ...many(6, { ownership: "hired", equipmentId: "h", cost: 400, workingHours: 8 }),
      // same money, a quarter of the productive hours
      ...many(6, { ownership: "owned", equipmentId: "o", cost: 400, workingHours: 2, idleHours: 8 }),
    ];
    const bucket = compareOwnership(days).buckets[0]!;
    expect(bucket.verdict).toBe("owned_dearer");
    expect(bucket.reasons.join(" ")).toContain("when it stands");
  });

  it("calls a difference inside the band the same, not a winner", () => {
    const days = [
      ...many(6, { ownership: "hired", equipmentId: "h", cost: 800, workingHours: 8 }),
      ...many(6, { ownership: "owned", equipmentId: "o", cost: 780, workingHours: 8 }),
    ];
    const bucket = compareOwnership(days).buckets[0]!;
    expect(bucket.verdict).toBe("comparable");
    expect(Math.abs((bucket.ratio ?? 0) - 1)).toBeLessThanOrEqual(COMPARABLE_BAND);
  });

  it("never mixes currencies into one bucket", () => {
    const days = [
      ...many(6, { ownership: "hired", equipmentId: "h", currency: "GBP" }),
      ...many(6, { ownership: "owned", equipmentId: "o", currency: "GBP", cost: 400 }),
      ...many(6, { ownership: "hired", equipmentId: "he", currency: "EUR" }),
      ...many(6, { ownership: "owned", equipmentId: "oe", currency: "EUR", cost: 400 }),
    ];
    const result = compareOwnership(days);
    expect(result.buckets).toHaveLength(2);
    expect(new Set(result.buckets.map((b) => b.currency))).toEqual(new Set(["GBP", "EUR"]));
    for (const bucket of result.buckets) {
      expect(bucket.hired.days).toBe(6);
      expect(bucket.owned.days).toBe(6);
    }
  });

  it("never mixes categories into one bucket", () => {
    const days = [
      ...many(6, { ownership: "hired", equipmentId: "h", category: "earthmoving" }),
      ...many(6, { ownership: "owned", equipmentId: "o", category: "earthmoving", cost: 400 }),
      ...many(6, { ownership: "hired", equipmentId: "ht", category: "lifting" }),
    ];
    const result = compareOwnership(days);
    expect(result.buckets).toHaveLength(2);
    const lifting = result.buckets.find((b) => b.category === "lifting")!;
    expect(lifting.verdict).toBe("not_comparable");
    expect(lifting.reasons.join(" ")).toContain("no in-house rate");
  });

  it("treats leased and operator-hired plant as hired", () => {
    const days = [
      ...many(3, { ownership: "leased", equipmentId: "l" }),
      ...many(3, { ownership: "operator_hired", equipmentId: "oh" }),
      ...many(6, { ownership: "owned", equipmentId: "o", cost: 400 }),
    ];
    const bucket = compareOwnership(days).buckets[0]!;
    expect(bucket.hired.days).toBe(6);
    expect(bucket.owned.days).toBe(6);
    expect(bucket.verdict).toBe("hired_dearer");
  });

  it("counts uncosted days rather than quietly dropping them", () => {
    const days = [
      ...many(6, { ownership: "hired", equipmentId: "h" }),
      ...many(5, { ownership: "owned", equipmentId: "o", cost: 400 }),
      day({ ownership: "owned", equipmentId: "o-2", cost: null, costIsComplete: false }),
    ];
    const result = compareOwnership(days);
    const bucket = result.buckets[0]!;
    expect(bucket.owned.uncostedDays).toBe(1);
    expect(result.totals.uncostedDays).toBe(1);
    expect(bucket.reasons.join(" ")).toContain("not counted as zero");
  });

  it("reports a partially costed day as a floor on both figures", () => {
    const days = [
      ...many(6, { ownership: "hired", equipmentId: "h", costIsComplete: false }),
      ...many(6, { ownership: "owned", equipmentId: "o", cost: 400 }),
    ];
    const bucket = compareOwnership(days).buckets[0]!;
    expect(bucket.hired.partiallyCostedDays).toBe(6);
    expect(bucket.reasons.join(" ")).toContain("floors");
  });

  it("never states a capital verdict — depreciation is out of scope and says so", () => {
    const result = compareOwnership(many(6, { ownership: "hired", equipmentId: "h" }));
    expect(result.reasons.join(" ")).toContain("capital appraisal");
  });
});
