/**
 * TAKEOFF MEASUREMENT ENGINE — spec Vol I §1.2 (#184–189).
 *
 * Pure arithmetic over drawn geometry: scale calibration, polyline length,
 * polygon area (shoelace), circle and rectangle measures, and the depth /
 * deduction / repeat factors that turn a shape on a sheet into a quantity in
 * a unit.
 *
 * WHY IT IS A SEPARATE FILE. The number this produces is the first link in
 * the estimating chain and the one most often disputed. It has to be
 * re-derivable from the stored geometry alone, by anybody, without an HTTP
 * request — so it is a pure function of its inputs with no database, no clock
 * and no randomness, and every branch is unit-tested.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not read PDFs, rasterise sheets,
 * or detect shapes. Geometry arrives already drawn (client-side overlay, an
 * import, or an API caller) in the sheet's own coordinate space; this file
 * only converts that space into building units and applies the estimator's
 * declared factors.
 */
import type { LengthUnit, TakeoffMeasurementType } from "@constructos/shared";

export interface Point {
  x: number;
  y: number;
}

export interface Geometry {
  kind: string;
  points: Point[];
  radius?: number;
  closed?: boolean;
}

/** Metres per one of the unit. The single conversion table in the module. */
export const LENGTH_UNIT_METRES: Record<LengthUnit, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  km: 1000,
  in: 0.0254,
  ft: 0.3048,
  yd: 0.9144,
};

export const isLengthUnit = (u: string): u is LengthUnit =>
  Object.prototype.hasOwnProperty.call(LENGTH_UNIT_METRES, u);

/** Quantity units derived from a length unit, per measurement type. */
export function derivedUnit(
  measurementType: TakeoffMeasurementType,
  scaleUnit: LengthUnit | null,
): string {
  if (measurementType === "count") return "ea";
  const base = scaleUnit ?? "unit";
  if (measurementType === "linear") return base;
  if (measurementType === "area") return `${base}2`;
  return `${base}3`;
}

export function toMetres(value: number, unit: LengthUnit): number {
  return value * LENGTH_UNIT_METRES[unit];
}

export function fromMetres(value: number, unit: LengthUnit): number {
  return value / LENGTH_UNIT_METRES[unit];
}

/** Convert a length between two units. */
export function convertLength(value: number, from: LengthUnit, to: LengthUnit): number {
  return fromMetres(toMetres(value, from), to);
}

/** Convert an area (unit²) between two length-unit bases. */
export function convertArea(value: number, from: LengthUnit, to: LengthUnit): number {
  const ratio = LENGTH_UNIT_METRES[from] / LENGTH_UNIT_METRES[to];
  return value * ratio * ratio;
}

/** Convert a volume (unit³) between two length-unit bases. */
export function convertVolume(value: number, from: LengthUnit, to: LengthUnit): number {
  const ratio = LENGTH_UNIT_METRES[from] / LENGTH_UNIT_METRES[to];
  return value * ratio * ratio * ratio;
}

/**
 * Scale calibration (#188). The estimator draws a line along a known
 * dimension and types what it really is; the result is how many geometry
 * units make one `unit` of the real building.
 *
 * Throws on a degenerate calibration rather than returning Infinity: a scale
 * of zero silently makes every quantity on the sheet infinite, which is the
 * kind of error that survives all the way to a tender.
 */
export function calibrateScale(a: {
  /** the length of the drawn reference in geometry (sheet) units */
  drawnLength: number;
  /** what that reference measures on the real building */
  realLength: number;
  unit: LengthUnit;
}): { pixelsPerUnit: number; scaleUnit: LengthUnit; label: string } {
  if (!(a.drawnLength > 0) || !Number.isFinite(a.drawnLength)) {
    throw new Error("Calibration needs a positive drawn length");
  }
  if (!(a.realLength > 0) || !Number.isFinite(a.realLength)) {
    throw new Error("Calibration needs a positive real length");
  }
  const pixelsPerUnit = a.drawnLength / a.realLength;
  return {
    pixelsPerUnit,
    scaleUnit: a.unit,
    label: `${round(a.drawnLength, 3)} drawn = ${round(a.realLength, 3)} ${a.unit}`,
  };
}

/**
 * Calibration from a printed ratio scale ("1:50") on a sheet whose geometry
 * units are millimetres of paper. `paperUnitsPerMm` lets a caller whose
 * geometry is in points or pixels state the conversion.
 */
export function calibrateFromRatio(a: {
  /** the "50" in 1:50 */
  ratio: number;
  unit: LengthUnit;
  /** geometry units per millimetre of paper (1 for mm, 72/25.4 for points) */
  paperUnitsPerMm?: number;
}): { pixelsPerUnit: number; scaleUnit: LengthUnit; label: string } {
  if (!(a.ratio > 0) || !Number.isFinite(a.ratio)) {
    throw new Error("A ratio scale must be positive");
  }
  const perMm = a.paperUnitsPerMm ?? 1;
  if (!(perMm > 0) || !Number.isFinite(perMm)) {
    throw new Error("paperUnitsPerMm must be positive");
  }
  // 1 mm of paper = `ratio` mm of building = ratio × 0.001 m
  const metresPerPaperUnit = (a.ratio * 0.001) / perMm;
  const unitsPerPaperUnit = metresPerPaperUnit / LENGTH_UNIT_METRES[a.unit];
  return {
    pixelsPerUnit: 1 / unitsPerPaperUnit,
    scaleUnit: a.unit,
    label: `1:${round(a.ratio, 3)}`,
  };
}

export function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round((value + Number.EPSILON) * f) / f;
}

const round4 = (v: number): number => round(v, 4);

function isFinitePoint(p: Point | undefined): p is Point {
  return p !== undefined && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** Total length of a polyline, adding the closing leg when `closed`. */
export function polylineLength(points: Point[], closed = false): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (!isFinitePoint(a) || !isFinitePoint(b)) continue;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  if (closed && points.length > 2) {
    const first = points[0];
    const last = points[points.length - 1];
    if (isFinitePoint(first) && isFinitePoint(last)) {
      total += Math.hypot(first.x - last.x, first.y - last.y);
    }
  }
  return total;
}

/**
 * Shoelace area of a simple polygon, sign discarded — a takeoff drawn
 * clockwise is the same wall as one drawn anticlockwise.
 */
export function polygonArea(points: Point[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!isFinitePoint(a) || !isFinitePoint(b)) continue;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function polygonPerimeter(points: Point[]): number {
  return polylineLength(points, true);
}

/** The two corners of a rectangle expanded into four vertices. */
export function rectanglePoints(points: Point[]): Point[] {
  if (points.length >= 4) return points;
  const a = points[0];
  const b = points[1];
  if (!isFinitePoint(a) || !isFinitePoint(b)) return [];
  return [
    { x: a.x, y: a.y },
    { x: b.x, y: a.y },
    { x: b.x, y: b.y },
    { x: a.x, y: b.y },
  ];
}

export interface GeometryMeasure {
  /** length in geometry units (a perimeter for closed shapes) */
  length: number;
  /** area in geometry units² — 0 for shapes that enclose nothing */
  area: number;
  /** number of marks — the count measure */
  count: number;
  warnings: string[];
}

/** Measure a geometry in its own coordinate space, before any scale. */
export function measureGeometry(geometry: Geometry | null | undefined): GeometryMeasure {
  const warnings: string[] = [];
  if (!geometry) return { length: 0, area: 0, count: 0, warnings: ["No geometry was recorded."] };
  const points = Array.isArray(geometry.points) ? geometry.points.filter(isFinitePoint) : [];
  if (points.length !== (geometry.points?.length ?? 0)) {
    warnings.push("Some vertices were not finite numbers and were ignored.");
  }
  switch (geometry.kind) {
    case "circle": {
      const centre = points[0];
      const r = geometry.radius ?? 0;
      if (!isFinitePoint(centre) || !(r > 0)) {
        warnings.push("A circle needs a centre point and a positive radius.");
        return { length: 0, area: 0, count: 0, warnings };
      }
      return { length: 2 * Math.PI * r, area: Math.PI * r * r, count: 1, warnings };
    }
    case "rectangle": {
      const rect = rectanglePoints(points);
      if (rect.length < 4) {
        warnings.push("A rectangle needs two opposite corners.");
        return { length: 0, area: 0, count: 0, warnings };
      }
      return {
        length: polygonPerimeter(rect),
        area: polygonArea(rect),
        count: 1,
        warnings,
      };
    }
    case "polygon": {
      if (points.length < 3) warnings.push("A polygon needs at least three vertices.");
      return {
        length: polygonPerimeter(points),
        area: polygonArea(points),
        count: 1,
        warnings,
      };
    }
    case "points": {
      if (points.length === 0) warnings.push("No marks were placed.");
      return { length: 0, area: 0, count: points.length, warnings };
    }
    case "polyline":
    default: {
      if (geometry.kind !== "polyline") {
        warnings.push(`Unknown geometry kind "${geometry.kind}"; measured as a polyline.`);
      }
      if (points.length < 2) warnings.push("A polyline needs at least two vertices.");
      const closed = geometry.closed === true;
      return {
        length: polylineLength(points, closed),
        area: closed ? polygonArea(points) : 0,
        count: 1,
        warnings,
      };
    }
  }
}

export interface TakeoffInput {
  measurementType: TakeoffMeasurementType;
  geometry?: Geometry | null;
  /** geometry units per one `scaleUnit`; null = uncalibrated */
  pixelsPerUnit?: number | null;
  scaleUnit?: LengthUnit | null;
  /** volume depth, in `scaleUnit` */
  depth?: number | null;
  /** wall height for a linear run measured as an area, in `scaleUnit` */
  height?: number | null;
  /** openings and the like, in the derived quantity unit */
  deduction?: number | null;
  /** repeats of the same shape (typical floors) */
  multiplier?: number | null;
  /**
   * A quantity typed rather than drawn. When set the geometry is ignored for
   * the raw measure — a legitimate takeoff ("32 doors, counted on site") that
   * must still carry its factors and its unit.
   */
  manualRawValue?: number | null;
  /** override the derived unit (e.g. "m2" measured but priced in "sf") */
  unit?: string | null;
}

export interface TakeoffMeasurement {
  /** the geometric measure in building units, before factors */
  rawValue: number;
  /** rawValue × multiplier × depth/height − deduction */
  quantity: number;
  /** perimeter of an area measure, in the scale unit; null when meaningless */
  perimeter: number | null;
  unit: string;
  /** every step of the arithmetic, in order, for the drawer's "why" panel */
  basis: string[];
  warnings: string[];
}

/**
 * Turn a drawn shape into a priced quantity.
 *
 * The arithmetic is deliberately explicit rather than clever, and every step
 * is pushed onto `basis` so the workspace can print the derivation next to
 * the number instead of asking the reader to trust it.
 */
export function computeTakeoff(input: TakeoffInput): TakeoffMeasurement {
  const warnings: string[] = [];
  const basis: string[] = [];
  const scaleUnit = input.scaleUnit ?? null;
  const unit = input.unit ?? derivedUnit(input.measurementType, scaleUnit);
  const multiplier =
    input.multiplier === null || input.multiplier === undefined ? 1 : input.multiplier;
  const deduction = input.deduction ?? 0;

  if (!Number.isFinite(multiplier) || multiplier < 0) {
    warnings.push("The repeat multiplier was not a non-negative number; 1 was used.");
  }
  const mult = Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : 1;

  const geo = measureGeometry(input.geometry);
  warnings.push(...geo.warnings);

  const scale = input.pixelsPerUnit ?? null;
  const calibrated = scale !== null && Number.isFinite(scale) && scale > 0;
  if (!calibrated && input.manualRawValue === null) {
    // manualRawValue undefined is "not supplied"; null is an explicit no.
  }
  if (input.manualRawValue === null || input.manualRawValue === undefined) {
    if (!calibrated && input.measurementType !== "count") {
      warnings.push(
        "The sheet is not calibrated, so the measure is in drawing units, not building units. Calibrate the sheet (#188) before pricing this line.",
      );
    }
    if (scale !== null && !calibrated) {
      warnings.push("The recorded scale was not a positive number and was ignored.");
    }
  }

  /* --- raw measure in building units ------------------------------------ */
  let rawValue: number;
  if (input.manualRawValue !== null && input.manualRawValue !== undefined) {
    rawValue = Number.isFinite(input.manualRawValue) ? input.manualRawValue : 0;
    basis.push(`Entered directly: ${round4(rawValue)} ${unit}.`);
  } else if (input.measurementType === "count") {
    rawValue = geo.count;
    basis.push(`Counted ${geo.count} mark${geo.count === 1 ? "" : "s"}.`);
  } else {
    const divisor = calibrated && scale !== null ? scale : 1;
    if (input.measurementType === "linear") {
      rawValue = geo.length / divisor;
      basis.push(
        `Drawn length ${round4(geo.length)} ÷ scale ${round4(divisor)} = ${round4(rawValue)} ${unit}.`,
      );
    } else if (input.measurementType === "area") {
      const height = input.height ?? null;
      if (geo.area > 0) {
        rawValue = geo.area / (divisor * divisor);
        basis.push(
          `Drawn area ${round4(geo.area)} ÷ scale² ${round4(divisor * divisor)} = ${round4(rawValue)} ${unit}.`,
        );
      } else if (height !== null && Number.isFinite(height) && height > 0) {
        const runLength = geo.length / divisor;
        rawValue = runLength * height;
        basis.push(
          `Run ${round4(runLength)} × height ${round4(height)} = ${round4(rawValue)} ${unit}.`,
        );
      } else {
        rawValue = 0;
        warnings.push(
          "An area measure needs an enclosing shape, or a run plus a height. Neither was recorded.",
        );
      }
    } else {
      const depth = input.depth ?? null;
      const height = input.height ?? null;
      const areaUnits = geo.area > 0 ? geo.area / (divisor * divisor) : null;
      if (areaUnits !== null && depth !== null && Number.isFinite(depth) && depth > 0) {
        rawValue = areaUnits * depth;
        basis.push(
          `Area ${round4(areaUnits)} × depth ${round4(depth)} = ${round4(rawValue)} ${unit}.`,
        );
      } else if (
        geo.length > 0 &&
        depth !== null &&
        Number.isFinite(depth) &&
        depth > 0 &&
        height !== null &&
        Number.isFinite(height) &&
        height > 0
      ) {
        const runLength = geo.length / divisor;
        rawValue = runLength * depth * height;
        basis.push(
          `Run ${round4(runLength)} × width ${round4(depth)} × height ${round4(height)} = ${round4(rawValue)} ${unit}.`,
        );
      } else {
        rawValue = 0;
        warnings.push(
          "A volume measure needs an area plus a depth, or a run plus a width and a height. The inputs recorded do not make one.",
        );
      }
    }
  }

  /* --- factors ---------------------------------------------------------- */
  let quantity = rawValue * mult;
  if (mult !== 1) basis.push(`× ${round4(mult)} repeat${mult === 1 ? "" : "s"} = ${round4(quantity)} ${unit}.`);
  if (deduction !== 0 && Number.isFinite(deduction)) {
    quantity -= deduction;
    basis.push(`− ${round4(deduction)} ${unit} deducted = ${round4(quantity)} ${unit}.`);
  }
  if (quantity < 0) {
    warnings.push(
      "The deduction exceeds the measure, so the quantity is negative. Check the openings recorded.",
    );
  }

  /* --- perimeter -------------------------------------------------------- */
  let perimeter: number | null = null;
  if (input.measurementType === "area" && geo.area > 0) {
    const divisor = calibrated && scale !== null ? scale : 1;
    perimeter = round4((geo.length / divisor) * mult);
  }

  return {
    rawValue: round4(rawValue),
    quantity: round4(quantity),
    perimeter,
    unit,
    basis,
    warnings: warnings.filter((w, i, all) => all.indexOf(w) === i),
  };
}
