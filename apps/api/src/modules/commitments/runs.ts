import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { commitmentPayments, commitments, paymentRuns, vendors } from "@constructos/db";
import { PAYMENT_RUN_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { requestWaiverForPayment } from "../invoicing/waivers.js";
import { assessCommitment } from "./compliance.js";
import { withIdempotency } from "./idempotency.js";
import { assertCompliancePermits, performIssue, renderRemittanceHtml } from "./payments.js";
import {
  CENT,
  assertSegregation,
  isoDateSchema,
  ledger,
  round2,
  todayIso,
  type CommitmentRow,
} from "./shared.js";

/**
 * PAYMENT RUNS — scheduling and remittance (spec #586–594).
 *
 * A payment run is the batch the bank receives: approved, scheduled payments
 * in ONE currency, issued together on a date, each leaving with a remittance
 * advice. The run adds no new money semantics of its own — every payment in
 * it is issued through exactly the same core as a single payment
 * (`performIssue`), so the compliance gate, the retainage allocation, the
 * invoice settlement and the budget posting are the same code path whether
 * a cheque is cut alone or with forty others.
 *
 *   draft      payments gathered; membership editable
 *   approved   somebody other than the author signed the batch off
 *   issued     every member issued (one failing member stops the run and
 *              reports which, with the ones already issued named)
 *   cancelled  membership released; payments stay scheduled
 */

const createSchema = z.object({
  name: z.string().min(1).max(200),
  scheduledDate: isoDateSchema,
  currency: z.string().min(3).max(8).transform((s) => s.toUpperCase()),
  paymentIds: z.array(z.string().min(1).max(64)).max(500).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const membersSchema = z.object({
  add: z.array(z.string().min(1).max(64)).max(500).optional(),
  remove: z.array(z.string().min(1).max(64)).max(500).optional(),
});

const issueSchema = z.object({
  paymentDate: isoDateSchema.optional(),
  acknowledgeWarnings: z.boolean().optional(),
});

const listQuery = pageQuerySchema.extend({ status: z.enum(PAYMENT_RUN_STATUSES).optional() });

export const paymentRunRoutes: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];
  const readGate = [...companyGate, app.requireTool("commitments", "read")];
  const standardGate = [...companyGate, app.requireTool("commitments", "standard")];

  async function fetchRun(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(paymentRuns)
      .where(and(eq(paymentRuns.id, id), eq(paymentRuns.companyId, companyId), eq(paymentRuns.projectId, projectId)))
      .limit(1);
    if (!rows[0]) throw notFound("Payment run not found");
    return rows[0];
  }

  /** Every candidate must be a scheduled, approved payment on this project in the run's currency. */
  async function loadMembers(ids: readonly string[], companyId: string, projectId: string, currency: string) {
    if (ids.length === 0) return [];
    const rows = await app.db
      .select()
      .from(commitmentPayments)
      .where(
        and(
          inArray(commitmentPayments.id, [...ids]),
          eq(commitmentPayments.companyId, companyId),
          eq(commitmentPayments.projectId, projectId),
        ),
      );
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) throw badRequest(`Payments not on this project: ${missing.join(", ")}`);
    const wrongCurrency = rows.filter((r) => r.currency.toUpperCase() !== currency);
    if (wrongCurrency.length > 0) {
      throw badRequest(
        `A run is one currency (${currency}); ${wrongCurrency.map((r) => `${r.reference} (${r.currency})`).join(", ")} ` +
          "would be summed across currencies, which this platform never does.",
      );
    }
    const notReady = rows.filter((r) => r.status !== "scheduled");
    if (notReady.length > 0) {
      throw conflict(
        `Only scheduled payments join a run: ${notReady.map((r) => `${r.reference} (${r.status})`).join(", ")}.`,
      );
    }
    return rows;
  }

  async function recomputeRun(runId: string): Promise<void> {
    const run = (await app.db.select().from(paymentRuns).where(eq(paymentRuns.id, runId)).limit(1))[0];
    if (!run) return;
    const rows = run.paymentIds.length
      ? await app.db
          .select({ amount: commitmentPayments.amount })
          .from(commitmentPayments)
          .where(inArray(commitmentPayments.id, run.paymentIds))
      : [];
    await app.db
      .update(paymentRuns)
      .set({
        totalAmount: round2(rows.reduce((s, r) => s + r.amount, 0)),
        paymentCount: rows.length,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(paymentRuns.id, runId));
  }

  app.post("/projects/:projectId/payment-runs", { preHandler: standardGate }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    const members = await loadMembers(body.paymentIds ?? [], req.companyId!, req.projectId!, body.currency);
    const number = await nextRecordNumber(app.db, req.projectId!, "payment_run");
    const id = newId("prn");
    await app.db.insert(paymentRuns).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      number,
      reference: `RUN-${String(number).padStart(3, "0")}`,
      name: body.name,
      status: "draft",
      currency: body.currency,
      scheduledDate: body.scheduledDate,
      paymentIds: members.map((m) => m.id),
      totalAmount: round2(members.reduce((s, m) => s + m.amount, 0)),
      paymentCount: members.length,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    await ledger(app.db, req, "create", "commitment_payment", id, {
      paymentRun: true,
      reference: `RUN-${String(number).padStart(3, "0")}`,
      paymentIds: members.map((m) => m.id),
      currency: body.currency,
    }, req.projectId!);
    return reply.status(201).send(await fetchRun(id, req.companyId!, req.projectId!));
  });

  app.get("/projects/:projectId/payment-runs", { preHandler: readGate }, async (req) => {
    const q = listQuery.parse(req.query);
    const clauses = [eq(paymentRuns.companyId, req.companyId!), eq(paymentRuns.projectId, req.projectId!)];
    if (q.status) clauses.push(eq(paymentRuns.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(paymentRuns).where(where);
    const items = await app.db
      .select()
      .from(paymentRuns)
      .where(where)
      .orderBy(desc(paymentRuns.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /** Scheduled, approved payments not yet in a live run — what a run is built from. */
  app.get("/projects/:projectId/payment-runs/candidates", { preHandler: readGate }, async (req) => {
    const q = z.object({ currency: z.string().optional() }).parse(req.query ?? {});
    const liveRuns = await app.db
      .select({ paymentIds: paymentRuns.paymentIds })
      .from(paymentRuns)
      .where(
        and(
          eq(paymentRuns.projectId, req.projectId!),
          inArray(paymentRuns.status, ["draft", "approved"]),
        ),
      );
    const taken = new Set(liveRuns.flatMap((r) => r.paymentIds));
    const rows = await app.db
      .select({
        id: commitmentPayments.id,
        reference: commitmentPayments.reference,
        commitmentId: commitmentPayments.commitmentId,
        vendorId: commitmentPayments.vendorId,
        amount: commitmentPayments.amount,
        currency: commitmentPayments.currency,
        approvedBy: commitmentPayments.approvedBy,
        paymentDate: commitmentPayments.paymentDate,
        method: commitmentPayments.method,
      })
      .from(commitmentPayments)
      .where(
        and(
          eq(commitmentPayments.companyId, req.companyId!),
          eq(commitmentPayments.projectId, req.projectId!),
          eq(commitmentPayments.status, "scheduled"),
        ),
      )
      .orderBy(asc(commitmentPayments.paymentDate), asc(commitmentPayments.number));
    const items = rows
      .filter((r) => !taken.has(r.id))
      .filter((r) => (q.currency ? r.currency.toUpperCase() === q.currency.toUpperCase() : true))
      .map((r) => ({ ...r, approved: r.approvedBy !== null }));
    const byCurrency = new Map<string, { currency: string; count: number; amount: number; unapproved: number }>();
    for (const it of items) {
      const b = byCurrency.get(it.currency) ?? { currency: it.currency, count: 0, amount: 0, unapproved: 0 };
      b.count += 1;
      b.amount = round2(b.amount + it.amount);
      if (!it.approved) b.unapproved += 1;
      byCurrency.set(it.currency, b);
    }
    return { items, byCurrency: [...byCurrency.values()] };
  });

  app.get("/projects/:projectId/payment-runs/:runId", { preHandler: readGate }, async (req) => {
    const { runId } = req.params as { runId: string };
    const run = await fetchRun(runId, req.companyId!, req.projectId!);
    const payments = run.paymentIds.length
      ? await app.db
          .select()
          .from(commitmentPayments)
          .where(inArray(commitmentPayments.id, run.paymentIds))
          .orderBy(asc(commitmentPayments.number))
      : [];
    const commitmentIds = [...new Set(payments.map((p) => p.commitmentId))];
    const commitmentRows = commitmentIds.length
      ? await app.db
          .select({ id: commitments.id, reference: commitments.reference, title: commitments.title, vendorId: commitments.vendorId })
          .from(commitments)
          .where(inArray(commitments.id, commitmentIds))
      : [];
    const vendorIds = [...new Set(commitmentRows.map((c) => c.vendorId).filter((v): v is string => !!v))];
    const vendorRows = vendorIds.length
      ? await app.db.select({ id: vendors.id, name: vendors.name, email: vendors.email }).from(vendors).where(inArray(vendors.id, vendorIds))
      : [];
    const byCommitment = new Map(commitmentRows.map((c) => [c.id, c]));
    const byVendor = new Map(vendorRows.map((v) => [v.id, v]));
    return {
      ...run,
      payments: payments.map((p) => {
        const c = byCommitment.get(p.commitmentId);
        const v = c?.vendorId ? byVendor.get(c.vendorId) : undefined;
        return {
          ...p,
          commitmentReference: c?.reference ?? null,
          commitmentTitle: c?.title ?? null,
          vendorName: v?.name ?? null,
          vendorEmail: v?.email ?? null,
        };
      }),
    };
  });

  app.post("/projects/:projectId/payment-runs/:runId/members", { preHandler: standardGate }, async (req) => {
    const { runId } = req.params as { runId: string };
    const body = membersSchema.parse(req.body ?? {});
    const run = await fetchRun(runId, req.companyId!, req.projectId!);
    if (run.status !== "draft") throw conflict(`A ${run.status} run's membership is fixed; the approval covered it.`);
    const next = new Set(run.paymentIds);
    for (const id of body.remove ?? []) next.delete(id);
    const adds = (body.add ?? []).filter((id) => !next.has(id));
    await loadMembers(adds, req.companyId!, req.projectId!, run.currency);
    for (const id of adds) next.add(id);
    await app.db
      .update(paymentRuns)
      .set({ paymentIds: [...next], updatedAt: new Date().toISOString() })
      .where(eq(paymentRuns.id, runId));
    await recomputeRun(runId);
    await ledger(app.db, req, "update", "commitment_payment", runId, {
      paymentRun: true,
      added: adds,
      removed: body.remove ?? [],
    }, req.projectId!);
    return fetchRun(runId, req.companyId!, req.projectId!);
  });

  /**
   * Approving the run approves every member that is not yet approved, by the
   * same segregation rule a single payment has: the run's author and each
   * payment's author may not be the approver.
   */
  app.post("/projects/:projectId/payment-runs/:runId/approve", { preHandler: standardGate }, async (req) => {
    const { runId } = req.params as { runId: string };
    const run = await fetchRun(runId, req.companyId!, req.projectId!);
    if (run.status !== "draft") throw conflict(`A ${run.status} run cannot be approved`);
    if (run.paymentIds.length === 0) throw badRequest("An empty run approves nothing");
    assertSegregation(req.user!.id, { createdBy: run.createdBy }, "payment run");
    const members = await loadMembers(run.paymentIds, req.companyId!, req.projectId!, run.currency);
    const selfAuthored = members.filter((m) => m.createdBy === req.user!.id && !m.approvedBy);
    if (selfAuthored.length > 0) {
      throw new AppError(
        403,
        `Segregation of duties: you scheduled ${selfAuthored.map((m) => m.reference).join(", ")} and may not approve them inside a run either.`,
        { control: "no_self_approval", role: "created_by" },
      );
    }
    const now = new Date().toISOString();
    const blocked: Array<{ reference: string; message: string }> = [];
    const commitmentCache = new Map<string, CommitmentRow>();
    for (const m of members) {
      let c = commitmentCache.get(m.commitmentId);
      if (!c) {
        c = (await app.db.select().from(commitments).where(eq(commitments.id, m.commitmentId)).limit(1))[0];
        if (!c) continue;
        commitmentCache.set(m.commitmentId, c);
      }
      const compliance = await assessCommitment(app.db, c);
      if (compliance.blocking.length > 0) {
        blocked.push({ reference: m.reference, message: compliance.blocking.map((f) => f.message).join(" ") });
      }
    }
    if (blocked.length > 0) {
      throw new AppError(409, `The run cannot be approved: ${blocked.map((b) => `${b.reference}: ${b.message}`).join(" ")}`, {
        control: "compliance_gate",
        blocked,
        remedy: "Remove the blocked payments from the run or restore the vendor's cover first.",
      });
    }
    await app.db.transaction(async (tx) => {
      const unapproved = members.filter((m) => !m.approvedBy).map((m) => m.id);
      if (unapproved.length > 0) {
        await tx
          .update(commitmentPayments)
          .set({ approvedBy: req.user!.id, approvedAt: now, updatedAt: now })
          .where(and(inArray(commitmentPayments.id, unapproved), eq(commitmentPayments.status, "scheduled")));
      }
      await tx
        .update(paymentRuns)
        .set({ status: "approved", approvedBy: req.user!.id, approvedAt: now, updatedAt: now })
        .where(eq(paymentRuns.id, runId));
    });
    await ledger(app.db, req, "state_change", "commitment_payment", runId, {
      paymentRun: true,
      status: "approved",
      approvedBy: req.user!.id,
      paymentIds: run.paymentIds,
      totalAmount: run.totalAmount,
      currency: run.currency,
    }, req.projectId!);
    return fetchRun(runId, req.companyId!, req.projectId!);
  });

  /**
   * ISSUE the run: every member goes through `performIssue`. The issuer may
   * not be the run's approver, and may not be any member's approver. The run
   * stops at the first refusal and reports exactly which payments went out.
   */
  app.post("/projects/:projectId/payment-runs/:runId/issue", { preHandler: standardGate }, async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const body = issueSchema.parse(req.body ?? {});
    const run = await fetchRun(runId, req.companyId!, req.projectId!);
    return withIdempotency(app.db, req, reply, "payment-run.issue", async () => {
      if (run.status !== "approved") throw conflict(`A ${run.status} run cannot be issued; approve it first.`);
      if (run.approvedBy === req.user!.id) {
        throw new AppError(403, "Segregation of duties: the person who approved this run may not issue it.", {
          control: "no_self_issue",
          role: "approved_by",
        });
      }
      const members = await app.db
        .select()
        .from(commitmentPayments)
        .where(inArray(commitmentPayments.id, run.paymentIds))
        .orderBy(asc(commitmentPayments.number));
      const issued: string[] = [];
      const skipped: Array<{ reference: string; status: string }> = [];
      const waivers: string[] = [];
      let failure: { reference: string; message: string; details: unknown } | null = null;
      for (const m of members) {
        if (m.status !== "scheduled" || !m.approvedBy) {
          skipped.push({ reference: m.reference, status: m.approvedBy ? m.status : `${m.status} (unapproved)` });
          continue;
        }
        if (m.approvedBy === req.user!.id) {
          failure = {
            reference: m.reference,
            message: `Segregation of duties: you approved ${m.reference} and may not issue it.`,
            details: { control: "no_self_issue", role: "approved_by" },
          };
          break;
        }
        const commitment = (await app.db.select().from(commitments).where(eq(commitments.id, m.commitmentId)).limit(1))[0];
        if (!commitment) continue;
        try {
          const compliance = await assessCommitment(app.db, commitment);
          assertCompliancePermits(commitment, compliance, `Issuing ${m.reference}`);
          if (compliance.warnings.length > 0 && body.acknowledgeWarnings !== true) {
            throw new AppError(
              409,
              `Issuing ${m.reference} needs the compliance warnings acknowledged first: ${compliance.warnings.map((f) => f.message).join(" ")}`,
              { control: "acknowledge_warnings", warnings: compliance.warnings },
            );
          }
          await performIssue(app.db, m, commitment, compliance, {
            actorId: req.user!.id,
            paymentDate: body.paymentDate ?? run.scheduledDate,
            acknowledgeWarnings: body.acknowledgeWarnings === true,
            paymentRunId: run.id,
          });
          issued.push(m.id);
          const w = await requestWaiverForPayment(app.db, m.id, req.user!.id);
          if (w) waivers.push(w.id);
          await ledger(app.db, req, "state_change", "commitment_payment", m.id, {
            status: "issued",
            issuedBy: req.user!.id,
            approvedBy: m.approvedBy,
            amount: m.amount,
            paymentRunId: run.id,
            waiverRequested: w?.id ?? null,
          }, req.projectId!);
        } catch (err) {
          failure = {
            reference: m.reference,
            message: err instanceof Error ? err.message : String(err),
            details: err instanceof AppError ? err.details : null,
          };
          break;
        }
      }
      const now = new Date().toISOString();
      const complete = failure === null;
      await app.db
        .update(paymentRuns)
        .set({
          ...(complete ? { status: "issued", issuedBy: req.user!.id, issuedAt: now, remittanceSentAt: now } : {}),
          detail: {
            ...(run.detail ?? {}),
            lastIssueAttemptAt: now,
            issuedPaymentIds: issued,
            skipped,
            ...(failure ? { failure } : {}),
          },
          updatedAt: now,
        })
        .where(eq(paymentRuns.id, runId));
      await ledger(app.db, req, "state_change", "commitment_payment", runId, {
        paymentRun: true,
        status: complete ? "issued" : "partially_issued",
        issued,
        skipped,
        failure,
      }, req.projectId!);
      if (failure) {
        throw new AppError(
          409,
          `The run stopped at ${failure.reference}: ${failure.message} ${issued.length} payment(s) before it were issued and stay issued.`,
          { control: "payment_run_partial", issued, skipped, failure },
        );
      }
      return { ...(await fetchRun(runId, req.companyId!, req.projectId!)), issued, skipped, waiversRequested: waivers };
    });
  });

  app.post("/projects/:projectId/payment-runs/:runId/cancel", { preHandler: standardGate }, async (req) => {
    const { runId } = req.params as { runId: string };
    const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body);
    const run = await fetchRun(runId, req.companyId!, req.projectId!);
    if (run.status === "issued") throw conflict("An issued run has moved money; void the individual payments instead.");
    if (run.status === "cancelled") throw conflict("Already cancelled");
    await app.db
      .update(paymentRuns)
      .set({ status: "cancelled", cancelReason: body.reason, updatedAt: new Date().toISOString() })
      .where(eq(paymentRuns.id, runId));
    await ledger(app.db, req, "state_change", "commitment_payment", runId, {
      paymentRun: true,
      status: "cancelled",
      reason: body.reason,
    }, req.projectId!);
    return fetchRun(runId, req.companyId!, req.projectId!);
  });

  /** Remittance advices for every issued member — what each vendor receives (#592). */
  app.get("/projects/:projectId/payment-runs/:runId/remittances", { preHandler: readGate }, async (req) => {
    const { runId } = req.params as { runId: string };
    const run = await fetchRun(runId, req.companyId!, req.projectId!);
    const payments = run.paymentIds.length
      ? await app.db.select().from(commitmentPayments).where(inArray(commitmentPayments.id, run.paymentIds))
      : [];
    const commitmentIds = [...new Set(payments.map((p) => p.commitmentId))];
    const commitmentRows = commitmentIds.length
      ? await app.db.select().from(commitments).where(inArray(commitments.id, commitmentIds))
      : [];
    const byCommitment = new Map(commitmentRows.map((c) => [c.id, c]));
    const items = payments.map((p) => {
      const c = byCommitment.get(p.commitmentId);
      const advice = {
        paymentId: p.id,
        reference: p.reference,
        status: p.status,
        commitment: { id: p.commitmentId, reference: c?.reference ?? "—", title: c?.title ?? "—" },
        vendorId: p.vendorId,
        invoice: null,
        currency: p.currency,
        gross: round2(p.amount + p.discountTaken),
        discountTaken: p.discountTaken,
        retainageReleased: p.retainageReleasedAmount,
        net: p.amount,
        method: p.method,
        paymentDate: p.paymentDate,
        checkNumber: p.checkNumber,
        transactionReference: p.transactionReference,
        jointPayees: p.jointPayees,
        issuedAt: p.issuedAt,
        note: p.status === "issued" || p.status === "cleared" ? null : "Not issued — preview only.",
      };
      return { advice, html: renderRemittanceHtml(advice) };
    });
    const total = round2(items.reduce((s, i) => s + i.advice.net, 0));
    return { runId, reference: run.reference, currency: run.currency, total, count: items.length, items, allIssued: items.every((i) => i.advice.status === "issued" || i.advice.status === "cleared") && items.length > 0, cent: CENT, today: todayIso() };
  });
};
