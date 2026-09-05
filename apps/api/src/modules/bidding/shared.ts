import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  bidAwards,
  bidInvitations,
  bidLevellingItems,
  bidPackages,
  bidSubmissions,
  prequalificationQuestionnaires,
  prequalificationSubmissions,
  vendors,
} from "@constructos/db";
import type { LedgerAction, PermissionLevel } from "@constructos/shared";
import { AppError, badRequest, notFound } from "../../lib/errors.js";
import { appendLedger } from "../../lib/ledger.js";
import type { Db } from "../../lib/db.js";

/* ------------------------------------------------------------------ */
/* Numeric + wire primitives                                           */
/* ------------------------------------------------------------------ */

/** Money to 2 decimal places. Every stored figure passes through this. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Ratios and scores to 4 decimal places. */
export const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * The tolerance two money figures may differ by before we call them
 * different. One cent: doublePrecision accumulates representation error over
 * a few hundred bid lines and refusing at exactly 0 would refuse arithmetic
 * that is right.
 */
export const CENT = 0.005;

/** ISO calendar date (YYYY-MM-DD) — the wire format for every date column. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "Not a real calendar date");

/** Lenient ISO timestamp (avoids zod version drift on .datetime()). */
export const isoTimestampSchema = z
  .string()
  .min(4)
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO timestamp");

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

/**
 * A written justification. Long enough that "n/a" and "ok" cannot pass: this
 * text is the whole of the audit answer when somebody asks why, and a
 * one-word reason is the same as no reason at all.
 */
export const justificationSchema = z.string().trim().min(20).max(4000);
/** A shorter stated reason — still never blank. */
export const reasonSchema = z.string().trim().min(3).max(2000);

/** Today, UTC, as an ISO calendar date. */
export const todayIso = (): string => new Date().toISOString().slice(0, 10);
export const nowIso = (): string => new Date().toISOString();

export const pad4 = (n: number): string => String(n).padStart(4, "0");

/* ------------------------------------------------------------------ */
/* "We do not know" — the platform's null contract                     */
/* ------------------------------------------------------------------ */

/**
 * A figure the platform could not compute. Mirrors the benchmarks metric
 * contract exactly (`{ value: null, reasons: [...] }`) so every "we do not
 * know" reads the same way across the platform. A zero here would be a lie,
 * and in procurement a lie that decides an award.
 */
export interface Unknowable<T = number> {
  value: T | null;
  reasons: string[];
}

export const known = <T>(value: T): Unknowable<T> => ({ value, reasons: [] });
export const unknowable = <T>(...reasons: string[]): Unknowable<T> => ({ value: null, reasons });

/* ------------------------------------------------------------------ */
/* Money discipline                                                    */
/* ------------------------------------------------------------------ */

/**
 * Figures in different currencies are never added on this platform, and in
 * this module they are never COMPARED either: "the lowest bid" across two
 * currencies is a statement about an exchange rate nobody recorded.
 */
export function assertSameCurrency(a: string, b: string, context: string): void {
  if (a.toUpperCase() !== b.toUpperCase()) {
    throw badRequest(
      `${context}: currency mismatch — ${a} cannot be combined with ${b}. ` +
        "Figures in different currencies are never summed or ranked against each other here.",
    );
  }
}

/** Distinct currencies present in a set of figures, upper-cased and sorted. */
export function distinctCurrencies(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((c): c is string => Boolean(c)).map((c) => c.toUpperCase()))].sort();
}

/* ------------------------------------------------------------------ */
/* Segregation of duties (ADR 0004)                                    */
/* ------------------------------------------------------------------ */

/**
 * The approver may be neither the author nor the person who recommended.
 * Evaluating and awarding are different acts by different people; a
 * procurement where they are the same person has no control at all.
 */
export function assertSegregation(
  actorId: string,
  parties: {
    createdBy?: string | null;
    recommendedBy?: string | null;
    reviewedBy?: string | null;
    adjustedBy?: string | null;
    submittedBy?: string | null;
  },
  what: string,
): void {
  const roles: [keyof typeof parties, string][] = [
    ["createdBy", "the author of"],
    ["recommendedBy", "the person who recommended"],
    ["reviewedBy", "the person who assessed"],
    ["adjustedBy", "the person who made the adjustment on"],
    ["submittedBy", "the person who submitted"],
  ];
  for (const [key, phrase] of roles) {
    if (parties[key] && parties[key] === actorId) {
      throw new AppError(
        403,
        `Segregation of duties: ${phrase} this ${what} may not approve it.`,
        { control: "no_self_approval", role: key },
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Row types                                                           */
/* ------------------------------------------------------------------ */

export type BidPackageRow = typeof bidPackages.$inferSelect;
export type BidInvitationRow = typeof bidInvitations.$inferSelect;
export type BidSubmissionRow = typeof bidSubmissions.$inferSelect;
export type BidLevellingItemRow = typeof bidLevellingItems.$inferSelect;
export type BidAwardRow = typeof bidAwards.$inferSelect;
export type QuestionnaireRow = typeof prequalificationQuestionnaires.$inferSelect;
export type PrequalSubmissionRow = typeof prequalificationSubmissions.$inferSelect;

/* ------------------------------------------------------------------ */
/* Gates + fetch helpers                                               */
/* ------------------------------------------------------------------ */

/**
 * Tool-permission check for sub-resource routes that carry no `:projectId`
 * param (`/bid-submissions/:id`, `/bid-awards/:id`). The owning project is
 * resolved from the record, injected into params, and the standard
 * `requireTool` gate runs — so a sub-resource write enforces exactly the same
 * `bidding` tool level as a project-scoped one.
 */
export async function requireBiddingLevel(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
  level: PermissionLevel,
): Promise<void> {
  (req.params as Record<string, string | undefined>)["projectId"] = projectId;
  await app.requireTool("bidding", level)(req, reply);
}

export async function fetchPackage(
  db: Db,
  packageId: string,
  companyId: string,
  projectId?: string,
): Promise<BidPackageRow> {
  const rows = await db
    .select()
    .from(bidPackages)
    .where(
      projectId
        ? and(
            eq(bidPackages.id, packageId),
            eq(bidPackages.companyId, companyId),
            eq(bidPackages.projectId, projectId),
          )
        : and(eq(bidPackages.id, packageId), eq(bidPackages.companyId, companyId)),
    )
    .limit(1);
  if (!rows[0]) throw notFound("Bid package not found");
  return rows[0];
}

export async function fetchInvitation(
  db: Db,
  invitationId: string,
  companyId: string,
): Promise<BidInvitationRow> {
  const rows = await db
    .select()
    .from(bidInvitations)
    .where(and(eq(bidInvitations.id, invitationId), eq(bidInvitations.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw notFound("Bid invitation not found");
  return rows[0];
}

export async function fetchSubmission(
  db: Db,
  submissionId: string,
  companyId: string,
): Promise<BidSubmissionRow> {
  const rows = await db
    .select()
    .from(bidSubmissions)
    .where(and(eq(bidSubmissions.id, submissionId), eq(bidSubmissions.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw notFound("Bid submission not found");
  return rows[0];
}

export async function fetchAward(
  db: Db,
  awardId: string,
  companyId: string,
): Promise<BidAwardRow> {
  const rows = await db
    .select()
    .from(bidAwards)
    .where(and(eq(bidAwards.id, awardId), eq(bidAwards.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw notFound("Bid award not found");
  return rows[0];
}

export async function fetchQuestionnaire(
  db: Db,
  questionnaireId: string,
  companyId: string,
): Promise<QuestionnaireRow> {
  const rows = await db
    .select()
    .from(prequalificationQuestionnaires)
    .where(
      and(
        eq(prequalificationQuestionnaires.id, questionnaireId),
        eq(prequalificationQuestionnaires.companyId, companyId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound("Prequalification questionnaire not found");
  return rows[0];
}

export async function fetchPrequalSubmission(
  db: Db,
  submissionId: string,
  companyId: string,
): Promise<PrequalSubmissionRow> {
  const rows = await db
    .select()
    .from(prequalificationSubmissions)
    .where(
      and(
        eq(prequalificationSubmissions.id, submissionId),
        eq(prequalificationSubmissions.companyId, companyId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound("Prequalification submission not found");
  return rows[0];
}

/**
 * A bidder is always a `directory.vendors` row. There is no second company
 * register in this module and there never will be — insurance certificates,
 * bonds and prequalification all hang off the vendor id.
 */
export async function assertVendor(
  db: Db,
  vendorId: string,
  companyId: string,
): Promise<{ id: string; name: string; status: string }> {
  const rows = await db
    .select({ id: vendors.id, name: vendors.name, status: vendors.status })
    .from(vendors)
    .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
    .limit(1);
  const vendor = rows[0];
  if (!vendor) {
    throw badRequest(
      "vendorId does not reference a vendor in this company's directory. Every bidder is a " +
        "directory vendor — that binding is what carries prequalification, insurance and " +
        "bonding onto the bid.",
    );
  }
  return vendor;
}

export type BiddingObjectType =
  | "bid_package"
  | "bid_invitation"
  | "bid_submission"
  | "bid_submission_line"
  | "bid_levelling_item"
  | "bid_levelling_entry"
  | "bid_award"
  | "prequalification_questionnaire"
  | "prequalification_question"
  | "prequalification_submission"
  | "prequalification_response"
  | "prequalification_financial"
  /* platform upgrade wave */
  | "bid_opportunity"
  | "bid_question"
  | "bid_meeting"
  | "bid_bond"
  | "bid_document_access"
  | "tender_cost"
  | "award_delegation"
  | "prequalification_safety_record"
  | "prequalification_licence"
  | "prequalification_reference";

/** Ledger append with the module's object-type vocabulary pre-bound. */
export async function ledger(
  db: Db,
  req: FastifyRequest,
  action: LedgerAction,
  objectType: BiddingObjectType,
  objectId: string,
  payload: unknown,
  projectId?: string | null,
  storePayload = false,
): Promise<void> {
  await appendLedger(db, {
    companyId: req.companyId!,
    actorId: req.user?.id ?? null,
    action,
    objectType,
    objectId,
    payload,
    storePayload,
    ...(projectId !== undefined ? { projectId } : {}),
  });
}

/* ------------------------------------------------------------------ */
/* Human references                                                    */
/* ------------------------------------------------------------------ */

export const packageReference = (number: number): string => `BP-${pad4(number)}`;
export const awardReference = (number: number): string => `AWD-${pad4(number)}`;
export const questionnaireReference = (number: number): string => `PQQ-${pad4(number)}`;
export const prequalReference = (number: number): string => `PQ-${pad4(number)}`;

/* ------------------------------------------------------------------ */
/* Status vocabularies with meaning                                    */
/* ------------------------------------------------------------------ */

/**
 * A submission in one of these statuses is OUT: it is not compared, not
 * levelled for completeness, and cannot be awarded. Everything else is "still
 * in contention" and its gaps block the comparison.
 */
export const OUT_OF_CONTENTION_SUBMISSION_STATUSES = [
  "draft",
  "unsuccessful",
  "withdrawn",
] as const;

export function isInContention(status: string): boolean {
  return !(OUT_OF_CONTENTION_SUBMISSION_STATUSES as readonly string[]).includes(status);
}

/** Invitations that are still live — the vendor may yet bid, or already has. */
export const LIVE_INVITATION_STATUSES = [
  "draft",
  "sent",
  "delivered",
  "viewed",
  "downloaded",
  "intent_to_bid",
  "submitted",
] as const;

/** Prequalification outcomes that admit a vendor to the supply chain. */
export const APPROVED_PREQUAL_OUTCOMES = [
  "approved",
  "approved_with_conditions",
  "approved_with_limit",
] as const;

export function isApprovedOutcome(outcome: string): boolean {
  return (APPROVED_PREQUAL_OUTCOMES as readonly string[]).includes(outcome);
}
