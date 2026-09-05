/**
 * GROUND CONDITIONS AND BURIED UTILITIES (spec Vol II Z #1082–1083).
 *
 * Two registers that answer the same question — what is under the site — and
 * one comparison that turns the answer into a finding:
 *
 *   geotechnical investigations, one of which may be flagged as the BASELINE
 *   (the ground model the contract was priced on)
 *     └ ground findings: the depth intervals where what was found differs
 *       from the baseline, produced by the comparison engine, never by eye
 *   buried utility services and the strikes register, where the three
 *   controls (permit, scan, marks) are recorded for every strike so the
 *   pattern in their absence becomes visible
 */
import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  siteGeotechInvestigations,
  siteGroundFindings,
  sitePermits,
  siteUtilityServices,
  siteUtilityStrikes,
} from "@constructos/db";
import {
  SITE_GEOTECH_KINDS,
  SITE_GEOTECH_STATUSES,
  SITE_GROUND_FINDING_CATEGORIES,
  SITE_GROUND_FINDING_STATUSES,
  SITE_STRIKE_SEVERITIES,
  SITE_UTILITY_CONFIDENCES,
  SITE_UTILITY_DETECTION_METHODS,
  SITE_UTILITY_STATUSES,
  SITE_UTILITY_TYPES,
} from "@constructos/shared";
import { badRequest, conflict } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { compareGround, type Stratum } from "../engines/ground.js";
import {
  allocateReference,
  alreadySignalled,
  assertVendor,
  buildGates,
  fileIdsSchema,
  idSchema,
  isoDateSchema,
  isoTimestampSchema,
  latSchema,
  ledger,
  lonSchema,
  notFoundIfMissing,
  nowISO,
  patchSchemaOf,
  patchSet,
  raiseSignal,
  ringSchema,
} from "../shared.js";

const stratumSchema = z.object({
  fromM: z.number().min(0).max(10_000),
  toM: z.number().min(0).max(10_000),
  description: z.string().trim().min(1).max(500),
  soilType: z.string().max(120).optional(),
  spt: z.number().min(0).max(1000).optional(),
  strengthKpa: z.number().min(0).max(1_000_000).optional(),
});

const investigationBody = z.object({
  holeRef: z.string().trim().min(1).max(60),
  kind: z.enum(SITE_GEOTECH_KINDS).default("borehole"),
  isBaseline: z.boolean().default(false),
  baselineInvestigationId: idSchema.nullish(),
  contractorVendorId: idSchema.nullish(),
  investigatedOn: isoDateSchema.nullish(),
  locationDescription: z.string().max(500).nullish(),
  lat: latSchema.nullish(),
  lon: lonSchema.nullish(),
  easting: z.number().nullish(),
  northing: z.number().nullish(),
  groundLevelM: z.number().nullish(),
  depthM: z.number().min(0).max(10_000).nullish(),
  waterStrikeDepthM: z.number().min(0).max(10_000).nullish(),
  strata: z.array(stratumSchema).max(500).default([]),
  labTestRefs: z.array(z.string().trim().min(1).max(120)).max(200).default([]),
  fileIds: fileIdsSchema.default([]),
  notes: z.string().max(4000).nullish(),
});

const serviceBody = z.object({
  serviceRef: z.string().trim().min(1).max(60),
  utilityType: z.enum(SITE_UTILITY_TYPES).default("unknown"),
  ownerName: z.string().max(200).nullish(),
  specification: z.string().max(300).nullish(),
  depthM: z.number().min(0).max(500).nullish(),
  route: ringSchema.optional(),
  detectionMethod: z.enum(SITE_UTILITY_DETECTION_METHODS).default("records"),
  confidence: z.enum(SITE_UTILITY_CONFIDENCES).default("unknown"),
  surveyScanId: idSchema.nullish(),
  markedOutAt: isoTimestampSchema.nullish(),
  markedOutByName: z.string().max(200).nullish(),
  markValidUntil: isoDateSchema.nullish(),
  status: z.enum(SITE_UTILITY_STATUSES).default("unknown"),
  fileIds: fileIdsSchema.default([]),
  notes: z.string().max(2000).nullish(),
});

function validateStrata(strata: readonly z.infer<typeof stratumSchema>[]): void {
  const sorted = [...strata].sort((a, b) => a.fromM - b.fromM);
  for (const s of sorted) {
    if (s.toM <= s.fromM) {
      throw badRequest(`Stratum ${s.fromM}–${s.toM} m ends at or above where it starts.`);
    }
  }
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;
    if (current.fromM < previous.toM) {
      throw badRequest(
        `Strata overlap between ${previous.fromM}–${previous.toM} m and ${current.fromM}–${current.toM} m. A borehole log describes one material per depth.`,
      );
    }
  }
}

export const groundRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);
  const base = "/projects/:projectId/site";

  /* Investigations ------------------------------------------------- */

  app.get(`${base}/geotech`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({ status: z.enum(SITE_GEOTECH_STATUSES).optional(), isBaseline: z.coerce.boolean().optional() })
      .parse(req.query);
    const where = and(
      eq(siteGeotechInvestigations.companyId, req.companyId!),
      eq(siteGeotechInvestigations.projectId, projectId),
      q.status ? eq(siteGeotechInvestigations.status, q.status) : undefined,
      q.isBaseline !== undefined ? eq(siteGeotechInvestigations.isBaseline, q.isBaseline ? 1 : 0) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteGeotechInvestigations).where(where).orderBy(desc(siteGeotechInvestigations.createdAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteGeotechInvestigations).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/geotech`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = investigationBody.parse(req.body);
    const companyId = req.companyId!;
    validateStrata(body.strata);
    if (body.contractorVendorId) await assertVendor(app.db, companyId, body.contractorVendorId);
    const { number, reference } = await allocateReference(app.db, projectId, "site_geotech", "GI");
    const id = newId("geo");
    const [row] = await app.db
      .insert(siteGeotechInvestigations)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        holeRef: body.holeRef,
        kind: body.kind,
        status: body.strata.length > 0 ? "complete" : "planned",
        isBaseline: body.isBaseline ? 1 : 0,
        baselineInvestigationId: body.baselineInvestigationId ?? null,
        contractorVendorId: body.contractorVendorId ?? null,
        investigatedOn: body.investigatedOn ?? null,
        locationDescription: body.locationDescription ?? null,
        lat: body.lat ?? null,
        lon: body.lon ?? null,
        easting: body.easting ?? null,
        northing: body.northing ?? null,
        groundLevelM: body.groundLevelM ?? null,
        depthM: body.depthM ?? null,
        waterStrikeDepthM: body.waterStrikeDepthM ?? null,
        strata: body.strata,
        labTestRefs: body.labTestRefs,
        fileIds: body.fileIds,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_geotech_investigation",
      objectId: id,
      payload: { reference, holeRef: body.holeRef, isBaseline: body.isBaseline, strata: body.strata.length },
    });
    return reply.code(201).send(row);
  });

  app.patch(`${base}/geotech/:id`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const body = patchSchemaOf(investigationBody.omit({ holeRef: true, isBaseline: true })).parse(req.body);
    notFoundIfMissing(
      (
        await app.db
          .select({ id: siteGeotechInvestigations.id })
          .from(siteGeotechInvestigations)
          .where(
            and(
              eq(siteGeotechInvestigations.id, id),
              eq(siteGeotechInvestigations.companyId, companyId),
              eq(siteGeotechInvestigations.projectId, projectId),
            ),
          )
          .limit(1)
      )[0],
      "Geotechnical investigation",
    );
    if (body.strata) validateStrata(body.strata);
    const set = patchSet(body as Record<string, unknown>, [
      "kind",
      "baselineInvestigationId",
      "contractorVendorId",
      "investigatedOn",
      "locationDescription",
      "lat",
      "lon",
      "easting",
      "northing",
      "groundLevelM",
      "depthM",
      "waterStrikeDepthM",
      "strata",
      "labTestRefs",
      "fileIds",
      "notes",
    ]);
    if (body.strata && body.strata.length > 0) set["status"] = "complete";
    const [row] = await app.db
      .update(siteGeotechInvestigations)
      .set(set)
      .where(and(eq(siteGeotechInvestigations.id, id), eq(siteGeotechInvestigations.companyId, companyId)))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "site_geotech_investigation",
      objectId: id,
      payload: set,
    });
    return row;
  });

  /**
   * Compare an investigation against the baseline ground model and store the
   * findings. Re-running replaces the findings this comparison produced and
   * leaves any that a person has since assessed or claimed alone.
   */
  app.post(`${base}/geotech/:id/compare`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const body = z
      .object({ baselineInvestigationId: idSchema.optional(), waterToleranceM: z.number().min(0).max(50).default(1) })
      .parse(req.body ?? {});

    const observed = notFoundIfMissing(
      (
        await app.db
          .select()
          .from(siteGeotechInvestigations)
          .where(
            and(
              eq(siteGeotechInvestigations.id, id),
              eq(siteGeotechInvestigations.companyId, companyId),
              eq(siteGeotechInvestigations.projectId, projectId),
            ),
          )
          .limit(1)
      )[0],
      "Geotechnical investigation",
    );
    if (observed.isBaseline === 1) {
      throw badRequest("This investigation IS the baseline; it cannot be compared with itself.");
    }

    const baselineId = body.baselineInvestigationId ?? observed.baselineInvestigationId;
    let baseline: typeof siteGeotechInvestigations.$inferSelect | null = null;
    if (baselineId) {
      baseline =
        (
          await app.db
            .select()
            .from(siteGeotechInvestigations)
            .where(
              and(
                eq(siteGeotechInvestigations.id, baselineId),
                eq(siteGeotechInvestigations.companyId, companyId),
                eq(siteGeotechInvestigations.projectId, projectId),
              ),
            )
            .limit(1)
        )[0] ?? null;
      if (!baseline) throw badRequest(`Baseline investigation ${baselineId} not found in this project.`);
    } else {
      // Nearest baseline hole by reference, or the only one there is.
      const candidates = await app.db
        .select()
        .from(siteGeotechInvestigations)
        .where(
          and(
            eq(siteGeotechInvestigations.companyId, companyId),
            eq(siteGeotechInvestigations.projectId, projectId),
            eq(siteGeotechInvestigations.isBaseline, 1),
          ),
        )
        .limit(200);
      baseline = candidates.find((c) => c.holeRef === observed.holeRef) ?? candidates[0] ?? null;
      if (!baseline) {
        throw badRequest(
          "This project holds no baseline ground model. Flag the tender-stage investigation with `isBaseline` before comparing against it — without a baseline there is nothing for a finding to differ from.",
        );
      }
    }

    const comparison = compareGround(
      (observed.strata ?? []) as Stratum[],
      (baseline.strata ?? []) as Stratum[],
      {
        observedWaterStrikeM: observed.waterStrikeDepthM,
        baselineWaterStrikeM: baseline.waterStrikeDepthM,
        waterToleranceM: body.waterToleranceM,
      },
    );

    // Replace only the untouched findings from previous runs.
    const previous = await app.db
      .select({ id: siteGroundFindings.id, status: siteGroundFindings.status })
      .from(siteGroundFindings)
      .where(and(eq(siteGroundFindings.companyId, companyId), eq(siteGroundFindings.investigationId, id)));
    const replaceable = previous.filter((p) => p.status === "open").map((p) => p.id);
    for (const findingId of replaceable) {
      await app.db.delete(siteGroundFindings).where(and(eq(siteGroundFindings.id, findingId), eq(siteGroundFindings.companyId, companyId)));
    }

    const raised = await alreadySignalled(app.db, companyId, ["site_ground_condition_change"], projectId);
    const created: Array<typeof siteGroundFindings.$inferSelect> = [];
    let signalsRaised = 0;

    for (const finding of comparison.findings) {
      const findingId = newId("gfd");
      let signalId: string | null = null;
      if (finding.differsFromBaseline && (finding.severity === "high" || finding.severity === "critical")) {
        const key = `ground:${id}:${finding.category}:${finding.depthFromM}-${finding.depthToM}`;
        if (!raised.has(key)) {
          signalId = await raiseSignal(app.db, companyId, projectId, req.user!.id, {
            detector: "site_ground_condition_change",
            severity: finding.severity,
            confidence: 0.8,
            title: `Ground differs from the baseline at ${finding.depthFromM}–${finding.depthToM} m in ${observed.holeRef}`,
            explanation: `${finding.varianceNotes} Category: ${finding.category.replace(/_/g, " ")}. Baseline: ${baseline!.reference} (${baseline!.holeRef}).`,
            key,
            subjectType: "site_geotech_investigation",
            subjectId: id,
            evidence: {
              investigationId: id,
              baselineInvestigationId: baseline!.id,
              category: finding.category,
              depthFromM: finding.depthFromM,
              depthToM: finding.depthToM,
            },
          });
          raised.add(key);
          signalsRaised += 1;
        }
      }
      const [row] = await app.db
        .insert(siteGroundFindings)
        .values({
          id: findingId,
          companyId,
          projectId,
          investigationId: id,
          baselineInvestigationId: baseline.id,
          category: finding.category,
          severity: finding.severity,
          depthFromM: finding.depthFromM,
          depthToM: finding.depthToM,
          baselineDescription: finding.baselineDescription,
          observedDescription: finding.observedDescription,
          differsFromBaseline: finding.differsFromBaseline ? 1 : 0,
          varianceNotes: finding.varianceNotes,
          status: "open",
          signalId,
          createdBy: req.user!.id,
        })
        .returning();
      if (row) created.push(row);
    }

    await app.db
      .update(siteGeotechInvestigations)
      .set({ baselineInvestigationId: baseline.id, updatedAt: nowISO() })
      .where(and(eq(siteGeotechInvestigations.id, id), eq(siteGeotechInvestigations.companyId, companyId)));

    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_ground_finding",
      objectId: id,
      payload: {
        investigationId: id,
        baselineInvestigationId: baseline.id,
        findings: created.length,
        replaced: replaceable.length,
        signalsRaised,
      },
    });

    return {
      investigationId: id,
      baseline: { id: baseline.id, reference: baseline.reference, holeRef: baseline.holeRef },
      findings: created,
      slicesCompared: comparison.slicesCompared,
      slicesWithoutBaseline: comparison.slicesWithoutBaseline,
      maxDepthComparedM: comparison.maxDepthComparedM,
      replacedFindings: replaceable.length,
      signalsRaised,
      reasons: comparison.reasons,
    };
  });

  app.get(`${base}/ground-findings`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({
        status: z.enum(SITE_GROUND_FINDING_STATUSES).optional(),
        category: z.enum(SITE_GROUND_FINDING_CATEGORIES).optional(),
        investigationId: idSchema.optional(),
      })
      .parse(req.query);
    const where = and(
      eq(siteGroundFindings.companyId, req.companyId!),
      eq(siteGroundFindings.projectId, projectId),
      q.status ? eq(siteGroundFindings.status, q.status) : undefined,
      q.category ? eq(siteGroundFindings.category, q.category) : undefined,
      q.investigationId ? eq(siteGroundFindings.investigationId, q.investigationId) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteGroundFindings).where(where).orderBy(desc(siteGroundFindings.detectedAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteGroundFindings).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/ground-findings/:id/assess`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const body = z
      .object({
        status: z.enum(SITE_GROUND_FINDING_STATUSES),
        assessmentNotes: z.string().trim().min(1).max(4000),
        changeEventId: idSchema.nullish(),
      })
      .parse(req.body);
    const [row] = await app.db
      .update(siteGroundFindings)
      .set({
        status: body.status,
        assessmentNotes: body.assessmentNotes,
        assessedBy: req.user!.id,
        assessedAt: nowISO(),
        changeEventId: body.changeEventId ?? null,
        updatedAt: nowISO(),
      })
      .where(
        and(
          eq(siteGroundFindings.id, id),
          eq(siteGroundFindings.companyId, companyId),
          eq(siteGroundFindings.projectId, projectId),
        ),
      )
      .returning();
    if (!row) throw badRequest("Ground finding not found in this project.");
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "site_ground_finding",
      objectId: id,
      payload: { to: body.status, changeEventId: body.changeEventId ?? null },
    });
    return row;
  });

  /* Utilities ------------------------------------------------------ */

  app.get(`${base}/utilities`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({ utilityType: z.enum(SITE_UTILITY_TYPES).optional(), status: z.enum(SITE_UTILITY_STATUSES).optional() })
      .parse(req.query);
    const where = and(
      eq(siteUtilityServices.companyId, req.companyId!),
      eq(siteUtilityServices.projectId, projectId),
      q.utilityType ? eq(siteUtilityServices.utilityType, q.utilityType) : undefined,
      q.status ? eq(siteUtilityServices.status, q.status) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteUtilityServices).where(where).orderBy(desc(siteUtilityServices.createdAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteUtilityServices).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post(`${base}/utilities`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = serviceBody.parse(req.body);
    const companyId = req.companyId!;
    const clash = (
      await app.db
        .select({ id: siteUtilityServices.id })
        .from(siteUtilityServices)
        .where(and(eq(siteUtilityServices.projectId, projectId), eq(siteUtilityServices.serviceRef, body.serviceRef)))
        .limit(1)
    )[0];
    if (clash) throw conflict(`Service reference ${body.serviceRef} already exists on this project.`);
    if (body.confidence === "verified" && !body.surveyScanId && body.detectionMethod === "records") {
      throw badRequest(
        "A service cannot be recorded as verified on the strength of records alone. Link the survey that verified it, or lower the confidence to `probable`.",
      );
    }
    const id = newId("uts");
    const [row] = await app.db
      .insert(siteUtilityServices)
      .values({
        id,
        companyId,
        projectId,
        serviceRef: body.serviceRef,
        utilityType: body.utilityType,
        ownerName: body.ownerName ?? null,
        specification: body.specification ?? null,
        depthM: body.depthM ?? null,
        route: body.route ?? [],
        detectionMethod: body.detectionMethod,
        confidence: body.confidence,
        surveyScanId: body.surveyScanId ?? null,
        markedOutAt: body.markedOutAt ?? null,
        markedOutByName: body.markedOutByName ?? null,
        markValidUntil: body.markValidUntil ?? null,
        status: body.status,
        fileIds: body.fileIds,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_utility_service",
      objectId: id,
      payload: { serviceRef: body.serviceRef, utilityType: body.utilityType, confidence: body.confidence },
    });
    return reply.code(201).send(row);
  });

  app.patch(`${base}/utilities/:id`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const body = patchSchemaOf(serviceBody.omit({ serviceRef: true })).parse(req.body);
    const existing = notFoundIfMissing(
      (
        await app.db
          .select()
          .from(siteUtilityServices)
          .where(and(eq(siteUtilityServices.id, id), eq(siteUtilityServices.companyId, companyId), eq(siteUtilityServices.projectId, projectId)))
          .limit(1)
      )[0],
      "Utility service",
    );
    // The same rule the create route enforces, applied to what the record
    // WOULD hold after this patch — otherwise "verified" is reachable in two
    // calls instead of one, which is no rule at all.
    const merged = {
      confidence: body.confidence ?? existing.confidence,
      surveyScanId: body.surveyScanId === undefined ? existing.surveyScanId : body.surveyScanId,
      detectionMethod: body.detectionMethod ?? existing.detectionMethod,
    };
    if (merged.confidence === "verified" && !merged.surveyScanId && merged.detectionMethod === "records") {
      throw badRequest(
        "A service cannot be recorded as verified on the strength of records alone. Link the survey that verified it, or lower the confidence to `probable`.",
      );
    }
    const set = patchSet(body as Record<string, unknown>, [
      "utilityType",
      "ownerName",
      "specification",
      "depthM",
      "route",
      "detectionMethod",
      "confidence",
      "surveyScanId",
      "markedOutAt",
      "markedOutByName",
      "markValidUntil",
      "status",
      "fileIds",
      "notes",
    ]);
    const [row] = await app.db
      .update(siteUtilityServices)
      .set(set)
      .where(and(eq(siteUtilityServices.id, id), eq(siteUtilityServices.companyId, companyId)))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "site_utility_service",
      objectId: id,
      payload: set,
    });
    return row;
  });

  /* Strikes -------------------------------------------------------- */

  app.get(`${base}/strikes`, { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema
      .extend({ severity: z.enum(SITE_STRIKE_SEVERITIES).optional(), status: z.string().max(20).optional() })
      .parse(req.query);
    const where = and(
      eq(siteUtilityStrikes.companyId, req.companyId!),
      eq(siteUtilityStrikes.projectId, projectId),
      q.severity ? eq(siteUtilityStrikes.severity, q.severity) : undefined,
      q.status ? eq(siteUtilityStrikes.status, q.status) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db.select().from(siteUtilityStrikes).where(where).orderBy(desc(siteUtilityStrikes.occurredAt)).limit(q.pageSize).offset(pageOffset(q)),
      app.db.select({ n: count() }).from(siteUtilityStrikes).where(where),
    ]);
    const controls = {
      total: rows.length,
      withPermit: rows.filter((r) => r.permitInPlace === 1).length,
      withScan: rows.filter((r) => r.scanCompleted === 1).length,
      withMarks: rows.filter((r) => r.marksPresent === 1).length,
    };
    return { ...paginate(rows, total?.n ?? 0, q), controls };
  });

  app.post(`${base}/strikes`, { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const companyId = req.companyId!;
    const body = z
      .object({
        occurredAt: isoTimestampSchema,
        utilityType: z.enum(SITE_UTILITY_TYPES).default("unknown"),
        serviceId: idSchema.nullish(),
        permitId: idSchema.nullish(),
        severity: z.enum(SITE_STRIKE_SEVERITIES).default("near_miss"),
        locationDescription: z.string().max(500).nullish(),
        lat: latSchema.nullish(),
        lon: lonSchema.nullish(),
        depthM: z.number().min(0).max(500).nullish(),
        injuries: z.number().int().min(0).max(1000).default(0),
        servicesLost: z.string().max(500).nullish(),
        contractorVendorId: idSchema.nullish(),
        operativeName: z.string().max(200).nullish(),
        plantType: z.string().max(200).nullish(),
        permitInPlace: z.boolean().default(false),
        scanCompleted: z.boolean().default(false),
        marksPresent: z.boolean().default(false),
        rootCause: z.string().max(2000).nullish(),
        immediateActions: z.string().max(2000).nullish(),
        reportedToOwnerAt: isoTimestampSchema.nullish(),
        costEstimate: z.number().min(0).nullish(),
        currency: z.string().length(3).default("USD"),
        incidentId: idSchema.nullish(),
        fileIds: fileIdsSchema.default([]),
        notes: z.string().max(4000).nullish(),
      })
      .parse(req.body);
    if (body.contractorVendorId) await assertVendor(app.db, companyId, body.contractorVendorId);
    if (body.permitId) {
      const permit = (
        await app.db
          .select({ id: sitePermits.id })
          .from(sitePermits)
          .where(and(eq(sitePermits.id, body.permitId), eq(sitePermits.companyId, companyId), eq(sitePermits.projectId, projectId)))
          .limit(1)
      )[0];
      if (!permit) throw badRequest(`Permit ${body.permitId} not found in this project.`);
    }

    const { number, reference } = await allocateReference(app.db, projectId, "site_utility_strike", "STR");
    const id = newId("str");

    const missing = [
      body.permitInPlace ? null : "no permit to work was in place",
      body.scanCompleted ? null : "no utility survey had been carried out",
      body.marksPresent ? null : "no marks were present on the ground",
    ].filter((x): x is string => Boolean(x));

    const severity =
      body.severity === "major" || body.injuries > 0
        ? "critical"
        : body.severity === "significant"
          ? "high"
          : missing.length >= 2
            ? "high"
            : "medium";

    const raised = await alreadySignalled(app.db, companyId, ["site_utility_strike"], projectId);
    const key = `strike:${id}`;
    const signalId = raised.has(key)
      ? null
      : await raiseSignal(app.db, companyId, projectId, req.user!.id, {
          detector: "site_utility_strike",
          severity,
          confidence: 1,
          title: `${body.severity.replace(/_/g, " ")} utility strike ${reference} (${body.utilityType})`,
          explanation: `A ${body.utilityType} service was struck at ${body.occurredAt}${body.locationDescription ? ` (${body.locationDescription})` : ""}. ${
            missing.length === 0
              ? "All three controls — permit, survey and marks — were in place; the investigation should establish how the strike still happened."
              : `Controls missing: ${missing.join("; ")}.`
          }${body.injuries > 0 ? ` ${body.injuries} injury/injuries reported.` : ""}`,
          key,
          subjectType: "site_utility_strike",
          subjectId: id,
          evidence: {
            strikeId: id,
            reference,
            utilityType: body.utilityType,
            permitInPlace: body.permitInPlace,
            scanCompleted: body.scanCompleted,
            marksPresent: body.marksPresent,
            injuries: body.injuries,
          },
        });

    const [row] = await app.db
      .insert(siteUtilityStrikes)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        occurredAt: body.occurredAt,
        utilityType: body.utilityType,
        serviceId: body.serviceId ?? null,
        permitId: body.permitId ?? null,
        severity: body.severity,
        status: "reported",
        locationDescription: body.locationDescription ?? null,
        lat: body.lat ?? null,
        lon: body.lon ?? null,
        depthM: body.depthM ?? null,
        injuries: body.injuries,
        servicesLost: body.servicesLost ?? null,
        contractorVendorId: body.contractorVendorId ?? null,
        operativeName: body.operativeName ?? null,
        plantType: body.plantType ?? null,
        permitInPlace: body.permitInPlace ? 1 : 0,
        scanCompleted: body.scanCompleted ? 1 : 0,
        marksPresent: body.marksPresent ? 1 : 0,
        rootCause: body.rootCause ?? null,
        immediateActions: body.immediateActions ?? null,
        reportedToOwnerAt: body.reportedToOwnerAt ?? null,
        costEstimate: body.costEstimate ?? null,
        currency: body.currency,
        incidentId: body.incidentId ?? null,
        signalId,
        fileIds: body.fileIds,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "site_utility_strike",
      objectId: id,
      payload: { reference, utilityType: body.utilityType, severity: body.severity, controlsMissing: missing },
    });
    return reply.code(201).send({ ...row, controlsMissing: missing, signalSeverity: severity });
  });

  app.post(`${base}/strikes/:id/close`, { preHandler: standardGate }, async (req) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const companyId = req.companyId!;
    const body = z
      .object({ rootCause: z.string().trim().min(1).max(2000), immediateActions: z.string().max(2000).nullish() })
      .parse(req.body);
    const [row] = await app.db
      .update(siteUtilityStrikes)
      .set({
        status: "closed",
        rootCause: body.rootCause,
        immediateActions: body.immediateActions ?? null,
        closedAt: nowISO(),
        closedBy: req.user!.id,
        updatedAt: nowISO(),
      })
      .where(
        and(
          eq(siteUtilityStrikes.id, id),
          eq(siteUtilityStrikes.companyId, companyId),
          eq(siteUtilityStrikes.projectId, projectId),
        ),
      )
      .returning();
    if (!row) throw badRequest("Strike not found in this project.");
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "site_utility_strike",
      objectId: id,
      payload: { to: "closed", rootCause: body.rootCause },
    });
    return row;
  });
};
