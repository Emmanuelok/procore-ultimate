import type { FastifyPluginAsync } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  backcharges,
  commitmentCloseouts,
  commitmentPayments,
  commitments,
  lienWaivers,
} from "@constructos/db";
import { CLOSEOUT_ITEM_KEYS, type CloseoutItemKey } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { AppError, badRequest, conflict } from "../../lib/errors.js";
import type { Db } from "../../lib/db.js";
import { settleAfterTransition } from "../invoicing/register.js";
import { assessCommitment } from "./compliance.js";
import { withIdempotency } from "./idempotency.js";
import { allocateRetainageRelease, assertCompliancePermits } from "./payments.js";
import { commitmentPosition } from "./rollups.js";
import {
  CENT,
  assertSegregation,
  fetchCommitment,
  isoDateSchema,
  ledger,
  paymentReference,
  requireCommitmentsLevel,
  round2,
  todayIso,
  type CommitmentRow,
} from "./shared.js";

/**
 * COMMITMENT CLOSEOUT AND FINAL RELEASE (spec #539).
 *
 * The final retainage cheque is the payment most often followed by a lien
 * claim, a warranty gap or a missing O&M manual, because it is the last
 * moment the contractor has any leverage. So it is gated on a checklist —
 * final unconditional waiver, consent of surety, warranties, as-builts, O&M,
 * punch complete, backcharges settled — each item satisfied by an EVIDENCE
 * ID, not a tick. `complete` and `final-release` both read the checklist;
 * an override is allowed but it is a reason on the record, never silence.
 *
 * Pure engine below (`evaluateCloseout`), routes underneath it.
 */

export interface CloseoutItem {
  key: CloseoutItemKey;
  label: string;
  required: boolean;
  done: boolean;
  evidenceType: string | null;
  evidenceId: string | null;
  note: string | null;
  completedBy: string | null;
  completedAt: string | null;
  /** items the platform can verify itself carry the verdict here */
  autoVerified: boolean;
}

export const CLOSEOUT_LABELS: Record<CloseoutItemKey, string> = {
  final_unconditional_waiver: "Final unconditional lien waiver received and verified",
  consent_of_surety: "Consent of surety to final payment",
  warranties: "Warranties and guarantees delivered",
  as_builts: "As-built drawings delivered",
  om_manuals: "O&M manuals and training delivered",
  punch_complete: "Punch list complete and accepted",
  backcharges_settled: "All backcharges settled",
};

/** Items that require external documents by default; POs need fewer. */
export function defaultCloseoutItems(kind: string): CloseoutItem[] {
  const required = new Set<CloseoutItemKey>(
    kind === "purchase_order"
      ? ["final_unconditional_waiver", "warranties", "backcharges_settled"]
      : [...CLOSEOUT_ITEM_KEYS],
  );
  return CLOSEOUT_ITEM_KEYS.map((key) => ({
    key,
    label: CLOSEOUT_LABELS[key],
    required: required.has(key),
    done: false,
    evidenceType: null,
    evidenceId: null,
    note: null,
    completedBy: null,
    completedAt: null,
    autoVerified: false,
  }));
}

export interface CloseoutEvaluation {
  passes: boolean;
  outstanding: CloseoutItem[];
  /** required items marked done without any evidence id — a tick, not a fact */
  unevidenced: CloseoutItem[];
  reasons: string[];
}

/** Pure: does the checklist pass? Required items must be done AND evidenced. */
export function evaluateCloseout(items: readonly CloseoutItem[]): CloseoutEvaluation {
  const outstanding = items.filter((i) => i.required && !i.done);
  const unevidenced = items.filter((i) => i.required && i.done && !i.evidenceId && !i.autoVerified);
  const reasons: string[] = [];
  if (outstanding.length > 0) {
    reasons.push(`Outstanding: ${outstanding.map((i) => i.label).join("; ")}.`);
  }
  if (unevidenced.length > 0) {
    reasons.push(
      `Marked done without evidence: ${unevidenced.map((i) => i.label).join("; ")}. A tick with ` +
        "no document behind it does not close a subcontract.",
    );
  }
  return { passes: outstanding.length === 0 && unevidenced.length === 0, outstanding, unevidenced, reasons };
}

/** Coerce a stored jsonb checklist back into typed items, defaulting anything missing. */
export function readCloseoutItems(stored: unknown, kind: string): CloseoutItem[] {
  const defaults = defaultCloseoutItems(kind);
  if (!Array.isArray(stored)) return defaults;
  const byKey = new Map<string, Record<string, unknown>>();
  for (const raw of stored) {
    if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>)["key"] === "string") {
      byKey.set((raw as Record<string, unknown>)["key"] as string, raw as Record<string, unknown>);
    }
  }
  return defaults.map((d) => {
    const r = byKey.get(d.key);
    if (!r) return d;
    return {
      ...d,
      required: typeof r["required"] === "boolean" ? r["required"] : d.required,
      done: r["done"] === true,
      evidenceType: typeof r["evidenceType"] === "string" ? r["evidenceType"] : null,
      evidenceId: typeof r["evidenceId"] === "string" ? r["evidenceId"] : null,
      note: typeof r["note"] === "string" ? r["note"] : null,
      completedBy: typeof r["completedBy"] === "string" ? r["completedBy"] : null,
      completedAt: typeof r["completedAt"] === "string" ? r["completedAt"] : null,
      autoVerified: r["autoVerified"] === true,
    };
  });
}

/**
 * Two items the platform can verify itself, from its own registers: a
 * verified final unconditional waiver on the commitment, and no open
 * backcharge. Verified facts overwrite hand ticks in both directions — a tick
 * on "backcharges settled" while one is open is corrected, not trusted.
 */
export async function autoVerifyItems(
  db: Db,
  commitment: CommitmentRow,
  items: CloseoutItem[],
): Promise<CloseoutItem[]> {
  const [waivers, openBackcharges] = await Promise.all([
    db
      .select({ id: lienWaivers.id, waiverType: lienWaivers.waiverType, status: lienWaivers.status })
      .from(lienWaivers)
      .where(
        and(
          eq(lienWaivers.companyId, commitment.companyId),
          eq(lienWaivers.commitmentId, commitment.id),
          eq(lienWaivers.waiverType, "unconditional_final"),
          eq(lienWaivers.status, "verified"),
        ),
      ),
    db
      .select({ id: backcharges.id })
      .from(backcharges)
      .where(
        and(
          eq(backcharges.commitmentId, commitment.id),
          inArray(backcharges.status, ["draft", "issued", "disputed"]),
        ),
      ),
  ]);
  return items.map((item) => {
    if (item.key === "final_unconditional_waiver") {
      const w = waivers[0];
      return w
        ? { ...item, done: true, autoVerified: true, evidenceType: "lien_waiver", evidenceId: w.id }
        : item.autoVerified
          ? { ...item, done: false, autoVerified: false, evidenceId: null, evidenceType: null }
          : item;
    }
    if (item.key === "backcharges_settled") {
      return openBackcharges.length === 0
        ? { ...item, done: true, autoVerified: true, evidenceType: "backcharge_register", evidenceId: commitment.id }
        : { ...item, done: false, autoVerified: false, note: `${openBackcharges.length} backcharge(s) still open` };
    }
    return item;
  });
}

export async function loadCloseout(db: Db, commitment: CommitmentRow) {
  const rows = await db
    .select()
    .from(commitmentCloseouts)
    .where(eq(commitmentCloseouts.commitmentId, commitment.id))
    .limit(1);
  const row = rows[0] ?? null;
  const items = await autoVerifyItems(db, commitment, readCloseoutItems(row?.items, commitment.kind));
  const evaluation = evaluateCloseout(items);
  return { row, items, evaluation };
}

/**
 * The gate `complete` runs: a passing checklist, or an explicit override with a
 * reason recorded on the closeout row. Returns the closeout status for the ledger.
 */
export async function assertCloseoutPermitsCompletion(
  db: Db,
  commitment: CommitmentRow,
  actorId: string,
  overrideReason: string | null,
): Promise<{ status: string }> {
  const { row, items, evaluation } = await loadCloseout(db, commitment);
  const now = new Date().toISOString();
  if (!evaluation.passes && !overrideReason) {
    throw new AppError(
      409,
      `The closeout checklist on ${commitment.reference} does not pass. ${evaluation.reasons.join(" ")} ` +
        "Complete the checklist, or send overrideReason to complete anyway on the record.",
      { control: "closeout_checklist", outstanding: evaluation.outstanding, unevidenced: evaluation.unevidenced },
    );
  }
  const status = evaluation.passes ? "closed" : "overridden";
  const values = {
    status,
    items: items as unknown[],
    ...(evaluation.passes
      ? {}
      : { overrideReason, overriddenBy: actorId, overriddenAt: now }),
    closedAt: now,
    closedBy: actorId,
    updatedAt: now,
  };
  if (row) {
    await db.update(commitmentCloseouts).set(values).where(eq(commitmentCloseouts.id, row.id));
  } else {
    await db.insert(commitmentCloseouts).values({
      id: newId("clo"),
      companyId: commitment.companyId,
      projectId: commitment.projectId,
      commitmentId: commitment.id,
      createdBy: actorId,
      ...values,
    });
  }
  return { status };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

const itemPatchSchema = z.object({
  done: z.boolean(),
  evidenceType: z.string().min(1).max(60).nullable().optional(),
  evidenceId: z.string().min(1).max(64).nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
  required: z.boolean().optional(),
});

const finalReleaseSchema = z.object({
  paymentDate: isoDateSchema.optional(),
  method: z.enum(["check", "ach", "wire", "credit_card", "cash", "joint_check", "other"]).optional(),
  transactionReference: z.string().max(200).nullable().optional(),
  overrideReason: z.string().min(1).max(4000).optional(),
});

export const closeoutRoutes: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];

  app.get("/commitments/:commitmentId/closeout", { preHandler: companyGate }, async (req, reply) => {
    const { commitmentId } = req.params as { commitmentId: string };
    const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
    await requireCommitmentsLevel(app, req, reply, commitment.projectId, "read");
    const { row, items, evaluation } = await loadCloseout(app.db, commitment);
    const position = await commitmentPosition(app.db, commitment.id);
    return {
      commitmentId,
      status: row?.status ?? "open",
      items,
      evaluation,
      overrideReason: row?.overrideReason ?? null,
      finalReleasePaymentId: row?.finalReleasePaymentId ?? null,
      remainingRetainage: position.retainageHeld,
      currency: commitment.currency,
    };
  });

  app.put(
    "/commitments/:commitmentId/closeout/items/:key",
    { preHandler: companyGate },
    async (req, reply) => {
      const { commitmentId, key } = req.params as { commitmentId: string; key: string };
      const body = itemPatchSchema.parse(req.body);
      const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
      if (!(CLOSEOUT_ITEM_KEYS as readonly string[]).includes(key)) {
        throw badRequest(`Unknown closeout item "${key}"`);
      }
      const { row, items } = await loadCloseout(app.db, commitment);
      const target = items.find((i) => i.key === key)!;
      if (target.autoVerified && target.done && body.done === false) {
        throw conflict(
          `"${target.label}" is verified by the platform from its own registers and cannot be ` +
            "un-ticked by hand.",
        );
      }
      if (body.done && !body.evidenceId && !target.autoVerified) {
        throw badRequest(
          `Marking "${target.label}" done needs an evidenceId — the document, waiver or record ` +
            "that satisfies it. A tick with nothing behind it does not close a subcontract.",
        );
      }
      const now = new Date().toISOString();
      const next = items.map((i) =>
        i.key !== key
          ? i
          : {
              ...i,
              done: body.done,
              required: body.required ?? i.required,
              evidenceType: body.evidenceType === undefined ? i.evidenceType : body.evidenceType,
              evidenceId: body.evidenceId === undefined ? i.evidenceId : body.evidenceId,
              note: body.note === undefined ? i.note : body.note,
              completedBy: body.done ? req.user!.id : null,
              completedAt: body.done ? now : null,
            },
      );
      const evaluation = evaluateCloseout(next);
      const status = row?.status === "closed" || row?.status === "overridden" ? row.status : evaluation.passes ? "passed" : "open";
      if (row) {
        await app.db
          .update(commitmentCloseouts)
          .set({ items: next as unknown[], status, updatedAt: now })
          .where(eq(commitmentCloseouts.id, row.id));
      } else {
        await app.db.insert(commitmentCloseouts).values({
          id: newId("clo"),
          companyId: commitment.companyId,
          projectId: commitment.projectId,
          commitmentId: commitment.id,
          status,
          items: next as unknown[],
          createdBy: req.user!.id,
        });
      }
      await ledger(app.db, req, "update", "commitment", commitmentId, {
        closeoutItem: key,
        done: body.done,
        evidenceId: body.evidenceId ?? null,
        checklistPasses: evaluation.passes,
      }, commitment.projectId);
      return { commitmentId, status, items: next, evaluation };
    },
  );

  /**
   * FINAL RELEASE — a payment of exactly the remaining retainage, refused
   * unless the checklist passes (or an override is recorded), and refused
   * outright while any backcharge is open. It is scheduled, not issued: the
   * two-person approve/issue path still applies, because final retainage is
   * the one payment nobody should be able to move alone.
   */
  app.post(
    "/commitments/:commitmentId/final-release",
    { preHandler: companyGate },
    async (req, reply) => {
      const { commitmentId } = req.params as { commitmentId: string };
      const body = finalReleaseSchema.parse(req.body ?? {});
      const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, commitment.projectId, "standard");
      return withIdempotency(app.db, req, reply, "commitment.final-release", async () => {
        if (commitment.status !== "approved" && commitment.status !== "complete") {
          throw conflict(`A ${commitment.status} commitment cannot take a final release`);
        }
        const { row, items, evaluation } = await loadCloseout(app.db, commitment);
        if (row?.finalReleasePaymentId) {
          const existing = await app.db
            .select({ status: commitmentPayments.status })
            .from(commitmentPayments)
            .where(eq(commitmentPayments.id, row.finalReleasePaymentId))
            .limit(1);
          if (existing[0] && existing[0].status !== "voided" && existing[0].status !== "failed") {
            throw conflict("A final release payment already exists on this commitment");
          }
        }
        const openBc = items.find((i) => i.key === "backcharges_settled");
        if (openBc && !openBc.done) {
          throw new AppError(409, "Final release is refused while a backcharge is open against this vendor.", {
            control: "closeout_checklist",
            outstanding: [openBc],
          });
        }
        if (!evaluation.passes && !body.overrideReason) {
          throw new AppError(
            409,
            `The closeout checklist does not pass. ${evaluation.reasons.join(" ")} Send overrideReason ` +
              "to release anyway — the override is recorded against the payment and the closeout.",
            { control: "closeout_checklist", outstanding: evaluation.outstanding, unevidenced: evaluation.unevidenced },
          );
        }
        const position = await commitmentPosition(app.db, commitment.id);
        const remaining = round2(position.retainageHeld);
        if (remaining <= CENT) {
          throw badRequest("No retainage remains held on this commitment; there is nothing to release.");
        }
        const compliance = await assessCommitment(app.db, commitment);
        assertCompliancePermits(commitment, compliance, "Scheduling the final release");

        const number = await nextRecordNumber(app.db, commitment.projectId, `commitment_payment:${commitmentId}`);
        const id = newId("cpy");
        const now = new Date().toISOString();
        await app.db.transaction(async (tx) => {
          await tx.insert(commitmentPayments).values({
            id,
            companyId: commitment.companyId,
            projectId: commitment.projectId,
            commitmentId,
            invoiceId: null,
            vendorId: commitment.vendorId,
            number,
            reference: paymentReference(commitment.reference, number),
            method: body.method ?? "check",
            status: "scheduled",
            amount: remaining,
            retainageReleasedAmount: remaining,
            discountTaken: 0,
            currency: commitment.currency,
            paymentDate: body.paymentDate ?? null,
            transactionReference: body.transactionReference ?? null,
            detail: {
              kind: "final_release",
              closeoutPassed: evaluation.passes,
              closeoutOverrideReason: body.overrideReason ?? null,
              complianceAtScheduling: { status: compliance.status, warnings: compliance.warnings.map((f) => f.code) },
            },
            createdBy: req.user!.id,
          });
          const values = {
            status: evaluation.passes ? "passed" : "overridden",
            items: items as unknown[],
            finalReleasePaymentId: id,
            ...(evaluation.passes ? {} : { overrideReason: body.overrideReason ?? null, overriddenBy: req.user!.id, overriddenAt: now }),
            updatedAt: now,
          };
          if (row) await tx.update(commitmentCloseouts).set(values).where(eq(commitmentCloseouts.id, row.id));
          else
            await tx.insert(commitmentCloseouts).values({
              id: newId("clo"),
              companyId: commitment.companyId,
              projectId: commitment.projectId,
              commitmentId,
              createdBy: req.user!.id,
              ...values,
            });
        });
        await ledger(app.db, req, "create", "commitment_payment", id, {
          kind: "final_release",
          commitmentId,
          amount: remaining,
          closeoutPassed: evaluation.passes,
          overrideReason: body.overrideReason ?? null,
        }, commitment.projectId);
        const payment = (await app.db.select().from(commitmentPayments).where(eq(commitmentPayments.id, id)).limit(1))[0];
        return reply.status(201).send({ payment, evaluation, remainingRetainage: remaining });
      });
    },
  );

  /** Void the scheduled final release so the checklist can be reworked (admin). */
  app.post(
    "/commitments/:commitmentId/final-release/void",
    { preHandler: companyGate },
    async (req, reply) => {
      const { commitmentId } = req.params as { commitmentId: string };
      const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body);
      const commitment = await fetchCommitment(app.db, commitmentId, req.companyId!);
      await requireCommitmentsLevel(app, req, reply, commitment.projectId, "admin");
      const { row } = await loadCloseout(app.db, commitment);
      if (!row?.finalReleasePaymentId) throw conflict("No final release is scheduled on this commitment");
      const payment = (
        await app.db.select().from(commitmentPayments).where(eq(commitmentPayments.id, row.finalReleasePaymentId)).limit(1)
      )[0];
      if (!payment || payment.status !== "scheduled") {
        throw conflict("Only a scheduled final release can be voided here; use the payment register for issued ones.");
      }
      assertSegregation(req.user!.id, {}, "final release");
      const now = new Date().toISOString();
      await app.db.transaction(async (tx) => {
        await tx
          .update(commitmentPayments)
          .set({ status: "voided", holdReason: body.reason, updatedAt: now })
          .where(eq(commitmentPayments.id, payment.id));
        await settleAfterTransition(tx, payment.id);
        await tx
          .update(commitmentCloseouts)
          .set({ finalReleasePaymentId: null, status: "open", updatedAt: now })
          .where(eq(commitmentCloseouts.id, row.id));
      });
      await ledger(app.db, req, "state_change", "commitment_payment", payment.id, {
        status: "voided",
        kind: "final_release",
        reason: body.reason,
      }, commitment.projectId);
      return { voided: payment.id };
    },
  );
};

/** Issued final releases zero the held retainage by construction — checked here for tests. */
export async function finalReleaseState(db: Db, commitmentId: string) {
  const c = (await db.select().from(commitments).where(eq(commitments.id, commitmentId)).limit(1))[0];
  const clo = (await db.select().from(commitmentCloseouts).where(eq(commitmentCloseouts.commitmentId, commitmentId)).limit(1))[0];
  return { retainageHeld: c?.retainageHeld ?? null, closeoutStatus: clo?.status ?? "open", allocate: allocateRetainageRelease, today: todayIso() };
}
