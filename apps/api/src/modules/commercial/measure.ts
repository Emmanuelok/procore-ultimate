import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  boqItems,
  boqs,
  provisionalSumExpenditures,
  provisionalSums,
  remeasurements,
} from "@constructos/db";
import {
  PROVISIONAL_SUM_KINDS,
  REMEASUREMENT_METHODS,
  REMEASUREMENT_STATUSES,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import {
  isoDateSchema,
  raiseSignalOnce,
  requireCommercialLevel,
  round2,
  round3,
  subResourceGate,
} from "./shared.js";

const remeasureCreateSchema = z.object({
  boqItemId: z.string().min(1),
  remeasuredQuantity: z.number().nonnegative(),
  method: z.enum(REMEASUREMENT_METHODS),
  measuredAt: isoDateSchema,
  witnessedBy: z.string().max(60).nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
  evidenceRef: z.string().max(300).nullable().optional(),
});

const remeasureListQuery = pageQuerySchema.extend({
  status: z.enum(REMEASUREMENT_STATUSES).optional(),
  boqId: z.string().optional(),
});

const disputeSchema = z.object({ reason: z.string().min(3).max(2000) });

const psCreateSchema = z.object({
  boqItemId: z.string().min(1),
  kind: z.enum(PROVISIONAL_SUM_KINDS),
  title: z.string().min(1).max(300),
  allowance: z.number().nonnegative(),
});

const psInstructSchema = z.object({
  instructionRef: z.string().min(1).max(200),
  instructedAt: isoDateSchema,
});

const expenditureSchema = z.object({
  description: z.string().min(1).max(500),
  amount: z.number().finite(),
  spentOn: isoDateSchema,
  sourceType: z.string().max(60).nullable().optional(),
  sourceId: z.string().max(60).nullable().optional(),
});

/**
 * Remeasurement (#141-144) and provisional sums / prime cost (#125-127).
 *
 * REMEASUREMENT is an assertion about quantity, and the platform's rule is
 * that an assertion and the test of it are not authored by the same person:
 * a remeasurement is proposed by one user and agreed by another, and only an
 * AGREED record may be applied to the bill. The original quantity is captured
 * at proposal time so the movement is always recoverable.
 *
 * PROVISIONAL SUMS are allowances, not work. Expenditure is recorded against
 * the allowance so the adjustment in the final account (omit the allowance,
 * add the expenditure) is a computed figure, and overspend raises a signal
 * instead of quietly inflating the forecast.
 */
export const measureRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("commercial", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("commercial", "standard"),
  ];
  const subRead = subResourceGate(app, "read");
  const subWrite = subResourceGate(app, "standard");

  async function itemOnProject(itemId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select({ item: boqItems, boq: boqs })
      .from(boqItems)
      .innerJoin(boqs, eq(boqs.id, boqItems.boqId))
      .where(
        and(
          eq(boqItems.id, itemId),
          eq(boqs.companyId, companyId),
          eq(boqs.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw badRequest("boqItemId does not reference a BQ item on this project");
    return rows[0];
  }

  async function ledger(
    req: { companyId?: string; user?: { id: string } },
    action: "create" | "update" | "state_change",
    objectType: string,
    objectId: string,
    payload: unknown,
    projectId: string,
    storePayload = false,
  ) {
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action,
      objectType,
      objectId,
      payload,
      projectId,
      storePayload,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Remeasurement                                                     */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/remeasurements", { preHandler: standardGate }, async (req, reply) => {
    const body = remeasureCreateSchema.parse(req.body);
    const { item, boq } = await itemOnProject(body.boqItemId, req.companyId!, req.projectId!);
    if (item.level !== "item") throw badRequest("Only a leaf BQ item can be remeasured");
    if (boq.status === "draft") {
      throw badRequest("A draft bill is edited directly; remeasurement applies to an issued bill");
    }
    const open = await app.db
      .select({ id: remeasurements.id })
      .from(remeasurements)
      .where(
        and(
          eq(remeasurements.boqItemId, body.boqItemId),
          inArray(remeasurements.status, ["proposed", "agreed"]),
        ),
      )
      .limit(1);
    if (open[0]) {
      throw conflict("This BQ item already has an open remeasurement; resolve it first");
    }
    const id = newId("rms");
    await app.db.insert(remeasurements).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      boqId: boq.id,
      boqItemId: body.boqItemId,
      originalQuantity: item.quantity,
      remeasuredQuantity: round3(body.remeasuredQuantity),
      method: body.method,
      status: "proposed",
      measuredAt: body.measuredAt,
      measuredBy: req.user!.id,
      witnessedBy: body.witnessedBy ?? null,
      note: body.note ?? null,
      evidenceRef: body.evidenceRef ?? null,
    });
    await ledger(
      req,
      "create",
      "remeasurement",
      id,
      {
        boqItemId: body.boqItemId,
        code: item.code,
        originalQuantity: item.quantity,
        remeasuredQuantity: round3(body.remeasuredQuantity),
        method: body.method,
      },
      req.projectId!,
      true,
    );
    const created = await app.db
      .select()
      .from(remeasurements)
      .where(eq(remeasurements.id, id))
      .limit(1);
    return reply.status(201).send(created[0]);
  });

  app.get("/projects/:projectId/remeasurements", { preHandler: readGate }, async (req) => {
    const q = remeasureListQuery.parse(req.query);
    const clauses = [
      eq(remeasurements.companyId, req.companyId!),
      eq(remeasurements.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(remeasurements.status, q.status));
    if (q.boqId) clauses.push(eq(remeasurements.boqId, q.boqId));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(remeasurements).where(where);
    const rows = await app.db
      .select({
        r: remeasurements,
        code: boqItems.code,
        description: boqItems.description,
        unit: boqItems.unit,
        rate: boqItems.rate,
      })
      .from(remeasurements)
      .innerJoin(boqItems, eq(boqItems.id, remeasurements.boqItemId))
      .where(where)
      .orderBy(desc(remeasurements.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const items = rows.map(({ r, code, description, unit, rate }) => ({
      ...r,
      code,
      description,
      unit,
      rate,
      quantityMovement:
        r.originalQuantity == null ? null : round3(r.remeasuredQuantity - r.originalQuantity),
      valueMovement:
        r.originalQuantity == null || rate == null
          ? null
          : round2((r.remeasuredQuantity - r.originalQuantity) * rate),
    }));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /**
   * Agreement is the second signature. The measurer cannot agree their own
   * measure, and agreement applies the quantity to the bill in one
   * transaction so the register and the bill can never disagree.
   */
  app.post("/remeasurements/:remeasurementId/agree", { preHandler: subWrite }, async (req, reply) => {
    const { remeasurementId } = req.params as { remeasurementId: string };
    const rows = await app.db
      .select()
      .from(remeasurements)
      .where(
        and(
          eq(remeasurements.id, remeasurementId),
          eq(remeasurements.companyId, req.companyId!),
        ),
      )
      .limit(1);
    const rec = rows[0];
    if (!rec) throw notFound("Remeasurement not found");
    await requireCommercialLevel(app, req, reply, rec.projectId, "standard");
    if (rec.status !== "proposed") throw badRequest(`A ${rec.status} remeasurement cannot be agreed`);
    if (rec.measuredBy === req.user!.id) {
      throw forbidden("A remeasurement must be agreed by someone other than the person who measured it");
    }

    const now = new Date().toISOString();
    let applied: { quantity: number; amount: number | null } | null = null;
    await app.db.transaction(async (tx) => {
      const itemRows = await tx
        .select()
        .from(boqItems)
        .where(eq(boqItems.id, rec.boqItemId))
        .limit(1);
      const item = itemRows[0];
      if (!item) throw notFound("The BQ item this remeasurement applies to no longer exists");
      const amount = item.rate != null ? round2(rec.remeasuredQuantity * item.rate) : null;
      await tx
        .update(boqItems)
        .set({ quantity: rec.remeasuredQuantity, amount, updatedAt: now })
        .where(eq(boqItems.id, rec.boqItemId));
      await tx
        .update(remeasurements)
        .set({
          status: "applied",
          agreedBy: req.user!.id,
          agreedAt: now,
          appliedAt: now,
          updatedAt: now,
        })
        .where(and(eq(remeasurements.id, remeasurementId), eq(remeasurements.status, "proposed")));
      applied = { quantity: rec.remeasuredQuantity, amount };
    });

    await ledger(
      req,
      "state_change",
      "remeasurement",
      remeasurementId,
      {
        from: "proposed",
        to: "applied",
        boqItemId: rec.boqItemId,
        originalQuantity: rec.originalQuantity,
        remeasuredQuantity: rec.remeasuredQuantity,
        applied,
      },
      rec.projectId,
      true,
    );
    const updated = await app.db
      .select()
      .from(remeasurements)
      .where(eq(remeasurements.id, remeasurementId))
      .limit(1);
    return updated[0];
  });

  app.post("/remeasurements/:remeasurementId/dispute", { preHandler: subWrite }, async (req, reply) => {
    const { remeasurementId } = req.params as { remeasurementId: string };
    const body = disputeSchema.parse(req.body);
    const rows = await app.db
      .select()
      .from(remeasurements)
      .where(
        and(eq(remeasurements.id, remeasurementId), eq(remeasurements.companyId, req.companyId!)),
      )
      .limit(1);
    const rec = rows[0];
    if (!rec) throw notFound("Remeasurement not found");
    await requireCommercialLevel(app, req, reply, rec.projectId, "standard");
    if (rec.status !== "proposed") throw badRequest(`A ${rec.status} remeasurement cannot be disputed`);
    await app.db
      .update(remeasurements)
      .set({
        status: "disputed",
        disputeReason: body.reason,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(remeasurements.id, remeasurementId), eq(remeasurements.status, "proposed")));
    await ledger(
      req,
      "state_change",
      "remeasurement",
      remeasurementId,
      { from: "proposed", to: "disputed", reason: body.reason },
      rec.projectId,
      true,
    );
    const updated = await app.db
      .select()
      .from(remeasurements)
      .where(eq(remeasurements.id, remeasurementId))
      .limit(1);
    return updated[0];
  });

  /* ---------------------------------------------------------------- */
  /* Provisional sums and prime cost (#125-127)                        */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/provisional-sums", { preHandler: standardGate }, async (req, reply) => {
    const body = psCreateSchema.parse(req.body);
    const { item, boq } = await itemOnProject(body.boqItemId, req.companyId!, req.projectId!);
    if (item.level !== "item") throw badRequest("A provisional sum attaches to a leaf BQ item");
    const existing = await app.db
      .select({ id: provisionalSums.id })
      .from(provisionalSums)
      .where(eq(provisionalSums.boqItemId, body.boqItemId))
      .limit(1);
    if (existing[0]) throw conflict("This BQ item already has a provisional sum record");
    const id = newId("psum");
    await app.db.insert(provisionalSums).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      boqId: boq.id,
      boqItemId: body.boqItemId,
      kind: body.kind,
      title: body.title,
      allowance: round2(body.allowance),
      currency: boq.currency,
      status: "open",
      createdBy: req.user!.id,
    });
    await ledger(
      req,
      "create",
      "provisional_sum",
      id,
      { boqItemId: body.boqItemId, kind: body.kind, allowance: round2(body.allowance) },
      req.projectId!,
    );
    const created = await app.db
      .select()
      .from(provisionalSums)
      .where(eq(provisionalSums.id, id))
      .limit(1);
    return reply.status(201).send(created[0]);
  });

  app.get("/projects/:projectId/provisional-sums", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = and(
      eq(provisionalSums.companyId, req.companyId!),
      eq(provisionalSums.projectId, req.projectId!),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(provisionalSums).where(where);
    const rows = await app.db
      .select({ ps: provisionalSums, code: boqItems.code, description: boqItems.description })
      .from(provisionalSums)
      .innerJoin(boqItems, eq(boqItems.id, provisionalSums.boqItemId))
      .where(where)
      .orderBy(asc(boqItems.code))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const items = rows.map(({ ps, code, description }) => ({
      ...ps,
      code,
      description,
      variance: round2(ps.expendedTotal - ps.allowance),
      variancePercent:
        ps.allowance > 0
          ? Math.round(((ps.expendedTotal - ps.allowance) / ps.allowance) * 1000) / 10
          : null,
    }));
    const byCurrency = new Map<string, { allowance: number; expended: number }>();
    for (const row of items) {
      const b = byCurrency.get(row.currency) ?? { allowance: 0, expended: 0 };
      b.allowance += row.allowance;
      b.expended += row.expendedTotal;
      byCurrency.set(row.currency, b);
    }
    return {
      ...paginate(items, Number(totalRow?.n ?? 0), q),
      byCurrency: [...byCurrency.entries()].map(([currency, b]) => ({
        currency,
        allowance: round2(b.allowance),
        expended: round2(b.expended),
        remaining: round2(b.allowance - b.expended),
      })),
    };
  });

  app.post("/provisional-sums/:psId/instruct", { preHandler: subWrite }, async (req, reply) => {
    const { psId } = req.params as { psId: string };
    const body = psInstructSchema.parse(req.body);
    const rows = await app.db
      .select()
      .from(provisionalSums)
      .where(and(eq(provisionalSums.id, psId), eq(provisionalSums.companyId, req.companyId!)))
      .limit(1);
    const ps = rows[0];
    if (!ps) throw notFound("Provisional sum not found");
    await requireCommercialLevel(app, req, reply, ps.projectId, "standard");
    if (ps.status !== "open") throw badRequest(`A ${ps.status} provisional sum cannot be instructed`);
    await app.db
      .update(provisionalSums)
      .set({
        status: "instructed",
        instructionRef: body.instructionRef,
        instructedAt: body.instructedAt,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(provisionalSums.id, psId));
    await ledger(
      req,
      "state_change",
      "provisional_sum",
      psId,
      { from: "open", to: "instructed", instructionRef: body.instructionRef },
      ps.projectId,
    );
    const updated = await app.db
      .select()
      .from(provisionalSums)
      .where(eq(provisionalSums.id, psId))
      .limit(1);
    return updated[0];
  });

  app.post("/provisional-sums/:psId/omit", { preHandler: subWrite }, async (req, reply) => {
    const { psId } = req.params as { psId: string };
    const rows = await app.db
      .select()
      .from(provisionalSums)
      .where(and(eq(provisionalSums.id, psId), eq(provisionalSums.companyId, req.companyId!)))
      .limit(1);
    const ps = rows[0];
    if (!ps) throw notFound("Provisional sum not found");
    await requireCommercialLevel(app, req, reply, ps.projectId, "standard");
    if (ps.expendedTotal > 0.005) {
      throw badRequest("A provisional sum with recorded expenditure cannot be omitted");
    }
    await app.db
      .update(provisionalSums)
      .set({ status: "omitted", updatedAt: new Date().toISOString() })
      .where(eq(provisionalSums.id, psId));
    await ledger(
      req,
      "state_change",
      "provisional_sum",
      psId,
      { from: ps.status, to: "omitted", allowance: ps.allowance },
      ps.projectId,
    );
    const updated = await app.db
      .select()
      .from(provisionalSums)
      .where(eq(provisionalSums.id, psId))
      .limit(1);
    return updated[0];
  });

  app.get("/provisional-sums/:psId/expenditures", { preHandler: subRead }, async (req, reply) => {
    const { psId } = req.params as { psId: string };
    const rows = await app.db
      .select()
      .from(provisionalSums)
      .where(and(eq(provisionalSums.id, psId), eq(provisionalSums.companyId, req.companyId!)))
      .limit(1);
    const ps = rows[0];
    if (!ps) throw notFound("Provisional sum not found");
    await requireCommercialLevel(app, req, reply, ps.projectId, "read");
    const items = await app.db
      .select()
      .from(provisionalSumExpenditures)
      .where(eq(provisionalSumExpenditures.provisionalSumId, psId))
      .orderBy(asc(provisionalSumExpenditures.spentOn));
    return {
      items,
      allowance: ps.allowance,
      expended: ps.expendedTotal,
      remaining: round2(ps.allowance - ps.expendedTotal),
      currency: ps.currency,
    };
  });

  app.post("/provisional-sums/:psId/expenditures", { preHandler: subWrite }, async (req, reply) => {
    const { psId } = req.params as { psId: string };
    const body = expenditureSchema.parse(req.body);
    const rows = await app.db
      .select()
      .from(provisionalSums)
      .where(and(eq(provisionalSums.id, psId), eq(provisionalSums.companyId, req.companyId!)))
      .limit(1);
    const ps = rows[0];
    if (!ps) throw notFound("Provisional sum not found");
    await requireCommercialLevel(app, req, reply, ps.projectId, "standard");
    if (ps.status === "omitted" || ps.status === "closed") {
      throw badRequest(`A ${ps.status} provisional sum cannot take further expenditure`);
    }
    const id = newId("psx");
    const newTotal = round2(ps.expendedTotal + body.amount);
    await app.db.transaction(async (tx) => {
      await tx.insert(provisionalSumExpenditures).values({
        id,
        companyId: req.companyId!,
        provisionalSumId: psId,
        description: body.description,
        amount: round2(body.amount),
        spentOn: body.spentOn,
        sourceType: body.sourceType ?? null,
        sourceId: body.sourceId ?? null,
        createdBy: req.user!.id,
      });
      await tx
        .update(provisionalSums)
        .set({
          expendedTotal: newTotal,
          status: ps.status === "open" ? "expended" : ps.status === "instructed" ? "expended" : ps.status,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(provisionalSums.id, psId));
    });

    // Overspend is a commercial fact the assurance layer should see, raised
    // once per provisional sum rather than on every expenditure line.
    let signalRaised = false;
    if (newTotal > ps.allowance + 0.005) {
      const res = await raiseSignalOnce(app.db, {
        companyId: req.companyId!,
        projectId: ps.projectId,
        detector: "provisional_sum_overspend",
        key: `provisional_sum_overspend:${psId}`,
        severity: "medium",
        confidence: 1,
        title: `Provisional sum overspent — ${ps.title}`,
        explanation:
          `Expenditure against the provisional sum "${ps.title}" now totals ${newTotal} ${ps.currency} ` +
          `against an allowance of ${ps.allowance} ${ps.currency} (over by ${round2(newTotal - ps.allowance)}). ` +
          `The excess flows into the final account as an adjustment and should be covered by an instruction.`,
        evidenceRefs: { provisionalSumId: psId, allowance: ps.allowance, expended: newTotal },
      });
      signalRaised = res.raised;
    }

    await ledger(
      req,
      "update",
      "provisional_sum",
      psId,
      { expenditureId: id, amount: round2(body.amount), expendedTotal: newTotal, signalRaised },
      ps.projectId,
      true,
    );
    const created = await app.db
      .select()
      .from(provisionalSumExpenditures)
      .where(eq(provisionalSumExpenditures.id, id))
      .limit(1);
    return reply.status(201).send({ ...created[0], expendedTotal: newTotal, signalRaised });
  });
};
