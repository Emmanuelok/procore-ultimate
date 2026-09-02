import { describe, expect, it } from "vitest";
import type { FormFieldDef } from "@constructos/shared";
import {
  evaluateCondition,
  evaluateRule,
  reconcilePdfMapping,
  resolveVisibility,
  validateResponse,
  validateTemplate,
} from "./forms.js";

const field = (over: Partial<FormFieldDef> & { key: string }): FormFieldDef => ({
  label: over.key,
  type: "text",
  ...over,
});

describe("evaluateCondition", () => {
  const values = { grade: "high", count: 5, done: true, tags: ["a", "b"], blank: "" };

  it("compares equality across wire shapes", () => {
    expect(evaluateCondition({ field: "count", operator: "eq", value: "5" }, values)).toBe(true);
    expect(evaluateCondition({ field: "done", operator: "eq", value: "true" }, values)).toBe(true);
    expect(evaluateCondition({ field: "grade", operator: "ne", value: "low" }, values)).toBe(true);
  });

  it("orders numbers and refuses to order non-numbers", () => {
    expect(evaluateCondition({ field: "count", operator: "gt", value: 4 }, values)).toBe(true);
    expect(evaluateCondition({ field: "count", operator: "lte", value: 5 }, values)).toBe(true);
    expect(evaluateCondition({ field: "grade", operator: "gt", value: 1 }, values)).toBe(false);
  });

  it("handles membership on scalars and lists", () => {
    expect(evaluateCondition({ field: "grade", operator: "in", value: ["high", "low"] }, values)).toBe(true);
    expect(evaluateCondition({ field: "tags", operator: "in", value: ["b"] }, values)).toBe(true);
    expect(evaluateCondition({ field: "tags", operator: "not_in", value: ["z"] }, values)).toBe(true);
    expect(evaluateCondition({ field: "tags", operator: "contains", value: "a" }, values)).toBe(true);
    expect(evaluateCondition({ field: "grade", operator: "contains", value: "IG" }, values)).toBe(true);
  });

  it("treats blank strings, empty lists and absent keys as empty", () => {
    expect(evaluateCondition({ field: "blank", operator: "empty" }, values)).toBe(true);
    expect(evaluateCondition({ field: "missing", operator: "empty" }, values)).toBe(true);
    expect(evaluateCondition({ field: "grade", operator: "not_empty" }, values)).toBe(true);
  });
});

describe("evaluateRule", () => {
  it("requires every all-condition and at least one any-condition", () => {
    const values = { a: 1, b: 2 };
    expect(evaluateRule({ all: [{ field: "a", operator: "eq", value: 1 }] }, values)).toBe(true);
    expect(
      evaluateRule(
        { all: [{ field: "a", operator: "eq", value: 1 }], any: [{ field: "b", operator: "eq", value: 9 }] },
        values,
      ),
    ).toBe(false);
    expect(evaluateRule({}, values)).toBe(true);
  });
});

describe("resolveVisibility", () => {
  const fields = [
    field({ key: "hasDefect", type: "checkbox" }),
    field({ key: "defectKind", type: "select", options: [{ value: "crack", label: "Crack" }], visibleWhen: { all: [{ field: "hasDefect", operator: "eq", value: true }] } }),
    field({ key: "crackWidth", type: "number", visibleWhen: { all: [{ field: "defectKind", operator: "eq", value: "crack" }] } }),
  ];

  it("hides dependent fields until their controller answers", () => {
    const r = resolveVisibility(fields, {});
    expect(r.visible).toEqual(["hasDefect"]);
    expect(r.hidden).toEqual(["defectKind", "crackWidth"]);
  });

  it("reveals the chain one step at a time", () => {
    expect(resolveVisibility(fields, { hasDefect: true }).visible).toEqual(["hasDefect", "defectKind"]);
    expect(resolveVisibility(fields, { hasDefect: true, defectKind: "crack" }).visible).toEqual([
      "hasDefect",
      "defectKind",
      "crackWidth",
    ]);
  });

  it("hides a field whose controller is itself hidden, even when its own condition passes", () => {
    // defectKind is hidden (hasDefect false) so crackWidth must be hidden too.
    const r = resolveVisibility(fields, { hasDefect: false, defectKind: "crack" });
    expect(r.hidden).toContain("crackWidth");
  });

  it("reports a dangling controller as a template defect and keeps the field visible", () => {
    const r = resolveVisibility([field({ key: "a", visibleWhen: { all: [{ field: "ghost", operator: "eq", value: 1 }] } })], {});
    expect(r.defects[0]).toContain("ghost");
  });

  it("reports a cycle instead of looping forever", () => {
    const cyclic = [
      field({ key: "a", visibleWhen: { all: [{ field: "b", operator: "not_empty" }] } }),
      field({ key: "b", visibleWhen: { all: [{ field: "a", operator: "not_empty" }] } }),
    ];
    const r = resolveVisibility(cyclic, { a: "x", b: "y" });
    expect(r.defects.some((d) => d.includes("cycle"))).toBe(true);
    expect(r.visible).toEqual(["a", "b"]);
  });

  it("applies template-level logic on top of the field's own rule", () => {
    const r = resolveVisibility([field({ key: "a" })], { gate: "no" }, { a: { all: [{ field: "a", operator: "eq", value: "x" }] } });
    expect(r.hidden).toEqual(["a"]);
  });
});

describe("validateTemplate", () => {
  it("accepts a well-formed template", () => {
    expect(
      validateTemplate([
        field({ key: "site", label: "Site" }),
        field({ key: "grade", label: "Grade", type: "select", options: [{ value: "a", label: "A" }] }),
      ]),
    ).toEqual([]);
  });

  it("rejects duplicate keys, bad keys, optionless selects and required headings", () => {
    const problems = validateTemplate([
      field({ key: "ok", label: "Ok" }),
      field({ key: "ok", label: "Again" }),
      field({ key: "9bad", label: "Bad" }),
      field({ key: "sel", label: "Sel", type: "select" }),
      field({ key: "head", label: "H", type: "heading", required: true }),
      field({ key: "num", label: "N", type: "number", min: 10, max: 1 }),
    ]);
    expect(problems.some((p) => p.includes("used more than once"))).toBe(true);
    expect(problems.some((p) => p.includes('"9bad"'))).toBe(true);
    expect(problems.some((p) => p.includes("no options"))).toBe(true);
    expect(problems.some((p) => p.includes("cannot be required"))).toBe(true);
    expect(problems.some((p) => p.includes("minimum above its maximum"))).toBe(true);
  });

  it("rejects an empty template and logic aimed at a field that does not exist", () => {
    expect(validateTemplate([])[0]).toContain("at least one field");
    const problems = validateTemplate([field({ key: "a" })], { ghost: { all: [{ field: "a", operator: "eq", value: 1 }] } });
    expect(problems.some((p) => p.includes("ghost"))).toBe(true);
  });
});

describe("validateResponse", () => {
  const fields = [
    field({ key: "title", label: "Title", required: true }),
    field({ key: "score", label: "Score", type: "number", min: 0, max: 10 }),
    field({ key: "when", label: "When", type: "date" }),
    field({ key: "at", label: "At", type: "time" }),
    field({ key: "grade", label: "Grade", type: "select", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }),
    field({ key: "trades", label: "Trades", type: "multiselect", options: [{ value: "m", label: "M" }, { value: "e", label: "E" }] }),
    field({ key: "safe", label: "Safe", type: "checkbox" }),
    field({ key: "why", label: "Why", type: "textarea", required: true, visibleWhen: { all: [{ field: "safe", operator: "eq", value: false }] } }),
  ];
  const base = { requireComplete: true, signatureRequired: false };

  it("accepts a complete, well-typed response and strips hidden fields", () => {
    const r = validateResponse(
      fields,
      { title: "Weekly walk", score: "8", when: "2026-09-01", at: "07:30", grade: "a", trades: ["m"], safe: true },
      {},
      base,
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.cleaned["score"]).toBe(8);
    expect(r.cleaned["safe"]).toBe(true);
    expect(r.hidden).toEqual(["why"]);
    expect(r.cleaned["why"]).toBeUndefined();
    expect(r.askable).toBe(7);
    expect(r.answered).toBe(7);
  });

  it("requires a hidden-then-revealed field once its branch opens", () => {
    const r = validateResponse(fields, { title: "t", safe: false }, {}, base);
    expect(r.ok).toBe(false);
    expect(r.errors).toContainEqual({ field: "why", message: "is required" });
  });

  it("does not enforce required fields on a draft", () => {
    const r = validateResponse(fields, {}, {}, { ...base, requireComplete: false });
    expect(r.ok).toBe(true);
  });

  it("catches type, range and option errors", () => {
    const r = validateResponse(
      fields,
      { title: "t", score: 99, when: "01/09/2026", at: "25:00", grade: "z", trades: "m", safe: "maybe" },
      {},
      base,
    );
    const byField = Object.fromEntries(r.errors.map((e) => [e.field, e.message]));
    expect(byField["score"]).toContain("at most 10");
    expect(byField["when"]).toContain("YYYY-MM-DD");
    expect(byField["at"]).toContain("HH:MM");
    expect(byField["grade"]).toContain("not one of the offered options");
    expect(byField["trades"]).toContain("must be a list");
    expect(byField["safe"]).toContain("true or false");
  });

  it("rejects values for fields the template does not define", () => {
    const r = validateResponse(fields, { title: "t", ghost: 1, safe: true }, {}, base);
    expect(r.errors).toContainEqual({ field: "ghost", message: "is not a field on this template" });
  });

  it("demands a signature when the template requires one", () => {
    const unsigned = validateResponse(fields, { title: "t", safe: true }, {}, { ...base, signatureRequired: true });
    expect(unsigned.errors).toContainEqual({
      field: "__signature",
      message: "this form must be signed before it is submitted",
    });
    const signed = validateResponse(
      fields,
      { title: "t", safe: true },
      {},
      { ...base, signatureRequired: true, signature: { name: "A Foreman", signedAt: "2026-09-01T00:00:00Z", method: "typed" } },
    );
    expect(signed.ok).toBe(true);
  });

  it("enforces maxLength on text", () => {
    const r = validateResponse([field({ key: "t", maxLength: 3 })], { t: "abcd" }, {}, base);
    expect(r.errors[0]?.message).toContain("at most 3 characters");
  });
});

describe("reconcilePdfMapping", () => {
  const fields = [
    field({ key: "name", pdfField: "topmostSubform[0].Name[0]" }),
    field({ key: "date", type: "date" }),
    field({ key: "section", type: "heading" }),
  ];

  it("merges the stored map with per-field mappings and reports both gaps", () => {
    const r = reconcilePdfMapping(fields, { "Form.Date": "date", "Form.Ghost": "nosuch" });
    expect(r.mapped["Form.Date"]).toBe("date");
    expect(r.mapped["topmostSubform[0].Name[0]"]).toBe("name");
    expect(r.danglingPdfFields).toEqual(["Form.Ghost"]);
    expect(r.unmappedFields).toEqual([]);
  });

  it("lists template fields no acroform field fills, ignoring headings", () => {
    const r = reconcilePdfMapping(fields, {});
    expect(r.unmappedFields).toEqual(["date"]);
  });
});
