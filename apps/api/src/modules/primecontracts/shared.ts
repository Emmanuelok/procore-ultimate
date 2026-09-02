/**
 * Helpers shared by the prime-contract route files (index.ts and
 * lifecycle.ts): tenant-scoped fetchers, the tool gate for sub-resource
 * routes, the contract re-derivation every write ends with, and the one
 * place an application's settlement is derived from its receipts.
 *
 * One definition of `recalcContract` matters: the billed position it stores
 * is the CERTIFIED position (Σ previousBilled + previousStoredMaterials on
 * the schedule of values), and the identity `Σ SOV billed to date =
 * totalBilled` in contractView compares the same thing — so a draft
 * application being edited never makes the contract look unreconciled.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, eq, ne } from "drizzle-orm";
import {
  invoices,
  ownerPaymentReceipts,
  paymentApplications,
  primeContractChanges,
  primeContractSovLines,
  primeContracts,
} from "@constructos/db";
import type { PermissionLevel } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { AppError, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { settlementOf } from "./analytics.js";
import { changeSums, round2 } from "./sov.js";

export type ContractRow = typeof primeContracts.$inferSelect;
export type SovRow = typeof primeContractSovLines.$inferSelect;
export type ChangeRow = typeof primeContractChanges.$inferSelect;
export type AppRow = typeof paymentApplications.$inferSelect;
export type InvoiceRow = typeof invoices.$inferSelect;
export type ReceiptRow = typeof ownerPaymentReceipts.$inferSelect;

export const nowIso = (): string => new Date().toISOString();
export const today = (): string => new Date().toISOString().slice(0, 10);

/** Statuses in which a payment application has left the contractor's hands. */
export const CERTIFIED_APP_STATUSES = ["certified", "partially_certified", "paid"] as const;
/** Statuses in which an application is still ours to edit, withdraw or void. */
export const OPEN_APP_STATUSES = ["draft", "submitted", "rejected"] as const;

/**
 * Tool gate for the sub-resource routes that carry no `:projectId` param.
 * The owning project is resolved from the record, injected into params and
 * put through the gate — so `/prime-contracts/:id/...` enforces exactly the
 * levels `/projects/:projectId/prime-contracts` does.
 */
export async function requireContractsLevel(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
  level: PermissionLevel,
): Promise<void> {
  (req.params as Record<string, string | undefined>)["projectId"] = projectId;
  await app.requireTool("contracts", level)(req, reply);
}

export async function fetchContract(db: Db, id: string, companyId: string): Promise<ContractRow> {
  const rows = await db
    .select()
    .from(primeContracts)
    .where(and(eq(primeContracts.id, id), eq(primeContracts.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw notFound("Prime contract not found");
  return rows[0];
}

export async function loadSov(db: Db, primeContractId: string): Promise<SovRow[]> {
  return db
    .select()
    .from(primeContractSovLines)
    .where(eq(primeContractSovLines.primeContractId, primeContractId))
    .orderBy(asc(primeContractSovLines.sortOrder), asc(primeContractSovLines.lineNumber));
}

export async function loadChanges(db: Db, primeContractId: string): Promise<ChangeRow[]> {
  return db
    .select()
    .from(primeContractChanges)
    .where(eq(primeContractChanges.primeContractId, primeContractId))
    .orderBy(asc(primeContractChanges.number));
}

/** A billing = the owner invoice (G703) plus the payment application (G702). */
export interface Billing {
  application: AppRow;
  invoice: InvoiceRow;
}

export async function fetchBilling(db: Db, contract: ContractRow, billingId: string): Promise<Billing> {
  const rows = await db
    .select()
    .from(paymentApplications)
    .where(
      and(
        eq(paymentApplications.id, billingId),
        eq(paymentApplications.primeContractId, contract.id),
      ),
    )
    .limit(1);
  const application = rows[0];
  if (!application) throw notFound("Payment application not found");
  if (!application.invoiceId) {
    throw new AppError(500, "Payment application has no owner invoice attached");
  }
  const inv = await db.select().from(invoices).where(eq(invoices.id, application.invoiceId)).limit(1);
  if (!inv[0]) throw new AppError(500, "Owner invoice for this application is missing");
  return { application, invoice: inv[0] };
}

/** The certified (rolled-forward) billed position of one SOV line. */
export const certifiedBilledOf = (l: Pick<SovRow, "previousBilled" | "previousStoredMaterials">): number =>
  round2(l.previousBilled + l.previousStoredMaterials);

/**
 * Re-derive every rollup column on the contract from the rows underneath
 * it. Nothing here is incremented in place: a total that is only ever
 * added to drifts, and a drifted contract sum is a dispute.
 *
 * `totalBilled` is the CERTIFIED position; work on a draft application is
 * mirrored onto the SOV for the G703 but does not count as billed until a
 * certifier has signed it, and the identity in contractView compares the
 * same certified figure.
 */
export async function recalcContract(db: Db, contractId: string, companyId: string): Promise<ContractRow> {
  const contract = await fetchContract(db, contractId, companyId);
  const [lines, changes] = await Promise.all([loadSov(db, contractId), loadChanges(db, contractId)]);
  const sums = changeSums(contract.originalContractSum, changes);
  let totalBilled = 0;
  let retainageHeld = 0;
  let retainageReleased = 0;
  for (const l of lines) {
    totalBilled += certifiedBilledOf(l);
    retainageHeld += l.retainageHeld;
    retainageReleased += l.retainageReleased;
  }
  const apps = await db
    .select({ paidAmount: paymentApplications.paidAmount })
    .from(paymentApplications)
    .where(
      and(
        eq(paymentApplications.primeContractId, contractId),
        ne(paymentApplications.status, "void"),
      ),
    );
  const totalPaid = round2(apps.reduce((s, a) => s + a.paidAmount, 0));
  const patch = {
    approvedChangeSum: sums.approvedChangeSum,
    pendingChangeSum: sums.pendingChangeSum,
    draftChangeSum: sums.draftChangeSum,
    revisedContractSum: sums.revisedContractSum,
    totalBilled: round2(totalBilled),
    totalPaid,
    retainageHeld: round2(retainageHeld),
    retainageReleased: round2(retainageReleased),
    balanceToFinish: round2(sums.revisedContractSum - totalBilled),
    totalsCalculatedAt: nowIso(),
    updatedAt: nowIso(),
  };
  await db.update(primeContracts).set(patch).where(eq(primeContracts.id, contractId));
  return { ...contract, ...patch };
}

/**
 * Derive an application's settlement from its non-void receipts and store
 * it: `paidAmount` is Σ receipts, and the status is `paid` only once the
 * certified amount is covered. Partial payments leave the application
 * certified with the outstanding balance visible, never silently "paid".
 */
export async function settleApplication(db: Db, applicationId: string): Promise<{ application: AppRow; paid: number; outstanding: number; state: string }> {
  const rows = await db.select().from(paymentApplications).where(eq(paymentApplications.id, applicationId)).limit(1);
  const a = rows[0];
  if (!a) throw notFound("Payment application not found");
  const receipts = await db
    .select()
    .from(ownerPaymentReceipts)
    .where(eq(ownerPaymentReceipts.paymentApplicationId, applicationId));
  const settlement = settlementOf(
    { id: a.id, reference: a.reference, status: a.status, currency: a.currency, currentPaymentDue: a.currentPaymentDue, certifiedAmount: a.certifiedAmount, certifiedAt: a.certifiedAt, applicationDate: a.applicationDate },
    receipts.map((r) => ({ paymentApplicationId: r.paymentApplicationId, status: r.status, amount: r.amount, receivedDate: r.receivedDate })),
  );
  const live = receipts.filter((r) => r.status !== "void").sort((x, y) => x.receivedDate.localeCompare(y.receivedDate));
  const last = live[live.length - 1];
  const wasPaidState = a.status === "paid";
  const nextStatus =
    settlement.state === "paid"
      ? "paid"
      : wasPaidState
        ? // a receipt was voided under a paid application: back to its certified state
          (a.certifiedAmount !== null && Math.abs(a.certifiedAmount - a.currentPaymentDue) > 0.005 ? "partially_certified" : "certified")
        : a.status;
  const now = nowIso();
  await db
    .update(paymentApplications)
    .set({
      paidAmount: settlement.paid,
      paidAt: last ? `${last.receivedDate}T00:00:00.000Z` : null,
      paymentReference: last?.paymentReference ?? null,
      status: nextStatus,
      detail: { ...((a.detail as Record<string, unknown> | null) ?? {}), settlement },
      updatedAt: now,
    })
    .where(eq(paymentApplications.id, applicationId));
  if (a.invoiceId) {
    await db
      .update(invoices)
      .set({
        amountPaid: settlement.paid,
        paidDate: last?.receivedDate ?? null,
        status: nextStatus === "paid" ? "paid" : nextStatus === "partially_certified" ? "approved_as_noted" : nextStatus === "certified" ? "approved" : undefined,
        updatedAt: now,
      })
      .where(eq(invoices.id, a.invoiceId));
  }
  const refreshed = await db.select().from(paymentApplications).where(eq(paymentApplications.id, applicationId)).limit(1);
  return { application: refreshed[0] ?? a, paid: settlement.paid, outstanding: settlement.outstanding, state: settlement.state };
}

/* ------------------------------------------------------------------ */
/* Receipts                                                            */
/* ------------------------------------------------------------------ */

export interface ReceiptInput {
  amount?: number | undefined;
  receivedDate?: string | undefined;
  method?: string | undefined;
  paymentReference?: string | null | undefined;
  bankReference?: string | null | undefined;
  notes?: string | null | undefined;
}

/**
 * Record one remittance from the owner against a certified application.
 * A receipt may be partial; Σ receipts may never exceed the certified
 * amount. The application's settlement and the contract's paid position
 * are re-derived from the receipts, never typed.
 */
export async function recordReceipt(
  db: Db,
  contract: ContractRow,
  billing: Billing,
  actorId: string,
  input: ReceiptInput,
  nextNumber: () => Promise<number>,
): Promise<{ receipt: ReceiptRow; settlement: Awaited<ReturnType<typeof settleApplication>>; contract: ContractRow }> {
  const a = billing.application;
  if (!["certified", "partially_certified", "paid"].includes(a.status)) {
    throw new AppError(409, `Application ${a.reference} is ${a.status} — only a certified application is payable.`);
  }
  const certified = round2(a.certifiedAmount ?? a.currentPaymentDue);
  const existing = await db
    .select({ amount: ownerPaymentReceipts.amount, status: ownerPaymentReceipts.status })
    .from(ownerPaymentReceipts)
    .where(eq(ownerPaymentReceipts.paymentApplicationId, a.id));
  const alreadyPaid = round2(existing.filter((r) => r.status !== "void").reduce((s, r) => s + r.amount, 0));
  const outstanding = round2(certified - alreadyPaid);
  const amount = round2(input.amount ?? outstanding);
  if (amount <= 0.005) {
    throw new AppError(400, `A receipt must carry an amount. ${a.reference} has ${outstanding.toFixed(2)} ${a.currency} outstanding.`);
  }
  if (amount - outstanding > 0.005) {
    throw new AppError(
      400,
      `Receipt of ${amount.toFixed(2)} ${a.currency} exceeds the ${outstanding.toFixed(2)} ${a.currency} still outstanding on the ` +
        `${certified.toFixed(2)} certified (${alreadyPaid.toFixed(2)} already received).`,
      { certified, alreadyPaid, outstanding, requested: amount, currency: a.currency },
    );
  }
  const number = await nextNumber();
  const id = newReceiptId();
  const now = nowIso();
  await db.insert(ownerPaymentReceipts).values({
    id,
    companyId: contract.companyId,
    projectId: contract.projectId,
    primeContractId: contract.id,
    paymentApplicationId: a.id,
    number,
    reference: `RCT-${String(number).padStart(3, "0")}`,
    status: "recorded",
    amount,
    currency: a.currency,
    receivedDate: input.receivedDate ?? today(),
    method: input.method ?? "ach",
    paymentReference: input.paymentReference ?? null,
    bankReference: input.bankReference ?? null,
    notes: input.notes ?? null,
    recordedBy: actorId,
    createdAt: now,
    updatedAt: now,
  });
  const settlement = await settleApplication(db, a.id);
  const recalculated = await recalcContract(db, contract.id, contract.companyId);
  const rows = await db.select().from(ownerPaymentReceipts).where(eq(ownerPaymentReceipts.id, id)).limit(1);
  return { receipt: rows[0]!, settlement, contract: recalculated };
}

function newReceiptId(): string {
  return newId("opr");
}
