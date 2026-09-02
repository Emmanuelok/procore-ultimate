import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { backcharges, commitmentChanges, commitmentSovLines, commitments } from "@constructos/db";
import { BACKCHARGE_REASON_CODES, BACKCHARGE_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { recomputeCommitmentTotals } from "./rollups.js";
import {
  changeReference,
  detailSchema,
  fetchCommitment,
  ledger,
  requireCommitmentsLevel,
  round2,
  todayIso,
} from "./shared.js";

/**
 * BACKCHARGES (spec #538) — cost recovered FROM a subcontractor.
 *
 * A backcharge is not a payment deduction someone remembers to make. It is a
 * record with a reason code and evidence, and ISSUING it raises a negative
 * commitment change order through the ordinary allocation path, so the
 * commitment sum moves with the same identities as any other change and the
 * register still reconciles. Until the negative change order is approved the
 * open amount is RESERVED against the next payment (payments.ts
 * `assertWithinCommitment`), so the money cannot leave in the meantime.
 *
 *   draft -> issued (negative CCO pending) -> settled (CCO approved)
 *         -> disputed (sub objects; still reserved)
 *         -> void
 *
 * Reversal of the CCO voids the backcharge back to draft; the change module's
 * pass-down detector (changes/analytics.ts) counts backcharges whose reason
 * code is `errors_omissions`-shaped against the change events that caused them.
 */

const evidenceSchema = z.object({
  type: z.string().min(1).max(60),
  id: z.string().min(1).max(64),
  label: z.string().max(300).optional(),
});

const createSchema = z.object({
  reasonCode: z.enum(BACKCHARGE_REASON_CODES),
  title: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  amount: z.number().finite().positive(),
  evidence: z.array(evidenceSchema).max(100).optional(),
  sovLineId: z.string().min(1).max(64).nullable().optional(),
  detail: detailSchema.optional(),
});

const patchSchema = createSchema.partial();

const listQuery = pageQuerySchema.extend({
  status: z.enum(BACKCHARGE_STATUSES).optional(),
  commitmentId: z.string().min(1).max(64).optional(),
  vendorId: z.string().min(1).max(64).optional(),
});

const reasonSchema = z.object({ reason: z.string().min(1).max(4000) });

export const backchargeRoutes: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];
  const readGate = [...companyGate, app.requireTool("commitments", "read")];

  async function fetchBackcharge(id: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(backcharges)
      .where(and(eq(backcharges.id, id), eq(backcharges.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Backcharge not found");
    return rows[0];
  }

  app.post("/commitments/:commitmentId/backcharges", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const body = createSchema.parse(req.body);
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
    if (commitment.status !== "approved" && commitment.status !== "complete") {
      throw conflict(`A backcharge can only be raised against an approved commitment (this one is ${commitment.status})`);
    }
    if (body.sovLineId) {
      const rows = await app.db
        .select({ id: commitmentSovLines.id })
        .from(commitmentSovLines)
        .where(and(eq(commitmentSovLines.id, body.sovLineId), eq(commitmentSovLines.commitmentId, commitmentId)))
        .limit(1);
      if (!rows[0]) throw badRequest("sovLineId does not belong to this commitment's schedule of values");
    }
    const number = await nextRecordNumber(app.db, commitment.projectId, "backcharge");
    const id = newId("bck");
    await app.db.insert(backcharges).values({
      id,
      companyId: req.companyId!,
      projectId: commitment.projectId,
      commitmentId,
      vendorId: commitment.vendorId,
      number,
      reference: `BC-${String(number).padStart(4, "0")}`,
      reasonCode: body.reasonCode,
      title: body.title,
      description: body.description ?? null,
      amount: round2(body.amount),
      currency: commitment.currency,
      status: "draft",
      evidence: body.evidence ?? [],
      sovLineId: body.sovLineId ?? null,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    await ledger(app.db, req, "create", "commitment", commitmentId, {
      backchargeId: id,
      reasonCode: body.reasonCode,
      amount: round2(body.amount),
    }, commitment.projectId);
    return reply.status(201).send(await fetchBackcharge(id, req.companyId!));
  });

  app.get("/commitments/:commitmentId/backcharges", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "read");
    const items = await app.db
      .select()
      .from(backcharges)
      .where(eq(backcharges.commitmentId, commitmentId))
      .orderBy(asc(backcharges.number));
    const open = items.filter((b) => b.status === "issued" || b.status === "disputed");
    return {
      items,
      currency: commitment.currency,
      register: {
        open: round2(open.reduce((s, b) => s + b.amount, 0)),
        settled: round2(items.filter((b) => b.status === "settled").reduce((s, b) => s + b.amount, 0)),
        disputed: round2(items.filter((b) => b.status === "disputed").reduce((s, b) => s + b.amount, 0)),
      },
    };
  });

  app.get("/projects/:projectId/backcharges", { preHandler: readGate }, async (req) => {
    const q = listQuery.parse(req.query);
    const clauses = [eq(backcharges.companyId, req.companyId!), eq(backcharges.projectId, req.projectId!)];
    if (q.status) clauses.push(eq(backcharges.status, q.status));
    if (q.commitmentId) clauses.push(eq(backcharges.commitmentId, q.commitmentId));
    if (q.vendorId) clauses.push(eq(backcharges.vendorId, q.vendorId));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(backcharges).where(where);
    const items = await app.db
      .select()
      .from(backcharges)
      .where(where)
      .orderBy(desc(backcharges.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/backcharges/:backchargeId", { preHandler: companyGate }, async (req, reply) => {
    const { backchargeId } = req.params as { backchargeId: string };
    const row = await fetchBackcharge(backchargeId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, row.projectId, "read");
    const change = row.commitmentChangeId
      ? (await app.db.select().from(commitmentChanges).where(eq(commitmentChanges.id, row.commitmentChangeId)).limit(1))[0] ?? null
      : null;
    return { backcharge: row, commitmentChange: change };
  });

  app.patch("/backcharges/:backchargeId", { preHandler: companyGate }, async (req, reply) => {
    const { backchargeId } = req.params as { backchargeId: string };
    const body = patchSchema.parse(req.body);
    const row = await fetchBackcharge(backchargeId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, row.projectId, "standard");
    if (row.status !== "draft") {
      throw conflict(`A ${row.status} backcharge cannot be edited; void it and raise a corrected one`);
    }
    await app.db
      .update(backcharges)
      .set({
        ...(body.reasonCode !== undefined ? { reasonCode: body.reasonCode } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.amount !== undefined ? { amount: round2(body.amount) } : {}),
        ...(body.evidence !== undefined ? { evidence: body.evidence } : {}),
        ...(body.sovLineId !== undefined ? { sovLineId: body.sovLineId } : {}),
        ...(body.detail !== undefined ? { detail: body.detail } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(backcharges.id, backchargeId));
    await ledger(app.db, req, "update", "commitment", row.commitmentId, {
      backchargeId,
      changed: Object.keys(body),
    }, row.projectId);
    return fetchBackcharge(backchargeId, req.companyId!);
  });

  /**
   * ISSUE — raises the negative change order (draft -> submitted) so the
   * ordinary CCO approval, by somebody other than the issuer, moves the sum.
   * From this moment the amount is reserved against the next payment.
   */
  app.post("/backcharges/:backchargeId/issue", { preHandler: companyGate }, async (req, reply) => {
    const { backchargeId } = req.params as { backchargeId: string };
    const row = await fetchBackcharge(backchargeId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, row.projectId, "standard");
    if (row.status !== "draft") throw conflict(`A ${row.status} backcharge cannot be issued`);
    if (row.evidence.length === 0) {
      throw badRequest(
        "A backcharge needs at least one piece of evidence (a punch item, an NCR, an incident, a " +
          "photo) before it is issued. Recovering money from a subcontractor on an assertion is a dispute.",
      );
    }
    const commitment = await fetchCommitment(app.db, row.commitmentId, req.companyId!);
    const number = await nextRecordNumber(app.db, commitment.projectId, `commitment_change:${commitment.id}`);
    const changeId = newId("cco");
    const now = new Date().toISOString();
    await app.db.transaction(async (tx) => {
      await tx.insert(commitmentChanges).values({
        id: changeId,
        companyId: commitment.companyId,
        projectId: commitment.projectId,
        commitmentId: commitment.id,
        number,
        reference: changeReference(commitment.reference, number),
        title: `Backcharge ${row.reference} — ${row.title}`,
        description: row.description,
        reason: "other",
        status: "pending_in_house_review",
        amount: round2(-row.amount),
        scheduleImpactDays: 0,
        lines: [
          {
            sovLineId: row.sovLineId,
            costCode: null,
            costType: "subcontract",
            description: `Backcharge ${row.reference}: ${row.title}`,
            amount: round2(-row.amount),
            budgetLineItemId: null,
          },
        ],
        revisedCommitmentSum: commitment.revisedCommitmentSum,
        requestedDate: todayIso(),
        detail: { backchargeId: row.id, reasonCode: row.reasonCode, evidence: row.evidence },
        createdBy: req.user!.id,
        submittedBy: req.user!.id,
        submittedAt: now,
      });
      await tx
        .update(backcharges)
        .set({ status: "issued", commitmentChangeId: changeId, issuedBy: req.user!.id, issuedAt: now, updatedAt: now })
        .where(eq(backcharges.id, backchargeId));
      await recomputeCommitmentTotals(tx, commitment.id);
    });
    await ledger(app.db, req, "state_change", "commitment", commitment.id, {
      backchargeId,
      status: "issued",
      commitmentChangeId: changeId,
      amount: -row.amount,
    }, commitment.projectId);
    return { backcharge: await fetchBackcharge(backchargeId, req.companyId!), commitmentChangeId: changeId };
  });

  app.post("/backcharges/:backchargeId/dispute", { preHandler: companyGate }, async (req, reply) => {
    const { backchargeId } = req.params as { backchargeId: string };
    const body = reasonSchema.parse(req.body);
    const row = await fetchBackcharge(backchargeId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, row.projectId, "standard");
    if (row.status !== "issued") throw conflict(`Only an issued backcharge can be disputed (this one is ${row.status})`);
    const now = new Date().toISOString();
    await app.db
      .update(backcharges)
      .set({ status: "disputed", disputedAt: now, disputeReason: body.reason, updatedAt: now })
      .where(eq(backcharges.id, backchargeId));
    await ledger(app.db, req, "state_change", "commitment", row.commitmentId, {
      backchargeId,
      status: "disputed",
      reason: body.reason,
    }, row.projectId);
    return fetchBackcharge(backchargeId, req.companyId!);
  });

  /** Settle a disputed backcharge by agreement — optionally at a reduced figure. */
  app.post("/backcharges/:backchargeId/settle", { preHandler: companyGate }, async (req, reply) => {
    const { backchargeId } = req.params as { backchargeId: string };
    const body = z.object({ agreedAmount: z.number().finite().min(0).optional(), note: z.string().max(4000).optional() }).parse(req.body ?? {});
    const row = await fetchBackcharge(backchargeId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, row.projectId, "standard");
    if (row.status !== "disputed" && row.status !== "issued") {
      throw conflict(`A ${row.status} backcharge cannot be settled here`);
    }
    const agreed = body.agreedAmount === undefined ? row.amount : round2(body.agreedAmount);
    if (agreed > row.amount + 0.005) throw badRequest("A settlement cannot exceed the backcharge raised");
    const now = new Date().toISOString();
    await app.db.transaction(async (tx) => {
      if (row.commitmentChangeId) {
        const change = (await tx.select().from(commitmentChanges).where(eq(commitmentChanges.id, row.commitmentChangeId)).limit(1))[0];
        if (change && change.status !== "approved" && change.status !== "executed") {
          if (agreed <= 0.005) {
            await tx
              .update(commitmentChanges)
              .set({ status: "void", rejectionReason: body.note ?? "Backcharge settled at zero", updatedAt: now })
              .where(eq(commitmentChanges.id, change.id));
          } else if (Math.abs(agreed - row.amount) > 0.005) {
            const lines = (change.lines as Array<Record<string, unknown>>).map((l, i) =>
              i === 0 ? { ...l, amount: round2(-agreed) } : l,
            );
            await tx
              .update(commitmentChanges)
              .set({ amount: round2(-agreed), lines, updatedAt: now })
              .where(eq(commitmentChanges.id, change.id));
          }
        }
      }
      await tx
        .update(backcharges)
        .set({
          status: agreed <= 0.005 ? "void" : row.commitmentChangeId ? "issued" : "settled",
          amount: agreed,
          detail: { ...(row.detail ?? {}), settlementNote: body.note ?? null, originalAmount: row.amount },
          updatedAt: now,
          ...(agreed <= 0.005 ? { voidReason: body.note ?? "Settled at zero" } : {}),
        })
        .where(eq(backcharges.id, backchargeId));
      await recomputeCommitmentTotals(tx, row.commitmentId);
    });
    await ledger(app.db, req, "state_change", "commitment", row.commitmentId, {
      backchargeId,
      settledAt: agreed,
      originalAmount: row.amount,
    }, row.projectId);
    return fetchBackcharge(backchargeId, req.companyId!);
  });

  app.post("/backcharges/:backchargeId/void", { preHandler: companyGate }, async (req, reply) => {
    const { backchargeId } = req.params as { backchargeId: string };
    const body = reasonSchema.parse(req.body);
    const row = await fetchBackcharge(backchargeId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, row.projectId, "standard");
    if (row.status === "settled") throw conflict("A settled backcharge is inside the commitment sum; reverse it with a change order");
    if (row.status === "void") throw conflict("Already void");
    const now = new Date().toISOString();
    await app.db.transaction(async (tx) => {
      if (row.commitmentChangeId) {
        await tx
          .update(commitmentChanges)
          .set({ status: "void", rejectionReason: `Backcharge voided: ${body.reason}`, updatedAt: now })
          .where(and(eq(commitmentChanges.id, row.commitmentChangeId), inArray(commitmentChanges.status, ["draft", "pending_in_house_review", "pending_owner_approval", "revise_and_resubmit", "pending_pricing"])));
      }
      await tx.update(backcharges).set({ status: "void", voidReason: body.reason, updatedAt: now }).where(eq(backcharges.id, backchargeId));
      await recomputeCommitmentTotals(tx, row.commitmentId);
    });
    await ledger(app.db, req, "state_change", "commitment", row.commitmentId, {
      backchargeId,
      status: "void",
      reason: body.reason,
    }, row.projectId);
    return fetchBackcharge(backchargeId, req.companyId!);
  });

  /** Vendors with open recoveries, for the register badge. */
  app.get("/projects/:projectId/backcharges/summary", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select({ vendorId: backcharges.vendorId, status: backcharges.status, amount: backcharges.amount, currency: backcharges.currency, commitmentId: backcharges.commitmentId })
      .from(backcharges)
      .where(and(eq(backcharges.companyId, req.companyId!), eq(backcharges.projectId, req.projectId!)));
    const open = rows.filter((r) => r.status === "issued" || r.status === "disputed");
    const byCurrency = new Map<string, number>();
    for (const r of open) byCurrency.set(r.currency, round2((byCurrency.get(r.currency) ?? 0) + r.amount));
    const commitmentIds = [...new Set(open.map((r) => r.commitmentId))];
    const refs = commitmentIds.length
      ? await app.db.select({ id: commitments.id, reference: commitments.reference }).from(commitments).where(inArray(commitments.id, commitmentIds))
      : [];
    return {
      openCount: open.length,
      openByCurrency: [...byCurrency].map(([currency, amount]) => ({ currency, amount })),
      commitmentsWithOpen: refs,
      total: rows.length,
    };
  });
};
