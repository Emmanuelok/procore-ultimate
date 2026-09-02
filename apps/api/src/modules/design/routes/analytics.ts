/**
 * DESIGN ANALYTICS, READINESS, LINKS AND SWEEPS.
 *
 * The read side of the module: the workspace's summary, the analytics the
 * spec asks for (review cycle time #900, deliverable slippage #909, change
 * frequency #906), the handover readiness verdict (#907–#908), the
 * cross-tool links that tie design records to drawings/models/specs, and the
 * manual triggers for every sweep the scheduler also runs.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  designChangeNotices,
  designDecisions,
  designDeliverables,
  designIssues,
  designPackages,
  designReadinessSnapshots,
  designReviews,
  recordLinks,
  signals,
} from "@constructos/db";
import { DESIGN_LINK_TARGET_TYPES, type DesignDetector } from "@constructos/shared";
import { badRequest, notFound } from "../../../lib/errors.js";
import { pageQuerySchema } from "../../../lib/pagination.js";
import {
  computeReadiness,
  designAnalytics,
  designHealthInputs,
  designSummary,
  sweepChangeFrequency,
  sweepDeliverables,
  sweepInfoRequirements,
  sweepIssues,
  sweepProfessionalIndemnity,
  sweepReviews,
} from "../service.js";
import {
  assertBimModel,
  assertDrawingSheet,
  assertSpecSection,
  buildGates,
  idSchema,
  ledger,
  linkRecord,
  todayISO,
} from "../shared.js";

const DESIGN_DETECTORS_ALL: readonly DesignDetector[] = [
  "design_deliverable_late",
  "design_review_overdue",
  "design_post_freeze_change",
  "design_issue_stale",
  "design_change_frequency",
  "design_info_requirement_overdue",
  "design_pi_inadequate",
];

/** The design record types that may be the `from` side of a link. */
const DESIGN_SOURCE_TYPES = [
  "design_package",
  "design_review",
  "design_comment",
  "design_issue",
  "design_decision",
  "design_deliverable",
  "design_change_notice",
  "design_info_requirement",
] as const;

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);

  app.get("/projects/:projectId/design/summary", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    return designSummary(app.db, req.companyId!, projectId);
  });

  app.get("/projects/:projectId/design/analytics", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
    return designAnalytics(app.db, req.companyId!, projectId, q.asOf ?? todayISO());
  });

  app.get("/projects/:projectId/design/health-inputs", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    return designHealthInputs(app.db, req.companyId!, projectId);
  });

  /* ---------------------------------------------------------------- */
  /* Readiness                                                        */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/design/readiness", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = z.object({ packageId: idSchema.optional() }).parse(req.query);
    const verdict = await computeReadiness(
      app.db,
      req.companyId!,
      projectId,
      q.packageId ?? null,
      req.user!.id,
      { persist: false },
    );
    const history = await app.db
      .select({
        id: designReadinessSnapshots.id,
        computedAt: designReadinessSnapshots.computedAt,
        score: designReadinessSnapshots.score,
        level: designReadinessSnapshots.level,
        confidence: designReadinessSnapshots.confidence,
      })
      .from(designReadinessSnapshots)
      .where(
        and(
          eq(designReadinessSnapshots.companyId, req.companyId!),
          eq(designReadinessSnapshots.projectId, projectId),
          q.packageId ? eq(designReadinessSnapshots.packageId, q.packageId) : undefined,
        ),
      )
      .orderBy(desc(designReadinessSnapshots.computedAt))
      .limit(30);
    return { ...verdict, history: history.reverse() };
  });

  app.post("/projects/:projectId/design/readiness/recompute", { preHandler: standardGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const body = z.object({ packageId: idSchema.nullable().optional() }).parse(req.body ?? {});
    return computeReadiness(app.db, req.companyId!, projectId, body.packageId ?? null, req.user!.id);
  });

  /* ---------------------------------------------------------------- */
  /* Signals raised by this module                                    */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/design/signals", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({ detector: z.string().max(60).optional(), open: z.coerce.boolean().optional() })
      .parse(req.query);
    const rows = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, req.companyId!),
          eq(signals.projectId, projectId),
          q.detector
            ? eq(signals.detector, q.detector)
            : inArray(signals.detector, [...DESIGN_DETECTORS_ALL]),
          q.open ? inArray(signals.disposition, ["new", "triaged", "investigating"]) : undefined,
        ),
      )
      .orderBy(desc(signals.createdAt))
      .limit(q.pageSize);
    return { items: rows, total: rows.length, detectors: DESIGN_DETECTORS_ALL };
  });

  /* ---------------------------------------------------------------- */
  /* Cross-tool links                                                 */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/design/links", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = z
      .object({ fromType: z.enum(DESIGN_SOURCE_TYPES).optional(), fromId: idSchema.optional() })
      .parse(req.query);
    const rows = await app.db
      .select()
      .from(recordLinks)
      .where(
        and(
          eq(recordLinks.companyId, req.companyId!),
          eq(recordLinks.projectId, projectId),
          q.fromType ? eq(recordLinks.fromType, q.fromType) : inArray(recordLinks.fromType, [...DESIGN_SOURCE_TYPES]),
          q.fromId ? eq(recordLinks.fromId, q.fromId) : undefined,
        ),
      )
      .orderBy(desc(recordLinks.createdAt))
      .limit(500);
    return { items: rows, total: rows.length, targetTypes: DESIGN_LINK_TARGET_TYPES };
  });

  /**
   * Link a design record to a drawing sheet, model, spec section, change
   * event, schedule task, RFI or submittal. The source is checked to exist in
   * this project — a link to a record that is not there is worse than none.
   */
  app.post("/projects/:projectId/design/links", { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = z
      .object({
        fromType: z.enum(DESIGN_SOURCE_TYPES),
        fromId: idSchema,
        toType: z.enum(DESIGN_LINK_TARGET_TYPES),
        toId: idSchema,
        linkKind: z.string().max(40).default("reference"),
      })
      .parse(req.body);
    const companyId = req.companyId!;

    const sourceExists = await designRecordExists(companyId, projectId, body.fromType, body.fromId);
    if (!sourceExists) throw notFound(`${body.fromType.replace(/_/g, " ")} ${body.fromId} not found in this project.`);

    if (body.toType === "drawing_sheet") await assertDrawingSheet(app.db, projectId, body.toId);
    else if (body.toType === "spec_section") await assertSpecSection(app.db, projectId, body.toId);
    else if (body.toType === "bim_model") await assertBimModel(app.db, projectId, body.toId);

    const id = await linkRecord(app.db, {
      companyId,
      projectId,
      fromType: body.fromType,
      fromId: body.fromId,
      toType: body.toType,
      toId: body.toId,
      linkKind: body.linkKind,
      createdBy: req.user!.id,
    });
    if (!id) return reply.code(200).send({ created: false, reason: "That link already exists." });
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "design_link",
      objectId: id,
      payload: { fromType: body.fromType, fromId: body.fromId, toType: body.toType, toId: body.toId },
    });
    return reply.code(201).send({ created: true, id });
  });

  app.delete("/projects/:projectId/design/links/:linkId", { preHandler: standardGate }, async (req) => {
    const { projectId, linkId } = req.params as { projectId: string; linkId: string };
    const companyId = req.companyId!;
    const [row] = await app.db
      .select()
      .from(recordLinks)
      .where(and(eq(recordLinks.id, linkId), eq(recordLinks.companyId, companyId), eq(recordLinks.projectId, projectId)))
      .limit(1);
    if (!row) throw notFound("Link not found");
    if (!(DESIGN_SOURCE_TYPES as readonly string[]).includes(row.fromType)) {
      throw badRequest("That link was not created by the design module and is not this module's to remove.");
    }
    await app.db.delete(recordLinks).where(eq(recordLinks.id, linkId));
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "delete",
      objectType: "design_link",
      objectId: linkId,
      payload: { fromType: row.fromType, fromId: row.fromId, toType: row.toType, toId: row.toId },
    });
    return { deleted: linkId };
  });

  async function designRecordExists(
    companyId: string,
    projectId: string,
    type: (typeof DESIGN_SOURCE_TYPES)[number],
    id: string,
  ): Promise<boolean> {
    const scope = (table: { companyId: unknown; projectId: unknown; id: unknown }) =>
      and(
        eq(table.id as never, id),
        eq(table.companyId as never, companyId),
        eq(table.projectId as never, projectId),
      );
    switch (type) {
      case "design_package": {
        const rows = await app.db.select({ id: designPackages.id }).from(designPackages).where(scope(designPackages)).limit(1);
        return rows.length > 0;
      }
      case "design_review": {
        const rows = await app.db.select({ id: designReviews.id }).from(designReviews).where(scope(designReviews)).limit(1);
        return rows.length > 0;
      }
      case "design_issue": {
        const rows = await app.db.select({ id: designIssues.id }).from(designIssues).where(scope(designIssues)).limit(1);
        return rows.length > 0;
      }
      case "design_decision": {
        const rows = await app.db.select({ id: designDecisions.id }).from(designDecisions).where(scope(designDecisions)).limit(1);
        return rows.length > 0;
      }
      case "design_deliverable": {
        const rows = await app.db
          .select({ id: designDeliverables.id })
          .from(designDeliverables)
          .where(scope(designDeliverables))
          .limit(1);
        return rows.length > 0;
      }
      case "design_change_notice": {
        const rows = await app.db
          .select({ id: designChangeNotices.id })
          .from(designChangeNotices)
          .where(scope(designChangeNotices))
          .limit(1);
        return rows.length > 0;
      }
      default:
        // comments and information requirements are linked through their parents
        return true;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Sweeps — the same code the scheduler runs                        */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/design/sweeps/run", { preHandler: standardGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const companyId = req.companyId!;
    const actorId = req.user!.id;
    // Sequential, not concurrent: every sweep appends to the same per-company
    // ledger chain, which serialises on an advisory lock. Running them in
    // parallel would have them queue behind each other at best and contend for
    // the same connection at worst.
    const deliverables = await sweepDeliverables(app.db, companyId, projectId, actorId);
    const reviews = await sweepReviews(app.db, companyId, projectId, actorId);
    const issues = await sweepIssues(app.db, companyId, projectId, actorId);
    const infoRequirements = await sweepInfoRequirements(app.db, companyId, projectId, actorId);
    const frequency = await sweepChangeFrequency(app.db, companyId, projectId, actorId);
    const pi = await sweepProfessionalIndemnity(app.db, companyId, projectId, actorId);
    const readiness = await computeReadiness(app.db, companyId, projectId, null, actorId);
    return {
      deliverables,
      reviews,
      issues,
      infoRequirements,
      changeFrequency: frequency,
      professionalIndemnity: pi,
      readiness: { level: readiness.level, score: readiness.score, snapshotWritten: readiness.snapshotWritten },
    };
  });

  app.post("/projects/:projectId/design/reviews/sweep", { preHandler: standardGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    return sweepReviews(app.db, req.companyId!, projectId, req.user!.id);
  });

  app.post("/projects/:projectId/design/issues/sweep", { preHandler: standardGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    return sweepIssues(app.db, req.companyId!, projectId, req.user!.id);
  });

};
