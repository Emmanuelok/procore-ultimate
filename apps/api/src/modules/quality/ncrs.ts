/**
 * Non-conformance reports.
 *
 * The register exists to make ONE act difficult: deciding that
 * non-conforming work is acceptable. `use_as_is` and `repair` both leave the
 * departure permanently in the building, so the disposition is PROPOSED by
 * one person and APPROVED by another, and the platform refuses the case where
 * they are the same person — that refusal is the product.
 *
 * Two things this module deliberately does NOT keep:
 *   - a second corrective-action list. Actions are rows in
 *     `safety_corrective_actions` with `sourceType = "ncr"`, so a project has
 *     one overdue-actions view rather than a safety one and a quality one.
 *   - a second snag list. See ./raise.ts on why a punch item and an NCR are
 *     different animals.
 */

import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  changeEvents,
  checklistResponses,
  itpActivities,
  materialDeliveries,
  nonConformanceReports,
  safetyCorrectiveActions,
} from "@constructos/db";
import {
  ACTION_ITEM_PRIORITIES,
  CORRECTIVE_ACTION_KINDS,
  HIERARCHY_OF_CONTROLS,
  NCR_CATEGORIES,
  NCR_DISPOSITIONS,
  NCR_SEVERITIES,
  NCR_SOURCES,
  NCR_STATUSES,
  ROOT_CAUSE_METHODS,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { pushNotifications } from "../notifications/service.js";
import {
  assertAsset,
  assertDistinctActor,
  assertLocation,
  assertVendor,
  buildGates,
  fileIdsSchema,
  idSchema,
  isoDateSchema,
  isoTimestampSchema,
  ledger,
  nowISO,
  pad3,
  round2,
} from "./shared.js";
import { createNcr } from "./raise.js";
import { sweepQuality } from "./sweeps.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const ncrCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(20_000),
  category: z.enum(NCR_CATEGORIES).optional(),
  severity: z.enum(NCR_SEVERITIES).optional(),
  sourceType: z.enum(NCR_SOURCES).optional(),
  sourceId: idSchema.nullable().optional(),
  checklistId: idSchema.nullable().optional(),
  checklistResponseId: idSchema.nullable().optional(),
  itpActivityId: idSchema.nullable().optional(),
  testRecordId: idSchema.nullable().optional(),
  deliveryId: idSchema.nullable().optional(),
  raisedAgainstVendorId: idSchema.nullable().optional(),
  commitmentId: idSchema.nullable().optional(),
  raisedByOrganisation: z.string().max(200).nullable().optional(),
  specSectionId: idSchema.nullable().optional(),
  specClauseRef: z.string().max(200).nullable().optional(),
  drawingSheetId: idSchema.nullable().optional(),
  drawingReference: z.string().max(200).nullable().optional(),
  locationId: idSchema.nullable().optional(),
  locationText: z.string().max(500).nullable().optional(),
  assetId: idSchema.nullable().optional(),
  materialItemId: idSchema.nullable().optional(),
  quantityAffected: z.number().finite().nullable().optional(),
  unit: z.string().max(50).nullable().optional(),
  detectedAt: isoTimestampSchema.nullable().optional(),
  responseDueDate: isoDateSchema.nullable().optional(),
  photoFileIds: fileIdsSchema.optional(),
  attachmentFileIds: fileIdsSchema.optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const ncrPatchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().min(1).max(20_000).optional(),
  category: z.enum(NCR_CATEGORIES).optional(),
  severity: z.enum(NCR_SEVERITIES).optional(),
  status: z.enum(["open", "under_review", "void"]).optional(),
  raisedAgainstVendorId: idSchema.nullable().optional(),
  commitmentId: idSchema.nullable().optional(),
  specSectionId: idSchema.nullable().optional(),
  specClauseRef: z.string().max(200).nullable().optional(),
  drawingSheetId: idSchema.nullable().optional(),
  drawingReference: z.string().max(200).nullable().optional(),
  locationId: idSchema.nullable().optional(),
  locationText: z.string().max(500).nullable().optional(),
  assetId: idSchema.nullable().optional(),
  quantityAffected: z.number().finite().nullable().optional(),
  unit: z.string().max(50).nullable().optional(),
  responseDueDate: isoDateSchema.nullable().optional(),
  costImpact: z.number().finite().nullable().optional(),
  currency: z.string().length(3).optional(),
  scheduleImpactDays: z.number().finite().nullable().optional(),
  photoFileIds: fileIdsSchema.optional(),
  attachmentFileIds: fileIdsSchema.optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const ncrListQuery = pageQuerySchema.extend({
  status: z.enum(NCR_STATUSES).optional(),
  severity: z.enum(NCR_SEVERITIES).optional(),
  category: z.enum(NCR_CATEGORIES).optional(),
  disposition: z.enum(NCR_DISPOSITIONS).optional(),
  sourceType: z.enum(NCR_SOURCES).optional(),
  vendorId: idSchema.optional(),
  assetId: idSchema.optional(),
  openOnly: z.coerce.boolean().optional(),
  overdueOnly: z.coerce.boolean().optional(),
  search: z.string().max(200).optional(),
});

const proposeSchema = z.object({
  disposition: z.enum(["rework", "repair", "use_as_is", "reject", "return_to_supplier", "regrade"]),
  justification: z.string().min(1).max(20_000),
  costImpact: z.number().finite().nullable().optional(),
  scheduleImpactDays: z.number().finite().nullable().optional(),
  currency: z.string().length(3).optional(),
});

const approveDispositionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  comments: z.string().max(10_000).nullable().optional(),
  /** the designer's concession — required where work stays in as-is */
  concessionReference: z.string().max(200).nullable().optional(),
  concessionFileId: idSchema.nullable().optional(),
});

const rootCauseSchema = z.object({
  rootCause: z.string().min(1).max(20_000),
  rootCauseMethod: z.enum(ROOT_CAUSE_METHODS).optional(),
  correctiveActionSummary: z.string().max(20_000).nullable().optional(),
  preventiveActionSummary: z.string().max(20_000).nullable().optional(),
});

const actionCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(20_000).nullable().optional(),
  actionKind: z.enum(CORRECTIVE_ACTION_KINDS).optional(),
  hierarchyOfControl: z.enum(HIERARCHY_OF_CONTROLS).nullable().optional(),
  priority: z.enum(ACTION_ITEM_PRIORITIES).optional(),
  ownerId: idSchema.nullable().optional(),
  ownerVendorId: idSchema.nullable().optional(),
  ownerName: z.string().max(200).nullable().optional(),
  dueDate: isoDateSchema,
  costToImplement: z.number().finite().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
});

const closeSchema = z.object({
  closeoutEvidenceDescription: z.string().min(1).max(20_000),
  closeoutEvidenceFileIds: fileIdsSchema.optional(),
  verificationChecklistId: idSchema.nullable().optional(),
  costImpact: z.number().finite().nullable().optional(),
  scheduleImpactDays: z.number().finite().nullable().optional(),
});

const verifySchema = z.object({
  verificationMethod: z.string().min(1).max(500),
  note: z.string().max(10_000).nullable().optional(),
});

const backchargeSchema = z.object({
  changeEventId: idSchema.optional(),
  amount: z.number().finite().min(0).optional(),
  backchargeReference: z.string().max(200).optional(),
  description: z.string().max(10_000).optional(),
  scheduleImpactDays: z.number().int().optional(),
});

const reopenSchema = z.object({ reason: z.string().min(1).max(10_000) });

const NCR_OPEN_STATUSES = [
  "open",
  "under_review",
  "disposition_proposed",
  "disposition_approved",
  "action_in_progress",
  "verification_pending",
];

const NCR_PATCH_COLUMNS = [
  "title",
  "description",
  "category",
  "severity",
  "status",
  "raisedAgainstVendorId",
  "commitmentId",
  "specSectionId",
  "specClauseRef",
  "drawingSheetId",
  "drawingReference",
  "locationId",
  "locationText",
  "assetId",
  "quantityAffected",
  "unit",
  "responseDueDate",
  "costImpact",
  "currency",
  "scheduleImpactDays",
  "photoFileIds",
  "attachmentFileIds",
  "detail",
] as const;

/** Dispositions that leave the departure permanently in the building. */
export const CONCESSION_DISPOSITIONS = ["use_as_is", "repair"];

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const ncrRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);

  async function fetchNcr(ncrId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(nonConformanceReports)
      .where(
        and(
          eq(nonConformanceReports.id, ncrId),
          eq(nonConformanceReports.companyId, companyId),
          eq(nonConformanceReports.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Non-conformance report not found");
    return rows[0];
  }

  async function loadActions(ncrId: string) {
    return app.db
      .select()
      .from(safetyCorrectiveActions)
      .where(
        and(
          eq(safetyCorrectiveActions.sourceType, "ncr"),
          eq(safetyCorrectiveActions.sourceId, ncrId),
        ),
      )
      .orderBy(asc(safetyCorrectiveActions.dueDate));
  }

  /** Keep the NCR's open-action counter honest against the shared register. */
  async function refreshOpenActionCount(ncrId: string) {
    const actions = await loadActions(ncrId);
    const open = actions.filter(
      (a) => a.status !== "closed" && a.status !== "cancelled" && a.status !== "verified",
    );
    await app.db
      .update(nonConformanceReports)
      .set({ openActionCount: open.length, updatedAt: nowISO() })
      .where(eq(nonConformanceReports.id, ncrId));
    return { actions, open };
  }

  /* ---------------------------------------------------------------- */
  /* Register                                                          */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/ncrs", { preHandler: standardGate }, async (req, reply) => {
    const body = ncrCreateSchema.parse(req.body);
    if (body.raisedAgainstVendorId) {
      await assertVendor(app.db, req.companyId!, body.raisedAgainstVendorId);
    }
    if (body.locationId) await assertLocation(app.db, req.projectId!, body.locationId);
    if (body.assetId) await assertAsset(app.db, req.projectId!, body.assetId);

    // Provenance: a source that names a record we hold is resolved, not trusted.
    if (body.checklistResponseId) {
      const rows = await app.db
        .select({ id: checklistResponses.id })
        .from(checklistResponses)
        .where(
          and(
            eq(checklistResponses.id, body.checklistResponseId),
            eq(checklistResponses.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!rows[0]) throw badRequest(`Checklist response ${body.checklistResponseId} not found in this project.`);
    }
    if (body.itpActivityId) {
      const rows = await app.db
        .select({ id: itpActivities.id })
        .from(itpActivities)
        .where(
          and(
            eq(itpActivities.id, body.itpActivityId),
            eq(itpActivities.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!rows[0]) throw badRequest(`ITP activity ${body.itpActivityId} not found in this project.`);
    }
    if (body.deliveryId) {
      const rows = await app.db
        .select({ id: materialDeliveries.id })
        .from(materialDeliveries)
        .where(
          and(
            eq(materialDeliveries.id, body.deliveryId),
            eq(materialDeliveries.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!rows[0]) throw badRequest(`Delivery ${body.deliveryId} not found in this project.`);
    }

    const sourceType =
      body.sourceType ??
      (body.checklistResponseId || body.checklistId
        ? "checklist"
        : body.itpActivityId
          ? "itp_activity"
          : body.testRecordId
            ? "test_record"
            : body.deliveryId
              ? "delivery"
              : "self_identified");

    const created = await createNcr(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      title: body.title,
      description: body.description,
      category: body.category,
      severity: body.severity,
      sourceType,
      sourceId:
        body.sourceId ??
        body.checklistResponseId ??
        body.itpActivityId ??
        body.testRecordId ??
        body.deliveryId ??
        null,
      checklistId: body.checklistId,
      checklistResponseId: body.checklistResponseId,
      itpActivityId: body.itpActivityId,
      testRecordId: body.testRecordId,
      deliveryId: body.deliveryId,
      raisedAgainstVendorId: body.raisedAgainstVendorId,
      commitmentId: body.commitmentId,
      raisedByOrganisation: body.raisedByOrganisation,
      specSectionId: body.specSectionId,
      specClauseRef: body.specClauseRef,
      drawingSheetId: body.drawingSheetId,
      drawingReference: body.drawingReference,
      locationId: body.locationId,
      locationText: body.locationText,
      assetId: body.assetId,
      materialItemId: body.materialItemId,
      quantityAffected: body.quantityAffected,
      unit: body.unit,
      detectedAt: body.detectedAt,
      responseDueDate: body.responseDueDate,
      photoFileIds: body.photoFileIds,
      attachmentFileIds: body.attachmentFileIds,
      detail: body.detail,
    });

    if (body.checklistResponseId) {
      await app.db
        .update(checklistResponses)
        .set({ ncrId: created.id, updatedAt: nowISO() })
        .where(eq(checklistResponses.id, body.checklistResponseId));
    }
    if (body.itpActivityId) {
      await app.db
        .update(itpActivities)
        .set({ ncrId: created.id, updatedAt: nowISO() })
        .where(eq(itpActivities.id, body.itpActivityId));
    }
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/ncrs", { preHandler: readGate }, async (req) => {
    await sweepQuality(app.db, req.companyId!, req.projectId!, req.user!.id);
    const q = ncrListQuery.parse(req.query);
    const clauses = [
      eq(nonConformanceReports.companyId, req.companyId!),
      eq(nonConformanceReports.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(nonConformanceReports.status, q.status));
    else if (q.openOnly) clauses.push(inArray(nonConformanceReports.status, NCR_OPEN_STATUSES));
    if (q.severity) clauses.push(eq(nonConformanceReports.severity, q.severity));
    if (q.category) clauses.push(eq(nonConformanceReports.category, q.category));
    if (q.disposition) clauses.push(eq(nonConformanceReports.disposition, q.disposition));
    if (q.sourceType) clauses.push(eq(nonConformanceReports.sourceType, q.sourceType));
    if (q.vendorId) clauses.push(eq(nonConformanceReports.raisedAgainstVendorId, q.vendorId));
    if (q.assetId) clauses.push(eq(nonConformanceReports.assetId, q.assetId));
    if (q.search) clauses.push(ilike(nonConformanceReports.title, `%${q.search}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(nonConformanceReports)
      .where(where);
    let items = await app.db
      .select()
      .from(nonConformanceReports)
      .where(where)
      .orderBy(desc(nonConformanceReports.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    if (q.overdueOnly) {
      const today = new Date().toISOString().slice(0, 10);
      items = items.filter(
        (n) =>
          n.responseDueDate !== null &&
          n.responseDueDate < today &&
          NCR_OPEN_STATUSES.includes(n.status),
      );
    }
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/ncrs/:ncrId", { preHandler: readGate }, async (req) => {
    const { ncrId } = req.params as { ncrId: string };
    const ncr = await fetchNcr(ncrId, req.companyId!, req.projectId!);
    const { actions } = await refreshOpenActionCount(ncrId);
    return {
      ...(await fetchNcr(ncrId, req.companyId!, req.projectId!)),
      correctiveActions: actions,
      segregation: {
        dispositionProposedBy: ncr.dispositionProposedBy,
        dispositionApprovedBy: ncr.dispositionApprovedBy,
        closedBy: ncr.closedBy,
        verifiedBy: ncr.verifiedBy,
      },
    };
  });

  app.patch("/projects/:projectId/ncrs/:ncrId", { preHandler: standardGate }, async (req) => {
    const { ncrId } = req.params as { ncrId: string };
    const body = ncrPatchSchema.parse(req.body);
    const ncr = await fetchNcr(ncrId, req.companyId!, req.projectId!);
    if (ncr.status === "closed" || ncr.status === "void") {
      throw badRequest(
        `${ncr.reference} is ${ncr.status}. Reopen it with a reason rather than editing a closed record.`,
      );
    }
    if (body.raisedAgainstVendorId) {
      await assertVendor(app.db, req.companyId!, body.raisedAgainstVendorId);
    }
    if (body.locationId) await assertLocation(app.db, req.projectId!, body.locationId);
    if (body.assetId) await assertAsset(app.db, req.projectId!, body.assetId);
    const set: Record<string, unknown> = { updatedAt: nowISO() };
    for (const key of NCR_PATCH_COLUMNS) {
      const value = (body as Record<string, unknown>)[key];
      if (value !== undefined) set[key] = value;
    }
    await app.db.update(nonConformanceReports).set(set).where(eq(nonConformanceReports.id, ncrId));
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "non_conformance_report",
      objectId: ncrId,
      payload: { changed: Object.keys(body) },
    });
    return fetchNcr(ncrId, req.companyId!, req.projectId!);
  });

  /* ---------------------------------------------------------------- */
  /* Disposition — the segregated act                                  */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/ncrs/:ncrId/disposition/propose",
    { preHandler: standardGate },
    async (req) => {
      const { ncrId } = req.params as { ncrId: string };
      const body = proposeSchema.parse(req.body);
      const ncr = await fetchNcr(ncrId, req.companyId!, req.projectId!);
      if (!["open", "under_review", "disposition_proposed"].includes(ncr.status)) {
        throw badRequest(
          `${ncr.reference} is ${ncr.status}; a disposition is proposed while the NCR is still open for one.`,
        );
      }
      const at = nowISO();
      await app.db
        .update(nonConformanceReports)
        .set({
          status: "disposition_proposed",
          disposition: body.disposition,
          dispositionJustification: body.justification,
          dispositionProposedBy: req.user!.id,
          dispositionProposedAt: at,
          // a re-proposal clears any earlier approval: the approval was of the
          // previous disposition, not of this one
          dispositionApprovedBy: null,
          dispositionApprovedAt: null,
          costImpact: body.costImpact !== undefined ? body.costImpact : ncr.costImpact,
          scheduleImpactDays:
            body.scheduleImpactDays !== undefined
              ? body.scheduleImpactDays
              : ncr.scheduleImpactDays,
          currency: body.currency ?? ncr.currency,
          updatedAt: at,
        })
        .where(eq(nonConformanceReports.id, ncrId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "non_conformance_report",
        objectId: ncrId,
        payload: {
          from: ncr.status,
          to: "disposition_proposed",
          disposition: body.disposition,
          justification: body.justification,
          proposedBy: req.user!.id,
        },
        storePayload: true,
      });
      return fetchNcr(ncrId, req.companyId!, req.projectId!);
    },
  );

  /**
   * Approve (or reject) the proposed disposition.
   *
   * The refusal below is the reason this register exists: a `use_as_is`
   * disposition signed off by the person who proposed it is a decision nobody
   * independent ever made, and it is the single most common way non-conforming
   * work ends up permanently in a building with a paper trail that looks fine.
   */
  app.post(
    "/projects/:projectId/ncrs/:ncrId/disposition/approve",
    { preHandler: standardGate },
    async (req) => {
      const { ncrId } = req.params as { ncrId: string };
      const body = approveDispositionSchema.parse(req.body);
      const ncr = await fetchNcr(ncrId, req.companyId!, req.projectId!);
      if (ncr.status !== "disposition_proposed") {
        throw badRequest(
          `${ncr.reference} is ${ncr.status} with disposition "${ncr.disposition}"; there is no proposed disposition to approve.`,
        );
      }
      assertDistinctActor(
        req.user!.id,
        ncr.dispositionProposedBy,
        `Approval of a "${ncr.disposition}" disposition on ${ncr.reference}`,
        "proposed",
      );
      if (
        body.decision === "approve" &&
        ncr.disposition === "use_as_is" &&
        !body.concessionReference
      ) {
        throw badRequest(
          `A "use as is" disposition leaves non-conforming work permanently in the building, so it is only acceptable on the designer's concession. ` +
            `Record the concession reference (and its document where you have one) before approving ${ncr.reference}.`,
        );
      }
      const at = nowISO();
      const approved = body.decision === "approve";
      await app.db
        .update(nonConformanceReports)
        .set({
          status: approved ? "disposition_approved" : "under_review",
          dispositionApprovedBy: approved ? req.user!.id : null,
          dispositionApprovedAt: approved ? at : null,
          concessionReference: body.concessionReference ?? ncr.concessionReference,
          concessionFileId: body.concessionFileId ?? ncr.concessionFileId,
          detail: {
            ...(ncr.detail as Record<string, unknown>),
            dispositionDecisionComments: body.comments ?? null,
          },
          updatedAt: at,
        })
        .where(eq(nonConformanceReports.id, ncrId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "non_conformance_report",
        objectId: ncrId,
        payload: {
          from: ncr.status,
          to: approved ? "disposition_approved" : "under_review",
          decision: body.decision,
          disposition: ncr.disposition,
          proposedBy: ncr.dispositionProposedBy,
          approvedBy: approved ? req.user!.id : null,
          concessionReference: body.concessionReference ?? null,
          comments: body.comments ?? null,
        },
        storePayload: true,
      });
      if (ncr.dispositionProposedBy && ncr.dispositionProposedBy !== req.user!.id) {
        await pushNotifications(app.db, [
          {
            companyId: req.companyId!,
            userId: ncr.dispositionProposedBy,
            projectId: req.projectId!,
            kind: "status_change",
            title: `${ncr.reference} disposition "${ncr.disposition}" ${approved ? "approved" : "sent back"}`,
            recordType: "non_conformance_report",
            recordId: ncrId,
          },
        ]);
      }
      return fetchNcr(ncrId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/ncrs/:ncrId/root-cause",
    { preHandler: standardGate },
    async (req) => {
      const { ncrId } = req.params as { ncrId: string };
      const body = rootCauseSchema.parse(req.body);
      const ncr = await fetchNcr(ncrId, req.companyId!, req.projectId!);
      await app.db
        .update(nonConformanceReports)
        .set({
          rootCause: body.rootCause,
          rootCauseMethod: body.rootCauseMethod ?? ncr.rootCauseMethod,
          correctiveActionSummary: body.correctiveActionSummary ?? ncr.correctiveActionSummary,
          preventiveActionSummary: body.preventiveActionSummary ?? ncr.preventiveActionSummary,
          updatedAt: nowISO(),
        })
        .where(eq(nonConformanceReports.id, ncrId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "non_conformance_report",
        objectId: ncrId,
        payload: { rootCause: body.rootCause, method: body.rootCauseMethod ?? ncr.rootCauseMethod },
        storePayload: true,
      });
      return fetchNcr(ncrId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Corrective actions — in the SHARED register, not a second one      */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/ncrs/:ncrId/actions", { preHandler: readGate }, async (req) => {
    const { ncrId } = req.params as { ncrId: string };
    await fetchNcr(ncrId, req.companyId!, req.projectId!);
    const { actions, open } = await refreshOpenActionCount(ncrId);
    return { items: actions, total: actions.length, openCount: open.length };
  });

  app.post(
    "/projects/:projectId/ncrs/:ncrId/actions",
    { preHandler: standardGate },
    async (req, reply) => {
      const { ncrId } = req.params as { ncrId: string };
      const body = actionCreateSchema.parse(req.body);
      const ncr = await fetchNcr(ncrId, req.companyId!, req.projectId!);
      if (body.ownerVendorId) await assertVendor(app.db, req.companyId!, body.ownerVendorId);
      const number = await nextRecordNumber(app.db, req.projectId!, "corrective_action");
      const id = newId("sca");
      const [created] = await app.db
        .insert(safetyCorrectiveActions)
        .values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          number,
          reference: `CA-${pad3(number)}`,
          sourceType: "ncr",
          sourceId: ncrId,
          sourceReference: ncr.reference,
          title: body.title,
          description: body.description ?? null,
          actionKind: body.actionKind ?? "corrective",
          hierarchyOfControl: body.hierarchyOfControl ?? null,
          priority: body.priority ?? "medium",
          ownerId: body.ownerId ?? null,
          ownerVendorId: body.ownerVendorId ?? null,
          ownerName: body.ownerName ?? null,
          dueDate: body.dueDate,
          originalDueDate: body.dueDate,
          costToImplement: body.costToImplement ?? null,
          currency: body.currency ?? null,
          createdBy: req.user!.id,
        })
        .returning();
      await refreshOpenActionCount(ncrId);
      if (ncr.status === "disposition_approved" || ncr.status === "open") {
        await app.db
          .update(nonConformanceReports)
          .set({ status: "action_in_progress", updatedAt: nowISO() })
          .where(eq(nonConformanceReports.id, ncrId));
      }
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "safety_corrective_action",
        objectId: id,
        payload: created,
        storePayload: true,
      });
      if (body.ownerId) {
        await pushNotifications(app.db, [
          {
            companyId: req.companyId!,
            userId: body.ownerId,
            projectId: req.projectId!,
            kind: "assignment",
            title: `Corrective action CA-${pad3(number)} from ${ncr.reference}: ${body.title}`,
            recordType: "safety_corrective_action",
            recordId: id,
          },
        ]);
      }
      return reply.status(201).send(created);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Closeout and independent verification                             */
  /* ---------------------------------------------------------------- */

  /**
   * Submit the closeout evidence. This does NOT close the NCR: it moves it to
   * `verification_pending`, and somebody other than the person who did this
   * has to verify the fix before it is closed. The two-step is the whole
   * difference between "we say it is fixed" and "it was checked".
   */
  app.post("/projects/:projectId/ncrs/:ncrId/close", { preHandler: standardGate }, async (req) => {
    const { ncrId } = req.params as { ncrId: string };
    const body = closeSchema.parse(req.body);
    const ncr = await fetchNcr(ncrId, req.companyId!, req.projectId!);
    if (ncr.status === "closed" || ncr.status === "void") {
      throw badRequest(`${ncr.reference} is already ${ncr.status}.`);
    }
    if (ncr.disposition === "pending" || !ncr.dispositionApprovedBy) {
      throw badRequest(
        `${ncr.reference} cannot be closed out: its disposition is "${ncr.disposition}"` +
          `${ncr.dispositionProposedBy && !ncr.dispositionApprovedBy ? " and is still awaiting approval" : ""}. ` +
          `Closing an NCR before anybody has decided what to do about the non-conformance records a fix to a decision that was never made.`,
      );
    }
    const { open } = await refreshOpenActionCount(ncrId);
    if (open.length > 0) {
      throw badRequest(
        `${ncr.reference} has ${open.length} corrective action(s) still open: ${open
          .map((a) => `${a.reference} ${a.title} (due ${a.dueDate}, ${a.status})`)
          .join("; ")}. Complete or cancel them before submitting closeout.`,
      );
    }
    const at = nowISO();
    await app.db
      .update(nonConformanceReports)
      .set({
        status: "verification_pending",
        closeoutEvidenceDescription: body.closeoutEvidenceDescription,
        closeoutEvidenceFileIds: body.closeoutEvidenceFileIds ?? ncr.closeoutEvidenceFileIds,
        verificationChecklistId: body.verificationChecklistId ?? ncr.verificationChecklistId,
        costImpact: body.costImpact !== undefined ? body.costImpact : ncr.costImpact,
        scheduleImpactDays:
          body.scheduleImpactDays !== undefined ? body.scheduleImpactDays : ncr.scheduleImpactDays,
        closedBy: req.user!.id,
        closedAt: at,
        updatedAt: at,
      })
      .where(eq(nonConformanceReports.id, ncrId));
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "non_conformance_report",
      objectId: ncrId,
      payload: {
        from: ncr.status,
        to: "verification_pending",
        closedBy: req.user!.id,
        evidence: body.closeoutEvidenceDescription,
        evidenceFileIds: body.closeoutEvidenceFileIds ?? [],
      },
      storePayload: true,
    });
    return fetchNcr(ncrId, req.companyId!, req.projectId!);
  });

  app.post("/projects/:projectId/ncrs/:ncrId/verify", { preHandler: standardGate }, async (req) => {
    const { ncrId } = req.params as { ncrId: string };
    const body = verifySchema.parse(req.body);
    const ncr = await fetchNcr(ncrId, req.companyId!, req.projectId!);
    if (ncr.status !== "verification_pending") {
      throw badRequest(
        `${ncr.reference} is ${ncr.status}; verification follows the submission of closeout evidence.`,
      );
    }
    assertDistinctActor(
      req.user!.id,
      ncr.closedBy,
      `Verification of the closeout of ${ncr.reference}`,
      "submitted the closeout of",
    );
    const at = nowISO();
    await app.db
      .update(nonConformanceReports)
      .set({
        status: "closed",
        verifiedBy: req.user!.id,
        verifiedAt: at,
        verificationMethod: body.verificationMethod,
        updatedAt: at,
      })
      .where(eq(nonConformanceReports.id, ncrId));
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "non_conformance_report",
      objectId: ncrId,
      payload: {
        from: "verification_pending",
        to: "closed",
        verifiedBy: req.user!.id,
        closedBy: ncr.closedBy,
        verificationMethod: body.verificationMethod,
        note: body.note ?? null,
      },
      storePayload: true,
    });
    return fetchNcr(ncrId, req.companyId!, req.projectId!);
  });

  app.post("/projects/:projectId/ncrs/:ncrId/reopen", { preHandler: standardGate }, async (req) => {
    const { ncrId } = req.params as { ncrId: string };
    const body = reopenSchema.parse(req.body);
    const ncr = await fetchNcr(ncrId, req.companyId!, req.projectId!);
    if (ncr.status !== "closed" && ncr.status !== "verification_pending") {
      throw badRequest(`${ncr.reference} is ${ncr.status} and is not closed.`);
    }
    const at = nowISO();
    await app.db
      .update(nonConformanceReports)
      .set({
        status: "open",
        reopenedCount: ncr.reopenedCount + 1,
        verifiedBy: null,
        verifiedAt: null,
        closedBy: null,
        closedAt: null,
        detail: { ...(ncr.detail as Record<string, unknown>), lastReopenReason: body.reason },
        updatedAt: at,
      })
      .where(eq(nonConformanceReports.id, ncrId));
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "non_conformance_report",
      objectId: ncrId,
      payload: { from: ncr.status, to: "open", reason: body.reason, reopenedCount: ncr.reopenedCount + 1 },
      storePayload: true,
    });
    return fetchNcr(ncrId, req.companyId!, req.projectId!);
  });

  /* ---------------------------------------------------------------- */
  /* Backcharge — the commercial consequence                           */
  /* ---------------------------------------------------------------- */

  /**
   * Recover the cost from the responsible subcontractor by binding the NCR to
   * a CHANGE EVENT. The change register is where money moves on this
   * platform; quality does not keep a parallel one, so the backcharge either
   * links to an existing event or creates one whose origin is this NCR.
   */
  app.post(
    "/projects/:projectId/ncrs/:ncrId/backcharge",
    { preHandler: standardGate },
    async (req) => {
      const { ncrId } = req.params as { ncrId: string };
      const body = backchargeSchema.parse(req.body ?? {});
      const ncr = await fetchNcr(ncrId, req.companyId!, req.projectId!);
      if (!ncr.raisedAgainstVendorId) {
        throw badRequest(
          `${ncr.reference} is not raised against a vendor, so there is nobody to backcharge. Record the responsible subcontractor first.`,
        );
      }
      const amount = body.amount ?? ncr.costImpact;
      let changeEventId = body.changeEventId ?? null;

      if (changeEventId) {
        const rows = await app.db
          .select({ id: changeEvents.id, reference: changeEvents.reference })
          .from(changeEvents)
          .where(
            and(eq(changeEvents.id, changeEventId), eq(changeEvents.projectId, req.projectId!)),
          )
          .limit(1);
        if (!rows[0]) throw badRequest(`Change event ${changeEventId} not found in this project.`);
      } else {
        const number = await nextRecordNumber(app.db, req.projectId!, "change_event");
        changeEventId = newId("cev");
        await app.db.insert(changeEvents).values({
          id: changeEventId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          number,
          reference: `CE-${pad3(number)}`,
          title: `Backcharge — ${ncr.reference}: ${ncr.title}`.slice(0, 300),
          description:
            body.description ??
            `Cost recovery from the subcontractor responsible for non-conformance ${ncr.reference}. ${ncr.description}`,
          status: "open",
          eventType: "backcharge",
          scope: "in_scope",
          // CHANGE_EVENT_ORIGIN_KINDS has no "ncr" member; "inspection" is the
          // nearest true statement about where this came from, and originId
          // carries the NCR id so the provenance resolves either way.
          originType: "inspection",
          originId: ncr.id,
          roughOrderOfMagnitude: amount !== null && amount !== undefined ? round2(amount) : 0,
          scheduleImpactDays:
            body.scheduleImpactDays ??
            (ncr.scheduleImpactDays !== null ? Math.round(ncr.scheduleImpactDays) : 0),
          identifiedDate: new Date().toISOString().slice(0, 10),
          detail: { ncrId: ncr.id, ncrReference: ncr.reference, backcharge: true },
          createdBy: req.user!.id,
        });
        await ledger(app.db, {
          companyId: req.companyId!,
          projectId: req.projectId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "change_event",
          objectId: changeEventId,
          payload: { reference: `CE-${pad3(number)}`, eventType: "backcharge", ncrId: ncr.id },
          storePayload: true,
        });
      }

      const at = nowISO();
      await app.db
        .update(nonConformanceReports)
        .set({
          isBackcharged: 1,
          backchargeReference: body.backchargeReference ?? ncr.backchargeReference,
          changeEventId,
          costImpact: amount ?? ncr.costImpact,
          updatedAt: at,
        })
        .where(eq(nonConformanceReports.id, ncrId));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "non_conformance_report",
        objectId: ncrId,
        payload: {
          isBackcharged: true,
          changeEventId,
          amount: amount ?? null,
          vendorId: ncr.raisedAgainstVendorId,
        },
        storePayload: true,
      });
      const updated = await fetchNcr(ncrId, req.companyId!, req.projectId!);
      const [event] = await app.db
        .select()
        .from(changeEvents)
        .where(eq(changeEvents.id, changeEventId!));
      return {
        ...updated,
        changeEvent: event ?? null,
        reasons:
          amount === null || amount === undefined
            ? [
                "No cost impact has been recorded on this NCR, so the change event carries a rough order of magnitude of zero rather than an invented figure. Record the cost and update the event.",
              ]
            : [],
      };
    },
  );
};
