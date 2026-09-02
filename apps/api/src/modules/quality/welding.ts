/**
 * Welding: procedures, welder qualifications, the weld map and NDT
 * (#1087–1088).
 *
 * The weld map exists to answer one question quickly: when an examination
 * rejects a joint, WHAT ELSE did that welder make to that procedure. Every
 * column here serves that query — the joint names its WPS and its welder
 * qualification, the qualification names its processes and its continuity, and
 * the NDT record names the body that examined it and the technician's level.
 *
 * The refusal that matters: a joint may not be recorded as welded by somebody
 * whose qualification had lapsed on the day, or to a procedure that did not
 * cover it, unless the caller states that it happened anyway — in which case
 * the platform raises the non-conformance itself. A weld map that quietly
 * accepts an unqualified weld is worse than no weld map, because it looks like
 * evidence.
 */

import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  ndtRecords,
  welderQualifications,
  weldingProcedures,
  welds,
} from "@constructos/db";
import {
  NDT_METHODS,
  NDT_RESULTS,
  WELD_PROCESSES,
  WELD_STATUSES,
  WELDER_QUALIFICATION_STATUSES,
  WPS_STATUSES,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import {
  allocateReference,
  alreadySignalled,
  assertDistinctActor,
  assertVendor,
  buildGates,
  fileIdsSchema,
  idSchema,
  isoDateSchema,
  ledger,
  nowISO,
  patchSet,
  QUALITY_DETECTORS,
  raiseSignal,
  todayISO,
} from "./shared.js";
import {
  qualificationStanding,
  weldCompliance,
  weldProgramme,
  welderPerformance,
  type NdtRecordLike,
  type WeldLike,
  type WelderQualificationLike,
  type WpsLike,
} from "./weldStats.js";
import { createNcr } from "./raise.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const wpsCreateSchema = z.object({
  wpsNumber: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  revision: z.string().max(50).nullable().optional(),
  standard: z.string().max(200).nullable().optional(),
  process: z.enum(WELD_PROCESSES).optional(),
  secondaryProcess: z.enum(WELD_PROCESSES).nullable().optional(),
  jointTypes: z.array(z.string().max(100)).max(50).optional(),
  positions: z.array(z.string().max(50)).max(50).optional(),
  baseMaterialGroup: z.string().max(100).nullable().optional(),
  fillerMaterial: z.string().max(200).nullable().optional(),
  thicknessMinMm: z.number().finite().nonnegative().nullable().optional(),
  thicknessMaxMm: z.number().finite().nonnegative().nullable().optional(),
  diameterMinMm: z.number().finite().nonnegative().nullable().optional(),
  diameterMaxMm: z.number().finite().nonnegative().nullable().optional(),
  preheatMinC: z.number().finite().nullable().optional(),
  interpassMaxC: z.number().finite().nullable().optional(),
  pwhtRequired: z.boolean().optional(),
  pqrReference: z.string().max(200).nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  validFrom: isoDateSchema.nullable().optional(),
  validUntil: isoDateSchema.nullable().optional(),
  documentFileId: idSchema.nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const qualCreateSchema = z.object({
  welderName: z.string().min(1).max(200),
  welderStamp: z.string().max(50).nullable().optional(),
  workerId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  certificateNumber: z.string().max(200).nullable().optional(),
  qualificationStandard: z.string().max(200).nullable().optional(),
  processes: z.array(z.enum(WELD_PROCESSES)).max(20).optional(),
  positions: z.array(z.string().max(50)).max(50).optional(),
  materialGroups: z.array(z.string().max(50)).max(50).optional(),
  thicknessMinMm: z.number().finite().nonnegative().nullable().optional(),
  thicknessMaxMm: z.number().finite().nonnegative().nullable().optional(),
  diameterMinMm: z.number().finite().nonnegative().nullable().optional(),
  diameterMaxMm: z.number().finite().nonnegative().nullable().optional(),
  qualifiedFrom: isoDateSchema.nullable().optional(),
  expiryDate: isoDateSchema.nullable().optional(),
  continuityConfirmedAt: isoDateSchema.nullable().optional(),
  continuityMonths: z.number().int().min(1).max(60).optional(),
  certificateFileId: idSchema.nullable().optional(),
  wpsIds: z.array(idSchema).max(50).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const weldCreateSchema = z.object({
  weldMapRef: z.string().max(100).nullable().optional(),
  jointReference: z.string().max(100).nullable().optional(),
  jointType: z.string().max(100).nullable().optional(),
  description: z.string().max(4000).nullable().optional(),
  drawingSheetId: idSchema.nullable().optional(),
  drawingReference: z.string().max(200).nullable().optional(),
  isometricRef: z.string().max(200).nullable().optional(),
  lineOrElementRef: z.string().max(200).nullable().optional(),
  systemId: idSchema.nullable().optional(),
  assetId: idSchema.nullable().optional(),
  locationId: idSchema.nullable().optional(),
  materialSpec: z.string().max(200).nullable().optional(),
  thicknessMm: z.number().finite().nonnegative().nullable().optional(),
  diameterMm: z.number().finite().nonnegative().nullable().optional(),
  heatNumbers: z.array(z.string().max(100)).max(20).optional(),
  materialCertificateIds: z.array(idSchema).max(20).optional(),
  wpsId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  ndtRequiredPercent: z.number().finite().min(0).max(100).nullable().optional(),
  ndtMethodsRequired: z.array(z.enum(NDT_METHODS)).max(10).optional(),
  itpActivityId: idSchema.nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const recordWeldSchema = z.object({
  wpsId: idSchema.optional(),
  welderQualificationId: idSchema,
  weldedAt: isoDateSchema.optional(),
  heatNumbers: z.array(z.string().max(100)).max(20).optional(),
  photoFileIds: fileIdsSchema.optional(),
  /** record a joint that was made outside the qualified envelope, knowingly */
  recordNonCompliant: z.boolean().optional(),
  nonComplianceReason: z.string().max(4000).nullable().optional(),
});

const visualSchema = z.object({
  result: z.enum(["accept", "reject"]),
  note: z.string().max(4000).nullable().optional(),
  inspectedAt: isoDateSchema.optional(),
});

const ndtCreateSchema = z.object({
  method: z.enum(NDT_METHODS),
  techniqueRef: z.string().max(200).nullable().optional(),
  procedureRef: z.string().max(200).nullable().optional(),
  acceptanceStandard: z.string().max(200).nullable().optional(),
  coverageDescription: z.string().max(2000).nullable().optional(),
  coveragePercent: z.number().finite().min(0).max(100).nullable().optional(),
  performedByOrganisation: z.string().max(200).nullable().optional(),
  technicianName: z.string().max(200).nullable().optional(),
  technicianLevel: z.string().max(20).nullable().optional(),
  technicianCertNumber: z.string().max(100).nullable().optional(),
  retestOfId: idSchema.nullable().optional(),
});

const ndtResultSchema = z.object({
  result: z.enum(NDT_RESULTS),
  performedAt: z.string().min(4).optional(),
  defectType: z.string().max(200).nullable().optional(),
  defectLengthMm: z.number().finite().nullable().optional(),
  defectLocation: z.string().max(200).nullable().optional(),
  reportNumber: z.string().max(200).nullable().optional(),
  reportFileId: idSchema.nullable().optional(),
  technicianName: z.string().max(200).nullable().optional(),
  technicianLevel: z.string().max(20).nullable().optional(),
});

const WPS_PATCH_COLUMNS = [
  "title",
  "revision",
  "standard",
  "process",
  "secondaryProcess",
  "jointTypes",
  "positions",
  "baseMaterialGroup",
  "fillerMaterial",
  "thicknessMinMm",
  "thicknessMaxMm",
  "diameterMinMm",
  "diameterMaxMm",
  "preheatMinC",
  "interpassMaxC",
  "pqrReference",
  "vendorId",
  "validFrom",
  "validUntil",
  "documentFileId",
  "detail",
] as const;

const QUAL_PATCH_COLUMNS = [
  "welderName",
  "welderStamp",
  "workerId",
  "vendorId",
  "certificateNumber",
  "qualificationStandard",
  "processes",
  "positions",
  "materialGroups",
  "thicknessMinMm",
  "thicknessMaxMm",
  "diameterMinMm",
  "diameterMaxMm",
  "qualifiedFrom",
  "expiryDate",
  "continuityConfirmedAt",
  "continuityMonths",
  "certificateFileId",
  "wpsIds",
  "detail",
] as const;

const WELD_PATCH_COLUMNS = [
  "weldMapRef",
  "jointReference",
  "jointType",
  "description",
  "drawingSheetId",
  "drawingReference",
  "isometricRef",
  "lineOrElementRef",
  "systemId",
  "assetId",
  "locationId",
  "materialSpec",
  "thicknessMm",
  "diameterMm",
  "heatNumbers",
  "materialCertificateIds",
  "wpsId",
  "vendorId",
  "ndtRequiredPercent",
  "ndtMethodsRequired",
  "itpActivityId",
  "detail",
] as const;

const asWps = (row: typeof weldingProcedures.$inferSelect): WpsLike => ({
  id: row.id,
  wpsNumber: row.wpsNumber,
  process: row.process,
  positions: row.positions,
  baseMaterialGroup: row.baseMaterialGroup,
  thicknessMinMm: row.thicknessMinMm,
  thicknessMaxMm: row.thicknessMaxMm,
  status: row.status,
  validFrom: row.validFrom,
  validUntil: row.validUntil,
});

const asQual = (row: typeof welderQualifications.$inferSelect): WelderQualificationLike => ({
  id: row.id,
  welderName: row.welderName,
  welderStamp: row.welderStamp,
  processes: row.processes,
  positions: row.positions,
  materialGroups: row.materialGroups,
  thicknessMinMm: row.thicknessMinMm,
  thicknessMaxMm: row.thicknessMaxMm,
  diameterMinMm: row.diameterMinMm,
  diameterMaxMm: row.diameterMaxMm,
  qualifiedFrom: row.qualifiedFrom,
  expiryDate: row.expiryDate,
  continuityConfirmedAt: row.continuityConfirmedAt,
  continuityMonths: row.continuityMonths,
  status: row.status,
});

const asWeld = (row: typeof welds.$inferSelect): WeldLike => ({
  id: row.id,
  reference: row.reference,
  status: row.status,
  weldedAt: row.weldedAt,
  thicknessMm: row.thicknessMm,
  diameterMm: row.diameterMm,
  wpsId: row.wpsId,
  welderQualificationId: row.welderQualificationId,
  ndtRequiredPercent: row.ndtRequiredPercent,
  ndtRecordCount: row.ndtRecordCount,
  ndtAcceptCount: row.ndtAcceptCount,
  ndtRejectCount: row.ndtRejectCount,
  repairCount: row.repairCount,
  jointType: row.jointType,
});

const asNdt = (row: typeof ndtRecords.$inferSelect): NdtRecordLike => ({
  id: row.id,
  weldId: row.weldId,
  method: row.method,
  result: row.result,
  performedAt: row.performedAt,
});

/* ------------------------------------------------------------------ */
/* Sweep: lapsed qualifications                                        */
/* ------------------------------------------------------------------ */

/**
 * Move lapsed qualifications to `expired` and raise one signal each. Welders
 * whose certificates lapse quietly are how a fabrication contract ends up with
 * a month of unqualified joints nobody can attribute.
 */
export async function sweepWelderQualifications(
  db: Db,
  companyId: string,
  asOf: string = todayISO(),
): Promise<{ raised: number; expired: number }> {
  const rows = await db
    .select()
    .from(welderQualifications)
    .where(
      and(
        eq(welderQualifications.companyId, companyId),
        inArray(welderQualifications.status, ["valid", "expiring"]),
      ),
    );
  if (rows.length === 0) return { raised: 0, expired: 0 };
  const seen = await alreadySignalled(db, companyId, QUALITY_DETECTORS.welderQualificationLapsed);
  let raised = 0;
  let expired = 0;
  for (const row of rows) {
    const standing = qualificationStanding(asQual(row), asOf);
    if (standing.status === row.status) continue;
    await db
      .update(welderQualifications)
      .set({ status: standing.status, updatedAt: nowISO() })
      .where(eq(welderQualifications.id, row.id));
    if (standing.status === "expired") expired += 1;
    if (standing.status !== "expired" || seen.has(row.id)) continue;
    seen.add(row.id);
    await raiseSignal(db, companyId, row.projectId, null, {
      detector: QUALITY_DETECTORS.welderQualificationLapsed,
      severity: "high",
      confidence: 1,
      title: `Welder qualification lapsed — ${row.welderName}${row.welderStamp ? ` (${row.welderStamp})` : ""}`,
      explanation:
        `${row.welderName}'s qualification ${row.certificateNumber ? `(${row.certificateNumber}) ` : ""}is no longer current. ${standing.reasons.join(" ")} ` +
        `Every joint attributed to this welder from the lapse date onwards is a joint nobody can show was made by a qualified welder, ` +
        `and the remedy on site is re-qualification plus examination of the joints in between — which is far cheaper to organise now than at handover.`,
      key: row.id,
      evidence: {
        qualificationId: row.id,
        welderName: row.welderName,
        welderStamp: row.welderStamp,
        expiryDate: row.expiryDate,
        continuityConfirmedAt: row.continuityConfirmedAt,
        continuityLapsesOn: standing.continuityLapsesOn,
        vendorId: row.vendorId,
      },
    });
    raised += 1;
  }
  return { raised, expired };
}

/** Welded joints past their required examination with nothing recorded. */
export async function sweepNdtCoverage(
  db: Db,
  companyId: string,
): Promise<{ raised: number }> {
  const rows = await db
    .select()
    .from(welds)
    .where(and(eq(welds.companyId, companyId), inArray(welds.status, ["welded", "visual_inspected", "ndt_requested"])));
  const short = rows.filter(
    (w) => w.ndtRequiredPercent !== null && w.ndtRequiredPercent > 0 && w.ndtRecordCount === 0,
  );
  if (short.length === 0) return { raised: 0 };
  const seen = await alreadySignalled(db, companyId, QUALITY_DETECTORS.ndtCoverageShort);
  let raised = 0;
  for (const w of short) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    await raiseSignal(db, companyId, w.projectId, null, {
      detector: QUALITY_DETECTORS.ndtCoverageShort,
      severity: "medium",
      confidence: 1,
      title: `${w.reference} requires ${w.ndtRequiredPercent}% examination and has none recorded`,
      explanation:
        `Joint ${w.reference}${w.jointReference ? ` (${w.jointReference})` : ""} was welded on ${w.weldedAt ?? "an unrecorded date"} and the specification requires ` +
        `${w.ndtRequiredPercent}% ${w.ndtMethodsRequired.length > 0 ? w.ndtMethodsRequired.join("/").toUpperCase() : "non-destructive"} examination of joints in its class. ` +
        `No examination is recorded against it. Examination percentages are not a formality: they are the sampling rate at which a systematic ` +
        `welding problem becomes visible, and a joint that is buried before it is examined cannot be examined at all.`,
      key: w.id,
      evidence: {
        weldId: w.id,
        reference: w.reference,
        weldedAt: w.weldedAt,
        requiredPercent: w.ndtRequiredPercent,
        methods: w.ndtMethodsRequired,
        welderQualificationId: w.welderQualificationId,
      },
    });
    raised += 1;
  }
  return { raised };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const weldingRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);

  const scope = (req: { companyId?: string; projectId?: string }) => ({
    companyId: req.companyId!,
    projectId: req.projectId!,
  });

  async function fetchWps(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(weldingProcedures)
      .where(
        and(
          eq(weldingProcedures.id, id),
          eq(weldingProcedures.companyId, companyId),
          eq(weldingProcedures.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Welding procedure not found");
    return rows[0];
  }

  async function fetchQual(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(welderQualifications)
      .where(
        and(
          eq(welderQualifications.id, id),
          eq(welderQualifications.companyId, companyId),
          eq(welderQualifications.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Welder qualification not found");
    return rows[0];
  }

  async function fetchWeld(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(welds)
      .where(
        and(eq(welds.id, id), eq(welds.companyId, companyId), eq(welds.projectId, projectId)),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Weld not found");
    return rows[0];
  }

  async function refreshWeldCounters(weldId: string) {
    const records = await app.db.select().from(ndtRecords).where(eq(ndtRecords.weldId, weldId));
    const accept = records.filter((r) => r.result === "accept").length;
    const reject = records.filter((r) => r.result === "reject").length;
    await app.db
      .update(welds)
      .set({
        ndtRecordCount: records.length,
        ndtAcceptCount: accept,
        ndtRejectCount: reject,
        updatedAt: nowISO(),
      })
      .where(eq(welds.id, weldId));
    return records;
  }

  /* ---------------- welding procedures ---------------- */

  app.post("/projects/:projectId/welding-procedures", { preHandler: standardGate }, async (req, reply) => {
    const body = wpsCreateSchema.parse(req.body);
    if (body.vendorId) await assertVendor(app.db, req.companyId!, body.vendorId);
    const dupe = await app.db
      .select({ id: weldingProcedures.id })
      .from(weldingProcedures)
      .where(
        and(
          eq(weldingProcedures.projectId, req.projectId!),
          eq(weldingProcedures.wpsNumber, body.wpsNumber),
        ),
      )
      .limit(1);
    if (dupe[0]) {
      throw conflict(
        `WPS ${body.wpsNumber} already exists on this project. Revise it rather than creating a second procedure under the same number — a joint that names "WPS-014" must resolve to one document.`,
      );
    }
    const id = newId("wps");
    const [created] = await app.db
      .insert(weldingProcedures)
      .values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        wpsNumber: body.wpsNumber,
        title: body.title,
        revision: body.revision ?? null,
        standard: body.standard ?? null,
        process: body.process ?? "smaw",
        secondaryProcess: body.secondaryProcess ?? null,
        jointTypes: body.jointTypes ?? [],
        positions: body.positions ?? [],
        baseMaterialGroup: body.baseMaterialGroup ?? null,
        fillerMaterial: body.fillerMaterial ?? null,
        thicknessMinMm: body.thicknessMinMm ?? null,
        thicknessMaxMm: body.thicknessMaxMm ?? null,
        diameterMinMm: body.diameterMinMm ?? null,
        diameterMaxMm: body.diameterMaxMm ?? null,
        preheatMinC: body.preheatMinC ?? null,
        interpassMaxC: body.interpassMaxC ?? null,
        pwhtRequired: body.pwhtRequired ? 1 : 0,
        pqrReference: body.pqrReference ?? null,
        vendorId: body.vendorId ?? null,
        validFrom: body.validFrom ?? null,
        validUntil: body.validUntil ?? null,
        documentFileId: body.documentFileId ?? null,
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      ...scope(req),
      actorId: req.user!.id,
      action: "create",
      objectType: "welding_procedure",
      objectId: id,
      payload: created,
      storePayload: true,
    });
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/welding-procedures", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ status: z.enum(WPS_STATUSES).optional(), search: z.string().max(200).optional() })
      .parse(req.query);
    const clauses = [
      eq(weldingProcedures.companyId, req.companyId!),
      eq(weldingProcedures.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(weldingProcedures.status, q.status));
    if (q.search) clauses.push(ilike(weldingProcedures.wpsNumber, `%${q.search}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(weldingProcedures).where(where);
    const rows = await app.db
      .select()
      .from(weldingProcedures)
      .where(where)
      .orderBy(asc(weldingProcedures.wpsNumber))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  app.patch(
    "/projects/:projectId/welding-procedures/:id",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = wpsCreateSchema.partial().parse(req.body);
      const row = await fetchWps(id, req.companyId!, req.projectId!);
      if (row.status === "approved" || row.status === "superseded") {
        throw badRequest(
          `${row.wpsNumber} is ${row.status}. An approved procedure is revised, not edited: joints have been welded to the document as it stands.`,
        );
      }
      await app.db
        .update(weldingProcedures)
        .set(patchSet(body as Record<string, unknown>, WPS_PATCH_COLUMNS))
        .where(eq(weldingProcedures.id, id));
      await ledger(app.db, {
        ...scope(req),
        actorId: req.user!.id,
        action: "update",
        objectType: "welding_procedure",
        objectId: id,
        payload: { changed: Object.keys(body) },
      });
      return fetchWps(id, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/welding-procedures/:id/approve",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const row = await fetchWps(id, req.companyId!, req.projectId!);
      if (row.status !== "draft") {
        throw badRequest(`${row.wpsNumber} is already ${row.status}.`);
      }
      if (!row.pqrReference) {
        throw badRequest(
          `${row.wpsNumber} names no procedure qualification record. A WPS is only a procedure because a PQR qualified it; approving one without naming the PQR approves an assertion.`,
        );
      }
      assertDistinctActor(req.user!.id, row.createdBy, `Approval of ${row.wpsNumber}`, "drafted");
      const at = nowISO();
      await app.db
        .update(weldingProcedures)
        .set({ status: "approved", approvedBy: req.user!.id, approvedAt: at, updatedAt: at })
        .where(eq(weldingProcedures.id, id));
      await ledger(app.db, {
        ...scope(req),
        actorId: req.user!.id,
        action: "state_change",
        objectType: "welding_procedure",
        objectId: id,
        payload: { from: "draft", to: "approved", pqrReference: row.pqrReference },
        storePayload: true,
      });
      return fetchWps(id, req.companyId!, req.projectId!);
    },
  );

  /* ---------------- welder qualifications ---------------- */

  app.post(
    "/projects/:projectId/welder-qualifications",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = qualCreateSchema.parse(req.body);
      if (body.vendorId) await assertVendor(app.db, req.companyId!, body.vendorId);
      const id = newId("wq");
      const [created] = await app.db
        .insert(welderQualifications)
        .values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          welderName: body.welderName,
          welderStamp: body.welderStamp ?? null,
          workerId: body.workerId ?? null,
          vendorId: body.vendorId ?? null,
          certificateNumber: body.certificateNumber ?? null,
          qualificationStandard: body.qualificationStandard ?? null,
          processes: body.processes ?? [],
          positions: body.positions ?? [],
          materialGroups: body.materialGroups ?? [],
          thicknessMinMm: body.thicknessMinMm ?? null,
          thicknessMaxMm: body.thicknessMaxMm ?? null,
          diameterMinMm: body.diameterMinMm ?? null,
          diameterMaxMm: body.diameterMaxMm ?? null,
          qualifiedFrom: body.qualifiedFrom ?? null,
          expiryDate: body.expiryDate ?? null,
          continuityConfirmedAt: body.continuityConfirmedAt ?? null,
          continuityMonths: body.continuityMonths ?? 6,
          certificateFileId: body.certificateFileId ?? null,
          wpsIds: body.wpsIds ?? [],
          detail: body.detail ?? {},
          createdBy: req.user!.id,
        })
        .returning();
      const standing = qualificationStanding(asQual(created!), todayISO());
      if (standing.status !== created!.status) {
        await app.db
          .update(welderQualifications)
          .set({ status: standing.status, updatedAt: nowISO() })
          .where(eq(welderQualifications.id, id));
      }
      await ledger(app.db, {
        ...scope(req),
        actorId: req.user!.id,
        action: "create",
        objectType: "welder_qualification",
        objectId: id,
        payload: created,
        storePayload: true,
      });
      return reply.status(201).send({ ...created, status: standing.status, standing });
    },
  );

  app.get("/projects/:projectId/welder-qualifications", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        status: z.enum(WELDER_QUALIFICATION_STATUSES).optional(),
        vendorId: idSchema.optional(),
        search: z.string().max(200).optional(),
      })
      .parse(req.query);
    const clauses = [
      eq(welderQualifications.companyId, req.companyId!),
      eq(welderQualifications.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(welderQualifications.status, q.status));
    if (q.vendorId) clauses.push(eq(welderQualifications.vendorId, q.vendorId));
    if (q.search) clauses.push(ilike(welderQualifications.welderName, `%${q.search}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(welderQualifications).where(where);
    const rows = await app.db
      .select()
      .from(welderQualifications)
      .where(where)
      .orderBy(asc(welderQualifications.welderName))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const today = todayISO();
    return paginate(
      rows.map((r) => ({ ...r, standing: qualificationStanding(asQual(r), today) })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.patch(
    "/projects/:projectId/welder-qualifications/:id",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = qualCreateSchema.partial().parse(req.body);
      const row = await fetchQual(id, req.companyId!, req.projectId!);
      if (row.status === "revoked") {
        throw badRequest(
          `${row.welderName}'s qualification is revoked; a revoked qualification is not edited back into life.`,
        );
      }
      await app.db
        .update(welderQualifications)
        .set(patchSet(body as Record<string, unknown>, QUAL_PATCH_COLUMNS))
        .where(eq(welderQualifications.id, id));
      const updated = await fetchQual(id, req.companyId!, req.projectId!);
      const standing = qualificationStanding(asQual(updated), todayISO());
      if (standing.status !== updated.status && updated.status !== "suspended") {
        await app.db
          .update(welderQualifications)
          .set({ status: standing.status, updatedAt: nowISO() })
          .where(eq(welderQualifications.id, id));
      }
      await ledger(app.db, {
        ...scope(req),
        actorId: req.user!.id,
        action: "update",
        objectType: "welder_qualification",
        objectId: id,
        payload: { changed: Object.keys(body), status: standing.status },
      });
      const fresh = await fetchQual(id, req.companyId!, req.projectId!);
      return { ...fresh, standing: qualificationStanding(asQual(fresh), todayISO()) };
    },
  );

  /** Continuity is a fact somebody confirms, not one the platform assumes. */
  app.post(
    "/projects/:projectId/welder-qualifications/:id/confirm-continuity",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({ confirmedAt: isoDateSchema.optional(), note: z.string().max(2000).nullable().optional() })
        .parse(req.body ?? {});
      const row = await fetchQual(id, req.companyId!, req.projectId!);
      const at = body.confirmedAt ?? todayISO();
      const standing = qualificationStanding({ ...asQual(row), continuityConfirmedAt: at }, todayISO());
      await app.db
        .update(welderQualifications)
        .set({
          continuityConfirmedAt: at,
          status: row.status === "suspended" || row.status === "revoked" ? row.status : standing.status,
          detail: { ...(row.detail as Record<string, unknown>), lastContinuityNote: body.note ?? null },
          updatedAt: nowISO(),
        })
        .where(eq(welderQualifications.id, id));
      await ledger(app.db, {
        ...scope(req),
        actorId: req.user!.id,
        action: "update",
        objectType: "welder_qualification",
        objectId: id,
        payload: { continuityConfirmedAt: at, status: standing.status, note: body.note ?? null },
        storePayload: true,
      });
      const fresh = await fetchQual(id, req.companyId!, req.projectId!);
      return { ...fresh, standing: qualificationStanding(asQual(fresh), todayISO()) };
    },
  );

  app.post(
    "/projects/:projectId/welder-qualifications/:id/suspend",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({ reason: z.string().min(1).max(4000), revoke: z.boolean().optional() })
        .parse(req.body);
      const row = await fetchQual(id, req.companyId!, req.projectId!);
      const status = body.revoke ? "revoked" : "suspended";
      await app.db
        .update(welderQualifications)
        .set({ status, suspensionReason: body.reason, updatedAt: nowISO() })
        .where(eq(welderQualifications.id, id));
      await ledger(app.db, {
        ...scope(req),
        actorId: req.user!.id,
        action: "state_change",
        objectType: "welder_qualification",
        objectId: id,
        payload: { from: row.status, to: status, reason: body.reason },
        storePayload: true,
      });
      return fetchQual(id, req.companyId!, req.projectId!);
    },
  );

  /* ---------------- welds ---------------- */

  app.post("/projects/:projectId/welds", { preHandler: standardGate }, async (req, reply) => {
    const body = weldCreateSchema.parse(req.body);
    if (body.vendorId) await assertVendor(app.db, req.companyId!, body.vendorId);
    const { number, reference } = await allocateReference(app.db, req.projectId!, "weld", "W", 4);
    const id = newId("wld");
    const [created] = await app.db
      .insert(welds)
      .values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        reference,
        weldMapRef: body.weldMapRef ?? null,
        jointReference: body.jointReference ?? null,
        jointType: body.jointType ?? null,
        description: body.description ?? null,
        drawingSheetId: body.drawingSheetId ?? null,
        drawingReference: body.drawingReference ?? null,
        isometricRef: body.isometricRef ?? null,
        lineOrElementRef: body.lineOrElementRef ?? null,
        systemId: body.systemId ?? null,
        assetId: body.assetId ?? null,
        locationId: body.locationId ?? null,
        materialSpec: body.materialSpec ?? null,
        thicknessMm: body.thicknessMm ?? null,
        diameterMm: body.diameterMm ?? null,
        heatNumbers: body.heatNumbers ?? [],
        materialCertificateIds: body.materialCertificateIds ?? [],
        wpsId: body.wpsId ?? null,
        vendorId: body.vendorId ?? null,
        ndtRequiredPercent: body.ndtRequiredPercent ?? null,
        ndtMethodsRequired: body.ndtMethodsRequired ?? [],
        itpActivityId: body.itpActivityId ?? null,
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      ...scope(req),
      actorId: req.user!.id,
      action: "create",
      objectType: "weld",
      objectId: id,
      payload: created,
      storePayload: true,
    });
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/welds", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        status: z.enum(WELD_STATUSES).optional(),
        welderQualificationId: idSchema.optional(),
        wpsId: idSchema.optional(),
        systemId: idSchema.optional(),
        heatNumber: z.string().max(100).optional(),
        search: z.string().max(200).optional(),
      })
      .parse(req.query);
    const clauses = [eq(welds.companyId, req.companyId!), eq(welds.projectId, req.projectId!)];
    if (q.status) clauses.push(eq(welds.status, q.status));
    if (q.welderQualificationId) {
      clauses.push(eq(welds.welderQualificationId, q.welderQualificationId));
    }
    if (q.wpsId) clauses.push(eq(welds.wpsId, q.wpsId));
    if (q.systemId) clauses.push(eq(welds.systemId, q.systemId));
    if (q.search) clauses.push(ilike(welds.reference, `%${q.search}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(welds).where(where);
    let rows = await app.db
      .select()
      .from(welds)
      .where(where)
      .orderBy(desc(welds.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    let total = Number(totalRow?.n ?? 0);
    if (q.heatNumber) {
      // Heat traceability searches the whole register rather than one page:
      // "which joints carry this cast" is a recall question, and a page of it
      // would be a wrong answer rather than a partial one.
      const all = await app.db.select().from(welds).where(where);
      const matching = all.filter((w) => w.heatNumbers.includes(q.heatNumber!));
      rows = matching.slice(pageOffset(q), pageOffset(q) + q.pageSize);
      total = matching.length;
    }
    return paginate(rows, total, q);
  });

  app.get("/projects/:projectId/welds/:id", { preHandler: readGate }, async (req) => {
    const { id } = req.params as { id: string };
    const weld = await fetchWeld(id, req.companyId!, req.projectId!);
    const records = await app.db
      .select()
      .from(ndtRecords)
      .where(eq(ndtRecords.weldId, id))
      .orderBy(asc(ndtRecords.number));
    const wpsRow = weld.wpsId
      ? (await app.db.select().from(weldingProcedures).where(eq(weldingProcedures.id, weld.wpsId)).limit(1))[0]
      : undefined;
    const qualRow = weld.welderQualificationId
      ? (
          await app.db
            .select()
            .from(welderQualifications)
            .where(eq(welderQualifications.id, weld.welderQualificationId))
            .limit(1)
        )[0]
      : undefined;
    return {
      ...weld,
      wps: wpsRow ?? null,
      welderQualification: qualRow ?? null,
      ndtRecords: records,
      compliance: weldCompliance(
        asWeld(weld),
        wpsRow ? asWps(wpsRow) : null,
        qualRow ? asQual(qualRow) : null,
        todayISO(),
      ),
    };
  });

  app.patch("/projects/:projectId/welds/:id", { preHandler: standardGate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = weldCreateSchema.partial().parse(req.body);
    const weld = await fetchWeld(id, req.companyId!, req.projectId!);
    if (weld.status === "accepted") {
      throw badRequest(
        `${weld.reference} is accepted; the joint's record is not edited after acceptance. Raise a repair or an NCR if something about it has changed.`,
      );
    }
    await app.db
      .update(welds)
      .set(patchSet(body as Record<string, unknown>, WELD_PATCH_COLUMNS))
      .where(eq(welds.id, id));
    await ledger(app.db, {
      ...scope(req),
      actorId: req.user!.id,
      action: "update",
      objectType: "weld",
      objectId: id,
      payload: { changed: Object.keys(body) },
    });
    return fetchWeld(id, req.companyId!, req.projectId!);
  });

  /**
   * Record that the joint was made. Refuses an unqualified weld unless the
   * caller states it happened anyway, in which case the non-conformance is
   * raised here rather than left to somebody's memory.
   */
  app.post("/projects/:projectId/welds/:id/weld", { preHandler: standardGate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = recordWeldSchema.parse(req.body);
    const weld = await fetchWeld(id, req.companyId!, req.projectId!);
    if (weld.weldedAt) {
      throw conflict(
        `${weld.reference} is already recorded as welded on ${weld.weldedAt}. A joint re-made is a repair or a cut-out, both of which are recorded as such.`,
      );
    }
    const qual = await fetchQual(body.welderQualificationId, req.companyId!, req.projectId!);
    const wpsId = body.wpsId ?? weld.wpsId;
    const wpsRow = wpsId ? await fetchWps(wpsId, req.companyId!, req.projectId!) : null;
    const weldedAt = body.weldedAt ?? todayISO();
    const candidate = { ...asWeld(weld), weldedAt, wpsId: wpsId ?? null, welderQualificationId: qual.id };
    const compliance = weldCompliance(
      candidate,
      wpsRow ? asWps(wpsRow) : null,
      asQual(qual),
      todayISO(),
    );
    if (!compliance.compliant && body.recordNonCompliant !== true) {
      throw badRequest(
        `${weld.reference} cannot be recorded as welded: ${compliance.blockers.join(" ")} ` +
          `Correct the record, or re-send with recordNonCompliant: true and a reason — a joint made outside the qualified envelope is a ` +
          `non-conformance, and the platform will raise it rather than let the weld map imply the joint was sound.`,
      );
    }
    if (!compliance.compliant && !body.nonComplianceReason) {
      throw badRequest(
        "A knowingly non-compliant weld must state why it was made. Without the reason the record cannot distinguish a data-entry correction from a departure.",
      );
    }
    const at = nowISO();
    await app.db
      .update(welds)
      .set({
        status: "welded",
        weldedAt,
        wpsId: wpsId ?? null,
        welderQualificationId: qual.id,
        welderStamp: qual.welderStamp,
        heatNumbers: body.heatNumbers ?? weld.heatNumbers,
        photoFileIds: body.photoFileIds ?? weld.photoFileIds,
        detail: {
          ...(weld.detail as Record<string, unknown>),
          ...(compliance.compliant
            ? {}
            : { nonCompliant: true, nonComplianceReason: body.nonComplianceReason ?? null }),
        },
        updatedAt: at,
      })
      .where(eq(welds.id, id));
    await ledger(app.db, {
      ...scope(req),
      actorId: req.user!.id,
      action: "state_change",
      objectType: "weld",
      objectId: id,
      payload: {
        from: weld.status,
        to: "welded",
        weldedAt,
        wpsId,
        welderQualificationId: qual.id,
        welderName: qual.welderName,
        compliance,
      },
      storePayload: true,
    });
    let ncr: { id: string; reference: string } | null = null;
    if (!compliance.compliant) {
      const raised = await createNcr(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        title: `${weld.reference} welded outside the qualified envelope`.slice(0, 300),
        description:
          `${weld.reference} was recorded as welded on ${weldedAt} with the following outside the qualified envelope: ` +
          `${compliance.blockers.join(" ")} Reason given: ${body.nonComplianceReason ?? "(none)"}.`,
        category: "process",
        severity: "major",
        sourceType: "self_identified",
        sourceId: weld.id,
        raisedAgainstVendorId: weld.vendorId ?? qual.vendorId,
        locationId: weld.locationId,
        detail: { weldId: weld.id, blockers: compliance.blockers },
      });
      ncr = { id: raised.id, reference: raised.reference };
      await app.db.update(welds).set({ ncrId: raised.id, updatedAt: at }).where(eq(welds.id, id));
    }
    const fresh = await fetchWeld(id, req.companyId!, req.projectId!);
    return { ...fresh, compliance, raised: { ncr } };
  });

  app.post("/projects/:projectId/welds/:id/visual", { preHandler: standardGate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = visualSchema.parse(req.body);
    const weld = await fetchWeld(id, req.companyId!, req.projectId!);
    if (!weld.weldedAt) {
      throw badRequest(
        `${weld.reference} has not been recorded as welded, so there is nothing to inspect visually.`,
      );
    }
    const at = nowISO();
    await app.db
      .update(welds)
      .set({
        status: body.result === "accept" ? "visual_inspected" : "rejected",
        visualResult: body.result,
        visualInspectedBy: req.user!.id,
        visualInspectedAt: body.inspectedAt ? `${body.inspectedAt}T00:00:00.000Z` : at,
        detail: { ...(weld.detail as Record<string, unknown>), visualNote: body.note ?? null },
        updatedAt: at,
      })
      .where(eq(welds.id, id));
    await ledger(app.db, {
      ...scope(req),
      actorId: req.user!.id,
      action: "state_change",
      objectType: "weld",
      objectId: id,
      payload: { from: weld.status, to: body.result === "accept" ? "visual_inspected" : "rejected", note: body.note ?? null },
      storePayload: true,
    });
    return fetchWeld(id, req.companyId!, req.projectId!);
  });

  /* ---------------- NDT ---------------- */

  app.post("/projects/:projectId/welds/:id/ndt", { preHandler: standardGate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ndtCreateSchema.parse(req.body);
    const weld = await fetchWeld(id, req.companyId!, req.projectId!);
    if (!weld.weldedAt) {
      throw badRequest(
        `${weld.reference} has not been welded yet; an examination of a joint that does not exist records nothing.`,
      );
    }
    const { number, reference } = await allocateReference(app.db, req.projectId!, "ndt", "NDT", 4);
    const ndtId = newId("ndt");
    const [created] = await app.db
      .insert(ndtRecords)
      .values({
        id: ndtId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        reference,
        weldId: id,
        method: body.method,
        techniqueRef: body.techniqueRef ?? null,
        procedureRef: body.procedureRef ?? null,
        acceptanceStandard: body.acceptanceStandard ?? null,
        coverageDescription: body.coverageDescription ?? null,
        coveragePercent: body.coveragePercent ?? null,
        requestedAt: nowISO(),
        requestedBy: req.user!.id,
        performedByOrganisation: body.performedByOrganisation ?? null,
        technicianName: body.technicianName ?? null,
        technicianLevel: body.technicianLevel ?? null,
        technicianCertNumber: body.technicianCertNumber ?? null,
        retestOfId: body.retestOfId ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await app.db
      .update(welds)
      .set({ status: weld.status === "welded" || weld.status === "visual_inspected" ? "ndt_requested" : weld.status, updatedAt: nowISO() })
      .where(eq(welds.id, id));
    await refreshWeldCounters(id);
    await ledger(app.db, {
      ...scope(req),
      actorId: req.user!.id,
      action: "create",
      objectType: "ndt_record",
      objectId: ndtId,
      payload: created,
      storePayload: true,
    });
    return reply.status(201).send(created);
  });

  /**
   * The examination result. A rejection moves the joint to `rejected`, counts
   * a repair and raises the non-conformance: the joint has to be cut out or
   * repaired to a procedure and re-examined, and none of that happens because
   * somebody remembered.
   */
  app.post(
    "/projects/:projectId/welds/:weldId/ndt/:ndtId/result",
    { preHandler: standardGate },
    async (req) => {
      const { weldId, ndtId } = req.params as { weldId: string; ndtId: string };
      const body = ndtResultSchema.parse(req.body);
      const weld = await fetchWeld(weldId, req.companyId!, req.projectId!);
      const rows = await app.db
        .select()
        .from(ndtRecords)
        .where(and(eq(ndtRecords.id, ndtId), eq(ndtRecords.weldId, weldId)))
        .limit(1);
      const record = rows[0];
      if (!record) throw notFound("NDT record not found on this weld");
      if (record.result !== "pending") {
        throw badRequest(
          `${record.reference} already records ${record.result}. A re-examination after a repair is a new record that names this one.`,
        );
      }
      if (body.result !== "pending" && !record.performedByOrganisation && !body.technicianName) {
        throw badRequest(
          "An examination result must name who performed it — the inspection body or the technician. An unattributed NDT result is not evidence.",
        );
      }
      const at = body.performedAt ?? nowISO();
      await app.db
        .update(ndtRecords)
        .set({
          result: body.result,
          performedAt: at,
          defectType: body.defectType ?? null,
          defectLengthMm: body.defectLengthMm ?? null,
          defectLocation: body.defectLocation ?? null,
          reportNumber: body.reportNumber ?? null,
          reportFileId: body.reportFileId ?? null,
          technicianName: body.technicianName ?? record.technicianName,
          technicianLevel: body.technicianLevel ?? record.technicianLevel,
          updatedAt: nowISO(),
        })
        .where(eq(ndtRecords.id, ndtId));
      const records = await refreshWeldCounters(weldId);
      const rejected = body.result === "reject";
      let ncr: { id: string; reference: string } | null = null;
      if (rejected) {
        const raised = await createNcr(app.db, {
          companyId: req.companyId!,
          projectId: req.projectId!,
          actorId: req.user!.id,
          title: `${weld.reference} rejected by ${record.method.toUpperCase()} examination`.slice(0, 300),
          description:
            `${record.reference} (${record.method.toUpperCase()}${record.acceptanceStandard ? ` to ${record.acceptanceStandard}` : ""}) rejected joint ${weld.reference}` +
            `${body.defectType ? ` for ${body.defectType}` : ""}${body.defectLengthMm ? ` of ${body.defectLengthMm} mm` : ""}` +
            `${body.defectLocation ? ` at ${body.defectLocation}` : ""}. ` +
            `The joint must be repaired to an approved procedure or cut out and re-made, and re-examined afterwards.`,
          category: "workmanship",
          severity: "major",
          sourceType: "test_record",
          sourceId: record.id,
          raisedAgainstVendorId: weld.vendorId,
          locationId: weld.locationId,
          detail: {
            weldId: weld.id,
            ndtRecordId: record.id,
            method: record.method,
            welderQualificationId: weld.welderQualificationId,
          },
        });
        ncr = { id: raised.id, reference: raised.reference };
        await app.db
          .update(welds)
          .set({
            status: "rejected",
            repairCount: weld.repairCount + 1,
            ncrId: weld.ncrId ?? raised.id,
            updatedAt: nowISO(),
          })
          .where(eq(welds.id, weldId));
        await app.db
          .update(ndtRecords)
          .set({ ncrId: raised.id, updatedAt: nowISO() })
          .where(eq(ndtRecords.id, ndtId));
      } else if (body.result === "accept") {
        const outstanding = records.filter((r) => r.id !== ndtId && r.result === "pending");
        if (outstanding.length === 0) {
          await app.db
            .update(welds)
            .set({ status: "accepted", updatedAt: nowISO() })
            .where(eq(welds.id, weldId));
        }
      }
      await ledger(app.db, {
        ...scope(req),
        actorId: req.user!.id,
        action: "state_change",
        objectType: "ndt_record",
        objectId: ndtId,
        payload: {
          weldId,
          method: record.method,
          result: body.result,
          performedAt: at,
          defectType: body.defectType ?? null,
          reportNumber: body.reportNumber ?? null,
          ncrId: ncr?.id ?? null,
        },
        storePayload: true,
      });
      const fresh = await fetchWeld(weldId, req.companyId!, req.projectId!);
      return { weld: fresh, ndtRecord: (await app.db.select().from(ndtRecords).where(eq(ndtRecords.id, ndtId)))[0], raised: { ncr } };
    },
  );

  /** A repair: the joint goes back to welded and needs examining again. */
  app.post("/projects/:projectId/welds/:id/repair", { preHandler: standardGate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        welderQualificationId: idSchema.optional(),
        repairProcedureRef: z.string().max(200).nullable().optional(),
        cutOut: z.boolean().optional(),
        note: z.string().max(4000).nullable().optional(),
        repairedAt: isoDateSchema.optional(),
      })
      .parse(req.body ?? {});
    const weld = await fetchWeld(id, req.companyId!, req.projectId!);
    if (weld.status !== "rejected") {
      throw badRequest(
        `${weld.reference} is ${weld.status}; a repair is recorded against a joint that was rejected.`,
      );
    }
    const qualId = body.welderQualificationId ?? weld.welderQualificationId;
    if (qualId) await fetchQual(qualId, req.companyId!, req.projectId!);
    const at = nowISO();
    await app.db
      .update(welds)
      .set({
        status: body.cutOut ? "cut_out" : "repaired",
        welderQualificationId: qualId,
        weldedAt: body.repairedAt ?? weld.weldedAt,
        detail: {
          ...(weld.detail as Record<string, unknown>),
          repairProcedureRef: body.repairProcedureRef ?? null,
          repairNote: body.note ?? null,
        },
        updatedAt: at,
      })
      .where(eq(welds.id, id));
    await ledger(app.db, {
      ...scope(req),
      actorId: req.user!.id,
      action: "state_change",
      objectType: "weld",
      objectId: id,
      payload: {
        from: weld.status,
        to: body.cutOut ? "cut_out" : "repaired",
        repairProcedureRef: body.repairProcedureRef ?? null,
        welderQualificationId: qualId,
        note: body.note ?? null,
      },
      storePayload: true,
    });
    return fetchWeld(id, req.companyId!, req.projectId!);
  });

  /* ---------------- the programme ---------------- */

  app.get("/projects/:projectId/welding-summary", { preHandler: readGate }, async (req) => {
    const [weldRows, ndtRows, qualRows, wpsRows] = await Promise.all([
      app.db
        .select()
        .from(welds)
        .where(and(eq(welds.companyId, req.companyId!), eq(welds.projectId, req.projectId!))),
      app.db
        .select()
        .from(ndtRecords)
        .where(
          and(eq(ndtRecords.companyId, req.companyId!), eq(ndtRecords.projectId, req.projectId!)),
        ),
      app.db
        .select()
        .from(welderQualifications)
        .where(
          and(
            eq(welderQualifications.companyId, req.companyId!),
            eq(welderQualifications.projectId, req.projectId!),
          ),
        ),
      app.db
        .select()
        .from(weldingProcedures)
        .where(
          and(
            eq(weldingProcedures.companyId, req.companyId!),
            eq(weldingProcedures.projectId, req.projectId!),
          ),
        ),
    ]);
    const today = todayISO();
    const programme = weldProgramme(weldRows.map(asWeld), ndtRows.map(asNdt));
    const performance = welderPerformance(
      weldRows.map(asWeld),
      ndtRows.map(asNdt),
      qualRows.map(asQual),
    );
    const standings = qualRows.map((q) => ({
      id: q.id,
      welderName: q.welderName,
      welderStamp: q.welderStamp,
      vendorId: q.vendorId,
      ...qualificationStanding(asQual(q), today),
    }));
    const nonCompliant = weldRows.filter(
      (w) => (w.detail as Record<string, unknown>)["nonCompliant"] === true,
    );
    return {
      programme,
      welderPerformance: performance,
      qualifications: {
        total: qualRows.length,
        valid: standings.filter((s) => s.status === "valid").length,
        expiring: standings.filter((s) => s.status === "expiring").length,
        expired: standings.filter((s) => s.status === "expired").length,
        suspended: standings.filter((s) => s.status === "suspended" || s.status === "revoked").length,
        items: standings,
      },
      procedures: {
        total: wpsRows.length,
        approved: wpsRows.filter((w) => w.status === "approved").length,
        draft: wpsRows.filter((w) => w.status === "draft").length,
      },
      nonCompliantWelds: nonCompliant.map((w) => ({
        id: w.id,
        reference: w.reference,
        reason: (w.detail as Record<string, unknown>)["nonComplianceReason"] ?? null,
      })),
      ndtRecords: ndtRows.length,
      pendingExaminations: ndtRows.filter((r) => r.result === "pending").length,
    };
  });
};
