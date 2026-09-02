/**
 * The directory: vendors, contacts, distribution groups and the tenant's own
 * people (Vol I §0.3 #1–#19, §0.1 #26–#30).
 *
 * WHAT CHANGED IN THIS WAVE
 *  • only an OWNER may create or remove an owner. An admin could previously
 *    PATCH their own membership to `owner`, or demote every other owner —
 *    privilege escalation inside the tenant with no audit signal.
 *  • an invitation no longer hands the inviter a working password for
 *    somebody else's account, and no longer grants membership before the
 *    invitee has accepted.
 *  • removing a member now revokes their sessions, their assurance grants and
 *    their pending approval steps — leaving those behind left a signed-in
 *    device, a live integrity role, and approval chains nobody could decide.
 *  • vendors are soft-deleted and merges re-point every reference they can
 *    reach, recorded in a merge journal that supports an undo.
 *  • duplicate detection (dedupe.ts) and a vendor performance view.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  bidInvitations,
  bidSubmissions,
  commitments,
  companies,
  companyMemberships,
  contacts,
  distributionGroupMembers,
  distributionGroups,
  importJobs,
  insuranceCertificates,
  invoices,
  legalHolds,
  nonConformanceReports,
  projectMemberships,
  projects,
  punchItems,
  safetyIncidents,
  submittals,
  users,
  vendorMerges,
  vendors,
  workers,
  workflowInstances,
  workflowStepInstances,
  assuranceGrants,
} from "@constructos/db";
import { COMPANY_ROLES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import type { Db } from "../../lib/db.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { revokeAllUserSessions } from "../account/sessions.js";
import { findDuplicates, type VendorLike } from "./dedupe.js";
import { visibleProjectIds } from "../projects/access.js";
import {
  committableRows,
  IMPORT_SPECS,
  type ImportRowError,
} from "../projects/import.js";
// Phase 8 — an invitation now produces a record and a message instead of a
// temporary password and silence. Everything about tokens, dispatch and
// acceptance lives in modules/account; this module keeps the route.
import { createInvitation } from "../account/invitations.js";
import { requestContext } from "../account/sessions.js";
import { requireVerifiedEmail } from "../account/verification.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

/**
 * How long a merge can be undone.
 *
 * After this the rows re-pointed by the merge cannot be told apart from rows
 * edited since, so the undo refuses rather than guessing. Stated once and
 * used by both the undo guard and the register, so the UI never offers an
 * undo the API will refuse.
 */
const MERGE_UNDO_WINDOW_MS = 24 * 60 * 60_000;

const vendorCreateSchema = z.object({
  name: z.string().min(1).max(300),
  tradeCodes: z.array(z.string().min(1).max(50)).max(50).default([]),
  address: z.string().max(500).optional(),
  city: z.string().max(200).optional(),
  country: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
  email: z.string().email().optional(),
  website: z.string().max(300).optional(),
  taxId: z.string().max(100).optional(),
  registrationNumber: z.string().max(100).optional(),
  status: z.enum(["active", "inactive"]).default("active"),
  notes: z.string().max(5000).optional(),
});
const vendorPatchSchema = vendorCreateSchema.partial();

const vendorListQuery = pageQuerySchema.extend({
  search: z.string().max(200).optional(),
  tradeCode: z.string().max(50).optional(),
  status: z.enum(["active", "inactive", "merged"]).optional(),
  includeMerged: z.string().optional(),
});

const contactCreateSchema = z.object({
  name: z.string().min(1).max(300),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  title: z.string().max(200).optional(),
  vendorId: z.string().max(100).optional(),
});
const contactPatchSchema = contactCreateSchema.partial().extend({
  vendorId: z.string().max(100).nullable().optional(),
});

const groupCreateSchema = z.object({
  name: z.string().min(1).max(200),
  projectId: z.string().max(100).optional(),
});

const groupMemberSchema = z
  .object({
    userId: z.string().max(100).optional(),
    contactId: z.string().max(100).optional(),
    email: z.string().email().optional(),
  })
  .refine(
    (v) => [v.userId, v.contactId, v.email].filter(Boolean).length === 1,
    "Provide exactly one of userId, contactId or email",
  );

const inviteSchema = z.object({
  email: z.string().email().toLowerCase(),
  name: z.string().min(1).max(200),
  role: z.enum(COMPANY_ROLES),
  /** permission template applied to the projects below, on acceptance */
  templateKey: z.string().min(1).max(80).optional(),
  projectIds: z.array(z.string().min(1).max(100)).max(100).default([]),
  /** a note from the inviter, rendered escaped in the message */
  message: z.string().max(2000).optional(),
});

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

export const directoryModule: FastifyPluginAsync = async (app) => {
  const read = [app.authenticate, app.requireCompany];
  const write = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin", "member"]),
  ];
  const adminOnly = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];

  /** Refuse a delete while an active legal hold covers the record (#47). */
  async function assertNoLegalHold(companyId: string, objectType: string, objectId: string) {
    const rows = await app.db
      .select({
        name: legalHolds.name,
        projectId: legalHolds.projectId,
        objectType: legalHolds.objectType,
        objectId: legalHolds.objectId,
      })
      .from(legalHolds)
      .where(and(eq(legalHolds.companyId, companyId), eq(legalHolds.status, "active")));
    const covering = rows.find(
      (h) =>
        h.projectId === null &&
        (h.objectType === null || h.objectType === objectType) &&
        (h.objectId === null || h.objectId === objectId),
    );
    if (covering) {
      throw conflict(
        `Legal hold "${covering.name}" covers this record; it cannot be deleted while the hold is active.`,
      );
    }
  }

  /* ---------------------------- Vendors ---------------------------- */

  app.get("/vendors", { preHandler: read }, async (req) => {
    const q = vendorListQuery.parse(req.query);
    const conds = [eq(vendors.companyId, req.companyId!), isNull(vendors.deletedAt)];
    if (q.status) {
      conds.push(eq(vendors.status, q.status));
    } else if (q.includeMerged !== "true") {
      conds.push(ne(vendors.status, "merged"));
    }
    if (q.search) conds.push(ilike(vendors.name, `%${q.search}%`));
    if (q.tradeCode) {
      conds.push(sql`${vendors.tradeCodes} @> ${JSON.stringify([q.tradeCode])}::jsonb`);
    }
    const where = and(...conds);
    const items = await app.db
      .select()
      .from(vendors)
      .where(where)
      .orderBy(asc(vendors.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [row] = await app.db.select({ n: count() }).from(vendors).where(where);
    return paginate(items, Number(row?.n ?? 0), q);
  });

  app.post("/vendors", { preHandler: write }, async (req, reply) => {
    const body = vendorCreateSchema.parse(req.body);
    const id = newId("vnd");
    await app.db.insert(vendors).values({ id, companyId: req.companyId!, ...body });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "vendor",
      objectId: id,
      payload: body,
    });
    const [created] = await app.db.select().from(vendors).where(eq(vendors.id, id));
    return reply.status(201).send(created);
  });

  async function getVendorOr404(companyId: string, vendorId: string, includeDeleted = false) {
    const [vendor] = await app.db
      .select()
      .from(vendors)
      .where(
        and(
          eq(vendors.id, vendorId),
          eq(vendors.companyId, companyId),
          includeDeleted ? undefined : isNull(vendors.deletedAt),
        ),
      )
      .limit(1);
    if (!vendor) throw notFound("Vendor not found");
    return vendor;
  }

  /**
   * Every table this module can safely re-point a vendorId on.
   *
   * Deliberately a curated list rather than a reflection over the schema:
   * a merge must be explainable, and a table added by another package in this
   * same wave has no business being touched by a migration this module cannot
   * see. `vendorReferences` counts them; `repointVendor` moves them.
   */
  const VENDOR_REFERENCE_TABLES = [
    { label: "contacts", table: contacts, key: "vendorId", column: contacts.vendorId, companyColumn: contacts.companyId },
    { label: "commitments", table: commitments, key: "vendorId", column: commitments.vendorId, companyColumn: commitments.companyId },
    { label: "invoices", table: invoices, key: "vendorId", column: invoices.vendorId, companyColumn: invoices.companyId },
    { label: "submittals", table: submittals, key: "vendorId", column: submittals.vendorId, companyColumn: submittals.companyId },
    { label: "punch items", table: punchItems, key: "vendorId", column: punchItems.vendorId, companyColumn: punchItems.companyId },
    { label: "bid invitations", table: bidInvitations, key: "vendorId", column: bidInvitations.vendorId, companyColumn: bidInvitations.companyId },
    { label: "bid submissions", table: bidSubmissions, key: "vendorId", column: bidSubmissions.vendorId, companyColumn: bidSubmissions.companyId },
    { label: "insurance certificates", table: insuranceCertificates, key: "vendorId", column: insuranceCertificates.vendorId, companyColumn: insuranceCertificates.companyId },
    { label: "workers", table: workers, key: "vendorId", column: workers.vendorId, companyColumn: workers.companyId },
    { label: "safety incidents", table: safetyIncidents, key: "vendorId", column: safetyIncidents.vendorId, companyColumn: safetyIncidents.companyId },
    { label: "NCRs", table: nonConformanceReports, key: "raisedAgainstVendorId", column: nonConformanceReports.raisedAgainstVendorId, companyColumn: nonConformanceReports.companyId },
  ] as const;

  async function vendorReferences(companyId: string, vendorId: string) {
    const counts: Record<string, number> = {};
    for (const entry of VENDOR_REFERENCE_TABLES) {
      const [row] = await app.db
        .select({ n: count() })
        .from(entry.table)
        .where(and(eq(entry.companyColumn, companyId), eq(entry.column, vendorId)));
      counts[entry.label] = Number(row?.n ?? 0);
    }
    return counts;
  }

  app.get("/vendors/:vendorId", { preHandler: read }, async (req) => {
    const { vendorId } = req.params as { vendorId: string };
    return getVendorOr404(req.companyId!, vendorId);
  });

  app.patch("/vendors/:vendorId", { preHandler: write }, async (req) => {
    const { vendorId } = req.params as { vendorId: string };
    const body = vendorPatchSchema.parse(req.body);
    const vendor = await getVendorOr404(req.companyId!, vendorId);
    if (vendor.status === "merged") throw conflict("A merged vendor cannot be edited");
    await app.db
      .update(vendors)
      .set({ ...body, updatedAt: new Date().toISOString() })
      .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, req.companyId!)));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "vendor",
      objectId: vendorId,
      payload: body,
    });
    return getVendorOr404(req.companyId!, vendorId);
  });

  /**
   * Soft-delete a vendor (#78).
   *
   * The hard delete this replaces removed the vendor row while commitments,
   * bid invitations, prequalification records, insurance policies and field
   * records kept its id in a NOT NULL column — dangling references and a
   * blank vendor name in every register that joined to it. Deletion now marks
   * the row and reports what still points at it; the vendor keeps its history
   * and can be restored.
   */
  app.delete("/vendors/:vendorId", { preHandler: adminOnly }, async (req) => {
    const { vendorId } = req.params as { vendorId: string };
    const vendor = await getVendorOr404(req.companyId!, vendorId);
    await assertNoLegalHold(req.companyId!, "vendor", vendorId);
    const references = await vendorReferences(req.companyId!, vendorId);
    const now = new Date().toISOString();
    await app.db.transaction(async (tx) => {
      await tx
        .update(contacts)
        .set({ vendorId: null, updatedAt: now })
        .where(and(eq(contacts.vendorId, vendorId), eq(contacts.companyId, req.companyId!)));
      await tx
        .update(vendors)
        .set({ deletedAt: now, deletedBy: req.user!.id, status: "inactive", updatedAt: now })
        .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, req.companyId!)));
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "vendor",
      objectId: vendorId,
      payload: { name: vendor.name, soft: true, references },
      storePayload: true,
    });
    return { ok: true, deletedAt: now, restorable: true, references };
  });

  app.post("/vendors/:vendorId/restore", { preHandler: adminOnly }, async (req) => {
    const { vendorId } = req.params as { vendorId: string };
    const vendor = await getVendorOr404(req.companyId!, vendorId, true);
    if (!vendor.deletedAt) return { ok: true, alreadyActive: true };
    await app.db
      .update(vendors)
      .set({
        deletedAt: null,
        deletedBy: null,
        status: "active",
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, req.companyId!)));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "vendor",
      objectId: vendorId,
      payload: { event: "restored" },
    });
    return { ok: true, restored: true };
  });

  /** Deleted vendors and contacts, for the recycle bin. */
  app.get("/directory/recycle-bin", { preHandler: adminOnly }, async (req) => {
    const deletedVendors = await app.db
      .select({
        id: vendors.id,
        name: vendors.name,
        deletedAt: vendors.deletedAt,
        deletedBy: vendors.deletedBy,
      })
      .from(vendors)
      .where(and(eq(vendors.companyId, req.companyId!), sql`${vendors.deletedAt} is not null`))
      .orderBy(desc(vendors.deletedAt))
      .limit(200);
    const deletedContacts = await app.db
      .select({
        id: contacts.id,
        name: contacts.name,
        deletedAt: contacts.deletedAt,
        deletedBy: contacts.deletedBy,
      })
      .from(contacts)
      .where(and(eq(contacts.companyId, req.companyId!), sql`${contacts.deletedAt} is not null`))
      .orderBy(desc(contacts.deletedAt))
      .limit(200);
    return {
      items: [
        ...deletedVendors.map((v) => ({ ...v, objectType: "vendor" as const })),
        ...deletedContacts.map((c) => ({ ...c, objectType: "contact" as const })),
      ],
      total: deletedVendors.length + deletedContacts.length,
    };
  });

  /* --------------------- Duplicate detection (#11) ------------------ */

  /**
   * Candidate duplicate vendors, with the reasons each pair was flagged.
   *
   * Read-only and explainable: nothing is merged here. The confidence and
   * the reason list are what an administrator decides on.
   */
  app.get("/vendors/duplicates", { preHandler: adminOnly }, async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        minConfidence: z.coerce.number().min(0).max(1).default(0.45),
      })
      .parse(req.query);
    const rows = await app.db
      .select({
        id: vendors.id,
        name: vendors.name,
        email: vendors.email,
        phone: vendors.phone,
        address: vendors.address,
        city: vendors.city,
        country: vendors.country,
        taxId: vendors.taxId,
        registrationNumber: vendors.registrationNumber,
      })
      .from(vendors)
      .where(
        and(
          eq(vendors.companyId, req.companyId!),
          isNull(vendors.deletedAt),
          ne(vendors.status, "merged"),
        ),
      )
      .limit(2000);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const pairs = findDuplicates(rows as VendorLike[], q.limit).filter(
      (p) => p.confidence >= q.minConfidence,
    );
    return {
      items: pairs.map((p) => ({
        ...p,
        aVendor: byId.get(p.a) ?? null,
        bVendor: byId.get(p.b) ?? null,
      })),
      total: pairs.length,
      scanned: rows.length,
    };
  });

  /**
   * Vendor 360 (#787) — how this vendor has actually performed, across the
   * portfolio.
   *
   * Money is bucketed BY CURRENCY and never summed across: a vendor working
   * in GBP and AED has two totals, not one meaningless one.
   */
  app.get("/vendors/:vendorId/performance", { preHandler: read }, async (req) => {
    const { vendorId } = req.params as { vendorId: string };
    const vendor = await getVendorOr404(req.companyId!, vendorId, true);

    const commitmentRows = await app.db
      .select({
        currency: commitments.currency,
        n: count(),
        value: sql<number>`coalesce(sum(${commitments.revisedCommitmentSum}), 0)`,
      })
      .from(commitments)
      .where(and(eq(commitments.companyId, req.companyId!), eq(commitments.vendorId, vendorId)))
      .groupBy(commitments.currency);

    const invoiceRows = await app.db
      .select({
        currency: invoices.currency,
        status: invoices.status,
        n: count(),
        value: sql<number>`coalesce(sum(${invoices.total}), 0)`,
      })
      .from(invoices)
      .where(and(eq(invoices.companyId, req.companyId!), eq(invoices.vendorId, vendorId)))
      .groupBy(invoices.currency, invoices.status);

    const [ncrRow] = await app.db
      .select({ n: count() })
      .from(nonConformanceReports)
      .where(
        and(
          eq(nonConformanceReports.companyId, req.companyId!),
          eq(nonConformanceReports.raisedAgainstVendorId, vendorId),
        ),
      );
    const [incidentRow] = await app.db
      .select({ n: count() })
      .from(safetyIncidents)
      .where(
        and(
          eq(safetyIncidents.companyId, req.companyId!),
          eq(safetyIncidents.vendorId, vendorId),
        ),
      );
    const [bidRow] = await app.db
      .select({ n: count() })
      .from(bidSubmissions)
      .where(
        and(eq(bidSubmissions.companyId, req.companyId!), eq(bidSubmissions.vendorId, vendorId)),
      );
    const policies = await app.db
      .select({
        id: insuranceCertificates.id,
        expiryDate: insuranceCertificates.validTo,
        status: insuranceCertificates.policyType,
      })
      .from(insuranceCertificates)
      .where(
        and(
          eq(insuranceCertificates.companyId, req.companyId!),
          eq(insuranceCertificates.vendorId, vendorId),
        ),
      )
      .limit(50);

    return {
      vendor: { id: vendor.id, name: vendor.name, status: vendor.status },
      commitments: {
        byCurrency: commitmentRows.map((r) => ({
          currency: r.currency,
          count: Number(r.n),
          value: Number(r.value),
        })),
        // Explicitly refused rather than fabricated: totals across currencies
        // are not a number.
        total: { value: null, reasons: ["money is never summed across currencies"] },
      },
      invoices: {
        byCurrencyAndStatus: invoiceRows.map((r) => ({
          currency: r.currency,
          status: r.status,
          count: Number(r.n),
          value: Number(r.value),
        })),
      },
      quality: { openNcrs: Number(ncrRow?.n ?? 0) },
      safety: { incidents: Number(incidentRow?.n ?? 0) },
      bidding: { submissions: Number(bidRow?.n ?? 0) },
      insurance: {
        certificates: policies.length,
        nextExpiry:
          policies
            .map((p) => p.expiryDate)
            .filter((d): d is string => Boolean(d))
            .sort()[0] ?? null,
      },
    };
  });

  app.post("/vendors/:vendorId/merge", { preHandler: adminOnly }, async (req) => {
    const { vendorId } = req.params as { vendorId: string };
    const body = z.object({ intoVendorId: z.string().min(1) }).parse(req.body);
    if (body.intoVendorId === vendorId) {
      throw badRequest("A vendor cannot be merged into itself");
    }
    const source = await getVendorOr404(req.companyId!, vendorId);
    const target = await getVendorOr404(req.companyId!, body.intoVendorId);
    if (source.status === "merged") throw conflict("Vendor is already merged");
    if (target.status === "merged") throw conflict("Target vendor is itself merged");

    /*
     * A merge re-points EVERY reference this module can reach, in one
     * transaction, and records exactly what it moved.
     *
     * The previous merge re-pointed contacts and nothing else, so the merged
     * vendor kept its commitments, its bids, its insurance and its incidents:
     * the "one vendor" the merge promised was still two everywhere it
     * mattered, and vendor performance was split across both.
     */
    const now = new Date().toISOString();
    const movements: Array<{ table: string; column: string; rows: number }> = [];
    const mergeId = newId("vmrg");
    /*
     * The re-pointing, the journal row and BOTH ledger entries are one
     * transaction.
     *
     * A merge that committed without its journal row could not be undone,
     * and one that committed without its ledger entries would be an
     * unledgered mutation across a dozen tables. `appendLedger` opens a
     * nested transaction (a savepoint) when handed a transaction handle, and
     * its per-company advisory lock is held to the outer commit.
     */
    await app.db.transaction(async (tx) => {
      for (const entry of VENDOR_REFERENCE_TABLES) {
        const moved = await tx
          .update(entry.table)
          .set({ [entry.key]: target.id } as never)
          .where(and(eq(entry.companyColumn, req.companyId!), eq(entry.column, source.id)))
          .returning({ id: entry.column });
        if (moved.length > 0) {
          movements.push({ table: entry.label, column: entry.key, rows: moved.length });
        }
      }
      await tx
        .update(vendors)
        .set({ status: "merged", mergedIntoId: target.id, updatedAt: now })
        .where(and(eq(vendors.id, source.id), eq(vendors.companyId, req.companyId!)));
      await tx.insert(vendorMerges).values({
        id: mergeId,
        companyId: req.companyId!,
        sourceVendorId: source.id,
        targetVendorId: target.id,
        movements,
        performedBy: req.user!.id,
      });
      await appendLedger(tx as Db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "vendor",
        objectId: source.id,
        payload: { status: "merged", mergedIntoId: target.id, mergeId, movements },
        storePayload: true,
      });
      await appendLedger(tx as Db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "vendor",
        objectId: target.id,
        payload: { absorbedVendorId: source.id, mergeId },
      });
    });
    const merged = await getVendorOr404(req.companyId!, source.id, true);
    return { ...merged, mergeId, movements };
  });

  /**
   * Undo a merge.
   *
   * Bounded to what the journal records: the same tables, moving back the
   * same number of rows. Rows that were re-pointed to the target by some
   * OTHER means since the merge cannot be told apart, so the undo refuses
   * once the window has passed rather than guessing.
   */
  app.post("/vendor-merges/:mergeId/undo", { preHandler: adminOnly }, async (req) => {
    const { mergeId } = req.params as { mergeId: string };
    const rows = await app.db
      .select()
      .from(vendorMerges)
      .where(and(eq(vendorMerges.id, mergeId), eq(vendorMerges.companyId, req.companyId!)))
      .limit(1);
    const merge = rows[0];
    if (!merge) throw notFound("Merge not found");
    if (merge.undoneAt) throw conflict("This merge has already been undone");
    const ageMs = Date.now() - Date.parse(merge.createdAt);
    if (ageMs > MERGE_UNDO_WINDOW_MS) {
      throw conflict(
        "A merge can only be undone within 24 hours; after that the re-pointed records cannot be told apart from later edits.",
      );
    }
    const now = new Date().toISOString();
    const restored: Array<{ table: string; rows: number }> = [];
    await app.db.transaction(async (tx) => {
      for (const entry of VENDOR_REFERENCE_TABLES) {
        const record = (merge.movements as Array<{ table: string; rows: number }>).find(
          (m) => m.table === entry.label,
        );
        if (!record || record.rows === 0) continue;
        const moved = await tx
          .update(entry.table)
          .set({ [entry.key]: merge.sourceVendorId } as never)
          .where(
            and(eq(entry.companyColumn, req.companyId!), eq(entry.column, merge.targetVendorId)),
          )
          .returning({ id: entry.column });
        restored.push({ table: entry.label, rows: moved.length });
      }
      await tx
        .update(vendors)
        .set({ status: "active", mergedIntoId: null, updatedAt: now })
        .where(eq(vendors.id, merge.sourceVendorId));
      await tx
        .update(vendorMerges)
        .set({ undoneAt: now, undoneBy: req.user!.id })
        .where(eq(vendorMerges.id, mergeId));
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "vendor",
      objectId: merge.sourceVendorId,
      payload: { event: "merge_undone", mergeId, restored },
      storePayload: true,
    });
    return { ok: true, mergeId, restored };
  });

  /**
   * The merge journal.
   *
   * Names, not ids: "vmrg_… moved 4 rows" is unreadable, and the register
   * exists to be read. `undoDeadline` is stated rather than left for the
   * caller to compute, so the UI never offers an undo the API will refuse.
   */
  app.get("/vendor-merges", { preHandler: adminOnly }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = eq(vendorMerges.companyId, req.companyId!);
    const [totalRow] = await app.db.select({ n: count() }).from(vendorMerges).where(where);
    const items = await app.db
      .select()
      .from(vendorMerges)
      .where(where)
      .orderBy(desc(vendorMerges.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const ids = [
      ...new Set(items.flatMap((m) => [m.sourceVendorId, m.targetVendorId])),
    ];
    const names = ids.length
      ? await app.db
          .select({ id: vendors.id, name: vendors.name })
          .from(vendors)
          .where(and(eq(vendors.companyId, req.companyId!), inArray(vendors.id, ids)))
      : [];
    const nameById = new Map(names.map((v) => [v.id, v.name]));
    return paginate(
      items.map((m) => ({
        ...m,
        sourceName: nameById.get(m.sourceVendorId) ?? m.sourceVendorId,
        targetName: nameById.get(m.targetVendorId) ?? m.targetVendorId,
        undoDeadline: new Date(Date.parse(m.createdAt) + MERGE_UNDO_WINDOW_MS).toISOString(),
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  /* ---------------------------- Contacts --------------------------- */

  async function assertVendorInCompany(companyId: string, vendorId: string) {
    const [vendor] = await app.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
      .limit(1);
    if (!vendor) throw badRequest("vendorId does not exist in this company");
  }

  app.get("/contacts", { preHandler: read }, async (req) => {
    const q = pageQuerySchema
      .extend({
        search: z.string().max(200).optional(),
        vendorId: z.string().max(100).optional(),
      })
      .parse(req.query);
    const conds = [eq(contacts.companyId, req.companyId!), isNull(contacts.deletedAt)];
    if (q.vendorId) conds.push(eq(contacts.vendorId, q.vendorId));
    if (q.search) {
      conds.push(
        or(ilike(contacts.name, `%${q.search}%`), ilike(contacts.email, `%${q.search}%`))!,
      );
    }
    const where = and(...conds);
    const items = await app.db
      .select()
      .from(contacts)
      .where(where)
      .orderBy(asc(contacts.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [row] = await app.db.select({ n: count() }).from(contacts).where(where);
    return paginate(items, Number(row?.n ?? 0), q);
  });

  app.post("/contacts", { preHandler: write }, async (req, reply) => {
    const body = contactCreateSchema.parse(req.body);
    if (body.vendorId) await assertVendorInCompany(req.companyId!, body.vendorId);
    const id = newId("cnt");
    await app.db.insert(contacts).values({ id, companyId: req.companyId!, ...body });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "contact",
      objectId: id,
      payload: body,
    });
    const [created] = await app.db.select().from(contacts).where(eq(contacts.id, id));
    return reply.status(201).send(created);
  });

  async function getContactOr404(companyId: string, contactId: string, includeDeleted = false) {
    const [contact] = await app.db
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.id, contactId),
          eq(contacts.companyId, companyId),
          includeDeleted ? undefined : isNull(contacts.deletedAt),
        ),
      )
      .limit(1);
    if (!contact) throw notFound("Contact not found");
    return contact;
  }

  app.get("/contacts/:contactId", { preHandler: read }, async (req) => {
    const { contactId } = req.params as { contactId: string };
    return getContactOr404(req.companyId!, contactId);
  });

  app.patch("/contacts/:contactId", { preHandler: write }, async (req) => {
    const { contactId } = req.params as { contactId: string };
    const body = contactPatchSchema.parse(req.body);
    await getContactOr404(req.companyId!, contactId);
    if (body.vendorId) await assertVendorInCompany(req.companyId!, body.vendorId);
    await app.db
      .update(contacts)
      .set({ ...body, updatedAt: new Date().toISOString() })
      .where(and(eq(contacts.id, contactId), eq(contacts.companyId, req.companyId!)));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "contact",
      objectId: contactId,
      payload: body,
    });
    return getContactOr404(req.companyId!, contactId);
  });

  app.delete("/contacts/:contactId", { preHandler: write }, async (req) => {
    const { contactId } = req.params as { contactId: string };
    const contact = await getContactOr404(req.companyId!, contactId);
    await assertNoLegalHold(req.companyId!, "contact", contactId);
    const now = new Date().toISOString();
    await app.db.transaction(async (tx) => {
      await tx
        .delete(distributionGroupMembers)
        .where(eq(distributionGroupMembers.contactId, contactId));
      await tx
        .update(contacts)
        .set({ deletedAt: now, deletedBy: req.user!.id, updatedAt: now })
        .where(and(eq(contacts.id, contactId), eq(contacts.companyId, req.companyId!)));
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "contact",
      objectId: contactId,
      payload: { name: contact.name, soft: true },
    });
    return { ok: true, deletedAt: now, restorable: true };
  });

  app.post("/contacts/:contactId/restore", { preHandler: write }, async (req) => {
    const { contactId } = req.params as { contactId: string };
    const contact = await getContactOr404(req.companyId!, contactId, true);
    if (!contact.deletedAt) return { ok: true, alreadyActive: true };
    await app.db
      .update(contacts)
      .set({ deletedAt: null, deletedBy: null, updatedAt: new Date().toISOString() })
      .where(and(eq(contacts.id, contactId), eq(contacts.companyId, req.companyId!)));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "contact",
      objectId: contactId,
      payload: { event: "restored" },
    });
    return { ok: true, restored: true };
  });

  /* ----------------------- Distribution groups --------------------- */

  async function getGroupOr404(companyId: string, groupId: string) {
    const [group] = await app.db
      .select()
      .from(distributionGroups)
      .where(
        and(eq(distributionGroups.id, groupId), eq(distributionGroups.companyId, companyId)),
      )
      .limit(1);
    if (!group) throw notFound("Distribution group not found");
    return group;
  }

  app.get("/distribution-groups", { preHandler: read }, async (req) => {
    const q = pageQuerySchema
      .extend({ projectId: z.string().max(100).optional() })
      .parse(req.query);
    const conds = [eq(distributionGroups.companyId, req.companyId!)];
    if (q.projectId) conds.push(eq(distributionGroups.projectId, q.projectId));
    // A project-scoped group names people on that project; a caller with no
    // access to the project has no business enumerating it.
    const visible = await visibleProjectIds(app, req);
    if (visible !== null) {
      conds.push(
        visible.length === 0
          ? isNull(distributionGroups.projectId)
          : or(isNull(distributionGroups.projectId), inArray(distributionGroups.projectId, visible))!,
      );
    }
    const where = and(...conds);
    const groups = await app.db
      .select()
      .from(distributionGroups)
      .where(where)
      .orderBy(asc(distributionGroups.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [row] = await app.db.select({ n: count() }).from(distributionGroups).where(where);
    const ids = groups.map((g) => g.id);
    const counts = ids.length
      ? await app.db
          .select({ groupId: distributionGroupMembers.groupId, n: count() })
          .from(distributionGroupMembers)
          .where(inArray(distributionGroupMembers.groupId, ids))
          .groupBy(distributionGroupMembers.groupId)
      : [];
    const countMap = new Map(counts.map((c) => [c.groupId, Number(c.n)]));
    return paginate(
      groups.map((g) => ({ ...g, memberCount: countMap.get(g.id) ?? 0 })),
      Number(row?.n ?? 0),
      q,
    );
  });

  app.post("/distribution-groups", { preHandler: write }, async (req, reply) => {
    const body = groupCreateSchema.parse(req.body);
    if (body.projectId) {
      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, body.projectId), eq(projects.companyId, req.companyId!)))
        .limit(1);
      if (!project) throw badRequest("projectId does not exist in this company");
    }
    const dupConds = [
      eq(distributionGroups.companyId, req.companyId!),
      eq(distributionGroups.name, body.name),
      body.projectId
        ? eq(distributionGroups.projectId, body.projectId)
        : sql`${distributionGroups.projectId} is null`,
    ];
    const [dup] = await app.db
      .select({ id: distributionGroups.id })
      .from(distributionGroups)
      .where(and(...dupConds))
      .limit(1);
    if (dup) throw conflict("A distribution group with this name already exists");

    const id = newId("dg");
    await app.db.insert(distributionGroups).values({
      id,
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      name: body.name,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "distribution_group",
      objectId: id,
      payload: body,
    });
    const group = await getGroupOr404(req.companyId!, id);
    return reply.status(201).send({ ...group, memberCount: 0 });
  });

  app.get("/distribution-groups/:groupId", { preHandler: read }, async (req) => {
    const { groupId } = req.params as { groupId: string };
    const group = await getGroupOr404(req.companyId!, groupId);
    const members = await app.db
      .select({
        id: distributionGroupMembers.id,
        userId: distributionGroupMembers.userId,
        contactId: distributionGroupMembers.contactId,
        email: distributionGroupMembers.email,
        userName: users.name,
        userEmail: users.email,
        contactName: contacts.name,
        contactEmail: contacts.email,
      })
      .from(distributionGroupMembers)
      .leftJoin(users, eq(users.id, distributionGroupMembers.userId))
      .leftJoin(contacts, eq(contacts.id, distributionGroupMembers.contactId))
      .where(eq(distributionGroupMembers.groupId, groupId));
    return { ...group, members };
  });

  app.patch("/distribution-groups/:groupId", { preHandler: write }, async (req) => {
    const { groupId } = req.params as { groupId: string };
    const body = z.object({ name: z.string().min(1).max(200) }).parse(req.body);
    await getGroupOr404(req.companyId!, groupId);
    await app.db
      .update(distributionGroups)
      .set({ name: body.name })
      .where(
        and(
          eq(distributionGroups.id, groupId),
          eq(distributionGroups.companyId, req.companyId!),
        ),
      );
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "distribution_group",
      objectId: groupId,
      payload: body,
    });
    return getGroupOr404(req.companyId!, groupId);
  });

  app.delete("/distribution-groups/:groupId", { preHandler: write }, async (req) => {
    const { groupId } = req.params as { groupId: string };
    const group = await getGroupOr404(req.companyId!, groupId);
    await app.db.transaction(async (tx) => {
      await tx
        .delete(distributionGroupMembers)
        .where(eq(distributionGroupMembers.groupId, groupId));
      await tx.delete(distributionGroups).where(eq(distributionGroups.id, groupId));
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "distribution_group",
      objectId: groupId,
      payload: { name: group.name },
    });
    return { ok: true };
  });

  app.post("/distribution-groups/:groupId/members", { preHandler: write }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    const body = groupMemberSchema.parse(req.body);
    await getGroupOr404(req.companyId!, groupId);
    if (body.userId) {
      const [membership] = await app.db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, req.companyId!),
            eq(companyMemberships.userId, body.userId),
          ),
        )
        .limit(1);
      if (!membership) throw badRequest("userId is not a member of this company");
    }
    if (body.contactId) await getContactOr404(req.companyId!, body.contactId);

    // Three nullable columns cannot be made unique together in Postgres, so
    // the recipient's identity is materialised into one key that can be. A
    // duplicate used to be accepted silently and double-notified on every
    // future fan-out.
    const memberKey = body.userId
      ? `u:${body.userId}`
      : body.contactId
        ? `c:${body.contactId}`
        : `e:${(body.email ?? "").toLowerCase()}`;
    const [duplicate] = await app.db
      .select({ id: distributionGroupMembers.id })
      .from(distributionGroupMembers)
      .where(
        and(
          eq(distributionGroupMembers.groupId, groupId),
          eq(distributionGroupMembers.memberKey, memberKey),
        ),
      )
      .limit(1);
    if (duplicate) {
      return reply.status(200).send({ id: duplicate.id, groupId, ...body, alreadyMember: true });
    }

    const id = newId("dgm");
    await app.db.insert(distributionGroupMembers).values({
      id,
      groupId,
      userId: body.userId ?? null,
      contactId: body.contactId ?? null,
      email: body.email ?? null,
      memberKey,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "distribution_group",
      objectId: groupId,
      payload: { addedMember: body },
    });
    return reply.status(201).send({ id, groupId, ...body });
  });

  app.delete(
    "/distribution-groups/:groupId/members/:memberId",
    { preHandler: write },
    async (req) => {
      const { groupId, memberId } = req.params as { groupId: string; memberId: string };
      await getGroupOr404(req.companyId!, groupId);
      const [member] = await app.db
        .select()
        .from(distributionGroupMembers)
        .where(
          and(
            eq(distributionGroupMembers.id, memberId),
            eq(distributionGroupMembers.groupId, groupId),
          ),
        )
        .limit(1);
      if (!member) throw notFound("Group member not found");
      await app.db
        .delete(distributionGroupMembers)
        .where(eq(distributionGroupMembers.id, memberId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "distribution_group",
        objectId: groupId,
        payload: { removedMemberId: memberId },
      });
      return { ok: true };
    },
  );

  /* --------------------------- Company users ----------------------- */

  app.get("/company/users", { preHandler: read }, async (req) => {
    const q = pageQuerySchema.extend({ search: z.string().max(200).optional() }).parse(req.query);
    const conds = [eq(companyMemberships.companyId, req.companyId!)];
    if (q.search) {
      conds.push(or(ilike(users.name, `%${q.search}%`), ilike(users.email, `%${q.search}%`))!);
    }
    const where = and(...conds);
    const items = await app.db
      .select({
        id: users.id,
        membershipId: companyMemberships.id,
        email: users.email,
        name: users.name,
        title: users.title,
        phone: users.phone,
        isActive: users.isActive,
        lastLoginAt: users.lastLoginAt,
        role: companyMemberships.role,
        joinedAt: companyMemberships.createdAt,
      })
      .from(companyMemberships)
      .innerJoin(users, eq(users.id, companyMemberships.userId))
      .where(where)
      .orderBy(asc(users.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [row] = await app.db
      .select({ n: count() })
      .from(companyMemberships)
      .innerJoin(users, eq(users.id, companyMemberships.userId))
      .where(where);
    return paginate(items, Number(row?.n ?? 0), q);
  });

  /**
   * Invite someone into the company.
   *
   * WHAT THIS ROUTE MUST NOT DO, AND USED TO
   *  • It handed the INVITER a working temporary password for the invitee's
   *    brand-new account. That password logged in immediately: the inviter
   *    held a live credential for somebody else's account until acceptance.
   *  • It created the company membership at once, for an existing user, with
   *    no act of consent from them — they were simply in your tenant.
   *  • It echoed `existingUser`, which told any admin whether a given email
   *    address has an account on the platform.
   *
   * What it does now: creates the invitation record (which already carries
   * the role, template and projects), dispatches the message, and creates a
   * new account only in an UNUSABLE state — `isActive: false` with a random
   * hash nobody holds — so acceptance is what turns it into a login. The
   * membership is created by the accept route, which already does exactly
   * that. `delivery` is always present, so an administrator can tell an
   * invitation that is on its way from one that was only recorded.
   */
  app.post(
    "/company/users/invite",
    { preHandler: [...adminOnly, requireVerifiedEmail(app, "invite people")] },
    async (req, reply) => {
      const body = inviteSchema.parse(req.body);
      // Only an owner may create another owner — see PATCH .../role.
      if (body.role === "owner" && req.companyRole !== "owner") {
        throw forbidden("Only an owner may invite another owner");
      }
      const [existing] = await app.db
        .select()
        .from(users)
        .where(eq(users.email, body.email))
        .limit(1);

      let userId: string;
      let createdAccount = false;
      if (existing) {
        const [membership] = await app.db
          .select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, req.companyId!),
              eq(companyMemberships.userId, existing.id),
            ),
          )
          .limit(1);
        if (membership) throw conflict("User is already a member of this company");
        userId = existing.id;
      } else {
        userId = newId("u");
        createdAccount = true;
        // An unusable hash: 64 random hex characters is not a bcrypt digest,
        // so no password can ever verify against it. Acceptance sets a real
        // one. Nobody — including the inviter — holds a credential here.
        await app.db.insert(users).values({
          id: userId,
          email: body.email,
          name: body.name,
          passwordHash: `invited:${newId()}${newId()}`,
          isActive: false,
        });
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "user",
          objectId: userId,
          payload: { email: body.email, name: body.name, invited: true, active: false },
        });
      }

      // Validate the projects now rather than at acceptance, so a typo is the
      // inviter's problem and not the invitee's.
      if (body.projectIds.length > 0) {
        const known = await app.db
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(eq(projects.companyId, req.companyId!), inArray(projects.id, body.projectIds)),
          );
        const missing = body.projectIds.filter((id) => !known.some((k) => k.id === id));
        if (missing.length > 0) throw badRequest(`Unknown project(s): ${missing.join(", ")}`);
      }

      const [company] = await app.db
        .select({ name: companies.name })
        .from(companies)
        .where(eq(companies.id, req.companyId!))
        .limit(1);
      const invited = await createInvitation(app, requestContext(req), {
        companyId: req.companyId!,
        companyName: company?.name ?? "your company",
        invitedBy: req.user!.id,
        inviterName: req.user!.name,
        email: body.email,
        name: body.name,
        role: body.role,
        templateKey: body.templateKey ?? null,
        projectIds: body.projectIds,
        message: body.message ?? null,
        createdAccount,
      });

      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "user_invitation",
        objectId: invited.invitation.id,
        payload: { email: body.email, role: body.role, projectIds: body.projectIds },
      });

      return reply.status(201).send({
        // No `tempPassword`, ever, and no `existingUser`: whether an address
        // already has an account on the platform is not this tenant's to know.
        invitedEmail: body.email,
        role: body.role,
        membershipCreated: false,
        invitation: {
          id: invited.invitation.id,
          status: invited.invitation.status,
          expiresAt: invited.invitation.expiresAt,
          tokenPrefix: invited.invitation.tokenPrefix,
        },
        // Never absent: the caller must always be able to tell an invitation
        // that is on its way from one that will never arrive.
        delivery: invited.delivery,
        // Only for an account this invitation created, and only when nothing
        // was dispatched — otherwise handing the link to the inviter would be
        // a takeover route into somebody else's existing account.
        acceptUrl: !invited.delivery.dispatched && createdAccount ? invited.acceptUrl : null,
      });
    },
  );

  async function getMembershipOr404(companyId: string, userId: string) {
    const [membership] = await app.db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.userId, userId),
        ),
      )
      .limit(1);
    if (!membership) throw notFound("User is not a member of this company");
    return membership;
  }

  async function countOwners(companyId: string): Promise<number> {
    const [row] = await app.db
      .select({ n: count() })
      .from(companyMemberships)
      .where(
        and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.role, "owner")),
      );
    return Number(row?.n ?? 0);
  }

  /**
   * Change a member's company role.
   *
   * TWO GUARDS THAT WERE MISSING, and what they cost.
   *
   * The route was gated `owner|admin` and the body enum accepted `owner`, so
   * an admin could PATCH THEIR OWN userId to `owner` — a one-request
   * privilege escalation inside the tenant — and could demote or remove any
   * existing owner as long as one remained. Both are now owner-only, and
   * nobody may change their own role at all: a role change is something
   * somebody else does to you, which is what makes it auditable.
   */
  app.patch("/company/users/:userId/role", { preHandler: adminOnly }, async (req) => {
    const { userId } = req.params as { userId: string };
    const body = z.object({ role: z.enum(COMPANY_ROLES) }).parse(req.body);
    if (userId === req.user!.id) {
      throw forbidden("You cannot change your own company role");
    }
    const membership = await getMembershipOr404(req.companyId!, userId);
    if ((body.role === "owner" || membership.role === "owner") && req.companyRole !== "owner") {
      throw forbidden("Only an owner may grant or remove the owner role");
    }
    if (membership.role === "owner" && body.role !== "owner") {
      const owners = await countOwners(req.companyId!);
      if (owners <= 1) throw conflict("Cannot demote the last owner of the company");
    }
    await app.db
      .update(companyMemberships)
      .set({ role: body.role })
      .where(eq(companyMemberships.id, membership.id));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "company_membership",
      objectId: membership.id,
      payload: { userId, role: body.role, previousRole: membership.role },
    });
    return { id: membership.id, userId, role: body.role };
  });

  /**
   * Remove someone from the company.
   *
   * WHAT WAS LEFT BEHIND BEFORE
   *  • their SESSIONS. `requireCompany` refused them per request, but the
   *    device stayed "live" in their account, its refresh token kept
   *    rotating, and there was no route anywhere on the platform that cut a
   *    user off (spec #26/#27).
   *  • their ASSURANCE GRANTS. Integrity-reviewer rights survived removal and
   *    silently revived if the person was ever re-added.
   *  • their PENDING APPROVAL STEPS. With no cancel or reassign route, a
   *    running workflow whose only approver had left could never finish.
   *
   * All three are handled here, in one transaction, and the response says
   * exactly what was cleared. Workflow steps are REPORTED rather than
   * silently reassigned — who should approve instead is a decision, not a
   * cleanup — and the removal is refused while any are outstanding unless the
   * caller passes `force`, in which case the affected instances are blocked
   * for an administrator to reassign.
   */
  app.delete("/company/users/:userId", { preHandler: adminOnly }, async (req) => {
    const { userId } = req.params as { userId: string };
    const q = z.object({ force: z.enum(["true", "false"]).optional() }).parse(req.query);
    if (userId === req.user!.id) throw forbidden("You cannot remove yourself from the company");
    const membership = await getMembershipOr404(req.companyId!, userId);
    if (membership.role === "owner") {
      if (req.companyRole !== "owner") {
        throw forbidden("Only an owner may remove another owner");
      }
      const owners = await countOwners(req.companyId!);
      if (owners <= 1) throw conflict("Cannot remove the last owner of the company");
    }

    const pendingSteps = await app.db
      .select({
        stepId: workflowStepInstances.id,
        stepName: workflowStepInstances.name,
        instanceId: workflowInstances.id,
        recordType: workflowInstances.recordType,
        recordId: workflowInstances.recordId,
      })
      .from(workflowStepInstances)
      .innerJoin(workflowInstances, eq(workflowInstances.id, workflowStepInstances.instanceId))
      .where(
        and(
          eq(workflowInstances.companyId, req.companyId!),
          eq(workflowInstances.status, "running"),
          eq(workflowStepInstances.decision, "pending"),
          or(
            eq(workflowStepInstances.assigneeId, userId),
            eq(workflowStepInstances.delegatedToId, userId),
          ),
        ),
      )
      .limit(200);

    if (pendingSteps.length > 0 && q.force !== "true") {
      throw conflict(
        `${pendingSteps.length} approval step(s) are still assigned to this user. Reassign them (POST /workflow-steps/:id/reassign) or repeat this call with ?force=true, which blocks those workflows for an administrator.`,
      );
    }

    const now = new Date().toISOString();
    const cleared = await app.db.transaction(async (tx) => {
      const projectRows = await tx
        .delete(projectMemberships)
        .where(
          and(
            eq(projectMemberships.companyId, req.companyId!),
            eq(projectMemberships.userId, userId),
          ),
        )
        .returning({ id: projectMemberships.id });
      const grantRows = await tx
        .delete(assuranceGrants)
        .where(
          and(
            eq(assuranceGrants.companyId, req.companyId!),
            eq(assuranceGrants.userId, userId),
          ),
        )
        .returning({ id: assuranceGrants.id });
      if (pendingSteps.length > 0) {
        await tx
          .update(workflowInstances)
          .set({
            status: "blocked",
            blockedReason: `An approver was removed from the company on ${now.slice(0, 10)}`,
            updatedAt: now,
          })
          .where(
            inArray(
              workflowInstances.id,
              [...new Set(pendingSteps.map((s) => s.instanceId))],
            ),
          );
      }
      await tx.delete(companyMemberships).where(eq(companyMemberships.id, membership.id));
      return { projectMemberships: projectRows.length, assuranceGrants: grantRows.length };
    });

    // Sessions last: revoking them is idempotent, and doing it after the
    // membership is gone means a race cannot re-authorise the caller.
    const revokedSessions = await revokeAllUserSessions(app.db, userId, {
      reason: "membership_removed",
      byUser: false,
      actorId: req.user!.id,
    });

    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "company_membership",
      objectId: membership.id,
      payload: {
        userId,
        role: membership.role,
        cleared,
        revokedSessions,
        blockedWorkflows: [...new Set(pendingSteps.map((s) => s.instanceId))],
      },
      storePayload: true,
    });
    return {
      ok: true,
      cleared: { ...cleared, revokedSessions },
      blockedWorkflows: pendingSteps.map((s) => ({
        instanceId: s.instanceId,
        stepName: s.stepName,
        recordType: s.recordType,
        recordId: s.recordId,
      })),
    };
  });

  /**
   * Cut a user off right now (#26/#27).
   *
   * Separate from removal because the two are different acts: a compromised
   * account needs its sessions killed while its membership stays intact.
   */
  app.post("/company/users/:userId/sessions/revoke", { preHandler: adminOnly }, async (req) => {
    const { userId } = req.params as { userId: string };
    const membership = await getMembershipOr404(req.companyId!, userId);
    if (membership.role === "owner" && req.companyRole !== "owner") {
      throw forbidden("Only an owner may revoke an owner's sessions");
    }
    const revoked = await revokeAllUserSessions(app.db, userId, {
      reason: "admin_revoked",
      byUser: false,
      actorId: req.user!.id,
      includeOrphanTokens: true,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "user",
      objectId: userId,
      payload: { event: "sessions_revoked", revoked },
      storePayload: true,
    });
    return { ok: true, revoked };
  });

  /* ---------------------------------------------------------------- */
  /* Bulk edit and CSV import (#76, #77)                               */
  /* ---------------------------------------------------------------- */

  app.post("/vendors/bulk", { preHandler: adminOnly }, async (req) => {
    const body = z
      .object({
        ids: z.array(z.string().min(1)).min(1).max(500),
        patch: z
          .object({
            status: z.enum(["active", "inactive"]).optional(),
            country: z.string().max(200).nullable().optional(),
            city: z.string().max(200).nullable().optional(),
            addTradeCodes: z.array(z.string().min(1).max(50)).max(20).optional(),
          })
          .refine((v) => Object.keys(v).length > 0, "Nothing to update"),
      })
      .parse(req.body);

    const rows = await app.db
      .select({ id: vendors.id, tradeCodes: vendors.tradeCodes, status: vendors.status })
      .from(vendors)
      .where(
        and(
          eq(vendors.companyId, req.companyId!),
          inArray(vendors.id, body.ids),
          isNull(vendors.deletedAt),
        ),
      );
    const refused = body.ids.filter((id) => !rows.some((r) => r.id === id));
    const now = new Date().toISOString();
    await app.db.transaction(async (tx) => {
      for (const row of rows) {
        if (row.status === "merged") continue;
        const patch: Record<string, unknown> = { updatedAt: now };
        if (body.patch.status !== undefined) patch["status"] = body.patch.status;
        if (body.patch.country !== undefined) patch["country"] = body.patch.country;
        if (body.patch.city !== undefined) patch["city"] = body.patch.city;
        if (body.patch.addTradeCodes) {
          patch["tradeCodes"] = [...new Set([...(row.tradeCodes ?? []), ...body.patch.addTradeCodes])];
        }
        await tx.update(vendors).set(patch).where(eq(vendors.id, row.id));
      }
    });
    for (const row of rows) {
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "vendor",
        objectId: row.id,
        payload: { bulk: true, ...body.patch },
      });
    }
    return { updated: rows.length, refused };
  });

  app.post("/contacts/bulk", { preHandler: adminOnly }, async (req) => {
    const body = z
      .object({
        ids: z.array(z.string().min(1)).min(1).max(500),
        patch: z
          .object({
            vendorId: z.string().max(100).nullable().optional(),
            title: z.string().max(200).nullable().optional(),
          })
          .refine((v) => Object.keys(v).length > 0, "Nothing to update"),
      })
      .parse(req.body);
    if (body.patch.vendorId) await assertVendorInCompany(req.companyId!, body.patch.vendorId);
    const rows = await app.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.companyId, req.companyId!),
          inArray(contacts.id, body.ids),
          isNull(contacts.deletedAt),
        ),
      );
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.patch.vendorId !== undefined) patch["vendorId"] = body.patch.vendorId;
    if (body.patch.title !== undefined) patch["title"] = body.patch.title;
    if (rows.length > 0) {
      await app.db
        .update(contacts)
        .set(patch)
        .where(
          and(
            eq(contacts.companyId, req.companyId!),
            inArray(
              contacts.id,
              rows.map((r) => r.id),
            ),
          ),
        );
    }
    for (const row of rows) {
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "contact",
        objectId: row.id,
        payload: { bulk: true, ...body.patch },
      });
    }
    return { updated: rows.length, refused: body.ids.filter((id) => !rows.some((r) => r.id === id)) };
  });

  /**
   * Commit a previewed vendor/contact import.
   *
   * The preview lives in `import_jobs` (created by POST
   * /imports/:dataset/preview in the projects module, which owns the parser).
   * The commit replays the stored rows so the person cannot review one file
   * and commit another.
   */
  app.post("/directory/imports/:jobId/commit", { preHandler: adminOnly }, async (req) => {
    const { jobId } = req.params as { jobId: string };
    const rows = await app.db
      .select()
      .from(importJobs)
      .where(and(eq(importJobs.id, jobId), eq(importJobs.companyId, req.companyId!)))
      .limit(1);
    const job = rows[0];
    if (!job) throw notFound("Import job not found");
    if (job.status !== "preview") throw conflict(`Import job is already ${job.status}`);
    if (job.dataset !== "vendors" && job.dataset !== "contacts") {
      throw badRequest(`${job.dataset} is not a directory dataset`);
    }
    const spec = IMPORT_SPECS[job.dataset]!;
    const preview = {
      dataset: job.dataset,
      columns: spec.columns,
      rows: (job.rows ?? []) as Array<Record<string, string>>,
      errors: (job.report ?? []) as ImportRowError[],
      rowCount: job.rowCount,
      validCount: job.validCount,
      errorCount: job.errorCount,
    };
    const writable = committableRows(preview);

    let created = 0;
    let updated = 0;
    if (job.dataset === "vendors") {
      const existing = await app.db
        .select({ id: vendors.id, name: vendors.name })
        .from(vendors)
        .where(and(eq(vendors.companyId, req.companyId!), isNull(vendors.deletedAt)));
      const byName = new Map(existing.map((v) => [v.name.trim().toLowerCase(), v.id]));
      await app.db.transaction(async (tx) => {
        for (const row of writable) {
          const name = (row["name"] ?? "").trim();
          if (!name) continue;
          const values = {
            tradeCodes: (row["trade_codes"] ?? "")
              .split(";")
              .map((t) => t.trim())
              .filter(Boolean),
            address: (row["address"] ?? "").trim() || null,
            city: (row["city"] ?? "").trim() || null,
            country: (row["country"] ?? "").trim() || null,
            phone: (row["phone"] ?? "").trim() || null,
            email: (row["email"] ?? "").trim() || null,
            website: (row["website"] ?? "").trim() || null,
            taxId: (row["tax_id"] ?? "").trim() || null,
            registrationNumber: (row["registration_number"] ?? "").trim() || null,
            status: (row["status"] ?? "active").trim().toLowerCase() || "active",
            updatedAt: new Date().toISOString(),
          };
          const known = byName.get(name.toLowerCase());
          if (known) {
            await tx.update(vendors).set(values).where(eq(vendors.id, known));
            updated += 1;
          } else {
            const id = newId("vnd");
            await tx.insert(vendors).values({ id, companyId: req.companyId!, name, ...values });
            byName.set(name.toLowerCase(), id);
            created += 1;
          }
        }
      });
    } else {
      const vendorRows = await app.db
        .select({ id: vendors.id, name: vendors.name })
        .from(vendors)
        .where(and(eq(vendors.companyId, req.companyId!), isNull(vendors.deletedAt)));
      const vendorByName = new Map(vendorRows.map((v) => [v.name.trim().toLowerCase(), v.id]));
      const existing = await app.db
        .select({ id: contacts.id, email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.companyId, req.companyId!), isNull(contacts.deletedAt)));
      const byEmail = new Map(
        existing.filter((c) => c.email).map((c) => [c.email!.trim().toLowerCase(), c.id]),
      );
      await app.db.transaction(async (tx) => {
        for (const row of writable) {
          const name = (row["name"] ?? "").trim();
          if (!name) continue;
          const email = (row["email"] ?? "").trim() || null;
          const vendorName = (row["vendor_name"] ?? "").trim().toLowerCase();
          const values = {
            name,
            email,
            phone: (row["phone"] ?? "").trim() || null,
            title: (row["title"] ?? "").trim() || null,
            vendorId: vendorName ? (vendorByName.get(vendorName) ?? null) : null,
            updatedAt: new Date().toISOString(),
          };
          const known = email ? byEmail.get(email.toLowerCase()) : undefined;
          if (known) {
            await tx.update(contacts).set(values).where(eq(contacts.id, known));
            updated += 1;
          } else {
            const id = newId("cnt");
            await tx.insert(contacts).values({ id, companyId: req.companyId!, ...values });
            if (email) byEmail.set(email.toLowerCase(), id);
            created += 1;
          }
        }
      });
    }

    const now = new Date().toISOString();
    await app.db
      .update(importJobs)
      .set({ status: "committed", createdCount: created, updatedCount: updated, committedAt: now })
      .where(eq(importJobs.id, jobId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "import_job",
      objectId: jobId,
      payload: { dataset: job.dataset, created, updated },
      storePayload: true,
    });
    return {
      id: jobId,
      status: "committed",
      created,
      updated,
      skipped: preview.rowCount - writable.length,
    };
  });
};
