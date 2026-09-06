/**
 * Environment, biodiversity, design-option carbon and disclosure — spec
 * Vol II Domain I #491, #502-504, #541-546 and the environmental half of the
 * ESG brief.
 *
 * WHAT IS HERE
 *
 *  - Monitoring points and readings. A consent condition sets a limit in a
 *    medium and a direction: a dust limit is a ceiling, a dissolved-oxygen
 *    limit is a floor. Exceedance is computed and stored at write, so the
 *    exceedance register is an indexed query rather than a scan, and a
 *    reading against a point with no limit is logged as a BASELINE
 *    observation with no compliance conclusion drawn from it.
 *
 *  - Environmental incidents with the regulator notification clock. The
 *    scheduled detector raises a finding when a reportable incident passes
 *    the statutory window unnotified — that window, not the closure of the
 *    incident, is what a regulator prosecutes on.
 *
 *  - Biodiversity units on the Defra metric shape (area × distinctiveness ×
 *    condition × strategic significance) with a net-gain test against the
 *    baseline. No baseline means no gain figure — reported as unavailable
 *    with the reason, never as zero.
 *
 *  - Design-option carbon comparison and marginal abatement cost (#502-504).
 *    An unpriced option is NOT ranked as though it were free: it is listed
 *    with the reason it could not be priced.
 *
 *  - Transport carbon legs (A4/A5) against a code-resident factor library,
 *    each leg optionally booked as a carbon entry so it lands in the same
 *    footprint as everything else rather than in a parallel spreadsheet.
 *
 *  - ISO 14001 EMS evidence register, one row per clause.
 *
 *  - Period disclosure assembly (CSRD/ESRS E1 & E5, IFRS S2, TCFD, GHG
 *    Protocol, modern slavery). Every datapoint carries its basis and its
 *    sources; a figure the platform cannot evidence is reported as
 *    unavailable with the reason.
 *
 *  - The GIA writer. `/carbon/summary` has always reported intensity per m²
 *    GIA — the RICS reporting unit — from `projects.settings.gia`, and
 *    nothing in the product ever wrote that key, so the headline KPI showed
 *    "GIA not set" with a hint nobody could follow.
 */

import type { FastifyInstance } from "fastify";
import { and, asc, count, desc, eq, gte, inArray, lte, max } from "drizzle-orm";
import { z } from "zod";
import {
  biodiversityUnits as biodiversityUnitsTable,
  carbonBudgets,
  carbonEntries,
  carbonFactors,
  carbonOptions,
  carbonTransportLegs,
  emsRecords,
  environmentalIncidents,
  esgDisclosures,
  grievances,
  ledgerEntries,
  monitoringPoints,
  monitoringReadings,
  obligations,
  projects,
  socialValueCommitments,
  socialValueDeliveries,
  wasteRecords,
  workers,
} from "@constructos/db";
import {
  BIODIVERSITY_STAGES,
  CARBON_OPTION_DECISIONS,
  CARBON_TRANSPORT_MODES,
  DISCLOSURE_FRAMEWORKS,
  EMS_EVIDENCE_STATUSES,
  ENVIRONMENTAL_INCIDENT_KINDS,
  ENVIRONMENTAL_INCIDENT_STATUSES,
  ENVIRONMENTAL_MEDIA,
  HABITAT_CONDITIONS,
  ISO14001_CLAUSES,
  LIMIT_DIRECTIONS,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema, todayISO } from "../field/dates.js";
import { percent, round2, round6 } from "./carbon.js";
import {
  TRANSPORT_FACTORS,
  biodiversityUnits as computeBiodiversityUnits,
  buildMacc,
  checkLimit,
  computeNetGain,
  computeTransportLeg,
  conditionScoreFor,
  type OptionInput,
} from "./environment.js";
import { assembleDisclosure, type DisclosureInputs } from "./disclosure.js";
import { REGULATOR_NOTIFICATION_HOURS } from "./detectors.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const pointCreateSchema = z.object({
  name: z.string().min(1).max(200),
  medium: z.enum(ENVIRONMENTAL_MEDIA),
  parameter: z.string().min(1).max(120),
  unit: z.string().min(1).max(40),
  limitValue: z.number().finite().nullable().optional(),
  limitDirection: z.enum(LIMIT_DIRECTIONS).optional(),
  limitBasis: z.string().max(4000).nullable().optional(),
  permitId: z.string().min(1).nullable().optional(),
  locationId: z.string().min(1).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  frequency: z.enum(["continuous", "daily", "weekly", "monthly", "ad_hoc"]).nullable().optional(),
});

const pointPatchSchema = pointCreateSchema.partial().extend({
  active: z.boolean().optional(),
});

const readingCreateSchema = z.object({
  readingAt: isoDateSchema,
  value: z.number().finite(),
  method: z.string().max(200).nullable().optional(),
  instrument: z.string().max(200).nullable().optional(),
  evidenceIds: z.array(z.string().min(1)).max(100).optional(),
  note: z.string().max(10000).nullable().optional(),
});

const incidentCreateSchema = z.object({
  kind: z.enum(ENVIRONMENTAL_INCIDENT_KINDS),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  occurredAt: isoDateSchema,
  discoveredAt: isoDateSchema.nullable().optional(),
  locationId: z.string().min(1).nullable().optional(),
  description: z.string().min(1).max(20000),
  quantity: z.number().finite().nonnegative().nullable().optional(),
  unit: z.string().max(40).nullable().optional(),
  medium: z.enum(ENVIRONMENTAL_MEDIA).nullable().optional(),
  reportableToRegulator: z.boolean().optional(),
  regulator: z.string().max(200).nullable().optional(),
  evidenceIds: z.array(z.string().min(1)).max(100).optional(),
});

const incidentNotifySchema = z.object({
  regulator: z.string().min(1).max(200),
  notifiedAt: z.string().datetime().optional(),
  reference: z.string().max(200).nullable().optional(),
});

const incidentStatusSchema = z.object({
  status: z.enum(ENVIRONMENTAL_INCIDENT_STATUSES),
  rootCause: z.string().max(20000).nullable().optional(),
  correctiveActions: z
    .array(
      z.object({
        text: z.string().min(1).max(4000),
        owner: z.string().max(200).nullable().optional(),
        dueDate: isoDateSchema.nullable().optional(),
      }),
    )
    .max(100)
    .optional(),
  note: z.string().max(10000).nullable().optional(),
});

const biodiversitySchema = z.object({
  stage: z.enum(BIODIVERSITY_STAGES),
  habitatType: z.string().min(1).max(200),
  areaHectares: z.number().finite().positive(),
  distinctiveness: z.number().finite().min(0).max(10),
  condition: z.enum(HABITAT_CONDITIONS).optional(),
  strategicSignificance: z.number().finite().min(0).max(5).optional(),
  surveyDate: isoDateSchema.nullable().optional(),
  surveyor: z.string().max(200).nullable().optional(),
  evidenceIds: z.array(z.string().min(1)).max(100).optional(),
  note: z.string().max(10000).nullable().optional(),
});

const optionCreateSchema = z.object({
  studyRef: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  description: z.string().max(20000).nullable().optional(),
  element: z.string().max(200).nullable().optional(),
  isBaseline: z.boolean().optional(),
  tco2e: z.number().finite().nonnegative(),
  cost: z.number().finite().nullable().optional(),
  currency: z.string().length(3).optional(),
});

const optionDecisionSchema = z.object({
  decision: z.enum(CARBON_OPTION_DECISIONS),
  note: z.string().max(20000).nullable().optional(),
});

const transportLegSchema = z.object({
  description: z.string().min(1).max(300),
  origin: z.string().max(200).nullable().optional(),
  destination: z.string().max(200).nullable().optional(),
  mode: z.enum(CARBON_TRANSPORT_MODES),
  distanceKm: z.number().finite().positive(),
  payloadTonnes: z.number().finite().positive(),
  trips: z.number().int().positive().max(100000).optional(),
  factorOverride: z.number().finite().positive().nullable().optional(),
  factorSourceOverride: z.string().max(200).nullable().optional(),
  lifecycleModule: z.enum(["A4", "A5", "C2"]).optional(),
  legDate: isoDateSchema,
  budgetId: z.string().min(1).nullable().optional(),
  /** book the leg into the project footprint as a carbon entry */
  createEntry: z.boolean().optional(),
});

const emsSchema = z.object({
  clause: z.enum(ISO14001_CLAUSES),
  requirement: z.string().min(1).max(4000),
  status: z.enum(EMS_EVIDENCE_STATUSES).optional(),
  ownerId: z.string().min(1).nullable().optional(),
  evidenceIds: z.array(z.string().min(1)).max(100).optional(),
  fileIds: z.array(z.string().min(1)).max(100).optional(),
  lastReviewedAt: isoDateSchema.nullable().optional(),
  nextReviewDueAt: isoDateSchema.nullable().optional(),
  note: z.string().max(20000).nullable().optional(),
});

const emsPatchSchema = emsSchema.partial().omit({ clause: true });

const disclosureSchema = z.object({
  framework: z.enum(DISCLOSURE_FRAMEWORKS),
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  /** false previews the return without storing it */
  commit: z.boolean().optional(),
});

const giaSchema = z.object({
  /** gross internal area in m², the RICS reporting unit for intensity */
  giaSqm: z.number().finite().positive().max(100_000_000).nullable(),
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export function registerEnvironmentRoutes(app: FastifyInstance): void {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("esg", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("esg", "standard")];

  async function fetchPoint(pointId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(monitoringPoints)
      .where(
        and(
          eq(monitoringPoints.id, pointId),
          eq(monitoringPoints.companyId, companyId),
          eq(monitoringPoints.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Monitoring point not found");
    return rows[0];
  }

  async function fetchIncident(incidentId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(environmentalIncidents)
      .where(
        and(
          eq(environmentalIncidents.id, incidentId),
          eq(environmentalIncidents.companyId, companyId),
          eq(environmentalIncidents.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Environmental incident not found");
    return rows[0];
  }

  /* ================================================================ */
  /* Reference                                                         */
  /* ================================================================ */

  app.get("/esg/environment/reference", { preHandler: [app.authenticate] }, async () => ({
    media: ENVIRONMENTAL_MEDIA,
    limitDirections: LIMIT_DIRECTIONS,
    incidentKinds: ENVIRONMENTAL_INCIDENT_KINDS,
    biodiversityStages: BIODIVERSITY_STAGES,
    habitatConditions: HABITAT_CONDITIONS,
    transportModes: TRANSPORT_FACTORS,
    iso14001Clauses: ISO14001_CLAUSES,
    disclosureFrameworks: DISCLOSURE_FRAMEWORKS,
    regulatorNotificationHours: REGULATOR_NOTIFICATION_HOURS,
  }));

  /* ================================================================ */
  /* Monitoring points and readings                                    */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/monitoring-points",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = pointCreateSchema.parse(req.body);
      const id = newId("mpt");
      await app.db.insert(monitoringPoints).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        name: body.name,
        medium: body.medium,
        parameter: body.parameter,
        unit: body.unit,
        limitValue: body.limitValue ?? null,
        limitDirection: body.limitDirection ?? "max",
        limitBasis: body.limitBasis ?? null,
        permitId: body.permitId ?? null,
        locationId: body.locationId ?? null,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        frequency: body.frequency ?? null,
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "monitoring_point",
        objectId: id,
        projectId: req.projectId!,
        payload: {
          name: body.name,
          medium: body.medium,
          parameter: body.parameter,
          unit: body.unit,
          limitValue: body.limitValue ?? null,
          limitDirection: body.limitDirection ?? "max",
          limitBasis: body.limitBasis ?? null,
        },
        storePayload: true,
      });
      return reply.status(201).send(await fetchPoint(id, req.companyId!, req.projectId!));
    },
  );

  app.get("/projects/:projectId/monitoring-points", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ medium: z.enum(ENVIRONMENTAL_MEDIA).optional() })
      .parse(req.query);
    const clauses = [
      eq(monitoringPoints.companyId, req.companyId!),
      eq(monitoringPoints.projectId, req.projectId!),
    ];
    if (q.medium) clauses.push(eq(monitoringPoints.medium, q.medium));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(monitoringPoints).where(where);
    const rows = await app.db
      .select()
      .from(monitoringPoints)
      .where(where)
      .orderBy(asc(monitoringPoints.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const ids = rows.map((r) => r.id);
    const latest = ids.length
      ? await app.db
          .select({
            pointId: monitoringReadings.pointId,
            lastAt: max(monitoringReadings.readingAt),
            readings: count(),
          })
          .from(monitoringReadings)
          .where(inArray(monitoringReadings.pointId, ids))
          .groupBy(monitoringReadings.pointId)
      : [];
    const exceedances = ids.length
      ? await app.db
          .select({ pointId: monitoringReadings.pointId, n: count() })
          .from(monitoringReadings)
          .where(
            and(
              inArray(monitoringReadings.pointId, ids),
              eq(monitoringReadings.exceedance, 1),
            ),
          )
          .groupBy(monitoringReadings.pointId)
      : [];
    const lastByPoint = new Map(latest.map((l) => [l.pointId, l]));
    const excByPoint = new Map(exceedances.map((e) => [e.pointId, Number(e.n)]));
    return paginate(
      rows.map((r) => ({
        ...r,
        activeBool: r.active === 1,
        readingCount: Number(lastByPoint.get(r.id)?.readings ?? 0),
        lastReadingAt: lastByPoint.get(r.id)?.lastAt ?? null,
        exceedanceCount: excByPoint.get(r.id) ?? 0,
        // a point with no limit measures; it does not judge
        hasLimit: r.limitValue != null,
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.patch(
    "/projects/:projectId/monitoring-points/:pointId",
    { preHandler: standardGate },
    async (req) => {
      const { pointId } = req.params as { pointId: string };
      const body = pointPatchSchema.parse(req.body);
      const point = await fetchPoint(pointId, req.companyId!, req.projectId!);
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const key of [
        "name",
        "medium",
        "parameter",
        "unit",
        "limitValue",
        "limitDirection",
        "limitBasis",
        "permitId",
        "locationId",
        "latitude",
        "longitude",
        "frequency",
      ] as const) {
        if (body[key] !== undefined) {
          patch[key] = body[key];
          before[key] = (point as Record<string, unknown>)[key];
          after[key] = body[key];
        }
      }
      if (body.active !== undefined) {
        patch["active"] = body.active ? 1 : 0;
        before["active"] = point.active === 1;
        after["active"] = body.active;
      }
      await app.db.update(monitoringPoints).set(patch).where(eq(monitoringPoints.id, pointId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "monitoring_point",
        objectId: pointId,
        projectId: req.projectId!,
        // a limit that moved changes which historic readings were breaches
        payload: { before, after },
        storePayload: true,
      });
      return fetchPoint(pointId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/monitoring-points/:pointId/readings",
    { preHandler: standardGate },
    async (req, reply) => {
      const { pointId } = req.params as { pointId: string };
      const body = readingCreateSchema.parse(req.body);
      const point = await fetchPoint(pointId, req.companyId!, req.projectId!);
      // computed and stored at write, so the exceedance register is indexed
      const check = checkLimit(body.value, point.limitValue, point.limitDirection, point.unit);
      const id = newId("mrd");
      await app.db.insert(monitoringReadings).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        pointId,
        readingAt: body.readingAt,
        value: body.value,
        exceedance: check.exceedance ? 1 : 0,
        exceedanceBy: check.exceedanceBy,
        method: body.method ?? null,
        instrument: body.instrument ?? null,
        evidenceIds: body.evidenceIds ?? [],
        note: body.note ?? null,
        recordedBy: req.user!.id,
      });
      if (check.exceedance) {
        // The finding is the detector's job; the ledger entry is the record
        // that a breach was measured, which belongs to whoever measured it.
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "environmental_reading",
          objectId: id,
          projectId: req.projectId!,
          payload: {
            pointId,
            pointName: point.name,
            parameter: point.parameter,
            value: body.value,
            limitValue: point.limitValue,
            limitDirection: point.limitDirection,
            exceedanceBy: check.exceedanceBy,
            limitBasis: point.limitBasis,
            basis: check.basis,
          },
          storePayload: true,
        });
      }
      const created = await app.db
        .select()
        .from(monitoringReadings)
        .where(eq(monitoringReadings.id, id))
        .limit(1);
      return reply.status(201).send({ ...created[0], ...check });
    },
  );

  app.get(
    "/projects/:projectId/monitoring-points/:pointId/readings",
    { preHandler: readGate },
    async (req) => {
      const { pointId } = req.params as { pointId: string };
      const q = pageQuerySchema
        .extend({ from: isoDateSchema.optional(), to: isoDateSchema.optional() })
        .parse(req.query);
      const point = await fetchPoint(pointId, req.companyId!, req.projectId!);
      const clauses = [eq(monitoringReadings.pointId, pointId)];
      if (q.from) clauses.push(gte(monitoringReadings.readingAt, q.from));
      if (q.to) clauses.push(lte(monitoringReadings.readingAt, q.to));
      const where = and(...clauses);
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(monitoringReadings)
        .where(where);
      const rows = await app.db
        .select()
        .from(monitoringReadings)
        .where(where)
        .orderBy(desc(monitoringReadings.readingAt))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return {
        point,
        ...paginate(
          rows.map((r) => ({
            ...r,
            exceedanceBool: r.exceedance === 1,
            percentOfLimit:
              point.limitValue != null && point.limitValue !== 0
                ? round2((r.value / point.limitValue) * 100)
                : null,
          })),
          Number(totalRow?.n ?? 0),
          q,
        ),
      };
    },
  );

  app.get("/projects/:projectId/environment/summary", { preHandler: readGate }, async (req) => {
    const points = await app.db
      .select()
      .from(monitoringPoints)
      .where(
        and(
          eq(monitoringPoints.companyId, req.companyId!),
          eq(monitoringPoints.projectId, req.projectId!),
        ),
      );
    const [readingRow] = await app.db
      .select({ n: count() })
      .from(monitoringReadings)
      .where(
        and(
          eq(monitoringReadings.companyId, req.companyId!),
          eq(monitoringReadings.projectId, req.projectId!),
        ),
      );
    const [excRow] = await app.db
      .select({ n: count() })
      .from(monitoringReadings)
      .where(
        and(
          eq(monitoringReadings.companyId, req.companyId!),
          eq(monitoringReadings.projectId, req.projectId!),
          eq(monitoringReadings.exceedance, 1),
        ),
      );
    const incidents = await app.db
      .select()
      .from(environmentalIncidents)
      .where(
        and(
          eq(environmentalIncidents.companyId, req.companyId!),
          eq(environmentalIncidents.projectId, req.projectId!),
        ),
      );
    const habitats = await app.db
      .select()
      .from(biodiversityUnitsTable)
      .where(
        and(
          eq(biodiversityUnitsTable.companyId, req.companyId!),
          eq(biodiversityUnitsTable.projectId, req.projectId!),
        ),
      );
    const sumStage = (stage: string) =>
      round2(habitats.filter((h) => h.stage === stage).reduce((s, h) => s + h.units, 0));
    const baseline = sumStage("baseline");
    const post = sumStage("post_intervention");
    const targetUnits = habitats.some((h) => h.stage === "target") ? sumStage("target") : null;
    const netGain =
      habitats.length > 0
        ? computeNetGain({
            baselineUnits: baseline,
            postInterventionUnits: post,
            targetUnits,
          })
        : null;
    const reportable = incidents.filter((i) => i.reportableToRegulator === 1);
    const readings = Number(readingRow?.n ?? 0);
    const exceedances = Number(excRow?.n ?? 0);
    return {
      monitoring: {
        points: points.length,
        pointsWithLimit: points.filter((p) => p.limitValue != null).length,
        readings,
        exceedances,
        exceedancePercent: percent(exceedances, readings),
        byMedium: ENVIRONMENTAL_MEDIA.map((medium) => ({
          medium,
          points: points.filter((p) => p.medium === medium).length,
        })).filter((m) => m.points > 0),
      },
      incidents: {
        total: incidents.length,
        open: incidents.filter((i) => i.status === "open").length,
        reportable: reportable.length,
        notified: reportable.filter((i) => i.regulatorNotifiedAt != null).length,
        awaitingNotification: reportable.filter((i) => i.regulatorNotifiedAt == null).length,
        byKind: ENVIRONMENTAL_INCIDENT_KINDS.map((kind) => ({
          kind,
          n: incidents.filter((i) => i.kind === kind).length,
        })).filter((k) => k.n > 0),
      },
      biodiversity: netGain
        ? { ...netGain, habitats: habitats.length }
        : {
            habitats: 0,
            unavailableReason:
              "No habitat units are recorded on this project, so no biodiversity position " +
              "can be stated.",
          },
    };
  });

  /* ================================================================ */
  /* Environmental incidents                                           */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/environmental-incidents",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = incidentCreateSchema.parse(req.body);
      const id = newId("ein");
      const reportable = body.reportableToRegulator === true;
      await app.db.transaction(async (tx) => {
        const number = await nextRecordNumber(tx, req.projectId!, "environmental_incident");
        let obligationId: string | null = null;
        if (reportable) {
          /*
           * The statutory notification window is a deadline, so it becomes an
           * Obligation: the clock runs from the incident, and the assurance
           * register sees the same date the detector does.
           */
          obligationId = newId("obl");
          const deadline = new Date(
            Date.parse(`${body.occurredAt}T00:00:00Z`) +
              REGULATOR_NOTIFICATION_HOURS * 3_600_000,
          ).toISOString();
          await tx.insert(obligations).values({
            id: obligationId,
            companyId: req.companyId!,
            projectId: req.projectId!,
            sourceClause: `Environmental permit / statutory reporting — incident EI-${number}`,
            trigger: `${body.kind} incident on ${body.occurredAt}, reportable to the regulator`,
            deadline,
            warnDaysBefore: 1,
            evidenceRequirement:
              "Regulator notification reference and a copy of the notification",
            status: "open",
            createdBy: req.user!.id,
          });
        }
        await tx.insert(environmentalIncidents).values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          number,
          kind: body.kind,
          severity: body.severity ?? "medium",
          occurredAt: body.occurredAt,
          discoveredAt: body.discoveredAt ?? null,
          locationId: body.locationId ?? null,
          description: body.description,
          quantity: body.quantity ?? null,
          unit: body.unit ?? null,
          medium: body.medium ?? null,
          reportableToRegulator: reportable ? 1 : 0,
          regulator: body.regulator ?? null,
          obligationId,
          evidenceIds: body.evidenceIds ?? [],
          createdBy: req.user!.id,
        });
        await appendLedger(tx, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "environmental_incident",
          objectId: id,
          projectId: req.projectId!,
          payload: {
            number,
            kind: body.kind,
            severity: body.severity ?? "medium",
            occurredAt: body.occurredAt,
            quantity: body.quantity ?? null,
            unit: body.unit ?? null,
            reportableToRegulator: reportable,
            obligationId,
          },
          storePayload: true,
        });
      });
      return reply.status(201).send(await fetchIncident(id, req.companyId!, req.projectId!));
    },
  );

  app.get(
    "/projects/:projectId/environmental-incidents",
    { preHandler: readGate },
    async (req) => {
      const q = pageQuerySchema
        .extend({
          status: z.enum(ENVIRONMENTAL_INCIDENT_STATUSES).optional(),
          kind: z.enum(ENVIRONMENTAL_INCIDENT_KINDS).optional(),
        })
        .parse(req.query);
      const clauses = [
        eq(environmentalIncidents.companyId, req.companyId!),
        eq(environmentalIncidents.projectId, req.projectId!),
      ];
      if (q.status) clauses.push(eq(environmentalIncidents.status, q.status));
      if (q.kind) clauses.push(eq(environmentalIncidents.kind, q.kind));
      const where = and(...clauses);
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(environmentalIncidents)
        .where(where);
      const rows = await app.db
        .select()
        .from(environmentalIncidents)
        .where(where)
        .orderBy(desc(environmentalIncidents.occurredAt), desc(environmentalIncidents.number))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      const now = Date.now();
      return paginate(
        rows.map((r) => ({
          ...r,
          reportableBool: r.reportableToRegulator === 1,
          notified: r.regulatorNotifiedAt != null,
          hoursSinceOccurrence: round2(
            (now - Date.parse(`${r.occurredAt}T00:00:00Z`)) / 3_600_000,
          ),
          notificationOverdue:
            r.reportableToRegulator === 1 &&
            r.regulatorNotifiedAt == null &&
            now - Date.parse(`${r.occurredAt}T00:00:00Z`) >
              REGULATOR_NOTIFICATION_HOURS * 3_600_000,
        })),
        Number(totalRow?.n ?? 0),
        q,
      );
    },
  );

  app.post(
    "/projects/:projectId/environmental-incidents/:incidentId/notify",
    { preHandler: standardGate },
    async (req) => {
      const { incidentId } = req.params as { incidentId: string };
      const body = incidentNotifySchema.parse(req.body);
      const incident = await fetchIncident(incidentId, req.companyId!, req.projectId!);
      if (incident.regulatorNotifiedAt) {
        throw conflict(
          `The regulator was already notified on ${incident.regulatorNotifiedAt}. A second ` +
            `notification is a new correspondence record, not a rewrite of the first.`,
        );
      }
      const notifiedAt = body.notifiedAt ?? new Date().toISOString();
      await app.db
        .update(environmentalIncidents)
        .set({
          regulatorNotifiedAt: notifiedAt,
          regulator: body.regulator,
          // notifying a non-reportable incident makes it reportable in fact
          reportableToRegulator: 1,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environmentalIncidents.id, incidentId));
      if (incident.obligationId) {
        // A late notification does not rewrite history: only a still-open
        // obligation is satisfied, a breached one stays breached.
        await app.db
          .update(obligations)
          .set({ status: "satisfied" })
          .where(
            and(eq(obligations.id, incident.obligationId), eq(obligations.status, "open")),
          );
      }
      const hours = round2(
        (Date.parse(notifiedAt) - Date.parse(`${incident.occurredAt}T00:00:00Z`)) / 3_600_000,
      );
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "environmental_incident",
        objectId: incidentId,
        projectId: req.projectId!,
        payload: {
          event: "regulator_notified",
          number: incident.number,
          regulator: body.regulator,
          reference: body.reference ?? null,
          notifiedAt,
          hoursFromOccurrence: hours,
          withinWindow: hours <= REGULATOR_NOTIFICATION_HOURS,
          windowHours: REGULATOR_NOTIFICATION_HOURS,
        },
        storePayload: true,
      });
      return fetchIncident(incidentId, req.companyId!, req.projectId!);
    },
  );

  const INCIDENT_TRANSITIONS: Record<string, readonly string[]> = {
    open: ["contained"],
    contained: ["remediated"],
    remediated: ["closed"],
    closed: [],
  };

  app.post(
    "/projects/:projectId/environmental-incidents/:incidentId/status",
    { preHandler: standardGate },
    async (req) => {
      const { incidentId } = req.params as { incidentId: string };
      const body = incidentStatusSchema.parse(req.body);
      const incident = await fetchIncident(incidentId, req.companyId!, req.projectId!);
      if (body.status === incident.status) throw badRequest(`Incident is already ${incident.status}`);
      const allowed = INCIDENT_TRANSITIONS[incident.status] ?? [];
      if (!allowed.includes(body.status)) {
        throw badRequest(
          `A ${incident.status} incident cannot move to ${body.status} ` +
            `(allowed: ${allowed.join(", ") || "none"})`,
        );
      }
      /*
       * An incident cannot be closed while its statutory notification is
       * outstanding: closing it would remove it from the operational view
       * while the legal duty it created is still live.
       */
      if (
        body.status === "closed" &&
        incident.reportableToRegulator === 1 &&
        incident.regulatorNotifiedAt == null
      ) {
        throw conflict(
          `EI-${incident.number} is reportable to the regulator and has not been notified. ` +
            `Record the notification before closing the incident.`,
        );
      }
      if (body.status === "closed" && !(body.rootCause ?? incident.rootCause)) {
        throw badRequest("Closing an environmental incident requires a recorded root cause");
      }
      const now = new Date().toISOString();
      const patch: Record<string, unknown> = { status: body.status, updatedAt: now };
      if (body.rootCause !== undefined) patch["rootCause"] = body.rootCause;
      if (body.correctiveActions !== undefined) {
        patch["correctiveActions"] = body.correctiveActions.map((a) => ({
          id: newId("eca"),
          ...a,
          status: "open",
        }));
      }
      if (body.status === "closed") patch["closedAt"] = now;
      await app.db
        .update(environmentalIncidents)
        .set(patch)
        .where(eq(environmentalIncidents.id, incidentId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "environmental_incident",
        objectId: incidentId,
        projectId: req.projectId!,
        payload: {
          from: incident.status,
          to: body.status,
          number: incident.number,
          rootCause: body.rootCause ?? incident.rootCause,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      return fetchIncident(incidentId, req.companyId!, req.projectId!);
    },
  );

  /* ================================================================ */
  /* Biodiversity                                                      */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/biodiversity-units",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = biodiversitySchema.parse(req.body);
      const condition = body.condition ?? "moderate";
      const conditionScore = conditionScoreFor(condition);
      const strategic = body.strategicSignificance ?? 1;
      const units = computeBiodiversityUnits({
        areaHectares: body.areaHectares,
        distinctiveness: body.distinctiveness,
        conditionScore,
        strategicSignificance: strategic,
      });
      const id = newId("bdu");
      await app.db.insert(biodiversityUnitsTable).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        stage: body.stage,
        habitatType: body.habitatType,
        areaHectares: body.areaHectares,
        distinctiveness: body.distinctiveness,
        condition,
        conditionScore,
        strategicSignificance: strategic,
        units,
        surveyDate: body.surveyDate ?? null,
        surveyor: body.surveyor ?? null,
        evidenceIds: body.evidenceIds ?? [],
        note: body.note ?? null,
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "biodiversity_unit",
        objectId: id,
        projectId: req.projectId!,
        payload: {
          stage: body.stage,
          habitatType: body.habitatType,
          areaHectares: body.areaHectares,
          distinctiveness: body.distinctiveness,
          condition,
          conditionScore,
          strategicSignificance: strategic,
          units,
          basis: `${body.areaHectares} ha × ${body.distinctiveness} distinctiveness × ${conditionScore} condition × ${strategic} strategic significance = ${units} units`,
        },
        storePayload: true,
      });
      const created = await app.db
        .select()
        .from(biodiversityUnitsTable)
        .where(eq(biodiversityUnitsTable.id, id))
        .limit(1);
      return reply.status(201).send(created[0]);
    },
  );

  app.get("/projects/:projectId/biodiversity-units", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(biodiversityUnitsTable)
      .where(
        and(
          eq(biodiversityUnitsTable.companyId, req.companyId!),
          eq(biodiversityUnitsTable.projectId, req.projectId!),
        ),
      )
      .orderBy(asc(biodiversityUnitsTable.stage), asc(biodiversityUnitsTable.habitatType));
    const sumStage = (stage: string) =>
      round2(rows.filter((r) => r.stage === stage).reduce((s, r) => s + r.units, 0));
    const baseline = sumStage("baseline");
    const post = sumStage("post_intervention");
    const targetUnits = rows.some((r) => r.stage === "target") ? sumStage("target") : null;
    return {
      items: rows,
      total: rows.length,
      byStage: BIODIVERSITY_STAGES.map((stage) => ({
        stage,
        habitats: rows.filter((r) => r.stage === stage).length,
        units: sumStage(stage),
      })),
      netGain:
        rows.length > 0
          ? computeNetGain({
              baselineUnits: baseline,
              postInterventionUnits: post,
              targetUnits,
            })
          : null,
    };
  });

  /* ================================================================ */
  /* Design-option carbon comparison & MACC (#502-504)                 */
  /* ================================================================ */

  app.post("/projects/:projectId/carbon-options", { preHandler: standardGate }, async (req, reply) => {
    const body = optionCreateSchema.parse(req.body);
    if (body.isBaseline) {
      const existing = await app.db
        .select({ id: carbonOptions.id, name: carbonOptions.name })
        .from(carbonOptions)
        .where(
          and(
            eq(carbonOptions.companyId, req.companyId!),
            eq(carbonOptions.projectId, req.projectId!),
            eq(carbonOptions.studyRef, body.studyRef),
            eq(carbonOptions.isBaseline, 1),
          ),
        )
        .limit(1);
      if (existing[0]) {
        throw conflict(
          `"${existing[0].name}" is already the baseline for study "${body.studyRef}". ` +
            `Abatement is measured against exactly one reference case.`,
        );
      }
    }
    const id = newId("cop");
    await app.db.insert(carbonOptions).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      studyRef: body.studyRef,
      name: body.name,
      description: body.description ?? null,
      element: body.element ?? null,
      isBaseline: body.isBaseline ? 1 : 0,
      tco2e: body.tco2e,
      cost: body.cost ?? null,
      currency: body.currency ?? "GBP",
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "carbon_option",
      objectId: id,
      projectId: req.projectId!,
      payload: {
        studyRef: body.studyRef,
        name: body.name,
        isBaseline: Boolean(body.isBaseline),
        tco2e: body.tco2e,
        cost: body.cost ?? null,
        currency: body.currency ?? "GBP",
      },
      storePayload: true,
    });
    const created = await app.db
      .select()
      .from(carbonOptions)
      .where(eq(carbonOptions.id, id))
      .limit(1);
    return reply.status(201).send(created[0]);
  });

  /**
   * The marginal abatement cost curve for one study. Options are ranked by
   * £ per tonne abated against the study's baseline; an option with no cost
   * is reported with the reason rather than ranked as though it were free,
   * which is the commonest way a carbon option appraisal misleads.
   */
  app.get("/projects/:projectId/carbon-options", { preHandler: readGate }, async (req) => {
    const q = z.object({ studyRef: z.string().min(1).optional() }).parse(req.query);
    const clauses = [
      eq(carbonOptions.companyId, req.companyId!),
      eq(carbonOptions.projectId, req.projectId!),
    ];
    if (q.studyRef) clauses.push(eq(carbonOptions.studyRef, q.studyRef));
    const rows = await app.db
      .select()
      .from(carbonOptions)
      .where(and(...clauses))
      .orderBy(asc(carbonOptions.studyRef), asc(carbonOptions.name));
    const studies = [...new Set(rows.map((r) => r.studyRef))].sort();
    return {
      items: rows,
      total: rows.length,
      studies: studies.map((studyRef) => {
        const inStudy = rows.filter((r) => r.studyRef === studyRef);
        const currencies = [...new Set(inStudy.map((r) => r.currency))];
        const options: OptionInput[] = inStudy.map((r) => ({
          id: r.id,
          name: r.name,
          isBaseline: r.isBaseline === 1,
          tco2e: r.tco2e,
          // never compare money across currencies: an option struck in a
          // different currency is unpriced for the purposes of this curve
          cost: currencies.length === 1 ? r.cost : null,
        }));
        const macc = buildMacc(options);
        return {
          studyRef,
          currency: currencies.length === 1 ? currencies[0] : null,
          currencies,
          mixedCurrency: currencies.length > 1,
          ...macc,
          note:
            currencies.length > 1
              ? `Options in this study are struck in ${currencies.join(", ")}. Cost per tonne ` +
                `abated is not computed, because subtracting money in different currencies ` +
                `produces a number that means nothing.`
              : macc.note,
        };
      }),
    };
  });

  app.post(
    "/projects/:projectId/carbon-options/:optionId/decision",
    { preHandler: standardGate },
    async (req) => {
      const { optionId } = req.params as { optionId: string };
      const body = optionDecisionSchema.parse(req.body);
      const rows = await app.db
        .select()
        .from(carbonOptions)
        .where(
          and(
            eq(carbonOptions.id, optionId),
            eq(carbonOptions.companyId, req.companyId!),
            eq(carbonOptions.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const option = rows[0];
      if (!option) throw notFound("Carbon option not found");
      const now = new Date().toISOString();
      await app.db
        .update(carbonOptions)
        .set({
          decision: body.decision,
          decidedAt: now,
          decidedBy: req.user!.id,
          decisionNote: body.note ?? null,
          updatedAt: now,
        })
        .where(eq(carbonOptions.id, optionId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "carbon_option",
        objectId: optionId,
        projectId: req.projectId!,
        payload: {
          from: option.decision,
          to: body.decision,
          studyRef: option.studyRef,
          name: option.name,
          tco2e: option.tco2e,
          cost: option.cost,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      const updated = await app.db
        .select()
        .from(carbonOptions)
        .where(eq(carbonOptions.id, optionId))
        .limit(1);
      return updated[0];
    },
  );

  /* ================================================================ */
  /* Transport carbon (A4 / A5)                                        */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/carbon-transport-legs",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = transportLegSchema.parse(req.body);
      const computed = computeTransportLeg({
        mode: body.mode,
        distanceKm: body.distanceKm,
        payloadTonnes: body.payloadTonnes,
        trips: body.trips,
        factorOverride: body.factorOverride,
        factorSourceOverride: body.factorSourceOverride,
      });
      if (!computed) {
        throw badRequest(
          `No transport factor is published for mode "${body.mode}" and none was supplied. ` +
            `Emissions are not estimated from nothing.`,
        );
      }
      const id = newId("ctl");
      const entryId = body.createEntry === false ? null : newId("cen");
      await app.db.transaction(async (tx) => {
        if (entryId) {
          // booked into the same footprint as everything else, so transport
          // carbon shows up in the summary rather than a parallel register
          await tx.insert(carbonEntries).values({
            id: entryId,
            companyId: req.companyId!,
            projectId: req.projectId!,
            budgetId: body.budgetId ?? null,
            description: `Transport: ${body.description}`,
            lifecycleModule: body.lifecycleModule ?? "A4",
            scope: "scope_3",
            factorId: null,
            quantity: computed.tonneKm,
            unit: "tonne-km",
            tco2e: computed.tco2e,
            sourceNote: computed.basis,
            entryDate: body.legDate,
            createdBy: req.user!.id,
          });
        }
        await tx.insert(carbonTransportLegs).values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          description: body.description,
          origin: body.origin ?? null,
          destination: body.destination ?? null,
          mode: body.mode,
          distanceKm: body.distanceKm,
          payloadTonnes: body.payloadTonnes,
          trips: body.trips ?? 1,
          tonneKm: computed.tonneKm,
          factorKgCo2ePerTonneKm: computed.factorKgCo2ePerTonneKm,
          factorSource: computed.factorSource,
          tco2e: computed.tco2e,
          lifecycleModule: body.lifecycleModule ?? "A4",
          entryId,
          legDate: body.legDate,
          createdBy: req.user!.id,
        });
        await appendLedger(tx, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "carbon_transport_leg",
          objectId: id,
          projectId: req.projectId!,
          payload: {
            description: body.description,
            mode: body.mode,
            distanceKm: body.distanceKm,
            payloadTonnes: body.payloadTonnes,
            trips: body.trips ?? 1,
            tonneKm: computed.tonneKm,
            factorKgCo2ePerTonneKm: computed.factorKgCo2ePerTonneKm,
            factorSource: computed.factorSource,
            tco2e: computed.tco2e,
            entryId,
            basis: computed.basis,
          },
          storePayload: true,
        });
      });
      const created = await app.db
        .select()
        .from(carbonTransportLegs)
        .where(eq(carbonTransportLegs.id, id))
        .limit(1);
      return reply.status(201).send({ ...created[0], ...computed });
    },
  );

  app.get("/projects/:projectId/carbon-transport-legs", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = and(
      eq(carbonTransportLegs.companyId, req.companyId!),
      eq(carbonTransportLegs.projectId, req.projectId!),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(carbonTransportLegs).where(where);
    const rows = await app.db
      .select()
      .from(carbonTransportLegs)
      .where(where)
      .orderBy(desc(carbonTransportLegs.legDate))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const all = await app.db
      .select({ tco2e: carbonTransportLegs.tco2e, tonneKm: carbonTransportLegs.tonneKm })
      .from(carbonTransportLegs)
      .where(where);
    return {
      ...paginate(rows, Number(totalRow?.n ?? 0), q),
      totals: {
        legs: all.length,
        tonneKm: round2(all.reduce((s, r) => s + r.tonneKm, 0)),
        tco2e: round6(all.reduce((s, r) => s + r.tco2e, 0)),
      },
      factors: TRANSPORT_FACTORS,
    };
  });

  /* ================================================================ */
  /* ISO 14001 EMS evidence                                            */
  /* ================================================================ */

  app.post("/projects/:projectId/ems-records", { preHandler: standardGate }, async (req, reply) => {
    const body = emsSchema.parse(req.body);
    const existing = await app.db
      .select({ id: emsRecords.id })
      .from(emsRecords)
      .where(
        and(eq(emsRecords.projectId, req.projectId!), eq(emsRecords.clause, body.clause)),
      )
      .limit(1);
    if (existing[0]) {
      throw conflict(`Clause ${body.clause} already has an EMS record on this project`);
    }
    const id = newId("ems");
    await app.db.insert(emsRecords).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      clause: body.clause,
      requirement: body.requirement,
      status: body.status ?? "not_started",
      ownerId: body.ownerId ?? null,
      evidenceIds: body.evidenceIds ?? [],
      fileIds: body.fileIds ?? [],
      lastReviewedAt: body.lastReviewedAt ?? null,
      nextReviewDueAt: body.nextReviewDueAt ?? null,
      note: body.note ?? null,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "ems_record",
      objectId: id,
      projectId: req.projectId!,
      payload: { clause: body.clause, requirement: body.requirement, status: body.status ?? "not_started" },
      storePayload: true,
    });
    const created = await app.db.select().from(emsRecords).where(eq(emsRecords.id, id)).limit(1);
    return reply.status(201).send(created[0]);
  });

  app.get("/projects/:projectId/ems-records", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(emsRecords)
      .where(
        and(eq(emsRecords.companyId, req.companyId!), eq(emsRecords.projectId, req.projectId!)),
      )
      .orderBy(asc(emsRecords.clause));
    const byClause = new Map(rows.map((r) => [r.clause, r]));
    const evidenced = rows.filter(
      (r) => r.status === "evidenced" || r.status === "verified",
    ).length;
    return {
      items: rows,
      total: rows.length,
      // the whole clause set, so the gaps are visible rather than absent
      coverage: ISO14001_CLAUSES.map((clause) => ({
        clause,
        record: byClause.get(clause) ?? null,
        status: byClause.get(clause)?.status ?? "not_started",
      })),
      clauses: ISO14001_CLAUSES.length,
      evidenced,
      nonconforming: rows.filter((r) => r.status === "nonconforming").length,
      coveragePercent: percent(evidenced, ISO14001_CLAUSES.length),
    };
  });

  app.patch(
    "/projects/:projectId/ems-records/:recordId",
    { preHandler: standardGate },
    async (req) => {
      const { recordId } = req.params as { recordId: string };
      const body = emsPatchSchema.parse(req.body);
      const rows = await app.db
        .select()
        .from(emsRecords)
        .where(
          and(
            eq(emsRecords.id, recordId),
            eq(emsRecords.companyId, req.companyId!),
            eq(emsRecords.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const record = rows[0];
      if (!record) throw notFound("EMS record not found");
      if (
        (body.status === "evidenced" || body.status === "verified") &&
        (body.evidenceIds ?? record.evidenceIds).length === 0 &&
        (body.fileIds ?? record.fileIds).length === 0
      ) {
        throw badRequest(
          `Clause ${record.clause} cannot be recorded as ${body.status} with nothing attached — ` +
            `"evidenced" is a claim about documents that exist`,
        );
      }
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const key of [
        "requirement",
        "status",
        "ownerId",
        "evidenceIds",
        "fileIds",
        "lastReviewedAt",
        "nextReviewDueAt",
        "note",
      ] as const) {
        if (body[key] !== undefined) {
          patch[key] = body[key];
          before[key] = (record as Record<string, unknown>)[key];
          after[key] = body[key];
        }
      }
      await app.db.update(emsRecords).set(patch).where(eq(emsRecords.id, recordId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "ems_record",
        objectId: recordId,
        projectId: req.projectId!,
        payload: { clause: record.clause, before, after },
        storePayload: true,
      });
      const updated = await app.db
        .select()
        .from(emsRecords)
        .where(eq(emsRecords.id, recordId))
        .limit(1);
      return updated[0];
    },
  );

  /* ================================================================ */
  /* GIA (#491 — the RICS intensity denominator)                       */
  /* ================================================================ */

  /**
   * `/carbon/summary` has always reported kgCO2e per m² GIA from
   * `projects.settings.gia`, and NOTHING in the product ever wrote that key:
   * the headline reporting unit rendered "GIA not set" for every customer,
   * with a hint that could not be followed anywhere. This is the writer.
   */
  app.patch(
    "/projects/:projectId/carbon-settings",
    { preHandler: standardGate },
    async (req) => {
      const body = giaSchema.parse(req.body);
      const rows = await app.db
        .select({ settings: projects.settings })
        .from(projects)
        .where(and(eq(projects.id, req.projectId!), eq(projects.companyId, req.companyId!)))
        .limit(1);
      if (!rows[0]) throw notFound("Project not found");
      const settings = { ...((rows[0].settings as Record<string, unknown>) ?? {}) };
      const before = settings["gia"] ?? null;
      if (body.giaSqm === null) delete settings["gia"];
      else settings["gia"] = body.giaSqm;
      await app.db
        .update(projects)
        .set({ settings, updatedAt: new Date().toISOString() })
        .where(eq(projects.id, req.projectId!));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "project",
        objectId: req.projectId!,
        projectId: req.projectId!,
        payload: {
          setting: "gia",
          before,
          after: body.giaSqm,
          note: "Gross internal area, the denominator of the RICS carbon intensity unit",
        },
        storePayload: true,
      });
      return { projectId: req.projectId!, giaSqm: body.giaSqm };
    },
  );

  app.get("/projects/:projectId/carbon-settings", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select({ settings: projects.settings })
      .from(projects)
      .where(and(eq(projects.id, req.projectId!), eq(projects.companyId, req.companyId!)))
      .limit(1);
    if (!rows[0]) throw notFound("Project not found");
    const raw = (rows[0].settings as Record<string, unknown> | null)?.["gia"];
    return {
      projectId: req.projectId!,
      giaSqm: typeof raw === "number" && raw > 0 ? raw : null,
      unavailableReason:
        typeof raw === "number" && raw > 0
          ? null
          : "No gross internal area is recorded, so carbon intensity per m² cannot be stated",
    };
  });

  /* ================================================================ */
  /* Disclosure assembly (#541-546)                                    */
  /* ================================================================ */

  async function disclosureInputs(
    companyId: string,
    projectId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<DisclosureInputs> {
    const entries = await app.db
      .select()
      .from(carbonEntries)
      .where(
        and(
          eq(carbonEntries.companyId, companyId),
          eq(carbonEntries.projectId, projectId),
          gte(carbonEntries.entryDate, periodStart),
          lte(carbonEntries.entryDate, periodEnd),
        ),
      );
    /*
     * #498 — the share of the reported footprint that stands on a
     * product-specific EPD rather than a generic library figure. A low share
     * is not an error; it is the honest maturity of the assessment, and a
     * disclosure that hides it is worse than one that reports it.
     */
    const factorIds = [...new Set(entries.map((e) => e.factorId).filter((v): v is string => !!v))];
    const factorRows = factorIds.length
      ? await app.db
          .select({
            id: carbonFactors.id,
            isProductSpecific: carbonFactors.isProductSpecific,
          })
          .from(carbonFactors)
          .where(
            and(
              inArray(carbonFactors.id, factorIds),
              eq(carbonFactors.companyId, companyId),
            ),
          )
      : [];
    const productSpecificFactors = new Set(
      factorRows.filter((f) => f.isProductSpecific === 1).map((f) => f.id),
    );
    const productSpecificTco2e = round6(
      entries
        .filter((e) => e.factorId != null && productSpecificFactors.has(e.factorId))
        .reduce((s, e) => s + e.tco2e, 0),
    );
    const byScope: Record<string, number> = {};
    const byModule: Record<string, number> = {};
    let unscoped = 0;
    for (const e of entries) {
      byModule[e.lifecycleModule] = round6((byModule[e.lifecycleModule] ?? 0) + e.tco2e);
      if (e.scope) byScope[e.scope] = round6((byScope[e.scope] ?? 0) + e.tco2e);
      else unscoped = round6(unscoped + e.tco2e);
    }
    const total = round6(entries.reduce((s, e) => s + e.tco2e, 0));

    const waste = await app.db
      .select()
      .from(wasteRecords)
      .where(
        and(
          eq(wasteRecords.companyId, companyId),
          eq(wasteRecords.projectId, projectId),
          gte(wasteRecords.recordDate, periodStart),
          lte(wasteRecords.recordDate, periodEnd),
        ),
      );
    const readings = await app.db
      .select({ exceedance: monitoringReadings.exceedance })
      .from(monitoringReadings)
      .where(
        and(
          eq(monitoringReadings.companyId, companyId),
          eq(monitoringReadings.projectId, projectId),
          gte(monitoringReadings.readingAt, periodStart),
          lte(monitoringReadings.readingAt, periodEnd),
        ),
      );
    const incidents = await app.db
      .select()
      .from(environmentalIncidents)
      .where(
        and(
          eq(environmentalIncidents.companyId, companyId),
          eq(environmentalIncidents.projectId, projectId),
          gte(environmentalIncidents.occurredAt, periodStart),
          lte(environmentalIncidents.occurredAt, periodEnd),
        ),
      );
    const commitments = await app.db
      .select()
      .from(socialValueCommitments)
      .where(
        and(
          eq(socialValueCommitments.companyId, companyId),
          eq(socialValueCommitments.projectId, projectId),
        ),
      );
    const deliveries = commitments.length
      ? await app.db
          .select()
          .from(socialValueDeliveries)
          .where(
            inArray(
              socialValueDeliveries.commitmentId,
              commitments.map((c) => c.id),
            ),
          )
      : [];
    const workerRows = await app.db
      .select({ id: workers.id, status: workers.status, idVerified: workers.idVerified })
      .from(workers)
      .where(and(eq(workers.companyId, companyId), eq(workers.projectId, projectId)));
    const grievanceRows = await app.db
      .select({ status: grievances.status })
      .from(grievances)
      .where(
        and(
          eq(grievances.companyId, companyId),
          eq(grievances.projectId, projectId),
          gte(grievances.receivedAt, periodStart),
          lte(grievances.receivedAt, periodEnd),
        ),
      );
    const habitats = await app.db
      .select()
      .from(biodiversityUnitsTable)
      .where(
        and(
          eq(biodiversityUnitsTable.companyId, companyId),
          eq(biodiversityUnitsTable.projectId, projectId),
        ),
      );
    const projectRow = await app.db
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const giaRaw = (projectRow[0]?.settings as Record<string, unknown> | undefined)?.["gia"];
    const [seqRow] = await app.db
      .select({ seq: max(ledgerEntries.seq) })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.companyId, companyId));
    const budgets = await app.db
      .select({ targetTco2e: carbonBudgets.targetTco2e })
      .from(carbonBudgets)
      .where(
        and(eq(carbonBudgets.companyId, companyId), eq(carbonBudgets.projectId, projectId)),
      );
    const budgetTarget =
      budgets.length > 0 ? round6(budgets.reduce((s, b) => s + b.targetTco2e, 0)) : null;

    const sumStage = (stage: string) =>
      round2(habitats.filter((h) => h.stage === stage).reduce((s, h) => s + h.units, 0));
    const baselineUnits = habitats.some((h) => h.stage === "baseline") ? sumStage("baseline") : null;
    const postUnits = habitats.some((h) => h.stage === "post_intervention")
      ? sumStage("post_intervention")
      : null;

    const notifiedLate = incidents.filter(
      (i) =>
        i.reportableToRegulator === 1 &&
        (i.regulatorNotifiedAt == null ||
          Date.parse(i.regulatorNotifiedAt) - Date.parse(`${i.occurredAt}T00:00:00Z`) >
            REGULATOR_NOTIFICATION_HOURS * 3_600_000),
    ).length;

    return {
      periodStart,
      periodEnd,
      carbon: {
        totalTco2e: total,
        byScope,
        byModule,
        entryCount: entries.length,
        productSpecificTco2e,
        unscopedTco2e: unscoped,
        giaSqm: typeof giaRaw === "number" && giaRaw > 0 ? giaRaw : null,
        budgetTargetTco2e: budgetTarget,
      },
      waste: {
        totalTonnes: round2(waste.reduce((s, w) => s + w.tonnes, 0)),
        landfillTonnes: round2(
          waste.filter((w) => w.destination === "landfill").reduce((s, w) => s + w.tonnes, 0),
        ),
        // WASTE_DESTINATIONS says "recycled"; "recycling" matched nothing, so
        // the disclosure reported a recycled tonnage of zero on every project
        // that recycles. Hazard is a property of the STREAM, not a flag.
        recycledTonnes: round2(
          waste.filter((w) => w.destination === "recycled").reduce((s, w) => s + w.tonnes, 0),
        ),
        hazardousTonnes: round2(
          waste.filter((w) => w.stream === "hazardous").reduce((s, w) => s + w.tonnes, 0),
        ),
        recordCount: waste.length,
      },
      environment: {
        readings: readings.length,
        exceedances: readings.filter((r) => r.exceedance === 1).length,
        incidents: incidents.length,
        reportableIncidents: incidents.filter((i) => i.reportableToRegulator === 1).length,
        incidentsNotifiedLate: notifiedLate,
      },
      socialValue: {
        commitments: commitments.length,
        proxyValueCommitted: round2(
          commitments.reduce(
            (s, c) => s + (c.proxyValuePerUnit != null ? c.targetValue * c.proxyValuePerUnit : 0),
            0,
          ),
        ),
        proxyValueDelivered: round2(
          commitments.reduce(
            (s, c) =>
              s + (c.proxyValuePerUnit != null ? c.deliveredValue * c.proxyValuePerUnit : 0),
            0,
          ),
        ),
        deliveriesWithEvidence: deliveries.filter((d) => d.evidenceIds.length > 0).length,
        deliveriesTotal: deliveries.length,
        shortfallCommitments: commitments.filter((c) => c.status === "shortfall").length,
      },
      labour: {
        indicatorCounts: null,
        workersScreened: workerRows.filter((w) => w.idVerified === 1).length,
        grievancesRaised: grievanceRows.length,
        grievancesResolved: grievanceRows.filter(
          (g) => g.status === "resolved" || g.status === "closed_verified",
        ).length,
      },
      biodiversity: {
        baselineUnits,
        postInterventionUnits: postUnits,
        netGainPercent:
          baselineUnits != null && baselineUnits > 0 && postUnits != null
            ? round2(((postUnits - baselineUnits) / baselineUnits) * 100)
            : null,
      },
      ledgerSeqTo: seqRow?.seq ?? null,
    };
  }

  app.post("/projects/:projectId/esg-disclosures", { preHandler: standardGate }, async (req, reply) => {
    const body = disclosureSchema.parse(req.body);
    if (body.periodEnd < body.periodStart) {
      throw badRequest("periodEnd cannot precede periodStart");
    }
    const inputs = await disclosureInputs(
      req.companyId!,
      req.projectId!,
      body.periodStart,
      body.periodEnd,
    );
    const result = assembleDisclosure(body.framework, inputs);
    if (body.commit === false) return { ...result, committed: false };
    const id = newId("esd");
    await app.db.insert(esgDisclosures).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      framework: body.framework,
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      datapoints: result.datapoints,
      dataQuality: result.dataQuality as unknown as Record<string, unknown>,
      ledgerSeqTo: result.ledgerSeqTo,
      generatedBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "esg_disclosure",
      objectId: id,
      projectId: req.projectId!,
      payload: {
        framework: body.framework,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
        datapoints: result.datapoints.length,
        unavailableDatapoints: result.dataQuality.unavailableDatapoints,
        ledgerSeqTo: result.ledgerSeqTo,
      },
      storePayload: true,
    });
    return reply.status(201).send({ id, ...result, committed: true });
  });

  app.get("/projects/:projectId/esg-disclosures", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ framework: z.enum(DISCLOSURE_FRAMEWORKS).optional() })
      .parse(req.query);
    const clauses = [
      eq(esgDisclosures.companyId, req.companyId!),
      eq(esgDisclosures.projectId, req.projectId!),
    ];
    if (q.framework) clauses.push(eq(esgDisclosures.framework, q.framework));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(esgDisclosures).where(where);
    const rows = await app.db
      .select()
      .from(esgDisclosures)
      .where(where)
      .orderBy(desc(esgDisclosures.periodEnd), desc(esgDisclosures.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/esg-disclosures/:disclosureId/export.csv",
    { preHandler: readGate },
    async (req, reply) => {
      const { disclosureId } = req.params as { disclosureId: string };
      const rows = await app.db
        .select()
        .from(esgDisclosures)
        .where(
          and(
            eq(esgDisclosures.id, disclosureId),
            eq(esgDisclosures.companyId, req.companyId!),
            eq(esgDisclosures.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const disclosure = rows[0];
      if (!disclosure) throw notFound("Disclosure not found");
      const escape = (v: unknown): string => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [
        "datapoint_id,label,value,unit,basis,sources,unavailable_reason,ledger_seq_to",
      ];
      for (const raw of disclosure.datapoints as Record<string, unknown>[]) {
        lines.push(
          [
            raw["id"],
            raw["label"],
            raw["value"],
            raw["unit"],
            raw["basis"],
            Array.isArray(raw["sources"]) ? (raw["sources"] as string[]).join("; ") : "",
            raw["unavailableReason"],
            disclosure.ledgerSeqTo,
          ]
            .map(escape)
            .join(","),
        );
      }
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="${disclosure.framework}-${disclosure.periodStart}-${disclosure.periodEnd}.csv"`,
        )
        .send(lines.join("\n"));
    },
  );

  /** Health inputs for WP-INTEL (contract 3.5). */
  app.get("/projects/:projectId/esg/health-inputs", { preHandler: readGate }, async (req) => {
    const reasons: string[] = [];
    const [excRow] = await app.db
      .select({ n: count() })
      .from(monitoringReadings)
      .where(
        and(
          eq(monitoringReadings.companyId, req.companyId!),
          eq(monitoringReadings.projectId, req.projectId!),
          eq(monitoringReadings.exceedance, 1),
        ),
      );
    const incidents = await app.db
      .select()
      .from(environmentalIncidents)
      .where(
        and(
          eq(environmentalIncidents.companyId, req.companyId!),
          eq(environmentalIncidents.projectId, req.projectId!),
        ),
      );
    const commitments = await app.db
      .select()
      .from(socialValueCommitments)
      .where(
        and(
          eq(socialValueCommitments.companyId, req.companyId!),
          eq(socialValueCommitments.projectId, req.projectId!),
        ),
      );
    const exceedances = Number(excRow?.n ?? 0);
    const unnotified = incidents.filter(
      (i) => i.reportableToRegulator === 1 && i.regulatorNotifiedAt == null,
    ).length;
    const shortfalls = commitments.filter((c) => c.status === "shortfall").length;
    if (exceedances > 0) reasons.push(`${exceedances} consent-limit exceedance(s) measured`);
    if (unnotified > 0) reasons.push(`${unnotified} reportable incident(s) not notified`);
    if (shortfalls > 0) reasons.push(`${shortfalls} social value commitment(s) in shortfall`);
    return {
      metrics: {
        monitoringExceedances: exceedances,
        environmentalIncidents: incidents.length,
        environmentalIncidentsOpen: incidents.filter((i) => i.status === "open").length,
        reportableUnnotified: unnotified,
        socialValueCommitments: commitments.length,
        socialValueShortfalls: shortfalls,
        socialValueDeliveredPercent:
          commitments.length > 0
            ? round2(
                (commitments.filter((c) => c.status === "delivered").length /
                  commitments.length) *
                  100,
              )
            : null,
      },
      reasons,
    };
  });
}
