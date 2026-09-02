/**
 * The concession register (#1091) — every departure somebody agreed to.
 *
 * A `use_as_is` or `repair` disposition leaves non-conforming work in the
 * building permanently. That is only defensible if the DESIGNER accepted it,
 * and their acceptance is a document with an author, a date, conditions, and
 * very often a quantity limit or an expiry. Before this register those facts
 * lived in a free-text field on the NCR, which made the two questions that
 * actually matter unanswerable: how many concessions has this subcontractor
 * been given, and which of them expire before handover.
 *
 * Three refusals carry the file:
 *
 *  1. A concession is approved by somebody other than the person who asked
 *     for it. A departure from the specification signed off by the party who
 *     wants the departure is not a concession, it is a decision to stop
 *     applying the specification.
 *  2. An approval must name the approval authority — the designer or the
 *     client's representative — because "approved" with no authority is a
 *     tick, not an acceptance.
 *  3. An expired concession is swept to `expired` and raises a signal. Work
 *     covered by a concession that has run out is non-conforming again, and
 *     the moment nobody notices that is the moment the register stops being
 *     worth keeping.
 */

import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import { nonConformanceReports, qualityConcessions } from "@constructos/db";
import { CONCESSION_KINDS, CONCESSION_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { pushNotifications } from "../notifications/service.js";
import type { Db } from "../../lib/db.js";
import {
  allocateReference,
  alreadySignalled,
  assertDistinctActor,
  assertLocation,
  assertVendor,
  buildGates,
  daysUntil,
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

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const createSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(20_000),
  kind: z.enum(CONCESSION_KINDS).optional(),
  departureFromRequirement: z.string().max(10_000).nullable().optional(),
  justification: z.string().max(20_000).nullable().optional(),
  ncrId: idSchema.nullable().optional(),
  itpActivityId: idSchema.nullable().optional(),
  checklistId: idSchema.nullable().optional(),
  testRecordId: idSchema.nullable().optional(),
  weldId: idSchema.nullable().optional(),
  pourId: idSchema.nullable().optional(),
  certificateId: idSchema.nullable().optional(),
  specSectionId: idSchema.nullable().optional(),
  specClauseRef: z.string().max(200).nullable().optional(),
  drawingSheetId: idSchema.nullable().optional(),
  locationId: idSchema.nullable().optional(),
  locationText: z.string().max(500).nullable().optional(),
  assetId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  commitmentId: idSchema.nullable().optional(),
  quantityLimit: z.number().finite().nullable().optional(),
  unit: z.string().max(50).nullable().optional(),
  conditions: z.string().max(10_000).nullable().optional(),
  expiryDate: isoDateSchema.nullable().optional(),
  designerOrganisation: z.string().max(200).nullable().optional(),
  designerContact: z.string().max(200).nullable().optional(),
  valueImpact: z.number().finite().nullable().optional(),
  currency: z.string().length(3).optional(),
  documentFileId: idSchema.nullable().optional(),
  attachmentFileIds: fileIdsSchema.optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const patchSchema = createSchema.partial();

const listQuery = pageQuerySchema.extend({
  status: z.enum(CONCESSION_STATUSES).optional(),
  kind: z.enum(CONCESSION_KINDS).optional(),
  vendorId: idSchema.optional(),
  ncrId: idSchema.optional(),
  openOnly: z.coerce.boolean().optional(),
  expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  search: z.string().max(200).optional(),
});

const approveSchema = z.object({
  decision: z.enum(["approve", "approve_with_conditions", "reject"]),
  approvalAuthority: z.string().min(1).max(200),
  designerOrganisation: z.string().max(200).nullable().optional(),
  conditions: z.string().max(10_000).nullable().optional(),
  expiryDate: isoDateSchema.nullable().optional(),
  quantityLimit: z.number().finite().nullable().optional(),
  comments: z.string().max(10_000).nullable().optional(),
  rejectionReason: z.string().max(10_000).nullable().optional(),
  documentFileId: idSchema.nullable().optional(),
});

const EDITABLE = ["draft", "submitted", "under_review"];
const OPEN_STATUSES = ["draft", "submitted", "under_review", "approved", "approved_with_conditions"];

const PATCH_COLUMNS = [
  "title",
  "description",
  "kind",
  "departureFromRequirement",
  "justification",
  "ncrId",
  "itpActivityId",
  "checklistId",
  "testRecordId",
  "weldId",
  "pourId",
  "certificateId",
  "specSectionId",
  "specClauseRef",
  "drawingSheetId",
  "locationId",
  "locationText",
  "assetId",
  "vendorId",
  "commitmentId",
  "quantityLimit",
  "unit",
  "conditions",
  "expiryDate",
  "designerOrganisation",
  "designerContact",
  "valueImpact",
  "currency",
  "documentFileId",
  "attachmentFileIds",
  "detail",
] as const;

/* ------------------------------------------------------------------ */
/* Standing                                                            */
/* ------------------------------------------------------------------ */

export interface ConcessionStanding {
  live: boolean;
  expired: boolean;
  daysToExpiry: number | null;
  reasons: string[];
}

/** Where a concession stands on `asOf`. Pure — used by the route and the sweep. */
export function concessionStanding(
  row: { status: string; expiryDate: string | null; quantityLimit: number | null; unit: string | null },
  asOf: string,
): ConcessionStanding {
  const reasons: string[] = [];
  const approved = row.status === "approved" || row.status === "approved_with_conditions";
  if (!approved) {
    return {
      live: false,
      expired: false,
      daysToExpiry: row.expiryDate ? daysUntil(asOf, row.expiryDate) : null,
      reasons: [`The concession is ${row.status.replace(/_/g, " ")}; nothing is covered by it yet.`],
    };
  }
  if (!row.expiryDate) {
    reasons.push(
      "No expiry is recorded, so the concession runs indefinitely. A concession without an end is a permanent change to the specification and should be reviewed as one.",
    );
    if (row.quantityLimit !== null) {
      reasons.push(
        `It is limited to ${row.quantityLimit}${row.unit ? ` ${row.unit}` : ""}; the quantity actually covered has to be checked against the works.`,
      );
    }
    return { live: true, expired: false, daysToExpiry: null, reasons };
  }
  const days = daysUntil(asOf, row.expiryDate);
  if (days !== null && days < 0) {
    reasons.push(
      `Expired on ${row.expiryDate}, ${Math.abs(days)} day(s) ago. Work relying on it is non-conforming again until the concession is renewed or the work is put right.`,
    );
    return { live: false, expired: true, daysToExpiry: days, reasons };
  }
  if (days !== null && days <= 30) {
    reasons.push(`Expires on ${row.expiryDate}, in ${days} day(s).`);
  }
  return { live: true, expired: false, daysToExpiry: days, reasons };
}

/* ------------------------------------------------------------------ */
/* Sweep                                                               */
/* ------------------------------------------------------------------ */

/**
 * Expire what has run out and raise one signal per concession. Idempotent:
 * the signal key is the concession id, and the status move is a no-op the
 * second time.
 */
export async function sweepConcessions(
  db: Db,
  companyId: string,
  asOf: string = todayISO(),
  warnDays = 30,
): Promise<{ expired: number; raised: number }> {
  const rows = await db
    .select()
    .from(qualityConcessions)
    .where(
      and(
        eq(qualityConcessions.companyId, companyId),
        inArray(qualityConcessions.status, ["approved", "approved_with_conditions"]),
        isNotNull(qualityConcessions.expiryDate),
      ),
    );
  if (rows.length === 0) return { expired: 0, raised: 0 };
  const seen = await alreadySignalled(db, companyId, QUALITY_DETECTORS.concessionExpiring);
  let expired = 0;
  let raised = 0;
  for (const row of rows) {
    const standing = concessionStanding(row, asOf);
    const days = standing.daysToExpiry;
    if (days === null) continue;
    if (days < 0 && row.status !== "expired") {
      await db
        .update(qualityConcessions)
        .set({ status: "expired", updatedAt: nowISO() })
        .where(eq(qualityConcessions.id, row.id));
      expired += 1;
      await ledger(db, {
        companyId,
        projectId: row.projectId,
        actorId: null,
        action: "state_change",
        objectType: "quality_concession",
        objectId: row.id,
        payload: { from: row.status, to: "expired", expiryDate: row.expiryDate, sweptOn: asOf },
      });
    }
    if (days > warnDays || seen.has(row.id)) continue;
    seen.add(row.id);
    const signalId = await raiseSignal(db, companyId, row.projectId, null, {
      detector: QUALITY_DETECTORS.concessionExpiring,
      severity: days < 0 ? "high" : "medium",
      confidence: 1,
      title:
        days < 0
          ? `Concession ${row.reference} has expired — ${row.title}`
          : `Concession ${row.reference} expires in ${days} day(s) — ${row.title}`,
      explanation:
        `${row.reference} (${row.kind.replace(/_/g, " ")}) ${days < 0 ? `expired on ${row.expiryDate}` : `expires on ${row.expiryDate}`}. ` +
        `${row.conditions ? `It was granted on conditions: ${row.conditions}. ` : ""}` +
        `A concession is a time-limited acceptance of work that does not meet the specification. Once it runs out, the work it covered is ` +
        `non-conforming again and the acceptance somebody relied on no longer exists — which is precisely the state nobody discovers until ` +
        `the handover audit. Renew it, put the work right, or record the decision to accept it permanently.`,
      key: row.id,
      evidence: {
        concessionId: row.id,
        reference: row.reference,
        kind: row.kind,
        expiryDate: row.expiryDate,
        ncrId: row.ncrId,
        vendorId: row.vendorId,
        daysToExpiry: days,
      },
    });
    if (!row.signalId) {
      await db
        .update(qualityConcessions)
        .set({ signalId, updatedAt: nowISO() })
        .where(eq(qualityConcessions.id, row.id));
    }
    raised += 1;
  }
  return { expired, raised };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const concessionRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);

  async function fetchOr404(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(qualityConcessions)
      .where(
        and(
          eq(qualityConcessions.id, id),
          eq(qualityConcessions.companyId, companyId),
          eq(qualityConcessions.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Concession not found");
    return rows[0];
  }

  const decorate = (row: typeof qualityConcessions.$inferSelect) => ({
    ...row,
    standing: concessionStanding(row, todayISO()),
  });

  app.post("/projects/:projectId/concessions", { preHandler: standardGate }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    if (body.vendorId) await assertVendor(app.db, req.companyId!, body.vendorId);
    if (body.locationId) await assertLocation(app.db, req.projectId!, body.locationId);
    if (body.ncrId) {
      const ncr = await app.db
        .select({ id: nonConformanceReports.id })
        .from(nonConformanceReports)
        .where(
          and(
            eq(nonConformanceReports.id, body.ncrId),
            eq(nonConformanceReports.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!ncr[0]) throw badRequest(`NCR ${body.ncrId} not found in this project.`);
    }
    const { number, reference } = await allocateReference(
      app.db,
      req.projectId!,
      "concession",
      "CON",
    );
    const id = newId("con");
    const [created] = await app.db
      .insert(qualityConcessions)
      .values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        reference,
        kind: body.kind ?? "concession",
        title: body.title,
        description: body.description,
        departureFromRequirement: body.departureFromRequirement ?? null,
        justification: body.justification ?? null,
        ncrId: body.ncrId ?? null,
        itpActivityId: body.itpActivityId ?? null,
        checklistId: body.checklistId ?? null,
        testRecordId: body.testRecordId ?? null,
        weldId: body.weldId ?? null,
        pourId: body.pourId ?? null,
        certificateId: body.certificateId ?? null,
        specSectionId: body.specSectionId ?? null,
        specClauseRef: body.specClauseRef ?? null,
        drawingSheetId: body.drawingSheetId ?? null,
        locationId: body.locationId ?? null,
        locationText: body.locationText ?? null,
        assetId: body.assetId ?? null,
        vendorId: body.vendorId ?? null,
        commitmentId: body.commitmentId ?? null,
        quantityLimit: body.quantityLimit ?? null,
        unit: body.unit ?? null,
        conditions: body.conditions ?? null,
        expiryDate: body.expiryDate ?? null,
        requestedBy: req.user!.id,
        requestedAt: nowISO(),
        designerOrganisation: body.designerOrganisation ?? null,
        designerContact: body.designerContact ?? null,
        valueImpact: body.valueImpact ?? null,
        currency: body.currency ?? "USD",
        documentFileId: body.documentFileId ?? null,
        attachmentFileIds: body.attachmentFileIds ?? [],
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "quality_concession",
      objectId: id,
      payload: created,
      storePayload: true,
    });
    return reply.status(201).send(decorate(created!));
  });

  app.get("/projects/:projectId/concessions", { preHandler: readGate }, async (req) => {
    const q = listQuery.parse(req.query);
    const today = todayISO();
    const clauses = [
      eq(qualityConcessions.companyId, req.companyId!),
      eq(qualityConcessions.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(qualityConcessions.status, q.status));
    else if (q.openOnly) clauses.push(inArray(qualityConcessions.status, OPEN_STATUSES));
    if (q.kind) clauses.push(eq(qualityConcessions.kind, q.kind));
    if (q.vendorId) clauses.push(eq(qualityConcessions.vendorId, q.vendorId));
    if (q.ncrId) clauses.push(eq(qualityConcessions.ncrId, q.ncrId));
    if (q.search) clauses.push(ilike(qualityConcessions.title, `%${q.search}%`));
    // Expressed in SQL rather than filtered after the page is cut, so a page
    // of expiring concessions is a full page and the total is the right total.
    if (q.expiringWithinDays !== undefined) {
      const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + q.expiringWithinDays * 86_400_000)
        .toISOString()
        .slice(0, 10);
      clauses.push(isNotNull(qualityConcessions.expiryDate));
      clauses.push(lte(qualityConcessions.expiryDate, horizon));
      clauses.push(
        inArray(qualityConcessions.status, ["approved", "approved_with_conditions", "expired"]),
      );
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(qualityConcessions).where(where);
    const rows = await app.db
      .select()
      .from(qualityConcessions)
      .where(where)
      .orderBy(desc(qualityConcessions.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows.map(decorate), Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/concessions/:id", { preHandler: readGate }, async (req) => {
    const { id } = req.params as { id: string };
    return decorate(await fetchOr404(id, req.companyId!, req.projectId!));
  });

  app.patch("/projects/:projectId/concessions/:id", { preHandler: standardGate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = patchSchema.parse(req.body);
    const row = await fetchOr404(id, req.companyId!, req.projectId!);
    if (!EDITABLE.includes(row.status)) {
      throw badRequest(
        `${row.reference} is ${row.status}. An approved concession is not edited — the terms somebody accepted are the terms on the record. Withdraw it and raise another if the departure has changed.`,
      );
    }
    if (body.vendorId) await assertVendor(app.db, req.companyId!, body.vendorId);
    if (body.locationId) await assertLocation(app.db, req.projectId!, body.locationId);
    await app.db
      .update(qualityConcessions)
      .set(patchSet(body as Record<string, unknown>, PATCH_COLUMNS))
      .where(eq(qualityConcessions.id, id));
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "quality_concession",
      objectId: id,
      payload: { changed: Object.keys(body) },
    });
    return decorate(await fetchOr404(id, req.companyId!, req.projectId!));
  });

  app.post(
    "/projects/:projectId/concessions/:id/submit",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const row = await fetchOr404(id, req.companyId!, req.projectId!);
      if (row.status !== "draft") {
        throw badRequest(`${row.reference} is ${row.status}; only a draft is submitted.`);
      }
      if (!row.departureFromRequirement) {
        throw badRequest(
          `${row.reference} does not state the departure from the requirement. A concession that does not say what it departs from cannot be assessed by the designer, and cannot be checked against the works afterwards.`,
        );
      }
      const at = nowISO();
      await app.db
        .update(qualityConcessions)
        .set({ status: "submitted", requestedAt: row.requestedAt ?? at, updatedAt: at })
        .where(eq(qualityConcessions.id, id));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "quality_concession",
        objectId: id,
        payload: { from: row.status, to: "submitted" },
      });
      return decorate(await fetchOr404(id, req.companyId!, req.projectId!));
    },
  );

  /**
   * The designer's decision. Segregated: the person who asked for the
   * departure may not be the person who accepts it.
   */
  app.post(
    "/projects/:projectId/concessions/:id/approve",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = approveSchema.parse(req.body);
      const row = await fetchOr404(id, req.companyId!, req.projectId!);
      if (row.status !== "submitted" && row.status !== "under_review") {
        throw badRequest(
          `${row.reference} is ${row.status}; a concession is decided once it has been submitted.`,
        );
      }
      assertDistinctActor(
        req.user!.id,
        row.requestedBy,
        `The decision on concession ${row.reference}`,
        "requested",
      );
      const at = nowISO();
      const approved = body.decision !== "reject";
      const status = body.decision === "reject" ? "rejected" : body.decision === "approve_with_conditions" ? "approved_with_conditions" : "approved";
      if (body.decision === "approve_with_conditions" && !body.conditions) {
        throw badRequest(
          "An approval with conditions must state the conditions. Conditions nobody wrote down are conditions nobody can check.",
        );
      }
      await app.db
        .update(qualityConcessions)
        .set({
          status,
          approvedBy: approved ? req.user!.id : null,
          approvedAt: approved ? at : null,
          approvalAuthority: body.approvalAuthority,
          designerOrganisation: body.designerOrganisation ?? row.designerOrganisation,
          approvalComments: body.comments ?? null,
          rejectionReason: body.decision === "reject" ? (body.rejectionReason ?? body.comments ?? null) : null,
          conditions: body.conditions ?? row.conditions,
          expiryDate: body.expiryDate ?? row.expiryDate,
          quantityLimit: body.quantityLimit ?? row.quantityLimit,
          documentFileId: body.documentFileId ?? row.documentFileId,
          updatedAt: at,
        })
        .where(eq(qualityConcessions.id, id));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "quality_concession",
        objectId: id,
        payload: {
          from: row.status,
          to: status,
          decision: body.decision,
          approvalAuthority: body.approvalAuthority,
          requestedBy: row.requestedBy,
          conditions: body.conditions ?? row.conditions,
          expiryDate: body.expiryDate ?? row.expiryDate,
        },
        storePayload: true,
      });
      if (row.requestedBy !== req.user!.id) {
        await pushNotifications(app.db, [
          {
            companyId: req.companyId!,
            userId: row.requestedBy,
            projectId: req.projectId!,
            kind: "status_change",
            title: `Concession ${row.reference} ${status.replace(/_/g, " ")}`,
            recordType: "quality_concession",
            recordId: id,
          },
        ]);
      }
      return decorate(await fetchOr404(id, req.companyId!, req.projectId!));
    },
  );

  app.post(
    "/projects/:projectId/concessions/:id/withdraw",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body);
      const row = await fetchOr404(id, req.companyId!, req.projectId!);
      if (row.status === "closed" || row.status === "withdrawn") {
        throw badRequest(`${row.reference} is already ${row.status}.`);
      }
      await app.db
        .update(qualityConcessions)
        .set({
          status: "withdrawn",
          detail: { ...(row.detail as Record<string, unknown>), withdrawalReason: body.reason },
          updatedAt: nowISO(),
        })
        .where(eq(qualityConcessions.id, id));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "quality_concession",
        objectId: id,
        payload: { from: row.status, to: "withdrawn", reason: body.reason },
        storePayload: true,
      });
      return decorate(await fetchOr404(id, req.companyId!, req.projectId!));
    },
  );

  app.post(
    "/projects/:projectId/concessions/:id/close",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = z.object({ note: z.string().max(4000).nullable().optional() }).parse(req.body ?? {});
      const row = await fetchOr404(id, req.companyId!, req.projectId!);
      if (row.status !== "approved" && row.status !== "approved_with_conditions" && row.status !== "expired") {
        throw badRequest(
          `${row.reference} is ${row.status}; a concession is closed once it has been granted and its work is complete.`,
        );
      }
      const at = nowISO();
      await app.db
        .update(qualityConcessions)
        .set({
          status: "closed",
          closedBy: req.user!.id,
          closedAt: at,
          detail: { ...(row.detail as Record<string, unknown>), closureNote: body.note ?? null },
          updatedAt: at,
        })
        .where(eq(qualityConcessions.id, id));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "quality_concession",
        objectId: id,
        payload: { from: row.status, to: "closed", note: body.note ?? null },
      });
      return decorate(await fetchOr404(id, req.companyId!, req.projectId!));
    },
  );

  /** Force the expiry sweep now — the scheduler owns the routine pass. */
  app.post("/projects/:projectId/concessions/sweep", { preHandler: standardGate }, async (req) => {
    const body = z.object({ asOf: isoDateSchema.optional() }).parse(req.body ?? {});
    return sweepConcessions(app.db, req.companyId!, body.asOf ?? todayISO());
  });

  /** The register's own summary — used by the workspace and by health inputs. */
  app.get("/projects/:projectId/concessions-summary", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(qualityConcessions)
      .where(
        and(
          eq(qualityConcessions.companyId, req.companyId!),
          eq(qualityConcessions.projectId, req.projectId!),
        ),
      )
      .orderBy(asc(qualityConcessions.number));
    const today = todayISO();
    const byStatus: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    const expiring: Array<{ id: string; reference: string; expiryDate: string | null; days: number | null }> = [];
    let live = 0;
    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
      const standing = concessionStanding(row, today);
      if (standing.live) live += 1;
      if (standing.live && standing.daysToExpiry !== null && standing.daysToExpiry <= 60) {
        expiring.push({
          id: row.id,
          reference: row.reference,
          expiryDate: row.expiryDate,
          days: standing.daysToExpiry,
        });
      }
    }
    const byVendor = new Map<string, number>();
    for (const row of rows) {
      if (!row.vendorId) continue;
      byVendor.set(row.vendorId, (byVendor.get(row.vendorId) ?? 0) + 1);
    }
    return {
      total: rows.length,
      live,
      byStatus,
      byKind,
      expiring: expiring.sort((a, b) => (a.days ?? 0) - (b.days ?? 0)),
      expired: rows.filter((r) => r.status === "expired").length,
      awaitingDecision: rows.filter((r) => r.status === "submitted" || r.status === "under_review")
        .length,
      byVendor: [...byVendor.entries()].map(([vendorId, n]) => ({ vendorId, concessions: n })),
      withoutExpiry: rows.filter(
        (r) => (r.status === "approved" || r.status === "approved_with_conditions") && !r.expiryDate,
      ).length,
    };
  });
};
