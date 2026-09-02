/**
 * SITE PLAN DATA (spec Vol I §2.15 #471–478).
 *
 * There is no tile server and the content-security policy is self-only, so
 * the site plan is drawn from the project's OWN points in an equirectangular
 * projection: exclusion zones (rings and radii), survey control, geotechnical
 * holes, buried service routes, utility strikes, gate reads that carried a
 * position, and environmental events with a sensor location.
 *
 * The endpoint returns the bounds and the features; the client draws them.
 * A project whose records carry no coordinates gets an empty feature list and
 * a reason — never an arbitrary centre point.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import {
  projects,
  siteEnvironmentalEvents,
  siteExclusionZones,
  siteGateEvents,
  siteGeotechInvestigations,
  siteSurveyPoints,
  siteUtilityServices,
  siteUtilityStrikes,
} from "@constructos/db";
import { bounds, ringCentroid, type Point } from "../engines/geometry.js";
import { buildGates, isoTimestampSchema, nowISO } from "../shared.js";

export interface MapPoint {
  id: string;
  layer: string;
  label: string;
  lat: number;
  lon: number;
  status?: string | null;
  severity?: string | null;
  detail?: string | null;
}

export interface MapShape {
  id: string;
  layer: string;
  label: string;
  kind: "ring" | "circle" | "line";
  ring?: Array<[number, number]>;
  centreLat?: number | null;
  centreLon?: number | null;
  radiusM?: number | null;
  status?: string | null;
  severity?: string | null;
}

export const mapRoutes: FastifyPluginAsync = async (app) => {
  const { readGate } = buildGates(app);

  app.get("/projects/:projectId/site/map", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const companyId = req.companyId!;
    const q = z
      .object({ since: isoTimestampSchema.optional(), gateLimit: z.coerce.number().int().min(0).max(2000).default(300) })
      .parse(req.query);
    const since = q.since ?? new Date(Date.now() - 7 * 86_400_000).toISOString();

    const [project, zones, points, holes, services, strikes, gateReads, envEvents] = await Promise.all([
      app.db
        .select({ id: projects.id, name: projects.name, latitude: projects.latitude, longitude: projects.longitude })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
        .limit(1),
      app.db
        .select()
        .from(siteExclusionZones)
        .where(
          and(
            eq(siteExclusionZones.companyId, companyId),
            eq(siteExclusionZones.projectId, projectId),
            inArray(siteExclusionZones.status, ["planned", "active"]),
          ),
        )
        .limit(2000),
      app.db
        .select()
        .from(siteSurveyPoints)
        .where(and(eq(siteSurveyPoints.companyId, companyId), eq(siteSurveyPoints.projectId, projectId)))
        .limit(5000),
      app.db
        .select()
        .from(siteGeotechInvestigations)
        .where(and(eq(siteGeotechInvestigations.companyId, companyId), eq(siteGeotechInvestigations.projectId, projectId)))
        .limit(5000),
      app.db
        .select()
        .from(siteUtilityServices)
        .where(and(eq(siteUtilityServices.companyId, companyId), eq(siteUtilityServices.projectId, projectId)))
        .limit(2000),
      app.db
        .select()
        .from(siteUtilityStrikes)
        .where(and(eq(siteUtilityStrikes.companyId, companyId), eq(siteUtilityStrikes.projectId, projectId)))
        .limit(2000),
      q.gateLimit === 0
        ? []
        : app.db
            .select({
              id: siteGateEvents.id,
              lat: siteGateEvents.lat,
              lon: siteGateEvents.lon,
              personName: siteGateEvents.personName,
              direction: siteGateEvents.direction,
              occurredAt: siteGateEvents.occurredAt,
              gateName: siteGateEvents.gateName,
              accepted: siteGateEvents.accepted,
            })
            .from(siteGateEvents)
            .where(
              and(
                eq(siteGateEvents.companyId, companyId),
                eq(siteGateEvents.projectId, projectId),
                gte(siteGateEvents.occurredAt, since),
                isNotNull(siteGateEvents.lat),
              ),
            )
            .orderBy(desc(siteGateEvents.occurredAt))
            .limit(q.gateLimit),
      app.db
        .select()
        .from(siteEnvironmentalEvents)
        .where(and(eq(siteEnvironmentalEvents.companyId, companyId), eq(siteEnvironmentalEvents.projectId, projectId)))
        .limit(2000),
    ]);

    const mapPoints: MapPoint[] = [];
    const shapes: MapShape[] = [];
    const reasons: string[] = [];

    for (const zone of zones) {
      const ring = zone.ring ?? [];
      if (ring.length >= 3) {
        shapes.push({
          id: zone.id,
          layer: "zone",
          label: zone.name,
          kind: "ring",
          ring,
          status: zone.status,
          severity: zone.severity,
        });
        const centre = ringCentroid(ring);
        if (centre) {
          mapPoints.push({ id: `${zone.id}-c`, layer: "zone_label", label: zone.name, lat: centre.lat, lon: centre.lon, status: zone.status });
        }
      } else if (zone.centreLat !== null && zone.centreLon !== null && zone.radiusM !== null) {
        shapes.push({
          id: zone.id,
          layer: "zone",
          label: zone.name,
          kind: "circle",
          centreLat: zone.centreLat,
          centreLon: zone.centreLon,
          radiusM: zone.radiusM,
          status: zone.status,
          severity: zone.severity,
        });
      } else {
        reasons.push(`Exclusion zone "${zone.name}" has neither a ring nor a centre and radius, so it cannot be drawn.`);
      }
    }

    for (const point of points) {
      if (point.lat === null || point.lon === null) continue;
      mapPoints.push({
        id: point.id,
        layer: "survey",
        label: point.pointRef,
        lat: point.lat,
        lon: point.lon,
        status: point.status,
        detail: `${point.kind}${point.accuracyMm !== null ? ` · ±${point.accuracyMm} mm` : ""}`,
      });
    }
    const surveyWithoutGeo = points.filter((p) => p.lat === null || p.lon === null).length;
    if (surveyWithoutGeo > 0) {
      reasons.push(
        `${surveyWithoutGeo} survey point(s) carry grid coordinates but no latitude/longitude, so they cannot be placed on this plan. The plan does not convert between coordinate systems.`,
      );
    }

    for (const hole of holes) {
      if (hole.lat === null || hole.lon === null) continue;
      mapPoints.push({
        id: hole.id,
        layer: "geotech",
        label: hole.holeRef,
        lat: hole.lat,
        lon: hole.lon,
        status: hole.isBaseline === 1 ? "baseline" : hole.status,
        detail: hole.depthM !== null ? `${hole.depthM} m deep` : null,
      });
    }

    for (const service of services) {
      const route = service.route ?? [];
      if (route.length >= 2) {
        shapes.push({
          id: service.id,
          layer: "utility",
          label: `${service.serviceRef} — ${service.utilityType}`,
          kind: "line",
          ring: route,
          status: service.status,
          severity: service.confidence,
        });
      }
    }

    for (const strike of strikes) {
      if (strike.lat === null || strike.lon === null) continue;
      mapPoints.push({
        id: strike.id,
        layer: "strike",
        label: strike.reference,
        lat: strike.lat,
        lon: strike.lon,
        severity: strike.severity,
        status: strike.status,
        detail: `${strike.utilityType} · ${strike.severity.replace(/_/g, " ")}`,
      });
    }

    for (const read of gateReads) {
      if (read.lat === null || read.lon === null) continue;
      mapPoints.push({
        id: read.id,
        layer: "gate",
        label: read.personName ?? read.gateName,
        lat: read.lat,
        lon: read.lon,
        status: read.accepted === 1 ? read.direction : "refused",
        detail: read.occurredAt,
      });
    }

    for (const event of envEvents) {
      if (event.lat === null || event.lon === null) continue;
      mapPoints.push({
        id: event.id,
        layer: "environment",
        label: event.reference,
        lat: event.lat,
        lon: event.lon,
        severity: event.severity,
        status: event.status,
        detail: `${event.category}${event.exceededThreshold === 1 ? " · threshold exceeded" : ""}`,
      });
    }

    const site = project[0];
    if (site && site.latitude !== null && site.longitude !== null) {
      mapPoints.push({ id: `${projectId}-site`, layer: "project", label: site.name, lat: site.latitude, lon: site.longitude });
    }

    const all: Point[] = [
      ...mapPoints.map((p) => ({ lat: p.lat, lon: p.lon })),
      ...shapes.flatMap((s) =>
        s.kind === "circle"
          ? typeof s.centreLat === "number" && typeof s.centreLon === "number"
            ? [{ lat: s.centreLat, lon: s.centreLon }]
            : []
          : (s.ring ?? []).map(([lon, lat]) => ({ lat, lon })),
      ),
    ];
    const extent = bounds(all);
    if (extent === null) {
      reasons.push(
        "Nothing on this site carries a position yet. The plan draws the project's own records — zones, control points, boreholes, service routes, strikes and located gate reads — so it stays empty until one of them has coordinates.",
      );
    }

    const byLayer: Record<string, number> = {};
    for (const p of mapPoints) byLayer[p.layer] = (byLayer[p.layer] ?? 0) + 1;
    for (const s of shapes) byLayer[s.layer] = (byLayer[s.layer] ?? 0) + 1;

    return {
      asOf: nowISO(),
      projectName: site?.name ?? null,
      bounds: extent,
      points: mapPoints,
      shapes,
      byLayer,
      gateWindowFrom: since,
      reasons,
    };
  });
};
