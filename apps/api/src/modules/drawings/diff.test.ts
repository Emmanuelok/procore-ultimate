import { describe, expect, it } from "vitest";
import {
  clusterRegions,
  diffTextItems,
  pointInRegions,
  rectsOverlap,
  shapeBounds,
  shapesInRegions,
} from "./diff.js";
import type { PositionedItem } from "./pdf.js";

const it_ = (t: string, x: number, y: number, w = 0.05, h = 0.01): PositionedItem => ({ t, x, y, w, h });

const base: PositionedItem[] = [
  it_("FLOOR PLAN LEVEL 1", 0.6, 0.9),
  it_("A-101", 0.85, 0.95),
  it_("DOOR 101", 0.2, 0.2),
  it_("WINDOW W1", 0.4, 0.4),
];

describe("revision vector diff (#262)", () => {
  it("calls an identical text layer unchanged, with no regions", () => {
    const r = diffTextItems(base, base.map((i) => ({ ...i })));
    expect(r.verdict).toBe("unchanged");
    expect(r.regions).toEqual([]);
    expect(r.stats).toMatchObject({ added: 0, removed: 0, moved: 0, common: 4, changeRatio: 0 });
    expect(r.basis).toMatch(/matches the superseded revision/);
  });

  it("tolerates sub-quantum jitter in position", () => {
    const jittered = base.map((i) => ({ ...i, x: i.x + 0.001, y: i.y - 0.001 }));
    expect(diffTextItems(base, jittered).verdict).toBe("unchanged");
  });

  it("reports an added item as one added region", () => {
    const next = [...base, it_("DOOR 102", 0.2, 0.25)];
    const r = diffTextItems(base, next);
    expect(r.verdict).toBe("changed");
    expect(r.stats).toMatchObject({ added: 1, removed: 0, moved: 0, common: 4 });
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0]).toMatchObject({ kind: "added", items: 1, sample: "DOOR 102" });
    expect(r.stats.changeRatio).toBeCloseTo(1 / 5, 3);
  });

  it("reports a removed item", () => {
    const r = diffTextItems(base, base.slice(0, 3));
    expect(r.stats).toMatchObject({ added: 0, removed: 1, moved: 0 });
    expect(r.regions[0]).toMatchObject({ kind: "removed", sample: "WINDOW W1" });
  });

  it("recognises the same text at a new place as moved, in two regions", () => {
    const next = base.map((i) => (i.t === "WINDOW W1" ? { ...i, x: 0.7, y: 0.1 } : i));
    const r = diffTextItems(base, next);
    expect(r.stats).toMatchObject({ added: 0, removed: 0, moved: 1 });
    expect(r.regions).toHaveLength(2);
    expect(r.regions.every((g) => g.kind === "moved")).toBe(true);
  });

  it("refuses a verdict when either side has no text layer", () => {
    const none = diffTextItems([], base, { prevHasText: false });
    expect(none.verdict).toBe("unknown");
    expect(none.stats.changeRatio).toBeNull();
    expect(none.basis).toMatch(/superseded revision has no text layer/);
    const other = diffTextItems(base, [], { nextHasText: false });
    expect(other.verdict).toBe("unknown");
    expect(diffTextItems([], []).basis).toMatch(/Neither revision/);
  });

  it("is deterministic regardless of input order", () => {
    const next = [...base, it_("NOTE 7", 0.9, 0.1), it_("NOTE 8", 0.1, 0.9)];
    const a = diffTextItems(base, next);
    const b = diffTextItems([...base].reverse(), [...next].reverse());
    expect(a.regions).toEqual(b.regions);
  });
});

describe("region clustering", () => {
  it("merges neighbouring items into one box and keeps the largest sample", () => {
    const regions = clusterRegions([
      { item: it_("A", 0.10, 0.10, 0.02, 0.01), kind: "added" },
      { item: it_("LONGER TEXT", 0.125, 0.10, 0.04, 0.01), kind: "added" },
      { item: it_("FAR", 0.80, 0.80, 0.02, 0.01), kind: "removed" },
    ]);
    expect(regions).toHaveLength(2);
    const big = regions.find((r) => r.items === 2)!;
    expect(big.kind).toBe("added");
    expect(big.sample).toBe("LONGER TEXT");
    expect(big.x).toBeCloseTo(0.1, 4);
    expect(big.w).toBeCloseTo(0.065, 3);
  });

  it("labels a mixed cluster as moved", () => {
    const regions = clusterRegions([
      { item: it_("A", 0.1, 0.1), kind: "added" },
      { item: it_("B", 0.11, 0.1), kind: "removed" },
    ]);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.kind).toBe("moved");
  });

  it("merges chains that only become adjacent after a merge", () => {
    const regions = clusterRegions([
      { item: it_("A", 0.10, 0.5, 0.01, 0.01), kind: "added" },
      { item: it_("C", 0.14, 0.5, 0.01, 0.01), kind: "added" },
      { item: it_("B", 0.12, 0.5, 0.01, 0.01), kind: "added" },
    ]);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.items).toBe(3);
  });
});

describe("overlap helpers", () => {
  const region = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };

  it("tests rectangles with optional padding", () => {
    expect(rectsOverlap(region, { x: 0.5, y: 0.5, w: 0.01, h: 0.01 })).toBe(true);
    expect(rectsOverlap(region, { x: 0.7, y: 0.7, w: 0.01, h: 0.01 })).toBe(false);
    expect(rectsOverlap(region, { x: 0.605, y: 0.5, w: 0.01, h: 0.01 }, 0.01)).toBe(true);
  });

  it("tests a pin point against changed regions", () => {
    expect(pointInRegions({ x: 0.5, y: 0.5 }, [region])).toBe(true);
    expect(pointInRegions({ x: 0.1, y: 0.1 }, [region])).toBe(false);
  });

  it("computes bounds for every markup shape kind and ignores garbage", () => {
    expect(shapeBounds({ kind: "rect", from: { x: 0.5, y: 0.1 }, to: { x: 0.1, y: 0.5 } })).toEqual({
      x: 0.1,
      y: 0.1,
      w: 0.4,
      h: 0.4,
    });
    const pen = shapeBounds({ kind: "pen", points: [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.25 }] })!;
    expect(pen.x).toBeCloseTo(0.2, 6);
    expect(pen.y).toBeCloseTo(0.2, 6);
    expect(pen.w).toBeCloseTo(0.1, 6);
    expect(pen.h).toBeCloseTo(0.05, 6);
    expect(shapeBounds({ kind: "text", at: { x: 0.5, y: 0.5 }, text: "x" })).toMatchObject({ x: 0.5, y: 0.5 });
    expect(shapeBounds({ kind: "pen", points: [] })).toBeNull();
    expect(shapeBounds(null)).toBeNull();
    expect(shapeBounds({ kind: "line" })).toBeNull();
  });

  it("flags only the shapes that sit inside a changed region", () => {
    const shapes = [
      { kind: "cloud", from: { x: 0.45, y: 0.45 }, to: { x: 0.5, y: 0.5 } },
      { kind: "rect", from: { x: 0.8, y: 0.8 }, to: { x: 0.9, y: 0.9 } },
      { kind: "text", at: { x: 0.41, y: 0.41 }, text: "check" },
    ];
    expect(shapesInRegions(shapes, [region])).toEqual([0, 2]);
    expect(shapesInRegions(shapes, [])).toEqual([]);
  });
});
