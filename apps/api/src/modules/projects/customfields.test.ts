import { describe, expect, it } from "vitest";
import {
  missingRequired,
  validateFieldValue,
  validateFieldValues,
  type FieldDefLike,
} from "./customfields.js";

const def = (over: Partial<FieldDefLike>): FieldDefLike => ({
  id: "d1",
  key: "field",
  label: "Field",
  fieldType: "text",
  options: [],
  required: 0,
  ...over,
});

describe("validateFieldValue", () => {
  it("accepts an empty value for an optional field and stores null", () => {
    expect(validateFieldValue(def({}), "")).toEqual({ ok: true, value: null });
    expect(validateFieldValue(def({}), null)).toEqual({ ok: true, value: null });
  });

  it("refuses an empty value for a required field", () => {
    const result = validateFieldValue(def({ required: 1, label: "Trade" }), "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Trade");
  });

  it("coerces a numeric string but refuses a non-number", () => {
    expect(validateFieldValue(def({ fieldType: "number" }), "42")).toEqual({ ok: true, value: 42 });
    expect(validateFieldValue(def({ fieldType: "number" }), "banana").ok).toBe(false);
  });

  it("requires an ISO date and refuses an impossible one", () => {
    expect(validateFieldValue(def({ fieldType: "date" }), "2026-03-01")).toEqual({
      ok: true,
      value: "2026-03-01",
    });
    expect(validateFieldValue(def({ fieldType: "date" }), "01/03/2026").ok).toBe(false);
    expect(validateFieldValue(def({ fieldType: "date" }), "2026-13-45").ok).toBe(false);
  });

  it("refuses a dropdown value outside its options — the bug this exists for", () => {
    const dropdown = def({ fieldType: "dropdown", options: ["A", "B"], label: "Zone" });
    expect(validateFieldValue(dropdown, "A")).toEqual({ ok: true, value: "A" });
    const bad = validateFieldValue(dropdown, "Z");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("Zone");
  });

  it("refuses a multi_select containing an unknown option and de-duplicates the rest", () => {
    const multi = def({ fieldType: "multi_select", options: ["A", "B"] });
    expect(validateFieldValue(multi, ["A", "A", "B"])).toEqual({ ok: true, value: ["A", "B"] });
    expect(validateFieldValue(multi, ["A", "Z"]).ok).toBe(false);
    expect(validateFieldValue(multi, "A").ok).toBe(false);
  });

  it("accepts a checkbox as a boolean or its string form", () => {
    const check = def({ fieldType: "checkbox" });
    expect(validateFieldValue(check, true)).toEqual({ ok: true, value: true });
    expect(validateFieldValue(check, "false")).toEqual({ ok: true, value: false });
    expect(validateFieldValue(check, 1).ok).toBe(false);
  });

  it("insists that money carries its currency", () => {
    const money = def({ fieldType: "currency", label: "Value" });
    expect(validateFieldValue(money, { amount: 100, currency: "GBP" })).toEqual({
      ok: true,
      value: { amount: 100, currency: "GBP" },
    });
    expect(validateFieldValue(money, 100).ok).toBe(false);
    expect(validateFieldValue(money, { amount: 100 }).ok).toBe(false);
    expect(validateFieldValue(money, { amount: 100, currency: "pounds" }).ok).toBe(false);
  });

  it("requires a lookup to name a record type and id", () => {
    const lookup = def({ fieldType: "lookup" });
    expect(validateFieldValue(lookup, { type: "rfi", id: "r1" })).toEqual({
      ok: true,
      value: { type: "rfi", id: "r1" },
    });
    expect(validateFieldValue(lookup, { type: "rfi" }).ok).toBe(false);
  });

  it("refuses an unknown field type rather than storing it blind", () => {
    expect(validateFieldValue(def({ fieldType: "quantum" }), "x").ok).toBe(false);
  });
});

describe("validateFieldValues", () => {
  it("collects every error rather than stopping at the first", () => {
    const defs = [
      def({ id: "a", key: "a", fieldType: "number" }),
      def({ id: "b", key: "b", fieldType: "dropdown", options: ["X"] }),
    ];
    const report = validateFieldValues(defs, { a: "no", b: "Y" });
    expect(report.errors.map((e) => e.key)).toEqual(["a", "b"]);
    expect(report.values).toEqual({});
  });

  it("flags an unknown definition id", () => {
    const report = validateFieldValues([def({ id: "a" })], { zzz: "x" });
    expect(report.errors[0]!.reason).toBe("Unknown field definition");
  });

  it("returns coerced values for the fields that passed", () => {
    const report = validateFieldValues([def({ id: "a", fieldType: "number" })], { a: "7" });
    expect(report.errors).toHaveLength(0);
    expect(report.values).toEqual({ a: 7 });
  });
});

describe("missingRequired", () => {
  const defs = [def({ id: "a", required: 1, label: "A" }), def({ id: "b", required: 0 })];

  it("names a required field the payload clears and nothing else stores", () => {
    expect(missingRequired(defs, { a: "" }, new Set()).map((d) => d.id)).toEqual(["a"]);
  });

  it("accepts a required field that is already stored and not being cleared", () => {
    expect(missingRequired(defs, { b: "x" }, new Set(["a"]))).toEqual([]);
  });
});
