/**
 * PRIME CONTRACT LIFECYCLE ROUTES — the platform-upgrade half of the prime
 * contract module, registered from index.ts as a sub-plugin under the same
 * `contracts` tool key.
 *
 * Covers, by spec function:
 *   #508–512  owner change order register analytics (by status, reason,
 *             cycle time, monthly execution, pending age)
 *   #514      AIA G702/G703 data export (JSON and CSV)
 *   #516      stored materials register: every G703 column F figure backed
 *             by material that is stored, insured and evidenced
 *   #517      retainage lifecycle: held by line, releases, the contractual
 *             step-down / final-release proposal with its gate
 *   #518      multi-receipt owner payment tracking with ageing and a
 *             dunning list; settlement derived from receipts
 *   #519      contract compliance documents gating application submission,
 *             with an expiry sweep on the platform scheduler
 *   plan §3.5 health inputs for the intelligence layer
 *
 * Deliberately NOT here: the owner portal (an external-review workflow step
 * with an owner-side login). The owner's identity on an approval or a
 * certification is recorded on the record (index.ts) and ledgered, but no
 * separate portal view exists in this wave.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import {
  commitments,
  invoiceLineItems,
  lienWaivers,
  ownerPaymentReceipts,
  paymentApplications,
  primeContractComplianceDocuments,
  primeContractSovLines,
  primeContracts,
  primeStoredMaterials,
  retainageReleases,
  vendors,
} from "@constructos/db";
import {
  OWNER_PAYMENT_RECEIPT_METHODS,
  PRIME_COMPLIANCE_DOCUMENT_KINDS,
  PRIME_COMPLIANCE_DOCUMENT_STATUSES,
  STORED_MATERIAL_LOCATIONS,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import {
  aiaCsv,
  aiaExport,
  changeOrderAnalytics,
  complianceGate,
  finalReleaseProposal,
  receivablesAging,
  storedMaterialsReconciliation,
} from "./analytics.js";
import { percentCompleteOf, round2, round4 } from "./sov.js";
import {
  CERTIFIED_APP_STATUSES,
  OPEN_APP_STATUSES,
  fetchBilling,
  fetchContract,
  loadChanges,
  loadSov,
  nowIso,
  recalcContract,
  recordReceipt,
  requireContractsLevel,
  settleApplication,
  today,
  type ContractRow,
} from "./shared.js";

/* ------------------------------------------------------------------ */
/* Wire schemas                                                        */
/* ------------------------------------------------------------------ */

const idRef = z.string().min(1).max(64);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");
const money = z.number().finite();

const complianceCreateSchema = z.object({
  kind: z.enum(PRIME_COMPLIANCE_DOCUMENT_KINDS),
  title: z.string().min(1).max(300),
  required: z.boolean().optional(),
  status: z.enum(["missing", "received"]).optional(),
  documentId: idRef.nullable().optional(),
  reference: z.string().max(200).nullable().optional(),
  issuer: z.string().max(300).nullable().optional(),
  issuedDate: isoDate.nullable().optional(),
  effectiveDate: isoDate.nullable().optional(),
  expiryDate: isoDate.nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const compliancePatchSchema = complianceCreateSchema.partial().extend({
  /** received → the document is on file; missing → withdrawn */
  status: z.enum(["missing", "received"]).optional(),
});

const complianceWaiveSchema = z.object({ reason: z.string().min(1).max(2000) });

const storedCreateSchema = z.object({
  sovLineId: idRef,
  description: z.string().min(1).max(2000),
  location: z.enum(STORED_MATERIAL_LOCATIONS).optional(),
  locationNotes: z.string().max(2000).nullable().optional(),
  quantity: money.nullable().optional(),
  unit: z.string().max(20).nullable().optional(),
  value: money.positive(),
  storedDate: isoDate.optional(),
  supplierInvoiceReference: z.string().max(200).nullable().optional(),
  supplierVendorId: idRef.nullable().optional(),
  insured: z.boolean().optional(),
  insuranceReference: z.string().max(200).nullable().optional(),
  documentIds: z.array(idRef).max(50).optional(),
  notes: z.string().max(5000).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const storedPatchSchema = storedCreateSchema.partial().omit({ sovLineId: true });

const incorporateSchema = z.object({
  /** the value moved into the work; default = everything still stored */
  value: money.positive().optional(),
  date: isoDate.optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const removeSchema = z.object({ reason: z.string().min(1).max(2000) });

const receiptCreateSchema = z.object({
  amount: money.positive().optional(),
  receivedDate: isoDate.optional(),
  method: z.enum(OWNER_PAYMENT_RECEIPT_METHODS).optional(),
  paymentReference: z.string().max(200).nullable().optional(),
  bankReference: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const receiptVoidSchema = z.object({ reason: z.string().min(1).max(2000) });

const exportQuery = z.object({ format: z.enum(["json", "csv"]).default("json") });

/* ------------------------------------------------------------------ */
/* Compliance expiry sweep                                             */
/* ------------------------------------------------------------------ */

/**
 * Mark received/verified documents whose expiry has passed as expired.
 * Idempotent: a document already expired is not touched again, and each
 * transition is ledgered once with the system actor.
 */
export async function sweepComplianceExpiry(
  db: Db,
  companyId: string,
  now: Date,
): Promise<{ expired: number }> {
  const asOf = now.toISOString().slice(0, 10);
  const due = await db
    .select()
    .from(primeContractComplianceDocuments)
    .where(
      and(
        eq(primeContractComplianceDocuments.companyId, companyId),
        inArray(primeContractComplianceDocuments.status, ["received", "verified"]),
        lt(primeContractComplianceDocuments.expiryDate, asOf),
      ),
    );
  let expired = 0;
  for (const doc of due) {
    if (!doc.expiryDate) continue;
    const rows = await db
      .update(primeContractComplianceDocuments)
      .set({ status: "expired", updatedAt: nowIso() })
      .where(
        and(
          eq(primeContractComplianceDocuments.id, doc.id),
          inArray(primeContractComplianceDocuments.status, ["received", "verified"]),
        ),
      )
      .returning({ id: primeContractComplianceDocuments.id });
    if (rows.length === 0) continue;
    expired += 1;
    await appendLedger(db, {
      companyId,
      projectId: doc.projectId,
      actorId: null,
      action: "state_change",
      objectType: "prime_contract_compliance_document",
      objectId: doc.id,
      payload: {
        primeContractId: doc.primeContractId,
        kind: doc.kind,
        title: doc.title,
        from: doc.status,
        to: "expired",
        expiryDate: doc.expiryDate,
        sweep: "primecontracts.compliance-expiry",
      },
      storePayload: true,
    });
  }
  return { expired };
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

export const primeLifecycleRoutes: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];
  const readGate = [...companyGate, app.requireTool("contracts", "read")];
  const db = app.db;

  const requireLevel = (
    req: Parameters<typeof requireContractsLevel>[1],
    reply: Parameters<typeof requireContractsLevel>[2],
    projectId: string,
    level: "read" | "standard" | "admin",
  ) => requireContractsLevel(app, req, reply, projectId, level);

  app.scheduler.register({
    name: "primecontracts.compliance-expiry",
    description: "Expire prime-contract compliance documents whose expiry date has passed, so an expired certificate gates the next application.",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db: jobDb, now }) => {
      let expired = 0;
      const summary = await forEachCompany(jobDb, async (companyId) => {
        const r = await sweepComplianceExpiry(jobDb, companyId, now);
        expired += r.expired;
      });
      return { ...summary, expired };
    },
  });

  async function fetchDoc(docId: string, companyId: string) {
    const rows = await db
      .select()
      .from(primeContractComplianceDocuments)
      .where(and(eq(primeContractComplianceDocuments.id, docId), eq(primeContractComplianceDocuments.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Compliance document not found");
    return rows[0];
  }

  const docsOf = (contractId: string) =>
    db
      .select()
      .from(primeContractComplianceDocuments)
      .where(eq(primeContractComplianceDocuments.primeContractId, contractId))
      .orderBy(desc(primeContractComplianceDocuments.required), asc(primeContractComplianceDocuments.kind), asc(primeContractComplianceDocuments.title));

  /* ---------------------------------------------------------------- */
  /* Compliance documents (#519)                                       */
  /* ---------------------------------------------------------------- */

  app.get("/prime-contracts/:primeContractId/compliance", { preHandler: companyGate }, async (req, reply) => {
    const { primeContractId } = req.params as { primeContractId: string };
    const contract = await fetchContract(db, primeContractId, req.companyId!);
    await requireLevel(req, reply, contract.projectId, "read");
    const items = await docsOf(contract.id);
    return { primeContractId: contract.id, items, total: items.length, gate: complianceGate(items, today()) };
  });

  app.post("/prime-contracts/:primeContractId/compliance", { preHandler: companyGate }, async (req, reply) => {
    const { primeContractId } = req.params as { primeContractId: string };
    const body = complianceCreateSchema.parse(req.body);
    const contract = await fetchContract(db, primeContractId, req.companyId!);
    await requireLevel(req, reply, contract.projectId, "standard");
    if (contract.status === "void" || contract.status === "terminated") {
      throw conflict(`A ${contract.status} prime contract cannot take compliance documents`);
    }
    const id = newId("pcd");
    const status = body.status ?? (body.documentId || body.reference ? "received" : "missing");
    const now = nowIso();
    await db.insert(primeContractComplianceDocuments).values({
      id,
      companyId: contract.companyId,
      projectId: contract.projectId,
      primeContractId: contract.id,
      kind: body.kind,
      title: body.title,
      required: body.required === false ? 0 : 1,
      status,
      documentId: body.documentId ?? null,
      reference: body.reference ?? null,
      issuer: body.issuer ?? null,
      issuedDate: body.issuedDate ?? null,
      effectiveDate: body.effectiveDate ?? null,
      expiryDate: body.expiryDate ?? null,
      receivedAt: status === "received" ? now : null,
      notes: body.notes ?? null,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    await appendLedger(db, {
      companyId: contract.companyId,
      projectId: contract.projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "prime_contract_compliance_document",
      objectId: id,
      payload: { primeContractId: contract.id, kind: body.kind, title: body.title, required: body.required !== false, status, expiryDate: body.expiryDate ?? null },
    });
    return reply.status(201).send(await fetchDoc(id, contract.companyId));
  });

  app.patch("/prime-compliance/:docId", { preHandler: companyGate }, async (req, reply) => {
    const { docId } = req.params as { docId: string };
    const body = compliancePatchSchema.parse(req.body);
    const doc = await fetchDoc(docId, req.companyId!);
    await requireLevel(req, reply, doc.projectId, "standard");
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    for (const key of ["kind", "title", "documentId", "reference", "issuer", "issuedDate", "effectiveDate", "expiryDate", "notes", "detail"] as const) {
      if (body[key] !== undefined) set[key] = body[key];
    }
    if (body.required !== undefined) set["required"] = body.required ? 1 : 0;
    if (body.status !== undefined && body.status !== doc.status) {
      if (doc.status === "waived") {
        throw conflict("A waived requirement is re-instated through the waiver, not a status edit — create a fresh document row.");
      }
      set["status"] = body.status;
      if (body.status === "received") set["receivedAt"] = nowIso();
      // a re-received document is no longer verified by anyone
      set["verifiedBy"] = null;
      set["verifiedAt"] = null;
    } else if (body.status === undefined && doc.status === "expired" && body.expiryDate && body.expiryDate >= today()) {
      // a renewed certificate: back on file, awaiting verification
      set["status"] = "received";
      set["receivedAt"] = nowIso();
      set["verifiedBy"] = null;
      set["verifiedAt"] = null;
    }
    await db.update(primeContractComplianceDocuments).set(set).where(eq(primeContractComplianceDocuments.id, docId));
    await appendLedger(db, {
      companyId: doc.companyId,
      projectId: doc.projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "prime_contract_compliance_document",
      objectId: docId,
      payload: { changed: Object.keys(body), status: set["status"] ?? doc.status },
    });
    return fetchDoc(docId, doc.companyId);
  });

  /** Verification is a second pair of eyes: the verifier may not be the person who recorded it. */
  app.post("/prime-compliance/:docId/verify", { preHandler: companyGate }, async (req, reply) => {
    const { docId } = req.params as { docId: string };
    const doc = await fetchDoc(docId, req.companyId!);
    await requireLevel(req, reply, doc.projectId, "admin");
    if (doc.status !== "received") throw conflict(`${doc.title} is ${doc.status} — only a received document can be verified.`);
    if (doc.createdBy === req.user!.id) {
      throw new AppError(403, "The verifier of a compliance document may not be the person who recorded it (segregation of duties).", { control: "segregation_of_duties" });
    }
    if (doc.expiryDate && doc.expiryDate < today()) {
      throw conflict(`${doc.title} expired on ${doc.expiryDate} and cannot be verified — record the renewed document.`);
    }
    const now = nowIso();
    await db
      .update(primeContractComplianceDocuments)
      .set({ status: "verified", verifiedBy: req.user!.id, verifiedAt: now, updatedAt: now })
      .where(eq(primeContractComplianceDocuments.id, docId));
    await appendLedger(db, {
      companyId: doc.companyId,
      projectId: doc.projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "prime_contract_compliance_document",
      objectId: docId,
      payload: { from: doc.status, to: "verified", kind: doc.kind, title: doc.title, expiryDate: doc.expiryDate },
      storePayload: true,
    });
    return fetchDoc(docId, doc.companyId);
  });

  app.post("/prime-compliance/:docId/waive", { preHandler: companyGate }, async (req, reply) => {
    const { docId } = req.params as { docId: string };
    const body = complianceWaiveSchema.parse(req.body);
    const doc = await fetchDoc(docId, req.companyId!);
    await requireLevel(req, reply, doc.projectId, "admin");
    if (doc.status === "waived") throw conflict(`${doc.title} is already waived.`);
    const now = nowIso();
    await db
      .update(primeContractComplianceDocuments)
      .set({ status: "waived", waivedBy: req.user!.id, waivedReason: body.reason, updatedAt: now })
      .where(eq(primeContractComplianceDocuments.id, docId));
    await appendLedger(db, {
      companyId: doc.companyId,
      projectId: doc.projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "prime_contract_compliance_document",
      objectId: docId,
      payload: { from: doc.status, to: "waived", kind: doc.kind, title: doc.title, reason: body.reason },
      storePayload: true,
    });
    return fetchDoc(docId, doc.companyId);
  });

  app.delete("/prime-compliance/:docId", { preHandler: companyGate }, async (req, reply) => {
    const { docId } = req.params as { docId: string };
    const doc = await fetchDoc(docId, req.companyId!);
    await requireLevel(req, reply, doc.projectId, "admin");
    await db.delete(primeContractComplianceDocuments).where(eq(primeContractComplianceDocuments.id, docId));
    await appendLedger(db, {
      companyId: doc.companyId,
      projectId: doc.projectId,
      actorId: req.user!.id,
      action: "delete",
      objectType: "prime_contract_compliance_document",
      objectId: docId,
      payload: { kind: doc.kind, title: doc.title, status: doc.status },
    });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Stored materials (#516)                                           */
  /* ---------------------------------------------------------------- */

  async function fetchStored(itemId: string, companyId: string) {
    const rows = await db
      .select()
      .from(primeStoredMaterials)
      .where(and(eq(primeStoredMaterials.id, itemId), eq(primeStoredMaterials.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Stored material item not found");
    return rows[0];
  }

  async function storedReconciliation(contract: ContractRow) {
    const [items, lines] = await Promise.all([
      db.select().from(primeStoredMaterials).where(eq(primeStoredMaterials.primeContractId, contract.id)).orderBy(asc(primeStoredMaterials.number)),
      loadSov(db, contract.id),
    ]);
    return { items, lines, reconciliation: storedMaterialsReconciliation(items, lines) };
  }

  app.get("/prime-contracts/:primeContractId/stored-materials", { preHandler: companyGate }, async (req, reply) => {
    const { primeContractId } = req.params as { primeContractId: string };
    const contract = await fetchContract(db, primeContractId, req.companyId!);
    await requireLevel(req, reply, contract.projectId, "read");
    const { items, reconciliation } = await storedReconciliation(contract);
    return { primeContractId: contract.id, currency: contract.currency, items, total: items.length, reconciliation };
  });

  app.post("/prime-contracts/:primeContractId/stored-materials", { preHandler: companyGate }, async (req, reply) => {
    const { primeContractId } = req.params as { primeContractId: string };
    const body = storedCreateSchema.parse(req.body);
    const contract = await fetchContract(db, primeContractId, req.companyId!);
    await requireLevel(req, reply, contract.projectId, "standard");
    const sov = await loadSov(db, contract.id);
    const line = sov.find((l) => l.id === body.sovLineId);
    if (!line) throw badRequest("sovLineId is not a schedule-of-values line on this contract");
    if (body.supplierVendorId) {
      const v = await db.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.id, body.supplierVendorId), eq(vendors.companyId, contract.companyId))).limit(1);
      if (!v[0]) throw badRequest("supplierVendorId is not in this company's directory");
    }
    const number = await nextRecordNumber(db, contract.id, "prime_stored_material");
    const id = newId("psm");
    await db.insert(primeStoredMaterials).values({
      id,
      companyId: contract.companyId,
      projectId: contract.projectId,
      primeContractId: contract.id,
      sovLineId: line.id,
      number,
      reference: `SM-${String(number).padStart(3, "0")}`,
      description: body.description,
      status: "stored",
      location: body.location ?? "on_site",
      locationNotes: body.locationNotes ?? null,
      quantity: body.quantity ?? null,
      unit: body.unit ?? null,
      value: round2(body.value),
      incorporatedValue: 0,
      storedDate: body.storedDate ?? today(),
      supplierInvoiceReference: body.supplierInvoiceReference ?? null,
      supplierVendorId: body.supplierVendorId ?? null,
      insured: body.insured ? 1 : 0,
      insuranceReference: body.insuranceReference ?? null,
      documentIds: body.documentIds ?? [],
      notes: body.notes ?? null,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    await appendLedger(db, {
      companyId: contract.companyId,
      projectId: contract.projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "prime_stored_material",
      objectId: id,
      payload: { primeContractId: contract.id, sovLineId: line.id, lineNumber: line.lineNumber, value: round2(body.value), currency: contract.currency, insured: Boolean(body.insured), supplierInvoiceReference: body.supplierInvoiceReference ?? null },
      storePayload: true,
    });
    return reply.status(201).send(await fetchStored(id, contract.companyId));
  });

  app.patch("/prime-stored-materials/:itemId", { preHandler: companyGate }, async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const body = storedPatchSchema.parse(req.body);
    const item = await fetchStored(itemId, req.companyId!);
    await requireLevel(req, reply, item.projectId, "standard");
    if (item.status === "removed" || item.status === "incorporated") {
      throw conflict(`${item.reference} is ${item.status} and no longer editable.`);
    }
    if (body.value !== undefined && body.value < item.incorporatedValue - 0.005) {
      throw badRequest(`${item.reference} already has ${item.incorporatedValue.toFixed(2)} incorporated; its value cannot fall below that.`);
    }
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    for (const key of ["description", "location", "locationNotes", "quantity", "unit", "storedDate", "supplierInvoiceReference", "supplierVendorId", "insuranceReference", "documentIds", "notes", "detail"] as const) {
      if (body[key] !== undefined) set[key] = body[key];
    }
    if (body.value !== undefined) set["value"] = round2(body.value);
    if (body.insured !== undefined) set["insured"] = body.insured ? 1 : 0;
    await db.update(primeStoredMaterials).set(set).where(eq(primeStoredMaterials.id, itemId));
    await appendLedger(db, {
      companyId: item.companyId,
      projectId: item.projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "prime_stored_material",
      objectId: itemId,
      payload: { changed: Object.keys(body), value: set["value"] ?? item.value },
    });
    return fetchStored(itemId, item.companyId);
  });

  /** Incorporation moves value off column F and into the work. */
  app.post("/prime-stored-materials/:itemId/incorporate", { preHandler: companyGate }, async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const body = incorporateSchema.parse(req.body ?? {});
    const item = await fetchStored(itemId, req.companyId!);
    await requireLevel(req, reply, item.projectId, "standard");
    if (item.status === "removed" || item.status === "incorporated") {
      throw conflict(`${item.reference} is ${item.status}.`);
    }
    const remaining = round2(item.value - item.incorporatedValue);
    const value = round2(body.value ?? remaining);
    if (value - remaining > 0.005) {
      throw badRequest(`${item.reference} has ${remaining.toFixed(2)} still stored; ${value.toFixed(2)} cannot be incorporated.`);
    }
    const incorporatedValue = round2(item.incorporatedValue + value);
    const done = Math.abs(incorporatedValue - item.value) <= 0.005;
    const now = nowIso();
    await db
      .update(primeStoredMaterials)
      .set({
        incorporatedValue,
        status: done ? "incorporated" : "partially_incorporated",
        incorporatedDate: body.date ?? today(),
        notes: body.notes !== undefined ? body.notes : item.notes,
        updatedAt: now,
      })
      .where(eq(primeStoredMaterials.id, itemId));
    await appendLedger(db, {
      companyId: item.companyId,
      projectId: item.projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "prime_stored_material",
      objectId: itemId,
      payload: { from: item.status, to: done ? "incorporated" : "partially_incorporated", incorporated: value, incorporatedValue, value: item.value, date: body.date ?? today() },
      storePayload: true,
    });
    return fetchStored(itemId, item.companyId);
  });

  app.post("/prime-stored-materials/:itemId/remove", { preHandler: companyGate }, async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const body = removeSchema.parse(req.body);
    const item = await fetchStored(itemId, req.companyId!);
    await requireLevel(req, reply, item.projectId, "standard");
    if (item.status === "removed") throw conflict(`${item.reference} is already removed.`);
    if (item.billedOnApplicationId && item.status !== "incorporated") {
      const apps = await db
        .select({ status: paymentApplications.status, reference: paymentApplications.reference })
        .from(paymentApplications)
        .where(eq(paymentApplications.id, item.billedOnApplicationId))
        .limit(1);
      if (apps[0] && (CERTIFIED_APP_STATUSES as readonly string[]).includes(apps[0].status)) {
        throw conflict(`${item.reference} was billed on ${apps[0].reference}, which is certified. Removing material the owner has paid for is a credit on the next application, not a deletion.`);
      }
    }
    const now = nowIso();
    await db.update(primeStoredMaterials).set({ status: "removed", notes: `${item.notes ? `${item.notes}\n` : ""}Removed: ${body.reason}`, updatedAt: now }).where(eq(primeStoredMaterials.id, itemId));
    await appendLedger(db, {
      companyId: item.companyId,
      projectId: item.projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "prime_stored_material",
      objectId: itemId,
      payload: { from: item.status, to: "removed", reason: body.reason, value: item.value },
      storePayload: true,
    });
    return fetchStored(itemId, item.companyId);
  });

  /* ---------------------------------------------------------------- */
  /* Receipts, settlement, ageing (#518)                               */
  /* ---------------------------------------------------------------- */

  app.get("/prime-contracts/:primeContractId/billings/:billingId/receipts", { preHandler: companyGate }, async (req, reply) => {
    const { primeContractId, billingId } = req.params as { primeContractId: string; billingId: string };
    const contract = await fetchContract(db, primeContractId, req.companyId!);
    await requireLevel(req, reply, contract.projectId, "read");
    const billing = await fetchBilling(db, contract, billingId);
    const items = await db
      .select()
      .from(ownerPaymentReceipts)
      .where(eq(ownerPaymentReceipts.paymentApplicationId, billing.application.id))
      .orderBy(asc(ownerPaymentReceipts.number));
    const a = billing.application;
    const certified = round2(a.certifiedAmount ?? a.currentPaymentDue);
    const paid = round2(items.filter((r) => r.status !== "void").reduce((s, r) => s + r.amount, 0));
    return {
      applicationId: a.id,
      reference: a.reference,
      currency: a.currency,
      certified: (CERTIFIED_APP_STATUSES as readonly string[]).includes(a.status) ? certified : null,
      paid,
      outstanding: (CERTIFIED_APP_STATUSES as readonly string[]).includes(a.status) ? round2(Math.max(0, certified - paid)) : null,
      items,
      total: items.length,
    };
  });

  app.post("/prime-contracts/:primeContractId/billings/:billingId/receipts", { preHandler: companyGate }, async (req, reply) => {
    const { primeContractId, billingId } = req.params as { primeContractId: string; billingId: string };
    const body = receiptCreateSchema.parse(req.body ?? {});
    const contract = await fetchContract(db, primeContractId, req.companyId!);
    await requireLevel(req, reply, contract.projectId, "admin");
    const billing = await fetchBilling(db, contract, billingId);
    const result = await recordReceipt(db, contract, billing, req.user!.id, body, () => nextRecordNumber(db, contract.id, "owner_payment_receipt"));
    await appendLedger(db, {
      companyId: contract.companyId,
      projectId: contract.projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "owner_payment_receipt",
      objectId: result.receipt.id,
      payload: { applicationId: billing.application.id, applicationReference: billing.application.reference, amount: result.receipt.amount, currency: result.receipt.currency, receivedDate: result.receipt.receivedDate, method: result.receipt.method, paymentReference: result.receipt.paymentReference, settlement: result.settlement.state, paid: result.settlement.paid, outstanding: result.settlement.outstanding, totalPaid: result.contract.totalPaid },
      storePayload: true,
    });
    return reply.status(201).send({ receipt: result.receipt, application: result.settlement.application, settlement: { paid: result.settlement.paid, outstanding: result.settlement.outstanding, state: result.settlement.state } });
  });

  app.post("/owner-payment-receipts/:receiptId/void", { preHandler: companyGate }, async (req, reply) => {
    const { receiptId } = req.params as { receiptId: string };
    const body = receiptVoidSchema.parse(req.body);
    const rows = await db
      .select()
      .from(ownerPaymentReceipts)
      .where(and(eq(ownerPaymentReceipts.id, receiptId), eq(ownerPaymentReceipts.companyId, req.companyId!)))
      .limit(1);
    const receipt = rows[0];
    if (!receipt) throw notFound("Receipt not found");
    await requireLevel(req, reply, receipt.projectId, "admin");
    if (receipt.status === "void") throw conflict(`${receipt.reference} is already void.`);
    const now = nowIso();
    await db
      .update(ownerPaymentReceipts)
      .set({ status: "void", voidReason: body.reason, voidedBy: req.user!.id, voidedAt: now, updatedAt: now })
      .where(eq(ownerPaymentReceipts.id, receiptId));
    const settlement = await settleApplication(db, receipt.paymentApplicationId);
    const contract = await recalcContract(db, receipt.primeContractId, receipt.companyId);
    await appendLedger(db, {
      companyId: receipt.companyId,
      projectId: receipt.projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "owner_payment_receipt",
      objectId: receiptId,
      payload: { to: "void", reason: body.reason, amount: receipt.amount, applicationId: receipt.paymentApplicationId, settlement: settlement.state, totalPaid: contract.totalPaid },
      storePayload: true,
    });
    const updated = await db.select().from(ownerPaymentReceipts).where(eq(ownerPaymentReceipts.id, receiptId)).limit(1);
    return { receipt: updated[0], application: settlement.application };
  });

  app.get("/prime-contracts/:primeContractId/receivables", { preHandler: companyGate }, async (req, reply) => {
    const { primeContractId } = req.params as { primeContractId: string };
    const contract = await fetchContract(db, primeContractId, req.companyId!);
    await requireLevel(req, reply, contract.projectId, "read");
    const [apps, receipts] = await Promise.all([
      db.select().from(paymentApplications).where(eq(paymentApplications.primeContractId, contract.id)),
      db.select().from(ownerPaymentReceipts).where(eq(ownerPaymentReceipts.primeContractId, contract.id)),
    ]);
    const aging = receivablesAging(
      apps.map((a) => ({ id: a.id, reference: a.reference, status: a.status, currency: a.currency, currentPaymentDue: a.currentPaymentDue, certifiedAmount: a.certifiedAmount, certifiedAt: a.certifiedAt, applicationDate: a.applicationDate })),
      receipts.map((r) => ({ paymentApplicationId: r.paymentApplicationId, status: r.status, amount: r.amount, receivedDate: r.receivedDate })),
      contract.paymentTermsDays,
      today(),
      contract.currency,
    );
    return { primeContractId: contract.id, asOf: today(), ...aging, receipts: receipts.filter((r) => r.status !== "void").length };
  });

  /* ---------------------------------------------------------------- */
  /* Retainage lifecycle (#517)                                        */
  /* ---------------------------------------------------------------- */

  app.get("/prime-contracts/:primeContractId/retainage", { preHandler: companyGate }, async (req, reply) => {
    const { primeContractId } = req.params as { primeContractId: string };
    const contract = await fetchContract(db, primeContractId, req.companyId!);
    await requireLevel(req, reply, contract.projectId, "read");
    const [lines, releases, openApps, docs, requiring] = await Promise.all([
      loadSov(db, contract.id),
      db.select().from(retainageReleases).where(and(eq(retainageReleases.primeContractId, contract.id), eq(retainageReleases.scope, "prime_contract"))).orderBy(desc(retainageReleases.number)),
      db.select({ n: count() }).from(paymentApplications).where(and(eq(paymentApplications.primeContractId, contract.id), inArray(paymentApplications.status, [...OPEN_APP_STATUSES]))),
      docsOf(contract.id),
      db
        .select({ id: commitments.id, reference: commitments.reference })
        .from(commitments)
        .where(and(eq(commitments.projectId, contract.projectId), eq(commitments.requiresLienWaiver, 1), inArray(commitments.status, ["approved", "complete"]))),
    ]);
    const waived = requiring.length > 0
      ? await db
          .select({ commitmentId: lienWaivers.commitmentId })
          .from(lienWaivers)
          .where(and(inArray(lienWaivers.commitmentId, requiring.map((c) => c.id)), inArray(lienWaivers.status, ["received", "verified"])))
      : [];
    const waivedIds = new Set(waived.map((w) => w.commitmentId));
    const outstandingLienWaivers = requiring.filter((c) => !waivedIds.has(c.id));
    const terms = (contract.detail as Record<string, unknown> | null)?.["retainage"] as Record<string, unknown> | undefined;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const percent = percentCompleteOf(contract.totalBilled, contract.revisedContractSum, `Prime contract ${contract.reference}`);
    const gate = complianceGate(docs, today());
    const proposal = finalReleaseProposal({
      retainageHeld: contract.retainageHeld,
      retainageReleased: contract.retainageReleased,
      percentComplete: percent.value,
      substantialCompletionDate: contract.substantialCompletionDate,
      actualCompletionDate: contract.actualCompletionDate,
      terms: { workPercent: contract.defaultRetainagePercent, reductionThresholdPercent: num(terms?.["reductionThresholdPercent"]), reducedPercent: num(terms?.["reducedPercent"]) },
      pendingReleases: releases.filter((r) => ["draft", "pending_approval", "approved"].includes(r.status)).length,
      openApplications: Number(openApps[0]?.n ?? 0),
      outstandingLienWaivers: outstandingLienWaivers.length,
      complianceOk: gate.ok,
      today: today(),
    });
    return {
      primeContractId: contract.id,
      currency: contract.currency,
      held: contract.retainageHeld,
      released: contract.retainageReleased,
      percentComplete: percent,
      byLine: lines.map((l) => ({ sovLineId: l.id, lineNumber: l.lineNumber, description: l.description, retainagePercent: l.retainagePercent, retainageHeld: l.retainageHeld, retainageReleased: l.retainageReleased, totalCompletedAndStored: l.totalCompletedAndStored })),
      releases,
      proposal,
      gate: { compliance: gate, outstandingLienWaivers: outstandingLienWaivers.map((c) => ({ id: c.id, reference: c.reference })), openApplications: Number(openApps[0]?.n ?? 0) },
    };
  });

  /* ---------------------------------------------------------------- */
  /* Owner change order register analytics (#508–512)                  */
  /* ---------------------------------------------------------------- */

  app.get("/prime-contracts/:primeContractId/changes/analytics", { preHandler: companyGate }, async (req, reply) => {
    const { primeContractId } = req.params as { primeContractId: string };
    const contract = await fetchContract(db, primeContractId, req.companyId!);
    await requireLevel(req, reply, contract.projectId, "read");
    const changes = await loadChanges(db, contract.id);
    const analytics = changeOrderAnalytics(
      changes.map((c) => ({ id: c.id, reference: c.reference, status: c.status, amount: c.amount, reason: c.reason, createdAt: c.createdAt, submittedAt: c.submittedAt, approvedAt: c.approvedAt, executedDate: c.executedDate, requestedDate: c.requestedDate, scheduleImpactDays: c.scheduleImpactDays })),
      contract.originalContractSum,
      today(),
    );
    return { primeContractId: contract.id, currency: contract.currency, asOf: today(), ...analytics };
  });

  /* ---------------------------------------------------------------- */
  /* AIA G702/G703 export (#514)                                       */
  /* ---------------------------------------------------------------- */

  app.get("/prime-contracts/:primeContractId/billings/:billingId/export", { preHandler: companyGate }, async (req, reply) => {
    const { primeContractId, billingId } = req.params as { primeContractId: string; billingId: string };
    const q = exportQuery.parse(req.query);
    const contract = await fetchContract(db, primeContractId, req.companyId!);
    await requireLevel(req, reply, contract.projectId, "read");
    const billing = await fetchBilling(db, contract, billingId);
    const vendorIds = [contract.ownerVendorId, contract.contractorVendorId, contract.architectVendorId].filter((v): v is string => typeof v === "string");
    const [lines, changes, parties] = await Promise.all([
      db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, billing.invoice.id)).orderBy(asc(invoiceLineItems.sortOrder), asc(invoiceLineItems.lineNumber)),
      loadChanges(db, contract.id),
      vendorIds.length > 0 ? db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(and(inArray(vendors.id, vendorIds), eq(vendors.companyId, contract.companyId))) : Promise.resolve([] as Array<{ id: string; name: string }>),
    ]);
    const nameOf = (id: string | null): string | null => (id ? (parties.find((p) => p.id === id)?.name ?? null) : null);
    const a = billing.application;
    const inv = billing.invoice;
    const data = aiaExport({
      contract: { reference: contract.reference, title: contract.title, currency: contract.currency, ownerName: nameOf(contract.ownerVendorId), contractorName: nameOf(contract.contractorVendorId), architectName: nameOf(contract.architectVendorId), contractDate: contract.contractDate, executionDate: contract.executionDate },
      application: { reference: a.reference, number: a.number, applicationDate: a.applicationDate, periodTo: a.periodTo, status: a.status, certifiedAmount: a.certifiedAmount, certifiedAt: a.certifiedAt, certifiedByContractorName: a.certifiedByContractorName, contractorCertifiedAt: a.contractorCertifiedAt, notaryReference: a.notaryReference },
      g702: { originalContractSum: a.originalContractSum, netChangeOrders: a.netChangeOrders, contractSumToDate: a.contractSumToDate, completedToDate: inv.completedToDate, storedMaterials: inv.storedMaterials, totalCompletedAndStored: a.totalCompletedAndStored, retainagePercentWork: inv.retainagePercentWork, retainageWork: inv.retainageWork, retainagePercentMaterials: inv.retainagePercentMaterials, retainageMaterials: inv.retainageMaterials, totalRetainage: a.totalRetainage, totalEarnedLessRetainage: a.totalEarnedLessRetainage, lessPreviousCertificates: a.lessPreviousCertificates, currentPaymentDue: a.currentPaymentDue, balanceToFinishPlusRetainage: a.balanceToFinishPlusRetainage },
      g703: lines.map((l) => ({ lineNumber: l.lineNumber, description: l.description, scheduledValue: l.scheduledValue, previousBilled: l.previousBilled, thisPeriodWork: l.thisPeriodWork, materialsPresentlyStored: l.materialsPresentlyStored, totalCompletedAndStored: l.totalCompletedAndStored, percentComplete: l.percentComplete, balanceToFinish: l.balanceToFinish, retainageHeldToDate: l.retainageHeldToDate })),
      changes: changes.filter((c) => c.status === "executed").map((c) => ({ reference: c.reference, amount: c.amount, executedDate: c.executedDate })),
    });
    await appendLedger(db, {
      companyId: contract.companyId,
      projectId: contract.projectId,
      actorId: req.user!.id,
      action: "access",
      objectType: "payment_application",
      objectId: a.id,
      payload: { export: "aia_g702_g703", format: q.format },
    });
    if (q.format === "csv") {
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="${contract.reference}-${a.reference}-g702-g703.csv"`)
        .send(aiaCsv(data));
    }
    return { primeContractId: contract.id, applicationId: a.id, ...data };
  });

  /* ---------------------------------------------------------------- */
  /* Health inputs (plan §3.5)                                         */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/prime-contracts/health-inputs", { preHandler: readGate }, async (req) => {
    const rows = await db
      .select()
      .from(primeContracts)
      .where(and(eq(primeContracts.companyId, req.companyId!), eq(primeContracts.projectId, req.projectId!), eq(primeContracts.executed, 1)));
    if (rows.length === 0) {
      return { metrics: { billedShare: null, pendingChangeShare: null, overdueReceivables: null, overdueReceivableShare: null, complianceBlocking: null, openApplications: null }, reasons: ["This project has no executed prime contract, so no revenue health can be stated."] };
    }
    const ids = rows.map((r) => r.id);
    const [apps, receipts, docs, open] = await Promise.all([
      db.select().from(paymentApplications).where(inArray(paymentApplications.primeContractId, ids)),
      db.select().from(ownerPaymentReceipts).where(inArray(ownerPaymentReceipts.primeContractId, ids)),
      db.select().from(primeContractComplianceDocuments).where(inArray(primeContractComplianceDocuments.primeContractId, ids)),
      db.select({ n: count() }).from(paymentApplications).where(and(inArray(paymentApplications.primeContractId, ids), inArray(paymentApplications.status, [...OPEN_APP_STATUSES]))),
    ]);
    const currencies = new Set(rows.map((r) => r.currency));
    const reasons: string[] = [];
    let billedShare: number | null = null;
    let pendingChangeShare: number | null = null;
    let overdueReceivables: number | null = null;
    let overdueShare: number | null = null;
    if (currencies.size === 1) {
      const revised = rows.reduce((s, r) => s + r.revisedContractSum, 0);
      const billed = rows.reduce((s, r) => s + r.totalBilled, 0);
      const pending = rows.reduce((s, r) => s + r.pendingChangeSum, 0);
      billedShare = revised > 0 ? round4(billed / revised) : null;
      pendingChangeShare = revised > 0 ? round4(pending / revised) : null;
      let overdue = 0;
      let outstanding = 0;
      for (const c of rows) {
        const aging = receivablesAging(
          apps.filter((a) => a.primeContractId === c.id).map((a) => ({ id: a.id, reference: a.reference, status: a.status, currency: a.currency, currentPaymentDue: a.currentPaymentDue, certifiedAmount: a.certifiedAmount, certifiedAt: a.certifiedAt, applicationDate: a.applicationDate })),
          receipts.map((r) => ({ paymentApplicationId: r.paymentApplicationId, status: r.status, amount: r.amount, receivedDate: r.receivedDate })),
          c.paymentTermsDays,
          today(),
          c.currency,
        );
        overdue += aging.totals.overdue;
        outstanding += aging.totals.outstanding;
        reasons.push(...aging.reasons);
      }
      overdueReceivables = round2(overdue);
      overdueShare = outstanding > 0 ? round4(overdue / outstanding) : null;
    } else {
      reasons.push(`Prime contracts on this project are in ${[...currencies].join(", ")}; share metrics are not summed across currencies.`);
    }
    const gate = complianceGate(docs, today());
    return {
      currency: currencies.size === 1 ? [...currencies][0] : null,
      metrics: {
        billedShare,
        pendingChangeShare,
        overdueReceivables,
        overdueReceivableShare: overdueShare,
        complianceBlocking: gate.blocking.length,
        complianceExpiringSoon: gate.expiringSoon.length,
        openApplications: Number(open[0]?.n ?? 0),
        executedContracts: rows.length,
      },
      reasons: [...new Set(reasons)],
    };
  });
};
