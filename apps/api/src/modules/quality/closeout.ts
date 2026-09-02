/**
 * Closeout — the year after handover (Domain V depth).
 *
 * Five registers that only matter once the contractor has left, which is
 * precisely why they are usually kept in somebody's spreadsheet and lost:
 *
 *   defects liability periods   the clock that starts at handover and ends on
 *                               a date somebody has to be told about — so the
 *                               deadline is an OBLIGATION in the assurance
 *                               register, not a reminder this module invents
 *   performance guarantees      what the plant was promised to do, what it
 *                               measured, and what the shortfall costs
 *   operator training           the handover that is not paper
 *   spare parts                 what the owner is contractually owed and has
 *                               not been given
 *   post-occupancy evaluation   whether the design intent survived, measured
 *                               in use rather than asserted at practical
 *                               completion (#973–975)
 *
 * The honesty rule that runs through all five: an unmeasured guarantee is not
 * a met one, an untested season is not a passed one, and an energy variance
 * with only one of its two numbers is reported as unknown rather than zero.
 */

import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import {
  commissioningSystems,
  commissioningTestRecords,
  defectsLiabilityPeriods,
  dlpDefects,
  obligations,
  operatorTrainingRecords,
  performanceGuarantees,
  postOccupancyEvaluations,
  spareParts,
  turnoverPackages,
} from "@constructos/db";
import {
  DLP_DEFECT_STATUSES,
  DLP_STATUSES,
  GUARANTEE_OPERATORS,
  GUARANTEE_STATUSES,
  NCR_SEVERITIES,
  POE_KINDS,
  POE_STATUSES,
  SPARE_PART_CATEGORIES,
  SPARE_PART_STATUSES,
  TRAINING_KINDS,
  TRAINING_STATUSES,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import {
  allocateReference,
  alreadySignalled,
  assertDistinctActor,
  assertVendor,
  buildGates,
  daysUntil,
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
  totalsByCurrency,
} from "./shared.js";
import { assessGuarantee, guaranteeExposure, type GuaranteeLike } from "./guarantees.js";
import { addMonths } from "./weldStats.js";

const SYSTEM_ACTOR = "system";

/* ------------------------------------------------------------------ */
/* DLP standing                                                        */
/* ------------------------------------------------------------------ */

export function dlpStanding(
  row: { status: string; startDate: string; endDate: string; extendedToDate: string | null },
  asOf: string,
): { status: (typeof DLP_STATUSES)[number]; daysRemaining: number | null; reasons: string[] } {
  if (row.status === "closed") {
    return { status: "closed", daysRemaining: null, reasons: ["The period is closed."] };
  }
  const end = row.extendedToDate ?? row.endDate;
  const days = daysUntil(asOf, end);
  if (asOf < row.startDate) {
    return {
      status: "not_started",
      daysRemaining: days,
      reasons: [`The period starts on ${row.startDate}.`],
    };
  }
  if (days === null) {
    return { status: "active", daysRemaining: null, reasons: ["The end date is unreadable."] };
  }
  if (days < 0) {
    return {
      status: "expired",
      daysRemaining: days,
      reasons: [
        `The period ended on ${end}, ${Math.abs(days)} day(s) ago. Defects reported after the end date are outside it unless the contract says otherwise — and the final certificate and the retention release both hang on this date.`,
      ],
    };
  }
  if (days <= 60) {
    return {
      status: "expiring",
      daysRemaining: days,
      reasons: [
        `The period ends on ${end}, in ${days} day(s). Everything the owner wants made good has to be reported before then; a defect found on day 366 is the owner's.`,
      ],
    };
  }
  return {
    status: row.extendedToDate ? "extended" : "active",
    daysRemaining: days,
    reasons: [],
  };
}

/* ------------------------------------------------------------------ */
/* Sweeps                                                              */
/* ------------------------------------------------------------------ */

/** Move liability periods along and raise one signal per expiring period. */
export async function sweepDlp(
  db: Db,
  companyId: string,
  asOf: string = todayISO(),
): Promise<{ raised: number; moved: number }> {
  const rows = await db
    .select()
    .from(defectsLiabilityPeriods)
    .where(
      and(
        eq(defectsLiabilityPeriods.companyId, companyId),
        inArray(defectsLiabilityPeriods.status, ["not_started", "active", "expiring", "extended"]),
      ),
    );
  if (rows.length === 0) return { raised: 0, moved: 0 };
  const seen = await alreadySignalled(db, companyId, QUALITY_DETECTORS.dlpExpiring);
  let raised = 0;
  let moved = 0;
  for (const row of rows) {
    const standing = dlpStanding(row, asOf);
    if (standing.status !== row.status) {
      await db
        .update(defectsLiabilityPeriods)
        .set({ status: standing.status, updatedAt: nowISO() })
        .where(eq(defectsLiabilityPeriods.id, row.id));
      moved += 1;
      await ledger(db, {
        companyId,
        projectId: row.projectId,
        actorId: null,
        action: "state_change",
        objectType: "defects_liability_period",
        objectId: row.id,
        payload: { from: row.status, to: standing.status, asOf },
      });
    }
    if (standing.status !== "expiring" && standing.status !== "expired") continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const openDefects = await db
      .select({ n: count() })
      .from(dlpDefects)
      .where(
        and(
          eq(dlpDefects.dlpId, row.id),
          inArray(dlpDefects.status, ["reported", "accepted", "disputed", "in_progress"]),
        ),
      );
    const open = Number(openDefects[0]?.n ?? 0);
    const signalId = await raiseSignal(db, companyId, row.projectId, null, {
      detector: QUALITY_DETECTORS.dlpExpiring,
      severity: standing.status === "expired" ? "medium" : open > 0 ? "high" : "medium",
      confidence: 1,
      title:
        standing.status === "expired"
          ? `Defects liability period ${row.reference} has ended — ${row.name}`
          : `Defects liability period ${row.reference} ends in ${standing.daysRemaining} day(s) — ${row.name}`,
      explanation:
        `${row.reference} "${row.name}" runs ${row.startDate} to ${row.extendedToDate ?? row.endDate}. ${standing.reasons.join(" ")} ` +
        `${open > 0 ? `${open} defect(s) are still open against it. ` : "No defects are currently open against it. "}` +
        `The end of a liability period is a commercial event as much as a technical one: it releases retention, it triggers the final ` +
        `certificate, and after it the cost of making good moves from the contractor to the owner. Walk the works before the date, not after it.`,
      key: row.id,
      evidence: {
        dlpId: row.id,
        reference: row.reference,
        endDate: row.extendedToDate ?? row.endDate,
        openDefects: open,
        vendorId: row.vendorId,
        retentionReleaseDate: row.retentionReleaseDate,
        turnoverPackageId: row.turnoverPackageId,
      },
    });
    if (!row.signalId) {
      await db
        .update(defectsLiabilityPeriods)
        .set({ signalId, updatedAt: nowISO() })
        .where(eq(defectsLiabilityPeriods.id, row.id));
    }
    raised += 1;
  }
  return { raised, moved };
}

/**
 * Seasonal commissioning (#973–975).
 *
 * A system deferred to the opposite season is the commonest broken promise in
 * commissioning: everybody agrees in March to test the heating in November,
 * and in November everybody has gone. When the due date arrives this raises a
 * signal AND creates the scheduled seasonal test record, so the commitment has
 * a row somebody has to close rather than a note in the minutes.
 */
export async function sweepSeasonalTests(
  db: Db,
  companyId: string,
  asOf: string = todayISO(),
  leadDays = 30,
): Promise<{ raised: number; testsCreated: number }> {
  const horizon = new Date(Date.parse(`${asOf}T00:00:00Z`) + leadDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const rows = await db
    .select()
    .from(commissioningSystems)
    .where(
      and(
        eq(commissioningSystems.companyId, companyId),
        isNotNull(commissioningSystems.seasonalTestDueDate),
        lte(commissioningSystems.seasonalTestDueDate, horizon),
      ),
    );
  if (rows.length === 0) return { raised: 0, testsCreated: 0 };
  const seen = await alreadySignalled(db, companyId, QUALITY_DETECTORS.seasonalTestDue);
  let raised = 0;
  let testsCreated = 0;
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    const existing = await db
      .select({ id: commissioningTestRecords.id })
      .from(commissioningTestRecords)
      .where(
        and(
          eq(commissioningTestRecords.systemId, row.id),
          eq(commissioningTestRecords.testKind, "seasonal"),
        ),
      )
      .limit(1);
    seen.add(row.id);
    let createdId: string | null = existing[0]?.id ?? null;
    if (!existing[0]) {
      const { number, reference } = await (async () => {
        const { allocateReference: alloc } = await import("./shared.js");
        return alloc(db, row.projectId, "commissioning_test", "CXT");
      })();
      createdId = newId("cxt");
      await db.insert(commissioningTestRecords).values({
        id: createdId,
        companyId,
        projectId: row.projectId,
        number,
        reference,
        systemId: row.id,
        testKind: "seasonal",
        title: `Seasonal verification — ${row.systemCode} ${row.name}`.slice(0, 300),
        description:
          `Raised automatically because ${row.systemCode} was accepted with seasonal testing deferred to ${row.seasonalTestDueDate}. ` +
          `A system that has only been proven in one season has not been proven.`,
        scheduledFor: row.seasonalTestDueDate,
        status: "scheduled",
        assetId: row.assetId,
        locationId: row.locationId,
        vendorId: row.vendorId,
        detail: { raisedBy: "seasonal_sweep", seasonalTestDueDate: row.seasonalTestDueDate },
        createdBy: SYSTEM_ACTOR,
      });
      testsCreated += 1;
      await ledger(db, {
        companyId,
        projectId: row.projectId,
        actorId: null,
        action: "create",
        objectType: "commissioning_test_record",
        objectId: createdId,
        payload: { systemId: row.id, testKind: "seasonal", scheduledFor: row.seasonalTestDueDate },
        storePayload: true,
      });
    }
    await raiseSignal(db, companyId, row.projectId, null, {
      detector: QUALITY_DETECTORS.seasonalTestDue,
      severity: "medium",
      confidence: 1,
      title: `Seasonal verification due on ${row.systemCode} — ${row.seasonalTestDueDate}`,
      explanation:
        `${row.systemCode} "${row.name}" was accepted with seasonal testing deferred to ${row.seasonalTestDueDate}. ` +
        `${createdId ? `A scheduled seasonal test record now exists for it. ` : ""}` +
        `Deferred seasonal tests are the promises nobody keeps: the contractor has demobilised, the commissioning agent's appointment has ended, ` +
        `and the heating has never run in anger. Book it, or record the owner's acceptance that it will not happen.`,
      key: row.id,
      evidence: {
        systemId: row.id,
        systemCode: row.systemCode,
        seasonalTestDueDate: row.seasonalTestDueDate,
        testRecordId: createdId,
        status: row.status,
      },
    });
    raised += 1;
  }
  return { raised, testsCreated };
}

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const dlpCreateSchema = z.object({
  name: z.string().min(1).max(300),
  scopeDescription: z.string().max(10_000).nullable().optional(),
  turnoverPackageId: idSchema.nullable().optional(),
  systemId: idSchema.nullable().optional(),
  assetId: idSchema.nullable().optional(),
  commitmentId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  contractClause: z.string().max(200).nullable().optional(),
  startDate: isoDateSchema,
  endDate: isoDateSchema.optional(),
  durationMonths: z.number().int().min(1).max(240).optional(),
  retentionReleaseDate: isoDateSchema.nullable().optional(),
  retentionAmount: z.number().finite().nullable().optional(),
  currency: z.string().length(3).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const guaranteeCreateSchema = z.object({
  title: z.string().min(1).max(300),
  parameter: z.string().min(1).max(200),
  operator: z.enum(GUARANTEE_OPERATORS).optional(),
  guaranteedValue: z.number().finite().nullable().optional(),
  guaranteedMin: z.number().finite().nullable().optional(),
  guaranteedMax: z.number().finite().nullable().optional(),
  unit: z.string().max(50).nullable().optional(),
  tolerancePercent: z.number().finite().min(0).max(100).nullable().optional(),
  measurementMethod: z.string().max(2000).nullable().optional(),
  systemId: idSchema.nullable().optional(),
  assetId: idSchema.nullable().optional(),
  turnoverPackageId: idSchema.nullable().optional(),
  commitmentId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  contractClause: z.string().max(200).nullable().optional(),
  ldRatePerUnit: z.number().finite().nullable().optional(),
  ldRateUnit: z.string().max(100).nullable().optional(),
  ldCapAmount: z.number().finite().nullable().optional(),
  currency: z.string().length(3).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const trainingCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).nullable().optional(),
  trainingKind: z.enum(TRAINING_KINDS).optional(),
  systemId: idSchema.nullable().optional(),
  assetId: idSchema.nullable().optional(),
  turnoverPackageId: idSchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  trainerName: z.string().max(200).nullable().optional(),
  trainerOrganisation: z.string().max(200).nullable().optional(),
  scheduledFor: isoDateSchema.nullable().optional(),
  durationHours: z.number().finite().min(0).max(1000).nullable().optional(),
  materialsFileIds: fileIdsSchema.optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const spareCreateSchema = z.object({
  description: z.string().min(1).max(500),
  category: z.enum(SPARE_PART_CATEGORIES).optional(),
  partNumber: z.string().max(200).nullable().optional(),
  manufacturer: z.string().max(200).nullable().optional(),
  supplierVendorId: idSchema.nullable().optional(),
  systemId: idSchema.nullable().optional(),
  assetId: idSchema.nullable().optional(),
  turnoverPackageId: idSchema.nullable().optional(),
  materialItemId: idSchema.nullable().optional(),
  quantityRequired: z.number().finite().min(0).nullable().optional(),
  unit: z.string().max(50).nullable().optional(),
  unitCost: z.number().finite().nullable().optional(),
  currency: z.string().length(3).optional(),
  leadTimeWeeks: z.number().finite().min(0).nullable().optional(),
  storageLocation: z.string().max(200).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const poeCreateSchema = z.object({
  title: z.string().min(1).max(300),
  poeKind: z.enum(POE_KINDS).optional(),
  turnoverPackageId: idSchema.nullable().optional(),
  systemId: idSchema.nullable().optional(),
  periodStart: isoDateSchema.nullable().optional(),
  periodEnd: isoDateSchema.nullable().optional(),
  scheduledFor: isoDateSchema.nullable().optional(),
  conductedByOrganisation: z.string().max(200).nullable().optional(),
  energyDesignValue: z.number().finite().nullable().optional(),
  energyActualValue: z.number().finite().nullable().optional(),
  energyUnit: z.string().max(50).nullable().optional(),
  satisfactionScale: z.string().max(100).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const closeoutRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);

  const scope = (req: { companyId?: string; projectId?: string }) => ({
    companyId: req.companyId!,
    projectId: req.projectId!,
  });

  /* ================= defects liability periods ================= */

  async function fetchDlp(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(defectsLiabilityPeriods)
      .where(
        and(
          eq(defectsLiabilityPeriods.id, id),
          eq(defectsLiabilityPeriods.companyId, companyId),
          eq(defectsLiabilityPeriods.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Defects liability period not found");
    return rows[0];
  }

  async function refreshDefectCounts(dlpId: string) {
    const rows = await app.db.select().from(dlpDefects).where(eq(dlpDefects.dlpId, dlpId));
    const open = rows.filter((r) =>
      ["reported", "accepted", "disputed", "in_progress"].includes(r.status),
    ).length;
    await app.db
      .update(defectsLiabilityPeriods)
      .set({ defectCount: rows.length, openDefectCount: open, updatedAt: nowISO() })
      .where(eq(defectsLiabilityPeriods.id, dlpId));
    return rows;
  }

  app.post("/projects/:projectId/dlps", { preHandler: standardGate }, async (req, reply) => {
    const body = dlpCreateSchema.parse(req.body);
    if (body.vendorId) await assertVendor(app.db, req.companyId!, body.vendorId);
    if (!body.endDate && !body.durationMonths) {
      throw badRequest(
        "A defects liability period needs an end date or a duration. A period with no end cannot be swept, cannot release retention and cannot be argued about later.",
      );
    }
    const endDate = body.endDate ?? addMonths(body.startDate, body.durationMonths!);
    if (endDate <= body.startDate) {
      throw badRequest(`The end date ${endDate} is not after the start date ${body.startDate}.`);
    }
    const { number, reference } = await allocateReference(app.db, req.projectId!, "dlp", "DLP");
    const id = newId("dlp");
    const obligationId = newId("obl");
    await app.db.insert(obligations).values({
      id: obligationId,
      companyId: req.companyId!,
      projectId: req.projectId!,
      sourceClause: body.contractClause ?? `Defects liability period ${reference}`,
      obligorId: body.vendorId ?? null,
      trigger:
        `${reference} "${body.name}" runs to ${endDate}. Everything the owner wants made good must be reported before that date; ` +
        `after it the cost of making good moves to the owner, and the retention and final certificate fall due.`,
      deadline: `${endDate}T00:00:00.000Z`,
      warnDaysBefore: 30,
      evidenceRequirement:
        "The defect list closed out and verified, and the final certificate or retention release recorded against this period.",
      status: "open",
      createdBy: req.user!.id,
    });
    const [created] = await app.db
      .insert(defectsLiabilityPeriods)
      .values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        reference,
        name: body.name,
        scopeDescription: body.scopeDescription ?? null,
        turnoverPackageId: body.turnoverPackageId ?? null,
        systemId: body.systemId ?? null,
        assetId: body.assetId ?? null,
        commitmentId: body.commitmentId ?? null,
        vendorId: body.vendorId ?? null,
        contractClause: body.contractClause ?? null,
        startDate: body.startDate,
        endDate,
        durationMonths: body.durationMonths ?? null,
        status: dlpStanding(
          { status: "not_started", startDate: body.startDate, endDate, extendedToDate: null },
          todayISO(),
        ).status,
        makeGoodObligationId: obligationId,
        retentionReleaseDate: body.retentionReleaseDate ?? null,
        retentionAmount: body.retentionAmount ?? null,
        currency: body.currency ?? "USD",
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      ...scope(req),
      actorId: req.user!.id,
      action: "create",
      objectType: "defects_liability_period",
      objectId: id,
      payload: { ...created, obligationId },
      storePayload: true,
    });
    return reply.status(201).send({ ...created, standing: dlpStanding(created!, todayISO()) });
  });

  app.get("/projects/:projectId/dlps", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        status: z.enum(DLP_STATUSES).optional(),
        vendorId: idSchema.optional(),
        search: z.string().max(200).optional(),
      })
      .parse(req.query);
    const clauses = [
      eq(defectsLiabilityPeriods.companyId, req.companyId!),
      eq(defectsLiabilityPeriods.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(defectsLiabilityPeriods.status, q.status));
    if (q.vendorId) clauses.push(eq(defectsLiabilityPeriods.vendorId, q.vendorId));
    if (q.search) clauses.push(ilike(defectsLiabilityPeriods.name, `%${q.search}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(defectsLiabilityPeriods).where(where);
    const rows = await app.db
      .select()
      .from(defectsLiabilityPeriods)
      .where(where)
      .orderBy(asc(defectsLiabilityPeriods.endDate))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const today = todayISO();
    return paginate(
      rows.map((r) => ({ ...r, standing: dlpStanding(r, today) })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.get("/projects/:projectId/dlps/:id", { preHandler: readGate }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await fetchDlp(id, req.companyId!, req.projectId!);
    const defects = await app.db
      .select()
      .from(dlpDefects)
      .where(eq(dlpDefects.dlpId, id))
      .orderBy(asc(dlpDefects.position));
    return { ...row, standing: dlpStanding(row, todayISO()), defects };
  });

  app.post("/projects/:projectId/dlps/:id/extend", { preHandler: standardGate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ extendedToDate: isoDateSchema, reason: z.string().min(1).max(4000) })
      .parse(req.body);
    const row = await fetchDlp(id, req.companyId!, req.projectId!);
    if (body.extendedToDate <= (row.extendedToDate ?? row.endDate)) {
      throw badRequest(
        `An extension must be later than the current end date (${row.extendedToDate ?? row.endDate}).`,
      );
    }
    await app.db
      .update(defectsLiabilityPeriods)
      .set({
        extendedToDate: body.extendedToDate,
        extensionReason: body.reason,
        status: "extended",
        updatedAt: nowISO(),
      })
      .where(eq(defectsLiabilityPeriods.id, id));
    if (row.makeGoodObligationId) {
      await app.db
        .update(obligations)
        .set({ deadline: `${body.extendedToDate}T00:00:00.000Z` })
        .where(eq(obligations.id, row.makeGoodObligationId));
    }
    await ledger(app.db, {
      ...scope(req),
      actorId: req.user!.id,
      action: "state_change",
      objectType: "defects_liability_period",
      objectId: id,
      payload: {
        from: row.endDate,
        to: body.extendedToDate,
        reason: body.reason,
        obligationId: row.makeGoodObligationId,
      },
      storePayload: true,
    });
    const fresh = await fetchDlp(id, req.companyId!, req.projectId!);
    return { ...fresh, standing: dlpStanding(fresh, todayISO()) };
  });

  app.post("/projects/:projectId/dlps/:id/close", { preHandler: standardGate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        finalCertificateDate: isoDateSchema.nullable().optional(),
        finalCertificateFileId: idSchema.nullable().optional(),
        note: z.string().max(4000).nullable().optional(),
        force: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    const row = await fetchDlp(id, req.companyId!, req.projectId!);
    const defects = await refreshDefectCounts(id);
    const open = defects.filter((d) =>
      ["reported", "accepted", "disputed", "in_progress"].includes(d.status),
    );
    if (open.length > 0 && body.force !== true) {
      throw badRequest(
        `${row.reference} has ${open.length} open defect(s): ${open.map((d) => d.reference).join(", ")}. ` +
          `Closing the period releases the retention and issues the final certificate; do that over open defects only deliberately, and say why.`,
      );
    }
    const at = nowISO();
    await app.db
      .update(defectsLiabilityPeriods)
      .set({
        status: "closed",
        closedBy: req.user!.id,
        closedAt: at,
        finalCertificateDate: body.finalCertificateDate ?? row.finalCertificateDate,
        finalCertificateFileId: body.finalCertificateFileId ?? row.finalCertificateFileId,
        detail: {
          ...(row.detail as Record<string, unknown>),
          closureNote: body.note ?? null,
          closedOverOpenDefects: open.length > 0 ? open.map((d) => d.reference) : undefined,
        },
        updatedAt: at,
      })
      .where(eq(defectsLiabilityPeriods.id, id));
    if (row.makeGoodObligationId) {
      await app.db
        .update(obligations)
        .set({ status: "satisfied" })
        .where(eq(obligations.id, row.makeGoodObligationId));
    }
    await ledger(app.db, {
      ...scope(req),
      actorId: req.user!.id,
      action: "state_change",
      objectType: "defects_liability_period",
      objectId: id,
      payload: {
        from: row.status,
        to: "closed",
        openDefectsAtClosure: open.map((d) => d.reference),
        finalCertificateDate: body.finalCertificateDate ?? row.finalCertificateDate,
        note: body.note ?? null,
      },
      storePayload: true,
    });
    const fresh = await fetchDlp(id, req.companyId!, req.projectId!);
    return { ...fresh, standing: dlpStanding(fresh, todayISO()) };
  });

  /* ---- defects reported during the period ---- */

  app.post("/projects/:projectId/dlps/:id/defects", { preHandler: standardGate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        title: z.string().min(1).max(300),
        description: z.string().max(20_000).nullable().optional(),
        reportedAt: isoDateSchema.optional(),
        reportedByName: z.string().max(200).nullable().optional(),
        reportedByOrganisation: z.string().max(200).nullable().optional(),
        severity: z.enum(NCR_SEVERITIES).optional(),
        locationId: idSchema.nullable().optional(),
        locationText: z.string().max(500).nullable().optional(),
        assetId: idSchema.nullable().optional(),
        systemId: idSchema.nullable().optional(),
        responsibleVendorId: idSchema.nullable().optional(),
        targetRectificationDate: isoDateSchema.nullable().optional(),
        cost: z.number().finite().nullable().optional(),
        currency: z.string().length(3).optional(),
        photoFileIds: fileIdsSchema.optional(),
      })
      .parse(req.body);
    const dlp = await fetchDlp(id, req.companyId!, req.projectId!);
    const reportedAt = body.reportedAt ?? todayISO();
    const end = dlp.extendedToDate ?? dlp.endDate;
    const outsidePeriod = reportedAt > end;
    const existing = await app.db.select().from(dlpDefects).where(eq(dlpDefects.dlpId, id));
    const position = existing.length + 1;
    const defectId = newId("dfc");
    const [created] = await app.db
      .insert(dlpDefects)
      .values({
        id: defectId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        dlpId: id,
        position,
        reference: `${dlp.reference}-D${String(position).padStart(3, "0")}`,
        title: body.title,
        description: body.description ?? null,
        reportedAt,
        reportedByName: body.reportedByName ?? null,
        reportedByOrganisation: body.reportedByOrganisation ?? null,
        severity: body.severity ?? "minor",
        locationId: body.locationId ?? null,
        locationText: body.locationText ?? null,
        assetId: body.assetId ?? null,
        systemId: body.systemId ?? null,
        responsibleVendorId: body.responsibleVendorId ?? dlp.vendorId,
        targetRectificationDate: body.targetRectificationDate ?? null,
        cost: body.cost ?? null,
        currency: body.currency ?? dlp.currency,
        photoFileIds: body.photoFileIds ?? [],
        detail: outsidePeriod
          ? {
              reportedOutsidePeriod: true,
              periodEnded: end,
              note: "Reported after the liability period ended; whether it is covered is a contractual question, and the dates are recorded so it can be argued from fact.",
            }
          : {},
        createdBy: req.user!.id,
      })
      .returning();
    await refreshDefectCounts(id);
    await ledger(app.db, {
      ...scope(req),
      actorId: req.user!.id,
      action: "create",
      objectType: "dlp_defect",
      objectId: defectId,
      payload: { ...created, outsidePeriod },
      storePayload: true,
    });
    return reply.status(201).send({ ...created, outsidePeriod });
  });

  app.post(
    "/projects/:projectId/dlp-defects/:defectId/status",
    { preHandler: standardGate },
    async (req) => {
      const { defectId } = req.params as { defectId: string };
      const body = z
        .object({
          status: z.enum(DLP_DEFECT_STATUSES),
          note: z.string().max(4000).nullable().optional(),
          rectifiedAt: isoDateSchema.nullable().optional(),
          disputeReason: z.string().max(4000).nullable().optional(),
          ncrId: idSchema.nullable().optional(),
          reworkItemId: idSchema.nullable().optional(),
          cost: z.number().finite().nullable().optional(),
        })
        .parse(req.body);
      const rows = await app.db
        .select()
        .from(dlpDefects)
        .where(
          and(
            eq(dlpDefects.id, defectId),
            eq(dlpDefects.companyId, req.companyId!),
            eq(dlpDefects.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const defect = rows[0];
      if (!defect) throw notFound("Defect not found");
      if (defect.status === "verified") {
        throw badRequest(`${defect.reference} is verified; re-report it if it has come back.`);
      }
      if (body.status === "disputed" && !body.disputeReason) {
        throw badRequest("A disputed defect must record the basis of the dispute.");
      }
      if (body.status === "verified") {
        assertDistinctActor(
          req.user!.id,
          defect.createdBy,
          `Verification of defect ${defect.reference}`,
          "reported",
        );
      }
      const at = nowISO();
      await app.db
        .update(dlpDefects)
        .set({
          status: body.status,
          rectifiedAt:
            body.status === "rectified" || body.status === "verified"
              ? (body.rectifiedAt ?? defect.rectifiedAt ?? todayISO())
              : defect.rectifiedAt,
          verifiedBy: body.status === "verified" ? req.user!.id : defect.verifiedBy,
          verifiedAt: body.status === "verified" ? at : defect.verifiedAt,
          disputeReason: body.disputeReason ?? defect.disputeReason,
          ncrId: body.ncrId ?? defect.ncrId,
          reworkItemId: body.reworkItemId ?? defect.reworkItemId,
          cost: body.cost ?? defect.cost,
          detail: { ...(defect.detail as Record<string, unknown>), lastNote: body.note ?? null },
          updatedAt: at,
        })
        .where(eq(dlpDefects.id, defectId));
      await refreshDefectCounts(defect.dlpId);
      await ledger(app.db, {
        ...scope(req),
        actorId: req.user!.id,
        action: "state_change",
        objectType: "dlp_defect",
        objectId: defectId,
        payload: { from: defect.status, to: body.status, note: body.note ?? null },
        storePayload: true,
      });
      const fresh = await app.db.select().from(dlpDefects).where(eq(dlpDefects.id, defectId));
      return fresh[0];
    },
  );

  /* ================= performance guarantees ================= */

  async function fetchGuarantee(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(performanceGuarantees)
      .where(
        and(
          eq(performanceGuarantees.id, id),
          eq(performanceGuarantees.companyId, companyId),
          eq(performanceGuarantees.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Performance guarantee not found");
    return rows[0];
  }

  const asGuarantee = (row: typeof performanceGuarantees.$inferSelect): GuaranteeLike => ({
    id: row.id,
    reference: row.reference,
    parameter: row.parameter,
    operator: row.operator,
    guaranteedValue: row.guaranteedValue,
    guaranteedMin: row.guaranteedMin,
    guaranteedMax: row.guaranteedMax,
    unit: row.unit,
    tolerancePercent: row.tolerancePercent,
    measuredValue: row.measuredValue,
    ldRatePerUnit: row.ldRatePerUnit,
    ldCapAmount: row.ldCapAmount,
    currency: row.currency,
    status: row.status,
  });

  app.post(
    "/projects/:projectId/performance-guarantees",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = guaranteeCreateSchema.parse(req.body);
      if (body.vendorId) await assertVendor(app.db, req.companyId!, body.vendorId);
      const operator = body.operator ?? "at_least";
      if (operator === "between" && (body.guaranteedMin === null || body.guaranteedMax === null)) {
        throw badRequest("A banded guarantee needs both ends of the band.");
      }
      if (operator !== "between" && (body.guaranteedValue === null || body.guaranteedValue === undefined)) {
        throw badRequest(
          "A guarantee needs the value it promises. Without it the measurement cannot be judged and the register holds an intention rather than a guarantee.",
        );
      }
      const { number, reference } = await allocateReference(app.db, req.projectId!, "guarantee", "PG");
      const id = newId("pgt");
      const [created] = await app.db
        .insert(performanceGuarantees)
        .values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          number,
          reference,
          title: body.title,
          parameter: body.parameter,
          operator,
          guaranteedValue: body.guaranteedValue ?? null,
          guaranteedMin: body.guaranteedMin ?? null,
          guaranteedMax: body.guaranteedMax ?? null,
          unit: body.unit ?? null,
          tolerancePercent: body.tolerancePercent ?? null,
          measurementMethod: body.measurementMethod ?? null,
          systemId: body.systemId ?? null,
          assetId: body.assetId ?? null,
          turnoverPackageId: body.turnoverPackageId ?? null,
          commitmentId: body.commitmentId ?? null,
          vendorId: body.vendorId ?? null,
          contractClause: body.contractClause ?? null,
          ldRatePerUnit: body.ldRatePerUnit ?? null,
          ldRateUnit: body.ldRateUnit ?? null,
          ldCapAmount: body.ldCapAmount ?? null,
          currency: body.currency ?? "USD",
          detail: body.detail ?? {},
          createdBy: req.user!.id,
        })
        .returning();
      await ledger(app.db, {
        ...scope(req),
        actorId: req.user!.id,
        action: "create",
        objectType: "performance_guarantee",
        objectId: id,
        payload: created,
        storePayload: true,
      });
      return reply
        .status(201)
        .send({ ...created, assessment: assessGuarantee(asGuarantee(created!)) });
    },
  );

  app.get("/projects/:projectId/performance-guarantees", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        status: z.enum(GUARANTEE_STATUSES).optional(),
        systemId: idSchema.optional(),
        search: z.string().max(200).optional(),
      })
      .parse(req.query);
    const clauses = [
      eq(performanceGuarantees.companyId, req.companyId!),
      eq(performanceGuarantees.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(performanceGuarantees.status, q.status));
    if (q.systemId) clauses.push(eq(performanceGuarantees.systemId, q.systemId));
    if (q.search) clauses.push(ilike(performanceGuarantees.title, `%${q.search}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(performanceGuarantees).where(where);
    const rows = await app.db
      .select()
      .from(performanceGuarantees)
      .where(where)
      .orderBy(desc(performanceGuarantees.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((r) => ({ ...r, assessment: assessGuarantee(asGuarantee(r)) })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  /**
   * Record what the test measured. The verdict, the shortfall and the damages
   * are computed — never typed in — and the basis is written out so the number
   * can be argued from rather than asserted.
   */
  app.post(
    "/projects/:projectId/performance-guarantees/:id/measure",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          measuredValue: z.number().finite(),
          measuredAt: isoTimestampSchema.optional(),
          testRecordId: idSchema.nullable().optional(),
          note: z.string().max(4000).nullable().optional(),
        })
        .parse(req.body);
      const row = await fetchGuarantee(id, req.companyId!, req.projectId!);
      if (row.status === "waived") {
        throw badRequest(`${row.reference} is waived; measuring it records nothing to enforce.`);
      }
      const assessment = assessGuarantee({ ...asGuarantee(row), measuredValue: body.measuredValue });
      const at = body.measuredAt ?? nowISO();
      await app.db
        .update(performanceGuarantees)
        .set({
          measuredValue: body.measuredValue,
          measuredAt: at,
          measuredBy: req.user!.id,
          testRecordId: body.testRecordId ?? row.testRecordId,
          status: assessment.status,
          shortfall: assessment.shortfall,
          shortfallPercent: assessment.shortfallPercent,
          ldAmount: assessment.ldAmount,
          ldBasis: assessment.basis,
          detail: { ...(row.detail as Record<string, unknown>), measurementNote: body.note ?? null },
          updatedAt: nowISO(),
        })
        .where(eq(performanceGuarantees.id, id));
      await ledger(app.db, {
        ...scope(req),
        actorId: req.user!.id,
        action: "state_change",
        objectType: "performance_guarantee",
        objectId: id,
        payload: {
          from: row.status,
          to: assessment.status,
          measuredValue: body.measuredValue,
          shortfall: assessment.shortfall,
          ldAmount: assessment.ldAmount,
          basis: assessment.basis,
          reasons: assessment.reasons,
        },
        storePayload: true,
      });
      const fresh = await fetchGuarantee(id, req.companyId!, req.projectId!);
      return { ...fresh, assessment };
    },
  );

  app.post(
    "/projects/:projectId/performance-guarantees/:id/verify",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const row = await fetchGuarantee(id, req.companyId!, req.projectId!);
      if (row.measuredValue === null) {
        throw badRequest(
          `${row.reference} has not been measured; there is nothing to verify. An unmeasured guarantee is not a met one.`,
        );
      }
      assertDistinctActor(
        req.user!.id,
        row.measuredBy,
        `Verification of ${row.reference}`,
        "measured",
      );
      const at = nowISO();
      await app.db
        .update(performanceGuarantees)
        .set({ verifiedBy: req.user!.id, verifiedAt: at, updatedAt: at })
        .where(eq(performanceGuarantees.id, id));
      await ledger(app.db, {
        ...scope(req),
        actorId: req.user!.id,
        action: "update",
        objectType: "performance_guarantee",
        objectId: id,
        payload: { verifiedBy: req.user!.id, measuredBy: row.measuredBy, measuredValue: row.measuredValue },
        storePayload: true,
      });
      const fresh = await fetchGuarantee(id, req.companyId!, req.projectId!);
      return { ...fresh, assessment: assessGuarantee(asGuarantee(fresh)) };
    },
  );

  app.post(
    "/projects/:projectId/performance-guarantees/:id/waive",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({ reason: z.string().min(1).max(4000), concessionId: idSchema.nullable().optional() })
        .parse(req.body);
      const row = await fetchGuarantee(id, req.companyId!, req.projectId!);
      assertDistinctActor(
        req.user!.id,
        row.createdBy,
        `Waiver of guarantee ${row.reference}`,
        "recorded",
      );
      const at = nowISO();
      await app.db
        .update(performanceGuarantees)
        .set({
          status: "waived",
          waivedBy: req.user!.id,
          waivedAt: at,
          waiverReason: body.reason,
          concessionId: body.concessionId ?? row.concessionId,
          updatedAt: at,
        })
        .where(eq(performanceGuarantees.id, id));
      await ledger(app.db, {
        ...scope(req),
        actorId: req.user!.id,
        action: "state_change",
        objectType: "performance_guarantee",
        objectId: id,
        payload: { from: row.status, to: "waived", reason: body.reason, concessionId: body.concessionId ?? null },
        storePayload: true,
      });
      return fetchGuarantee(id, req.companyId!, req.projectId!);
    },
  );

  /* ================= training ================= */

  app.post("/projects/:projectId/training-records", { preHandler: standardGate }, async (req, reply) => {
    const body = trainingCreateSchema.parse(req.body);
    if (body.vendorId) await assertVendor(app.db, req.companyId!, body.vendorId);
    const { number, reference } = await allocateReference(app.db, req.projectId!, "training", "TRN");
    const id = newId("trn");
    const [created] = await app.db
      .insert(operatorTrainingRecords)
      .values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        reference,
        title: body.title,
        description: body.description ?? null,
        trainingKind: body.trainingKind ?? "hands_on",
        systemId: body.systemId ?? null,
        assetId: body.assetId ?? null,
        turnoverPackageId: body.turnoverPackageId ?? null,
        vendorId: body.vendorId ?? null,
        trainerName: body.trainerName ?? null,
        trainerOrganisation: body.trainerOrganisation ?? null,
        scheduledFor: body.scheduledFor ?? null,
        durationHours: body.durationHours ?? null,
        materialsFileIds: body.materialsFileIds ?? [],
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      ...scope(req),
      actorId: req.user!.id,
      action: "create",
      objectType: "operator_training_record",
      objectId: id,
      payload: created,
      storePayload: true,
    });
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/training-records", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ status: z.enum(TRAINING_STATUSES).optional(), systemId: idSchema.optional() })
      .parse(req.query);
    const clauses = [
      eq(operatorTrainingRecords.companyId, req.companyId!),
      eq(operatorTrainingRecords.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(operatorTrainingRecords.status, q.status));
    if (q.systemId) clauses.push(eq(operatorTrainingRecords.systemId, q.systemId));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(operatorTrainingRecords).where(where);
    const rows = await app.db
      .select()
      .from(operatorTrainingRecords)
      .where(where)
      .orderBy(desc(operatorTrainingRecords.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  app.post(
    "/projects/:projectId/training-records/:id/deliver",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          deliveredAt: isoDateSchema.optional(),
          durationHours: z.number().finite().min(0).max(1000).nullable().optional(),
          attendees: z
            .array(
              z.object({
                name: z.string().min(1).max(200),
                organisation: z.string().max(200).nullable().optional(),
                role: z.string().max(200).nullable().optional(),
                userId: idSchema.nullable().optional(),
                signedAt: isoTimestampSchema.nullable().optional(),
              }),
            )
            .max(200),
          competencyAssessed: z.boolean().optional(),
          attendanceSheetFileId: idSchema.nullable().optional(),
          recordingFileId: idSchema.nullable().optional(),
          trainerName: z.string().max(200).nullable().optional(),
        })
        .parse(req.body);
      const rows = await app.db
        .select()
        .from(operatorTrainingRecords)
        .where(
          and(
            eq(operatorTrainingRecords.id, id),
            eq(operatorTrainingRecords.companyId, req.companyId!),
            eq(operatorTrainingRecords.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) throw notFound("Training record not found");
      if (body.attendees.length === 0) {
        throw badRequest(
          "A delivered training session with no attendees records that nobody was trained. If it happened, name who was there.",
        );
      }
      const at = body.deliveredAt ?? todayISO();
      await app.db
        .update(operatorTrainingRecords)
        .set({
          status: "delivered",
          deliveredAt: at,
          durationHours: body.durationHours ?? row.durationHours,
          attendees: body.attendees,
          attendeeCount: body.attendees.length,
          competencyAssessed: body.competencyAssessed ? 1 : row.competencyAssessed,
          attendanceSheetFileId: body.attendanceSheetFileId ?? row.attendanceSheetFileId,
          recordingFileId: body.recordingFileId ?? row.recordingFileId,
          trainerName: body.trainerName ?? row.trainerName,
          updatedAt: nowISO(),
        })
        .where(eq(operatorTrainingRecords.id, id));
      await ledger(app.db, {
        ...scope(req),
        actorId: req.user!.id,
        action: "state_change",
        objectType: "operator_training_record",
        objectId: id,
        payload: { from: row.status, to: "delivered", deliveredAt: at, attendees: body.attendees.length },
        storePayload: true,
      });
      const fresh = await app.db
        .select()
        .from(operatorTrainingRecords)
        .where(eq(operatorTrainingRecords.id, id));
      return fresh[0];
    },
  );

  app.post(
    "/projects/:projectId/training-records/:id/accept",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = z.object({ note: z.string().max(4000).nullable().optional() }).parse(req.body ?? {});
      const rows = await app.db
        .select()
        .from(operatorTrainingRecords)
        .where(
          and(
            eq(operatorTrainingRecords.id, id),
            eq(operatorTrainingRecords.companyId, req.companyId!),
            eq(operatorTrainingRecords.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) throw notFound("Training record not found");
      if (row.status !== "delivered") {
        throw badRequest(
          `${row.reference} is ${row.status}; the owner accepts training that has been delivered.`,
        );
      }
      assertDistinctActor(
        req.user!.id,
        row.createdBy,
        `Acceptance of training ${row.reference}`,
        "recorded",
      );
      const at = nowISO();
      await app.db
        .update(operatorTrainingRecords)
        .set({
          status: "accepted",
          acceptedBy: req.user!.id,
          acceptedAt: at,
          acceptanceNote: body.note ?? null,
          updatedAt: at,
        })
        .where(eq(operatorTrainingRecords.id, id));
      await ledger(app.db, {
        ...scope(req),
        actorId: req.user!.id,
        action: "state_change",
        objectType: "operator_training_record",
        objectId: id,
        payload: { from: "delivered", to: "accepted", acceptedBy: req.user!.id, note: body.note ?? null },
        storePayload: true,
      });
      const fresh = await app.db
        .select()
        .from(operatorTrainingRecords)
        .where(eq(operatorTrainingRecords.id, id));
      return fresh[0];
    },
  );

  /* ================= spares ================= */

  app.post("/projects/:projectId/spare-parts", { preHandler: standardGate }, async (req, reply) => {
    const body = spareCreateSchema.parse(req.body);
    if (body.supplierVendorId) await assertVendor(app.db, req.companyId!, body.supplierVendorId);
    const { number, reference } = await allocateReference(app.db, req.projectId!, "spare_part", "SPR", 4);
    const id = newId("spr");
    const [created] = await app.db
      .insert(spareParts)
      .values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        reference,
        description: body.description,
        category: body.category ?? "operational_spare",
        partNumber: body.partNumber ?? null,
        manufacturer: body.manufacturer ?? null,
        supplierVendorId: body.supplierVendorId ?? null,
        systemId: body.systemId ?? null,
        assetId: body.assetId ?? null,
        turnoverPackageId: body.turnoverPackageId ?? null,
        materialItemId: body.materialItemId ?? null,
        quantityRequired: body.quantityRequired ?? null,
        unit: body.unit ?? null,
        unitCost: body.unitCost ?? null,
        currency: body.currency ?? "USD",
        leadTimeWeeks: body.leadTimeWeeks ?? null,
        storageLocation: body.storageLocation ?? null,
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      ...scope(req),
      actorId: req.user!.id,
      action: "create",
      objectType: "spare_part",
      objectId: id,
      payload: created,
      storePayload: true,
    });
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/spare-parts", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        status: z.enum(SPARE_PART_STATUSES).optional(),
        category: z.enum(SPARE_PART_CATEGORIES).optional(),
        systemId: idSchema.optional(),
        outstandingOnly: z.coerce.boolean().optional(),
      })
      .parse(req.query);
    const clauses = [eq(spareParts.companyId, req.companyId!), eq(spareParts.projectId, req.projectId!)];
    if (q.status) clauses.push(eq(spareParts.status, q.status));
    else if (q.outstandingOnly) {
      clauses.push(inArray(spareParts.status, ["specified", "ordered", "outstanding"]));
    }
    if (q.category) clauses.push(eq(spareParts.category, q.category));
    if (q.systemId) clauses.push(eq(spareParts.systemId, q.systemId));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(spareParts).where(where);
    const rows = await app.db
      .select()
      .from(spareParts)
      .where(where)
      .orderBy(desc(spareParts.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  app.post("/projects/:projectId/spare-parts/:id/receive", { preHandler: standardGate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        quantityDelivered: z.number().finite().min(0),
        deliveredAt: isoDateSchema.optional(),
        storageLocation: z.string().max(200).nullable().optional(),
        note: z.string().max(4000).nullable().optional(),
      })
      .parse(req.body);
    const rows = await app.db
      .select()
      .from(spareParts)
      .where(
        and(
          eq(spareParts.id, id),
          eq(spareParts.companyId, req.companyId!),
          eq(spareParts.projectId, req.projectId!),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Spare part not found");
    const delivered = round2(row.quantityDelivered + body.quantityDelivered);
    const complete = row.quantityRequired !== null && delivered >= row.quantityRequired;
    await app.db
      .update(spareParts)
      .set({
        quantityDelivered: delivered,
        deliveredAt: body.deliveredAt ?? todayISO(),
        storageLocation: body.storageLocation ?? row.storageLocation,
        receivedBy: req.user!.id,
        status: complete ? "delivered" : "outstanding",
        detail: { ...(row.detail as Record<string, unknown>), lastReceiptNote: body.note ?? null },
        updatedAt: nowISO(),
      })
      .where(eq(spareParts.id, id));
    await ledger(app.db, {
      ...scope(req),
      actorId: req.user!.id,
      action: "update",
      objectType: "spare_part",
      objectId: id,
      payload: {
        received: body.quantityDelivered,
        totalDelivered: delivered,
        required: row.quantityRequired,
        status: complete ? "delivered" : "outstanding",
      },
      storePayload: true,
    });
    const fresh = await app.db.select().from(spareParts).where(eq(spareParts.id, id));
    return fresh[0];
  });

  app.post("/projects/:projectId/spare-parts/:id/handover", { preHandler: standardGate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ note: z.string().max(4000).nullable().optional() }).parse(req.body ?? {});
    const rows = await app.db
      .select()
      .from(spareParts)
      .where(
        and(
          eq(spareParts.id, id),
          eq(spareParts.companyId, req.companyId!),
          eq(spareParts.projectId, req.projectId!),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Spare part not found");
    if (row.status !== "delivered") {
      throw badRequest(
        `${row.reference} is ${row.status}; a spare is handed over once it has actually been delivered. ${
          row.quantityRequired !== null
            ? `${row.quantityDelivered} of ${row.quantityRequired} ${row.unit ?? ""} received so far.`
            : ""
        }`,
      );
    }
    const at = nowISO();
    await app.db
      .update(spareParts)
      .set({ status: "handed_over", handedOverAt: at, handoverNote: body.note ?? null, updatedAt: at })
      .where(eq(spareParts.id, id));
    await ledger(app.db, {
      ...scope(req),
      actorId: req.user!.id,
      action: "state_change",
      objectType: "spare_part",
      objectId: id,
      payload: { from: row.status, to: "handed_over", note: body.note ?? null },
      storePayload: true,
    });
    const fresh = await app.db.select().from(spareParts).where(eq(spareParts.id, id));
    return fresh[0];
  });

  /* ================= post-occupancy evaluation ================= */

  app.post("/projects/:projectId/poe", { preHandler: standardGate }, async (req, reply) => {
    const body = poeCreateSchema.parse(req.body);
    const { number, reference } = await allocateReference(app.db, req.projectId!, "poe", "POE");
    const id = newId("poe");
    const [created] = await app.db
      .insert(postOccupancyEvaluations)
      .values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        reference,
        title: body.title,
        poeKind: body.poeKind ?? "soft_landings_review",
        turnoverPackageId: body.turnoverPackageId ?? null,
        systemId: body.systemId ?? null,
        periodStart: body.periodStart ?? null,
        periodEnd: body.periodEnd ?? null,
        scheduledFor: body.scheduledFor ?? null,
        conductedByOrganisation: body.conductedByOrganisation ?? null,
        energyDesignValue: body.energyDesignValue ?? null,
        energyActualValue: body.energyActualValue ?? null,
        energyUnit: body.energyUnit ?? null,
        satisfactionScale: body.satisfactionScale ?? null,
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      ...scope(req),
      actorId: req.user!.id,
      action: "create",
      objectType: "post_occupancy_evaluation",
      objectId: id,
      payload: created,
      storePayload: true,
    });
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/poe", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ status: z.enum(POE_STATUSES).optional(), poeKind: z.enum(POE_KINDS).optional() })
      .parse(req.query);
    const clauses = [
      eq(postOccupancyEvaluations.companyId, req.companyId!),
      eq(postOccupancyEvaluations.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(postOccupancyEvaluations.status, q.status));
    if (q.poeKind) clauses.push(eq(postOccupancyEvaluations.poeKind, q.poeKind));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(postOccupancyEvaluations).where(where);
    const rows = await app.db
      .select()
      .from(postOccupancyEvaluations)
      .where(where)
      .orderBy(desc(postOccupancyEvaluations.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows.map(decoratePoe), Number(totalRow?.n ?? 0), q);
  });

  /** Energy variance is computed from two numbers or reported as unknown. */
  function decoratePoe(row: typeof postOccupancyEvaluations.$inferSelect) {
    const design = row.energyDesignValue;
    const actual = row.energyActualValue;
    const variance =
      design !== null && actual !== null && Math.abs(design) > 1e-9
        ? {
            value: round2(((actual - design) / design) * 100),
            unit: "percent",
            inputs: { design, actual, energyUnit: row.energyUnit },
            reasons: [] as string[],
          }
        : {
            value: null,
            unit: "percent",
            inputs: { design, actual, energyUnit: row.energyUnit },
            reasons: [
              design === null && actual === null
                ? "Neither the design energy figure nor the metered actual is recorded, so the performance gap cannot be reported. It is unknown, not nil."
                : design === null
                  ? "No design energy figure is recorded, so the metered actual has nothing to be compared with."
                  : "No metered actual is recorded yet, so the design figure stands alone.",
            ],
          };
    const responseRate =
      row.surveyResponseCount !== null && row.surveyInviteCount !== null && row.surveyInviteCount > 0
        ? round2((row.surveyResponseCount / row.surveyInviteCount) * 100)
        : null;
    return { ...row, energyVariance: variance, surveyResponseRate: responseRate };
  }

  app.post("/projects/:projectId/poe/:id/complete", { preHandler: standardGate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        completedAt: isoDateSchema.optional(),
        surveyResponseCount: z.number().int().min(0).nullable().optional(),
        surveyInviteCount: z.number().int().min(0).nullable().optional(),
        satisfactionScore: z.number().finite().nullable().optional(),
        energyActualValue: z.number().finite().nullable().optional(),
        defectsRaisedCount: z.number().int().min(0).nullable().optional(),
        warrantyClaimCount: z.number().int().min(0).nullable().optional(),
        findings: z.string().max(20_000).nullable().optional(),
        recommendations: z.string().max(20_000).nullable().optional(),
        reportFileId: idSchema.nullable().optional(),
        lessonId: idSchema.nullable().optional(),
      })
      .parse(req.body ?? {});
    const rows = await app.db
      .select()
      .from(postOccupancyEvaluations)
      .where(
        and(
          eq(postOccupancyEvaluations.id, id),
          eq(postOccupancyEvaluations.companyId, req.companyId!),
          eq(postOccupancyEvaluations.projectId, req.projectId!),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Post-occupancy evaluation not found");
    if (row.status === "complete") throw badRequest(`${row.reference} is already complete.`);
    if (!body.findings && !row.findings) {
      throw badRequest(
        "A completed evaluation must record what it found. An evaluation with no findings is an appointment that was kept, not a study.",
      );
    }
    const at = body.completedAt ?? todayISO();
    await app.db
      .update(postOccupancyEvaluations)
      .set({
        status: "complete",
        completedAt: at,
        conductedBy: req.user!.id,
        surveyResponseCount: body.surveyResponseCount ?? row.surveyResponseCount,
        surveyInviteCount: body.surveyInviteCount ?? row.surveyInviteCount,
        satisfactionScore: body.satisfactionScore ?? row.satisfactionScore,
        energyActualValue: body.energyActualValue ?? row.energyActualValue,
        defectsRaisedCount: body.defectsRaisedCount ?? row.defectsRaisedCount,
        warrantyClaimCount: body.warrantyClaimCount ?? row.warrantyClaimCount,
        findings: body.findings ?? row.findings,
        recommendations: body.recommendations ?? row.recommendations,
        reportFileId: body.reportFileId ?? row.reportFileId,
        lessonId: body.lessonId ?? row.lessonId,
        updatedAt: nowISO(),
      })
      .where(eq(postOccupancyEvaluations.id, id));
    await ledger(app.db, {
      ...scope(req),
      actorId: req.user!.id,
      action: "state_change",
      objectType: "post_occupancy_evaluation",
      objectId: id,
      payload: { from: row.status, to: "complete", completedAt: at, findings: body.findings ?? row.findings },
      storePayload: true,
    });
    const fresh = await app.db
      .select()
      .from(postOccupancyEvaluations)
      .where(eq(postOccupancyEvaluations.id, id));
    return decoratePoe(fresh[0]!);
  });

  /* ================= the closeout dashboard ================= */

  app.get("/projects/:projectId/closeout-summary", { preHandler: readGate }, async (req) => {
    const s = scope(req);
    const [dlps, defects, guarantees, training, spares, poes, packages] = await Promise.all([
      app.db.select().from(defectsLiabilityPeriods).where(and(eq(defectsLiabilityPeriods.companyId, s.companyId), eq(defectsLiabilityPeriods.projectId, s.projectId))),
      app.db.select().from(dlpDefects).where(and(eq(dlpDefects.companyId, s.companyId), eq(dlpDefects.projectId, s.projectId))),
      app.db.select().from(performanceGuarantees).where(and(eq(performanceGuarantees.companyId, s.companyId), eq(performanceGuarantees.projectId, s.projectId))),
      app.db.select().from(operatorTrainingRecords).where(and(eq(operatorTrainingRecords.companyId, s.companyId), eq(operatorTrainingRecords.projectId, s.projectId))),
      app.db.select().from(spareParts).where(and(eq(spareParts.companyId, s.companyId), eq(spareParts.projectId, s.projectId))),
      app.db.select().from(postOccupancyEvaluations).where(and(eq(postOccupancyEvaluations.companyId, s.companyId), eq(postOccupancyEvaluations.projectId, s.projectId))),
      app.db.select().from(turnoverPackages).where(and(eq(turnoverPackages.companyId, s.companyId), eq(turnoverPackages.projectId, s.projectId))),
    ]);
    const today = todayISO();
    const assessed = guarantees.map((g) => ({
      guarantee: asGuarantee(g),
      assessment: assessGuarantee(asGuarantee(g)),
    }));
    const exposure = guaranteeExposure(assessed);
    const defectCosts = totalsByCurrency(defects.map((d) => ({ amount: d.cost, currency: d.currency })));
    const handedOver = packages.filter((p) => p.handedOverAt);
    const packagesWithoutDlp = handedOver.filter(
      (p) => !dlps.some((d) => d.turnoverPackageId === p.id),
    );
    return {
      dlps: {
        total: dlps.length,
        byStatus: dlps.reduce<Record<string, number>>((acc, d) => {
          const st = dlpStanding(d, today).status;
          acc[st] = (acc[st] ?? 0) + 1;
          return acc;
        }, {}),
        expiringWithin60Days: dlps
          .map((d) => ({ row: d, standing: dlpStanding(d, today) }))
          .filter((x) => x.standing.status === "expiring")
          .map((x) => ({
            id: x.row.id,
            reference: x.row.reference,
            name: x.row.name,
            endDate: x.row.extendedToDate ?? x.row.endDate,
            daysRemaining: x.standing.daysRemaining,
            openDefects: x.row.openDefectCount,
          })),
        openDefects: defects.filter((d) =>
          ["reported", "accepted", "disputed", "in_progress"].includes(d.status),
        ).length,
        defectCosts: defectCosts.totals,
        defectCostReasons:
          defectCosts.withoutAmount > 0
            ? [
                `${defectCosts.withoutAmount} defect(s) carry no cost, so the totals are a floor rather than the figure.`,
              ]
            : [],
        handedOverPackagesWithoutAPeriod: packagesWithoutDlp.map((p) => ({
          id: p.id,
          reference: p.reference,
          handedOverAt: p.handedOverAt,
        })),
      },
      guarantees: {
        total: guarantees.length,
        met: assessed.filter((a) => a.assessment.met === true).length,
        notMet: assessed.filter((a) => a.assessment.met === false).length,
        unmeasured: assessed.filter((a) => a.assessment.met === null && a.assessment.status !== "waived").length,
        waived: assessed.filter((a) => a.assessment.status === "waived").length,
        exposure,
      },
      training: {
        total: training.length,
        delivered: training.filter((t) => t.status === "delivered" || t.status === "accepted").length,
        accepted: training.filter((t) => t.status === "accepted").length,
        attendees: training.reduce((n, t) => n + t.attendeeCount, 0),
        outstanding: training.filter((t) => t.status === "planned" || t.status === "scheduled").length,
      },
      spares: {
        total: spares.length,
        handedOver: spares.filter((sp) => sp.status === "handed_over").length,
        outstanding: spares.filter((sp) =>
          ["specified", "ordered", "outstanding"].includes(sp.status),
        ).length,
        byCategory: spares.reduce<Record<string, number>>((acc, sp) => {
          acc[sp.category] = (acc[sp.category] ?? 0) + 1;
          return acc;
        }, {}),
      },
      poe: {
        total: poes.length,
        complete: poes.filter((p) => p.status === "complete").length,
        items: poes.map(decoratePoe).map((p) => ({
          id: p.id,
          reference: p.reference,
          title: p.title,
          poeKind: p.poeKind,
          status: p.status,
          satisfactionScore: p.satisfactionScore,
          energyVariance: p.energyVariance,
        })),
      },
    };
  });
};
