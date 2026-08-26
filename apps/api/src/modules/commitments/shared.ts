import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { commitments } from "@constructos/db";
import type { PermissionLevel } from "@constructos/shared";
import { AppError, badRequest, notFound } from "../../lib/errors.js";
import { appendLedger } from "../../lib/ledger.js";
import type { Db } from "../../lib/db.js";

/* ------------------------------------------------------------------ */
/* Numeric + wire primitives                                           */
/* ------------------------------------------------------------------ */

/** Money to 2 decimal places. Every stored figure passes through this. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Percentages to 4 decimal places — retainage steps are basis-point exact. */
export const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * The tolerance an identity is allowed to drift by before we call it broken.
 * One cent: doublePrecision accumulates representation error over hundreds of
 * SOV lines, and refusing at exactly 0 would refuse arithmetic that is right.
 */
export const CENT = 0.005;

/** ISO calendar date (YYYY-MM-DD) — the wire format for every date column. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "Not a real calendar date");

/** Currency code as stored: 3-8 chars, upper-cased on the way in. */
export const currencySchema = z
  .string()
  .min(3)
  .max(8)
  .transform((s) => s.toUpperCase());

export const moneySchema = z.number().finite();
export const nonNegativeMoneySchema = z.number().finite().min(0);
export const percentSchema = z.number().finite().min(0).max(100);

export const detailSchema = z.record(z.string(), z.unknown());

/** Today, UTC, as an ISO calendar date. */
export const todayIso = (): string => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ */
/* Money discipline                                                    */
/* ------------------------------------------------------------------ */

/**
 * ADR money rule: figures in different currencies are never added. Callers
 * that would mix them must refuse, not convert — there is no rate on the
 * record and inventing one is fabrication.
 */
export function assertSameCurrency(a: string, b: string, context: string): void {
  if (a.toUpperCase() !== b.toUpperCase()) {
    throw badRequest(
      `${context}: currency mismatch — ${a} cannot be combined with ${b}. ` +
        "Figures in different currencies are never summed on this platform.",
    );
  }
}

/**
 * A figure the platform could not compute. Mirrors the benchmarks metric
 * contract exactly (`{ value: null, reasons: [...] }`) so every "we do not
 * know" on the money spine reads the same way. A zero here would be a lie.
 */
export interface Unknowable<T = number> {
  value: T | null;
  reasons: string[];
}

export const known = <T>(value: T): Unknowable<T> => ({ value, reasons: [] });
export const unknown = <T>(...reasons: string[]): Unknowable<T> => ({ value: null, reasons });

/* ------------------------------------------------------------------ */
/* Status vocabularies                                                 */
/* ------------------------------------------------------------------ */

/**
 * A commitment in one of these statuses is REAL money we owe: it lands in
 * `budget_line_items.committed_cost` and in every committed-cost rollup.
 */
export const COMMITTED_COMMITMENT_STATUSES = ["approved", "complete"] as const;

/**
 * Buyout in flight. Exposure we have created but not yet signed — it lands in
 * `pending_commitments`, deliberately a different column, because a budget
 * that shows an out-for-bid subcontract as committed cannot be trusted.
 */
export const PENDING_COMMITMENT_STATUSES = [
  "draft",
  "out_for_bid",
  "out_for_signature",
] as const;

/** Terminated and void commitments carry no forward obligation at all. */
export const DEAD_COMMITMENT_STATUSES = ["terminated", "void"] as const;

/** Change-order statuses that are already inside the revised commitment sum. */
export const COMMITTED_CHANGE_STATUSES = ["approved", "executed"] as const;

/** Priced but unsigned — the exposure bucket, outside the commitment sum. */
export const PENDING_CHANGE_STATUSES = [
  "pending_pricing",
  "pending_in_house_review",
  "pending_owner_approval",
  "revise_and_resubmit",
] as const;

/** Change-order statuses that will never become money. */
export const DEAD_CHANGE_STATUSES = ["rejected", "no_charge", "void"] as const;

/** Payments that have actually moved money out of the building. */
export const PAID_PAYMENT_STATUSES = ["issued", "cleared"] as const;

const membership = <T extends readonly string[]>(list: T, value: string): boolean =>
  (list as readonly string[]).includes(value);

export const isCommittedCommitment = (status: string): boolean =>
  membership(COMMITTED_COMMITMENT_STATUSES, status);
export const isPendingCommitment = (status: string): boolean =>
  membership(PENDING_COMMITMENT_STATUSES, status);
export const isCommittedChange = (status: string): boolean =>
  membership(COMMITTED_CHANGE_STATUSES, status);
export const isPendingChange = (status: string): boolean =>
  membership(PENDING_CHANGE_STATUSES, status);
export const isDeadChange = (status: string): boolean =>
  membership(DEAD_CHANGE_STATUSES, status);
export const isPaidPayment = (status: string): boolean =>
  membership(PAID_PAYMENT_STATUSES, status);

/* ------------------------------------------------------------------ */
/* Segregation of duties (ADR 0004)                                    */
/* ------------------------------------------------------------------ */

/**
 * The approver may be neither the author nor the submitter. This is the one
 * financial control that is worth more than every other control combined, and
 * it is enforced at the route, not in a workflow template someone can edit.
 */
export function assertSegregation(
  actorId: string,
  parties: { createdBy?: string | null; submittedBy?: string | null; requestedBy?: string | null },
  what: string,
): void {
  if (parties.createdBy && parties.createdBy === actorId) {
    throw new AppError(
      403,
      `Segregation of duties: the author of this ${what} may not approve it.`,
      { control: "no_self_approval", role: "created_by" },
    );
  }
  if (parties.submittedBy && parties.submittedBy === actorId) {
    throw new AppError(
      403,
      `Segregation of duties: the person who submitted this ${what} may not approve it.`,
      { control: "no_self_approval", role: "submitted_by" },
    );
  }
  if (parties.requestedBy && parties.requestedBy === actorId) {
    throw new AppError(
      403,
      `Segregation of duties: the person who requested this ${what} may not approve it.`,
      { control: "no_self_approval", role: "requested_by" },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Gates + fetch helpers                                               */
/* ------------------------------------------------------------------ */

/**
 * Tool-permission check for sub-resource routes that carry no `:projectId`
 * param (`/commitments/:commitmentId`, `/commitment-payments/:paymentId`).
 * The owning project is resolved from the record, injected into params, and
 * the standard `requireTool` gate runs — so a sub-resource write enforces
 * exactly the same commitments tool level as a project-scoped one.
 */
export async function requireCommitmentsLevel(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
  level: PermissionLevel,
): Promise<void> {
  (req.params as Record<string, string | undefined>)["projectId"] = projectId;
  await app.requireTool("commitments", level)(req, reply);
}

export type CommitmentRow = typeof commitments.$inferSelect;

export async function fetchCommitment(
  db: Db,
  commitmentId: string,
  companyId: string,
): Promise<CommitmentRow> {
  const rows = await db
    .select()
    .from(commitments)
    .where(and(eq(commitments.id, commitmentId), eq(commitments.companyId, companyId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("Commitment not found");
  return row;
}

/** Ledger append with the module's object-type vocabulary pre-bound. */
export async function ledger(
  db: Db,
  req: FastifyRequest,
  action: "create" | "update" | "delete" | "state_change",
  objectType:
    | "commitment"
    | "commitment_sov_line"
    | "commitment_change"
    | "commitment_payment"
    | "budget_line_item",
  objectId: string,
  payload: unknown,
  projectId?: string | null,
): Promise<void> {
  await appendLedger(db, {
    companyId: req.companyId!,
    actorId: req.user?.id ?? null,
    action,
    objectType,
    objectId,
    payload,
    ...(projectId !== undefined ? { projectId } : {}),
  });
}

/** Human label for a commitment: SC-0007 / PO-0007. */
export function commitmentReference(kind: string, number: number): string {
  const prefix = kind === "purchase_order" ? "PO" : "SC";
  return `${prefix}-${String(number).padStart(4, "0")}`;
}

/** Human label for a commitment change order: SC-0007-CCO-003. */
export function changeReference(commitmentRef: string, number: number): string {
  return `${commitmentRef}-CCO-${String(number).padStart(3, "0")}`;
}

/** Human label for a payment: SC-0007-PAY-002. */
export function paymentReference(commitmentRef: string, number: number): string {
  return `${commitmentRef}-PAY-${String(number).padStart(3, "0")}`;
}
