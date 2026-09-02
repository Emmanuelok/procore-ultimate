/**
 * The calibration register (#1097).
 *
 * Commissioning already refuses to record a pass taken on an
 * out-of-calibration instrument. This register is what makes that refusal
 * mean something: the due date is derived from the certificate and the
 * interval rather than typed in, and every calibration event is kept, because
 * the question that follows an instrument failing calibration is "what did we
 * measure with it since it last passed" — and that window is only answerable
 * from the history.
 */

import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray } from "drizzle-orm";
import { z } from "zod";
import { calibratedInstruments, calibrationRecords } from "@constructos/db";
import { CALIBRATION_RESULTS, INSTRUMENT_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import {
  allocateReference,
  alreadySignalled,
  assertVendor,
  buildGates,
  idSchema,
  isoDateSchema,
  ledger,
  nowISO,
  patchSet,
  QUALITY_DETECTORS,
  raiseSignal,
  todayISO,
} from "./shared.js";
import { addMonths, instrumentStanding, readingsInDoubt } from "./calibrationStatus.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const createSchema = z.object({
  name: z.string().min(1).max(200),
  serialNumber: z.string().min(1).max(200),
  instrumentType: z.string().max(200).nullable().optional(),
  manufacturer: z.string().max(200).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  assetTag: z.string().max(100).nullable().optional(),
  equipmentId: idSchema.nullable().optional(),
  ownerVendorId: idSchema.nullable().optional(),
  ownerName: z.string().max(200).nullable().optional(),
  custodian: z.string().max(200).nullable().optional(),
  storageLocation: z.string().max(200).nullable().optional(),
  rangeMin: z.number().finite().nullable().optional(),
  rangeMax: z.number().finite().nullable().optional(),
  rangeUnit: z.string().max(50).nullable().optional(),
  accuracy: z.string().max(200).nullable().optional(),
  calibrationStandard: z.string().max(200).nullable().optional(),
  calibrationIntervalMonths: z.number().int().min(1).max(120).optional(),
  lastCalibratedAt: isoDateSchema.nullable().optional(),
  calibrationDueDate: isoDateSchema.nullable().optional(),
  certificateNumber: z.string().max(200).nullable().optional(),
  certificateFileId: idSchema.nullable().optional(),
  calibratedByOrganisation: z.string().max(200).nullable().optional(),
  calibrationAccreditation: z.string().max(200).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const PATCH_COLUMNS = [
  "name",
  "instrumentType",
  "manufacturer",
  "model",
  "assetTag",
  "equipmentId",
  "ownerVendorId",
  "ownerName",
  "custodian",
  "storageLocation",
  "rangeMin",
  "rangeMax",
  "rangeUnit",
  "accuracy",
  "calibrationStandard",
  "calibrationIntervalMonths",
  "detail",
] as const;

const calibrateSchema = z.object({
  calibratedAt: isoDateSchema,
  result: z.enum(CALIBRATION_RESULTS).optional(),
  calibrationDueDate: isoDateSchema.nullable().optional(),
  asFoundCondition: z.string().max(2000).nullable().optional(),
  asLeftCondition: z.string().max(2000).nullable().optional(),
  deviationFound: z.number().finite().nullable().optional(),
  certificateNumber: z.string().max(200).nullable().optional(),
  certificateFileId: idSchema.nullable().optional(),
  calibratedByOrganisation: z.string().max(200).nullable().optional(),
  technicianName: z.string().max(200).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

/* ------------------------------------------------------------------ */
/* Sweep                                                               */
/* ------------------------------------------------------------------ */

export async function sweepCalibration(
  db: Db,
  companyId: string,
  asOf: string = todayISO(),
): Promise<{ raised: number; moved: number }> {
  /*
   * Only the statuses that date arithmetic governs. `retired`, `lost`,
   * `out_of_service` and `under_calibration` are decisions somebody made and
   * the sweep leaves them alone; `overdue` is included because an instrument
   * that was already overdue when it was registered has still never had its
   * signal raised, and the signal key makes the second pass a no-op.
   */
  const all = await db
    .select()
    .from(calibratedInstruments)
    .where(
      and(
        eq(calibratedInstruments.companyId, companyId),
        inArray(calibratedInstruments.status, ["in_service", "due_soon", "overdue"]),
      ),
    );
  if (all.length === 0) return { raised: 0, moved: 0 };
  const seen = await alreadySignalled(db, companyId, QUALITY_DETECTORS.calibrationOverdue);
  let raised = 0;
  let moved = 0;
  for (const row of all) {
    const standing = instrumentStanding(row, asOf);
    if (standing.status !== row.status) {
      await db
        .update(calibratedInstruments)
        .set({ status: standing.status, updatedAt: nowISO() })
        .where(eq(calibratedInstruments.id, row.id));
      moved += 1;
    }
    if (standing.status !== "overdue" || seen.has(row.id)) continue;
    seen.add(row.id);
    const signalId = await raiseSignal(db, companyId, row.projectId, null, {
      detector: QUALITY_DETECTORS.calibrationOverdue,
      severity: "high",
      confidence: 1,
      title: `${row.reference} ${row.name} is out of calibration`,
      explanation:
        `${row.name} (serial ${row.serialNumber}) is out of calibration. ${standing.reasons.join(" ")} ` +
        `A reading taken with an out-of-calibration instrument is not a reading, and it is the first thing an auditor checks against a test ` +
        `certificate. Any test recorded with this instrument since its calibration ran out has to be reviewed, and the instrument withdrawn ` +
        `from use until it is recalibrated.`,
      key: row.id,
      evidence: {
        instrumentId: row.id,
        reference: row.reference,
        serialNumber: row.serialNumber,
        calibrationDueDate: row.calibrationDueDate,
        derivedDueDate: standing.derivedDueDate,
        lastCalibratedAt: row.lastCalibratedAt,
        daysOverdue: standing.daysUntilDue === null ? null : Math.abs(standing.daysUntilDue),
      },
    });
    await db
      .update(calibratedInstruments)
      .set({ signalId, updatedAt: nowISO() })
      .where(eq(calibratedInstruments.id, row.id));
    raised += 1;
  }
  return { raised, moved };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const calibrationRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);

  async function fetchOr404(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(calibratedInstruments)
      .where(
        and(
          eq(calibratedInstruments.id, id),
          eq(calibratedInstruments.companyId, companyId),
          eq(calibratedInstruments.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Instrument not found");
    return rows[0];
  }

  const decorate = (row: typeof calibratedInstruments.$inferSelect) => ({
    ...row,
    standing: instrumentStanding(row, todayISO()),
  });

  app.post("/projects/:projectId/instruments", { preHandler: standardGate }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    if (body.ownerVendorId) await assertVendor(app.db, req.companyId!, body.ownerVendorId);
    const dupe = await app.db
      .select({ id: calibratedInstruments.id })
      .from(calibratedInstruments)
      .where(
        and(
          eq(calibratedInstruments.projectId, req.projectId!),
          eq(calibratedInstruments.serialNumber, body.serialNumber),
        ),
      )
      .limit(1);
    if (dupe[0]) {
      throw conflict(
        `An instrument with serial ${body.serialNumber} is already registered on this project. The serial is how a reading is traced back to a certificate, so it identifies the instrument.`,
      );
    }
    const { number, reference } = await allocateReference(
      app.db,
      req.projectId!,
      "instrument",
      "CAL",
    );
    const interval = body.calibrationIntervalMonths ?? 12;
    const derived =
      body.lastCalibratedAt ? addMonths(body.lastCalibratedAt, interval) : null;
    const id = newId("cal");
    const [created] = await app.db
      .insert(calibratedInstruments)
      .values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        reference,
        name: body.name,
        instrumentType: body.instrumentType ?? null,
        manufacturer: body.manufacturer ?? null,
        model: body.model ?? null,
        serialNumber: body.serialNumber,
        assetTag: body.assetTag ?? null,
        equipmentId: body.equipmentId ?? null,
        ownerVendorId: body.ownerVendorId ?? null,
        ownerName: body.ownerName ?? null,
        custodian: body.custodian ?? null,
        storageLocation: body.storageLocation ?? null,
        rangeMin: body.rangeMin ?? null,
        rangeMax: body.rangeMax ?? null,
        rangeUnit: body.rangeUnit ?? null,
        accuracy: body.accuracy ?? null,
        calibrationStandard: body.calibrationStandard ?? null,
        calibrationIntervalMonths: interval,
        lastCalibratedAt: body.lastCalibratedAt ?? null,
        calibrationDueDate: body.calibrationDueDate ?? derived,
        certificateNumber: body.certificateNumber ?? null,
        certificateFileId: body.certificateFileId ?? null,
        calibratedByOrganisation: body.calibratedByOrganisation ?? null,
        calibrationAccreditation: body.calibrationAccreditation ?? null,
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      })
      .returning();
    const standing = instrumentStanding(created!, todayISO());
    if (standing.status !== created!.status) {
      await app.db
        .update(calibratedInstruments)
        .set({ status: standing.status, updatedAt: nowISO() })
        .where(eq(calibratedInstruments.id, id));
    }
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "calibrated_instrument",
      objectId: id,
      payload: created,
      storePayload: true,
    });
    return reply.status(201).send({ ...created, status: standing.status, standing });
  });

  app.get("/projects/:projectId/instruments", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        status: z.enum(INSTRUMENT_STATUSES).optional(),
        search: z.string().max(200).optional(),
        dueOnly: z.coerce.boolean().optional(),
      })
      .parse(req.query);
    const clauses = [
      eq(calibratedInstruments.companyId, req.companyId!),
      eq(calibratedInstruments.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(calibratedInstruments.status, q.status));
    if (q.search) clauses.push(ilike(calibratedInstruments.name, `%${q.search}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(calibratedInstruments).where(where);
    const rows = await app.db
      .select()
      .from(calibratedInstruments)
      .where(where)
      .orderBy(asc(calibratedInstruments.calibrationDueDate))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const decorated = rows.map(decorate);
    return paginate(
      q.dueOnly
        ? decorated.filter((r) => r.standing.status === "overdue" || r.standing.status === "due_soon")
        : decorated,
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.get("/projects/:projectId/instruments/:id", { preHandler: readGate }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await fetchOr404(id, req.companyId!, req.projectId!);
    const history = await app.db
      .select()
      .from(calibrationRecords)
      .where(eq(calibrationRecords.instrumentId, id))
      .orderBy(desc(calibrationRecords.calibratedAt));
    return { ...decorate(row), history };
  });

  app.patch("/projects/:projectId/instruments/:id", { preHandler: standardGate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = createSchema.partial().parse(req.body);
    const row = await fetchOr404(id, req.companyId!, req.projectId!);
    if (body.ownerVendorId) await assertVendor(app.db, req.companyId!, body.ownerVendorId);
    await app.db
      .update(calibratedInstruments)
      .set(patchSet(body as Record<string, unknown>, PATCH_COLUMNS))
      .where(eq(calibratedInstruments.id, id));
    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "calibrated_instrument",
      objectId: id,
      payload: { changed: Object.keys(body) },
    });
    void row;
    return decorate(await fetchOr404(id, req.companyId!, req.projectId!));
  });

  /**
   * Record a calibration. A `fail` result names the window of readings put in
   * doubt rather than leaving somebody to work it out from paper.
   */
  app.post(
    "/projects/:projectId/instruments/:id/calibrate",
    { preHandler: standardGate },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = calibrateSchema.parse(req.body);
      const row = await fetchOr404(id, req.companyId!, req.projectId!);
      const result = body.result ?? "pass";
      const due =
        body.calibrationDueDate ?? addMonths(body.calibratedAt, row.calibrationIntervalMonths);
      const recordId = newId("clr");
      await app.db.insert(calibrationRecords).values({
        id: recordId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        instrumentId: id,
        calibratedAt: body.calibratedAt,
        calibrationDueDate: due,
        result,
        asFoundCondition: body.asFoundCondition ?? null,
        asLeftCondition: body.asLeftCondition ?? null,
        deviationFound: body.deviationFound ?? null,
        certificateNumber: body.certificateNumber ?? null,
        certificateFileId: body.certificateFileId ?? null,
        calibratedByOrganisation: body.calibratedByOrganisation ?? null,
        technicianName: body.technicianName ?? null,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      });
      const history = await app.db
        .select()
        .from(calibrationRecords)
        .where(eq(calibrationRecords.instrumentId, id));
      const doubt =
        result === "fail"
          ? readingsInDoubt(
              history.map((h) => ({ calibratedAt: h.calibratedAt, result: h.result })),
              body.calibratedAt,
            )
          : null;
      const nextStatus = result === "fail" ? "out_of_service" : "in_service";
      await app.db
        .update(calibratedInstruments)
        .set({
          lastCalibratedAt: result === "fail" ? row.lastCalibratedAt : body.calibratedAt,
          calibrationDueDate: result === "fail" ? row.calibrationDueDate : due,
          certificateNumber: body.certificateNumber ?? row.certificateNumber,
          certificateFileId: body.certificateFileId ?? row.certificateFileId,
          calibratedByOrganisation: body.calibratedByOrganisation ?? row.calibratedByOrganisation,
          status: nextStatus,
          outOfServiceReason:
            result === "fail"
              ? `Found out of tolerance at calibration on ${body.calibratedAt}${body.asFoundCondition ? `: ${body.asFoundCondition}` : ""}`
              : null,
          updatedAt: nowISO(),
        })
        .where(eq(calibratedInstruments.id, id));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "calibration_record",
        objectId: recordId,
        payload: {
          instrumentId: id,
          calibratedAt: body.calibratedAt,
          result,
          dueDate: due,
          asFound: body.asFoundCondition ?? null,
          readingsInDoubt: doubt,
        },
        storePayload: true,
      });
      const fresh = await fetchOr404(id, req.companyId!, req.projectId!);
      return reply.status(201).send({ ...decorate(fresh), readingsInDoubt: doubt });
    },
  );

  app.post(
    "/projects/:projectId/instruments/:id/status",
    { preHandler: standardGate },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          status: z.enum(["in_service", "out_of_service", "under_calibration", "lost", "retired"]),
          reason: z.string().max(4000).nullable().optional(),
        })
        .parse(req.body);
      const row = await fetchOr404(id, req.companyId!, req.projectId!);
      if (body.status !== "in_service" && !body.reason) {
        throw badRequest(
          "Taking an instrument out of service is a decision that affects every reading it was used for; it must carry a reason.",
        );
      }
      await app.db
        .update(calibratedInstruments)
        .set({
          status: body.status,
          outOfServiceReason: body.status === "in_service" ? null : (body.reason ?? null),
          updatedAt: nowISO(),
        })
        .where(eq(calibratedInstruments.id, id));
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "calibrated_instrument",
        objectId: id,
        payload: { from: row.status, to: body.status, reason: body.reason ?? null },
        storePayload: true,
      });
      return decorate(await fetchOr404(id, req.companyId!, req.projectId!));
    },
  );

  app.post("/projects/:projectId/instruments/sweep", { preHandler: standardGate }, async (req) => {
    const body = z.object({ asOf: isoDateSchema.optional() }).parse(req.body ?? {});
    return sweepCalibration(app.db, req.companyId!, body.asOf ?? todayISO());
  });

  app.get("/projects/:projectId/instruments-summary", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(calibratedInstruments)
      .where(
        and(
          eq(calibratedInstruments.companyId, req.companyId!),
          eq(calibratedInstruments.projectId, req.projectId!),
        ),
      );
    const today = todayISO();
    const standings = rows.map((r) => ({ row: r, standing: instrumentStanding(r, today) }));
    const byStatus: Record<string, number> = {};
    for (const s of standings) byStatus[s.standing.status] = (byStatus[s.standing.status] ?? 0) + 1;
    return {
      total: rows.length,
      byStatus,
      overdue: standings.filter((s) => s.standing.status === "overdue").length,
      dueSoon: standings.filter((s) => s.standing.status === "due_soon").length,
      unusable: standings.filter((s) => !s.standing.usable).length,
      withoutCertificate: rows.filter((r) => !r.certificateFileId && !r.certificateNumber).length,
      items: standings.map((s) => ({
        id: s.row.id,
        reference: s.row.reference,
        name: s.row.name,
        serialNumber: s.row.serialNumber,
        calibrationDueDate: s.row.calibrationDueDate,
        status: s.standing.status,
        daysUntilDue: s.standing.daysUntilDue,
        usable: s.standing.usable,
        reasons: s.standing.reasons,
      })),
    };
  });
};
