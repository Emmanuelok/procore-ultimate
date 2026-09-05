/**
 * Unit tests for the per-project slice of a Pulse snapshot — the thing that
 * lets someone who can see three of forty projects read an honest history
 * instead of the company's totals (plan §6.3). No database: this is pure
 * arithmetic over what a snapshot stores.
 */
import { describe, expect, it } from "vitest";
import { COMPANY_ROLLUP_KEY, rollupForVisible, type ProjectRollup } from "./service.js";

const rollup: ProjectRollup = {
  p1: { level: "off_track", attention: { critical: 2, high: 3, medium: 1, low: 0, info: 0 } },
  p2: { level: "watch", attention: { critical: 0, high: 1, medium: 0, low: 2, info: 0 } },
  p3: { level: "on_track", attention: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } },
  [COMPANY_ROLLUP_KEY]: { level: "unrated", attention: { critical: 1, high: 0, medium: 0, low: 0, info: 0 } },
};

describe("rollupForVisible", () => {
  it("gives the whole company when nothing is restricted", () => {
    const all = rollupForVisible(rollup, null);
    expect(all.projects).toBe(3);
    expect(all.byHealth).toEqual({ off_track: 1, watch: 1, on_track: 1, unrated: 0 });
    expect(all.openAttention).toBe(10);
    expect(all.attentionBySeverity["critical"]).toBe(3);
    expect(all.attentionBySeverity["high"]).toBe(4);
  });

  it("counts only the projects the caller may see, and never leaks the rest", () => {
    const slice = rollupForVisible(rollup, new Set(["p2"]));
    expect(slice.projects).toBe(1);
    expect(slice.byHealth).toEqual({ off_track: 0, watch: 1, on_track: 0, unrated: 0 });
    // p2's three items plus the one company-wide item every member may see
    expect(slice.openAttention).toBe(4);
    expect(slice.attentionBySeverity["critical"]).toBe(1);
    expect(slice.attentionBySeverity["high"]).toBe(1);
    expect(slice.attentionBySeverity["low"]).toBe(2);
  });

  it("keeps company-wide items visible to a caller with no projects at all", () => {
    const none = rollupForVisible(rollup, new Set<string>());
    expect(none.projects).toBe(0);
    expect(none.byHealth).toEqual({ off_track: 0, watch: 0, on_track: 0, unrated: 0 });
    expect(none.openAttention).toBe(1);
    expect(none.attentionBySeverity["critical"]).toBe(1);
  });

  it("is empty, not zero-filled with someone else's numbers, for an empty snapshot", () => {
    const empty = rollupForVisible({}, new Set(["p1"]));
    expect(empty.projects).toBe(0);
    expect(empty.openAttention).toBe(0);
    expect(Object.values(empty.attentionBySeverity).every((v) => v === 0)).toBe(true);
  });

  it("ignores a level it does not know rather than mis-bucketing it", () => {
    const odd: ProjectRollup = { p9: { level: "banana", attention: { high: 1 } } };
    const out = rollupForVisible(odd, null);
    expect(out.projects).toBe(1);
    expect(out.byHealth).toEqual({ off_track: 0, watch: 0, on_track: 0, unrated: 0 });
    expect(out.openAttention).toBe(1);
  });
});
