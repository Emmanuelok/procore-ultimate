import { describe, expect, it } from "vitest";
import {
  calibrateFromRatio,
  calibrateScale,
  computeTakeoff,
  convertArea,
  convertLength,
  convertVolume,
  derivedUnit,
  measureGeometry,
  polygonArea,
  polygonPerimeter,
  polylineLength,
  rectanglePoints,
} from "./measure.js";

/**
 * Takeoff measurement engine (spec Vol I #184–189). Every branch: each
 * geometry kind, calibrated and uncalibrated, each measurement type, the
 * factor arithmetic, and the refusals.
 */

describe("unit conversion", () => {
  it("converts lengths through metres", () => {
    expect(convertLength(1, "m", "mm")).toBeCloseTo(1000, 6);
    expect(convertLength(12, "in", "ft")).toBeCloseTo(1, 6);
    expect(convertLength(3, "ft", "yd")).toBeCloseTo(1, 6);
  });

  it("squares and cubes the ratio for areas and volumes", () => {
    expect(convertArea(1, "m", "mm")).toBeCloseTo(1_000_000, 3);
    expect(convertVolume(1, "m", "mm")).toBeCloseTo(1_000_000_000, 0);
    expect(convertArea(9, "ft", "yd")).toBeCloseTo(1, 6);
  });

  it("derives the quantity unit from the measurement type", () => {
    expect(derivedUnit("linear", "m")).toBe("m");
    expect(derivedUnit("area", "m")).toBe("m2");
    expect(derivedUnit("volume", "ft")).toBe("ft3");
    expect(derivedUnit("count", "m")).toBe("ea");
    expect(derivedUnit("area", null)).toBe("unit2");
  });
});

describe("scale calibration (#188)", () => {
  it("derives geometry units per building unit from a known dimension", () => {
    const cal = calibrateScale({ drawnLength: 250, realLength: 5, unit: "m" });
    expect(cal.pixelsPerUnit).toBe(50);
    expect(cal.scaleUnit).toBe("m");
    expect(cal.label).toContain("5 m");
  });

  it("refuses a degenerate calibration instead of returning infinity", () => {
    expect(() => calibrateScale({ drawnLength: 0, realLength: 5, unit: "m" })).toThrow(/positive drawn/);
    expect(() => calibrateScale({ drawnLength: 10, realLength: 0, unit: "m" })).toThrow(/positive real/);
  });

  it("derives a calibration from a printed ratio", () => {
    // At 1:50 with geometry in paper millimetres, 1 mm drawn = 50 mm = 0.05 m,
    // so 20 drawn units make one metre.
    const cal = calibrateFromRatio({ ratio: 50, unit: "m" });
    expect(cal.pixelsPerUnit).toBeCloseTo(20, 9);
    expect(cal.label).toBe("1:50");
  });

  it("honours a paper-unit conversion for point-based geometry", () => {
    const cal = calibrateFromRatio({ ratio: 100, unit: "m", paperUnitsPerMm: 72 / 25.4 });
    // 1 point = 25.4/72 mm of paper = 100 × that of building
    expect(cal.pixelsPerUnit).toBeCloseTo((72 / 25.4) * 10, 6);
  });

  it("refuses a non-positive ratio or paper conversion", () => {
    expect(() => calibrateFromRatio({ ratio: 0, unit: "m" })).toThrow(/positive/);
    expect(() => calibrateFromRatio({ ratio: 50, unit: "m", paperUnitsPerMm: 0 })).toThrow(/positive/);
  });
});

describe("geometry primitives", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it("measures a polyline, open and closed", () => {
    expect(polylineLength(square, false)).toBe(30);
    expect(polylineLength(square, true)).toBe(40);
  });

  it("takes the shoelace area regardless of winding direction", () => {
    expect(polygonArea(square)).toBe(100);
    expect(polygonArea([...square].reverse())).toBe(100);
  });

  it("returns zero area for degenerate polygons", () => {
    expect(polygonArea([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(0);
  });

  it("expands two rectangle corners into four vertices", () => {
    const pts = rectanglePoints([
      { x: 2, y: 3 },
      { x: 8, y: 9 },
    ]);
    expect(pts).toHaveLength(4);
    expect(polygonArea(pts)).toBe(36);
    expect(polygonPerimeter(pts)).toBe(24);
  });

  it("measures each geometry kind", () => {
    expect(measureGeometry({ kind: "polygon", points: square }).area).toBe(100);
    expect(measureGeometry({ kind: "rectangle", points: [{ x: 0, y: 0 }, { x: 4, y: 5 }] }).area).toBe(20);
    const circle = measureGeometry({ kind: "circle", points: [{ x: 0, y: 0 }], radius: 2 });
    expect(circle.area).toBeCloseTo(Math.PI * 4, 9);
    expect(circle.length).toBeCloseTo(4 * Math.PI, 9);
    expect(measureGeometry({ kind: "points", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }).count).toBe(2);
  });

  it("warns rather than throwing on unusable geometry", () => {
    expect(measureGeometry(null).warnings[0]).toMatch(/No geometry/);
    expect(measureGeometry({ kind: "circle", points: [], radius: 0 }).warnings[0]).toMatch(/centre point/);
    expect(measureGeometry({ kind: "polygon", points: [{ x: 0, y: 0 }] }).warnings[0]).toMatch(/three vertices/);
    expect(measureGeometry({ kind: "rectangle", points: [{ x: 0, y: 0 }] }).warnings[0]).toMatch(/two opposite corners/);
    expect(measureGeometry({ kind: "points", points: [] }).warnings[0]).toMatch(/No marks/);
    expect(measureGeometry({ kind: "spline", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }).warnings[0]).toMatch(/Unknown geometry kind/);
  });

  it("ignores non-finite vertices and says so", () => {
    const m = measureGeometry({
      kind: "polyline",
      points: [{ x: 0, y: 0 }, { x: Number.NaN, y: 1 }, { x: 3, y: 0 }],
    });
    expect(m.length).toBe(3);
    expect(m.warnings.join(" ")).toMatch(/not finite/);
  });
});

describe("computeTakeoff", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  it("measures a linear run at scale (#185)", () => {
    const r = computeTakeoff({
      measurementType: "linear",
      geometry: { kind: "polyline", points: [{ x: 0, y: 0 }, { x: 250, y: 0 }] },
      pixelsPerUnit: 50,
      scaleUnit: "m",
    });
    expect(r.rawValue).toBe(5);
    expect(r.quantity).toBe(5);
    expect(r.unit).toBe("m");
    expect(r.warnings).toHaveLength(0);
    expect(r.basis[0]).toContain("÷ scale");
  });

  it("measures an area and its perimeter (#186)", () => {
    const r = computeTakeoff({
      measurementType: "area",
      geometry: { kind: "polygon", points: square },
      pixelsPerUnit: 10,
      scaleUnit: "m",
    });
    expect(r.rawValue).toBe(100); // 10m × 10m
    expect(r.unit).toBe("m2");
    expect(r.perimeter).toBe(40);
  });

  it("raises a linear run to an area when a height is given", () => {
    const r = computeTakeoff({
      measurementType: "area",
      geometry: { kind: "polyline", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
      pixelsPerUnit: 10,
      scaleUnit: "m",
      height: 2.4,
    });
    expect(r.rawValue).toBe(24);
    expect(r.basis[0]).toContain("height");
    expect(r.perimeter).toBeNull();
  });

  it("measures a volume from an area and a depth (#187)", () => {
    const r = computeTakeoff({
      measurementType: "volume",
      geometry: { kind: "polygon", points: square },
      pixelsPerUnit: 10,
      scaleUnit: "m",
      depth: 0.2,
    });
    expect(r.rawValue).toBe(20);
    expect(r.unit).toBe("m3");
  });

  it("measures a volume from a run, a width and a height", () => {
    const r = computeTakeoff({
      measurementType: "volume",
      geometry: { kind: "polyline", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
      pixelsPerUnit: 10,
      scaleUnit: "m",
      depth: 0.6,
      height: 1.2,
    });
    expect(r.rawValue).toBeCloseTo(7.2, 6);
  });

  it("refuses to invent a volume without the inputs for one", () => {
    const r = computeTakeoff({
      measurementType: "volume",
      geometry: { kind: "polygon", points: square },
      pixelsPerUnit: 10,
      scaleUnit: "m",
    });
    expect(r.rawValue).toBe(0);
    expect(r.warnings.join(" ")).toMatch(/needs an area plus a depth/);
  });

  it("refuses to invent an area from an open run with no height", () => {
    const r = computeTakeoff({
      measurementType: "area",
      geometry: { kind: "polyline", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
      pixelsPerUnit: 10,
      scaleUnit: "m",
    });
    expect(r.rawValue).toBe(0);
    expect(r.warnings.join(" ")).toMatch(/enclosing shape/);
  });

  it("counts marks (#187)", () => {
    const r = computeTakeoff({
      measurementType: "count",
      geometry: { kind: "points", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] },
    });
    expect(r.quantity).toBe(3);
    expect(r.unit).toBe("ea");
    expect(r.warnings).toHaveLength(0);
  });

  it("applies repeats and deductions in order, showing the arithmetic", () => {
    const r = computeTakeoff({
      measurementType: "area",
      geometry: { kind: "polygon", points: square },
      pixelsPerUnit: 10,
      scaleUnit: "m",
      multiplier: 4,
      deduction: 12,
    });
    expect(r.rawValue).toBe(100);
    expect(r.quantity).toBe(388); // 100 × 4 − 12
    expect(r.perimeter).toBe(160);
    expect(r.basis.join(" ")).toContain("× 4 repeats");
    expect(r.basis.join(" ")).toContain("− 12");
  });

  it("flags an uncalibrated sheet rather than pretending the units are metres", () => {
    const r = computeTakeoff({
      measurementType: "linear",
      geometry: { kind: "polyline", points: [{ x: 0, y: 0 }, { x: 250, y: 0 }] },
      pixelsPerUnit: null,
      scaleUnit: "m",
    });
    expect(r.rawValue).toBe(250);
    expect(r.warnings.join(" ")).toMatch(/not calibrated/);
  });

  it("flags a non-positive recorded scale", () => {
    const r = computeTakeoff({
      measurementType: "linear",
      geometry: { kind: "polyline", points: [{ x: 0, y: 0 }, { x: 250, y: 0 }] },
      pixelsPerUnit: -3,
      scaleUnit: "m",
    });
    expect(r.warnings.join(" ")).toMatch(/not a positive number/);
  });

  it("accepts a directly entered quantity and keeps the factors", () => {
    const r = computeTakeoff({
      measurementType: "count",
      manualRawValue: 32,
      multiplier: 2,
      deduction: 4,
    });
    expect(r.rawValue).toBe(32);
    expect(r.quantity).toBe(60);
    expect(r.basis[0]).toContain("Entered directly");
  });

  it("warns when a deduction takes the quantity negative", () => {
    const r = computeTakeoff({
      measurementType: "area",
      geometry: { kind: "polygon", points: square },
      pixelsPerUnit: 10,
      scaleUnit: "m",
      deduction: 500,
    });
    expect(r.quantity).toBe(-400);
    expect(r.warnings.join(" ")).toMatch(/negative/);
  });

  it("falls back to a multiplier of one when the repeat count is nonsense", () => {
    const r = computeTakeoff({
      measurementType: "count",
      manualRawValue: 10,
      multiplier: -2,
    });
    expect(r.quantity).toBe(10);
    expect(r.warnings.join(" ")).toMatch(/non-negative/);
  });

  it("honours an explicit output unit override", () => {
    const r = computeTakeoff({
      measurementType: "area",
      geometry: { kind: "polygon", points: square },
      pixelsPerUnit: 10,
      scaleUnit: "m",
      unit: "sm",
    });
    expect(r.unit).toBe("sm");
  });
});
