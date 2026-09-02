/**
 * The material test certificate register (#1089).
 *
 * The supply-chain module traces the LOT (heat → delivery → installed
 * location). This register holds the CERTIFICATE and the act of reading it:
 * somebody has to compare the yield strength on the mill certificate with the
 * one the specification demanded, and record that they did. Until that
 * happens the certificate is a file in a folder, not evidence.
 *
 * Two things the register refuses to blur:
 *
 *  - An EN 10204 2.2 document is not specific to the delivered cast and
 *    cannot bind the steel on site to the numbers on the page. It is filed
 *    and reported as untraceable rather than passed.
 *  - A requirement the certificate is silent on fails the check. Passing by
 *    omission is how an unspecified property becomes an unverified one.
 */

import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray } from "drizzle-orm";
import { z } from "zod";
import { materialTestCertificates } from "@constructos/db";
import { CERTIFICATE_TYPES, CERTIFICATE_VERIFICATION_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, notFound } from "../../lib/errors.js";
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
  verifyCertificate,
  type MeasuredProperty,
  type RequiredProperty,
} from "./certificateCheck.js";
import { createNcr } from "./raise.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const requiredPropertySchema = z.object({
  property: z.string().min(1).max(200),
  min: z.number().finite().nullable().optional(),
  max: z.number().finite().nullable().optional(),
  target: z.number().finite().nullable().optional(),
  unit: z.string().max(50).nullable().optional(),
  text: z.string().max(2000).nullable().optional(),
});

const measuredPropertySchema = z.object({
  property: z.string().min(1).max(200),
  value: z.number().finite().nullable().optional(),
  text: z.string().max(2000).nullable().optional(),
  unit: z.string().max(50).nullable().optional(),
});

const createSchema = z.object({
  certificateNumber: z.string().min(1).max(200),
  certificateType: z.enum(CERTIFICATE_TYPES).optional(),
  materialDescription: z.string().min(1).max(500),
  materialType: z.string().max(200).nullable().optional(),
  materialGrade: z.string().max(200).nullable().optional(),
  standard: z.string().max(200).nullable().optional(),
  heatNumber: z.string().max(100).nullable().optional(),
  batchNumber: z.string().max(100).nullable().optional(),
  castNumber: z.string().max(100).nullable().optional(),
  lotNumber: z.string().max(100).nullable().optional(),
  serialNumbers: z.array(z.string().max(100)).max(200).optional(),
  quantity: z.number().finite().nullable().optional(),
  unit: z.string().max(50).nullable().optional(),
  manufacturer: z.string().max(200).nullable().optional(),
  millName: z.string().max(200).nullable().optional(),
  supplierVendorId: idSchema.nullable().optional(),
  originCountry: z.string().max(100).nullable().optional(),
  issuedAt: isoDateSchema.nullable().optional(),
  receivedAt: isoDateSchema.nullable().optional(),
  materialTraceRecordId: idSchema.nullable().optional(),
  materialItemId: idSchema.nullable().optional(),
  deliveryId: idSchema.nullable().optional(),
  specSectionId: idSchema.nullable().optional(),
  specClauseRef: z.string().max(200).nullable().optional(),
  submittalId: idSchema.nullable().optional(),
  requiredProperties: z.array(requiredPropertySchema).max(100).optional(),
  measuredProperties: z.array(measuredPropertySchema).max(200).optional(),
  documentFileId: idSchema.nullable().optional(),
  attachmentFileIds: fileIdsSchema.optional(),
  installedLocationIds: z.array(idSchema).max(200).optional(),
  installedDescription: z.string().max(2000).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const PATCH_COLUMNS = [
  "certificateNumber",
  "certificateType",
  "materialDescription",
  "materialType",
  "materialGrade",
  "standard",
  "heatNumber",
  "batchNumber",
  "castNumber",
  "lotNumber",
  "serialNumbers",
  "quantity",
  "unit",
  "manufacturer",
  "millName",
  "supplierVendorId",
  "originCountry",
  "issuedAt",
  "receivedAt",
  "materialTraceRecordId",
  "materialItemId",
  "deliveryId",
  "specSectionId",
  "specClauseRef",
  "submittalId",
  "requiredProperties",
  "measuredProperties",
  "documentFileId",
  "attachmentFileIds",
  "installedLocationIds",
  "installedDescription",
  "detail",
] as const;

const listQuery = pageQuerySchema.extend({
  verificationStatus: z.enum(CERTIFICATE_VERIFICATION_STATUSES).optional(),
  certificateType: z.enum(CERTIFICATE_TYPES).optional(),
  supplierVendorId: idSchema.optional(),
  heatNumber: z.string().max(100).optional(),
  batchNumber: z.string().max(100).optional(),
  search: z.string().max(200).optional(),
});

function assessment(row: typeof materialTestCertificates.$inferSelect) {
  return verifyCertificate({
    certificateType: row.certificateType,
    heatNumber: row.heatNumber,
    batchNumber: row.batchNumber,
    castNumber: row.castNumber,
    documentFileId: row.documentFileId,
    required: row.requiredProperties as RequiredProperty[],
    measured: row.measuredProperties as MeasuredProperty[],
  });
}

/* ------------------------------------------------------------------ */
/* Sweep                                                               */
/* ------------------------------------------------------------------ */

/**
 * Certificates that have sat unverified. The window is deliberately short:
 * the moment to challenge a mill certificate is before the steel is in the
 * frame, and every day after delivery makes rejection more expensive.
 */
export async function sweepCertificates(
  db: Db,
  companyId: string,
  asOf: string = todayISO(),
  graceDays = 14,
): Promise<{ raised: number }> {
  const rows = await db
    .select()
    .from(materialTestCertificates)
    .where(
      and(
        eq(materialTestCertificates.companyId, companyId),
        eq(materialTestCertificates.verificationStatus, "unverified"),
      ),
    );
  if (rows.length === 0) return { raised: 0 };
  const cutoff = new Date(Date.parse(`${asOf}T00:00:00Z`) - graceDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const stale = rows.filter((r) => (r.receivedAt ?? r.createdAt.slice(0, 10)) <= cutoff);
  if (stale.length === 0) return { raised: 0 };
  const seen = await alreadySignalled(db, companyId, QUALITY_DETECTORS.certificateUnverified);
  let raised = 0;
  for (const row of stale) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const check = assessment(row);
    await raiseSignal(db, companyId, row.projectId, null, {
      detector: QUALITY_DETECTORS.certificateUnverified,
      severity: "medium",
      confidence: 1,
      title: `Material certificate ${row.reference} has not been verified — ${row.materialDescription}`,
      explanation:
        `${row.reference} (certificate ${row.certificateNumber}${row.heatNumber ? `, heat ${row.heatNumber}` : ""}) was received on ` +
        `${row.receivedAt ?? row.createdAt.slice(0, 10)} and nobody has compared its numbers with the specification. ` +
        `${check.reasons.join(" ")} ` +
        `A certificate in the folder is not evidence; a certificate somebody read is. The moment to reject material is before it is installed.`,
      key: row.id,
      evidence: {
        certificateId: row.id,
        reference: row.reference,
        certificateNumber: row.certificateNumber,
        heatNumber: row.heatNumber,
        receivedAt: row.receivedAt,
        supplierVendorId: row.supplierVendorId,
        lotTraceable: check.lotTraceable,
      },
    });
    raised += 1;
  }
  return { raised };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const certificateRoutes: FastifyPluginAsync = async (app) => {
  const { memberGate, readGate, standardGate } = buildGates(app);

  async function fetchOr404(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(materialTestCertificates)
      .where(
        and(
          eq(materialTestCertificates.id, id),
          eq(materialTestCertificates.companyId, companyId),
          eq(materialTestCertificates.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Material test certificate not found");
    return rows[0];
  }

  const decorate = (row: typeof materialTestCertificates.$inferSelect) => ({
    ...row,
    check: assessment(row),
  });

  app.post(
    "/projects/:projectId/material-certificates",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = createSchema.parse(req.body);
      if (body.supplierVendorId) await assertVendor(app.db, req.companyId!, body.supplierVendorId);
      const { number, reference } = await allocateReference(
        app.db,
        req.projectId!,
        "material_certificate",
        "MTC",
        4,
      );
      const id = newId("mtc");
      const [created] = await app.db
        .insert(materialTestCertificates)
        .values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          number,
          reference,
          certificateNumber: body.certificateNumber,
          certificateType: body.certificateType ?? "en_10204_3_1",
          materialDescription: body.materialDescription,
          materialType: body.materialType ?? null,
          materialGrade: body.materialGrade ?? null,
          standard: body.standard ?? null,
          heatNumber: body.heatNumber ?? null,
          batchNumber: body.batchNumber ?? null,
          castNumber: body.castNumber ?? null,
          lotNumber: body.lotNumber ?? null,
          serialNumbers: body.serialNumbers ?? [],
          quantity: body.quantity ?? null,
          unit: body.unit ?? null,
          manufacturer: body.manufacturer ?? null,
          millName: body.millName ?? null,
          supplierVendorId: body.supplierVendorId ?? null,
          originCountry: body.originCountry ?? null,
          issuedAt: body.issuedAt ?? null,
          receivedAt: body.receivedAt ?? todayISO(),
          materialTraceRecordId: body.materialTraceRecordId ?? null,
          materialItemId: body.materialItemId ?? null,
          deliveryId: body.deliveryId ?? null,
          specSectionId: body.specSectionId ?? null,
          specClauseRef: body.specClauseRef ?? null,
          submittalId: body.submittalId ?? null,
          requiredProperties: body.requiredProperties ?? [],
          measuredProperties: body.measuredProperties ?? [],
          documentFileId: body.documentFileId ?? null,
          attachmentFileIds: body.attachmentFileIds ?? [],
          installedLocationIds: body.installedLocationIds ?? [],
          installedDescription: body.installedDescription ?? null,
          detail: body.detail ?? {},
          createdBy: req.user!.id,
        })
        .returning();
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "material_test_certificate",
        objectId: id,
        payload: created,
        storePayload: true,
      });
      return reply.status(201).send(decorate(created!));
    },
  );

  app.get("/projects/:projectId/material-certificates", { preHandler: readGate }, async (req) => {
    const q = listQuery.parse(req.query);
    const clauses = [
      eq(materialTestCertificates.companyId, req.companyId!),
      eq(materialTestCertificates.projectId, req.projectId!),
    ];
    if (q.verificationStatus) {
      clauses.push(eq(materialTestCertificates.verificationStatus, q.verificationStatus));
    }
    if (q.certificateType) clauses.push(eq(materialTestCertificates.certificateType, q.certificateType));
    if (q.supplierVendorId) clauses.push(eq(materialTestCertificates.supplierVendorId, q.supplierVendorId));
    if (q.heatNumber) clauses.push(eq(materialTestCertificates.heatNumber, q.heatNumber));
    if (q.batchNumber) clauses.push(eq(materialTestCertificates.batchNumber, q.batchNumber));
    if (q.search) clauses.push(ilike(materialTestCertificates.materialDescription, `%${q.search}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(materialTestCertificates)
      .where(where);
    const rows = await app.db
      .select()
      .from(materialTestCertificates)
      .where(where)
      .orderBy(desc(materialTestCertificates.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows.map(decorate), Number(totalRow?.n ?? 0), q);
  });

  /**
   * Heat traceability, company-wide. "Which certificates cover cast H-1234"
   * is a recall question — it crosses projects, because the cast did.
   */
  app.get("/companies/current/material-certificates/trace", { preHandler: memberGate }, async (req) => {
    const q = z
      .object({
        heatNumber: z.string().max(100).optional(),
        batchNumber: z.string().max(100).optional(),
      })
      .parse(req.query ?? {});
    if (!q.heatNumber && !q.batchNumber) {
      throw badRequest("Give a heat number or a batch number to trace.");
    }
    const clauses = [eq(materialTestCertificates.companyId, req.companyId!)];
    if (q.heatNumber) clauses.push(eq(materialTestCertificates.heatNumber, q.heatNumber));
    if (q.batchNumber) clauses.push(eq(materialTestCertificates.batchNumber, q.batchNumber));
    const rows = await app.db
      .select()
      .from(materialTestCertificates)
      .where(and(...clauses))
      .orderBy(asc(materialTestCertificates.createdAt))
      .limit(200);
    return {
      items: rows.map(decorate),
      total: rows.length,
      reasons:
        rows.length === 0
          ? [
              `No certificate in this company records ${q.heatNumber ? `heat ${q.heatNumber}` : `batch ${q.batchNumber}`}. Either the material was received without a certificate, or the certificate was filed without its heat number — both are worth knowing before the material is installed.`,
            ]
          : [],
    };
  });

  app.get("/projects/:projectId/material-certificates/:id", { preHandler: readGate }, async (req) => {
    const { id } = req.params as { id: string };
    return decorate(await fetchOr404(id, req.companyId!, req.projectId!));
  });

  app.patch(
    "/projects/:projectId/material-certificates/:id",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = createSchema.partial().parse(req.body);
      const row = await fetchOr404(id, req.companyId!, req.projectId!);
      if (row.verificationStatus === "verified") {
        throw badRequest(
          `${row.reference} has been verified. The numbers somebody checked are the numbers on the record — supersede the certificate instead of editing it.`,
        );
      }
      if (body.supplierVendorId) await assertVendor(app.db, req.companyId!, body.supplierVendorId);
      await app.db
        .update(materialTestCertificates)
        .set(patchSet(body as Record<string, unknown>, PATCH_COLUMNS))
        .where(eq(materialTestCertificates.id, id));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "material_test_certificate",
        objectId: id,
        payload: { changed: Object.keys(body) },
      });
      return decorate(await fetchOr404(id, req.companyId!, req.projectId!));
    },
  );

  /**
   * The act of reading the certificate. Segregated from filing it: the person
   * who booked the delivery in is not the person who decides the steel meets
   * the specification.
   */
  app.post(
    "/projects/:projectId/material-certificates/:id/verify",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          notes: z.string().max(10_000).nullable().optional(),
          measuredProperties: z.array(measuredPropertySchema).max(200).optional(),
          raiseNcrOnFailure: z.boolean().optional(),
        })
        .parse(req.body ?? {});
      const row = await fetchOr404(id, req.companyId!, req.projectId!);
      if (row.verificationStatus === "verified") {
        throw badRequest(`${row.reference} is already verified by ${row.verifiedBy ?? "—"}.`);
      }
      assertDistinctActor(
        req.user!.id,
        row.createdBy,
        `Verification of certificate ${row.reference}`,
        "recorded",
      );
      const measured = body.measuredProperties ?? (row.measuredProperties as MeasuredProperty[]);
      const check = verifyCertificate({
        certificateType: row.certificateType,
        heatNumber: row.heatNumber,
        batchNumber: row.batchNumber,
        castNumber: row.castNumber,
        documentFileId: row.documentFileId,
        required: row.requiredProperties as RequiredProperty[],
        measured,
      });
      if ((row.requiredProperties as RequiredProperty[]).length === 0) {
        throw badRequest(
          `${row.reference} lists no specified properties, so there is nothing to verify it against. Record what the specification demands first — otherwise "verified" means only that somebody opened the file.`,
        );
      }
      const at = nowISO();
      await app.db
        .update(materialTestCertificates)
        .set({
          measuredProperties: measured,
          verificationStatus: check.status,
          verificationReasons: [...check.reasons, ...check.verdicts.filter((v) => v.passed === false).map((v) => v.reason)],
          verifiedBy: req.user!.id,
          verifiedAt: at,
          verificationNotes: body.notes ?? null,
          updatedAt: at,
        })
        .where(eq(materialTestCertificates.id, id));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "material_test_certificate",
        objectId: id,
        payload: {
          from: row.verificationStatus,
          to: check.status,
          verdicts: check.verdicts,
          lotTraceable: check.lotTraceable,
          notes: body.notes ?? null,
        },
        storePayload: true,
      });
      let ncr: { id: string; reference: string } | null = null;
      if (check.status === "failed" && body.raiseNcrOnFailure !== false && !row.ncrId) {
        const raised = await createNcr(app.db, {
          companyId: req.companyId!,
          projectId: req.projectId!,
          actorId: req.user!.id,
          title: `${row.reference} — material certificate fails the specification`.slice(0, 300),
          description:
            `Certificate ${row.certificateNumber} for ${row.materialDescription}` +
            `${row.heatNumber ? ` (heat ${row.heatNumber})` : ""} does not meet the specified properties. ` +
            check.verdicts
              .filter((v) => v.passed === false)
              .map((v) => v.reason)
              .join(" "),
          category: "material",
          severity: "major",
          sourceType: "delivery",
          sourceId: row.id,
          raisedAgainstVendorId: row.supplierVendorId,
          specSectionId: row.specSectionId,
          specClauseRef: row.specClauseRef,
          detail: { certificateId: row.id, heatNumber: row.heatNumber },
        });
        ncr = { id: raised.id, reference: raised.reference };
        await app.db
          .update(materialTestCertificates)
          .set({ ncrId: raised.id, updatedAt: nowISO() })
          .where(eq(materialTestCertificates.id, id));
      }
      return { ...decorate(await fetchOr404(id, req.companyId!, req.projectId!)), raised: { ncr } };
    },
  );

  app.get(
    "/projects/:projectId/material-certificates-summary",
    { preHandler: readGate },
    async (req) => {
      const rows = await app.db
        .select()
        .from(materialTestCertificates)
        .where(
          and(
            eq(materialTestCertificates.companyId, req.companyId!),
            eq(materialTestCertificates.projectId, req.projectId!),
          ),
        );
      const byStatus: Record<string, number> = {};
      const byType: Record<string, number> = {};
      let untraceable = 0;
      let withoutDocument = 0;
      let withoutHeat = 0;
      for (const row of rows) {
        byStatus[row.verificationStatus] = (byStatus[row.verificationStatus] ?? 0) + 1;
        byType[row.certificateType] = (byType[row.certificateType] ?? 0) + 1;
        const check = assessment(row);
        if (!check.lotTraceable) untraceable += 1;
        if (!row.documentFileId) withoutDocument += 1;
        if (!row.heatNumber && !row.batchNumber && !row.castNumber) withoutHeat += 1;
      }
      return {
        total: rows.length,
        byStatus,
        byType,
        unverified: rows.filter((r) => r.verificationStatus === "unverified").length,
        failed: rows.filter((r) => r.verificationStatus === "failed").length,
        untraceable,
        withoutDocument,
        withoutHeat,
        reasons:
          rows.length === 0
            ? [
                "No material test certificate has been recorded on this project. That is either a project with no certified material or a project that is not filing them — the delivery register will say which.",
              ]
            : [],
      };
    },
  );

  app.post(
    "/projects/:projectId/material-certificates/sweep",
    { preHandler: standardGate },
    async (req) => {
      const body = z.object({ asOf: isoDateSchema.optional() }).parse(req.body ?? {});
      return sweepCertificates(app.db, req.companyId!, body.asOf ?? todayISO());
    },
  );

  /** Certificates against a set of heat numbers, for the weld map's traceability panel. */
  app.post(
    "/projects/:projectId/material-certificates/lookup",
    { preHandler: readGate },
    async (req) => {
      const body = z
        .object({ heatNumbers: z.array(z.string().min(1).max(100)).min(1).max(100) })
        .parse(req.body);
      const rows = await app.db
        .select()
        .from(materialTestCertificates)
        .where(
          and(
            eq(materialTestCertificates.companyId, req.companyId!),
            eq(materialTestCertificates.projectId, req.projectId!),
            inArray(materialTestCertificates.heatNumber, body.heatNumbers),
          ),
        );
      const found = new Set(rows.map((r) => r.heatNumber).filter((h): h is string => !!h));
      return {
        items: rows.map(decorate),
        missing: body.heatNumbers.filter((h) => !found.has(h)),
      };
    },
  );
};
