import { describe, expect, it } from "vitest";
import {
  bounds,
  distanceToRouteM,
  haversineMetres,
  normaliseRing,
  pointInRing,
  ringCentroid,
  zonesContaining,
  type Ring,
} from "./geometry.js";

const square: Ring = [
  [0, 0],
  [0, 1],
  [1, 1],
  [1, 0],
];

describe("pointInRing", () => {
  it("puts an interior point inside and an exterior point outside", () => {
    expect(pointInRing({ lat: 0.5, lon: 0.5 }, square)).toBe(true);
    expect(pointInRing({ lat: 1.5, lon: 0.5 }, square)).toBe(false);
    expect(pointInRing({ lat: -0.0001, lon: 0.5 }, square)).toBe(false);
  });

  it("treats the boundary and the vertices as inside", () => {
    expect(pointInRing({ lat: 0, lon: 0 }, square)).toBe(true);
    expect(pointInRing({ lat: 0.5, lon: 0 }, square)).toBe(true);
    expect(pointInRing({ lat: 1, lon: 1 }, square)).toBe(true);
  });

  it("accepts an explicitly closed ring identically", () => {
    const closed: Ring = [...square, [0, 0]];
    expect(normaliseRing(closed)).toHaveLength(4);
    expect(pointInRing({ lat: 0.5, lon: 0.5 }, closed)).toBe(true);
    expect(pointInRing({ lat: 2, lon: 2 }, closed)).toBe(false);
  });

  it("handles a concave ring: the notch is outside", () => {
    const cShape: Ring = [
      [0, 0],
      [0, 3],
      [3, 3],
      [3, 2],
      [1, 2],
      [1, 1],
      [3, 1],
      [3, 0],
    ];
    expect(pointInRing({ lat: 1.5, lon: 2 }, cShape)).toBe(false);
    expect(pointInRing({ lat: 0.5, lon: 2 }, cShape)).toBe(true);
    expect(pointInRing({ lat: 2.5, lon: 2 }, cShape)).toBe(true);
  });

  it("refuses a degenerate ring rather than guessing", () => {
    expect(pointInRing({ lat: 0, lon: 0 }, [[0, 0]] as Ring)).toBe(false);
    expect(pointInRing({ lat: 0, lon: 0 }, [] as Ring)).toBe(false);
  });
});

describe("haversineMetres", () => {
  it("is zero for the same point and ~111km per degree of latitude", () => {
    expect(haversineMetres({ lat: 51.5, lon: -0.1 }, { lat: 51.5, lon: -0.1 })).toBe(0);
    const d = haversineMetres({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  it("is symmetric", () => {
    const a = { lat: 51.5074, lon: -0.1278 };
    const b = { lat: 48.8566, lon: 2.3522 };
    expect(haversineMetres(a, b)).toBeCloseTo(haversineMetres(b, a), 6);
  });
});

describe("zonesContaining", () => {
  const ringZone = { id: "z1", name: "Lift zone", ring: square, centreLat: null, centreLon: null, radiusM: null };
  const radiusZone = { id: "z2", name: "Blast radius", ring: [] as Ring, centreLat: 10, centreLon: 10, radiusM: 500 };
  const brokenZone = { id: "z3", name: "Half drawn", ring: [[0, 0]] as Ring, centreLat: null, centreLon: null, radiusM: null };

  it("matches ring zones and radius zones and names the unusable ones", () => {
    const inside = zonesContaining({ lat: 0.5, lon: 0.5 }, [ringZone, radiusZone, brokenZone]);
    expect(inside.hits.map((h) => h.zoneId)).toEqual(["z1"]);
    expect(inside.unusable).toEqual(["z3"]);

    const nearCentre = zonesContaining({ lat: 10.001, lon: 10 }, [ringZone, radiusZone]);
    expect(nearCentre.hits[0]?.zoneId).toBe("z2");
    expect(nearCentre.hits[0]?.test).toBe("radius");
    expect(nearCentre.hits[0]?.distanceM).toBeGreaterThan(0);

    const outside = zonesContaining({ lat: 20, lon: 20 }, [ringZone, radiusZone]);
    expect(outside.hits).toEqual([]);
  });

  it("never treats an unusable zone as a miss", () => {
    const r = zonesContaining({ lat: 0, lon: 0 }, [brokenZone]);
    expect(r.hits).toEqual([]);
    expect(r.unusable).toEqual(["z3"]);
  });
});

describe("bounds and centroid", () => {
  it("returns null for nothing and the extent otherwise", () => {
    expect(bounds([])).toBeNull();
    expect(bounds([{ lat: 1, lon: 2 }, { lat: -1, lon: 5 }])).toEqual({ minLat: -1, maxLat: 1, minLon: 2, maxLon: 5 });
    expect(ringCentroid(square)).toEqual({ lat: 0.5, lon: 0.5 });
    expect(ringCentroid([])).toBeNull();
  });
});

describe("distanceToRouteM", () => {
  it("refuses a route with fewer than two vertices", () => {
    expect(distanceToRouteM({ lat: 0, lon: 0 }, [] as Ring)).toBeNull();
    expect(distanceToRouteM({ lat: 0, lon: 0 }, [[0, 0]] as Ring)).toBeNull();
  });

  it("is zero on the line and grows with perpendicular offset", () => {
    const route: Ring = [
      [0, 0],
      [0.01, 0],
    ];
    expect(distanceToRouteM({ lat: 0, lon: 0.005 }, route)).toBeCloseTo(0, 0);
    const off = distanceToRouteM({ lat: 0.001, lon: 0.005 }, route);
    expect(off).not.toBeNull();
    expect(off!).toBeGreaterThan(100);
    expect(off!).toBeLessThan(120);
  });

  it("clamps to the segment ends rather than extending the line", () => {
    const route: Ring = [
      [0, 0],
      [0.01, 0],
    ];
    const beyond = distanceToRouteM({ lat: 0, lon: 0.02 }, route);
    expect(beyond).not.toBeNull();
    expect(beyond!).toBeGreaterThan(1000);
  });
});
