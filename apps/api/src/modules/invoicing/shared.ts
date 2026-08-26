import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { LedgerAction, PermissionLevel } from "@constructos/shared";
import { AppError, badRequest } from "../../lib/errors.js";
import { appendLedger } from "../../lib/ledger.js";
import type { Db } from "../../lib/db.js";

/* ------------------------------------------------------------------ */
/* Numbers                                                             */
/* ------------------------------------------------------------------ */

/** Money, to the cent. Every stored figure on this module goes through it. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Percentages, to four places — a retainage rate of 7.5 must not round to 8. */
export const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * Half a cent. Doubles cannot represent 0.1 exactly, so every comparison of
 * two money figures on this module is a comparison against this tolerance
 * rather than `===`. A billing engine that refuses an invoice because
 * 1000.0000000000001 > 1000 is a billing engine nobody uses.
 */
export const CENT = 0.005;

/** `1234567.5` -> `"1,234,567.50"` — for refusal messages that name figures. */
export function formatMoney(n: number): string {
  return round2(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export const nowIso = (): string => new Date().toISOString();
export const todayIso = (): string => new Date().toISOString().slice(0, 10);

const MS_PER_DAY = 86_400_000;

/** Whole days from `fromISO` to `toISO`, both ISO calendar dates. */
export function daysBetween(fromISO: string, toISO: string): number {
  return Math.floor(
    (Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / MS_PER_DAY,
  );
}

/** `addDays("2026-01-30", 45)` -> `"2026-03-16"`. */
export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Wire schemas                                                        */
/* ------------------------------------------------------------------ */

/** ISO calendar date (YYYY-MM-DD) — the wire format for every date column. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "Not a real calendar date");

export const currencySchema = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "Expected a 3-letter ISO 4217 currency code")
  .transform((s) => s.toUpperCase());

export const moneySchema = z.number().finite();
export const nonNegativeMoneySchema = z.number().finite().min(0);
export const percentSchema = z.number().finite().min(0).max(100);
export const detailSchema = z.record(z.string(), z.unknown());
export const reasonSchema = z.object({ reason: z.string().min(1).max(4000) });

/* ------------------------------------------------------------------ */
/* Money discipline (ADR: never sum across currencies)                 */
/* ------------------------------------------------------------------ */

export function assertSameCurrency(a: string, b: string, context: string): void {
  if (a.toUpperCase() !== b.toUpperCase()) {
    throw badRequest(
      `${context}: currency mismatch — ${a} cannot be combined with ${b}. ` +
        "Figures in different currencies are never summed on this platform.",
    );
  }
}

/**
 * A figure the platform could not compute. Identical in shape to the
 * benchmark metric contract (`{ value: null, reasons: [...] }`) so every
 * "we do not know" on the money spine reads the same way. A fabricated 0
 * on an aging report is how a business misses a payment run.
 */
export interface Unknowable<T = number> {
  value: T | null;
  reasons: string[];
}

export const known = <T>(value: T): Unknowable<T> => ({ value, reasons: [] });
export const unknown = <T>(...reasons: string[]): Unknowable<T> => ({ value: null, reasons });

/**
 * Bucket rows by currency and fold each bucket independently. There is no FX
 * rate on the record, so a single cross-currency total would be invented.
 * Every report in this module returns an array of these, never one number.
 */
export function byCurrency<T, R>(
  rows: readonly T[],
  currencyOf: (row: T) => string,
  fold: (rows: T[], currency: string) => R,
): R[] {
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const cur = currencyOf(row).toUpperCase();
    const list = buckets.get(cur);
    if (list) list.push(row);
    else buckets.set(cur, [row]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, list]) => fold(list, currency));
}

/* ------------------------------------------------------------------ */
/* Status vocabularies                                                 */
/* ------------------------------------------------------------------ */

/** An invoice in one of these statuses is a real claim on money. */
export const LIVE_INVOICE_STATUSES = [
  "submitted",
  "under_review",
  "approved",
  "approved_as_noted",
  "paid",
] as const;

/** Approved in either flavour — the point at which the SOV rolls forward. */
export const APPROVED_INVOICE_STATUSES = ["approved", "approved_as_noted", "paid"] as const;

/** Statuses that will never become money and are excluded from every rollup. */
export const DEAD_INVOICE_STATUSES = ["rejected", "void"] as const;

/** Editable: lines and header figures may still move. */
export const OPEN_INVOICE_STATUSES = ["draft", "revise_and_resubmit"] as const;

/** A lien waiver in one of these is ON FILE and unblocks payment. */
export const SATISFYING_WAIVER_STATUSES = ["received", "verified", "not_required"] as const;

/** Retainage that has actually been let go of. */
export const RELEASED_RETAINAGE_STATUSES = ["approved", "released"] as const;

const has = <T extends readonly string[]>(list: T, value: string): boolean =>
  (list as readonly string[]).includes(value);

export const isLiveInvoice = (s: string): boolean => has(LIVE_INVOICE_STATUSES, s);
export const isApprovedInvoice = (s: string): boolean => has(APPROVED_INVOICE_STATUSES, s);
export const isDeadInvoice = (s: string): boolean => has(DEAD_INVOICE_STATUSES, s);
export const isOpenInvoice = (s: string): boolean => has(OPEN_INVOICE_STATUSES, s);
export const isSatisfyingWaiver = (s: string): boolean => has(SATISFYING_WAIVER_STATUSES, s);
export const isReleasedRetainage = (s: string): boolean => has(RELEASED_RETAINAGE_STATUSES, s);

/* ------------------------------------------------------------------ */
/* Segregation of duties (ADR 0004)                                    */
/* ------------------------------------------------------------------ */

/**
 * The approver / certifier may be neither the author nor the submitter of
 * what they are approving. Enforced at the route rather than in a workflow
 * template, because a control someone can edit is not a control.
 */
export function assertSegregation(
  actorId: string,
  parties: {
    createdBy?: string | null;
    submittedBy?: string | null;
    requestedBy?: string | null;
    receivedBy?: string | null;
  },
  what: string,
): void {
  const checks: Array<[keyof typeof parties, string, string]> = [
    ["createdBy", "created_by", `the author of this ${what} may not approve it`],
    ["submittedBy", "submitted_by", `the person who submitted this ${what} may not approve it`],
    ["requestedBy", "requested_by", `the person who requested this ${what} may not approve it`],
    ["receivedBy", "received_by", `the person who received this ${what} may not verify it`],
  ];
  for (const [key, role, message] of checks) {
    if (parties[key] && parties[key] === actorId) {
      throw new AppError(403, `Segregation of duties: ${message}.`, {
        control: "no_self_approval",
        role,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Gates + ledger                                                      */
/* ------------------------------------------------------------------ */

/**
 * Tool-permission check for sub-resource routes that carry no `:projectId`
 * param (`/invoices/:invoiceId`, `/lien-waivers/:waiverId`). The owning
 * project is resolved from the record, injected into params, and the standard
 * `requireTool` gate runs — so a sub-resource write enforces exactly the same
 * `invoicing` tool level as a project-scoped one.
 */
export async function requireInvoicingLevel(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
  level: PermissionLevel,
): Promise<void> {
  (req.params as Record<string, string | undefined>)["projectId"] = projectId;
  await app.requireTool("invoicing", level)(req, reply);
}

/** Append to the hash chain, with the project attributed for the webhook. */
export async function ledger(
  db: Db,
  req: FastifyRequest,
  action: LedgerAction,
  objectType: string,
  objectId: string,
  payload: unknown,
  projectId: string,
  storePayload = false,
): Promise<void> {
  await appendLedger(db, {
    companyId: req.companyId!,
    actorId: req.user?.id ?? null,
    action,
    objectType,
    objectId,
    payload,
    projectId,
    storePayload,
  });
}

/* ------------------------------------------------------------------ */
/* References                                                          */
/* ------------------------------------------------------------------ */

export const pad3 = (n: number): string => String(n).padStart(3, "0");
export const pad4 = (n: number): string => String(n).padStart(4, "0");

/** `BP-003` — a billing period. */
export const periodReference = (n: number): string => `BP-${pad3(n)}`;
/** `OB-004` owner application / `INV-0012` subcontractor invoice. */
export const invoiceReference = (kind: string, n: number): string =>
  kind === "owner_billing" ? `OB-${pad3(n)}` : `INV-${pad4(n)}`;
/** `PA-004` — the certified application for payment sitting over an OB. */
export const applicationReference = (n: number): string => `PA-${pad3(n)}`;
/** `RR-003` — a retainage release. */
export const releaseReference = (n: number): string => `RR-${pad3(n)}`;
/** `LW-0021` — a lien waiver. */
export const waiverReference = (n: number): string => `LW-${pad4(n)}`;

/**
 * Counter keys. Invoice numbering is PER KIND because the unique index is
 * (projectId, kind, number): owner application OB-001 and subcontractor
 * invoice INV-0001 coexist and neither renumbers the other. These key names
 * are shared with the prime-contracts module on purpose — both write into the
 * same `invoices` table, so both must draw from the same counter.
 */
export const invoiceCounterKey = (kind: string): string =>
  kind === "owner_billing" ? "owner_billing_invoice" : "subcontractor_invoice";
export const APPLICATION_COUNTER = "payment_application";
export const PERIOD_COUNTER = "billing_period";
export const RELEASE_COUNTER = "retainage_release";
export const WAIVER_COUNTER = "lien_waiver";
export const paymentCounterKey = (commitmentId: string): string =>
  `commitment_payment:${commitmentId}`;
