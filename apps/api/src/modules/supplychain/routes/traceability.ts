/**
 * MATERIAL TRACEABILITY routes (spec #945–947; Vol I #721, #724–725).
 *
 * heat/batch/lot/serial → certificate → installed location. A certificate is
 * attached by one person and VERIFIED by another; the record links INTO the
 * materials catalogue and the delivery lines (equipment.material_*) rather
 * than keeping a second copy of either. `from-delivery` lifts the heat and
 * batch numbers a receiving clerk already typed on a delivery line into
 * trace records, so provenance starts where the paperwork does.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { deliverySlots, longLeadItems, materialDeliveries, materialDeliveryLines, materialTraceRecords, offsiteUnits } from "@constructos/db";
import { TRACE_CERTIFICATE_KINDS, TRACE_STATUSES } from "@constructos/shared";
import { badRequest, forbidden, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { chainCompleteness, traceCoverage, type TraceCertificate } from "../engines/traceability.js";
import { certificatesOf, persistChain, traceInput, type TraceRow } from "../service.js";
import {
  ROLLUP_CAP,
  allocateReference,
  assertLocation,
  assertMaterialItem,
  assertNode,
  assertVendor,
  buildGates,
  capped,
  countryCodeSchema,
  idSchema,
  isoDateSchema,
  ledger,
  nowISO,
  patchSchemaOf,
  patchSet,
  todayISO,
} from "../shared.js";

const certificateInputSchema = z.object({
  kind: z.enum(TRACE_CERTIFICATE_KINDS),
  reference: z.string().min(1).max(200),
  fileId: idSchema.nullable().optional(),
  issuedBy: z.string().max(200).nullable().optional(),
  issuedAt: isoDateSchema.nullable().optional(),
});

const recordBodySchema = z.object({
  description: z.string().min(1).max(500),
  materialType: z.string().max(80).nullable().optional(),
  heatNumber: z.string().max(80).nullable().optional(),
  batchNumber: z.string().max(80).nullable().optional(),
  lotNumber: z.string().max(80).nullable().optional(),
  serialNumber: z.string().max(120).nullable().optional(),
  quantity: z.number().min(0).nullable().optional(),
  unit: z.string().max(20).nullable().optional(),
  supplierNodeId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  manufacturer: z.string().max(200).nullable().optional(),
  originCountry: countryCodeSchema.nullable().optional(),
  materialItemId: idSchema.nullable().optional(),
  materialDeliveryLineId: idSchema.nullable().optional(),
  deliverySlotId: idSchema.nullable().optional(),
  longLeadItemId: idSchema.nullable().optional(),
  offsiteUnitId: idSchema.nullable().optional(),
  conformityMarking: z.string().max(120).nullable().optional(),
  responsibleSourcingScheme: z.string().max(120).nullable().optional(),
  requiresConformityMarking: z.boolean().default(false),
  receivedAt: isoDateSchema.nullable().optional(),
  certificates: z.array(certificateInputSchema).max(50).default([]),
});
const recordPatchSchema = patchSchemaOf(recordBodySchema.omit({ certificates: true }));

const listSchema = pageQuerySchema.extend({
  status: z.enum(TRACE_STATUSES).optional(),
  materialType: z.string().max(80).optional(),
  materialItemId: idSchema.optional(),
  installedLocationId: idSchema.optional(),
  offsiteUnitId: idSchema.optional(),
  chainComplete: z.enum(["0", "1"]).optional(),
  q: z.string().max(120).optional(),
});

const lookupSchema = z.object({
  heat: z.string().max(80).optional(),
  batch: z.string().max(80).optional(),
  serial: z.string().max(120).optional(),
  lot: z.string().max(80).optional(),
});

const installSchema = z.object({
  installedLocationId: idSchema,
  installedAt: isoDateSchema.optional(),
  installedRef: z.string().max(200).nullable().optional(),
});

const VOUCHING: ReadonlySet<string> = new Set(["mill_certificate", "test_certificate", "declaration_of_conformity", "ce_ukca_marking"]);

export const traceabilityRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);
  const base = "/projects/:projectId/supply-chain/trace";

  async function loadRecord(companyId: string, projectId: string, recordId: string): Promise<TraceRow> {
    const [row] = await app.db
      .select()
      .from(materialTraceRecords)
      .where(and(eq(materialTraceRecords.id, recordId), eq(materialTraceRecords.companyId, companyId), eq(materialTraceRecords.projectId, projectId)))
      .limit(1);
    if (!row) throw notFound("Traceability record not found");
    return row;
  }

  async function validateRefs(companyId: string, projectId: string, body: Partial<z.infer<typeof recordBodySchema>>) {
    if (body.vendorId) await assertVendor(app.db, companyId, body.vendorId);
    if (body.supplierNodeId) await assertNode(app.db, projectId, body.supplierNodeId);
    if (body.materialItemId) await assertMaterialItem(app.db, companyId, body.materialItemId);
    if (body.deliverySlotId) {
      const [r] = await app.db.select({ id: deliverySlots.id }).from(deliverySlots).where(and(eq(deliverySlots.id, body.deliverySlotId), eq(deliverySlots.projectId, projectId))).limit(1);
      if (!r) throw badRequest(`Delivery slot ${body.deliverySlotId} not found in this project.`);
    }
    if (body.longLeadItemId) {
      const [r] = await app.db.select({ id: longLeadItems.id }).from(longLeadItems).where(and(eq(longLeadItems.id, body.longLeadItemId), eq(longLeadItems.projectId, projectId))).limit(1);
      if (!r) throw badRequest(`Long-lead item ${body.longLeadItemId} not found in this project.`);
    }
    if (body.offsiteUnitId) {
      const [r] = await app.db.select({ id: offsiteUnits.id }).from(offsiteUnits).where(and(eq(offsiteUnits.id, body.offsiteUnitId), eq(offsiteUnits.projectId, projectId))).limit(1);
      if (!r) throw badRequest(`Offsite unit ${body.offsiteUnitId} not found in this project.`);
    }
    if (body.materialDeliveryLineId) {
      const [r] = await app.db.select({ id: materialDeliveryLines.id }).from(materialDeliveryLines).where(and(eq(materialDeliveryLines.id, body.materialDeliveryLineId), eq(materialDeliveryLines.projectId, projectId))).limit(1);
      if (!r) throw badRequest(`Delivery line ${body.materialDeliveryLineId} not found in this project.`);
    }
  }

  function toCertificate(input: z.infer<typeof certificateInputSchema>, actorId: string): TraceCertificate & { addedBy: string; addedAt: string } {
    return {
      id: newId("crt"),
      kind: input.kind,
      reference: input.reference,
      fileId: input.fileId ?? null,
      issuedBy: input.issuedBy ?? null,
      issuedAt: input.issuedAt ?? null,
      verifiedBy: null,
      verifiedAt: null,
      addedBy: actorId,
      addedAt: nowISO(),
    };
  }

  function statusAfterCertificates(status: string, certificates: TraceCertificate[]): string {
    if (status === "received" && certificates.some((c) => VOUCHING.has(c.kind))) return "certified";
    return status;
  }

  /* ---------------------------------------------------------------- */
  /* Records                                                           */
  /* ---------------------------------------------------------------- */

  app.get(`${base}/records`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = listSchema.parse(req.query);
    const where = and(
      eq(materialTraceRecords.companyId, req.companyId!),
      eq(materialTraceRecords.projectId, projectId),
      q.status ? eq(materialTraceRecords.status, q.status) : undefined,
      q.materialType ? eq(materialTraceRecords.materialType, q.materialType) : undefined,
      q.materialItemId ? eq(materialTraceRecords.materialItemId, q.materialItemId) : undefined,
      q.installedLocationId ? eq(materialTraceRecords.installedLocationId, q.installedLocationId) : undefined,
      q.offsiteUnitId ? eq(materialTraceRecords.offsiteUnitId, q.offsiteUnitId) : undefined,
      q.chainComplete ? eq(materialTraceRecords.chainComplete, Number(q.chainComplete)) : undefined,
      q.q
        ? or(
            ilike(materialTraceRecords.description, `%${q.q}%`),
            ilike(materialTraceRecords.reference, `%${q.q}%`),
            ilike(materialTraceRecords.heatNumber, `%${q.q}%`),
            ilike(materialTraceRecords.batchNumber, `%${q.q}%`),
            ilike(materialTraceRecords.serialNumber, `%${q.q}%`),
          )
        : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(materialTraceRecords).where(where).orderBy(desc(materialTraceRecords.number)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(materialTraceRecords).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/records`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = recordBodySchema.parse(req.body);
    const companyId = req.companyId!;
    if (!body.heatNumber && !body.batchNumber && !body.lotNumber && !body.serialNumber) {
      throw badRequest("A traceable lot needs at least one identifier: heat, batch, lot or serial number.");
    }
    await validateRefs(companyId, projectId, body);
    const { number, reference } = await allocateReference(app.db, projectId, "material_trace_record", "TRC");
    const certificates = body.certificates.map((c) => toCertificate(c, req.user!.id));
    const id = newId("trc");
    const [inserted] = await app.db
      .insert(materialTraceRecords)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        description: body.description,
        materialType: body.materialType ?? null,
        heatNumber: body.heatNumber ?? null,
        batchNumber: body.batchNumber ?? null,
        lotNumber: body.lotNumber ?? null,
        serialNumber: body.serialNumber ?? null,
        quantity: body.quantity ?? null,
        unit: body.unit ?? null,
        supplierNodeId: body.supplierNodeId ?? null,
        vendorId: body.vendorId ?? null,
        manufacturer: body.manufacturer ?? null,
        originCountry: body.originCountry ?? null,
        materialItemId: body.materialItemId ?? null,
        materialDeliveryLineId: body.materialDeliveryLineId ?? null,
        deliverySlotId: body.deliverySlotId ?? null,
        longLeadItemId: body.longLeadItemId ?? null,
        offsiteUnitId: body.offsiteUnitId ?? null,
        certificates,
        certificateCount: certificates.length,
        conformityMarking: body.conformityMarking ?? null,
        responsibleSourcingScheme: body.responsibleSourcingScheme ?? null,
        status: statusAfterCertificates("received", certificates),
        receivedAt: body.receivedAt ?? todayISO(),
        detail: { requiresConformityMarking: body.requiresConformityMarking },
        createdBy: req.user!.id,
      })
      .returning();
    const { row, chain } = await persistChain(app.db, inserted!);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "create", objectType: "material_trace_record", objectId: id, payload: { reference, heatNumber: body.heatNumber ?? null, batchNumber: body.batchNumber ?? null, certificates: certificates.length, chainComplete: chain.complete } });
    return reply.code(201).send({ ...row, chain });
  });

  app.get(`${base}/records/:recordId`, { preHandler: readGate }, async (req) => {
    const { projectId, recordId } = req.params as { projectId: string; recordId: string };
    const row = await loadRecord(req.companyId!, projectId, recordId);
    return { ...row, chain: chainCompleteness(traceInput(row)) };
  });

  app.patch(`${base}/records/:recordId`, { preHandler: standardGate }, async (req) => {
    const { projectId, recordId } = req.params as { projectId: string; recordId: string };
    const body = recordPatchSchema.parse(req.body);
    const companyId = req.companyId!;
    const current = await loadRecord(companyId, projectId, recordId);
    if (current.status === "installed" || current.status === "rejected") throw badRequest(`A ${current.status} record is read-only; its chain is closed.`);
    await validateRefs(companyId, projectId, body);
    const set = patchSet(body as Record<string, unknown>, [
      "description", "materialType", "heatNumber", "batchNumber", "lotNumber", "serialNumber", "quantity", "unit", "supplierNodeId", "vendorId", "manufacturer", "originCountry",
      "materialItemId", "materialDeliveryLineId", "deliverySlotId", "longLeadItemId", "offsiteUnitId", "conformityMarking", "responsibleSourcingScheme", "receivedAt",
    ]);
    if (body.requiresConformityMarking !== undefined) set["detail"] = { ...current.detail, requiresConformityMarking: body.requiresConformityMarking };
    const [updated] = await app.db.update(materialTraceRecords).set(set).where(eq(materialTraceRecords.id, recordId)).returning();
    const { row, chain } = await persistChain(app.db, updated!);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "update", objectType: "material_trace_record", objectId: recordId, payload: body });
    return { ...row, chain };
  });

  /* ---------------------------------------------------------------- */
  /* Certificates: attach, verify                                      */
  /* ---------------------------------------------------------------- */

  app.post(`${base}/records/:recordId/certificates`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId, recordId } = req.params as { projectId: string; recordId: string };
    const body = certificateInputSchema.parse(req.body);
    const companyId = req.companyId!;
    const current = await loadRecord(companyId, projectId, recordId);
    if (current.status === "rejected") throw badRequest("A rejected lot takes no further certificates.");
    const cert = toCertificate(body, req.user!.id);
    const certificates = [...certificatesOf(current), cert];
    const [updated] = await app.db
      .update(materialTraceRecords)
      .set({ certificates, certificateCount: certificates.length, status: statusAfterCertificates(current.status, certificates), updatedAt: nowISO() })
      .where(eq(materialTraceRecords.id, recordId))
      .returning();
    const { row, chain } = await persistChain(app.db, updated!);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "update", objectType: "material_trace_record", objectId: recordId, payload: { certificateAdded: { id: cert.id, kind: cert.kind, reference: cert.reference } } });
    return reply.code(201).send({ ...row, chain, certificate: cert });
  });

  /** Verification by a second person: whoever attached the certificate cannot vouch for it. */
  app.post(`${base}/records/:recordId/certificates/:certificateId/verify`, { preHandler: standardGate }, async (req) => {
    const { projectId, recordId, certificateId } = req.params as { projectId: string; recordId: string; certificateId: string };
    const body = z.object({ note: z.string().max(2000).optional() }).parse(req.body ?? {});
    const companyId = req.companyId!;
    const current = await loadRecord(companyId, projectId, recordId);
    const certificates = certificatesOf(current) as Array<TraceCertificate & { addedBy?: string }>;
    const cert = certificates.find((c) => c.id === certificateId);
    if (!cert) throw notFound("Certificate not found on this record");
    if (cert.verifiedBy) throw badRequest("Certificate already verified.");
    if (cert.addedBy === req.user!.id || current.createdBy === req.user!.id && !cert.addedBy) {
      throw forbidden("A certificate must be verified by someone other than the person who attached it.");
    }
    cert.verifiedBy = req.user!.id;
    cert.verifiedAt = nowISO();
    const [updated] = await app.db
      .update(materialTraceRecords)
      .set({ certificates, updatedAt: nowISO() })
      .where(eq(materialTraceRecords.id, recordId))
      .returning();
    const { row, chain } = await persistChain(app.db, updated!);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "state_change", objectType: "material_trace_record", objectId: recordId, payload: { certificateVerified: { id: cert.id, kind: cert.kind, reference: cert.reference, addedBy: cert.addedBy ?? null, note: body.note ?? null } } });
    return { ...row, chain };
  });

  /* ---------------------------------------------------------------- */
  /* Lifecycle: install, quarantine, release, reject                   */
  /* ---------------------------------------------------------------- */

  app.post(`${base}/records/:recordId/install`, { preHandler: standardGate }, async (req) => {
    const { projectId, recordId } = req.params as { projectId: string; recordId: string };
    const body = installSchema.parse(req.body);
    const companyId = req.companyId!;
    const current = await loadRecord(companyId, projectId, recordId);
    if (current.status === "installed") throw badRequest("Already installed.");
    if (current.status === "rejected") throw badRequest("A rejected lot cannot be installed.");
    if (current.status === "quarantined") throw badRequest("Release the lot from quarantine before installing it.");
    await assertLocation(app.db, projectId, body.installedLocationId);
    const chainBefore = chainCompleteness(traceInput(current));
    const at = body.installedAt ?? todayISO();
    const [updated] = await app.db
      .update(materialTraceRecords)
      .set({ status: "installed", installedLocationId: body.installedLocationId, installedAt: at, installedRef: body.installedRef ?? null, installedBy: req.user!.id, updatedAt: nowISO() })
      .where(eq(materialTraceRecords.id, recordId))
      .returning();
    const { row, chain } = await persistChain(app.db, updated!);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "state_change", objectType: "material_trace_record", objectId: recordId, payload: { from: current.status, to: "installed", installedLocationId: body.installedLocationId, at, certificateBeforeInstall: chainBefore.links.certificate } });
    return {
      ...row,
      chain,
      warnings: chainBefore.links.certificate ? [] : ["Installed without a vouching certificate on file. The chain stays incomplete until one is attached and verified."],
    };
  });

  app.post(`${base}/records/:recordId/quarantine`, { preHandler: standardGate }, async (req) => {
    const { projectId, recordId } = req.params as { projectId: string; recordId: string };
    const body = z.object({ reason: z.string().min(1).max(2000) }).parse(req.body);
    const companyId = req.companyId!;
    const current = await loadRecord(companyId, projectId, recordId);
    if (current.status !== "received" && current.status !== "certified") throw badRequest(`A ${current.status} lot cannot be quarantined.`);
    const [updated] = await app.db
      .update(materialTraceRecords)
      .set({ status: "quarantined", detail: { ...current.detail, quarantineReason: body.reason, statusBeforeQuarantine: current.status }, updatedAt: nowISO() })
      .where(eq(materialTraceRecords.id, recordId))
      .returning();
    const { row, chain } = await persistChain(app.db, updated!);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "state_change", objectType: "material_trace_record", objectId: recordId, payload: { from: current.status, to: "quarantined", reason: body.reason } });
    return { ...row, chain };
  });

  app.post(`${base}/records/:recordId/release`, { preHandler: standardGate }, async (req) => {
    const { projectId, recordId } = req.params as { projectId: string; recordId: string };
    const body = z.object({ note: z.string().min(1).max(2000) }).parse(req.body);
    const companyId = req.companyId!;
    const current = await loadRecord(companyId, projectId, recordId);
    if (current.status !== "quarantined") throw badRequest("Only a quarantined lot can be released.");
    const detail = current.detail as Record<string, unknown>;
    const next = statusAfterCertificates("received", certificatesOf(current));
    const [updated] = await app.db
      .update(materialTraceRecords)
      .set({ status: next, detail: { ...detail, releaseNote: body.note }, updatedAt: nowISO() })
      .where(eq(materialTraceRecords.id, recordId))
      .returning();
    const { row, chain } = await persistChain(app.db, updated!);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "state_change", objectType: "material_trace_record", objectId: recordId, payload: { from: "quarantined", to: next, note: body.note } });
    return { ...row, chain };
  });

  app.post(`${base}/records/:recordId/reject`, { preHandler: standardGate }, async (req) => {
    const { projectId, recordId } = req.params as { projectId: string; recordId: string };
    const body = z.object({ reason: z.string().min(1).max(2000) }).parse(req.body);
    const companyId = req.companyId!;
    const current = await loadRecord(companyId, projectId, recordId);
    if (current.status === "installed") throw badRequest("An installed lot cannot be rejected from here; raise a non-conformance.");
    if (current.status === "rejected") throw badRequest("Already rejected.");
    const [updated] = await app.db
      .update(materialTraceRecords)
      .set({ status: "rejected", detail: { ...current.detail, rejectReason: body.reason }, updatedAt: nowISO() })
      .where(eq(materialTraceRecords.id, recordId))
      .returning();
    const { row, chain } = await persistChain(app.db, updated!);
    await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "state_change", objectType: "material_trace_record", objectId: recordId, payload: { from: current.status, to: "rejected", reason: body.reason } });
    return { ...row, chain };
  });

  /* ---------------------------------------------------------------- */
  /* From a material delivery (equipment.material_delivery_lines)      */
  /* ---------------------------------------------------------------- */

  app.post(`${base}/from-delivery/:deliveryId`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId, deliveryId } = req.params as { projectId: string; deliveryId: string };
    const body = z.object({ certificateKind: z.enum(TRACE_CERTIFICATE_KINDS).default("mill_certificate"), materialType: z.string().max(80).nullable().optional() }).parse(req.body ?? {});
    const companyId = req.companyId!;
    const [delivery] = await app.db
      .select()
      .from(materialDeliveries)
      .where(and(eq(materialDeliveries.id, deliveryId), eq(materialDeliveries.companyId, companyId), eq(materialDeliveries.projectId, projectId)))
      .limit(1);
    if (!delivery) throw notFound("Material delivery not found");
    const lines = await app.db
      .select()
      .from(materialDeliveryLines)
      .where(eq(materialDeliveryLines.deliveryId, deliveryId))
      .orderBy(asc(materialDeliveryLines.position));
    const already = new Set(
      (await app.db
        .select({ lineId: materialTraceRecords.materialDeliveryLineId })
        .from(materialTraceRecords)
        .where(and(eq(materialTraceRecords.projectId, projectId), inArray(materialTraceRecords.materialDeliveryLineId, lines.map((l) => l.id).concat(["-"])))))
        .map((r) => r.lineId),
    );
    const [slot] = await app.db.select({ id: deliverySlots.id }).from(deliverySlots).where(and(eq(deliverySlots.projectId, projectId), eq(deliverySlots.materialDeliveryId, deliveryId))).limit(1);
    const created: Array<{ id: string; reference: string; lineId: string }> = [];
    const skipped: Array<{ lineId: string; reason: string }> = [];
    for (const line of lines) {
      if (already.has(line.id)) {
        skipped.push({ lineId: line.id, reason: "already traced" });
        continue;
      }
      const serial = line.serialNumbers[0] ?? null;
      if (!line.heatNumber && !line.batchNumber && !serial) {
        skipped.push({ lineId: line.id, reason: "no heat, batch or serial number on the line" });
        continue;
      }
      const { number, reference } = await allocateReference(app.db, projectId, "material_trace_record", "TRC");
      const certificates = line.certificateFileIds.map((fileId) => ({ ...toCertificate({ kind: body.certificateKind, reference: `file:${fileId}`, fileId }, req.user!.id) }));
      const id = newId("trc");
      const [inserted] = await app.db
        .insert(materialTraceRecords)
        .values({
          id,
          companyId,
          projectId,
          number,
          reference,
          description: line.description,
          materialType: body.materialType ?? null,
          heatNumber: line.heatNumber,
          batchNumber: line.batchNumber,
          serialNumber: serial,
          quantity: line.quantityAccepted > 0 ? line.quantityAccepted : line.quantityReceived,
          unit: line.unit,
          vendorId: delivery.supplierVendorId,
          materialItemId: line.materialItemId,
          materialDeliveryLineId: line.id,
          deliverySlotId: slot?.id ?? null,
          certificates,
          certificateCount: certificates.length,
          status: statusAfterCertificates("received", certificates),
          receivedAt: (delivery.receivedAt ?? delivery.arrivedAt ?? nowISO()).slice(0, 10),
          detail: { requiresConformityMarking: false, source: `material_delivery:${deliveryId}` },
          createdBy: req.user!.id,
        })
        .returning();
      await persistChain(app.db, inserted!);
      await ledger(app.db, { companyId, projectId, actorId: req.user!.id, action: "create", objectType: "material_trace_record", objectId: id, payload: { reference, fromDelivery: deliveryId, lineId: line.id, heatNumber: line.heatNumber, batchNumber: line.batchNumber } });
      created.push({ id, reference, lineId: line.id });
    }
    return reply.code(201).send({ deliveryId, created, skipped });
  });

  /* ---------------------------------------------------------------- */
  /* Lookup and coverage                                               */
  /* ---------------------------------------------------------------- */

  app.get(`${base}/lookup`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = lookupSchema.parse(req.query);
    if (!q.heat && !q.batch && !q.serial && !q.lot) throw badRequest("Give a heat, batch, lot or serial number to look up.");
    const rows = await app.db
      .select()
      .from(materialTraceRecords)
      .where(
        and(
          eq(materialTraceRecords.companyId, req.companyId!),
          eq(materialTraceRecords.projectId, projectId),
          q.heat ? ilike(materialTraceRecords.heatNumber, q.heat) : undefined,
          q.batch ? ilike(materialTraceRecords.batchNumber, q.batch) : undefined,
          q.serial ? ilike(materialTraceRecords.serialNumber, q.serial) : undefined,
          q.lot ? ilike(materialTraceRecords.lotNumber, q.lot) : undefined,
        ),
      )
      .limit(200);
    return { items: rows.map((r) => ({ ...r, chain: chainCompleteness(traceInput(r)) })), total: rows.length };
  });

  app.get(`${base}/coverage`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const all = await app.db
      .select({ id: materialTraceRecords.id, reference: materialTraceRecords.reference, description: materialTraceRecords.description, materialType: materialTraceRecords.materialType, status: materialTraceRecords.status, chainComplete: materialTraceRecords.chainComplete, certificateCount: materialTraceRecords.certificateCount, chainGaps: materialTraceRecords.chainGaps, installedLocationId: materialTraceRecords.installedLocationId })
      .from(materialTraceRecords)
      .where(and(eq(materialTraceRecords.companyId, req.companyId!), eq(materialTraceRecords.projectId, projectId)))
      .limit(ROLLUP_CAP + 1);
    const capRows = capped(all, "traceability records");
    const rows = capRows.rows;
    const overall = traceCoverage(rows);
    const byType = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = r.materialType ?? "unclassified";
      const list = byType.get(k) ?? [];
      list.push(r);
      byType.set(k, list);
    }
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    return {
      ...overall,
      truncated: capRows.notice ? [capRows.notice] : [],
      reasons: capRows.notice ? [capRows.notice, ...overall.reasons] : overall.reasons,
      byStatus,
      byMaterialType: [...byType.entries()].map(([materialType, list]) => ({ materialType, ...traceCoverage(list) })),
      installedWithoutCertificateItems: rows.filter((r) => r.status === "installed" && r.certificateCount === 0).slice(0, 50).map((r) => ({ id: r.id, reference: r.reference, description: r.description, installedLocationId: r.installedLocationId })),
      openGaps: rows.filter((r) => r.chainComplete === 0 && r.status !== "rejected").slice(0, 50).map((r) => ({ id: r.id, reference: r.reference, description: r.description, status: r.status, gaps: r.chainGaps })),
    };
  });
};
