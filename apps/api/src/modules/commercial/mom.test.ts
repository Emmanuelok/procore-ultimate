import { describe, expect, it } from "vitest";
import { measurementStandards, validateBoq, type MomItemInput } from "./mom.js";

function item(over: Partial<MomItemInput> = {}): MomItemInput {
  return {
    id: over.id ?? "i1",
    parentId: over.parentId ?? "s1",
    level: over.level ?? "item",
    code: over.code ?? "5.2.1",
    description: over.description ?? "Excavating trenches width not exceeding 2m, depth 1-2m",
    unit: over.unit ?? "m3",
    quantity: over.quantity ?? 120,
    rate: over.rate ?? 32,
    amount: over.amount ?? 3840,
    itemType: over.itemType ?? "measured",
    ...over,
  };
}

const bill = (id = "b1"): MomItemInput => ({
  id,
  parentId: null,
  level: "bill",
  code: "5",
  description: "Bill 5 — Substructure",
  unit: null,
  quantity: null,
  rate: null,
  amount: null,
  itemType: "measured",
});

const section = (id = "s1", parentId = "b1"): MomItemInput => ({
  id,
  parentId,
  level: "section",
  code: "5.2",
  description: "Excavation and earthworks",
  unit: null,
  quantity: null,
  rate: null,
  amount: null,
  itemType: "measured",
});

describe("method-of-measurement engine", () => {
  it("passes a well-formed NRM2 bill with no errors", () => {
    const report = validateBoq("nrm2", [bill(), section(), item()]);
    expect(report.supported).toBe(true);
    expect(report.counts.error).toBe(0);
    expect(report.itemsChecked).toBe(1);
    expect(report.complianceScore).toBeGreaterThan(70);
  });

  it("flags an unrecognised unit as an error and cites the standard", () => {
    const report = validateBoq("nrm2", [bill(), section(), item({ unit: "cubits" })]);
    const finding = report.findings.find((f) => f.ruleId === "unit.not_recognised");
    expect(finding?.severity).toBe("error");
    expect(finding?.reference).toContain("NRM2");
  });

  it("requires a quantity for a measured item but not for a lump item", () => {
    const measured = validateBoq("nrm2", [
      bill(),
      section(),
      item({ quantity: null, amount: null }),
    ]);
    expect(measured.findings.some((f) => f.ruleId === "quantity.missing")).toBe(true);

    const lump = validateBoq("nrm2", [
      bill(),
      section(),
      item({ unit: "item", quantity: null, rate: 5000, amount: null }),
    ]);
    expect(lump.findings.some((f) => f.ruleId === "quantity.missing")).toBe(false);
  });

  it("rejects a negative quantity and a non-reconciling extension", () => {
    const report = validateBoq("nrm2", [
      bill(),
      section(),
      item({ quantity: -5, amount: -160 }),
      item({ id: "i2", code: "5.2.2", quantity: 10, rate: 10, amount: 999 }),
    ]);
    expect(report.findings.some((f) => f.ruleId === "quantity.negative")).toBe(true);
    const ext = report.findings.find((f) => f.ruleId === "quantity.extension");
    expect(ext?.severity).toBe("error");
    expect(ext?.message).toContain("100");
  });

  it("checks CESMM4 class-letter coding and rejects NRM2-style numbering", () => {
    const good = validateBoq("cesmm4", [
      { ...bill(), code: "E" },
      { ...section(), code: "E3" },
      item({ code: "E325", unit: "m3" }),
    ]);
    expect(good.findings.some((f) => f.ruleId === "code.grammar")).toBe(false);

    const bad = validateBoq("cesmm4", [
      { ...bill(), code: "E" },
      { ...section(), code: "E3" },
      item({ code: "5.2.1", unit: "m3" }),
    ]);
    expect(bad.findings.some((f) => f.ruleId === "cesmm4.class_letter")).toBe(true);
  });

  it("detects duplicate item codes and empty bills", () => {
    const report = validateBoq("nrm2", [
      bill(),
      bill("b2"),
      section(),
      item(),
      item({ id: "i2" }),
    ]);
    expect(report.findings.some((f) => f.ruleId === "structure.duplicate_code")).toBe(true);
    expect(report.findings.some((f) => f.ruleId === "structure.empty_bill")).toBe(true);
  });

  it("wants provisional sums to say so, and undefined ones not to be measured", () => {
    const report = validateBoq("nrm2", [
      bill(),
      section(),
      item({
        itemType: "provisional_undefined",
        description: "Allowance for external works to be designed",
        unit: "m2",
        quantity: 300,
        rate: 40,
        amount: 12000,
      }),
    ]);
    expect(report.findings.some((f) => f.ruleId === "item_type.provisional_not_stated")).toBe(true);
    expect(report.findings.some((f) => f.ruleId === "item_type.undefined_measured")).toBe(true);
  });

  it("applies the rounding rule as information, not an error", () => {
    const report = validateBoq("nrm2", [bill(), section(), item({ quantity: 120.437, amount: 3853.98 })]);
    const rounding = report.findings.find((f) => f.ruleId === "quantity.rounding");
    expect(rounding?.severity).toBe("info");
  });

  it("runs structural rules only for a custom bill and says why", () => {
    const report = validateBoq("custom", [bill(), section(), item({ unit: "cubits" })]);
    expect(report.supported).toBe(false);
    expect(report.complianceScore).toBeNull();
    expect(report.notes[0]).toContain("Custom bills");
    expect(report.findings.some((f) => f.ruleId === "unit.not_recognised")).toBe(false);
  });

  it("refuses to place an item under another item", () => {
    const report = validateBoq("nrm2", [
      bill(),
      section(),
      item({ id: "i1" }),
      item({ id: "i2", parentId: "i1", code: "5.2.2" }),
    ]);
    const finding = report.findings.find((f) => f.ruleId === "structure.item_under_item");
    expect(finding?.severity).toBe("error");
  });

  it("publishes a standards reference for the UI", () => {
    const standards = measurementStandards();
    expect(standards.map((s) => s.method).sort()).toEqual(["cesmm4", "nrm2", "pomi", "smm7"]);
    expect(standards.every((s) => s.units.length > 0 && s.reference.length > 0)).toBe(true);
  });
});
