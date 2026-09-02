import { describe, expect, it } from "vitest";
import { planBudgetLines, type ConvertibleLine } from "./budgetize.js";
import type { AppliedMarkup } from "./pricing.js";

/** Estimate → budget conversion (spec Vol I #204). */

const line = (over: Partial<ConvertibleLine> & { id: string }): ConvertibleLine => ({
  description: "Blockwork",
  costCode: "04-2000",
  costCodeId: "cc_1",
  costType: "material",
  status: "active",
  unit: "m2",
  quantity: 100,
  unitRate: 50,
  amount: 5000,
  labourAmount: 0,
  materialAmount: 5000,
  equipmentAmount: 0,
  subcontractAmount: 0,
  otherAmount: 0,
  ...over,
});

const markup = (over: Partial<AppliedMarkup> = {}): AppliedMarkup => ({
  id: "m1",
  sequence: 1,
  kind: "overhead",
  name: "Overhead",
  method: "percent",
  basis: "direct_cost",
  rate: 10,
  baseAmount: 5000,
  amount: 500,
  explanation: "10% of 5000",
  ...over,
});

describe("planBudgetLines", () => {
  it("maps one estimate line onto one budget line", () => {
    const plan = planBudgetLines({ lines: [line({ id: "a" })], markups: [] });
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]).toMatchObject({
      costCode: "04-2000",
      costCodeId: "cc_1",
      costType: "material",
      unit: "m2",
      quantity: 100,
      unitRate: 50,
      originalBudget: 5000,
    });
    expect(plan.total).toBe(5000);
  });

  it("merges lines that collide on cost code and cost type", () => {
    const plan = planBudgetLines({
      lines: [
        line({ id: "a", quantity: 100, amount: 5000 }),
        line({ id: "b", description: "Blockwork upper", quantity: 60, amount: 3000 }),
      ],
      markups: [],
    });
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]?.quantity).toBe(160);
    expect(plan.lines[0]?.originalBudget).toBe(8000);
    expect(plan.lines[0]?.unitRate).toBe(50);
    expect(plan.lines[0]?.description).toContain("+1 more");
    expect(plan.lines[0]?.sourceLineIds).toEqual(["a", "b"]);
    expect(plan.mergedGroupCount).toBe(1);
    expect(plan.warnings.join(" ")).toMatch(/merges several estimate lines/);
  });

  it("keeps the amount and drops the rate when merged units disagree", () => {
    const plan = planBudgetLines({
      lines: [
        line({ id: "a", unit: "m2", amount: 5000 }),
        line({ id: "b", unit: "m3", amount: 3000 }),
      ],
      markups: [],
    });
    expect(plan.lines[0]?.unit).toBeNull();
    expect(plan.lines[0]?.quantity).toBeNull();
    expect(plan.lines[0]?.unitRate).toBeNull();
    expect(plan.lines[0]?.originalBudget).toBe(8000);
  });

  it("keeps different cost types apart on the same code", () => {
    const plan = planBudgetLines({
      lines: [
        line({ id: "a", costType: "material", amount: 5000 }),
        line({ id: "b", costType: "labour", amount: 2000 }),
      ],
      markups: [],
    });
    expect(plan.lines).toHaveLength(2);
  });

  it("collects uncoded lines on a named holding code and warns", () => {
    const plan = planBudgetLines({
      lines: [line({ id: "a", costCode: null, costCodeId: null, amount: 900 })],
      markups: [],
      uncodedCostCode: "ZZ-TBC",
    });
    expect(plan.lines[0]?.costCode).toBe("ZZ-TBC");
    expect(plan.lines[0]?.costCodeId).toBeNull();
    expect(plan.uncodedLineCount).toBe(1);
    expect(plan.warnings.join(" ")).toMatch(/holding code "ZZ-TBC"/);
  });

  it("leaves alternates and exclusions out unless asked", () => {
    const plan = planBudgetLines({
      lines: [
        line({ id: "a", amount: 5000 }),
        line({ id: "b", status: "alternate", amount: 900, costCode: "05-1000" }),
        line({ id: "c", status: "excluded", amount: 400, costCode: "06-1000" }),
      ],
      markups: [],
    });
    expect(plan.lines).toHaveLength(1);
    expect(plan.warnings.join(" ")).toMatch(/2 lines outside the estimate total/);

    const withAlts = planBudgetLines({
      lines: [
        line({ id: "a", amount: 5000 }),
        line({ id: "b", status: "alternate", amount: 900, costCode: "05-1000" }),
      ],
      markups: [],
      includeAlternates: true,
    });
    expect(withAlts.lines).toHaveLength(2);
  });

  it("gives each markup kind its own budget line by default", () => {
    const plan = planBudgetLines({
      lines: [line({ id: "a" })],
      markups: [
        markup({ id: "m1", kind: "overhead", amount: 500 }),
        markup({ id: "m2", kind: "profit", name: "Profit", amount: 275 }),
        markup({ id: "m3", kind: "contingency", name: "Contingency", amount: 300 }),
      ],
      markupCostCodePrefix: "99",
    });
    const codes = plan.lines.map((l) => l.costCode);
    expect(codes).toContain("99-OVERHEAD");
    expect(codes).toContain("99-PROFIT");
    expect(codes).toContain("99-CONTINGENCY");
    const contingency = plan.lines.find((l) => l.costCode === "99-CONTINGENCY");
    expect(contingency?.lineKind).toBe("contingency");
    expect(plan.total).toBe(6075);
    expect(plan.warnings.join(" ")).toMatch(/not in the company cost-code list/);
  });

  it("folds several markups of one kind onto a single line", () => {
    const plan = planBudgetLines({
      lines: [line({ id: "a" })],
      markups: [
        markup({ id: "m1", kind: "overhead", name: "Head office", amount: 300 }),
        markup({ id: "m2", kind: "overhead", name: "Site overhead", amount: 200 }),
      ],
    });
    const oh = plan.lines.find((l) => l.costCode === "MARKUP-OVERHEAD");
    expect(oh?.originalBudget).toBe(500);
    expect(oh?.sourceMarkupIds).toEqual(["m1", "m2"]);
  });

  it("spreads markups pro rata when asked, and reconciles to the cent", () => {
    const plan = planBudgetLines({
      lines: [
        line({ id: "a", amount: 3000, quantity: 60 }),
        line({ id: "b", costCode: "05-1000", amount: 7000, quantity: 140 }),
      ],
      markups: [markup({ amount: 1000 })],
      markupTreatment: "prorate",
    });
    expect(plan.lines).toHaveLength(2);
    expect(plan.total).toBe(11000);
    expect(plan.lines[0]?.originalBudget).toBe(3300);
    expect(plan.lines[1]?.originalBudget).toBe(7700);
    expect(plan.warnings.join(" ")).toMatch(/spread across the budget lines/);
  });

  it("refuses to spread markups over a zero direct cost", () => {
    const plan = planBudgetLines({
      lines: [line({ id: "a", amount: 0, quantity: 0 })],
      markups: [markup({ amount: 500 })],
      markupTreatment: "prorate",
    });
    expect(plan.total).toBe(0);
    expect(plan.warnings.join(" ")).toMatch(/could not be spread pro rata/);
  });

  it("says out loud how big the gap is when markups are excluded", () => {
    const plan = planBudgetLines({
      lines: [line({ id: "a" })],
      markups: [markup({ amount: 500 })],
      markupTreatment: "exclude",
    });
    expect(plan.total).toBe(5000);
    expect(plan.markupTotal).toBe(500);
    expect(plan.warnings.join(" ")).toMatch(/has to be funded somewhere/);
  });
});
