/**
 * PROGRESS DETERMINATION (spec Vol II X #995–1003).
 *
 * `POST /projects/:id/site/progress-observations` is the endpoint the whole
 * assurance thesis rests on at the site end: a claimed percentage and an
 * independently observed one, recorded as an Assertion, an Evidence row and
 * the Reconciliation between them.
 *
 * The route refuses, with the reason quoted, when:
 *   • the observer is the claimant (the different-actor rule — Vol III §4);
 *   • the observation is too weak to test the claim at all (independence
 *     below 0.35), in which case it is recorded as `insufficient_evidence`
 *     rather than as a verdict.
 *
 * A material overclaim raises a signal whose severity tracks the size of the
 * gap. Nothing here writes to a valuation or a payment: this module produces
 * the finding; the money modules decide what to do about it.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  assertions,
  evidence,
  reconciliations,
  siteProgressObservations,
  vendors,
} from "@constructos/db";
import { SITE_PROGRESS_CLAIM_SOURCES, SITE_PROGRESS_METHODS } from "@constructos/shared";
import { badRequest } from "../../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import {
  assessProgress,
  overclaimSeverity,
  SelfVerifiedProgressError,
} from "../engines/progress.js";
import { recordProgressObservation } from "../service.js";
import {
  alreadySignalled,
  assertLocation,
  assertTask,
  buildGates,
  fileIdsSchema,
  idSchema,
  isoTimestampSchema,
  ledger,
  notFoundIfMissing,
  nowISO,
  percentSchema,
  raiseSignal,
} from "../shared.js";

export const progressRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);
  const base = "/projects/:projectId/site/progress-observations";

  app.get(base, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({
        result: z.string().max(30).optional(),
        scheduleTaskId: idSchema.optional(),
        zoneName: z.string().max(200).optional(),
      })
      .parse(req.query);
    const where = and(
      eq(siteProgressObservations.companyId, req.companyId!),
      eq(siteProgressObservations.projectId, projectId),
      q.result ? eq(siteProgressObservations.result, q.result) : undefined,
      q.scheduleTaskId ? eq(siteProgressObservations.scheduleTaskId, q.scheduleTaskId) : undefined,
      q.zoneName ? eq(siteProgressObservations.zoneName, q.zoneName) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteProgressObservations).where(where).orderBy(desc(siteProgressObservations.observedAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteProgressObservations).where(where),
    ]);
    const byResult: Record<string, number> = {};
    for (const row of rows) byResult[row.result] = (byResult[row.result] ?? 0) + 1;
    return { ...paginate(rows, total?.n ?? 0, q), byResult };
  });

  app.post(base, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const companyId = req.companyId!;
    const body = z
      .object({
        zoneName: z.string().trim().min(1).max(200),
        locationId: idSchema.nullish(),
        scheduleTaskId: idSchema.nullish(),
        workPackageRef: z.string().max(200).nullish(),
        claimedPercent: percentSchema,
        observedPercent: percentSchema,
        method: z.enum(SITE_PROGRESS_METHODS).default("visual"),
        observedAt: isoTimestampSchema.optional(),
        claimSourceType: z.enum(SITE_PROGRESS_CLAIM_SOURCES).default("manual"),
        claimSourceId: idSchema.nullish(),
        claimantId: idSchema,
        claimantKind: z.enum(["user", "entity", "vendor"]).default("user"),
        claimantVendorId: idSchema.nullish(),
        claimedAt: isoTimestampSchema.nullish(),
        scanId: idSchema.nullish(),
        droneFlightId: idSchema.nullish(),
        fileIds: fileIdsSchema.default([]),
        tolerancePercent: z.number().min(0).max(50).optional(),
        notes: z.string().max(4000).nullish(),
      })
      .parse(req.body);

    if (body.locationId) await assertLocation(app.db, projectId, body.locationId);
    if (body.scheduleTaskId) await assertTask(app.db, projectId, body.scheduleTaskId);
    if (body.claimantVendorId) {
      const vendor = (
        await app.db
          .select({ id: vendors.id })
          .from(vendors)
          .where(and(eq(vendors.id, body.claimantVendorId), eq(vendors.companyId, companyId)))
          .limit(1)
      )[0];
      if (!vendor) throw badRequest(`Vendor ${body.claimantVendorId} not found in this company.`);
    }

    let assessment;
    try {
      assessment = assessProgress({
        claimedPercent: body.claimedPercent,
        observedPercent: body.observedPercent,
        method: body.method,
        claimantId: body.claimantId,
        observerId: req.user!.id,
        claimantVendorId: body.claimantVendorId ?? null,
        observerVendorId: null,
        attachmentCount: body.fileIds.length,
        hasCaptureRecord: Boolean(body.scanId || body.droneFlightId),
        ...(body.tolerancePercent === undefined ? {} : { tolerancePercent: body.tolerancePercent }),
      });
    } catch (err) {
      if (err instanceof SelfVerifiedProgressError) throw badRequest(err.message);
      throw err;
    }

    const observedAt = body.observedAt ?? nowISO();
    const saved = await recordProgressObservation(
      app.db,
      companyId,
      projectId,
      { userId: req.user!.id, vendorId: null },
      {
        zoneName: body.zoneName,
        locationId: body.locationId ?? null,
        scheduleTaskId: body.scheduleTaskId ?? null,
        workPackageRef: body.workPackageRef ?? null,
        claimedPercent: body.claimedPercent,
        observedPercent: body.observedPercent,
        method: body.method,
        observedAt,
        claimSourceType: body.claimSourceType,
        claimSourceId: body.claimSourceId ?? null,
        claimantId: body.claimantId,
        claimantKind: body.claimantKind,
        claimedAt: body.claimedAt ?? null,
        scanId: body.scanId ?? null,
        droneFlightId: body.droneFlightId ?? null,
        fileIds: body.fileIds,
        notes: body.notes ?? null,
      },
      assessment,
    );

    let signalId: string | null = null;
    if (assessment.overclaim && assessment.variancePercent >= 10) {
      const raised = await alreadySignalled(app.db, companyId, ["site_progress_overclaim"], projectId);
      const key = `progress:${saved.record.id}`;
      if (!raised.has(key)) {
        signalId = await raiseSignal(app.db, companyId, projectId, req.user!.id, {
          detector: "site_progress_overclaim",
          severity: overclaimSeverity(assessment.variancePercent),
          confidence: assessment.confidence,
          title: `${body.zoneName}: ${assessment.variancePercent} percentage points more claimed than observed`,
          explanation: `${saved.record.reference}. ${assessment.reasons.join(" ")} Evidence independence ${assessment.independenceScore}: ${assessment.independenceBasis.join(" ")}`,
          key,
          subjectType: "site_progress_observation",
          subjectId: saved.record.id,
          evidence: {
            observationId: saved.record.id,
            assertionId: saved.assertionId,
            evidenceId: saved.evidenceId,
            reconciliationId: saved.reconciliationId,
            claimedPercent: body.claimedPercent,
            observedPercent: body.observedPercent,
            claimSourceType: body.claimSourceType,
            claimSourceId: body.claimSourceId ?? null,
          },
        });
        await app.db
          .update(siteProgressObservations)
          .set({ signalId })
          .where(and(eq(siteProgressObservations.id, saved.record.id), eq(siteProgressObservations.companyId, companyId)));
      }
    }

    return reply.code(201).send({
      ...saved.record,
      signalId,
      assessment: {
        result: assessment.result,
        variancePercent: assessment.variancePercent,
        confidence: assessment.confidence,
        independenceScore: assessment.independenceScore,
        independenceBasis: assessment.independenceBasis,
        reasons: assessment.reasons,
        overclaim: assessment.overclaim,
      },
    });
  });

  app.get(`${base}/:id`, { preHandler: readGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const record = notFoundIfMissing(
      (
        await app.db
          .select()
          .from(siteProgressObservations)
          .where(
            and(
              eq(siteProgressObservations.id, id),
              eq(siteProgressObservations.companyId, companyId),
              eq(siteProgressObservations.projectId, projectId),
            ),
          )
          .limit(1)
      )[0],
      "Progress observation",
    );
    const [assertion, evidenceRow, reconciliation] = await Promise.all([
      app.db.select().from(assertions).where(and(eq(assertions.id, record.assertionId), eq(assertions.companyId, companyId))).limit(1),
      app.db.select().from(evidence).where(and(eq(evidence.id, record.evidenceId), eq(evidence.companyId, companyId))).limit(1),
      app.db.select().from(reconciliations).where(and(eq(reconciliations.id, record.reconciliationId), eq(reconciliations.companyId, companyId))).limit(1),
    ]);
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "access",
      objectType: "site_progress_observation",
      objectId: id,
      payload: { reference: record.reference },
    });
    return {
      ...record,
      assertion: assertion[0] ?? null,
      evidence: evidenceRow[0] ?? null,
      reconciliation: reconciliation[0] ?? null,
    };
  });
};
