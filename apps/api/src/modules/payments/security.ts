import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  commitmentPayments,
  commitments,
  paymentSecurityAccounts,
  paymentSecurityMovements,
  signals,
  vendors,
} from "@constructos/db";
import { PAYMENT_SECURITY_ACCOUNT_KINDS, PAYMENT_SECURITY_MOVEMENT_KINDS } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import type { Db } from "../../lib/db.js";
import { isoDateSchema, todayISO } from "../field/dates.js";

/**
 * RETENTION TRUSTS, PROJECT BANK ACCOUNTS AND ESCROW (spec Vol II F #381–385).
 *
 * Several regimes require retention money to be held in trust, and public
 * clients increasingly pay through a project bank account that pays the
 * supply chain directly. The record here is the ACCOUNT and its MOVEMENTS;
 * the balance is derived from the movements, never typed, and the one
 * question that matters — is the trust funded to what the commitments say
 * is being held? — is answered by reconciliation, per currency, with any
 * shortfall raised as a signal rather than left in a footnote.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;
const CENT = 0.005;

const accountSchema = z.object({
  kind: z.enum(PAYMENT_SECURITY_ACCOUNT_KINDS),
  name: z.string().min(1).max(200),
  bankReference: z.string().max(200).nullable().optional(),
  trustee: z.string().max(200).nullable().optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  beneficiaryVendorIds: z.array(z.string().min(1).max(64)).max(500).optional(),
  openedAt: isoDateSchema.nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const movementSchema = z.object({
  kind: z.enum(PAYMENT_SECURITY_MOVEMENT_KINDS),
  /** unsigned; the sign is implied by the kind (release/withdrawal debit) */
  amount: z.number().finite().positive(),
  beneficiaryVendorId: z.string().min(1).max(64).nullable().optional(),
  relatedPaymentId: z.string().min(1).max(64).nullable().optional(),
  relatedInvoiceId: z.string().min(1).max(64).nullable().optional(),
  reference: z.string().max(200).nullable().optional(),
  occurredAt: isoDateSchema.optional(),
  notes: z.string().max(4000).nullable().optional(),
});

const DEBIT_KINDS = new Set(["release", "withdrawal"]);

export function signedAmount(kind: string, amount: number): number {
  return DEBIT_KINDS.has(kind) ? -Math.abs(amount) : Math.abs(amount);
}

export interface AccountReconciliation {
  accountId: string;
  currency: string;
  balance: number;
  /** retainage the commitments say is held from the beneficiary vendors */
  retainageHeld: number;
  /** commitments that could not be counted (other currency) */
  skippedForCurrency: Array<{ commitmentId: string; reference: string; currency: string }>;
  shortfall: number;
  funded: boolean;
  basis: string;
}

/** Pure: does the balance cover the retainage held? */
export function reconcileAccount(input: {
  accountId: string;
  currency: string;
  movements: ReadonlyArray<{ amount: number }>;
  commitments: ReadonlyArray<{ id: string; reference: string; currency: string; retainageHeld: number }>;
}): AccountReconciliation {
  const balance = round2(input.movements.reduce((s, m) => s + m.amount, 0));
  const skipped: AccountReconciliation["skippedForCurrency"] = [];
  let held = 0;
  for (const c of input.commitments) {
    if (c.currency.toUpperCase() !== input.currency.toUpperCase()) {
      skipped.push({ commitmentId: c.id, reference: c.reference, currency: c.currency });
      continue;
    }
    held = round2(held + c.retainageHeld);
  }
  const shortfall = round2(Math.max(0, held - balance));
  return {
    accountId: input.accountId,
    currency: input.currency,
    balance,
    retainageHeld: held,
    skippedForCurrency: skipped,
    shortfall,
    funded: shortfall <= CENT,
    basis:
      `Balance is Σ signed movements (${input.movements.length}); retainage held is Σ commitments.retainageHeld over the ` +
      `${input.commitments.length - skipped.length} beneficiary commitment(s) in ${input.currency}` +
      (skipped.length > 0 ? `; ${skipped.length} commitment(s) in other currencies were not summed.` : "."),
  };
}

export async function reconcileAccountRow(db: Db, account: typeof paymentSecurityAccounts.$inferSelect): Promise<AccountReconciliation> {
  const movements = await db
    .select({ amount: paymentSecurityMovements.amount })
    .from(paymentSecurityMovements)
    .where(eq(paymentSecurityMovements.accountId, account.id));
  const clauses = [eq(paymentSecurityAccounts.projectId, account.projectId)];
  void clauses;
  const commitmentRows = await db
    .select({ id: commitments.id, reference: commitments.reference, currency: commitments.currency, retainageHeld: commitments.retainageHeld, vendorId: commitments.vendorId, status: commitments.status })
    .from(commitments)
    .where(and(eq(commitments.projectId, account.projectId), inArray(commitments.status, ["approved", "complete"])));
  const scoped =
    account.beneficiaryVendorIds.length > 0
      ? commitmentRows.filter((c) => c.vendorId && account.beneficiaryVendorIds.includes(c.vendorId))
      : commitmentRows;
  return reconcileAccount({ accountId: account.id, currency: account.currency, movements, commitments: scoped });
}

export const securityAccountRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("payments", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("payments", "standard")];

  async function fetchAccount(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(paymentSecurityAccounts)
      .where(and(eq(paymentSecurityAccounts.id, id), eq(paymentSecurityAccounts.companyId, companyId), eq(paymentSecurityAccounts.projectId, projectId)))
      .limit(1);
    if (!rows[0]) throw notFound("Account not found");
    return rows[0];
  }

  app.post("/projects/:projectId/payment-security-accounts", { preHandler: standardGate }, async (req, reply) => {
    const body = accountSchema.parse(req.body);
    if (body.beneficiaryVendorIds?.length) {
      const found = await app.db.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.companyId, req.companyId!), inArray(vendors.id, body.beneficiaryVendorIds)));
      if (found.length !== new Set(body.beneficiaryVendorIds).size) throw badRequest("beneficiaryVendorIds must all be vendors in this company");
    }
    const id = newId("psa");
    await app.db.insert(paymentSecurityAccounts).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      kind: body.kind,
      name: body.name,
      status: "active",
      bankReference: body.bankReference ?? null,
      trustee: body.trustee ?? null,
      currency: (body.currency ?? "USD").toUpperCase(),
      beneficiaryVendorIds: body.beneficiaryVendorIds ?? [],
      openedAt: body.openedAt ?? todayISO(),
      notes: body.notes ?? null,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, { companyId: req.companyId!, actorId: req.user!.id, action: "create", objectType: "payment_security_account", objectId: id, projectId: req.projectId!, payload: { kind: body.kind, name: body.name, currency: body.currency ?? "USD" }, storePayload: true });
    return reply.status(201).send(await fetchAccount(id, req.companyId!, req.projectId!));
  });

  app.get("/projects/:projectId/payment-security-accounts", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(paymentSecurityAccounts)
      .where(and(eq(paymentSecurityAccounts.companyId, req.companyId!), eq(paymentSecurityAccounts.projectId, req.projectId!)))
      .orderBy(asc(paymentSecurityAccounts.createdAt));
    const items = [];
    for (const a of rows) items.push({ ...a, reconciliation: await reconcileAccountRow(app.db, a) });
    return { items, total: items.length, underfunded: items.filter((i) => !i.reconciliation.funded && i.status === "active").length };
  });

  app.get("/projects/:projectId/payment-security-accounts/:accountId", { preHandler: readGate }, async (req) => {
    const { accountId } = req.params as { accountId: string };
    const account = await fetchAccount(accountId, req.companyId!, req.projectId!);
    const movements = await app.db.select().from(paymentSecurityMovements).where(eq(paymentSecurityMovements.accountId, accountId)).orderBy(desc(paymentSecurityMovements.occurredAt), desc(paymentSecurityMovements.createdAt));
    return { ...account, movements, reconciliation: await reconcileAccountRow(app.db, account) };
  });

  app.post("/projects/:projectId/payment-security-accounts/:accountId/movements", { preHandler: standardGate }, async (req, reply) => {
    const { accountId } = req.params as { accountId: string };
    const body = movementSchema.parse(req.body);
    const account = await fetchAccount(accountId, req.companyId!, req.projectId!);
    if (account.status !== "active") throw conflict("A closed account takes no movements");
    if (body.relatedPaymentId) {
      const p = await app.db.select({ id: commitmentPayments.id, currency: commitmentPayments.currency }).from(commitmentPayments).where(and(eq(commitmentPayments.id, body.relatedPaymentId), eq(commitmentPayments.projectId, req.projectId!))).limit(1);
      if (!p[0]) throw badRequest("relatedPaymentId does not reference a payment on this project");
      if (p[0].currency.toUpperCase() !== account.currency.toUpperCase()) throw badRequest(`The payment is in ${p[0].currency}; the account is in ${account.currency}`);
    }
    const amount = signedAmount(body.kind, body.amount);
    const before = await reconcileAccountRow(app.db, account);
    if (amount < 0 && before.balance + amount < -CENT) {
      throw badRequest(`This ${body.kind} of ${body.amount} ${account.currency} exceeds the ${before.balance} ${account.currency} in the account.`);
    }
    const id = newId("psm");
    await app.db.insert(paymentSecurityMovements).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      accountId,
      kind: body.kind,
      amount,
      beneficiaryVendorId: body.beneficiaryVendorId ?? null,
      relatedPaymentId: body.relatedPaymentId ?? null,
      relatedInvoiceId: body.relatedInvoiceId ?? null,
      reference: body.reference ?? null,
      occurredAt: body.occurredAt ?? todayISO(),
      notes: body.notes ?? null,
      createdBy: req.user!.id,
    });
    const after = await reconcileAccountRow(app.db, account);
    /* an under-funded trust is a signal, raised when the shortfall APPEARS */
    if (!after.funded && before.funded) {
      await app.db.insert(signals).values({
        id: newId("sig"),
        companyId: req.companyId!,
        projectId: req.projectId!,
        detector: "retention_trust_underfunded",
        severity: "high",
        confidence: 1,
        title: `${account.name} is under-funded by ${after.shortfall} ${account.currency}`,
        explanation: `${after.basis} Balance ${after.balance} ${account.currency} against ${after.retainageHeld} ${account.currency} of retainage the commitments say is held.`,
      });
    }
    await appendLedger(app.db, { companyId: req.companyId!, actorId: req.user!.id, action: "create", objectType: "payment_security_movement", objectId: id, projectId: req.projectId!, payload: { accountId, kind: body.kind, amount, balanceAfter: after.balance }, storePayload: true });
    return reply.status(201).send({ movementId: id, reconciliation: after });
  });

  app.post("/projects/:projectId/payment-security-accounts/:accountId/close", { preHandler: standardGate }, async (req) => {
    const { accountId } = req.params as { accountId: string };
    const account = await fetchAccount(accountId, req.companyId!, req.projectId!);
    const rec = await reconcileAccountRow(app.db, account);
    if (Math.abs(rec.balance) > CENT) throw conflict(`The account still holds ${rec.balance} ${account.currency}; release or withdraw it before closing.`);
    await app.db.update(paymentSecurityAccounts).set({ status: "closed", closedAt: todayISO(), updatedAt: new Date().toISOString() }).where(eq(paymentSecurityAccounts.id, accountId));
    await appendLedger(app.db, { companyId: req.companyId!, actorId: req.user!.id, action: "state_change", objectType: "payment_security_account", objectId: accountId, projectId: req.projectId!, payload: { status: "closed" } });
    return fetchAccount(accountId, req.companyId!, req.projectId!);
  });
};
