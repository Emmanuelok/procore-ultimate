/**
 * Geofence geometry (spec #471-475) - pure, no PostGIS.
 *
 * A geofence is a closed ring of [longitude, latitude] pairs. Containment is
 * a ray-cast in degrees, which is correct for the site-scale polygons this is
 * used for (a few hundred metres) and does not pretend to be geodesic. Areas
 * and distances are reported in metres using an equirectangular approximation
 * around the ring's own latitude, and the approximation is stated wherever a
 * figure is returned.
 */

export type Point = [number, number]; // [longitude, latitude]

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/** Is a ring usable? At least three distinct points and finite coordinates. */
export function isValidRing(ring: Point[]): boolean {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  return ring.every(
    (p) =>
      Array.isArray(p) &&
      p.length === 2 &&
      Number.isFinite(p[0]) &&
      Number.isFinite(p[1]) &&
      p[0] >= -180 &&
      p[0] <= 180 &&
      p[1] >= -90 &&
      p[1] <= 90,
  );
}

/**
 * Ray-cast point-in-polygon. Points exactly on an edge are treated as inside,
 * because a worker standing on the boundary of an exclusion zone is in it.
 */
export function pointInRing(point: Point, ring: Point[]): boolean {
  if (!isValidRing(ring)) return false;
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    // on-edge test (collinear and within the segment's bounding box)
    const cross = (xj - xi) * (y - yi) - (yj - yi) * (x - xi);
    if (Math.abs(cross) < 1e-12) {
      const withinX = x >= Math.min(xi, xj) - 1e-12 && x <= Math.max(xi, xj) + 1e-12;
      const withinY = y >= Math.min(yi, yj) - 1e-12 && y <= Math.max(yi, yj) + 1e-12;
      if (withinX && withinY) return true;
    }
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Bounding box of a ring: [west, south, east, north]. */
export function ringBounds(ring: Point[]): [number, number, number, number] | null {
  if (!isValidRing(ring)) return null;
  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  for (const [lng, lat] of ring) {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [west, south, east, north];
}

/**
 * Planar area in square metres (equirectangular projection at the ring's mean
 * latitude). Good to a fraction of a percent at site scale; not a geodesic
 * area, and labelled as approximate wherever it is shown.
 */
export function ringAreaM2(ring: Point[]): number | null {
  if (!isValidRing(ring)) return null;
  const meanLat = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
  const mPerLng = EARTH_RADIUS_M * DEG * Math.cos(meanLat * DEG);
  const mPerLat = EARTH_RADIUS_M * DEG;
  let twiceArea = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    twiceArea += (xj * mPerLng) * (yi * mPerLat) - (xi * mPerLng) * (yj * mPerLat);
  }
  return Math.abs(twiceArea / 2);
}

/** Great-circle distance in metres (haversine). */
export function distanceM(a: Point, b: Point): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface GeoFeature {
  id: string;
  kind: string;
  label: string;
  latitude: number;
  longitude: number;
  at?: string | null;
  meta?: Record<string, unknown>;
}

/** Assign features to the geofences that contain them (#472-475). */
export function assignToFences(
  features: GeoFeature[],
  fences: Array<{ id: string; name: string; ring: Point[] }>,
): {
  byFence: Record<string, string[]>;
  fenceOfFeature: Record<string, string[]>;
  outside: string[];
} {
  const byFence: Record<string, string[]> = {};
  const fenceOfFeature: Record<string, string[]> = {};
  const outside: string[] = [];
  for (const fence of fences) byFence[fence.id] = [];
  for (const feature of features) {
    const hits: string[] = [];
    for (const fence of fences) {
      if (pointInRing([feature.longitude, feature.latitude], fence.ring)) {
        hits.push(fence.id);
        byFence[fence.id]!.push(feature.id);
      }
    }
    if (hits.length === 0) outside.push(feature.id);
    else fenceOfFeature[feature.id] = hits;
  }
  return { byFence, fenceOfFeature, outside };
}
