import { describe, expect, it } from "vitest";
import { computeHiddenScopes, sheetGrantsStandard, sheetVisible, type SheetRule } from "./permissions.js";

const arch = { id: "s1", discipline: "architectural", area: "Tower A" };
const struct = { id: "s2", discipline: "structural", area: "Tower A" };
const mech = { id: "s3", discipline: "mechanical", area: null };

describe("sheet-level segregation (#265, #282)", () => {
  it("leaves everything visible when no rule exists", () => {
    const hidden = computeHiddenScopes([], { userId: "u1", templateKey: "subcontractor" });
    expect(hidden.anyRules).toBe(false);
    for (const s of [arch, struct, mech]) expect(sheetVisible(s, hidden)).toBe(true);
    expect(sheetGrantsStandard(arch, hidden)).toBe(false);
  });

  it("restricts a discipline to the subjects listed for it", () => {
    const rules: SheetRule[] = [
      { scope: "discipline", scopeValue: "structural", subjectType: "user", subjectId: "u1", level: "read" },
    ];
    const me = computeHiddenScopes(rules, { userId: "u1", templateKey: null });
    const other = computeHiddenScopes(rules, { userId: "u2", templateKey: null });
    expect(sheetVisible(struct, me)).toBe(true);
    expect(sheetVisible(struct, other)).toBe(false);
    // an unrestricted discipline stays open to everyone
    expect(sheetVisible(arch, other)).toBe(true);
  });

  it("matches a template subject for everyone on that template", () => {
    const rules: SheetRule[] = [
      { scope: "area", scopeValue: "Tower A", subjectType: "template", subjectId: "field_engineer", level: "read" },
    ];
    const onTemplate = computeHiddenScopes(rules, { userId: "u9", templateKey: "field_engineer" });
    const offTemplate = computeHiddenScopes(rules, { userId: "u9", templateKey: "subcontractor" });
    const nonMember = computeHiddenScopes(rules, { userId: "u9", templateKey: null });
    expect(sheetVisible(arch, onTemplate)).toBe(true);
    expect(sheetVisible(arch, offTemplate)).toBe(false);
    expect(sheetVisible(arch, nonMember)).toBe(false);
    // a sheet with no area is untouched by an area rule
    expect(sheetVisible(mech, offTemplate)).toBe(true);
  });

  it("composes restrictions as AND: hidden by any scope is hidden", () => {
    const rules: SheetRule[] = [
      { scope: "discipline", scopeValue: "architectural", subjectType: "user", subjectId: "u1", level: "read" },
      { scope: "area", scopeValue: "Tower A", subjectType: "user", subjectId: "u2", level: "read" },
    ];
    const u1 = computeHiddenScopes(rules, { userId: "u1", templateKey: null });
    // u1 may see architectural but not Tower A → arch (architectural + Tower A) is hidden
    expect(sheetVisible(arch, u1)).toBe(false);
    expect(sheetVisible(mech, u1)).toBe(true);
  });

  it("restricts a single sheet by id", () => {
    const rules: SheetRule[] = [
      { scope: "sheet", scopeValue: "s3", subjectType: "user", subjectId: "u1", level: "standard" },
    ];
    const u2 = computeHiddenScopes(rules, { userId: "u2", templateKey: null });
    const u1 = computeHiddenScopes(rules, { userId: "u1", templateKey: null });
    expect(sheetVisible(mech, u2)).toBe(false);
    expect(sheetVisible(mech, u1)).toBe(true);
    expect(sheetGrantsStandard(mech, u1)).toBe(true);
    expect(sheetGrantsStandard(arch, u1)).toBe(false);
  });

  it("takes the highest level any matching rule grants", () => {
    const rules: SheetRule[] = [
      { scope: "discipline", scopeValue: "structural", subjectType: "template", subjectId: "field_engineer", level: "read" },
      { scope: "discipline", scopeValue: "structural", subjectType: "user", subjectId: "u1", level: "standard" },
    ];
    const both = computeHiddenScopes(rules, { userId: "u1", templateKey: "field_engineer" });
    expect(sheetGrantsStandard(struct, both)).toBe(true);
    const templateOnly = computeHiddenScopes(rules, { userId: "u5", templateKey: "field_engineer" });
    expect(sheetVisible(struct, templateOnly)).toBe(true);
    expect(sheetGrantsStandard(struct, templateOnly)).toBe(false);
  });
});
