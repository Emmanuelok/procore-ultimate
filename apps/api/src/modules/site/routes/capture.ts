/**
 * REALITY CAPTURE — drone flights, laser scans, scan-versus-model deviation
 * reports and 360° tours (spec Vol II Z #1077–1080; Vol I §2.15 #471–478).
 *
 * Two refusals carry this file:
 *   • A flight whose airspace/landowner permission is pending or refused may
 *     not be recorded as flown. The permission is the control.
 *   • A deviation report against an unregistered scan is `not_assessable`,
 *     never "within tolerance" — an unregistered point cloud has no
 *     defensible relationship to the model it is compared with.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  siteDroneFlights,
  sitePhotoTourStations,
  sitePhotoTours,
  siteScanDeviations,
  siteScans,
} from "@constructos/db";
import {
  SITE_FLIGHT_PERMISSIONS,
  SITE_FLIGHT_PURPOSES,
  SITE_SCAN_METHODS,
  SITE_SCAN_REGISTRATION_STATUSES,
  SITE_TOUR_STATUSES,
} from "@constructos/shared";
import { badRequest, conflict } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { buildDeviationReport } from "../engines/deviation.js";
import {
  allocateReference,
  alreadySignalled,
  assertLocation,
  assertVendor,
  buildGates,
  fileIdsSchema,
  idSchema,
  isoTimestampSchema,
  latSchema,
  ledger,
  lonSchema,
  notFoundIfMissing,
  nowISO,
  patchSchemaOf,
  patchSet,
  raiseSignal,
} from "../shared.js";

const flightBody = z.object({
  purpose: z.enum(SITE_FLIGHT_PURPOSES).default("progress"),
  pilotName: z.string().trim().max(200).nullish(),
  pilotLicenceRef: z.string().trim().max(120).nullish(),
  operatorVendorId: idSchema.nullish(),
  aircraft: z.string().trim().max(200).nullish(),
  plannedFor: isoTimestampSchema.nullish(),
  permissionStatus: z.enum(SITE_FLIGHT_PERMISSIONS).default("pending"),
  permissionRef: z.string().trim().max(200).nullish(),
  airspaceNotes: z.string().max(2000).nullish(),
  maxAltitudeM: z.number().min(0).max(10_000).nullish(),
  riskAssessmentRef: z.string().max(200).nullish(),
  notes: z.string().max(4000).nullish(),
});

const scanBody = z.object({
  name: z.string().trim().min(1).max(200),
  method: z.enum(SITE_SCAN_METHODS).default("terrestrial_laser"),
  vendorId: idSchema.nullish(),
  locationId: idSchema.nullish(),
  areaDescription: z.string().max(500).nullish(),
  droneFlightId: idSchema.nullish(),
  coordinateSystem: z.string().max(120).nullish(),
  modelId: idSchema.nullish(),
  notes: z.string().max(4000).nullish(),
});

export const captureRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);
  const base = "/projects/:projectId/site";

  /* Drone flights -------------------------------------------------- */

  app.get(`${base}/flights`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema.extend({ status: z.string().max(20).optional() }).parse(req.query);
    const where = and(
      eq(siteDroneFlights.companyId, req.companyId!),
      eq(siteDroneFlights.projectId, projectId),
      q.status ? eq(siteDroneFlights.status, q.status) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteDroneFlights).where(where).orderBy(desc(siteDroneFlights.createdAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteDroneFlights).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/flights`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = flightBody.parse(req.body);
    const companyId = req.companyId!;
    if (body.operatorVendorId) await assertVendor(app.db, companyId, body.operatorVendorId);
    const { number, reference } = await allocateReference(app.db, projectId, "site_drone_flight", "UAV");
    const id = newId("uav");
    const [row] = await app.db
      .insert(siteDroneFlights)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        purpose: body.purpose,
        status: body.permissionStatus === "granted" || body.permissionStatus === "not_required" ? "permitted" : "planned",
        pilotName: body.pilotName ?? null,
        pilotLicenceRef: body.pilotLicenceRef ?? null,
        operatorVendorId: body.operatorVendorId ?? null,
        aircraft: body.aircraft ?? null,
        plannedFor: body.plannedFor ?? null,
        permissionStatus: body.permissionStatus,
        permissionRef: body.permissionRef ?? null,
        airspaceNotes: body.airspaceNotes ?? null,
        maxAltitudeM: body.maxAltitudeM ?? null,
        riskAssessmentRef: body.riskAssessmentRef ?? null,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_drone_flight",
      objectId: id,
      payload: { reference, purpose: body.purpose, permissionStatus: body.permissionStatus },
    });
    return reply.code(201).send(row);
  });

  app.patch(`${base}/flights/:id`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const body = patchSchemaOf(flightBody).parse(req.body);
    const existing = notFoundIfMissing(
      (
        await app.db
          .select()
          .from(siteDroneFlights)
          .where(and(eq(siteDroneFlights.id, id), eq(siteDroneFlights.companyId, companyId), eq(siteDroneFlights.projectId, projectId)))
          .limit(1)
      )[0],
      "Drone flight",
    );
    if (existing.status === "flown" || existing.status === "processed") {
      throw conflict("A flight that has been flown is a record of what happened; edit its outputs instead of its plan.");
    }
    if (body.operatorVendorId) await assertVendor(app.db, companyId, body.operatorVendorId);
    const set = patchSet(body as Record<string, unknown>, [
      "purpose",
      "pilotName",
      "pilotLicenceRef",
      "operatorVendorId",
      "aircraft",
      "plannedFor",
      "permissionStatus",
      "permissionRef",
      "airspaceNotes",
      "maxAltitudeM",
      "riskAssessmentRef",
      "notes",
    ]);
    if (body.permissionStatus !== undefined) {
      set["status"] = body.permissionStatus === "granted" || body.permissionStatus === "not_required" ? "permitted" : existing.status === "permitted" ? "planned" : existing.status;
    }
    const [row] = await app.db
      .update(siteDroneFlights)
      .set(set)
      .where(and(eq(siteDroneFlights.id, id), eq(siteDroneFlights.companyId, companyId)))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "site_drone_flight",
      objectId: id,
      payload: set,
    });
    return row;
  });

  app.post(`${base}/flights/:id/flown`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const body = z
      .object({
        flownAt: isoTimestampSchema.optional(),
        durationMinutes: z.number().min(0).max(1440).nullish(),
        areaCoveredM2: z.number().min(0).nullish(),
        imageCount: z.number().int().min(0).max(1_000_000).nullish(),
        weatherObservationId: idSchema.nullish(),
        outputs: z
          .array(
            z.object({
              kind: z.string().trim().min(1).max(60),
              fileId: idSchema.optional(),
              ref: z.string().max(300).optional(),
              note: z.string().max(500).optional(),
            }),
          )
          .max(50)
          .default([]),
        fileIds: fileIdsSchema.default([]),
      })
      .parse(req.body ?? {});
    const existing = notFoundIfMissing(
      (
        await app.db
          .select()
          .from(siteDroneFlights)
          .where(and(eq(siteDroneFlights.id, id), eq(siteDroneFlights.companyId, companyId), eq(siteDroneFlights.projectId, projectId)))
          .limit(1)
      )[0],
      "Drone flight",
    );
    if (existing.permissionStatus === "pending" || existing.permissionStatus === "refused") {
      throw conflict(
        `Flight ${existing.reference} has ${existing.permissionStatus} permission. A flight cannot be recorded as flown without the airspace or landowner permission that authorised it — record the permission first, or ground the flight.`,
      );
    }
    if (existing.status === "cancelled" || existing.status === "grounded") {
      throw conflict(`Flight ${existing.reference} is ${existing.status} and cannot be recorded as flown.`);
    }
    const at = body.flownAt ?? nowISO();
    const [row] = await app.db
      .update(siteDroneFlights)
      .set({
        status: "flown",
        flownAt: at,
        durationMinutes: body.durationMinutes ?? null,
        areaCoveredM2: body.areaCoveredM2 ?? null,
        imageCount: body.imageCount ?? null,
        weatherObservationId: body.weatherObservationId ?? null,
        outputs: body.outputs,
        fileIds: body.fileIds,
        updatedAt: nowISO(),
      })
      .where(and(eq(siteDroneFlights.id, id), eq(siteDroneFlights.companyId, companyId)))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "site_drone_flight",
      objectId: id,
      payload: { to: "flown", flownAt: at, imageCount: body.imageCount ?? null, outputs: body.outputs.length },
    });
    return row;
  });

  /* Scans ---------------------------------------------------------- */

  app.get(`${base}/scans`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({ status: z.string().max(20).optional(), registrationStatus: z.string().max(20).optional() })
      .parse(req.query);
    const where = and(
      eq(siteScans.companyId, req.companyId!),
      eq(siteScans.projectId, projectId),
      q.status ? eq(siteScans.status, q.status) : undefined,
      q.registrationStatus ? eq(siteScans.registrationStatus, q.registrationStatus) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteScans).where(where).orderBy(desc(siteScans.createdAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteScans).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/scans`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = scanBody.parse(req.body);
    const companyId = req.companyId!;
    if (body.vendorId) await assertVendor(app.db, companyId, body.vendorId);
    if (body.locationId) await assertLocation(app.db, projectId, body.locationId);
    const { number, reference } = await allocateReference(app.db, projectId, "site_scan", "SCN");
    const id = newId("scn");
    const [row] = await app.db
      .insert(siteScans)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        name: body.name,
        method: body.method,
        status: "planned",
        vendorId: body.vendorId ?? null,
        locationId: body.locationId ?? null,
        areaDescription: body.areaDescription ?? null,
        droneFlightId: body.droneFlightId ?? null,
        coordinateSystem: body.coordinateSystem ?? null,
        modelId: body.modelId ?? null,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_scan",
      objectId: id,
      payload: { reference, name: body.name, method: body.method },
    });
    return reply.code(201).send(row);
  });

  app.post(`${base}/scans/:id/captured`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const body = z
      .object({
        capturedAt: isoTimestampSchema.optional(),
        capturedByName: z.string().trim().max(200).nullish(),
        setupCount: z.number().int().min(0).max(100_000).nullish(),
        pointCountMillions: z.number().min(0).nullish(),
        sizeMb: z.number().min(0).nullish(),
        registrationStatus: z.enum(SITE_SCAN_REGISTRATION_STATUSES).default("unregistered"),
        registrationErrorMm: z.number().min(0).max(100_000).nullish(),
        controlPointRefs: z.array(z.string().trim().min(1).max(60)).max(500).default([]),
        fileIds: fileIdsSchema.default([]),
      })
      .parse(req.body ?? {});
    if (body.registrationStatus === "registered" && (body.registrationErrorMm === null || body.registrationErrorMm === undefined)) {
      throw badRequest(
        "A scan recorded as registered must carry its registration error in millimetres — a registration without a residual is an assertion, not a measurement.",
      );
    }
    const at = body.capturedAt ?? nowISO();
    const [row] = await app.db
      .update(siteScans)
      .set({
        status: body.registrationStatus === "failed" ? "failed" : "captured",
        capturedAt: at,
        capturedByName: body.capturedByName ?? null,
        setupCount: body.setupCount ?? null,
        pointCountMillions: body.pointCountMillions ?? null,
        sizeMb: body.sizeMb ?? null,
        registrationStatus: body.registrationStatus,
        registrationErrorMm: body.registrationErrorMm ?? null,
        controlPointRefs: body.controlPointRefs,
        fileIds: body.fileIds,
        updatedAt: nowISO(),
      })
      .where(and(eq(siteScans.id, id), eq(siteScans.companyId, companyId), eq(siteScans.projectId, projectId)))
      .returning();
    if (!row) throw badRequest("Scan not found in this project.");
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "site_scan",
      objectId: id,
      payload: { to: row.status, registrationStatus: body.registrationStatus, registrationErrorMm: body.registrationErrorMm ?? null },
    });
    return row;
  });

  /* Deviation reports ---------------------------------------------- */

  app.get(`${base}/deviations`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema.extend({ scanId: idSchema.optional(), verdict: z.string().max(30).optional() }).parse(req.query);
    const where = and(
      eq(siteScanDeviations.companyId, req.companyId!),
      eq(siteScanDeviations.projectId, projectId),
      q.scanId ? eq(siteScanDeviations.scanId, q.scanId) : undefined,
      q.verdict ? eq(siteScanDeviations.verdict, q.verdict) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteScanDeviations).where(where).orderBy(desc(siteScanDeviations.generatedAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteScanDeviations).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/scans/:id/deviations`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const body = z
      .object({
        modelId: idSchema.nullish(),
        modelVersion: z.string().max(80).nullish(),
        method: z.string().trim().max(80).default("cloud_to_mesh"),
        toleranceMm: z.number().positive().max(10_000),
        marginalFactor: z.number().positive().max(1).default(0.8),
        items: z
          .array(
            z.object({
              elementId: z.string().trim().min(1).max(120),
              elementName: z.string().max(200).optional(),
              zone: z.string().max(120).optional(),
              deviationMm: z.number(),
            }),
          )
          .min(1)
          .max(20_000),
        notes: z.string().max(4000).nullish(),
      })
      .parse(req.body);
    const scan = notFoundIfMissing(
      (
        await app.db
          .select()
          .from(siteScans)
          .where(and(eq(siteScans.id, id), eq(siteScans.companyId, companyId), eq(siteScans.projectId, projectId)))
          .limit(1)
      )[0],
      "Scan",
    );

    const report = buildDeviationReport(body.items, {
      toleranceMm: body.toleranceMm,
      marginalFactor: body.marginalFactor,
      registrationStatus: scan.registrationStatus,
      registrationErrorMm: scan.registrationErrorMm,
    });

    const { number, reference } = await allocateReference(app.db, projectId, "site_scan_deviation", "DEV");
    const devId = newId("dev");

    let signalId: string | null = null;
    if (report.verdict === "out_of_tolerance") {
      const raised = await alreadySignalled(app.db, companyId, ["site_scan_out_of_tolerance"], projectId);
      const key = `deviation:${devId}`;
      if (!raised.has(key)) {
        signalId = await raiseSignal(app.db, companyId, projectId, req.user!.id, {
          detector: "site_scan_out_of_tolerance",
          severity: report.outOfToleranceCount > report.elementCount * 0.1 ? "high" : "medium",
          confidence: 0.85,
          title: `${report.outOfToleranceCount} element(s) out of tolerance on ${scan.reference}`,
          explanation: `${reference} compared ${report.elementCount} element(s) from scan ${scan.reference} against the model at a ${body.toleranceMm} mm tolerance. ${report.outOfToleranceCount} exceed it; the worst is ${report.maxDeviationMm} mm. ${report.reasons.join(" ")}`,
          key,
          subjectType: "site_scan_deviation",
          subjectId: devId,
          evidence: {
            scanId: scan.id,
            deviationId: devId,
            toleranceMm: body.toleranceMm,
            outOfTolerance: report.outOfToleranceCount,
            maxDeviationMm: report.maxDeviationMm,
            byZone: report.byZone,
          },
        });
      }
    }

    const [row] = await app.db
      .insert(siteScanDeviations)
      .values({
        id: devId,
        companyId,
        projectId,
        scanId: scan.id,
        modelId: body.modelId ?? scan.modelId ?? null,
        modelVersion: body.modelVersion ?? null,
        reference,
        number,
        method: body.method,
        toleranceMm: body.toleranceMm,
        marginalFactor: report.marginalFactor,
        elementCount: report.elementCount,
        withinToleranceCount: report.withinToleranceCount,
        marginalCount: report.marginalCount,
        outOfToleranceCount: report.outOfToleranceCount,
        maxDeviationMm: report.maxDeviationMm,
        meanAbsDeviationMm: report.meanAbsDeviationMm,
        rmsDeviationMm: report.rmsDeviationMm,
        verdict: report.verdict,
        status: "draft",
        byZone: report.byZone,
        items: report.items.slice(0, 5000),
        reasons: report.reasons,
        signalId,
        notes: body.notes ?? null,
        generatedBy: req.user!.id,
      })
      .returning();

    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_scan_deviation",
      objectId: devId,
      payload: {
        reference,
        scanId: scan.id,
        verdict: report.verdict,
        elementCount: report.elementCount,
        outOfTolerance: report.outOfToleranceCount,
      },
    });
    return reply.code(201).send({ ...row, itemsStored: Math.min(report.items.length, 5000), itemsSubmitted: body.items.length });
  });

  app.post(`${base}/deviations/:id/accept`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const { status, notes } = z
      .object({ status: z.enum(["accepted", "rejected", "issued"]).default("issued"), notes: z.string().max(2000).optional() })
      .parse(req.body ?? {});
    const at = nowISO();
    const [row] = await app.db
      .update(siteScanDeviations)
      .set({
        status,
        acceptedBy: status === "accepted" ? req.user!.id : null,
        acceptedAt: status === "accepted" ? at : null,
        notes: notes ?? null,
      })
      .where(
        and(
          eq(siteScanDeviations.id, id),
          eq(siteScanDeviations.companyId, companyId),
          eq(siteScanDeviations.projectId, projectId),
        ),
      )
      .returning();
    if (!row) throw badRequest("Deviation report not found in this project.");
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "site_scan_deviation",
      objectId: id,
      payload: { to: status, notes: notes ?? null },
    });
    return row;
  });

  /* 360 tours ------------------------------------------------------ */

  app.get(`${base}/tours`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema.extend({ status: z.enum(SITE_TOUR_STATUSES).optional() }).parse(req.query);
    const where = and(
      eq(sitePhotoTours.companyId, req.companyId!),
      eq(sitePhotoTours.projectId, projectId),
      q.status ? eq(sitePhotoTours.status, q.status) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(sitePhotoTours).where(where).orderBy(desc(sitePhotoTours.capturedAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(sitePhotoTours).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/tours`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const companyId = req.companyId!;
    const body = z
      .object({
        name: z.string().trim().min(1).max(200),
        capturedAt: isoTimestampSchema.optional(),
        capturedByName: z.string().trim().max(200).nullish(),
        locationId: idSchema.nullish(),
        level: z.string().max(80).nullish(),
        scanId: idSchema.nullish(),
        droneFlightId: idSchema.nullish(),
        coverageNotes: z.string().max(2000).nullish(),
        notes: z.string().max(2000).nullish(),
      })
      .parse(req.body);
    if (body.locationId) await assertLocation(app.db, projectId, body.locationId);
    const id = newId("tur");
    const [row] = await app.db
      .insert(sitePhotoTours)
      .values({
        id,
        companyId,
        projectId,
        name: body.name,
        capturedAt: body.capturedAt ?? nowISO(),
        capturedByName: body.capturedByName ?? null,
        locationId: body.locationId ?? null,
        level: body.level ?? null,
        status: "draft",
        scanId: body.scanId ?? null,
        droneFlightId: body.droneFlightId ?? null,
        coverageNotes: body.coverageNotes ?? null,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_photo_tour",
      objectId: id,
      payload: { name: body.name },
    });
    return reply.code(201).send(row);
  });

  app.get(`${base}/tours/:id`, { preHandler: readGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const tour = notFoundIfMissing(
      (
        await app.db
          .select()
          .from(sitePhotoTours)
          .where(and(eq(sitePhotoTours.id, id), eq(sitePhotoTours.companyId, companyId), eq(sitePhotoTours.projectId, projectId)))
          .limit(1)
      )[0],
      "Tour",
    );
    const stations = await app.db
      .select()
      .from(sitePhotoTourStations)
      .where(and(eq(sitePhotoTourStations.tourId, id), eq(sitePhotoTourStations.companyId, companyId)))
      .orderBy(asc(sitePhotoTourStations.sequence));
    return { ...tour, stations };
  });

  app.post(`${base}/tours/:id/stations`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const body = z
      .object({
        name: z.string().trim().min(1).max(200),
        sequence: z.number().int().min(0).max(10_000).optional(),
        capturedAt: isoTimestampSchema.optional(),
        fileId: idSchema.nullish(),
        photoId: idSchema.nullish(),
        lat: latSchema.nullish(),
        lon: lonSchema.nullish(),
        elevationM: z.number().min(-500).max(10_000).nullish(),
        headingDeg: z.number().min(0).max(360).nullish(),
        locationId: idSchema.nullish(),
        notes: z.string().max(1000).nullish(),
      })
      .parse(req.body);
    const tour = notFoundIfMissing(
      (
        await app.db
          .select()
          .from(sitePhotoTours)
          .where(and(eq(sitePhotoTours.id, id), eq(sitePhotoTours.companyId, companyId), eq(sitePhotoTours.projectId, projectId)))
          .limit(1)
      )[0],
      "Tour",
    );
    if (tour.status === "archived") throw conflict("An archived tour does not take new stations.");
    const stationId = newId("tst");
    const [row] = await app.db
      .insert(sitePhotoTourStations)
      .values({
        id: stationId,
        companyId,
        projectId,
        tourId: id,
        name: body.name,
        sequence: body.sequence ?? tour.stationCount,
        capturedAt: body.capturedAt ?? nowISO(),
        fileId: body.fileId ?? null,
        photoId: body.photoId ?? null,
        lat: body.lat ?? null,
        lon: body.lon ?? null,
        elevationM: body.elevationM ?? null,
        headingDeg: body.headingDeg ?? null,
        locationId: body.locationId ?? null,
        notes: body.notes ?? null,
      })
      .returning();
    const [tally] = await app.db
      .select({ n: count() })
      .from(sitePhotoTourStations)
      .where(and(eq(sitePhotoTourStations.tourId, id), eq(sitePhotoTourStations.companyId, companyId)));
    const stationCount = tally?.n ?? 0;
    await app.db
      .update(sitePhotoTours)
      .set({ stationCount, updatedAt: nowISO() })
      .where(and(eq(sitePhotoTours.id, id), eq(sitePhotoTours.companyId, companyId)));
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_photo_tour_station",
      objectId: stationId,
      payload: { tourId: id, name: body.name },
    });
    return reply.code(201).send(row);
  });

  app.post(`${base}/tours/:id/publish`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const [tally] = await app.db
      .select({ n: count() })
      .from(sitePhotoTourStations)
      .where(and(eq(sitePhotoTourStations.tourId, id), eq(sitePhotoTourStations.companyId, companyId)));
    const stationCount = tally?.n ?? 0;
    if (stationCount === 0) throw conflict("A tour with no stations has nothing to publish.");
    const [row] = await app.db
      .update(sitePhotoTours)
      .set({ status: "published", stationCount, updatedAt: nowISO() })
      .where(and(eq(sitePhotoTours.id, id), eq(sitePhotoTours.companyId, companyId), eq(sitePhotoTours.projectId, projectId), eq(sitePhotoTours.status, "draft")))
      .returning();
    if (!row) throw conflict("Only a draft tour can be published.");
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "site_photo_tour",
      objectId: id,
      payload: { to: "published", stations: stationCount },
    });
    return row;
  });
};
