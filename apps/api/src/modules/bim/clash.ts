/**
 * Geometric clash detection (spec #240) — pure, deterministic.
 *
 * Broad phase only, and honest about it: every element carries an
 * axis-aligned bounding box computed at ingestion from its placement chain
 * and declared quantities. Two boxes that interpenetrate by more than the
 * test tolerance are a hard clash; two that are closer than the required
 * clearance without touching are a clearance clash; two of the same type
 * occupying the same box are a duplicate.
 *
 * WHY NOT TRIANGLE-TRIANGLE. Narrow-phase interference needs tessellated
 * geometry, which needs an IFC geometry kernel in the worker. Until that
 * exists, this engine reports what a bounding-box pass can actually support
 * and every result says so (`method`), rather than dressing an approximation
 * up as a precise penetration depth. Elements with no extents are counted and
 * reported as excluded — never silently dropped.
 *
 * Complexity: a uniform spatial hash keyed on the clearance-expanded cell
 * size, so a 200k-element federation does not become 2·10^10 comparisons.
 */

export interface ClashBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface ClashElement {
  globalId: string;
  ifcType: string;
  name: string | null;
  discipline: string | null;
  modelVersionId: string | null;
  storey: string | null;
  bounds: ClashBounds | null;
}

export interface ClashOptions {
  /** minimum interpenetration, millimetres, before a hard clash is reported */
  toleranceMm: number;
  /** required clear space, millimetres; 0 disables clearance testing */
  clearanceMm: number;
  /** safety cap on reported hits so one bad pairing cannot flood the register */
  maxHits?: number;
}

export interface ClashHit {
  fingerprint: string;
  kind: "hard" | "clearance" | "duplicate";
  a: ClashElement;
  b: ClashElement;
  /** smallest overlap across the three axes, millimetres (hard/duplicate) */
  penetrationMm: number | null;
  /** gap between the boxes, millimetres (clearance) */
  distanceMm: number | null;
  overlapVolume: number | null;
  centroid: { x: number; y: number; z: number };
  storey: string | null;
}

export interface ClashRun {
  hits: ClashHit[];
  comparedPairs: number;
  /** elements excluded because they carry no extents */
  skippedNoBounds: number;
  elementsLeft: number;
  elementsRight: number;
  truncated: boolean;
  method: "aabb_broad_phase";
}

const MM = 1000;

/** Stable identity of a clash: the unordered GlobalId pair. */
export function clashFingerprint(a: string, b: string): string {
  const [first, second] = a <= b ? [a, b] : [b, a];
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const key = `${first}|${second}`;
  for (let i = 0; i < key.length; i += 1) {
    h1 = Math.imul(h1 ^ key.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 + key.charCodeAt(i) * (i + 1), 2246822519) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

function overlapAxis(aMin: number, aMax: number, bMin: number, bMax: number): number {
  return Math.min(aMax, bMax) - Math.max(aMin, bMin);
}

function centre(a: ClashBounds, b: ClashBounds): { x: number; y: number; z: number } {
  return {
    x: (Math.max(a.minX, b.minX) + Math.min(a.maxX, b.maxX)) / 2,
    y: (Math.max(a.minY, b.minY) + Math.min(a.maxY, b.maxY)) / 2,
    z: (Math.max(a.minZ, b.minZ) + Math.min(a.maxZ, b.maxZ)) / 2,
  };
}

function nearlyIdentical(a: ClashBounds, b: ClashBounds, tolM: number): boolean {
  return (
    Math.abs(a.minX - b.minX) <= tolM &&
    Math.abs(a.minY - b.minY) <= tolM &&
    Math.abs(a.minZ - b.minZ) <= tolM &&
    Math.abs(a.maxX - b.maxX) <= tolM &&
    Math.abs(a.maxY - b.maxY) <= tolM &&
    Math.abs(a.maxZ - b.maxZ) <= tolM
  );
}

/** Classify one pair; null when they neither touch nor come within clearance. */
export function classifyPair(
  a: ClashElement,
  b: ClashElement,
  options: ClashOptions,
): ClashHit | null {
  const ab = a.bounds;
  const bb = b.bounds;
  if (!ab || !bb) return null;
  const tolM = options.toleranceMm / MM;
  const clearM = options.clearanceMm / MM;

  const ox = overlapAxis(ab.minX, ab.maxX, bb.minX, bb.maxX);
  const oy = overlapAxis(ab.minY, ab.maxY, bb.minY, bb.maxY);
  const oz = overlapAxis(ab.minZ, ab.maxZ, bb.minZ, bb.maxZ);

  if (ox > 0 && oy > 0 && oz > 0) {
    const penetration = Math.min(ox, oy, oz);
    if (penetration <= tolM) return null;
    const duplicate = a.ifcType === b.ifcType && nearlyIdentical(ab, bb, tolM);
    return {
      fingerprint: clashFingerprint(a.globalId, b.globalId),
      kind: duplicate ? "duplicate" : "hard",
      a,
      b,
      penetrationMm: penetration * MM,
      distanceMm: null,
      overlapVolume: ox * oy * oz,
      centroid: centre(ab, bb),
      storey: a.storey ?? b.storey ?? null,
    };
  }

  if (clearM <= 0) return null;
  // separation: the largest positive gap across the axes
  const gapX = Math.max(0, -ox);
  const gapY = Math.max(0, -oy);
  const gapZ = Math.max(0, -oz);
  const gap = Math.sqrt(gapX * gapX + gapY * gapY + gapZ * gapZ);
  if (gap > clearM) return null;
  return {
    fingerprint: clashFingerprint(a.globalId, b.globalId),
    kind: "clearance",
    a,
    b,
    penetrationMm: null,
    distanceMm: gap * MM,
    overlapVolume: null,
    centroid: {
      x: (ab.minX + ab.maxX + bb.minX + bb.maxX) / 4,
      y: (ab.minY + ab.maxY + bb.minY + bb.maxY) / 4,
      z: (ab.minZ + ab.maxZ + bb.minZ + bb.maxZ) / 4,
    },
    storey: a.storey ?? b.storey ?? null,
  };
}

function cellKeys(bounds: ClashBounds, cell: number, pad: number): string[] {
  const keys: string[] = [];
  const x0 = Math.floor((bounds.minX - pad) / cell);
  const x1 = Math.floor((bounds.maxX + pad) / cell);
  const y0 = Math.floor((bounds.minY - pad) / cell);
  const y1 = Math.floor((bounds.maxY + pad) / cell);
  const z0 = Math.floor((bounds.minZ - pad) / cell);
  const z1 = Math.floor((bounds.maxZ + pad) / cell);
  // guard against a degenerate model where one element spans the whole site
  const spanCap = 12;
  for (let x = x0; x <= Math.min(x1, x0 + spanCap); x += 1) {
    for (let y = y0; y <= Math.min(y1, y0 + spanCap); y += 1) {
      for (let z = z0; z <= Math.min(z1, z0 + spanCap); z += 1) {
        keys.push(`${x}:${y}:${z}`);
      }
    }
  }
  return keys;
}

/**
 * Run a clash test between two element sets. Passing the same array twice
 * performs an all-pairs test within one set; a pair is never reported twice
 * and an element never clashes with itself.
 */
export function detectClashes(
  left: ClashElement[],
  right: ClashElement[],
  options: ClashOptions,
): ClashRun {
  const maxHits = options.maxHits ?? 5000;
  const withBounds = (list: ClashElement[]) => list.filter((e) => e.bounds !== null);
  const l = withBounds(left);
  const r = withBounds(right);
  const skippedNoBounds = left.length - l.length + (right.length - r.length);

  const clearM = Math.max(0, options.clearanceMm) / MM;
  const cell = Math.max(1, clearM * 2, 2);
  const grid = new Map<string, number[]>();
  r.forEach((el, index) => {
    for (const key of cellKeys(el.bounds!, cell, clearM)) {
      const bucket = grid.get(key);
      if (bucket) bucket.push(index);
      else grid.set(key, [index]);
    }
  });

  const hits: ClashHit[] = [];
  const seen = new Set<string>();
  let comparedPairs = 0;
  let truncated = false;

  outer: for (const a of l) {
    const candidates = new Set<number>();
    for (const key of cellKeys(a.bounds!, cell, clearM)) {
      const bucket = grid.get(key);
      if (!bucket) continue;
      for (const index of bucket) candidates.add(index);
    }
    for (const index of candidates) {
      const b = r[index]!;
      if (b.globalId === a.globalId) continue;
      const fingerprint = clashFingerprint(a.globalId, b.globalId);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      comparedPairs += 1;
      const hit = classifyPair(a, b, options);
      if (!hit) continue;
      hits.push(hit);
      if (hits.length >= maxHits) {
        truncated = true;
        break outer;
      }
    }
  }

  hits.sort((x, y) => {
    const px = x.penetrationMm ?? -(x.distanceMm ?? 0);
    const py = y.penetrationMm ?? -(y.distanceMm ?? 0);
    if (px !== py) return py - px;
    return x.fingerprint < y.fingerprint ? -1 : 1;
  });

  return {
    hits,
    comparedPairs,
    skippedNoBounds,
    elementsLeft: l.length,
    elementsRight: r.length,
    truncated,
    method: "aabb_broad_phase",
  };
}
