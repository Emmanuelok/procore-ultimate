/**
 * Project map and geofences (spec #471-478).
 *
 * One endpoint returns everything the map draws - the project pin, active
 * geofences, plant positions, geo-tagged photos and reality captures - plus
 * which fence each feature falls inside, evaluated in process (geo.ts) so no
 * PostGIS extension is required. Records without coordinates are counted and
 * reported as "not located" rather than silently dropped, because "3 of 40
 * photos are geo-tagged" is the honest state of most sites.
 *
 * The map itself (tiles, basemap) is a client concern; this is the data.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  equipment,
  geofences,
  photos,
  projects,
  realityCaptures,
} from "@constructos/db";
import { GEOFENCE_PURPOSES } from "@constructos/shared";
import { newId } from "../../../lib/ids.js";
import { badRequest, notFound } from "../../../lib/errors.js";
import {
  assignToFences,
  isValidRing,
  ringAreaM2,
  ringBounds,
  type GeoFeature,
  type Point,
} from "../geo.js";
import { buildBimGates, ledger, nowISO } from "../shared.js";

const ringSchema = z
  .array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]))
  .min(3)
  .max(2000);

const geofenceCreateSchema = z.object({
  name: z.string().min(1).max(200),
  purpose: z.enum(GEOFENCE_PURPOSES).optional(),
  description: z.string().max(2000).nullable().optional(),
  ring: ringSchema,
  colour: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Expected a hex colour like #2f6fed")
    .nullable()
    .optional(),
  isActive: z.boolean().optional(),
});

const geofencePatchSchema = geofenceCreateSchema.partial();

export const mapRoutes: FastifyPluginAsync = async (app) => {
  const gates = buildBimGates(app);

  async function getFence(fenceId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(geofences)
      .where(
        and(
          eq(geofences.id, fenceId),
          eq(geofences.companyId, companyId),
          eq(geofences.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Geofence not found");
    return rows[0];
  }

  /* ---------------------------------------------------------------- */
  /* Geofences                                                         */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/geofences", { preHandler: gates.readGate }, async (req) => {
    const items = await app.db
      .select()
      .from(geofences)
      .where(
        and(eq(geofences.companyId, req.companyId!), eq(geofences.projectId, req.projectId!)),
      )
      .orderBy(desc(geofences.isActive), geofences.name)
      .limit(500);
    return {
      items: items.map((f) => ({
        ...f,
        areaM2: ringAreaM2(f.ring as Point[]),
        areaBasis: "planar approximation at the fence's mean latitude",
        bounds: ringBounds(f.ring as Point[]),
      })),
      total: items.length,
    };
  });

  app.post("/projects/:projectId/geofences", { preHandler: gates.standardGate }, async (req, reply) => {
    const body = geofenceCreateSchema.parse(req.body);
    if (!isValidRing(body.ring as Point[])) throw badRequest("Geofence ring is not a valid polygon");
    const id = newId("gfn");
    const [created] = await app.db
      .insert(geofences)
      .values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        name: body.name,
        purpose: body.purpose ?? "work_zone",
        description: body.description ?? null,
        ring: body.ring as Point[],
        colour: body.colour ?? null,
        isActive: body.isActive === false ? 0 : 1,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "geofence",
      objectId: id,
      payload: { name: body.name, purpose: body.purpose ?? "work_zone", points: body.ring.length },
    });
    return reply.status(201).send({ ...created, areaM2: ringAreaM2(body.ring as Point[]) });
  });

  app.patch(
    "/projects/:projectId/geofences/:fenceId",
    { preHandler: gates.standardGate },
    async (req) => {
      const { fenceId } = req.params as { fenceId: string };
      await getFence(fenceId, req.companyId!, req.projectId!);
      const body = geofencePatchSchema.parse(req.body);
      if (body.ring && !isValidRing(body.ring as Point[])) {
        throw badRequest("Geofence ring is not a valid polygon");
      }
      const patch: Record<string, unknown> = { updatedAt: nowISO() };
      for (const key of ["name", "purpose", "description", "ring", "colour"] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (body.isActive !== undefined) patch["isActive"] = body.isActive ? 1 : 0;
      if (Object.keys(patch).length === 1) throw badRequest("Nothing to update");
      const [updated] = await app.db
        .update(geofences)
        .set(patch)
        .where(eq(geofences.id, fenceId))
        .returning();
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "geofence",
        objectId: fenceId,
        payload: patch,
      });
      return updated;
    },
  );

  app.delete(
    "/projects/:projectId/geofences/:fenceId",
    { preHandler: gates.standardGate },
    async (req) => {
      const { fenceId } = req.params as { fenceId: string };
      const fence = await getFence(fenceId, req.companyId!, req.projectId!);
      await app.db.delete(geofences).where(eq(geofences.id, fenceId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "geofence",
        objectId: fenceId,
        payload: { name: fence.name },
        storePayload: true,
      });
      return { ok: true };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Map data (#471, #476-478)                                         */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/map", { preHandler: gates.readGate }, async (req) => {
    const q = z
      .object({
        layers: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(300),
      })
      .parse(req.query);
    const wanted = new Set(
      (q.layers ?? "equipment,photo,capture,geofence").split(",").map((s) => s.trim()),
    );
    // assets and model elements carry no coordinates of their own: they are
    // located by their spatial container, not by latitude/longitude. Asking
    // for them returns nothing, and the response says so rather than
    // returning an empty layer that looks like "there are none".
    const supported = new Set(["equipment", "photo", "capture", "geofence"]);
    const unsupportedLayers = [...wanted].filter((layer) => !supported.has(layer));

    const [projectRow] = await app.db
      .select({
        id: projects.id,
        name: projects.name,
        address: projects.address,
        city: projects.city,
        country: projects.country,
        latitude: projects.latitude,
        longitude: projects.longitude,
      })
      .from(projects)
      .where(and(eq(projects.id, req.projectId!), eq(projects.companyId, req.companyId!)))
      .limit(1);
    if (!projectRow) throw notFound("Project not found");

    const fenceRows = await app.db
      .select()
      .from(geofences)
      .where(
        and(
          eq(geofences.companyId, req.companyId!),
          eq(geofences.projectId, req.projectId!),
          eq(geofences.isActive, 1),
        ),
      )
      .limit(200);

    const features: GeoFeature[] = [];
    const coverage: Record<string, { located: number; total: number }> = {};

    if (wanted.has("equipment")) {
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(equipment)
        .where(
          and(eq(equipment.companyId, req.companyId!), eq(equipment.projectId, req.projectId!)),
        );
      const rows = await app.db
        .select({
          id: equipment.id,
          name: equipment.name,
          status: equipment.status,
          category: equipment.category,
          latitude: equipment.latitude,
          longitude: equipment.longitude,
        })
        .from(equipment)
        .where(
          and(
            eq(equipment.companyId, req.companyId!),
            eq(equipment.projectId, req.projectId!),
            isNotNull(equipment.latitude),
            isNotNull(equipment.longitude),
          ),
        )
        .limit(q.limit);
      for (const r of rows) {
        features.push({
          id: r.id,
          kind: "equipment",
          label: r.name,
          latitude: r.latitude!,
          longitude: r.longitude!,
          meta: { status: r.status, category: r.category },
        });
      }
      coverage["equipment"] = { located: rows.length, total: Number(totalRow?.n ?? 0) };
    }

    if (wanted.has("photo")) {
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(photos)
        .where(and(eq(photos.companyId, req.companyId!), eq(photos.projectId, req.projectId!)));
      const rows = await app.db
        .select({
          id: photos.id,
          fileId: photos.fileId,
          caption: photos.caption,
          takenAt: photos.takenAt,
          latitude: photos.latitude,
          longitude: photos.longitude,
        })
        .from(photos)
        .where(
          and(
            eq(photos.companyId, req.companyId!),
            eq(photos.projectId, req.projectId!),
            isNotNull(photos.latitude),
            isNotNull(photos.longitude),
          ),
        )
        .orderBy(desc(photos.takenAt))
        .limit(q.limit);
      for (const r of rows) {
        features.push({
          id: r.id,
          kind: "photo",
          label: r.caption ?? "Photo",
          latitude: r.latitude!,
          longitude: r.longitude!,
          at: r.takenAt,
          meta: { fileId: r.fileId },
        });
      }
      coverage["photo"] = { located: rows.length, total: Number(totalRow?.n ?? 0) };
    }

    if (wanted.has("capture")) {
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(realityCaptures)
        .where(
          and(
            eq(realityCaptures.companyId, req.companyId!),
            eq(realityCaptures.projectId, req.projectId!),
          ),
        );
      const rows = await app.db
        .select({
          id: realityCaptures.id,
          name: realityCaptures.name,
          kind: realityCaptures.kind,
          capturedAt: realityCaptures.capturedAt,
          latitude: realityCaptures.latitude,
          longitude: realityCaptures.longitude,
        })
        .from(realityCaptures)
        .where(
          and(
            eq(realityCaptures.companyId, req.companyId!),
            eq(realityCaptures.projectId, req.projectId!),
            isNotNull(realityCaptures.latitude),
            isNotNull(realityCaptures.longitude),
          ),
        )
        .limit(q.limit);
      for (const r of rows) {
        features.push({
          id: r.id,
          kind: "capture",
          label: r.name,
          latitude: r.latitude!,
          longitude: r.longitude!,
          at: r.capturedAt,
          meta: { captureKind: r.kind },
        });
      }
      coverage["capture"] = { located: rows.length, total: Number(totalRow?.n ?? 0) };
    }

    const fences = fenceRows.map((f) => ({ id: f.id, name: f.name, ring: f.ring as Point[] }));
    const assignment = assignToFences(features, fences);

    return {
      project: projectRow,
      centre:
        projectRow.latitude !== null && projectRow.longitude !== null
          ? { latitude: projectRow.latitude, longitude: projectRow.longitude }
          : features.length > 0
            ? {
                latitude: features.reduce((s, f) => s + f.latitude, 0) / features.length,
                longitude: features.reduce((s, f) => s + f.longitude, 0) / features.length,
              }
            : null,
      centreBasis:
        projectRow.latitude !== null
          ? "project coordinates"
          : features.length > 0
            ? "mean of located records — the project has no coordinates"
            : "not available: neither the project nor any record carries coordinates",
      geofences: fenceRows.map((f) => ({
        ...f,
        areaM2: ringAreaM2(f.ring as Point[]),
        featureCount: assignment.byFence[f.id]?.length ?? 0,
      })),
      features: features.map((f) => ({
        ...f,
        geofenceIds: assignment.fenceOfFeature[f.id] ?? [],
      })),
      coverage,
      outsideAnyFence: assignment.outside.length,
      unsupportedLayers,
      unsupportedReason:
        unsupportedLayers.length > 0
          ? "Assets and model elements are located by their spatial container, not by coordinates, so they cannot be plotted on the map"
          : null,
    };
  });

  /** What currently sits inside one fence (#472-475). */
  app.get(
    "/projects/:projectId/geofences/:fenceId/contents",
    { preHandler: gates.readGate },
    async (req) => {
      const { fenceId } = req.params as { fenceId: string };
      const fence = await getFence(fenceId, req.companyId!, req.projectId!);
      const ring = fence.ring as Point[];
      if (!isValidRing(ring)) {
        return { fence, items: [], total: 0, reason: "The fence polygon is not valid" };
      }
      const [equipmentRows, photoRows] = await Promise.all([
        app.db
          .select({
            id: equipment.id,
            name: equipment.name,
            status: equipment.status,
            latitude: equipment.latitude,
            longitude: equipment.longitude,
          })
          .from(equipment)
          .where(
            and(
              eq(equipment.companyId, req.companyId!),
              eq(equipment.projectId, req.projectId!),
              isNotNull(equipment.latitude),
              isNotNull(equipment.longitude),
            ),
          )
          .limit(1000),
        app.db
          .select({
            id: photos.id,
            caption: photos.caption,
            takenAt: photos.takenAt,
            latitude: photos.latitude,
            longitude: photos.longitude,
          })
          .from(photos)
          .where(
            and(
              eq(photos.companyId, req.companyId!),
              eq(photos.projectId, req.projectId!),
              isNotNull(photos.latitude),
              isNotNull(photos.longitude),
            ),
          )
          .orderBy(desc(photos.takenAt))
          .limit(1000),
      ]);
      const features: GeoFeature[] = [
        ...equipmentRows.map((r) => ({
          id: r.id,
          kind: "equipment",
          label: r.name,
          latitude: r.latitude!,
          longitude: r.longitude!,
          meta: { status: r.status },
        })),
        ...photoRows.map((r) => ({
          id: r.id,
          kind: "photo",
          label: r.caption ?? "Photo",
          latitude: r.latitude!,
          longitude: r.longitude!,
          at: r.takenAt,
        })),
      ];
      const assignment = assignToFences(features, [{ id: fence.id, name: fence.name, ring }]);
      const insideIds = new Set(assignment.byFence[fence.id] ?? []);
      const items = features.filter((f) => insideIds.has(f.id));
      return {
        fence: { ...fence, areaM2: ringAreaM2(ring) },
        items,
        total: items.length,
        byKind: items.reduce<Record<string, number>>((acc, f) => {
          acc[f.kind] = (acc[f.kind] ?? 0) + 1;
          return acc;
        }, {}),
        evaluatedRecords: features.length,
      };
    },
  );
};
