/** Unit tests for the lessons closure gate engine (#415). */
import { describe, expect, it } from "vitest";
import {
  assessLessonsReadiness,
  lessonsGateApplies,
  type LessonForGate,
} from "./lessons.js";

const lesson = (status: string, number = "LSN-001"): LessonForGate => ({
  id: `l-${number}-${status}`,
  number,
  title: `Lesson ${number}`,
  status,
  phase: null,
});

describe("assessLessonsReadiness", () => {
  it("passes everything through when the gate does not carry the requirement", () => {
    const r = assessLessonsReadiness([lesson("draft")], { required: false });
    expect(r.required).toBe(false);
    expect(r.ready).toBe(true);
    // the outstanding lesson is still REPORTED — it is information, not a block
    expect(r.outstanding).toHaveLength(1);
    expect(r.reasons.join(" ")).toMatch(/information only/i);
  });

  it("refuses an empty register rather than treating silence as closure", () => {
    const r = assessLessonsReadiness([], { required: true });
    expect(r.ready).toBe(false);
    expect(r.capturedCount).toBe(0);
    expect(r.outstanding).toEqual([]);
    expect(r.reasons.join(" ")).toMatch(/No lesson has been captured/i);
  });

  it("blocks on lessons nobody has ruled on and names them", () => {
    const r = assessLessonsReadiness(
      [lesson("validated", "LSN-001"), lesson("draft", "LSN-002"), lesson("submitted", "LSN-003")],
      { required: true },
    );
    expect(r.ready).toBe(false);
    expect(r.closedCount).toBe(1);
    expect(r.outstanding.map((l) => l.number)).toEqual(["LSN-002", "LSN-003"]);
    expect(r.reasons.join(" ")).toContain("LSN-002, LSN-003");
  });

  it("treats a rejected or superseded lesson as ruled on — a decision is closure", () => {
    const r = assessLessonsReadiness(
      [lesson("rejected", "LSN-004"), lesson("superseded", "LSN-005"), lesson("published", "LSN-006")],
      { required: true },
    );
    expect(r.ready).toBe(true);
    expect(r.closedCount).toBe(3);
    expect(r.reasons.join(" ")).toMatch(/learning is closed/i);
  });

  it("does not invent a quota: one closed lesson is enough", () => {
    const r = assessLessonsReadiness([lesson("validated")], { required: true });
    expect(r.ready).toBe(true);
    expect(r.capturedCount).toBe(1);
  });
});

describe("lessonsGateApplies", () => {
  it("binds only the decisions that let the project move on", () => {
    expect(lessonsGateApplies("proceed")).toBe(true);
    expect(lessonsGateApplies("proceed_with_conditions")).toBe(true);
    expect(lessonsGateApplies("hold")).toBe(false);
    expect(lessonsGateApplies("stop")).toBe(false);
  });
});
