import { describe, expect, it } from "vitest";
import {
  evaluateAnswerItem,
  evaluateNumeric,
  scoreChecklist,
  toleranceBounds,
  validateAnswer,
  validateItemDefinition,
  type ChecklistItemSpec,
} from "./checklistItems.js";

/** A template item with sane defaults; override what the test is about. */
const item = (over: Partial<ChecklistItemSpec> = {}): ChecklistItemSpec => ({
  id: "i1",
  itemNumber: "1.1",
  text: "Item",
  itemType: "pass_fail",
  required: true,
  options: [],
  targetValue: null,
  minValue: null,
  maxValue: null,
  tolerancePlus: null,
  toleranceMinus: null,
  unit: null,
  weight: 1,
  isCritical: false,
  photoRequired: false,
  raisesNcrOnFail: false,
  ...over,
});

/* ------------------------------------------------------------------ */
/* Tolerance arithmetic                                                */
/* ------------------------------------------------------------------ */

describe("toleranceBounds", () => {
  it("derives a window from a target and a symmetric tolerance", () => {
    const bounds = toleranceBounds(
      item({ itemType: "measurement", targetValue: 100, tolerancePlus: 2, toleranceMinus: 2 }),
    );
    expect(bounds.lower).toBe(98);
    expect(bounds.upper).toBe(102);
    expect(bounds.reasons).toEqual([]);
  });

  it("treats a negative toleranceMinus as a magnitude below target", () => {
    const bounds = toleranceBounds(
      item({ itemType: "measurement", targetValue: 100, tolerancePlus: 5, toleranceMinus: -3 }),
    );
    expect(bounds.lower).toBe(97);
    expect(bounds.upper).toBe(105);
  });

  it("takes the TIGHTER of an explicit min/max and a target tolerance", () => {
    // spec says 20-30, and the drawing says 25 ±2 — 23..27 is the real window
    const bounds = toleranceBounds(
      item({
        itemType: "measurement",
        minValue: 20,
        maxValue: 30,
        targetValue: 25,
        tolerancePlus: 2,
        toleranceMinus: 2,
      }),
    );
    expect(bounds.lower).toBe(23);
    expect(bounds.upper).toBe(27);
  });

  it("refuses to invent a window from a target with no tolerance", () => {
    const bounds = toleranceBounds(item({ itemType: "measurement", targetValue: 100 }));
    expect(bounds.lower).toBeNull();
    expect(bounds.upper).toBeNull();
    expect(bounds.reasons.join(" ")).toContain("neither a tolerance nor a min/max");
  });

  it("flags contradictory bounds rather than silently picking one", () => {
    const bounds = toleranceBounds(item({ itemType: "measurement", minValue: 50, maxValue: 10 }));
    expect(bounds.reasons.join(" ")).toContain("contradictory");
  });
});

describe("evaluateNumeric — boundaries", () => {
  const measurement = item({
    itemType: "measurement",
    targetValue: 100,
    tolerancePlus: 2,
    toleranceMinus: 2,
    unit: "mm",
  });

  it("passes exactly on the lower bound", () => {
    expect(evaluateNumeric(measurement, 98).isPass).toBe(true);
  });

  it("passes exactly on the upper bound", () => {
    expect(evaluateNumeric(measurement, 102).isPass).toBe(true);
  });

  it("fails just outside either bound", () => {
    expect(evaluateNumeric(measurement, 97.999).isPass).toBe(false);
    expect(evaluateNumeric(measurement, 102.001).isPass).toBe(false);
  });

  it("does not fail a boundary reading to floating-point noise", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754
    const spec = item({ itemType: "measurement", minValue: 0, maxValue: 0.3 });
    expect(evaluateNumeric(spec, 0.1 + 0.2).isPass).toBe(true);
  });

  it("returns null with a reason when no value was recorded", () => {
    const verdict = evaluateNumeric(measurement, null);
    expect(verdict.isPass).toBeNull();
    expect(verdict.reasons.join(" ")).toContain("No numeric value");
  });

  it("returns null rather than a pass when the item carries no bounds", () => {
    const verdict = evaluateNumeric(item({ itemType: "numeric" }), 42);
    expect(verdict.isPass).toBeNull();
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  it("honours a one-sided window", () => {
    const spec = item({ itemType: "instrument_reading", minValue: 1 });
    expect(evaluateNumeric(spec, 1).isPass).toBe(true);
    expect(evaluateNumeric(spec, 0.9).isPass).toBe(false);
    expect(evaluateNumeric(spec, 1e9).isPass).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Answer validation                                                   */
/* ------------------------------------------------------------------ */

describe("validateAnswer", () => {
  it("rejects an unknown token on a pass_fail item", () => {
    const result = validateAnswer(item({ itemType: "pass_fail" }), { response: "maybe" });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("pass / fail");
  });

  it("refuses not-applicable on a pass_fail item that has no NA", () => {
    const result = validateAnswer(item({ itemType: "pass_fail" }), {
      isNotApplicable: true,
      naReason: "not built yet",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("does not permit");
  });

  it("requires a reason with not-applicable on a pass_fail_na item", () => {
    const spec = item({ itemType: "pass_fail_na" });
    expect(validateAnswer(spec, { isNotApplicable: true }).ok).toBe(false);
    expect(validateAnswer(spec, { isNotApplicable: true, naReason: "n/a here" }).ok).toBe(true);
  });

  it("rejects a select answer that is not one of the declared options", () => {
    const spec = item({ itemType: "single_select", options: ["A", "B"] });
    expect(validateAnswer(spec, { response: "C" }).ok).toBe(false);
    expect(validateAnswer(spec, { response: "B" }).ok).toBe(true);
  });

  it("enforces photoRequired alongside an answer", () => {
    const spec = item({ itemType: "pass_fail", photoRequired: true });
    expect(validateAnswer(spec, { response: "pass" }).ok).toBe(false);
    expect(validateAnswer(spec, { response: "pass", photoFileIds: ["f1"] }).ok).toBe(true);
  });
});

describe("validateItemDefinition", () => {
  it("refuses a measurement item that could never be judged", () => {
    const result = validateItemDefinition({ itemType: "measurement", targetValue: 100 });
    expect(result.ok).toBe(false);
  });

  it("refuses a select item with no options", () => {
    expect(validateItemDefinition({ itemType: "multi_select", options: [] }).ok).toBe(false);
    expect(validateItemDefinition({ itemType: "multi_select", options: ["x"] }).ok).toBe(true);
  });

  it("refuses a section header that claims to raise an NCR", () => {
    expect(
      validateItemDefinition({ itemType: "section_header", raisesNcrOnFail: true }).ok,
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Whole-checklist scoring                                             */
/* ------------------------------------------------------------------ */

describe("scoreChecklist", () => {
  it("produces no score under the pass_fail method and fails on any failure", () => {
    const result = scoreChecklist(
      [
        { item: item({ id: "a" }), answer: { response: "pass" } },
        { item: item({ id: "b" }), answer: { response: "fail" } },
      ],
      { scoringMethod: "pass_fail", passThreshold: null },
    );
    expect(result.score).toBeNull();
    expect(result.scorePercent).toBeNull();
    expect(result.result).toBe("fail");
    expect(result.failedItemIds).toEqual(["b"]);
    expect(result.reasons.join(" ")).toContain("produces no score");
  });

  it("scores a percentage and compares it to the threshold at the boundary", () => {
    const entries = [
      { item: item({ id: "a" }), answer: { response: "pass" } },
      { item: item({ id: "b" }), answer: { response: "pass" } },
      { item: item({ id: "c" }), answer: { response: "pass" } },
      { item: item({ id: "d" }), answer: { response: "fail" } },
    ];
    const atThreshold = scoreChecklist(entries, { scoringMethod: "percentage", passThreshold: 75 });
    expect(atThreshold.scorePercent).toBe(75);
    expect(atThreshold.result).toBe("pass_with_observations");

    const above = scoreChecklist(entries, { scoringMethod: "percentage", passThreshold: 76 });
    expect(above.result).toBe("fail");
  });

  it("weights items when the method says weighted", () => {
    const result = scoreChecklist(
      [
        { item: item({ id: "a", weight: 3 }), answer: { response: "pass" } },
        { item: item({ id: "b", weight: 1 }), answer: { response: "fail" } },
      ],
      { scoringMethod: "weighted", passThreshold: 70 },
    );
    expect(result.score).toBe(3);
    expect(result.maxScore).toBe(4);
    expect(result.scorePercent).toBe(75);
    expect(result.result).toBe("pass_with_observations");
  });

  it("fails the whole checklist on a critical failure whatever the score says", () => {
    const entries = [
      ...Array.from({ length: 9 }, (_, i) => ({
        item: item({ id: `p${i}` }),
        answer: { response: "pass" },
      })),
      { item: item({ id: "crit", isCritical: true }), answer: { response: "fail" } },
    ];
    const result = scoreChecklist(entries, { scoringMethod: "percentage", passThreshold: 80 });
    expect(result.scorePercent).toBe(90);
    expect(result.result).toBe("fail");
    expect(result.criticalFailureItemIds).toEqual(["crit"]);
  });

  it("excludes unjudgeable items from the score instead of counting them as passes", () => {
    const result = scoreChecklist(
      [
        { item: item({ id: "a" }), answer: { response: "pass" } },
        { item: item({ id: "note", itemType: "long_text" }), answer: { response: "all fine" } },
        {
          item: item({ id: "pick", itemType: "single_select", options: ["A"] }),
          answer: { response: "A" },
        },
      ],
      { scoringMethod: "percentage", passThreshold: null },
    );
    expect(result.judgedItemCount).toBe(1);
    expect(result.answeredItemCount).toBe(3);
    expect(result.score).toBe(1);
    expect(result.maxScore).toBe(1);
  });

  it("excludes not-applicable answers from the score and names them", () => {
    const result = scoreChecklist(
      [
        { item: item({ id: "a", itemType: "pass_fail_na" }), answer: { response: "pass" } },
        {
          item: item({ id: "b", itemType: "pass_fail_na" }),
          answer: { isNotApplicable: true, naReason: "no such louvre" },
        },
      ],
      { scoringMethod: "percentage", passThreshold: 100 },
    );
    expect(result.notApplicableCount).toBe(1);
    expect(result.maxScore).toBe(1);
    expect(result.scorePercent).toBe(100);
    expect(result.result).toBe("pass");
  });

  it("returns a null result with a reason when nothing has been answered", () => {
    const result = scoreChecklist([{ item: item({ id: "a" }), answer: null }], {
      scoringMethod: "percentage",
      passThreshold: 90,
    });
    expect(result.result).toBeNull();
    expect(result.reasons.join(" ")).toContain("No items have been answered");
    expect(result.unansweredRequiredItemIds).toEqual(["a"]);
  });

  it("says so when a threshold is set but nothing could be scored", () => {
    const result = scoreChecklist(
      [{ item: item({ id: "t", itemType: "text" }), answer: { response: "words" } }],
      { scoringMethod: "percentage", passThreshold: 80 },
    );
    expect(result.result).toBeNull();
    expect(result.reasons.join(" ")).toContain("no percentage could be computed");
  });

  it("says the verdict ignored the score when no threshold is recorded", () => {
    const result = scoreChecklist([{ item: item({ id: "a" }), answer: { response: "fail" } }], {
      scoringMethod: "percentage",
      passThreshold: null,
    });
    expect(result.result).toBe("pass_with_observations");
    expect(result.reasons.join(" ")).toContain("No pass threshold");
  });

  it("skips section headers entirely", () => {
    const result = scoreChecklist(
      [
        { item: item({ id: "h", itemType: "section_header", required: true }), answer: null },
        { item: item({ id: "a" }), answer: { response: "pass" } },
      ],
      { scoringMethod: "percentage", passThreshold: null },
    );
    expect(result.unansweredRequiredItemIds).toEqual([]);
    expect(result.answeredItemCount).toBe(1);
    expect(result.result).toBe("pass");
  });

  it("judges a measurement item end to end through evaluateAnswerItem", () => {
    const spec = item({
      id: "m",
      itemType: "measurement",
      targetValue: 50,
      tolerancePlus: 1,
      toleranceMinus: 1,
      isCritical: true,
      weight: 2,
    });
    const inTolerance = evaluateAnswerItem(spec, { numericValue: 49 });
    expect(inTolerance.isPass).toBe(true);
    expect(inTolerance.score).toBe(2);
    expect(inTolerance.criticalFailure).toBe(false);

    const outOfTolerance = evaluateAnswerItem(spec, { numericValue: 48.9 });
    expect(outOfTolerance.isPass).toBe(false);
    expect(outOfTolerance.score).toBe(0);
    expect(outOfTolerance.criticalFailure).toBe(true);
  });
});
