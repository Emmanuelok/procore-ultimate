/**
 * DESIGN CHANGE NOTICES AND IMPACT ASSESSMENT
 * (spec Vol I #255; Vol II T #890–#896, #906).
 *
 * A DCN is the upstream half of change control: the thing that happens
 * BEFORE a change event costs money. What the routes here enforce:
 *
 *  - Impact is assessed per discipline and rolled up by the engine. Cost is
 *    bucketed by currency and never added across them; time is the longest
 *    single impact, not the sum.
 *  - The freeze position is stamped at submission and never recomputed: a
 *    change that was post-freeze on the day it was raised stays post-freeze
 *    even after the freeze is lifted.
 *  - The authorisation level is computed, not typed, and approval must come
 *    from someone other than the requester.
 *  - Implementation may raise a change event when the classification and
 *    originator carry entitlement — and refuses to when they do not.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { z } from "zod";
import {
  changeEvents,
  designChangeImpacts,
  designChangeNotices,
  designPackages,
} from "@constructos/db";
import {
  DCN_AUTHORISATION_LEVELS,
  DCN_CLASSIFICATIONS,
  DCN_ORIGINATORS,
  DCN_STATUSES,
  DESIGN_DISCIPLINES,
  DESIGN_STAGE_KEYS,
} from "@constructos/shared";
import { badRequest, conflict, forbidden, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { nextRecordNumber } from "../../../lib/numbering.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { pushNotifications } from "../../notifications/service.js";
import {
  DEFAULT_THRESHOLDS,
  assessEntitlement,
  authorisationRank,
  requiredAuthorisation,
  rollupImpacts,
} from "../engines/change.js";
import { freezeFor, sweepChangeFrequency } from "../service.js";
import {
  allocateReference,
  alreadySignalled,
  assertPackage,
  assertVendor,
  buildGates,
  currencySchema,
  fileIdsSchema,
  idSchema,
  isoDateSchema,
  ledger,
  loadTask,
  nowISO,
  patchSchemaOf,
  patchSet,
  raiseSignal,
} from "../shared.js";

const noticeBodySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(16_000).nullable().optional(),
  packageId: idSchema.nullable().optional(),
  stageKey: z.enum(DESIGN_STAGE_KEYS).nullable().optional(),
  discipline: z.enum(DESIGN_DISCIPLINES).default("multi_discipline"),
  classification: z.enum(DCN_CLASSIFICATIONS).default("design_change"),
  originator: z.enum(DCN_ORIGINATORS).default("client"),
  originatorVendorId: idSchema.nullable().optional(),
  scheduleTaskId: idSchema.nullable().optional(),
  decisionId: idSchema.nullable().optional(),
  issueId: idSchema.nullable().optional(),
  needByDate: isoDateSchema.nullable().optional(),
  currency: currencySchema.default("USD"),
  fileIds: fileIdsSchema.default([]),
  notes: z.string().max(8000).nullable().optional(),
});

const noticePatchSchema = patchSchemaOf(noticeBodySchema);

const impactBodySchema = z.object({
  discipline: z.enum(DESIGN_DISCIPLINES).default("multi_discipline"),
  packageId: idSchema.nullable().optional(),
  consultantId: idSchema.nullable().optional(),
  summary: z.string().min(1).max(8000),
  costImpact: z.number().nullable().optional(),
  currency: currencySchema.default("USD"),
  timeImpactDays: z.number().int().min(-3650).max(3650).nullable().optional(),
  reworkHours: z.number().min(0).max(1_000_000).nullable().optional(),
  affectedPackageIds: z.array(idSchema).max(100).default([]),
  riskNote: z.string().max(4000).nullable().optional(),
});

/** Map the DCN's classification and originator onto the change register's own
 *  reason vocabulary, so the downstream record says WHY without a new enum. */
function changeReasonFor(classification: string, originator: string): string {
  if (classification === "design_development") return "design_development";
  switch (originator) {
    case "client":
      return "client_request";
    case "designer":
      return "design_error";
    case "statutory":
      return "code_compliance";
    case "site_condition":
      return "unforeseen_condition";
    case "contractor":
      return "coordination_conflict";
    default:
      return "other";
  }
}

export const changeRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);

  async function loadNotice(companyId: string, projectId: string, id: string) {
    const [row] = await app.db
      .select()
      .from(designChangeNotices)
      .where(
        and(
          eq(designChangeNotices.id, id),
          eq(designChangeNotices.companyId, companyId),
          eq(designChangeNotices.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Design change notice not found");
    return row;
  }

  async function impactsOf(noticeId: string) {
    return app.db
      .select()
      .from(designChangeImpacts)
      .where(eq(designChangeImpacts.changeNoticeId, noticeId))
      .orderBy(asc(designChangeImpacts.assessedAt));
  }

  /** Recompute the roll-up and the required authorisation onto the row. */
  async function refreshAssessment(noticeId: string) {
    const [row] = await app.db
      .select()
      .from(designChangeNotices)
      .where(eq(designChangeNotices.id, noticeId))
      .limit(1);
    if (!row) return null;
    const impacts = await impactsOf(noticeId);
    const rollup = rollupImpacts(
      impacts.map((i) => ({
        discipline: i.discipline,
        costImpact: i.costImpact,
        currency: i.currency,
        timeImpactDays: i.timeImpactDays,
        reworkHours: i.reworkHours,
        affectedPackageIds: i.affectedPackageIds ?? [],
      })),
    );
    const freeze = {
      isPostFreeze: row.isPostFreeze === 1,
      freezeId: row.freezeId,
      requiredAuthorisation: (DCN_AUTHORISATION_LEVELS as readonly string[]).includes(row.requiredAuthorisation)
        ? (row.requiredAuthorisation as (typeof DCN_AUTHORISATION_LEVELS)[number])
        : null,
      basis: row.authorisationBasis ?? "",
    };
    const verdict = requiredAuthorisation({
      rollup,
      classification: row.classification === "design_development" ? "design_development" : "design_change",
      freeze: {
        isPostFreeze: freeze.isPostFreeze,
        freezeId: freeze.freezeId,
        requiredAuthorisation: freeze.isPostFreeze ? freeze.requiredAuthorisation : null,
        basis: freeze.basis,
      },
    });
    const primaryCurrency = rollup.currencies[0] ?? row.currency;
    await app.db
      .update(designChangeNotices)
      .set({
        assessedCost: rollup.cost,
        currency: primaryCurrency,
        assessedTimeDays: rollup.timeDays,
        assessedReworkHours: rollup.reworkHours,
        impactCount: rollup.lineCount,
        impactCurrencies: rollup.currencies,
        requiredAuthorisation: verdict.level,
        authorisationBasis: verdict.reasons.join(" "),
        updatedAt: nowISO(),
      })
      .where(eq(designChangeNotices.id, noticeId));
    return { rollup, verdict };
  }

  async function refreshPackageDcnCounts(packageId: string | null) {
    if (!packageId) return;
    const [total] = await app.db
      .select({ n: count() })
      .from(designChangeNotices)
      .where(eq(designChangeNotices.packageId, packageId));
    const [postFreeze] = await app.db
      .select({ n: count() })
      .from(designChangeNotices)
      .where(and(eq(designChangeNotices.packageId, packageId), eq(designChangeNotices.isPostFreeze, 1)));
    await app.db
      .update(designPackages)
      .set({ dcnCount: total?.n ?? 0, postFreezeDcnCount: postFreeze?.n ?? 0, updatedAt: nowISO() })
      .where(eq(designPackages.id, packageId));
  }

  /* ---------------------------------------------------------------- */
  /* Register                                                         */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/design/change-notices", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({
        status: z.enum(DCN_STATUSES).optional(),
        classification: z.enum(DCN_CLASSIFICATIONS).optional(),
        originator: z.enum(DCN_ORIGINATORS).optional(),
        packageId: idSchema.optional(),
        postFreeze: z.coerce.boolean().optional(),
        open: z.coerce.boolean().optional(),
        q: z.string().max(120).optional(),
      })
      .parse(req.query);
    const where = and(
      eq(designChangeNotices.companyId, req.companyId!),
      eq(designChangeNotices.projectId, projectId),
      q.status ? eq(designChangeNotices.status, q.status) : undefined,
      q.classification ? eq(designChangeNotices.classification, q.classification) : undefined,
      q.originator ? eq(designChangeNotices.originator, q.originator) : undefined,
      q.packageId ? eq(designChangeNotices.packageId, q.packageId) : undefined,
      q.postFreeze ? eq(designChangeNotices.isPostFreeze, 1) : undefined,
      q.open ? inArray(designChangeNotices.status, ["submitted", "assessing", "approved"]) : undefined,
      q.q
        ? or(ilike(designChangeNotices.title, `%${q.q}%`), ilike(designChangeNotices.reference, `%${q.q}%`))
        : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db
        .select()
        .from(designChangeNotices)
        .where(where)
        .orderBy(desc(designChangeNotices.number))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(designChangeNotices).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post("/projects/:projectId/design/change-notices", { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = noticeBodySchema.parse(req.body);
    const companyId = req.companyId!;
    if (body.packageId) await assertPackage(app.db, companyId, projectId, body.packageId);
    if (body.originatorVendorId) await assertVendor(app.db, companyId, body.originatorVendorId);
    if (body.scheduleTaskId) await loadTask(app.db, projectId, body.scheduleTaskId);
    const { number, reference } = await allocateReference(app.db, projectId, "design_change_notice", "DCN");
    const id = newId("dcx");
    const [inserted] = await app.db
      .insert(designChangeNotices)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        title: body.title,
        description: body.description ?? null,
        packageId: body.packageId ?? null,
        stageKey: body.stageKey ?? null,
        discipline: body.discipline,
        classification: body.classification,
        originator: body.originator,
        originatorVendorId: body.originatorVendorId ?? null,
        scheduleTaskId: body.scheduleTaskId ?? null,
        decisionId: body.decisionId ?? null,
        issueId: body.issueId ?? null,
        needByDate: body.needByDate ?? null,
        currency: body.currency,
        fileIds: body.fileIds,
        notes: body.notes ?? null,
        requestedBy: req.user!.id,
        requestedAt: nowISO(),
      })
      .returning();
    await refreshPackageDcnCounts(body.packageId ?? null);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "design_change_notice",
      objectId: id,
      payload: { reference, classification: body.classification, originator: body.originator, packageId: body.packageId ?? null },
    });
    return reply.code(201).send(inserted);
  });

  app.get("/projects/:projectId/design/change-notices/:noticeId", { preHandler: readGate }, async (req) => {
    const { projectId, noticeId } = req.params as { projectId: string; noticeId: string };
    const companyId = req.companyId!;
    const row = await loadNotice(companyId, projectId, noticeId);
    const impacts = await impactsOf(noticeId);
    const rollup = rollupImpacts(
      impacts.map((i) => ({
        discipline: i.discipline,
        costImpact: i.costImpact,
        currency: i.currency,
        timeImpactDays: i.timeImpactDays,
        reworkHours: i.reworkHours,
        affectedPackageIds: i.affectedPackageIds ?? [],
      })),
    );
    // Show the LIVE freeze position for a draft (it is still deciding) and the
    // STAMPED one for anything submitted (it is a fact about that moment).
    const live = await freezeFor(
      app.db,
      companyId,
      projectId,
      { packageId: row.packageId, stageKey: row.stageKey },
      nowISO(),
    );
    const freeze =
      row.status === "draft"
        ? live
        : {
            isPostFreeze: row.isPostFreeze === 1,
            freezeId: row.freezeId,
            requiredAuthorisation: row.isPostFreeze === 1 ? row.requiredAuthorisation : null,
            basis: row.authorisationBasis ?? "Stamped when the notice was submitted.",
          };
    const verdict = requiredAuthorisation({
      rollup,
      classification: row.classification === "design_development" ? "design_development" : "design_change",
      freeze: {
        isPostFreeze: freeze.isPostFreeze,
        freezeId: freeze.freezeId,
        requiredAuthorisation: (DCN_AUTHORISATION_LEVELS as readonly string[]).includes(
          String(freeze.requiredAuthorisation),
        )
          ? (freeze.requiredAuthorisation as (typeof DCN_AUTHORISATION_LEVELS)[number])
          : null,
        basis: freeze.basis,
      },
    });
    const entitlement = assessEntitlement({
      classification: row.classification === "design_development" ? "design_development" : "design_change",
      originator: (DCN_ORIGINATORS as readonly string[]).includes(row.originator)
        ? (row.originator as (typeof DCN_ORIGINATORS)[number])
        : "other",
      isPostFreeze: freeze.isPostFreeze,
    });
    const [pkg] = row.packageId
      ? await app.db.select().from(designPackages).where(eq(designPackages.id, row.packageId)).limit(1)
      : [];
    return {
      ...row,
      package: pkg ?? null,
      impacts,
      rollup,
      freeze,
      authorisation: verdict,
      entitlement,
      thresholds: DEFAULT_THRESHOLDS,
    };
  });

  app.patch("/projects/:projectId/design/change-notices/:noticeId", { preHandler: standardGate }, async (req) => {
    const { projectId, noticeId } = req.params as { projectId: string; noticeId: string };
    const body = noticePatchSchema.parse(req.body);
    const companyId = req.companyId!;
    const row = await loadNotice(companyId, projectId, noticeId);
    if (row.status !== "draft" && row.status !== "assessing") {
      throw conflict(
        `${row.reference} is ${row.status}. A submitted change notice is edited by withdrawing it and raising a new one, not in place.`,
      );
    }
    if (body.packageId) await assertPackage(app.db, companyId, projectId, body.packageId);
    if (body.scheduleTaskId) await loadTask(app.db, projectId, body.scheduleTaskId);
    const set = patchSet(body as Record<string, unknown>, [
      "title",
      "description",
      "packageId",
      "stageKey",
      "discipline",
      "classification",
      "originator",
      "originatorVendorId",
      "scheduleTaskId",
      "decisionId",
      "issueId",
      "needByDate",
      "currency",
      "fileIds",
      "notes",
    ]);
    const [updated] = await app.db
      .update(designChangeNotices)
      .set(set)
      .where(eq(designChangeNotices.id, noticeId))
      .returning();
    if (body.packageId !== undefined && body.packageId !== row.packageId) {
      await refreshPackageDcnCounts(row.packageId);
      await refreshPackageDcnCounts(body.packageId ?? null);
    }
    await refreshAssessment(noticeId);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "design_change_notice",
      objectId: noticeId,
      payload: { keys: Object.keys(set).filter((k) => k !== "updatedAt") },
    });
    return updated;
  });

  /* ---------------------------------------------------------------- */
  /* Impacts                                                          */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/design/change-notices/:noticeId/impacts", { preHandler: standardGate }, async (req, reply) => {
    const { projectId, noticeId } = req.params as { projectId: string; noticeId: string };
    const body = impactBodySchema.parse(req.body);
    const companyId = req.companyId!;
    const row = await loadNotice(companyId, projectId, noticeId);
    if (row.status === "approved" || row.status === "implemented" || row.status === "rejected" || row.status === "withdrawn") {
      throw conflict(
        `${row.reference} is ${row.status}; its assessed impact is now part of the record and cannot be added to.`,
      );
    }
    if (body.packageId) await assertPackage(app.db, companyId, projectId, body.packageId);
    const [existing] = await app.db
      .select({ id: designChangeImpacts.id })
      .from(designChangeImpacts)
      .where(
        and(eq(designChangeImpacts.changeNoticeId, noticeId), eq(designChangeImpacts.discipline, body.discipline)),
      )
      .limit(1);
    if (existing) {
      throw conflict(
        `${body.discipline.replace(/_/g, " ")} has already assessed this notice. Delete that assessment before replacing it, so the change of position is visible.`,
      );
    }
    const id = newId("dci");
    const [inserted] = await app.db
      .insert(designChangeImpacts)
      .values({
        id,
        companyId,
        projectId,
        changeNoticeId: noticeId,
        discipline: body.discipline,
        packageId: body.packageId ?? null,
        consultantId: body.consultantId ?? null,
        summary: body.summary,
        costImpact: body.costImpact ?? null,
        currency: body.currency,
        timeImpactDays: body.timeImpactDays ?? null,
        reworkHours: body.reworkHours ?? null,
        affectedPackageIds: body.affectedPackageIds,
        riskNote: body.riskNote ?? null,
        assessedBy: req.user!.id,
      })
      .returning();
    if (row.status === "submitted") {
      await app.db
        .update(designChangeNotices)
        .set({ status: "assessing", updatedAt: nowISO() })
        .where(eq(designChangeNotices.id, noticeId));
    }
    const refreshed = await refreshAssessment(noticeId);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "design_change_impact",
      objectId: id,
      payload: {
        changeNoticeId: noticeId,
        discipline: body.discipline,
        costImpact: body.costImpact ?? null,
        currency: body.currency,
        timeImpactDays: body.timeImpactDays ?? null,
      },
    });
    return reply.code(201).send({ ...inserted, rollup: refreshed?.rollup ?? null, authorisation: refreshed?.verdict ?? null });
  });

  app.delete(
    "/projects/:projectId/design/change-notices/:noticeId/impacts/:impactId",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, noticeId, impactId } = req.params as {
        projectId: string;
        noticeId: string;
        impactId: string;
      };
      const companyId = req.companyId!;
      const row = await loadNotice(companyId, projectId, noticeId);
      if (row.status === "approved" || row.status === "implemented") {
        throw conflict("The assessed impact of an approved change notice is part of the record.");
      }
      const [impact] = await app.db
        .select()
        .from(designChangeImpacts)
        .where(
          and(
            eq(designChangeImpacts.id, impactId),
            eq(designChangeImpacts.changeNoticeId, noticeId),
            eq(designChangeImpacts.projectId, projectId),
          ),
        )
        .limit(1);
      if (!impact) throw notFound("Impact assessment not found");
      await app.db.delete(designChangeImpacts).where(eq(designChangeImpacts.id, impactId));
      const refreshed = await refreshAssessment(noticeId);
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "delete",
        objectType: "design_change_impact",
        objectId: impactId,
        payload: { changeNoticeId: noticeId, discipline: impact.discipline },
      });
      return { deleted: impactId, rollup: refreshed?.rollup ?? null, authorisation: refreshed?.verdict ?? null };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  /** Submission stamps the freeze position — a fact about this moment. */
  app.post("/projects/:projectId/design/change-notices/:noticeId/submit", { preHandler: standardGate }, async (req) => {
    const { projectId, noticeId } = req.params as { projectId: string; noticeId: string };
    const companyId = req.companyId!;
    const row = await loadNotice(companyId, projectId, noticeId);
    if (row.status !== "draft") throw conflict(`${row.reference} has already been submitted (${row.status}).`);
    const at = nowISO();
    const freeze = await freezeFor(app.db, companyId, projectId, { packageId: row.packageId, stageKey: row.stageKey }, at);
    const impacts = await impactsOf(noticeId);
    const rollup = rollupImpacts(
      impacts.map((i) => ({
        discipline: i.discipline,
        costImpact: i.costImpact,
        currency: i.currency,
        timeImpactDays: i.timeImpactDays,
        reworkHours: i.reworkHours,
        affectedPackageIds: i.affectedPackageIds ?? [],
      })),
    );
    const verdict = requiredAuthorisation({
      rollup,
      classification: row.classification === "design_development" ? "design_development" : "design_change",
      freeze,
    });
    const [updated] = await app.db
      .update(designChangeNotices)
      .set({
        status: "submitted",
        submittedBy: req.user!.id,
        submittedAt: at,
        isPostFreeze: freeze.isPostFreeze ? 1 : 0,
        freezeId: freeze.freezeId,
        requiredAuthorisation: verdict.level,
        authorisationBasis: verdict.reasons.join(" "),
        assessedCost: rollup.cost,
        assessedTimeDays: rollup.timeDays,
        assessedReworkHours: rollup.reworkHours,
        impactCount: rollup.lineCount,
        impactCurrencies: rollup.currencies,
        updatedAt: at,
      })
      .where(eq(designChangeNotices.id, noticeId))
      .returning();
    await refreshPackageDcnCounts(row.packageId);

    let signalId: string | null = null;
    if (freeze.isPostFreeze) {
      const key = `design_post_freeze_change:${noticeId}`;
      const seen = await alreadySignalled(app.db, companyId, ["design_post_freeze_change"], projectId);
      if (!seen.has(key)) {
        signalId = await raiseSignal(app.db, companyId, projectId, req.user!.id, {
          detector: "design_post_freeze_change",
          severity: verdict.level === "board" ? "high" : "medium",
          confidence: 1,
          title: `Post-freeze design change ${row.reference}`,
          explanation: `${row.title} was submitted after a design freeze took effect. ${freeze.basis} It requires ${verdict.level.replace(/_/g, " ")} authorisation.`,
          key,
          evidence: {
            changeNoticeId: noticeId,
            reference: row.reference,
            packageId: row.packageId,
            freezeId: freeze.freezeId,
            requiredAuthorisation: verdict.level,
            assessedCost: rollup.cost,
            currencies: rollup.currencies,
          },
        });
        await app.db
          .update(designChangeNotices)
          .set({ postFreezeSignalId: signalId, updatedAt: nowISO() })
          .where(eq(designChangeNotices.id, noticeId));
      }
    }
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_change_notice",
      objectId: noticeId,
      payload: {
        to: "submitted",
        isPostFreeze: freeze.isPostFreeze,
        freezeId: freeze.freezeId,
        requiredAuthorisation: verdict.level,
      },
    });
    return { ...updated, freeze, authorisation: verdict, rollup, signalId };
  });

  /**
   * Approval. The requester may not approve; the approver must be at or above
   * the computed authorisation level, declared on the request so the record
   * says under what authority it was signed.
   */
  app.post("/projects/:projectId/design/change-notices/:noticeId/approve", { preHandler: standardGate }, async (req) => {
    const { projectId, noticeId } = req.params as { projectId: string; noticeId: string };
    const body = z
      .object({
        authorisationLevel: z.enum(DCN_AUTHORISATION_LEVELS),
        note: z.string().max(4000).optional(),
      })
      .parse(req.body);
    const companyId = req.companyId!;
    const row = await loadNotice(companyId, projectId, noticeId);
    if (row.status !== "submitted" && row.status !== "assessing") {
      throw conflict(`${row.reference} is ${row.status}; only a submitted or assessing notice can be approved.`);
    }
    if (row.requestedBy === req.user!.id) {
      throw forbidden(
        "A design change notice is approved by someone other than the person who raised it. Segregation of duties is what makes the approval mean something.",
      );
    }
    const required = (DCN_AUTHORISATION_LEVELS as readonly string[]).includes(row.requiredAuthorisation)
      ? (row.requiredAuthorisation as (typeof DCN_AUTHORISATION_LEVELS)[number])
      : "design_lead";
    if (authorisationRank(body.authorisationLevel) < authorisationRank(required)) {
      throw forbidden(
        `This change needs ${required.replace(/_/g, " ")} authorisation and you are approving at ${body.authorisationLevel.replace(/_/g, " ")} level. ${row.authorisationBasis ?? ""}`.trim(),
      );
    }
    if (row.impactCount === 0) {
      throw badRequest(
        "No discipline has assessed this change. Approving an unassessed change is approving an unknown number — record at least one impact assessment first.",
      );
    }
    const [updated] = await app.db
      .update(designChangeNotices)
      .set({ status: "approved", approvedBy: req.user!.id, approvedAt: nowISO(), updatedAt: nowISO() })
      .where(eq(designChangeNotices.id, noticeId))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_change_notice",
      objectId: noticeId,
      payload: {
        to: "approved",
        authorisationLevel: body.authorisationLevel,
        required,
        assessedCost: row.assessedCost,
        currency: row.currency,
        note: body.note ?? null,
      },
    });
    await pushNotifications(app.db, [
      {
        companyId,
        userId: row.requestedBy,
        projectId,
        kind: "design",
        title: `${row.reference} approved`,
        body: `${row.title} — approved at ${body.authorisationLevel.replace(/_/g, " ")} level.`,
        recordType: "design_change_notice",
        recordId: noticeId,
      },
    ]);
    return updated;
  });

  app.post("/projects/:projectId/design/change-notices/:noticeId/reject", { preHandler: standardGate }, async (req) => {
    const { projectId, noticeId } = req.params as { projectId: string; noticeId: string };
    const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body);
    const companyId = req.companyId!;
    const row = await loadNotice(companyId, projectId, noticeId);
    if (row.status !== "submitted" && row.status !== "assessing") {
      throw conflict(`${row.reference} is ${row.status}; only a submitted or assessing notice can be rejected.`);
    }
    if (row.requestedBy === req.user!.id) {
      throw forbidden("Withdraw your own change notice rather than rejecting it — a rejection is someone else's decision.");
    }
    const [updated] = await app.db
      .update(designChangeNotices)
      .set({ status: "rejected", rejectedBy: req.user!.id, rejectedAt: nowISO(), rejectionReason: body.reason, updatedAt: nowISO() })
      .where(eq(designChangeNotices.id, noticeId))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_change_notice",
      objectId: noticeId,
      payload: { to: "rejected", reason: body.reason },
    });
    await pushNotifications(app.db, [
      {
        companyId,
        userId: row.requestedBy,
        projectId,
        kind: "design",
        title: `${row.reference} rejected`,
        body: body.reason.slice(0, 240),
        recordType: "design_change_notice",
        recordId: noticeId,
      },
    ]);
    return updated;
  });

  app.post("/projects/:projectId/design/change-notices/:noticeId/withdraw", { preHandler: standardGate }, async (req) => {
    const { projectId, noticeId } = req.params as { projectId: string; noticeId: string };
    const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body);
    const companyId = req.companyId!;
    const row = await loadNotice(companyId, projectId, noticeId);
    if (row.status === "implemented") throw conflict("An implemented change cannot be withdrawn.");
    if (row.status === "withdrawn") throw conflict("This notice is already withdrawn.");
    const [updated] = await app.db
      .update(designChangeNotices)
      .set({ status: "withdrawn", withdrawnAt: nowISO(), withdrawnReason: body.reason, updatedAt: nowISO() })
      .where(eq(designChangeNotices.id, noticeId))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_change_notice",
      objectId: noticeId,
      payload: { to: "withdrawn", reason: body.reason },
    });
    return updated;
  });

  /**
   * Implementation. When the classification and originator carry entitlement,
   * this raises the downstream change event with the assessed exposure and
   * links the two records. When they do not, it refuses to create one and
   * says why: a designer's own error is not an owner variation.
   */
  app.post("/projects/:projectId/design/change-notices/:noticeId/implement", { preHandler: standardGate }, async (req) => {
    const { projectId, noticeId } = req.params as { projectId: string; noticeId: string };
    const body = z
      .object({
        raiseChangeEvent: z.boolean().default(true),
        note: z.string().max(4000).optional(),
      })
      .parse(req.body ?? {});
    const companyId = req.companyId!;
    const row = await loadNotice(companyId, projectId, noticeId);
    if (row.status !== "approved") {
      throw conflict(`${row.reference} is ${row.status}; only an approved change notice can be implemented.`);
    }
    const entitlement = assessEntitlement({
      classification: row.classification === "design_development" ? "design_development" : "design_change",
      originator: (DCN_ORIGINATORS as readonly string[]).includes(row.originator)
        ? (row.originator as (typeof DCN_ORIGINATORS)[number])
        : "other",
      isPostFreeze: row.isPostFreeze === 1,
    });

    let changeEventId = row.changeEventId;
    if (body.raiseChangeEvent && !changeEventId) {
      if (!entitlement.raisesChangeEvent) {
        throw badRequest(
          `A change event was requested but this notice carries no entitlement: ${entitlement.reasons.join(" ")} Implement it with raiseChangeEvent=false, or reclassify the notice if that attribution is wrong.`,
          { entitlement },
        );
      }
      if (row.impactCurrencies.length > 1) {
        throw badRequest(
          `The assessed impact spans ${row.impactCurrencies.length} currencies (${row.impactCurrencies.join(", ")}). A change event carries one currency, so the impacts must be assessed in one currency before a change event can be raised.`,
        );
      }
      const number = await nextRecordNumber(app.db, projectId, "change_event");
      changeEventId = newId("cev");
      await app.db.insert(changeEvents).values({
        id: changeEventId,
        companyId,
        projectId,
        number,
        reference: `CE-${String(number).padStart(3, "0")}`,
        title: `${row.reference} — ${row.title}`,
        description: row.description ?? null,
        status: "open",
        eventType: "design_change",
        scope: "tbd",
        reason: changeReasonFor(row.classification, row.originator),
        originType: "manual",
        originId: noticeId,
        estimatedCost: row.assessedCost ?? 0,
        latestCost: row.assessedCost ?? 0,
        scheduleImpactDays: row.assessedTimeDays ?? 0,
        identifiedDate: (row.submittedAt ?? row.createdAt).slice(0, 10),
        detail: {
          source: "design_change_notice",
          designChangeNoticeId: noticeId,
          classification: row.classification,
          originator: row.originator,
          isPostFreeze: row.isPostFreeze === 1,
          entitlement: entitlement.reasons,
          currency: row.currency,
        },
        createdBy: req.user!.id,
      });
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "create",
        objectType: "design_change_notice",
        objectId: changeEventId,
        payload: { raisedFrom: noticeId, estimatedCost: row.assessedCost, currency: row.currency },
      });
    }

    const [updated] = await app.db
      .update(designChangeNotices)
      .set({
        status: "implemented",
        implementedBy: req.user!.id,
        implementedAt: nowISO(),
        changeEventId: changeEventId ?? null,
        updatedAt: nowISO(),
      })
      .where(eq(designChangeNotices.id, noticeId))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "design_change_notice",
      objectId: noticeId,
      payload: { to: "implemented", changeEventId: changeEventId ?? null, note: body.note ?? null },
    });
    return { ...updated, entitlement, changeEventId: changeEventId ?? null };
  });

  app.post("/projects/:projectId/design/change-notices/frequency", { preHandler: standardGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    return sweepChangeFrequency(app.db, req.companyId!, projectId, req.user!.id);
  });

};
