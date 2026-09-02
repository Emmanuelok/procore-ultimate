import { describe, expect, it } from "vitest";
import { diffVersions, issuesAffectedByDiff, type DiffElement } from "./diff.js";
import {
  classifyPair,
  clashFingerprint,
  detectClashes,
  type ClashElement,
} from "./clash.js";
import {
  assignToFences,
  distanceM,
  isValidRing,
  pointInRing,
  ringAreaM2,
  ringBounds,
  type Point,
} from "./geo.js";
import { buildQualityReport } from "./ingest.js";

/* ------------------------------------------------------------------ */
/* Version comparison (#236)                                           */
/* ------------------------------------------------------------------ */

const el = (
  globalId: string,
  ifcType: string,
  name: string | null,
  hash: string,
): DiffElement => ({ globalId, ifcType, name, propertyHash: hash, storey: "L1" });

describe("diffVersions", () => {
  it("classifies added, removed, modified and unchanged by GlobalId", () => {
    const base = [
      el("A", "IFCWALL", "Wall 1", "h1"),
      el("B", "IFCWALL", "Wall 2", "h2"),
      el("C", "IFCDOOR", "Door", "h3"),
    ];
    const target = [
      el("A", "IFCWALL", "Wall 1", "h1"), // unchanged
      el("B", "IFCWALL", "Wall 2 renamed", "h2b"), // modified
      el("D", "IFCPIPESEGMENT", "Pipe", "h4"), // added
    ];
    const diff = diffVersions(base, target);
    expect(diff.added.map((e) => e.globalId)).toEqual(["D"]);
    expect(diff.removed.map((e) => e.globalId)).toEqual(["C"]);
    expect(diff.modified.map((e) => e.globalId)).toEqual(["B"]);
    expect(diff.modified[0]!.previousName).toBe("Wall 2");
    expect(diff.unchangedCount).toBe(1);
    expect(diff.byType["IFCPIPESEGMENT"]).toEqual({ added: 1, removed: 0, modified: 0 });
    expect(diff.byType["IFCDOOR"]).toEqual({ added: 0, removed: 1, modified: 0 });
  });

  it("treats a type change as modified even when the hash matches", () => {
    const diff = diffVersions(
      [el("A", "IFCWALL", "W", "same")],
      [el("A", "IFCWALLSTANDARDCASE", "W", "same")],
    );
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0]!.previousIfcType).toBe("IFCWALL");
  });

  it("reports duplicate GlobalIds instead of double-counting them", () => {
    const diff = diffVersions(
      [el("A", "IFCWALL", "W", "h")],
      [el("A", "IFCWALL", "W", "h"), el("A", "IFCWALL", "W copy", "h2")],
    );
    expect(diff.duplicateGlobalIds).toEqual(["A"]);
    expect(diff.added).toHaveLength(0);
    expect(diff.unchangedCount).toBe(1);
  });

  it("is empty for identical versions", () => {
    const list = [el("A", "IFCWALL", "W", "h"), el("B", "IFCDOOR", "D", "h2")];
    const diff = diffVersions(list, list);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
    expect(diff.unchangedCount).toBe(2);
  });

  it("flags open issues whose elements were removed or modified", () => {
    const diff = diffVersions(
      [el("A", "IFCWALL", "W", "h"), el("B", "IFCWALL", "W2", "h2")],
      [el("B", "IFCWALL", "W2 moved", "h2b")],
    );
    const affected = issuesAffectedByDiff(
      [
        { id: "i1", elementGlobalIds: ["A"] },
        { id: "i2", elementGlobalIds: ["B"] },
        { id: "i3", elementGlobalIds: ["Z"] },
      ],
      diff,
    );
    expect(affected.map((a) => a.issue.id)).toEqual(["i1", "i2"]);
    expect(affected[0]!.removed).toEqual(["A"]);
    expect(affected[1]!.modified).toEqual(["B"]);
  });
});

/* ------------------------------------------------------------------ */
/* Clash detection (#240)                                              */
/* ------------------------------------------------------------------ */

const box = (
  globalId: string,
  x: number,
  y: number,
  z: number,
  size = 1,
  discipline = "structural",
  ifcType = "IFCBEAM",
): ClashElement => ({
  globalId,
  ifcType,
  name: globalId,
  discipline,
  modelVersionId: `v-${discipline}`,
  storey: "L1",
  bounds: { minX: x, minY: y, minZ: z, maxX: x + size, maxY: y + size, maxZ: z + size },
});

describe("clash engine", () => {
  it("reports a hard clash when boxes interpenetrate beyond the tolerance", () => {
    const hit = classifyPair(box("A", 0, 0, 0), box("B", 0.5, 0.5, 0.5), {
      toleranceMm: 10,
      clearanceMm: 0,
    });
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe("hard");
    expect(hit!.penetrationMm).toBeCloseTo(500, 6);
    expect(hit!.centroid.x).toBeCloseTo(0.75, 6);
  });

  it("ignores an overlap smaller than the tolerance", () => {
    // 5 mm overlap with a 10 mm tolerance
    const hit = classifyPair(box("A", 0, 0, 0), box("B", 0.995, 0, 0), {
      toleranceMm: 10,
      clearanceMm: 0,
    });
    expect(hit).toBeNull();
  });

  it("reports a clearance failure only when clearance is required", () => {
    const options = { toleranceMm: 10, clearanceMm: 200 };
    const near = classifyPair(box("A", 0, 0, 0), box("B", 1.1, 0, 0), options);
    expect(near?.kind).toBe("clearance");
    expect(near?.distanceMm).toBeCloseTo(100, 6);
    expect(classifyPair(box("A", 0, 0, 0), box("B", 1.1, 0, 0), {
      toleranceMm: 10,
      clearanceMm: 0,
    })).toBeNull();
    // beyond the clearance: nothing
    expect(classifyPair(box("A", 0, 0, 0), box("B", 1.5, 0, 0), options)).toBeNull();
  });

  it("calls two identical boxes of the same type a duplicate", () => {
    const hit = classifyPair(box("A", 0, 0, 0), box("B", 0, 0, 0), {
      toleranceMm: 10,
      clearanceMm: 0,
    });
    expect(hit?.kind).toBe("duplicate");
  });

  it("never clashes an element with itself and reports each pair once", () => {
    const set = [box("A", 0, 0, 0), box("B", 0.5, 0, 0), box("C", 10, 10, 10)];
    const run = detectClashes(set, set, { toleranceMm: 10, clearanceMm: 0 });
    expect(run.hits).toHaveLength(1);
    expect(run.hits[0]!.fingerprint).toBe(clashFingerprint("A", "B"));
    expect(run.elementsLeft).toBe(3);
  });

  it("excludes elements with no extents and says how many", () => {
    const withBounds = [box("A", 0, 0, 0)];
    const without: ClashElement[] = [
      { ...box("B", 0, 0, 0), bounds: null },
      { ...box("C", 0, 0, 0), bounds: null },
    ];
    const run = detectClashes(withBounds, [...withBounds, ...without], {
      toleranceMm: 10,
      clearanceMm: 0,
    });
    expect(run.skippedNoBounds).toBe(2);
    expect(run.hits).toHaveLength(0);
    expect(run.method).toBe("aabb_broad_phase");
  });

  it("is deterministic and orders the worst clash first", () => {
    const left = [box("A", 0, 0, 0, 2), box("C", 20, 0, 0, 2)];
    const right = [box("B", 1.9, 0, 0, 2), box("D", 20.1, 0, 0, 2)];
    const first = detectClashes(left, right, { toleranceMm: 10, clearanceMm: 0 });
    const second = detectClashes(left, right, { toleranceMm: 10, clearanceMm: 0 });
    expect(first.hits.map((h) => h.fingerprint)).toEqual(second.hits.map((h) => h.fingerprint));
    expect(first.hits[0]!.penetrationMm).toBeGreaterThan(first.hits[1]!.penetrationMm!);
  });

  it("keeps a fingerprint stable regardless of pair order", () => {
    expect(clashFingerprint("A", "B")).toBe(clashFingerprint("B", "A"));
    expect(clashFingerprint("A", "B")).not.toBe(clashFingerprint("A", "C"));
  });

  it("scales: a 2000-element grid stays under the pair cap", () => {
    const set: ClashElement[] = [];
    for (let i = 0; i < 2000; i += 1) set.push(box(`E${i}`, i * 5, 0, 0));
    const run = detectClashes(set, set, { toleranceMm: 10, clearanceMm: 0 });
    expect(run.hits).toHaveLength(0);
    // spatial hashing keeps this far below 2000^2 / 2 = 2,000,000
    expect(run.comparedPairs).toBeLessThan(20_000);
  });
});

/* ------------------------------------------------------------------ */
/* Geofences (#471-475)                                                */
/* ------------------------------------------------------------------ */

const square: Point[] = [
  [-0.1, 51.5],
  [-0.1, 51.6],
  [0.1, 51.6],
  [0.1, 51.5],
];

describe("geofence geometry", () => {
  it("validates rings", () => {
    expect(isValidRing(square)).toBe(true);
    expect(isValidRing([[0, 0]] as Point[])).toBe(false);
    expect(isValidRing([[200, 0], [0, 0], [1, 1]] as Point[])).toBe(false);
  });

  it("tests containment, including points on the boundary", () => {
    expect(pointInRing([0, 51.55], square)).toBe(true);
    expect(pointInRing([0.5, 51.55], square)).toBe(false);
    expect(pointInRing([-0.1, 51.55], square)).toBe(true);
  });

  it("computes bounds and an approximate area", () => {
    expect(ringBounds(square)).toEqual([-0.1, 51.5, 0.1, 51.6]);
    const area = ringAreaM2(square)!;
    // 0.2 deg lng at 51.55 N is ~13.8 km; 0.1 deg lat is ~11.1 km
    expect(area).toBeGreaterThan(1.3e8);
    expect(area).toBeLessThan(1.7e8);
  });

  it("measures distance between two points", () => {
    expect(distanceM([0, 51.5], [0, 51.6])).toBeCloseTo(11119, -2);
  });

  it("assigns features to the fences that contain them", () => {
    const result = assignToFences(
      [
        { id: "in", kind: "equipment", label: "Crane", latitude: 51.55, longitude: 0 },
        { id: "out", kind: "photo", label: "Photo", latitude: 51.9, longitude: 0 },
      ],
      [{ id: "f1", name: "Site", ring: square }],
    );
    expect(result.byFence["f1"]).toEqual(["in"]);
    expect(result.outside).toEqual(["out"]);
    expect(result.fenceOfFeature["in"]).toEqual(["f1"]);
  });
});

/* ------------------------------------------------------------------ */
/* Model quality gate (#638)                                           */
/* ------------------------------------------------------------------ */

describe("buildQualityReport", () => {
  it("blocks on duplicate GlobalIds and on an empty model", () => {
    const dupes = buildQualityReport({
      elements: [
        { globalId: "A", name: "W", classification: "X", spatialGlobalId: "S", bounds: {} },
        { globalId: "A", name: "W", classification: "X", spatialGlobalId: "S", bounds: {} },
      ],
      spatialCount: 1,
      notes: [],
    });
    expect(dupes.passed).toBe(false);
    expect(dupes.findings.map((f) => f.check)).toContain("duplicate_global_ids");

    const empty = buildQualityReport({ elements: [], spatialCount: 0, notes: [] });
    expect(empty.passed).toBe(false);
    expect(empty.findings[0]!.check).toBe("no_elements");
  });

  it("warns without blocking for missing names, containers and classification", () => {
    const report = buildQualityReport({
      elements: [{ globalId: "A", name: null, classification: null, spatialGlobalId: null, bounds: null }],
      spatialCount: 0,
      notes: ["note"],
    });
    expect(report.passed).toBe(true);
    expect(report.findings.map((f) => f.check).sort()).toEqual([
      "missing_classification",
      "missing_names",
      "missing_spatial_container",
    ]);
    expect(report.notes.join(" ")).toContain("no extents");
  });
});
