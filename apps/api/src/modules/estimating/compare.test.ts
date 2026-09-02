import { describe, expect, it } from "vitest";
import { compareEstimates, naturalKey, type ComparableLine } from "./compare.js";

/** Estimate version comparison (spec Vol I #200–201). */

const mk = (over: Partial<ComparableLine> & { id: string }): ComparableLine => ({
  lineageId: null,
  description: "Blockwork 140mm",
  costCode: "04-2000",
  costType: "material",
  unit: "m2",
  quantity: 100,
  unitRate: 50,
  amount: 5000,
  status: "active",
  ...over,
});

describe("naturalKey", () => {
  it("normalises whitespace and case so a retyped description still pairs", () => {
    expect(naturalKey(mk({ id: "a", description: "  Blockwork   140MM " }))).toBe(
      naturalKey(mk({ id: "b", description: "blockwork 140mm" })),
    );
  });

  it("keeps different cost codes apart", () => {
    expect(naturalKey(mk({ id: "a", costCode: "04-2000" }))).not.toBe(
      naturalKey(mk({ id: "b", costCode: "04-3000" })),
    );
  });
});

describe("compareEstimates", () => {
  it("pairs on lineage and separates the quantity move from the rate move", () => {
    const res = compareEstimates({
      before: [mk({ id: "a1", lineageId: "L1", quantity: 100, unitRate: 50, amount: 5000 })],
      after: [mk({ id: "b1", lineageId: "L1", quantity: 120, unitRate: 55, amount: 6600 })],
    });
    const row = res.rows[0];
    expect(row?.matchedOn).toBe("lineage");
    expect(row?.change).toBe("quantity_and_rate");
    expect(row?.quantityDelta).toBe(20);
    expect(row?.rateDelta).toBe(5);
    expect(row?.amountDelta).toBe(1600);
    expect(row?.quantityEffect).toBe(1000); // 20 more at the old rate
    expect(row?.rateEffect).toBe(600); // 5 more on the new quantity
    expect(res.totals.totalDelta).toBe(1600);
  });

  it("reports a pure quantity change and a pure rate change distinctly", () => {
    const qty = compareEstimates({
      before: [mk({ id: "a", lineageId: "L", quantity: 100, unitRate: 10, amount: 1000 })],
      after: [mk({ id: "b", lineageId: "L", quantity: 150, unitRate: 10, amount: 1500 })],
    });
    expect(qty.rows[0]?.change).toBe("quantity");
    const rate = compareEstimates({
      before: [mk({ id: "a", lineageId: "L", quantity: 100, unitRate: 10, amount: 1000 })],
      after: [mk({ id: "b", lineageId: "L", quantity: 100, unitRate: 12, amount: 1200 })],
    });
    expect(rate.rows[0]?.change).toBe("rate");
  });

  it("falls back to the natural key when there is no shared lineage", () => {
    const res = compareEstimates({
      before: [mk({ id: "a", description: "Excavation" })],
      after: [mk({ id: "b", description: "excavation", quantity: 110, amount: 5500 })],
    });
    expect(res.rows[0]?.matchedOn).toBe("natural_key");
    expect(res.rows[0]?.change).toBe("quantity");
  });

  it("reports added and removed lines and reconciles the decomposition", () => {
    const res = compareEstimates({
      before: [
        mk({ id: "a1", lineageId: "L1", amount: 5000 }),
        mk({ id: "a2", description: "Scaffold", costCode: "01-5000", amount: 2000 }),
      ],
      after: [
        mk({ id: "b1", lineageId: "L1", quantity: 110, amount: 5500 }),
        mk({ id: "b2", description: "Temporary works", costCode: "01-6000", amount: 3000 }),
      ],
    });
    expect(res.counts.added).toBe(1);
    expect(res.counts.removed).toBe(1);
    expect(res.totals.addedTotal).toBe(3000);
    expect(res.totals.removedTotal).toBe(-2000);
    const decomposed =
      res.totals.addedTotal +
      res.totals.removedTotal +
      res.totals.quantityEffectTotal +
      res.totals.rateEffectTotal;
    expect(decomposed).toBeCloseTo(res.totals.directCostDelta, 6);
  });

  it("treats a line taken out of the total as a scope change, not a rate change", () => {
    const res = compareEstimates({
      before: [mk({ id: "a", lineageId: "L", amount: 5000, status: "active" })],
      after: [mk({ id: "b", lineageId: "L", amount: 5000, status: "excluded" })],
    });
    expect(res.rows[0]?.change).toBe("scope");
    expect(res.totals.afterDirectCost).toBe(0);
  });

  it("hides unchanged rows unless asked for them", () => {
    const args = {
      before: [mk({ id: "a", lineageId: "L" })],
      after: [mk({ id: "b", lineageId: "L" })],
    };
    expect(compareEstimates(args).rows).toHaveLength(0);
    const all = compareEstimates({ ...args, includeUnchanged: true });
    expect(all.rows).toHaveLength(1);
    expect(all.rows[0]?.change).toBe("unchanged");
  });

  it("includes the markup block in the total delta", () => {
    const res = compareEstimates({
      before: [mk({ id: "a", lineageId: "L", amount: 1000 })],
      after: [mk({ id: "b", lineageId: "L", amount: 1000 })],
      beforeMarkupTotal: 100,
      afterMarkupTotal: 180,
      includeUnchanged: true,
    });
    expect(res.totals.markupDelta).toBe(80);
    expect(res.totals.totalDelta).toBe(80);
  });

  it("buckets the movement by cost type", () => {
    const res = compareEstimates({
      before: [
        mk({ id: "a", costType: "labour", amount: 1000 }),
        mk({ id: "b", costType: "material", amount: 2000, description: "Blocks" }),
      ],
      after: [
        mk({ id: "c", costType: "labour", amount: 1500 }),
        mk({ id: "d", costType: "material", amount: 2000, description: "Blocks" }),
      ],
    });
    const labour = res.byCostType.find((b) => b.costType === "labour");
    expect(labour?.delta).toBe(500);
    const material = res.byCostType.find((b) => b.costType === "material");
    expect(material?.delta).toBe(0);
  });

  it("warns about duplicate lineages instead of pairing arbitrarily", () => {
    const res = compareEstimates({
      before: [mk({ id: "a1", lineageId: "L" }), mk({ id: "a2", lineageId: "L", description: "Other" })],
      after: [mk({ id: "b1", lineageId: "L" })],
    });
    expect(res.warnings.join(" ")).toMatch(/more than one line on lineage/);
  });

  it("sorts the biggest movers first", () => {
    const res = compareEstimates({
      before: [
        mk({ id: "a1", lineageId: "L1", amount: 100 }),
        mk({ id: "a2", lineageId: "L2", amount: 100, description: "Big" }),
      ],
      after: [
        mk({ id: "b1", lineageId: "L1", amount: 150 }),
        mk({ id: "b2", lineageId: "L2", amount: 900, description: "Big" }),
      ],
    });
    expect(res.rows[0]?.description).toBe("Big");
  });
});
