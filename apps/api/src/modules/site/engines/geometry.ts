/**
 * Site geometry — the small amount of computational geometry site operations
 * needs, kept pure so it can be tested exhaustively (spec Vol I §2.15
 * #471–478; Vol II Z #1072 exclusion zones).
 *
 * There is no tile server and no external geometry library: an exclusion zone
 * is a closed ring of [lon, lat] pairs and "is this person inside it" is a
 * ray-casting test. Distances use the haversine formula on a spherical earth,
 * which is accurate to ~0.5% — far better than the metre-scale positions a
 * phone or a turnstile reports, and stated rather than implied.
 *
 * What it deliberately does not do: reproject coordinates, handle polygons
 * that cross the antimeridian, or model altitude.
 */

export type Point = { lat: number; lon: number };
export type Ring = Array<[number, number]>; // [lon, lat]

export const EARTH_RADIUS_M = 6_371_008.8;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in metres between two points. */
export function haversineMetres(a: Point, b: Point): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A ring with its first vertex repeated at the end removed — rings are
 *  stored either way and every routine here treats them as implicitly closed. */
export function normaliseRing(ring: Ring): Ring {
  if (ring.length < 2) return [...ring];
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  return [...ring];
}

/**
 * Ray casting (even-odd rule) with the boundary treated as INSIDE: a person
 * standing on the line of a lifting exclusion zone is in it. Points exactly on
 * a vertex or edge return true; everything else follows the crossing count.
 */
export function pointInRing(point: Point, ring: Ring): boolean {
  const poly = normaliseRing(ring);
  if (poly.length < 3) return false;
  const { lon: x, lat: y } = point;

  // Boundary first — the crossing test is unreliable exactly on an edge.
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (onSegment(x, y, a[0], a[1], b[0], b[1])) return true;
  }

  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function onSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): boolean {
  const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  if (Math.abs(cross) > 1e-12) return false;
  const withinX = px >= Math.min(ax, bx) - 1e-12 && px <= Math.max(ax, bx) + 1e-12;
  const withinY = py >= Math.min(ay, by) - 1e-12 && py <= Math.max(ay, by) + 1e-12;
  return withinX && withinY;
}

export interface ZoneShape {
  id: string;
  name: string;
  ring: Ring;
  centreLat: number | null;
  centreLon: number | null;
  radiusM: number | null;
}

export interface ZoneHit {
  zoneId: string;
  zoneName: string;
  test: "ring" | "radius";
  /** metres inside the boundary for a radius zone; null for a ring test */
  distanceM: number | null;
}

/**
 * Which of these zones contains the point. A zone with neither a usable ring
 * (3+ vertices) nor a centre+radius is skipped and named in `unusable` — it is
 * never silently treated as "not containing".
 */
export function zonesContaining(
  point: Point,
  zones: readonly ZoneShape[],
): { hits: ZoneHit[]; unusable: string[] } {
  const hits: ZoneHit[] = [];
  const unusable: string[] = [];
  for (const zone of zones) {
    const ring = normaliseRing(zone.ring ?? []);
    if (ring.length >= 3) {
      if (pointInRing(point, ring)) {
        hits.push({ zoneId: zone.id, zoneName: zone.name, test: "ring", distanceM: null });
      }
      continue;
    }
    if (
      typeof zone.centreLat === "number" &&
      typeof zone.centreLon === "number" &&
      typeof zone.radiusM === "number" &&
      zone.radiusM > 0
    ) {
      const d = haversineMetres(point, { lat: zone.centreLat, lon: zone.centreLon });
      if (d <= zone.radiusM) {
        hits.push({
          zoneId: zone.id,
          zoneName: zone.name,
          test: "radius",
          distanceM: Math.round(zone.radiusM - d),
        });
      }
      continue;
    }
    unusable.push(zone.id);
  }
  return { hits, unusable };
}

/** Axis-aligned bounds of a set of points, or null when there are none. */
export function bounds(
  points: readonly Point[],
): { minLat: number; minLon: number; maxLat: number; maxLon: number } | null {
  if (points.length === 0) return null;
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, minLon, maxLat, maxLon };
}

/** Centroid of a ring by simple vertex mean — good enough to label a zone. */
export function ringCentroid(ring: Ring): Point | null {
  const poly = normaliseRing(ring);
  if (poly.length === 0) return null;
  let lon = 0;
  let lat = 0;
  for (const [x, y] of poly) {
    lon += x;
    lat += y;
  }
  return { lat: lat / poly.length, lon: lon / poly.length };
}

/**
 * Shortest distance in metres from a point to a polyline (a buried service
 * route). Returns null when the route has fewer than two vertices — an
 * excavation cannot be "clear of" a route the platform does not hold.
 */
export function distanceToRouteM(point: Point, route: Ring): number | null {
  if (!Array.isArray(route) || route.length < 2) return null;
  let best = Infinity;
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1]!;
    const b = route[i]!;
    best = Math.min(best, distanceToSegmentM(point, { lon: a[0], lat: a[1] }, { lon: b[0], lat: b[1] }));
  }
  return Number.isFinite(best) ? Math.round(best * 10) / 10 : null;
}

function distanceToSegmentM(p: Point, a: Point, b: Point): number {
  // Local equirectangular projection: over the length of a site the error is
  // far below the metre-scale accuracy of the inputs.
  const lat0 = toRad((a.lat + b.lat) / 2);
  const mx = (lon: number) => toRad(lon) * Math.cos(lat0) * EARTH_RADIUS_M;
  const my = (lat: number) => toRad(lat) * EARTH_RADIUS_M;
  const ax = mx(a.lon);
  const ay = my(a.lat);
  const bx = mx(b.lon);
  const by = my(b.lat);
  const px = mx(p.lon);
  const py = my(p.lat);
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
