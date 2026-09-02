/**
 * Concrete pour records and cube/cylinder statistics (#1085–1086).
 *
 * A pour is irreversible. Everything anybody will ever ask about it — which
 * mix, from which plant, on which delivery tickets, at what slump and what
 * temperature, cured how, released by whom — is knowable for about two hours
 * and then only from the record. So the record is made BEFORE the truck
 * arrives (the plan), completed AT the pour (tickets, fresh tests, specimens)
 * and judged WEEKS later (the crush results), and this file keeps all three
 * against one row.
 *
 * Two refusals:
 *
 *  1. A pour whose pre-pour hold point has not been released cannot be
 *     recorded as poured. The whole purpose of a pre-pour inspection is that
 *     the steel is checked while it can still be seen; a system that lets the
 *     pour be booked in over an unreleased hold point has quietly deleted the
 *     control.
 *  2. Acceptance is computed by ./concreteStats.ts against the code the pour
 *     names, never typed in. A failing set raises a non-conformance, because
 *     concrete that did not make its strength is not a paperwork problem.
 */

import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray } from "drizzle-orm";
import { z } from "zod";
import { concretePours, concreteTestSpecimens, itpActivities } from "@constructos/db";
import {
  CONCRETE_ACCEPTANCE_CODES,
  POUR_STATUSES,
  SPECIMEN_RESULTS,
  SPECIMEN_TYPES,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import {
  allocateReference,
  alreadySignalled,
  assertLocation,
  assertVendor,
  buildGates,
  fileIdsSchema,
  idSchema,
  isoDateSchema,
  isoTimestampSchema,
  ledger,
  nowISO,
  patchSet,
  QUALITY_DETECTORS,
  raiseSignal,
  round2,
  todayISO,
} from "./shared.js";
import { assessPour, slumpVerdict, type SpecimenLike } from "./concreteStats.js";
import { createNcr } from "./raise.js";
import { isTerminalActivityStatus } from "./holdPoints.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const ticketSchema = z.object({
  ticketNumber: z.string().min(1).max(100),
  batchedAt: isoTimestampSchema.nullable().optional(),
  volumeM3: z.number().finite().nullable().optional(),
  batchNumber: z.string().max(100).nullable().optional(),
  truck: z.string().max(100).nullable().optional(),
});

const pourCreateSchema = z.object({
  pourName: z.string().min(1).max(300),
  elementType: z.string().max(200).nullable().optional(),
  locationId: idSchema.nullable().optional(),
  locationText: z.string().max(500).nullable().optional(),
  drawingSheetId: idSchema.nullable().optional(),
  drawingReference: z.string().max(200).nullable().optional(),
  plannedDate: isoDateSchema.nullable().optional(),
  mixReference: z.string().max(200).nullable().optional(),
  specifiedGrade: z.string().max(100).nullable().optional(),
  specifiedStrengthMpa: z.number().finite().positive().nullable().optional(),
  testAgeDays: z.number().int().min(1).max(365).optional(),
  acceptanceCode: z.enum(CONCRETE_ACCEPTANCE_CODES).optional(),
  volumeM3: z.number().finite().nonnegative().nullable().optional(),
  supplierVendorId: idSchema.nullable().optional(),
  batchPlant: z.string().max(200).nullable().optional(),
  slumpSpecMin: z.number().finite().nullable().optional(),
  slumpSpecMax: z.number().finite().nullable().optional(),
  curingMethod: z.string().max(200).nullable().optional(),
  itpActivityId: idSchema.nullable().optional(),
  prePourChecklistId: idSchema.nullable().optional(),
  pouredByVendorId: idSchema.nullable().optional(),
  supervisedBy: idSchema.nullable().optional(),
  materialCertificateIds: z.array(idSchema).max(100).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const pourPatchSchema = pourCreateSchema.partial();

const recordPourSchema = z.object({
  pouredAt: isoTimestampSchema.optional(),
  volumeM3: z.number().finite().nonnegative().nullable().optional(),
  deliveryTickets: z.array(ticketSchema).max(200).optional(),
  batchNumbers: z.array(z.string().min(1).max(100)).max(200).optional(),
  slumpMm: z.number().finite().nullable().optional(),
  airContentPct: z.number().finite().nullable().optional(),
  concreteTempC: z.number().finite().nullable().optional(),
  ambientTempC: z.number().finite().nullable().optional(),
  curingMethod: z.string().max(200).nullable().optional(),
  curingStartedAt: isoTimestampSchema.nullable().optional(),
  photoFileIds: fileIdsSchema.optional(),
  /** acknowledge a pour going ahead without the hold point released */
  proceedWithoutRelease: z.boolean().optional(),
  proceedReason: z.string().max(4000).nullable().optional(),
});

const specimenCreateSchema = z.object({
  specimenRef: z.string().min(1).max(100),
  specimenType: z.enum(SPECIMEN_TYPES).optional(),
  castAt: isoDateSchema.nullable().optional(),
  testAgeDays: z.number().int().min(1).max(365).optional(),
  labName: z.string().max(200).nullable().optional(),
  labAccreditation: z.string().max(200).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

const specimenResultSchema = z.object({
  strengthMpa: z.number().finite().nonnegative().nullable().optional(),
  densityKgM3: z.number().finite().nullable().optional(),
  testDate: isoDateSchema.nullable().optional(),
  result: z.enum(SPECIMEN_RESULTS).optional(),
  failureMode: z.string().max(200).nullable().optional(),
  certificateNumber: z.string().max(200).nullable().optional(),
  certificateFileId: idSchema.nullable().optional(),
  labName: z.string().max(200).nullable().optional(),
  voidReason: z.string().max(2000).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

const pourListQuery = pageQuerySchema.extend({
  status: z.enum(POUR_STATUSES).optional(),
  supplierVendorId: idSchema.optional(),
  locationId: idSchema.optional(),
  verdict: z.enum(["accepted", "rejected", "inconclusive", "not_assessable"]).optional(),
  search: z.string().max(200).optional(),
});

const POUR_PATCH_COLUMNS = [
  "pourName",
  "elementType",
  "locationId",
  "locationText",
  "drawingSheetId",
  "drawingReference",
  "plannedDate",
  "mixReference",
  "specifiedGrade",
  "specifiedStrengthMpa",
  "testAgeDays",
  "acceptanceCode",
  "volumeM3",
  "supplierVendorId",
  "batchPlant",
  "slumpSpecMin",
  "slumpSpecMax",
  "curingMethod",
  "itpActivityId",
  "prePourChecklistId",
  "pouredByVendorId",
  "supervisedBy",
  "materialCertificateIds",
  "detail",
] as const;

const asSpecimen = (row: typeof concreteTestSpecimens.$inferSelect): SpecimenLike => ({
  id: row.id,
  specimenRef: row.specimenRef,
  specimenType: row.specimenType,
  testAgeDays: row.testAgeDays,
  testDate: row.testDate,
  strengthMpa: row.strengthMpa,
  result: row.result,
});

/* ------------------------------------------------------------------ */
/* Assessment + persistence                                            */
/* ------------------------------------------------------------------ */

/**
 * Re-judge a pour from its specimens and store the verdict. Called after every
 * specimen result so the register is never stale, and by the explicit
 * `/assess` route.
 *
 * `priorResults` are the tested strengths of OTHER pours of the same mix on
 * the project: the codes that allow a standard-deviation rule mean the
 * production run, not this one pour, and using only this pour's three cubes
 * would apply the continuous-production rule to a sample that cannot support
 * it.
 */
export async function assessAndPersist(
  db: Db,
  pour: typeof concretePours.$inferSelect,
): Promise<ReturnType<typeof assessPour>> {
  const specimens = await db
    .select()
    .from(concreteTestSpecimens)
    .where(eq(concreteTestSpecimens.pourId, pour.id));
  const priorRows = pour.mixReference
    ? await db
        .select({
          strengthMpa: concreteTestSpecimens.strengthMpa,
          result: concreteTestSpecimens.result,
          pourId: concreteTestSpecimens.pourId,
        })
        .from(concreteTestSpecimens)
        .innerJoin(concretePours, eq(concreteTestSpecimens.pourId, concretePours.id))
        .where(
          and(
            eq(concretePours.projectId, pour.projectId),
            eq(concretePours.mixReference, pour.mixReference),
          ),
        )
    : [];
  const prior = priorRows
    .filter((r) => r.pourId !== pour.id && r.result !== "void" && typeof r.strengthMpa === "number")
    .map((r) => r.strengthMpa as number);

  const assessment = assessPour(
    {
      specifiedStrengthMpa: pour.specifiedStrengthMpa,
      testAgeDays: pour.testAgeDays,
      acceptanceCode: pour.acceptanceCode,
      priorResults: prior,
    },
    specimens.map(asSpecimen),
  );
  const stats = assessment.statistics;
  await db
    .update(concretePours)
    .set({
      specimenCount: specimens.length,
      testedSpecimenCount: stats.testedCount,
      failedSpecimenCount: specimens.filter((s) => s.result === "fail").length,
      meanStrengthMpa: stats.mean,
      minStrengthMpa: stats.min,
      standardDeviationMpa: stats.standardDeviation,
      acceptanceVerdict: assessment.verdict,
      acceptanceReasons: assessment.reasons,
      status:
        assessment.verdict === "accepted"
          ? "accepted"
          : assessment.verdict === "rejected"
            ? "rejected"
            : pour.status === "poured" || pour.status === "curing"
              ? "testing"
              : pour.status,
      updatedAt: nowISO(),
    })
    .where(eq(concretePours.id, pour.id));
  return assessment;
}

/** One signal per failing pour, keyed on the pour id. */
async function signalFailedPour(
  db: Db,
  pour: typeof concretePours.$inferSelect,
  assessment: ReturnType<typeof assessPour>,
  actorId: string | null,
): Promise<string | null> {
  const seen = await alreadySignalled(db, pour.companyId, QUALITY_DETECTORS.concreteAcceptanceFailed);
  if (seen.has(pour.id)) return null;
  return raiseSignal(db, pour.companyId, pour.projectId, actorId, {
    detector: QUALITY_DETECTORS.concreteAcceptanceFailed,
    severity: "critical",
    confidence: 1,
    title: `Concrete pour ${pour.reference} failed its acceptance criteria — ${pour.pourName}`,
    explanation:
      `${pour.reference} "${pour.pourName}"${pour.specifiedGrade ? ` (${pour.specifiedGrade})` : ""} does not satisfy ${assessment.code.replace(/_/g, " ")}. ` +
      `${assessment.checks.map((c) => `${c.name}: ${c.observed} against ${c.requirement}`).join("; ")}. ` +
      `Concrete that did not make its strength is a structural question, not a paperwork one: the element it is in has to be assessed, ` +
      `and the assessment is a designer's decision recorded against a concession, not a site decision to carry on. ` +
      `Core testing, load testing, strengthening and removal are the options, in that order of cost.`,
    key: pour.id,
    evidence: {
      pourId: pour.id,
      reference: pour.reference,
      grade: pour.specifiedGrade,
      specifiedStrengthMpa: pour.specifiedStrengthMpa,
      meanStrengthMpa: assessment.statistics.mean,
      minStrengthMpa: assessment.statistics.min,
      code: assessment.code,
      checks: assessment.checks,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const concreteRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);

  async function fetchPour(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(concretePours)
      .where(
        and(
          eq(concretePours.id, id),
          eq(concretePours.companyId, companyId),
          eq(concretePours.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Concrete pour not found");
    return rows[0];
  }

  async function specimensOf(pourId: string) {
    return app.db
      .select()
      .from(concreteTestSpecimens)
      .where(eq(concreteTestSpecimens.pourId, pourId))
      .orderBy(asc(concreteTestSpecimens.specimenRef));
  }

  async function detail(pour: typeof concretePours.$inferSelect) {
    const specimens = await specimensOf(pour.id);
    const assessment = assessPour(
      {
        specifiedStrengthMpa: pour.specifiedStrengthMpa,
        testAgeDays: pour.testAgeDays,
        acceptanceCode: pour.acceptanceCode,
      },
      specimens.map(asSpecimen),
    );
    return {
      ...pour,
      specimens,
      assessment,
      slump: slumpVerdict(pour.slumpMm, pour.slumpSpecMin, pour.slumpSpecMax),
    };
  }

  app.post("/projects/:projectId/concrete-pours", { preHandler: standardGate }, async (req, reply) => {
    const body = pourCreateSchema.parse(req.body);
    if (body.supplierVendorId) await assertVendor(app.db, req.companyId!, body.supplierVendorId);
    if (body.pouredByVendorId) await assertVendor(app.db, req.companyId!, body.pouredByVendorId);
    if (body.locationId) await assertLocation(app.db, req.projectId!, body.locationId);
    const { number, reference } = await allocateReference(app.db, req.projectId!, "concrete_pour", "POUR");
    const id = newId("pour");
    const [created] = await app.db
      .insert(concretePours)
      .values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        reference,
        pourName: body.pourName,
        elementType: body.elementType ?? null,
        locationId: body.locationId ?? null,
        locationText: body.locationText ?? null,
        drawingSheetId: body.drawingSheetId ?? null,
        drawingReference: body.drawingReference ?? null,
        plannedDate: body.plannedDate ?? null,
        mixReference: body.mixReference ?? null,
        specifiedGrade: body.specifiedGrade ?? null,
        specifiedStrengthMpa: body.specifiedStrengthMpa ?? null,
        testAgeDays: body.testAgeDays ?? 28,
        acceptanceCode: body.acceptanceCode ?? "specified_only",
        volumeM3: body.volumeM3 ?? null,
        supplierVendorId: body.supplierVendorId ?? null,
        batchPlant: body.batchPlant ?? null,
        slumpSpecMin: body.slumpSpecMin ?? null,
        slumpSpecMax: body.slumpSpecMax ?? null,
        curingMethod: body.curingMethod ?? null,
        itpActivityId: body.itpActivityId ?? null,
        prePourChecklistId: body.prePourChecklistId ?? null,
        pouredByVendorId: body.pouredByVendorId ?? null,
        supervisedBy: body.supervisedBy ?? null,
        materialCertificateIds: body.materialCertificateIds ?? [],
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "concrete_pour",
      objectId: id,
      payload: created,
      storePayload: true,
    });
    return reply.status(201).send(await detail(created!));
  });

  app.get("/projects/:projectId/concrete-pours", { preHandler: readGate }, async (req) => {
    const q = pourListQuery.parse(req.query);
    const clauses = [
      eq(concretePours.companyId, req.companyId!),
      eq(concretePours.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(concretePours.status, q.status));
    if (q.supplierVendorId) clauses.push(eq(concretePours.supplierVendorId, q.supplierVendorId));
    if (q.locationId) clauses.push(eq(concretePours.locationId, q.locationId));
    if (q.verdict) clauses.push(eq(concretePours.acceptanceVerdict, q.verdict));
    if (q.search) clauses.push(ilike(concretePours.pourName, `%${q.search}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(concretePours).where(where);
    const rows = await app.db
      .select()
      .from(concretePours)
      .where(where)
      .orderBy(desc(concretePours.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/concrete-pours/:id", { preHandler: readGate }, async (req) => {
    const { id } = req.params as { id: string };
    return detail(await fetchPour(id, req.companyId!, req.projectId!));
  });

  app.patch("/projects/:projectId/concrete-pours/:id", { preHandler: standardGate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = pourPatchSchema.parse(req.body);
    const pour = await fetchPour(id, req.companyId!, req.projectId!);
    if (pour.status === "accepted" || pour.status === "rejected") {
      throw badRequest(
        `${pour.reference} is ${pour.status}; the mix and the criteria a verdict was reached against are not edited afterwards.`,
      );
    }
    if (body.supplierVendorId) await assertVendor(app.db, req.companyId!, body.supplierVendorId);
    if (body.locationId) await assertLocation(app.db, req.projectId!, body.locationId);
    await app.db
      .update(concretePours)
      .set(patchSet(body as Record<string, unknown>, POUR_PATCH_COLUMNS))
      .where(eq(concretePours.id, id));
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "concrete_pour",
      objectId: id,
      payload: { changed: Object.keys(body) },
    });
    return detail(await fetchPour(id, req.companyId!, req.projectId!));
  });

  /**
   * Record the pour itself. Refuses over an unreleased pre-pour hold point
   * unless the caller states, in writing, that it went ahead anyway — which is
   * a fact worth having on the record rather than one worth hiding.
   */
  app.post(
    "/projects/:projectId/concrete-pours/:id/pour",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = recordPourSchema.parse(req.body ?? {});
      const pour = await fetchPour(id, req.companyId!, req.projectId!);
      if (pour.pouredAt) {
        throw conflict(
          `${pour.reference} is already recorded as poured at ${pour.pouredAt}. A second pour of the same element is a different pour record.`,
        );
      }
      let holdPointReleasedAt: string | null = null;
      let holdPointReleasedBy: string | null = null;
      if (pour.itpActivityId) {
        const rows = await app.db
          .select()
          .from(itpActivities)
          .where(
            and(
              eq(itpActivities.id, pour.itpActivityId),
              eq(itpActivities.projectId, req.projectId!),
            ),
          )
          .limit(1);
        const activity = rows[0];
        if (!activity) {
          throw badRequest(
            `The pre-pour hold point ${pour.itpActivityId} named on ${pour.reference} does not exist on this project.`,
          );
        }
        const released = activity.status === "released" || activity.status === "waived";
        if (!released && body.proceedWithoutRelease !== true) {
          throw badRequest(
            `${pour.reference} cannot be recorded as poured: its pre-pour hold point "${activity.activity}" is ${activity.status}. ` +
              `The point of a pre-pour inspection is that the reinforcement is checked while it can still be seen. ` +
              `Release the hold point, or re-send with proceedWithoutRelease: true and a reason — a pour that went ahead over an unreleased ` +
              `hold point is a fact the record should carry, not one it should hide.`,
          );
        }
        if (!released && !body.proceedReason) {
          throw badRequest(
            "A pour recorded over an unreleased hold point must state why it went ahead. The reason is the only thing that distinguishes an authorised departure from a concealed one.",
          );
        }
        holdPointReleasedAt = activity.releasedAt;
        holdPointReleasedBy = activity.releasedBy;
        if (!isTerminalActivityStatus(activity.status)) {
          await app.db
            .update(itpActivities)
            .set({ actualDate: todayISO(), updatedAt: nowISO() })
            .where(eq(itpActivities.id, activity.id));
        }
      }
      const at = body.pouredAt ?? nowISO();
      const tickets = body.deliveryTickets ?? (pour.deliveryTickets as unknown[]);
      const ticketVolume = (tickets as Array<{ volumeM3?: number | null }>).reduce(
        (sum, t) => sum + (typeof t?.volumeM3 === "number" ? t.volumeM3 : 0),
        0,
      );
      await app.db
        .update(concretePours)
        .set({
          status: "poured",
          pouredAt: at,
          volumeM3: body.volumeM3 ?? (ticketVolume > 0 ? round2(ticketVolume) : pour.volumeM3),
          deliveryTickets: tickets,
          batchNumbers: body.batchNumbers ?? pour.batchNumbers,
          slumpMm: body.slumpMm ?? pour.slumpMm,
          airContentPct: body.airContentPct ?? pour.airContentPct,
          concreteTempC: body.concreteTempC ?? pour.concreteTempC,
          ambientTempC: body.ambientTempC ?? pour.ambientTempC,
          curingMethod: body.curingMethod ?? pour.curingMethod,
          curingStartedAt: body.curingStartedAt ?? at,
          holdPointReleasedAt,
          holdPointReleasedBy,
          photoFileIds: body.photoFileIds ?? pour.photoFileIds,
          detail: {
            ...(pour.detail as Record<string, unknown>),
            ...(body.proceedWithoutRelease
              ? { pouredWithoutRelease: true, proceedReason: body.proceedReason ?? null }
              : {}),
          },
          updatedAt: nowISO(),
        })
        .where(eq(concretePours.id, id));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "concrete_pour",
        objectId: id,
        payload: {
          from: pour.status,
          to: "poured",
          pouredAt: at,
          tickets,
          slumpMm: body.slumpMm ?? pour.slumpMm,
          holdPointReleasedAt,
          pouredWithoutRelease: body.proceedWithoutRelease === true,
          proceedReason: body.proceedReason ?? null,
        },
        storePayload: true,
      });
      const refreshed = await fetchPour(id, req.companyId!, req.projectId!);
      return detail(refreshed);
    },
  );

  /* ---------------- specimens ---------------- */

  app.post(
    "/projects/:projectId/concrete-pours/:id/specimens",
    { preHandler: standardGate },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({ specimens: z.array(specimenCreateSchema).min(1).max(50) })
        .parse(req.body);
      const pour = await fetchPour(id, req.companyId!, req.projectId!);
      const existing = await specimensOf(id);
      const known = new Set(existing.map((s) => s.specimenRef));
      const duplicate = body.specimens.filter((s) => known.has(s.specimenRef));
      if (duplicate.length > 0) {
        throw conflict(
          `Specimen reference(s) already recorded against ${pour.reference}: ${duplicate.map((d) => d.specimenRef).join(", ")}.`,
        );
      }
      const rows = body.specimens.map((s) => ({
        id: newId("cts"),
        companyId: req.companyId!,
        projectId: req.projectId!,
        pourId: id,
        specimenRef: s.specimenRef,
        specimenType: s.specimenType ?? "cube",
        castAt: s.castAt ?? (pour.pouredAt ? pour.pouredAt.slice(0, 10) : todayISO()),
        testAgeDays: s.testAgeDays ?? pour.testAgeDays,
        labName: s.labName ?? null,
        labAccreditation: s.labAccreditation ?? null,
        notes: s.notes ?? null,
        createdBy: req.user!.id,
      }));
      await app.db.insert(concreteTestSpecimens).values(rows);
      await assessAndPersist(app.db, pour);
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "concrete_test_specimen",
        objectId: rows[0]!.id,
        payload: { pourId: id, specimens: rows.map((r) => r.specimenRef) },
        storePayload: true,
      });
      return reply.status(201).send(await detail(await fetchPour(id, req.companyId!, req.projectId!)));
    },
  );

  /**
   * Record a crush result. Re-judges the pour immediately: the point of the
   * register is that the verdict is never later than the last result.
   */
  app.post(
    "/projects/:projectId/concrete-pours/:id/specimens/:specimenId/result",
    { preHandler: standardGate },
    async (req) => {
      const { id, specimenId } = req.params as { id: string; specimenId: string };
      const body = specimenResultSchema.parse(req.body);
      const pour = await fetchPour(id, req.companyId!, req.projectId!);
      const rows = await app.db
        .select()
        .from(concreteTestSpecimens)
        .where(
          and(eq(concreteTestSpecimens.id, specimenId), eq(concreteTestSpecimens.pourId, id)),
        )
        .limit(1);
      const specimen = rows[0];
      if (!specimen) throw notFound("Specimen not found on this pour");
      if (body.result === "void" && !body.voidReason) {
        throw badRequest(
          "A voided specimen must say why it was voided. A void with no reason is indistinguishable from a result somebody did not like.",
        );
      }
      const strength = body.strengthMpa ?? specimen.strengthMpa;
      const derivedResult =
        body.result ??
        (strength === null
          ? "pending"
          : pour.specifiedStrengthMpa !== null && strength < pour.specifiedStrengthMpa
            ? "fail"
            : "pass");
      await app.db
        .update(concreteTestSpecimens)
        .set({
          strengthMpa: strength,
          densityKgM3: body.densityKgM3 ?? specimen.densityKgM3,
          testDate: body.testDate ?? specimen.testDate ?? todayISO(),
          result: derivedResult,
          failureMode: body.failureMode ?? specimen.failureMode,
          certificateNumber: body.certificateNumber ?? specimen.certificateNumber,
          certificateFileId: body.certificateFileId ?? specimen.certificateFileId,
          labName: body.labName ?? specimen.labName,
          voidReason: body.voidReason ?? specimen.voidReason,
          notes: body.notes ?? specimen.notes,
          updatedAt: nowISO(),
        })
        .where(eq(concreteTestSpecimens.id, specimenId));

      const assessment = await assessAndPersist(app.db, pour);
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "concrete_test_specimen",
        objectId: specimenId,
        payload: {
          pourId: id,
          specimenRef: specimen.specimenRef,
          strengthMpa: strength,
          result: derivedResult,
          verdict: assessment.verdict,
          statistics: assessment.statistics,
        },
        storePayload: true,
      });

      let ncr: { id: string; reference: string } | null = null;
      let signalId: string | null = null;
      const refreshed = await fetchPour(id, req.companyId!, req.projectId!);
      if (assessment.verdict === "rejected" && !refreshed.ncrId) {
        const raised = await createNcr(app.db, {
          companyId: req.companyId!,
          projectId: req.projectId!,
          actorId: req.user!.id,
          title: `${refreshed.reference} — concrete did not meet ${refreshed.specifiedGrade ?? "the specified strength"}`.slice(0, 300),
          description:
            `Pour ${refreshed.reference} "${refreshed.pourName}" failed its acceptance criteria under ${assessment.code.replace(/_/g, " ")}. ` +
            assessment.reasons.join(" "),
          category: "material",
          severity: "critical",
          sourceType: "test_record",
          sourceId: refreshed.id,
          locationId: refreshed.locationId,
          locationText: refreshed.locationText,
          raisedAgainstVendorId: refreshed.supplierVendorId,
          detail: { pourId: refreshed.id, verdict: assessment.verdict, code: assessment.code },
        });
        ncr = { id: raised.id, reference: raised.reference };
        signalId = await signalFailedPour(app.db, refreshed, assessment, req.user!.id);
        await app.db
          .update(concretePours)
          .set({ ncrId: raised.id, signalId, updatedAt: nowISO() })
          .where(eq(concretePours.id, id));
      }
      return {
        ...(await detail(await fetchPour(id, req.companyId!, req.projectId!))),
        raised: { ncr, signalId },
      };
    },
  );

  /** Re-run the acceptance arithmetic on demand. */
  app.post(
    "/projects/:projectId/concrete-pours/:id/assess",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const pour = await fetchPour(id, req.companyId!, req.projectId!);
      const assessment = await assessAndPersist(app.db, pour);
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "concrete_pour",
        objectId: id,
        payload: { verdict: assessment.verdict, statistics: assessment.statistics },
        storePayload: true,
      });
      return { ...(await detail(await fetchPour(id, req.companyId!, req.projectId!))), assessment };
    },
  );

  /** The concrete register's own dashboard: statistics by mix, not by pour. */
  app.get("/projects/:projectId/concrete-summary", { preHandler: readGate }, async (req) => {
    const pours = await app.db
      .select()
      .from(concretePours)
      .where(
        and(
          eq(concretePours.companyId, req.companyId!),
          eq(concretePours.projectId, req.projectId!),
        ),
      )
      .orderBy(asc(concretePours.number));
    const pourIds = pours.map((p) => p.id);
    const specimens = pourIds.length
      ? await app.db
          .select()
          .from(concreteTestSpecimens)
          .where(inArray(concreteTestSpecimens.pourId, pourIds))
      : [];
    const byPour = new Map<string, typeof specimens>();
    for (const s of specimens) {
      const list = byPour.get(s.pourId) ?? [];
      list.push(s);
      byPour.set(s.pourId, list);
    }
    const byStatus: Record<string, number> = {};
    const byVerdict: Record<string, number> = {};
    const byMix = new Map<string, { pours: number; results: number[]; specified: number | null }>();
    let pouredWithoutRelease = 0;
    let untestedPours = 0;
    for (const p of pours) {
      byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      const verdict = p.acceptanceVerdict ?? "not_assessed";
      byVerdict[verdict] = (byVerdict[verdict] ?? 0) + 1;
      if ((p.detail as Record<string, unknown>)["pouredWithoutRelease"] === true) {
        pouredWithoutRelease += 1;
      }
      const mine = byPour.get(p.id) ?? [];
      const tested = mine.filter((s) => s.result !== "void" && typeof s.strengthMpa === "number");
      if (p.pouredAt && tested.length === 0) untestedPours += 1;
      const key = p.mixReference ?? "(no mix reference)";
      const bucket = byMix.get(key) ?? { pours: 0, results: [], specified: p.specifiedStrengthMpa };
      bucket.pours += 1;
      bucket.results.push(...tested.map((s) => s.strengthMpa as number));
      byMix.set(key, bucket);
    }
    const mixes = [...byMix.entries()].map(([mixReference, v]) => {
      const n = v.results.length;
      const mean = n > 0 ? v.results.reduce((a, b) => a + b, 0) / n : null;
      const sd =
        n >= 2 && mean !== null
          ? Math.sqrt(v.results.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / (n - 1))
          : null;
      return {
        mixReference,
        pours: v.pours,
        specifiedStrengthMpa: v.specified,
        resultCount: n,
        meanStrengthMpa: mean === null ? null : round2(mean),
        standardDeviationMpa: sd === null ? null : round2(sd),
        minStrengthMpa: n > 0 ? round2(Math.min(...v.results)) : null,
        reasons:
          n === 0
            ? [
                `No crush result is held for ${mixReference}, so nothing can be said about its strength. It is untested, not passing.`,
              ]
            : n < 2
              ? ["One result cannot produce a standard deviation for this mix."]
              : [],
      };
    });
    return {
      pours: pours.length,
      byStatus,
      byVerdict,
      failing: pours.filter((p) => p.acceptanceVerdict === "rejected").length,
      untestedPours,
      pouredWithoutRelease,
      specimens: specimens.length,
      specimensAwaitingResult: specimens.filter((s) => s.result === "pending").length,
      mixes,
    };
  });
};
