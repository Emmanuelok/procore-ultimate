/**
 * The summary and register reads are bounded. A register bigger than its cap
 * must SAY so — a figure computed over a slice and presented as the whole is
 * exactly the fabricated number the platform refuses to print.
 */
import { describe, expect, it } from "vitest";
import { SUMMARY_ACTIVITY_CAP, SUMMARY_ROW_CAP, capped } from "./service.js";

describe("summary row caps", () => {
  it("returns everything and says nothing when the register fits", () => {
    const reasons: string[] = [];
    const rows = capped([1, 2, 3], 10, "letters", reasons);
    expect(rows).toHaveLength(3);
    expect(reasons).toEqual([]);
  });

  it("returns exactly the cap and says nothing when the register is exactly full", () => {
    const reasons: string[] = [];
    const rows = capped([1, 2, 3], 3, "letters", reasons);
    expect(rows).toHaveLength(3);
    expect(reasons).toEqual([]);
  });

  it("truncates to the cap and records WHY the figures are a floor", () => {
    const reasons: string[] = [];
    const rows = capped([1, 2, 3, 4], 3, "letters", reasons);
    expect(rows).toEqual([1, 2, 3]);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("more than 3 letters");
    expect(reasons[0]).toContain("floor");
  });

  it("names the record kind that overflowed, so the reason is actionable", () => {
    const reasons: string[] = [];
    capped([1, 2], 1, "form responses", reasons);
    expect(reasons[0]).toContain("form responses");
  });

  it("keeps the caps the reads fetch one row past", () => {
    // The reads select CAP + 1 rows precisely so `capped` can tell "full" from
    // "overflowing". If these ever drift apart the truncation goes silent.
    expect(SUMMARY_ROW_CAP).toBe(20_000);
    expect(SUMMARY_ACTIVITY_CAP).toBe(50_000);
  });
});
