import { describe, expect, it } from "vitest";
import {
  applyMarkups,
  assemblyUnitRate,
  buildLabourRate,
  crewCost,
  dominantCostType,
  estimateTotals,
  expandAssembly,
  hoursPerUnit,
  makeSplit,
  priceLine,
  rateKeyForCostType,
  rollUpLines,
  splitTotal,
  type MarkupSpec,
  type RollupLine,
} from "./pricing.js";

/** Estimate pricing engine (spec Vol I #190–199). */

const line = (over: Partial<RollupLine> = {}): RollupLine => ({
  costType: "material",
  status: "active",
  labourAmount: 0,
  materialAmount: 100,
  equipmentAmount: 0,
  subcontractAmount: 0,
  otherAmount: 0,
  amount: 100,
  ...over,
});

describe("rate splits", () => {
  it("sums and normalises a partial split", () => {
    const split = makeSplit({ labour: 10, material: 20 });
    expect(splitTotal(split)).toBe(30);
    expect(split.equipment).toBe(0);
  });

  it("drops non-finite components rather than propagating NaN", () => {
    const split = makeSplit({ labour: Number.NaN, material: 5 });
    expect(splitTotal(split)).toBe(5);
  });

  it("maps cost types onto rate keys", () => {
    expect(rateKeyForCostType("labour")).toBe("labour");
    expect(rateKeyForCostType("subcontract")).toBe("subcontract");
    expect(rateKeyForCostType("nonsense")).toBe("other");
  });

  it("picks the dominant cost type deterministically", () => {
    expect(dominantCostType(makeSplit({ labour: 5, material: 9 }))).toBe("material");
    expect(dominantCostType(makeSplit({}))).toBe("other");
    // a tie resolves to the earlier key in RATE_KEYS order, every time
    expect(dominantCostType(makeSplit({ labour: 7, material: 7 }))).toBe("labour");
  });
});

describe("crews and production rates (#194, #197)", () => {
  it("sums a crew composition into an hourly cost", () => {
    const cost = crewCost(
      [
        { trade: "bricklayer", count: 2, hourlyRate: 32 },
        { trade: "labourer", count: 1, hourlyRate: 21 },
      ],
      [{ description: "mixer", count: 1, hourlyRate: 6.5 }],
    );
    expect(cost.labourHourlyCost).toBe(85);
    expect(cost.equipmentHourlyCost).toBe(6.5);
    expect(cost.hourlyCost).toBe(91.5);
    expect(cost.headcount).toBe(3);
  });

  it("ignores negative counts and rates", () => {
    const cost = crewCost([{ trade: "x", count: -3, hourlyRate: 50 }], null);
    expect(cost.hourlyCost).toBe(0);
    expect(cost.headcount).toBe(0);
  });

  it("normalises both production-rate directions", () => {
    expect(hoursPerUnit(4, "output_per_hour")).toBe(0.25);
    expect(hoursPerUnit(0.25, "hours_per_unit")).toBe(0.25);
    expect(hoursPerUnit(0, "output_per_hour")).toBeNull();
    expect(hoursPerUnit(null, "hours_per_unit")).toBeNull();
  });

  it("builds a labour rate from crew × hours per unit", () => {
    const crew = crewCost([{ trade: "b", count: 2, hourlyRate: 30 }], [{ description: "m", count: 1, hourlyRate: 10 }]);
    const built = buildLabourRate({ crew, productionRate: 4, productionRateBasis: "output_per_hour" });
    expect(built.hoursPerUnit).toBe(0.25);
    expect(built.labourRate).toBe(15);
    expect(built.equipmentRate).toBe(2.5);
    expect(built.reason).toContain("crew-hours per unit");
  });

  it("states the gap rather than pricing at zero when an input is missing", () => {
    expect(buildLabourRate({ crew: null, productionRate: 4, productionRateBasis: "output_per_hour" }).reason).toMatch(/No crew/);
    const crew = crewCost([{ trade: "b", count: 1, hourlyRate: 30 }], null);
    expect(buildLabourRate({ crew, productionRate: null, productionRateBasis: null }).reason).toMatch(/No usable production rate/);
  });
});

describe("priceLine (#190)", () => {
  it("extends quantity × rate by cost type", () => {
    const priced = priceLine({
      baseQuantity: 100,
      rates: { labour: 12.5, material: 30 },
    });
    expect(priced.quantity).toBe(100);
    expect(priced.unitRate).toBe(42.5);
    expect(priced.amounts.labour).toBe(1250);
    expect(priced.amounts.material).toBe(3000);
    expect(priced.amount).toBe(4250);
  });

  it("applies waste to the measured quantity and shows both", () => {
    const priced = priceLine({ baseQuantity: 412, wastePercent: 6, rates: { material: 10 } });
    expect(priced.quantity).toBe(436.72);
    expect(priced.amount).toBe(4367.2);
    expect(priced.basis[0]).toContain("6% waste");
  });

  it("fills the labour rate from a crew build-up and counts the hours", () => {
    const crew = crewCost([{ trade: "b", count: 2, hourlyRate: 30 }], null);
    const priced = priceLine({
      baseQuantity: 200,
      rates: { material: 8 },
      crew,
      productionRate: 5,
      productionRateBasis: "output_per_hour",
    });
    expect(priced.rates.labour).toBe(12); // 0.2 h/unit × 60/h
    expect(priced.labourHours).toBe(40);
    expect(priced.amount).toBe(4000);
  });

  it("lets an explicit labour rate override the crew build-up", () => {
    const crew = crewCost([{ trade: "b", count: 2, hourlyRate: 30 }], null);
    const priced = priceLine({
      baseQuantity: 10,
      rates: { labour: 99 },
      crew,
      productionRate: 5,
      productionRateBasis: "output_per_hour",
    });
    expect(priced.rates.labour).toBe(99);
    expect(priced.labourHours).toBe(2);
  });

  it("counts no labour hours when there is no production rate", () => {
    const priced = priceLine({ baseQuantity: 10, rates: { labour: 5 } });
    expect(priced.labourHours).toBe(0);
  });
});

describe("assemblies (#191, #193)", () => {
  const components = [
    { description: "Blocks", unit: "no", costType: "material", quantityPer: 10, wastePercent: 5, rates: { material: 1.2 } },
    { description: "Mortar", unit: "m3", costType: "material", quantityPer: 0.02, rates: { material: 150 } },
    { description: "Bricklaying gang", unit: "hr", costType: "labour", quantityPer: 0.4, rates: { labour: 60 } },
  ];

  it("prices one assembly unit from its components", () => {
    const pricing = assemblyUnitRate(components);
    expect(pricing.rates.material).toBeCloseTo(10 * 1.05 * 1.2 + 0.02 * 150, 4);
    expect(pricing.rates.labour).toBeCloseTo(24, 4);
    expect(pricing.unitRate).toBeCloseTo(12.6 + 3 + 24, 4);
    expect(pricing.componentCount).toBe(3);
  });

  it("expands an assembly onto lines at the right quantities", () => {
    const lines = expandAssembly(components, 50);
    expect(lines).toHaveLength(3);
    const blocks = lines[0];
    expect(blocks?.baseQuantity).toBe(500);
    expect(blocks?.priced.quantity).toBe(525); // 5% waste
    expect(blocks?.priced.amount).toBe(630);
    const labour = lines[2];
    expect(labour?.costType).toBe("labour");
    expect(labour?.priced.amount).toBe(1200);
  });

  it("derives a cost type from the dominant rate when none is declared", () => {
    const lines = expandAssembly(
      [{ description: "Kit", quantityPer: 1, rates: { equipment: 40, material: 5 } }],
      1,
    );
    expect(lines[0]?.costType).toBe("equipment");
  });
});

describe("roll-up", () => {
  it("counts active and provisional lines, and holds the rest apart", () => {
    const rollup = rollUpLines([
      line({ amount: 100, materialAmount: 100 }),
      line({ status: "provisional", amount: 50, materialAmount: 50 }),
      line({ status: "alternate", amount: 400, materialAmount: 400 }),
      line({ status: "excluded", amount: 900, materialAmount: 900 }),
    ]);
    expect(rollup.directCostTotal).toBe(150);
    expect(rollup.materialTotal).toBe(150);
    expect(rollup.alternateTotal).toBe(400);
    expect(rollup.excludedTotal).toBe(900);
    expect(rollup.lineCount).toBe(4);
  });

  it("buckets by cost type and by section", () => {
    const rollup = rollUpLines([
      line({ costType: "labour", sectionId: "s1", amount: 200, labourAmount: 200, materialAmount: 0, labourHours: 10 }),
      line({ costType: "material", sectionId: "s1", amount: 300, materialAmount: 300 }),
      line({ costType: "material", sectionId: null, amount: 100, materialAmount: 100 }),
    ]);
    expect(rollup.byCostType["labour"]).toBe(200);
    expect(rollup.byCostType["material"]).toBe(400);
    expect(rollup.bySection["s1"]).toBe(500);
    expect(rollup.bySection[""]).toBe(100);
    expect(rollup.labourHours).toBe(10);
  });
});

describe("markup cascade (#198–199)", () => {
  const rollup = rollUpLines([
    line({ costType: "labour", amount: 400, labourAmount: 400, materialAmount: 0, sectionId: "s1" }),
    line({ costType: "subcontract", amount: 600, subcontractAmount: 600, materialAmount: 0, sectionId: "s2" }),
  ]);

  const markup = (over: Partial<MarkupSpec>): MarkupSpec => ({
    id: "m1",
    sequence: 1,
    kind: "overhead",
    name: "Overhead",
    method: "percent",
    basis: "direct_cost",
    rate: 10,
    ...over,
  });

  it("applies a percentage of direct cost", () => {
    const res = applyMarkups([markup({})], rollup);
    expect(res.markupTotal).toBe(100);
    expect(res.total).toBe(1100);
    expect(res.markups[0]?.explanation).toContain("10% of 1000");
  });

  it("compounds a running-total markup on top of the earlier tier", () => {
    const res = applyMarkups(
      [
        markup({ id: "a", sequence: 1, rate: 10, basis: "direct_cost", name: "OH" }),
        markup({ id: "b", sequence: 2, kind: "profit", name: "Profit", rate: 5, basis: "running_total" }),
      ],
      rollup,
    );
    expect(res.markups[1]?.baseAmount).toBe(1100);
    expect(res.markups[1]?.amount).toBe(55);
    expect(res.total).toBe(1155);
  });

  it("narrows a tiered markup to selected cost types (#199)", () => {
    const res = applyMarkups(
      [markup({ basis: "cost_type", costTypes: ["subcontract"], rate: 5, name: "Sub margin" })],
      rollup,
    );
    expect(res.markups[0]?.baseAmount).toBe(600);
    expect(res.markups[0]?.amount).toBe(30);
  });

  it("warns and widens when a cost-type markup names no cost type", () => {
    const res = applyMarkups([markup({ basis: "cost_type", costTypes: [] })], rollup);
    expect(res.markups[0]?.baseAmount).toBe(1000);
    expect(res.warnings.join(" ")).toMatch(/no cost type selected/);
  });

  it("narrows to sections when the basis is sectionable", () => {
    const res = applyMarkups([markup({ basis: "direct_cost", sectionIds: ["s2"], rate: 10 })], rollup);
    expect(res.markups[0]?.baseAmount).toBe(600);
  });

  it("refuses to section a running-total markup and says why", () => {
    const res = applyMarkups(
      [markup({ basis: "running_total", sectionIds: ["s2"], rate: 10 })],
      rollup,
    );
    expect(res.markups[0]?.baseAmount).toBe(1000);
    expect(res.warnings.join(" ")).toMatch(/not sectioned/);
  });

  it("supports fixed and per-unit markups", () => {
    const res = applyMarkups(
      [
        markup({ id: "f", method: "fixed", rate: 250, name: "Bond", kind: "bond" }),
        markup({ id: "u", sequence: 2, method: "per_unit", rate: 12, quantity: 100, name: "Prelims", kind: "general_conditions" }),
      ],
      rollup,
    );
    expect(res.markups[0]?.amount).toBe(250);
    expect(res.markups[1]?.amount).toBe(1200);
    expect(res.markupTotal).toBe(1450);
  });

  it("warns about a per-unit markup with no quantity", () => {
    const res = applyMarkups([markup({ method: "per_unit", rate: 12, quantity: 0 })], rollup);
    expect(res.markups[0]?.amount).toBe(0);
    expect(res.warnings.join(" ")).toMatch(/no quantity/);
  });

  it("skips disabled markups", () => {
    const res = applyMarkups([markup({ enabled: false })], rollup);
    expect(res.markups).toHaveLength(0);
    expect(res.total).toBe(1000);
  });

  it("orders equal sequences by id so the result is deterministic", () => {
    const forwards = applyMarkups(
      [
        markup({ id: "b", sequence: 1, rate: 10, basis: "running_total" }),
        markup({ id: "a", sequence: 1, rate: 20, basis: "running_total" }),
      ],
      rollup,
    );
    const backwards = applyMarkups(
      [
        markup({ id: "a", sequence: 1, rate: 20, basis: "running_total" }),
        markup({ id: "b", sequence: 1, rate: 10, basis: "running_total" }),
      ],
      rollup,
    );
    expect(forwards.total).toBe(backwards.total);
    expect(forwards.markups[0]?.id).toBe("a");
  });

  it("assembles the whole header through estimateTotals", () => {
    const totals = estimateTotals(
      [line({ costType: "labour", amount: 1000, labourAmount: 1000, materialAmount: 0 })],
      [markup({ rate: 15 })],
    );
    expect(totals.directCostTotal).toBe(1000);
    expect(totals.markupTotal).toBe(150);
    expect(totals.total).toBe(1150);
    expect(totals.appliedMarkups).toHaveLength(1);
  });
});
