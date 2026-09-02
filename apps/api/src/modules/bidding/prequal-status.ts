import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  bidInvitations,
  obligations,
  prequalificationFinancials,
  prequalificationSubmissions,
  signals,
  vendors,
} from "@constructos/db";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { conflict } from "../../lib/errors.js";
import type { FinancialDataSource } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { APPROVED_PREQUAL_OUTCOMES, isApprovedOutcome, todayIso, type BidPackageRow } from "./shared.js";
import {
  deriveRatios,
  recommendSingleProjectLimit,
  type RecommendedLimit,
} from "./financial-limits.js";

/**
 * PREQUALIFICATION EXPIRES, AND A LAPSED APPROVAL IS A SIGNAL BEFORE IT IS AN
 * INVITATION MISTAKENLY SENT.
 *
 * The machinery is deliberately the same as insurance certificate expiry
 * (ADR 0012, #780): an idempotent LAZY SWEEP that runs on list and detail
 * reads, never a cron. A record nobody reads harms nobody, and the read is
 * the moment the answer has to be true.
 *
 * Two detectors, each keyed in `evidenceRefs.key` so a repeated read never
 * raises the same lapse twice:
 *
 *   prequalification_lapsed     key = submissionId  (high)
 *   prequalification_supply_chain_gap  key = vendorId  (raised on demand)
 *
 * And one obligation: an approval inside its renewal window raises a renewal
 * obligation on the obligations register, bound to the submission through
 * `prequalification_submissions.obligation_id`. When the approval lapses with
 * that obligation still open, the obligation is BREACHED — the renewal was
 * not done, and the register should say so rather than quietly closing.
 */

/** Obligations raised here all carry this prefix so they can be counted back. */
export const PREQUAL_OBLIGATION_PREFIX = "prequalification";

/** How far ahead of expiry a renewal obligation is raised. */
export const RENEWAL_WINDOW_DAYS = 60;

const MS_PER_DAY = 86_400_000;

function daysUntil(isoDate: string | null | undefined, asOf: string): number | null {
  if (!isoDate) return null;
  const at = Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`);
  const now = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return null;
  return Math.round((at - now) / MS_PER_DAY);
}

export type PrequalState =
  | "approved"
  | "expiring"
  | "lapsed"
  | "suspended"
  | "rejected"
  | "in_progress"
  | "none";

export interface VendorPrequalStatus {
  vendorId: string;
  vendorName: string | null;
  submissionId: string | null;
  reference: string | null;
  questionnaireId: string | null;
  status: string | null;
  outcome: string | null;
  state: PrequalState;
  validFrom: string | null;
  expiresAt: string | null;
  daysToExpiry: number | null;
  singleProjectLimit: number | null;
  aggregateLimit: number | null;
  currency: string | null;
  tradeScopeApproved: string[];
  conditions: string | null;
  knockoutFailed: boolean;
  knockoutReason: string | null;
  /** the latest screening, when one exists */
  recommendedLimit: RecommendedLimit | null;
  /** plain English, always populated — this is what a gate quotes */
  note: string;
}

/**
 * A vendor's prequalification standing right now. Reads the most recent
 * decided submission and, failing that, the most recent submission of any
 * kind, so "they are half way through the questionnaire" is distinguishable
 * from "we have never asked them".
 */
export async function vendorPrequalStatus(
  db: Db,
  companyId: string,
  vendorId: string,
  asOf: string = todayIso(),
): Promise<VendorPrequalStatus> {
  const [vendorRow] = await db
    .select({ name: vendors.name })
    .from(vendors)
    .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
    .limit(1);

  const rows = await db
    .select()
    .from(prequalificationSubmissions)
    .where(
      and(
        eq(prequalificationSubmissions.companyId, companyId),
        eq(prequalificationSubmissions.vendorId, vendorId),
      ),
    )
    .orderBy(desc(prequalificationSubmissions.createdAt));

  const base = {
    vendorId,
    vendorName: vendorRow?.name ?? null,
    recommendedLimit: null as RecommendedLimit | null,
  };

  if (rows.length === 0) {
    return {
      ...base,
      submissionId: null,
      reference: null,
      questionnaireId: null,
      status: null,
      outcome: null,
      state: "none",
      validFrom: null,
      expiresAt: null,
      daysToExpiry: null,
      singleProjectLimit: null,
      aggregateLimit: null,
      currency: null,
      tradeScopeApproved: [],
      conditions: null,
      knockoutFailed: false,
      knockoutReason: null,
      note:
        `${vendorRow?.name ?? "This vendor"} has never been prequalified: there is no ` +
        "questionnaire submission of any kind on the record for them.",
    };
  }

  const decided = rows.filter((r) => isApprovedOutcome(r.outcome) || r.outcome === "rejected");
  const chosen = decided[0] ?? rows[0]!;
  const days = daysUntil(chosen.expiresAt, asOf);
  const approved = isApprovedOutcome(chosen.outcome);

  let state: PrequalState;
  if (chosen.status === "suspended") state = "suspended";
  else if (chosen.outcome === "rejected") state = "rejected";
  else if (!approved) state = "in_progress";
  else if (chosen.expiresAt && days !== null && days < 0) state = "lapsed";
  else if (chosen.status === "expired") state = "lapsed";
  else if (days !== null && days <= RENEWAL_WINDOW_DAYS) state = "expiring";
  else state = "approved";

  const screening = await latestScreening(db, companyId, vendorId);

  const noteByState: Record<PrequalState, string> = {
    approved:
      `${base.vendorName} is prequalified under ${chosen.reference}` +
      (chosen.expiresAt ? `, valid to ${chosen.expiresAt}` : " with no stated expiry") +
      (chosen.singleProjectLimit !== null
        ? `, capped at ${chosen.currency} ${chosen.singleProjectLimit} on any one project.`
        : "."),
    expiring:
      `${base.vendorName}'s prequalification ${chosen.reference} expires on ${chosen.expiresAt} ` +
      `(${days} day(s) away). Renewal is due now — an approval that lapses mid-tender cannot be ` +
      "relied on at award.",
    lapsed:
      `${base.vendorName}'s prequalification ${chosen.reference} LAPSED on ${chosen.expiresAt}. ` +
      "An expired approval is not an approval: nothing has been checked about this company " +
      "since then — not their accounts, not their safety record, not their insurance.",
    suspended:
      `${base.vendorName}'s prequalification ${chosen.reference} is SUSPENDED` +
      (chosen.suspendedReason ? `: ${chosen.suspendedReason}` : "."),
    rejected:
      `${base.vendorName} was assessed under ${chosen.reference} and REJECTED` +
      (chosen.rejectedReason ? `: ${chosen.rejectedReason}` : ".") +
      (chosen.knockoutFailed === 1 && chosen.knockoutReason
        ? ` Knockout: ${chosen.knockoutReason}`
        : ""),
    in_progress:
      `${base.vendorName}'s prequalification ${chosen.reference} is at status ` +
      `"${chosen.status}" and has not been decided. An undecided questionnaire is not an approval.`,
    none: "",
  };

  return {
    ...base,
    recommendedLimit: screening,
    submissionId: chosen.id,
    reference: chosen.reference,
    questionnaireId: chosen.questionnaireId,
    status: chosen.status,
    outcome: chosen.outcome,
    state,
    validFrom: chosen.validFrom,
    expiresAt: chosen.expiresAt,
    daysToExpiry: days,
    singleProjectLimit: chosen.singleProjectLimit,
    aggregateLimit: chosen.aggregateLimit,
    currency: chosen.currency,
    tradeScopeApproved: (chosen.tradeScopeApproved as string[]) ?? [],
    conditions: chosen.conditions,
    knockoutFailed: chosen.knockoutFailed === 1,
    knockoutReason: chosen.knockoutReason,
    note: noteByState[state],
  };
}

/** The most recent financial screening for a vendor, re-derived on read. */
export async function latestScreening(
  db: Db,
  companyId: string,
  vendorId: string,
): Promise<RecommendedLimit | null> {
  const rows = await db
    .select()
    .from(prequalificationFinancials)
    .where(
      and(
        eq(prequalificationFinancials.companyId, companyId),
        eq(prequalificationFinancials.vendorId, vendorId),
      ),
    )
    .orderBy(desc(prequalificationFinancials.financialYearEnd))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const figures = {
    currency: row.currency,
    source: row.source as FinancialDataSource,
    financialYearEnd: row.financialYearEnd,
    turnover: row.turnover,
    operatingProfit: row.operatingProfit,
    profitBeforeTax: row.profitBeforeTax,
    netAssets: row.netAssets,
    currentAssets: row.currentAssets,
    currentLiabilities: row.currentLiabilities,
    cashAtBank: row.cashAtBank,
    totalDebt: row.totalDebt,
    inventory: (row.detail as Record<string, unknown>)["inventory"] as number | null,
    largestContractValue: row.largestContractValue,
    orderBookValue: row.orderBookValue,
    isGoingConcernQualified: row.isGoingConcernQualified === 1,
    insolvencyEventCount: ((row.insolvencyEvents as unknown[]) ?? []).length,
  };
  return recommendSingleProjectLimit(figures, deriveRatios(figures));
}

/**
 * The limit to test a contract against, WITH the currency it is stated in.
 *
 * The approved cap and the derived screening figure are different numbers in
 * potentially different currencies, so they must be picked as a PAIR. Taking
 * the amount from one and the currency from the other produced a comparison
 * that silently refused itself as a currency mismatch.
 */
export function effectiveLimit(status: VendorPrequalStatus): {
  limit: number | null;
  currency: string | null;
  basis: string | null;
} {
  if (status.singleProjectLimit !== null && status.singleProjectLimit !== undefined) {
    return {
      limit: status.singleProjectLimit,
      currency: status.currency,
      basis:
        `Cap set on prequalification ${status.reference} when the vendor was admitted to the ` +
        "supply chain.",
    };
  }
  if (status.recommendedLimit && status.recommendedLimit.value !== null) {
    return {
      limit: status.recommendedLimit.value,
      currency: status.recommendedLimit.currency,
      basis: status.recommendedLimit.basis,
    };
  }
  return { limit: null, currency: null, basis: status.recommendedLimit?.basis ?? null };
}

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

export type PrequalStrictness = "refuse" | "warn";

/**
 * How hard the prequalification gate bites on this package. Declared on the
 * package (`detail.prequalificationStrictness`) so a fit-out enquiry and a
 * public works tender can differ, and defaulting to REFUSE wherever
 * prequalification was declared a requirement of the tender.
 */
export function prequalStrictness(pkg: BidPackageRow): PrequalStrictness {
  const declared = (pkg.detail as Record<string, unknown>)["prequalificationStrictness"];
  if (declared === "warn" || declared === "refuse") return declared;
  return pkg.prequalificationRequired === 1 ? "refuse" : "warn";
}

export interface PrequalGateResult {
  /** true when nothing is wrong with this vendor's standing */
  ok: boolean;
  state: PrequalState;
  strictness: PrequalStrictness;
  /** populated whenever ok is false, whether it refused or warned */
  message: string | null;
  status: VendorPrequalStatus;
}

const BAD_STATES: PrequalState[] = ["lapsed", "rejected", "suspended", "in_progress", "none"];

/**
 * Test a vendor's standing at the moment they are being considered.
 *
 * `throwOnRefuse` is what separates an invitation from an award: an
 * invitation to a lapsed vendor is FLAGGED (they may renew before the
 * deadline, and telling them to is the point), while awarding to one is
 * refused or warned per the package's configured strictness — and either way
 * the message names the lapse.
 */
export function evaluatePrequalGate(
  pkg: BidPackageRow,
  status: VendorPrequalStatus,
  what: string,
  throwOnRefuse: boolean,
): PrequalGateResult {
  const strictness = prequalStrictness(pkg);
  const required = pkg.prequalificationRequired === 1;
  const bad = BAD_STATES.includes(status.state);

  if (!bad) {
    return { ok: true, state: status.state, strictness, message: null, status };
  }

  const detail =
    status.state === "lapsed"
      ? `their prequalification ${status.reference} expired on ${status.expiresAt}`
      : status.state === "none"
        ? "they have never been prequalified"
        : status.state === "in_progress"
          ? `their prequalification ${status.reference} is still at "${status.status}" and undecided`
          : status.state === "suspended"
            ? `their prequalification ${status.reference} is suspended`
            : `their prequalification ${status.reference} was rejected`;

  const message =
    `${what} — ${status.vendorName ?? "this vendor"}: ${detail}. ` +
    (required
      ? "This package was issued on the basis that bidders are prequalified, so that basis no " +
        "longer holds for them. "
      : "") +
    status.note;

  if (throwOnRefuse && required && strictness === "refuse") {
    throw conflict(
      `${message} Renew the prequalification, or set this package's ` +
        'prequalificationStrictness to "warn" and record who accepted the risk.',
    );
  }
  return { ok: false, state: status.state, strictness, message, status };
}

/* ------------------------------------------------------------------ */
/* The lazy sweep                                                      */
/* ------------------------------------------------------------------ */

/** Signal keys already raised for a detector in this company. */
async function alreadySignalled(db: Db, companyId: string, detector: string): Promise<Set<string>> {
  const rows = await db
    .select({ refs: signals.evidenceRefs })
    .from(signals)
    .where(and(eq(signals.companyId, companyId), eq(signals.detector, detector)));
  const keys = new Set<string>();
  for (const row of rows) {
    const refs = row.refs as { key?: unknown } | null;
    if (typeof refs?.key === "string") keys.add(refs.key);
  }
  return keys;
}

/**
 * A renewal obligation needs a project, because the obligations register is
 * project-scoped. A company-wide prequalification therefore binds its renewal
 * to the project where the vendor is actually engaged — which is the project
 * that suffers if the renewal is missed. Where the vendor is engaged nowhere,
 * no obligation is raised and the caller is told why rather than being handed
 * an obligation against an arbitrary project.
 */
async function renewalProjectFor(
  db: Db,
  companyId: string,
  submissionProjectId: string | null,
  vendorId: string,
): Promise<{ projectId: string | null; why: string }> {
  if (submissionProjectId) {
    return {
      projectId: submissionProjectId,
      why: "the project this prequalification was raised for",
    };
  }
  const rows = await db
    .select({ projectId: bidInvitations.projectId })
    .from(bidInvitations)
    .where(
      and(
        eq(bidInvitations.companyId, companyId),
        eq(bidInvitations.vendorId, vendorId),
        inArray(bidInvitations.status, [
          "draft",
          "sent",
          "delivered",
          "viewed",
          "downloaded",
          "intent_to_bid",
          "submitted",
        ]),
      ),
    )
    .orderBy(desc(bidInvitations.createdAt))
    .limit(1);
  if (rows[0]) {
    return {
      projectId: rows[0].projectId,
      why: "the project where this vendor currently holds a live bid invitation",
    };
  }
  return {
    projectId: null,
    why:
      "no project — this is a company-wide prequalification and the vendor holds no live bid " +
      "invitation, so there is nothing project-scoped to bind the renewal to. It is still " +
      "tracked on the submission's renewalDueAt and will raise a signal if it lapses.",
  };
}

export interface PrequalSweepResult {
  lapsed: string[];
  renewalObligationsRaised: string[];
  signalsRaised: string[];
  notes: string[];
}

/**
 * Idempotent expiry sweep over this company's prequalification register.
 * Lazy: run from list and detail reads, never from a cron.
 */
export async function sweepPrequalification(
  db: Db,
  companyId: string,
  actorId: string,
  asOf: string = todayIso(),
): Promise<PrequalSweepResult> {
  const result: PrequalSweepResult = {
    lapsed: [],
    renewalObligationsRaised: [],
    signalsRaised: [],
    notes: [],
  };

  const live = await db
    .select()
    .from(prequalificationSubmissions)
    .where(
      and(
        eq(prequalificationSubmissions.companyId, companyId),
        inArray(prequalificationSubmissions.outcome, [...APPROVED_PREQUAL_OUTCOMES]),
        isNotNull(prequalificationSubmissions.expiresAt),
      ),
    );
  if (live.length === 0) return result;

  const seen = await alreadySignalled(db, companyId, "prequalification_lapsed");
  const now = new Date().toISOString();

  for (const row of live) {
    const days = daysUntil(row.expiresAt, asOf);
    if (days === null) continue;

    /* (1) it has lapsed */
    if (days < 0) {
      if (row.status !== "expired" && row.status !== "suspended" && row.status !== "withdrawn") {
        await db
          .update(prequalificationSubmissions)
          .set({ status: "expired", updatedAt: now })
          .where(eq(prequalificationSubmissions.id, row.id));
        await appendLedger(db, {
          companyId,
          actorId,
          action: "state_change",
          objectType: "prequalification_submission",
          objectId: row.id,
          payload: { from: row.status, to: "expired", expiresAt: row.expiresAt, derived: true },
          projectId: row.projectId,
        });
        result.lapsed.push(row.id);
      }
      // an open renewal obligation that was never discharged is BREACHED
      if (row.obligationId) {
        await db
          .update(obligations)
          .set({ status: "breached" })
          .where(and(eq(obligations.id, row.obligationId), eq(obligations.status, "open")));
      }
      if (!seen.has(row.id)) {
        seen.add(row.id);
        const [vendorRow] = await db
          .select({ name: vendors.name })
          .from(vendors)
          .where(eq(vendors.id, row.vendorId))
          .limit(1);
        const signalId = newId("sig");
        await db.insert(signals).values({
          id: signalId,
          companyId,
          projectId: row.projectId,
          detector: "prequalification_lapsed",
          severity: "high",
          confidence: 1,
          title: `Prequalification lapsed — ${vendorRow?.name ?? row.vendorId} (${row.reference})`,
          explanation:
            `${vendorRow?.name ?? "This vendor"}'s prequalification ${row.reference} was valid to ` +
            `${row.expiresAt} and has not been renewed. Nothing has been checked about this ` +
            "company since then: not their accounts, not their safety record, not their " +
            "insurance, not whether they still employ the people whose experience got them " +
            "approved. Until it is renewed, an invitation to them is unsupported and an award " +
            "to them is a decision taken on stale evidence — which is the finding an auditor " +
            "writes up after the failure, not before it.",
          evidenceRefs: {
            key: row.id,
            submissionId: row.id,
            vendorId: row.vendorId,
            reference: row.reference,
            expiresAt: row.expiresAt,
            obligationId: row.obligationId,
          },
        });
        await db
          .update(prequalificationSubmissions)
          .set({ signalId, updatedAt: now })
          .where(eq(prequalificationSubmissions.id, row.id));
        result.signalsRaised.push(signalId);
      }
      continue;
    }

    /* (2) it is inside the renewal window — raise the obligation once */
    if (days <= RENEWAL_WINDOW_DAYS && !row.obligationId) {
      const target = await renewalProjectFor(db, companyId, row.projectId, row.vendorId);
      if (!target.projectId) {
        result.notes.push(
          `${row.reference} expires in ${days} day(s) but no renewal obligation was raised: ${target.why}`,
        );
        await db
          .update(prequalificationSubmissions)
          .set({ renewalDueAt: row.expiresAt, updatedAt: now })
          .where(eq(prequalificationSubmissions.id, row.id));
        continue;
      }
      const obligationId = newId("obl");
      await db.insert(obligations).values({
        id: obligationId,
        companyId,
        projectId: target.projectId,
        sourceClause: `${PREQUAL_OBLIGATION_PREFIX} ${row.reference} — renewal`,
        trigger:
          `Prequalification ${row.reference} expires on ${row.expiresAt}. Renew it before then, ` +
          "or the vendor drops out of the supply chain mid-tender.",
        deadline: `${row.expiresAt}T23:59:59Z`,
        warnDaysBefore: Math.min(30, Math.max(7, Math.ceil(RENEWAL_WINDOW_DAYS / 4))),
        evidenceRequirement:
          "A renewed prequalification submission, assessed and approved by someone other than " +
          "its assessor, with current financial figures",
        status: "open",
        createdBy: actorId,
      });
      await db
        .update(prequalificationSubmissions)
        .set({ obligationId, renewalDueAt: row.expiresAt, updatedAt: now })
        .where(eq(prequalificationSubmissions.id, row.id));
      await appendLedger(db, {
        companyId,
        actorId,
        action: "create",
        objectType: "prequalification_submission",
        objectId: row.id,
        payload: {
          renewalObligationId: obligationId,
          expiresAt: row.expiresAt,
          daysToExpiry: days,
          boundTo: target.why,
          derived: true,
        },
        projectId: target.projectId,
      });
      result.renewalObligationsRaised.push(obligationId);
    }
  }

  return result;
}
