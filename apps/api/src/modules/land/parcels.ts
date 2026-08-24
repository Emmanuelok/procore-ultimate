import type { FastifyInstance } from "fastify";
import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { affectedPersons, landParcels, signals } from "@constructos/db";
import { PARCEL_STATUSES, TENURE_TYPES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema } from "../field/dates.js";
import {
  PARCEL_BLOCKING_STATUSES,
  PARCEL_COMPENSABLE_FROM,
  PARCEL_TRANSITIONS,
} from "./reference.js";
import {
  daysUntil,
  resolveTasks,
  round2,
  validateEntity,
  validateEvidence,
  validateTasksInProject,
} from "./shared.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const parcelCreateSchema = z.object({
  reference: z.string().min(1).max(200),
  description: z.string().max(20000).nullable().optional(),
  areaSqm: z.number().positive().nullable().optional(),
  tenureType: z.enum(TENURE_TYPES),
  ownerName: z.string().max(300).nullable().optional(),
  ownerEntityId: z.string().min(1).nullable().optional(),
  encumbrances: z.string().max(20000).nullable().optional(),
  valuationAmount: z.number().nonnegative().nullable().optional(),
  compensationAmount: z.number().nonnegative().nullable().optional(),
  currency: z.string().length(3).optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  blockingTaskIds: z.array(z.string().min(1)).max(500).optional(),
});

const parcelPatchSchema = parcelCreateSchema.partial();

const parcelListQuery = pageQuerySchema.extend({
  status: z.enum(PARCEL_STATUSES).optional(),
  tenureType: z.enum(TENURE_TYPES).optional(),
});

const parcelStatusSchema = z.object({
  status: z.enum(PARCEL_STATUSES),
  note: z.string().max(10000).nullable().optional(),
});

const compensateSchema = z.object({
  amount: z.number().positive(),
  paidAt: isoDateSchema,
  /** compensation must be evidenced — a bank transaction, a signed receipt,
   *  a beneficiary-verified payment record (#554) */
  evidenceIds: z.array(z.string().min(1)).min(1).max(100),
  note: z.string().max(10000).nullable().optional(),
});

const scheduleRiskQuery = z.object({
  days: z.coerce.number().int().min(1).max(3650).default(90),
});

/** Blocked tasks starting inside this horizon raise an integrity signal. */
const SIGNAL_HORIZON_DAYS = 30;

/**
 * Land parcel register, acquisition flow, evidenced compensation and the
 * consent-to-programme dependency analysis — spec Domain J #547-554, #591.
 */
export async function registerParcelRoutes(app: FastifyInstance): Promise<void> {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("land", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("land", "standard")];

  async function fetchParcel(parcelId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(landParcels)
      .where(
        and(
          eq(landParcels.id, parcelId),
          eq(landParcels.companyId, companyId),
          eq(landParcels.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Land parcel not found");
    return rows[0];
  }

  /** Cadastral references are unique per project — a duplicate is a 409. */
  async function assertReferenceFree(
    projectId: string,
    companyId: string,
    reference: string,
    exceptId?: string,
  ): Promise<void> {
    const clauses = [
      eq(landParcels.companyId, companyId),
      eq(landParcels.projectId, projectId),
      eq(landParcels.reference, reference),
    ];
    if (exceptId) clauses.push(ne(landParcels.id, exceptId));
    const rows = await app.db
      .select({ id: landParcels.id })
      .from(landParcels)
      .where(and(...clauses))
      .limit(1);
    if (rows[0]) {
      throw conflict(`A parcel with reference "${reference}" already exists on this project`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Parcel register (#547-551)                                        */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/parcels", { preHandler: standardGate }, async (req, reply) => {
    const body = parcelCreateSchema.parse(req.body);
    await assertReferenceFree(req.projectId!, req.companyId!, body.reference);
    if (body.ownerEntityId) await validateEntity(app.db, req.companyId!, body.ownerEntityId);
    await validateTasksInProject(app.db, req.projectId!, body.blockingTaskIds ?? []);
    const id = newId("lpc");
    await app.db.insert(landParcels).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      reference: body.reference,
      description: body.description ?? null,
      areaSqm: body.areaSqm ?? null,
      tenureType: body.tenureType,
      ownerName: body.ownerName ?? null,
      ownerEntityId: body.ownerEntityId ?? null,
      encumbrances: body.encumbrances ?? null,
      status: "identified",
      valuationAmount: body.valuationAmount ?? null,
      compensationAmount: body.compensationAmount ?? null,
      currency: body.currency ?? "USD",
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      blockingTaskIds: body.blockingTaskIds ?? [],
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "land_parcel",
      objectId: id,
      payload: {
        reference: body.reference,
        tenureType: body.tenureType,
        ownerName: body.ownerName ?? null,
        ownerEntityId: body.ownerEntityId ?? null,
        areaSqm: body.areaSqm ?? null,
        valuationAmount: body.valuationAmount ?? null,
        blockingTaskIds: body.blockingTaskIds ?? [],
      },
      storePayload: true,
    });
    const created = await fetchParcel(id, req.companyId!, req.projectId!);
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/parcels", { preHandler: readGate }, async (req) => {
    const q = parcelListQuery.parse(req.query);
    const clauses = [
      eq(landParcels.companyId, req.companyId!),
      eq(landParcels.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(landParcels.status, q.status));
    if (q.tenureType) clauses.push(eq(landParcels.tenureType, q.tenureType));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(landParcels).where(where);
    const rows = await app.db
      .select()
      .from(landParcels)
      .where(where)
      .orderBy(asc(landParcels.reference))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const ids = rows.map((r) => r.id);
    const papCounts = ids.length
      ? await app.db
          .select({ parcelId: affectedPersons.parcelId, n: count() })
          .from(affectedPersons)
          .where(
            and(
              eq(affectedPersons.companyId, req.companyId!),
              eq(affectedPersons.projectId, req.projectId!),
              inArray(affectedPersons.parcelId, ids),
            ),
          )
          .groupBy(affectedPersons.parcelId)
      : [];
    const byParcel = new Map(papCounts.map((c) => [c.parcelId ?? "", Number(c.n)]));
    const items = rows.map((r) => ({ ...r, papCount: byParcel.get(r.id) ?? 0 }));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/parcels/:parcelId", { preHandler: readGate }, async (req) => {
    const { parcelId } = req.params as { parcelId: string };
    const parcel = await fetchParcel(parcelId, req.companyId!, req.projectId!);
    const paps = await app.db
      .select()
      .from(affectedPersons)
      .where(
        and(
          eq(affectedPersons.companyId, req.companyId!),
          eq(affectedPersons.projectId, req.projectId!),
          eq(affectedPersons.parcelId, parcelId),
        ),
      )
      .orderBy(asc(affectedPersons.reference));
    const tasks = await resolveTasks(app.db, req.projectId!, parcel.blockingTaskIds);
    return {
      ...parcel,
      papCount: paps.length,
      affectedPersons: paps,
      blockingTasks: parcel.blockingTaskIds.map((taskId) => {
        const t = tasks.get(taskId);
        return {
          id: taskId,
          // a task deleted out from under the parcel still shows, flagged
          name: t?.name ?? null,
          startDate: t?.startDate ?? null,
          missing: !t,
        };
      }),
      allowedTransitions: PARCEL_TRANSITIONS[parcel.status as keyof typeof PARCEL_TRANSITIONS] ?? [],
    };
  });

  app.patch(
    "/projects/:projectId/parcels/:parcelId",
    { preHandler: standardGate },
    async (req) => {
      const { parcelId } = req.params as { parcelId: string };
      const body = parcelPatchSchema.parse(req.body);
      const parcel = await fetchParcel(parcelId, req.companyId!, req.projectId!);
      if (body.reference !== undefined && body.reference !== parcel.reference) {
        await assertReferenceFree(req.projectId!, req.companyId!, body.reference, parcelId);
      }
      if (body.ownerEntityId) await validateEntity(app.db, req.companyId!, body.ownerEntityId);
      if (body.blockingTaskIds !== undefined) {
        await validateTasksInProject(app.db, req.projectId!, body.blockingTaskIds);
      }
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const key of [
        "reference",
        "description",
        "areaSqm",
        "tenureType",
        "ownerName",
        "ownerEntityId",
        "encumbrances",
        "valuationAmount",
        "compensationAmount",
        "currency",
        "latitude",
        "longitude",
        "blockingTaskIds",
      ] as const) {
        if (body[key] !== undefined) set[key] = body[key];
      }
      await app.db.update(landParcels).set(set).where(eq(landParcels.id, parcelId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "land_parcel",
        objectId: parcelId,
        payload: { changed: Object.keys(body) },
      });
      return fetchParcel(parcelId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Acquisition flow (#551-552)                                       */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/parcels/:parcelId/status",
    { preHandler: standardGate },
    async (req) => {
      const { parcelId } = req.params as { parcelId: string };
      const body = parcelStatusSchema.parse(req.body);
      const parcel = await fetchParcel(parcelId, req.companyId!, req.projectId!);
      if (body.status === parcel.status) {
        throw badRequest(`Parcel is already ${parcel.status}`);
      }
      if (body.status === "compensated") {
        throw badRequest(
          "A parcel is marked compensated only through the evidenced compensation route " +
            "(POST /parcels/:parcelId/compensate)",
        );
      }
      const allowed =
        PARCEL_TRANSITIONS[parcel.status as keyof typeof PARCEL_TRANSITIONS] ?? ([] as string[]);
      if (!allowed.includes(body.status)) {
        throw badRequest(
          `A ${parcel.status} parcel cannot move to ${body.status} ` +
            `(allowed: ${allowed.join(", ") || "none"})`,
        );
      }
      await app.db
        .update(landParcels)
        .set({ status: body.status, updatedAt: new Date().toISOString() })
        .where(eq(landParcels.id, parcelId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "land_parcel",
        objectId: parcelId,
        payload: {
          from: parcel.status,
          to: body.status,
          reference: parcel.reference,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      return fetchParcel(parcelId, req.companyId!, req.projectId!);
    },
  );

  /**
   * Evidenced compensation (#553-554). Compensation is the single most
   * fraud-exposed transaction in a resettlement programme, so the record
   * cannot be created without evidence of payment reaching the beneficiary.
   */
  app.post(
    "/projects/:projectId/parcels/:parcelId/compensate",
    { preHandler: standardGate },
    async (req) => {
      const { parcelId } = req.params as { parcelId: string };
      const body = compensateSchema.parse(req.body);
      const parcel = await fetchParcel(parcelId, req.companyId!, req.projectId!);
      if (!PARCEL_COMPENSABLE_FROM.includes(parcel.status as (typeof PARCEL_COMPENSABLE_FROM)[number])) {
        throw badRequest(
          `Compensation cannot be recorded against a ${parcel.status} parcel ` +
            `(allowed: ${PARCEL_COMPENSABLE_FROM.join(", ")})`,
        );
      }
      await validateEvidence(app.db, req.companyId!, req.projectId!, body.evidenceIds);
      const amount = round2(body.amount);
      const merged = [...new Set([...parcel.evidenceIds, ...body.evidenceIds])];
      await app.db
        .update(landParcels)
        .set({
          compensationAmount: amount,
          compensationPaidAt: body.paidAt,
          evidenceIds: merged,
          status: "compensated",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(landParcels.id, parcelId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "land_parcel",
        objectId: parcelId,
        payload: {
          from: parcel.status,
          to: "compensated",
          reference: parcel.reference,
          amount,
          currency: parcel.currency,
          paidAt: body.paidAt,
          valuationAmount: parcel.valuationAmount,
          evidenceIds: body.evidenceIds,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      return fetchParcel(parcelId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Consent-to-programme dependency mapping (#591)                    */
  /* ---------------------------------------------------------------- */

  /**
   * The question a programme director actually asks: which works are about
   * to start on land we do not yet hold? Every parcel that is not `acquired`
   * and that blocks a task starting inside the horizon is reported, ordered
   * by urgency. Anything starting inside 30 days also raises an integrity
   * signal — once per (parcel, task), so repeated reads never duplicate it.
   */
  app.get("/projects/:projectId/land/schedule-risk", { preHandler: readGate }, async (req) => {
    const q = scheduleRiskQuery.parse(req.query);
    const parcels = await app.db
      .select()
      .from(landParcels)
      .where(
        and(
          eq(landParcels.companyId, req.companyId!),
          eq(landParcels.projectId, req.projectId!),
          inArray(landParcels.status, [...PARCEL_BLOCKING_STATUSES]),
        ),
      )
      .orderBy(asc(landParcels.reference));
    const allTaskIds = [...new Set(parcels.flatMap((p) => p.blockingTaskIds))];
    const tasks = await resolveTasks(app.db, req.projectId!, allTaskIds);

    interface RiskRow {
      parcelId: string;
      reference: string;
      status: string;
      tenureType: string;
      ownerName: string | null;
      taskId: string;
      taskName: string;
      taskStart: string;
      daysUntilStart: number;
    }
    const items: RiskRow[] = [];
    for (const parcel of parcels) {
      for (const taskId of parcel.blockingTaskIds) {
        const task = tasks.get(taskId);
        if (!task?.startDate) continue; // unscheduled task — no date to be at risk against
        const days = daysUntil(task.startDate);
        if (days > q.days) continue;
        items.push({
          parcelId: parcel.id,
          reference: parcel.reference,
          status: parcel.status,
          tenureType: parcel.tenureType,
          ownerName: parcel.ownerName,
          taskId,
          taskName: task.name,
          taskStart: task.startDate,
          daysUntilStart: days,
        });
      }
    }
    items.sort((a, b) => a.daysUntilStart - b.daysUntilStart || a.reference.localeCompare(b.reference));

    // Idempotent signal raise, keyed on (parcel, task) carried in evidenceRefs.
    const imminent = items.filter((r) => r.daysUntilStart <= SIGNAL_HORIZON_DAYS);
    if (imminent.length > 0) {
      const existing = await app.db
        .select({ evidenceRefs: signals.evidenceRefs })
        .from(signals)
        .where(
          and(
            eq(signals.companyId, req.companyId!),
            eq(signals.projectId, req.projectId!),
            eq(signals.detector, "land_blocks_programme"),
          ),
        );
      const seen = new Set(
        existing.map((row) => {
          const refs = row.evidenceRefs as { parcelId?: string; taskId?: string } | null;
          return `${refs?.parcelId ?? ""}::${refs?.taskId ?? ""}`;
        }),
      );
      for (const risk of imminent) {
        const key = `${risk.parcelId}::${risk.taskId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const id = newId("sig");
        const when =
          risk.daysUntilStart < 0
            ? `started ${Math.abs(risk.daysUntilStart)} day(s) ago`
            : `starts in ${risk.daysUntilStart} day(s)`;
        await app.db.insert(signals).values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          detector: "land_blocks_programme",
          severity: "high",
          confidence: 1,
          title: `Land not acquired blocks "${risk.taskName}" — parcel ${risk.reference}`,
          explanation:
            `Parcel ${risk.reference} (${risk.tenureType} tenure${risk.ownerName ? `, ${risk.ownerName}` : ""}) ` +
            `is ${risk.status} and has not been acquired, yet it blocks schedule task ` +
            `"${risk.taskName}", which ${when} (planned start ${risk.taskStart}). ` +
            `Mobilising onto land the project does not hold exposes it to trespass, ` +
            `injunction and lender-standard non-compliance, and is one of the most common ` +
            `root causes of prolongation claims on internationally financed infrastructure.`,
          evidenceRefs: {
            parcelId: risk.parcelId,
            taskId: risk.taskId,
            reference: risk.reference,
            taskStart: risk.taskStart,
            parcelStatus: risk.status,
          },
        });
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "signal",
          objectId: id,
          payload: {
            detector: "land_blocks_programme",
            parcelId: risk.parcelId,
            taskId: risk.taskId,
          },
        });
      }
    }

    const blockedParcels = new Set(items.map((r) => r.parcelId));
    return {
      horizonDays: q.days,
      /** headline: how many works packages are standing on un-acquired land */
      blockedTasks: items.length,
      blockedParcels: blockedParcels.size,
      imminent: imminent.length,
      alreadyStarted: items.filter((r) => r.daysUntilStart < 0).length,
      signalHorizonDays: SIGNAL_HORIZON_DAYS,
      items,
    };
  });

  /** Ordered acquisition pipeline for the register header (#551). */
  app.get("/projects/:projectId/land/parcel-summary", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select({ status: landParcels.status, n: count() })
      .from(landParcels)
      .where(
        and(
          eq(landParcels.companyId, req.companyId!),
          eq(landParcels.projectId, req.projectId!),
        ),
      )
      .groupBy(landParcels.status)
      .orderBy(desc(count()));
    return {
      byStatus: Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])),
      total: rows.reduce((s, r) => s + Number(r.n), 0),
    };
  });
}
