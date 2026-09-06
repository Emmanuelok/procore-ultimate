import type { FastifyInstance } from "fastify";
import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { affectedPersons, landParcels } from "@constructos/db";
import { ACQUISITION_BASES, PARCEL_STATUSES, TENURE_TYPES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema, todayISO } from "../field/dates.js";
import {
  CASH_ACQUISITION_BASES,
  PARCEL_ACQUIRABLE_FROM,
  PARCEL_COMPENSABLE_FROM,
  PARCEL_TRANSITIONS,
} from "./reference.js";
import { loadConsentView, SIGNAL_HORIZON_DAYS } from "./consent-service.js";
import {
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

const acquireSchema = z.object({
  acquisitionBasis: z.enum(ACQUISITION_BASES),
  acquiredAt: isoDateSchema.optional(),
  /** title transfer, lease, donation deed, court order, allocation letter */
  evidenceIds: z.array(z.string().min(1)).min(1).max(100),
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
      /*
       * `acquired` is deliberately absent from the transition table — title
       * passes through the evidenced /acquire route, which records the BASIS
       * on which it passed. The register therefore has to tell the workspace
       * when that route is open, or the only way to mark a state-owned or
       * donated parcel acquired would be to invent a dispute.
       */
      acquirable:
        parcel.status !== "acquired" &&
        PARCEL_ACQUIRABLE_FROM.includes(parcel.status as (typeof PARCEL_ACQUIRABLE_FROM)[number]),
      /** bases that require a compensation payment before possession */
      cashAcquisitionBases: CASH_ACQUISITION_BASES,
      acquisitionBases: ACQUISITION_BASES,
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
      /*
       * Once compensation has been PAID, the amount and the currency are
       * facts about a transaction that happened, not editable attributes.
       * A general PATCH could previously move a parcel compensated at
       * 10,000 USD to 50,000 USD, and the only trace was an "update" row
       * saying `compensationAmount changed` — no before, no after, no
       * evidence. A supplementary payment is a supplementary /compensate
       * with its own evidence; a mistake is a correction with a reason.
       */
      if (parcel.compensationPaidAt) {
        const frozen = (["compensationAmount", "currency", "valuationAmount"] as const).filter(
          (k) => body[k] !== undefined && body[k] !== parcel[k],
        );
        if (frozen.length > 0) {
          throw conflict(
            `Parcel ${parcel.reference} was compensated on ${parcel.compensationPaidAt}: ` +
              `${frozen.join(", ")} cannot be edited afterwards. Record a supplementary payment ` +
              `through POST /parcels/${parcelId}/compensate with its own evidence.`,
          );
        }
      }
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
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
        if (body[key] !== undefined) {
          set[key] = body[key];
          before[key] = parcel[key];
          after[key] = body[key];
        }
      }
      await app.db.update(landParcels).set(set).where(eq(landParcels.id, parcelId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "land_parcel",
        objectId: parcelId,
        // the values, not the key names: a compensation figure that moved
        // has to be readable from the ledger without the record beside it
        payload: { before, after },
        storePayload: true,
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
      if (body.status === "acquired") {
        throw badRequest(
          "A parcel is marked acquired only through the evidenced acquisition route " +
            "(POST /parcels/:parcelId/acquire), which records the basis on which title passed",
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
   * Title actually passing (#551-552).
   *
   * Before this route the ONLY way into `acquired` without a cash payment
   * was `agreed → disputed → acquired`. On a road scheme dominated by
   * state-owned land, communal donations or land the employer already held,
   * that forced thirty fictitious disputes into the register — and the RAP
   * dashboard, the acquisition pipeline and the dispute statistics all read
   * them as real. Acquisition is instead its own evidenced act, naming the
   * BASIS on which title passed, from `agreed`, `compensated` or `disputed`
   * (a court order or compulsory-purchase determination settles a dispute
   * straight into acquisition).
   *
   * Evidence is mandatory: a title transfer, lease, donation deed, court
   * order or government allocation letter. A `purchase` or `expropriation`
   * basis additionally requires that compensation has actually been paid —
   * possession before payment is the IFC PS5 para 20 breach, and it must not
   * be reachable by choosing a menu item.
   */
  app.post(
    "/projects/:projectId/parcels/:parcelId/acquire",
    { preHandler: standardGate },
    async (req) => {
      const { parcelId } = req.params as { parcelId: string };
      const body = acquireSchema.parse(req.body);
      const parcel = await fetchParcel(parcelId, req.companyId!, req.projectId!);
      if (parcel.status === "acquired") throw badRequest("Parcel is already acquired");
      if (!PARCEL_ACQUIRABLE_FROM.includes(parcel.status as (typeof PARCEL_ACQUIRABLE_FROM)[number])) {
        throw badRequest(
          `A ${parcel.status} parcel cannot be acquired ` +
            `(allowed: ${PARCEL_ACQUIRABLE_FROM.join(", ")})`,
        );
      }
      if (CASH_ACQUISITION_BASES.includes(body.acquisitionBasis) && !parcel.compensationPaidAt) {
        throw badRequest(
          `Acquisition on a "${body.acquisitionBasis}" basis requires compensation to have been ` +
            `paid first: IFC PS5 para 20 requires payment before possession is taken. Record ` +
            `the payment through /compensate, or state the non-cash basis on which title passed.`,
        );
      }
      await validateEvidence(app.db, req.companyId!, req.projectId!, body.evidenceIds);
      const acquiredAt = body.acquiredAt ?? todayISO();
      const merged = [...new Set([...parcel.evidenceIds, ...body.evidenceIds])];
      await app.db
        .update(landParcels)
        .set({
          status: "acquired",
          acquisitionBasis: body.acquisitionBasis,
          acquiredAt,
          evidenceIds: merged,
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
          to: "acquired",
          reference: parcel.reference,
          acquisitionBasis: body.acquisitionBasis,
          acquiredAt,
          tenureType: parcel.tenureType,
          compensationPaidAt: parcel.compensationPaidAt,
          evidenceIds: body.evidenceIds,
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
   * Which works are about to start on land the project does not hold — and,
   * now, under a consent it has not been granted: parcels and permits are
   * one dependency set, because a task blocked by both is not two separate
   * risks to a programme director.
   *
   * This read is PURE. It used to raise signals and append ledger rows as a
   * side effect of being looked at, with no lock and no unique key, so the
   * two requests the land workspace fires in parallel both inserted the same
   * finding. Raising is now the scheduled detector's job (system actor,
   * advisory-locked, fingerprinted, auto-closing when the dependency
   * clears); the view reports what is true, and quantifies it: days-at-risk
   * per dependency from the project's own median resolution times, and the
   * slip that survives the task's float.
   */
  app.get("/projects/:projectId/land/schedule-risk", { preHandler: readGate }, async (req) => {
    const q = scheduleRiskQuery.parse(req.query);
    const { view } = await loadConsentView(app.db, req.companyId!, req.projectId!, {
      horizonDays: q.days,
      withObservations: true,
    });

    // Flat (dependency × task) rows, which is what the register renders.
    const items = view.tasks.flatMap((task) =>
      task.dependencies.map((dep) => ({
        kind: dep.kind,
        dependencyId: dep.id,
        // kept for backwards compatibility with the parcel-only view
        parcelId: dep.kind === "parcel" ? dep.id : null,
        permitId: dep.kind === "permit" ? dep.id : null,
        reference: dep.reference,
        label: dep.label,
        status: dep.status,
        taskId: task.taskId,
        taskName: task.taskName,
        taskStart: task.plannedStart ?? task.actualStart,
        daysUntilStart: task.daysUntilStart,
        isCritical: task.isCritical,
        totalFloat: task.totalFloat,
        daysAtRisk: dep.daysAtRisk,
        expectedResolutionDate: dep.expectedResolutionDate,
        estimateSource: dep.estimateSource,
        estimateSampleSize: dep.estimateSampleSize,
        slipContribution: task.slipContribution,
        startedUnconsented: task.startedUnconsented,
        basis: task.basis,
        detail: dep.detail,
      })),
    );
    items.sort(
      (a, b) =>
        (a.daysUntilStart ?? Number.MAX_SAFE_INTEGER) -
          (b.daysUntilStart ?? Number.MAX_SAFE_INTEGER) ||
        b.daysAtRisk - a.daysAtRisk ||
        a.reference.localeCompare(b.reference),
    );

    return {
      horizonDays: view.horizonDays,
      signalHorizonDays: SIGNAL_HORIZON_DAYS,
      /** headline: how many works packages stand on unresolved consent */
      blockedTasks: view.summary.blockedTasks,
      blockedParcels: view.summary.blockingParcels,
      blockingPermits: view.summary.blockingPermits,
      alreadyStarted: view.summary.startedUnconsented,
      imminent: items.filter(
        (i) => i.daysUntilStart !== null && i.daysUntilStart <= SIGNAL_HORIZON_DAYS,
      ).length,
      summary: view.summary,
      tasks: view.tasks,
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
