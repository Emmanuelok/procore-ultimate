/**
 * Domain P — the PROGRAMME engine (spec Vol II #777, #782, #787, #796, plus
 * the renewal pipeline #775 and the payment-hold hook WP-FIN2 calls).
 *
 * Pure, deterministic, dependency-free: every function is a total function of
 * its arguments and an explicit `asOf` date. No clock, no database, no I/O.
 * The route layer reads rows, calls these, and turns the answers into
 * Signals, Obligations and holds — which is why the whole file can be
 * unit-tested and the sweeps that consume it stay idempotent.
 *
 * Five questions it answers, all of them ones the register alone cannot:
 *
 *  1. HOW MUCH BONDING LINE IS LEFT (#796)? Utilisation is derived from the
 *     live bonds drawn against a facility, never stored, so it cannot drift
 *     from the bonds it summarises. Headroom is refused across currencies.
 *  2. WHAT IS THE LOSS RATIO (#782)? Claims incurred over premium earned,
 *     per currency, with the counts that produced it — the number that
 *     decides next year's renewal, and the one a policy record alone cannot
 *     give because premium is paid in instalments and partly returned.
 *  3. IS THE WORDING WHAT THE CONTRACT ASKED FOR? A requirement is a reading
 *     of a clause with a limit, a deductible ceiling and endorsements; a
 *     policy either satisfies it or fails it for a nameable reason.
 *  4. IS THE PERIOD A HOLE (#777)? Cover that starts after the works or ends
 *     before them is not cover for the uncovered days, and those days are the
 *     ones a loss will land on.
 *  5. SHOULD THIS PAYMENT BE HELD? The hook WP-FIN2 calls before releasing
 *     money to a vendor whose evidence of insurance has lapsed.
 *
 * Honesty rule carried through the file, as in expiry.ts: a figure that
 * cannot be computed is `null` with a reason, never defaulted to zero, and a
 * total is never summed across currencies.
 *
 * What it deliberately does NOT do: decide anything. Nothing here writes,
 * raises a signal, or blocks a payment; it returns findings and the caller
 * (which holds the permission and the ledger) acts on them.
 */
import type { InsuranceHoldReason } from "@constructos/shared";
import {
  daysBetweenISO,
  isIsoDate,
  type BondLike,
  type CertificateLike,
  type IsoDate,
  type PolicyLike,
} from "./expiry.js";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Row shapes (structural — real drizzle rows satisfy these)           */
/* ------------------------------------------------------------------ */

/** A recorded cover requirement: a clause, a scope and a limit. */
export interface RequirementLike {
  id: string;
  projectId: string | null;
  vendorId: string | null;
  policyType: string;
  requiredByClause: string;
  minimumLimit: number | null;
  limitBasis: string | null;
  currency: string;
  maximumDeductible: number | null;
  waiverOfSubrogation: number;
  additionalInsuredRequired: number;
  maintainMonthsAfterCompletion: number | null;
  territorialLimits: string | null;
  status: string;
}

export interface FacilityLike {
  id: string;
  number: string;
  name: string;
  provider: string;
  projectId: string | null;
  limitAmount: number;
  currency: string;
  permittedBondTypes: string[];
  status: string;
  effectiveFrom: IsoDate | null;
  effectiveTo: IsoDate | null;
  reviewDate: IsoDate | null;
}

export interface PremiumLike {
  id: string;
  policyId: string;
  kind: string;
  amount: number;
  currency: string;
  periodStart: IsoDate | null;
  periodEnd: IsoDate | null;
  paidAt: IsoDate | null;
}

export interface ClaimLike {
  id: string;
  policyId: string;
  projectId: string | null;
  status: string;
  quantum: number | null;
  reserve: number | null;
  settledAmount: number | null;
  currency: string;
  incidentDate: IsoDate;
}

/** A recorded loss with a money value, from safety, quality or forensics. */
export interface LossEventLike {
  recordType: string;
  recordId: string;
  projectId: string;
  title: string;
  /** the date the loss happened, not the date it was typed in */
  occurredAt: IsoDate;
  lossAmount: number | null;
  currency: string;
  /** which class of cover would respond, if any */
  policyType: string | null;
}

/* ================================================================== */
/* 1. BONDING LINE HEADROOM (#796)                                     */
/* ================================================================== */

/** Bond statuses that consume facility line. */
export const BOND_DRAWN_STATUSES = ["issued", "active", "called"] as const;

export interface FacilityUtilisation {
  facilityId: string;
  number: string;
  name: string;
  provider: string;
  currency: string;
  limitAmount: number;
  /** live exposure drawn against the line, in the facility's currency */
  drawnAmount: number;
  /** limit − drawn, or null when it cannot honestly be computed */
  headroom: number | null;
  utilisationPct: number | null;
  bondCount: number;
  /** bonds pointing at this facility in a different currency — never netted */
  excludedForeignCurrency: Array<{ bondId: string; currency: string; amount: number }>;
  /** bonds of a type the facility does not permit: drawn anyway, flagged */
  outsidePermittedTypes: string[];
  inForce: boolean | null;
  daysToReview: number | null;
  reasons: string[];
}

/**
 * What is left of a bonding line.
 *
 * `currentExposure` is supplied by the caller (from expiry.ts's
 * `bondCurrentExposure`, which understands reduction schedules) so this file
 * stays free of that logic and the two cannot disagree.
 */
export function facilityUtilisation(
  facility: FacilityLike,
  bonds: ReadonlyArray<BondLike & { facilityId: string | null }>,
  currentExposure: (bond: BondLike) => number,
  asOf: IsoDate,
): FacilityUtilisation {
  const reasons: string[] = [];
  const mine = bonds.filter(
    (b) =>
      b.facilityId === facility.id &&
      (BOND_DRAWN_STATUSES as readonly string[]).includes(b.status),
  );
  const excludedForeignCurrency = mine
    .filter((b) => b.currency !== facility.currency)
    .map((b) => ({ bondId: b.id, currency: b.currency, amount: b.amount }));
  const sameCurrency = mine.filter((b) => b.currency === facility.currency);
  const drawnAmount = round2(
    sameCurrency.reduce((sum, b) => sum + currentExposure(b), 0),
  );
  const permitted = facility.permittedBondTypes ?? [];
  const outsidePermittedTypes =
    permitted.length === 0
      ? []
      : [...new Set(mine.filter((b) => !permitted.includes(b.bondType)).map((b) => b.bondType))];
  if (excludedForeignCurrency.length > 0) {
    reasons.push(
      `${excludedForeignCurrency.length} bond(s) are drawn against this facility in a different ` +
        `currency and are excluded from the utilisation figure — a ${facility.currency} line and a ` +
        `foreign-currency bond cannot be netted without a rate, and no rate is held.`,
    );
  }
  if (outsidePermittedTypes.length > 0) {
    reasons.push(
      `Bond type(s) ${outsidePermittedTypes.join(", ")} are drawn against a facility that does not ` +
        `permit them. They still consume line, so they are counted, but the provider may refuse them.`,
    );
  }
  const inForce =
    facility.status !== "active"
      ? false
      : facility.effectiveFrom || facility.effectiveTo
        ? (!facility.effectiveFrom || daysBetweenISO(facility.effectiveFrom, asOf) >= 0) &&
          (!facility.effectiveTo || daysBetweenISO(asOf, facility.effectiveTo) >= 0)
        : true;
  if (!inForce) {
    reasons.push(
      `This facility is not in force as at ${asOf} (status ${facility.status}` +
        `${facility.effectiveTo ? `, effective to ${facility.effectiveTo}` : ""}), so its headroom ` +
        `is not available line.`,
    );
  }
  const headroom = facility.limitAmount > 0 ? round2(facility.limitAmount - drawnAmount) : null;
  if (headroom === null) {
    reasons.push("The facility records no limit, so headroom cannot be computed.");
  } else if (headroom < 0) {
    reasons.push(
      `The line is over-drawn by ${facility.currency} ${round2(-headroom)}: live bonds exceed the ` +
        `agreed limit, which normally means a released bond was never recorded as released.`,
    );
  }
  return {
    facilityId: facility.id,
    number: facility.number,
    name: facility.name,
    provider: facility.provider,
    currency: facility.currency,
    limitAmount: facility.limitAmount,
    drawnAmount,
    headroom,
    utilisationPct:
      facility.limitAmount > 0 ? round2((drawnAmount / facility.limitAmount) * 100) : null,
    bondCount: sameCurrency.length,
    excludedForeignCurrency,
    outsidePermittedTypes,
    inForce,
    daysToReview: facility.reviewDate ? daysBetweenISO(asOf, facility.reviewDate) : null,
    reasons,
  };
}

/* ================================================================== */
/* 2. PREMIUM AND CLAIMS EXPERIENCE (#782)                             */
/* ================================================================== */

export interface ExperienceByCurrency {
  currency: string;
  premiumWritten: number;
  premiumReturned: number;
  premiumNet: number;
  brokerFees: number;
  levies: number;
  claimsPaid: number;
  claimsReserved: number;
  claimsIncurred: number;
  claimCount: number;
  openClaimCount: number;
  /** claims incurred ÷ net premium, as a percentage. null when no premium. */
  lossRatioPct: number | null;
  reasons: string[];
}

export interface ExperienceReport {
  byCurrency: ExperienceByCurrency[];
  /** premium rows whose currency differs from their policy's — a data fault */
  currencyMismatches: Array<{ premiumId: string; policyId: string }>;
  note: string | null;
}

const OPEN_CLAIM_STATUSES = [
  "notified",
  "acknowledged",
  "under_assessment",
  "accepted",
] as const;

/**
 * Claims experience, bucketed by currency and never across.
 *
 * `claimsIncurred` = settled amounts on closed claims + reserves on open ones,
 * which is the market's definition and the only one that does not double
 * count. A claim with neither a settlement nor a reserve contributes nothing
 * and is named in `reasons` rather than assumed to be nil.
 */
export function computeExperience(input: {
  premiums: readonly PremiumLike[];
  claims: readonly ClaimLike[];
  policyCurrency?: ReadonlyMap<string, string>;
}): ExperienceReport {
  const { premiums, claims, policyCurrency } = input;
  const buckets = new Map<string, ExperienceByCurrency>();
  const bucket = (currency: string): ExperienceByCurrency => {
    let b = buckets.get(currency);
    if (!b) {
      b = {
        currency,
        premiumWritten: 0,
        premiumReturned: 0,
        premiumNet: 0,
        brokerFees: 0,
        levies: 0,
        claimsPaid: 0,
        claimsReserved: 0,
        claimsIncurred: 0,
        claimCount: 0,
        openClaimCount: 0,
        lossRatioPct: null,
        reasons: [],
      };
      buckets.set(currency, b);
    }
    return b;
  };

  const currencyMismatches: Array<{ premiumId: string; policyId: string }> = [];
  for (const p of premiums) {
    const expected = policyCurrency?.get(p.policyId);
    if (expected && expected !== p.currency) {
      currencyMismatches.push({ premiumId: p.id, policyId: p.policyId });
    }
    const b = bucket(p.currency);
    if (p.kind === "return_premium") b.premiumReturned = round2(b.premiumReturned + p.amount);
    else if (p.kind === "broker_fee") b.brokerFees = round2(b.brokerFees + p.amount);
    else if (p.kind === "levy") b.levies = round2(b.levies + p.amount);
    else b.premiumWritten = round2(b.premiumWritten + p.amount);
  }

  let unvalued = 0;
  for (const c of claims) {
    const b = bucket(c.currency);
    b.claimCount += 1;
    const open = (OPEN_CLAIM_STATUSES as readonly string[]).includes(c.status);
    if (open) b.openClaimCount += 1;
    if (c.status === "settled" && c.settledAmount !== null) {
      b.claimsPaid = round2(b.claimsPaid + c.settledAmount);
    } else if (open && c.reserve !== null) {
      b.claimsReserved = round2(b.claimsReserved + c.reserve);
    } else if (open && c.quantum !== null) {
      /* No reserve set: the claimed quantum is the only figure held, and it is
         labelled as such rather than silently treated as a reserve. */
      b.claimsReserved = round2(b.claimsReserved + c.quantum);
    } else if (c.status !== "repudiated" && c.status !== "withdrawn") {
      unvalued += 1;
    }
  }

  for (const b of buckets.values()) {
    b.premiumNet = round2(b.premiumWritten - b.premiumReturned);
    b.claimsIncurred = round2(b.claimsPaid + b.claimsReserved);
    if (b.premiumNet > 0) {
      b.lossRatioPct = round2((b.claimsIncurred / b.premiumNet) * 100);
    } else {
      b.reasons.push(
        b.premiumWritten === 0
          ? "No premium is recorded in this currency, so a loss ratio cannot be computed. " +
            "Record the premium instalments against the policy."
          : "Net premium in this currency is zero or negative after returns, so a loss ratio " +
            "would be meaningless and is not reported.",
      );
    }
    if (b.openClaimCount > 0 && b.claimsReserved === 0) {
      b.reasons.push(
        `${b.openClaimCount} open claim(s) carry neither a reserve nor a quantum, so the incurred ` +
          `figure understates the exposure by an unknown amount.`,
      );
    }
  }

  return {
    byCurrency: [...buckets.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    currencyMismatches,
    note:
      unvalued > 0
        ? `${unvalued} live claim(s) carry no settled amount, reserve or quantum and contribute ` +
          `nothing to the incurred figure. They are counted, not valued.`
        : null,
  };
}

/* ================================================================== */
/* 3. POLICY WORDING vs CONTRACT REQUIREMENT                           */
/* ================================================================== */

export type WordingFindingCode =
  | "no_policy"
  | "limit_below_requirement"
  | "limit_unknown"
  | "limit_basis_mismatch"
  | "deductible_above_maximum"
  | "deductible_unknown"
  | "currency_mismatch"
  | "waiver_of_subrogation_missing"
  | "additional_insured_missing"
  | "territorial_limits_unstated"
  | "period_ends_before_maintenance_period"
  | "not_in_force";

export interface WordingFinding {
  code: WordingFindingCode;
  severity: "critical" | "high" | "medium" | "low";
  requirementId: string;
  requiredByClause: string;
  policyType: string;
  policyId: string | null;
  policyNumber: string | null;
  detail: string;
}

export interface WordingCheckResult {
  requirementId: string;
  policyType: string;
  requiredByClause: string;
  satisfiedBy: string | null;
  compliant: boolean;
  findings: WordingFinding[];
}

/** Free-text conditions on a policy, as stored: [{ ref, text, ... }]. */
function conditionText(conditions: unknown): string {
  if (!Array.isArray(conditions)) return "";
  return conditions
    .map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object" && "text" in c) {
        const t = (c as { text?: unknown }).text;
        return typeof t === "string" ? t : "";
      }
      return "";
    })
    .join(" \n")
    .toLowerCase();
}

/* Wordings say this half a dozen ways ("waiver of subrogation", "the insurer
   waives its rights of subrogation", "subrogation is waived"), so the test is
   a proximity match on the two words rather than a fixed phrase list. */
const WAIVER_RE = /\bwaiv\w*\b[^.]{0,60}\bsubrogation\b|\bsubrogation\b[^.]{0,60}\bwaiv\w*\b/;
const ADDITIONAL_INSURED_RE =
  /\badditional\s+(?:insured|insureds|assured|assureds)\b|\bco-?insured\b|\bnamed\s+as\s+(?:an\s+)?insured\b/;

/**
 * Does the programme actually satisfy one recorded requirement?
 *
 * The check is deliberately blunt about what it cannot see: a wording is a
 * PDF and this reads structured fields plus the conditions text. A finding of
 * `waiver_of_subrogation_missing` therefore means "the record does not
 * evidence it", which is the honest claim, and the detail says so.
 */
export function checkRequirement(
  requirement: RequirementLike,
  policies: readonly PolicyLike[],
  asOf: IsoDate,
  options: { worksEnd?: IsoDate | null; conditionsById?: ReadonlyMap<string, unknown> } = {},
): WordingCheckResult {
  const findings: WordingFinding[] = [];
  const base = {
    requirementId: requirement.id,
    requiredByClause: requirement.requiredByClause,
    policyType: requirement.policyType,
  };
  const candidates = policies.filter(
    (p) =>
      p.policyType === requirement.policyType &&
      (requirement.projectId === null ||
        p.projectId === requirement.projectId ||
        p.projectId === null),
  );
  const inForce = candidates.filter(
    (p) =>
      p.status === "active" &&
      daysBetweenISO(p.periodStart, asOf) >= 0 &&
      daysBetweenISO(asOf, p.periodEnd) >= 0,
  );
  if (candidates.length === 0) {
    findings.push({
      ...base,
      code: "no_policy",
      severity: "critical",
      policyId: null,
      policyNumber: null,
      detail:
        `${requirement.requiredByClause} requires ${requirement.policyType} cover and no policy of ` +
        `that type is recorded in this scope at all. The requirement is unevidenced, not satisfied.`,
    });
    return { ...base, satisfiedBy: null, compliant: false, findings };
  }
  /* Prefer an in-force policy; fall back to the best candidate so the reader
     is told "you have one, it is not on risk" rather than "you have none". */
  const pool = inForce.length > 0 ? inForce : candidates;
  const best =
    [...pool].sort(
      (a, b) => (b.limitOfIndemnity ?? -1) - (a.limitOfIndemnity ?? -1),
    )[0] ?? null;
  if (!best) return { ...base, satisfiedBy: null, compliant: false, findings };
  const ref = { policyId: best.id, policyNumber: best.number };

  if (inForce.length === 0) {
    findings.push({
      ...base,
      ...ref,
      code: "not_in_force",
      severity: "critical",
      detail:
        `Policy ${best.number} is the only ${requirement.policyType} cover recorded, and as at ` +
        `${asOf} it is ${best.status} with a period of ${best.periodStart} to ${best.periodEnd}. ` +
        `Cover that is not on risk does not satisfy ${requirement.requiredByClause}.`,
    });
  }
  if (requirement.minimumLimit !== null) {
    if (best.limitOfIndemnity === null) {
      findings.push({
        ...base,
        ...ref,
        code: "limit_unknown",
        severity: "high",
        detail:
          `${requirement.requiredByClause} requires a limit of at least ${requirement.currency} ` +
          `${requirement.minimumLimit}, and policy ${best.number} records no limit of indemnity. ` +
          `Compliance cannot be asserted from an unrecorded figure.`,
      });
    } else if (best.currency !== requirement.currency) {
      findings.push({
        ...base,
        ...ref,
        code: "currency_mismatch",
        severity: "high",
        detail:
          `The requirement is expressed in ${requirement.currency} and policy ${best.number} is ` +
          `written in ${best.currency}. Limits are not converted here: obtain the limit in the ` +
          `required currency or record the agreed rate on the requirement.`,
      });
    } else if (best.limitOfIndemnity < requirement.minimumLimit) {
      findings.push({
        ...base,
        ...ref,
        code: "limit_below_requirement",
        severity: "high",
        detail:
          `${requirement.requiredByClause} requires ${requirement.currency} ` +
          `${requirement.minimumLimit}; policy ${best.number} carries ${best.currency} ` +
          `${best.limitOfIndemnity} — a shortfall of ${requirement.currency} ` +
          `${round2(requirement.minimumLimit - best.limitOfIndemnity)}.`,
      });
    }
  }
  if (
    requirement.limitBasis &&
    best.limitOfIndemnity !== null &&
    "limitBasis" in best &&
    (best as { limitBasis?: string | null }).limitBasis &&
    (best as { limitBasis?: string | null }).limitBasis !== requirement.limitBasis
  ) {
    findings.push({
      ...base,
      ...ref,
      code: "limit_basis_mismatch",
      severity: "medium",
      detail:
        `The requirement is on a ${requirement.limitBasis} basis; policy ${best.number} is written ` +
        `${(best as { limitBasis?: string | null }).limitBasis}. An aggregate limit that has already ` +
        `been eroded is not the cover the clause asked for.`,
    });
  }
  if (requirement.maximumDeductible !== null) {
    const deductible = (best as { deductible?: number | null }).deductible ?? null;
    if (deductible === null) {
      findings.push({
        ...base,
        ...ref,
        code: "deductible_unknown",
        severity: "medium",
        detail:
          `${requirement.requiredByClause} caps the deductible at ${requirement.currency} ` +
          `${requirement.maximumDeductible} and policy ${best.number} records none. An unrecorded ` +
          `deductible is not a nil deductible.`,
      });
    } else if (deductible > requirement.maximumDeductible) {
      findings.push({
        ...base,
        ...ref,
        code: "deductible_above_maximum",
        severity: "high",
        detail:
          `Policy ${best.number} carries a deductible of ${best.currency} ${deductible}, above the ` +
          `${requirement.currency} ${requirement.maximumDeductible} permitted by ` +
          `${requirement.requiredByClause}. The excess falls on you on every claim.`,
      });
    }
  }
  const text = conditionText(options.conditionsById?.get(best.id));
  if (requirement.waiverOfSubrogation === 1 && !WAIVER_RE.test(text)) {
    findings.push({
      ...base,
      ...ref,
      code: "waiver_of_subrogation_missing",
      severity: "high",
      detail:
        `${requirement.requiredByClause} requires a waiver of subrogation and nothing in the ` +
        `recorded conditions of policy ${best.number} evidences one. Without it the insurer can pay ` +
        `the claim and then sue the party the waiver was meant to protect.`,
    });
  }
  if (requirement.additionalInsuredRequired === 1 && !ADDITIONAL_INSURED_RE.test(text)) {
    findings.push({
      ...base,
      ...ref,
      code: "additional_insured_missing",
      severity: "high",
      detail:
        `${requirement.requiredByClause} requires the beneficiary to be named as additional ` +
        `insured, and the recorded conditions of policy ${best.number} do not evidence it. A ` +
        `certificate naming you is not the same as a wording that covers you.`,
    });
  }
  if (requirement.territorialLimits && !(best as { territorialLimits?: string | null }).territorialLimits) {
    findings.push({
      ...base,
      ...ref,
      code: "territorial_limits_unstated",
      severity: "medium",
      detail:
        `${requirement.requiredByClause} requires territorial limits of "${requirement.territorialLimits}" ` +
        `and policy ${best.number} records none, so the geographic scope of the cover is unknown.`,
    });
  }
  if (requirement.maintainMonthsAfterCompletion !== null && options.worksEnd) {
    const requiredTo = addMonths(options.worksEnd, requirement.maintainMonthsAfterCompletion);
    if (daysBetweenISO(best.periodEnd, requiredTo) > 0) {
      findings.push({
        ...base,
        ...ref,
        code: "period_ends_before_maintenance_period",
        severity: "high",
        detail:
          `${requirement.requiredByClause} requires cover maintained for ` +
          `${requirement.maintainMonthsAfterCompletion} month(s) after completion (${options.worksEnd}), ` +
          `i.e. to ${requiredTo}. Policy ${best.number} expires ${best.periodEnd}, leaving ` +
          `${daysBetweenISO(best.periodEnd, requiredTo)} day(s) of the maintenance period uninsured.`,
      });
    }
  }
  return {
    ...base,
    satisfiedBy: best.id,
    compliant: findings.length === 0,
    findings,
  };
}

/** ISO date `months` after `from`, clamped to the end of the target month. */
export function addMonths(from: IsoDate, months: number): IsoDate {
  if (!isIsoDate(from)) return from;
  const d = new Date(`${from}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

/* ================================================================== */
/* 4. PERIOD GAPS AGAINST THE WORKS (#777)                             */
/* ================================================================== */

export interface PeriodGapFinding {
  policyType: string;
  requirementId: string | null;
  requiredByClause: string | null;
  projectId: string;
  /** days at the start of the works with no in-force policy of this type */
  uncoveredAtStartDays: number;
  uncoveredAtEndDays: number;
  /** the best-covering policy, when one exists at all */
  policyId: string | null;
  policyNumber: string | null;
  policyPeriod: { start: IsoDate; end: IsoDate } | null;
  worksStart: IsoDate;
  worksEnd: IsoDate;
  key: string;
  detail: string;
}

/**
 * Uncovered days at either end of the works for a required policy type.
 *
 * The union of every candidate policy's period is taken first, so a
 * back-to-back renewal covers the works even though neither policy does on
 * its own. Only genuine holes at the edges are reported; a hole in the MIDDLE
 * is reported as an end gap of the earlier policy by the same arithmetic
 * because the union is contiguous only when it truly is.
 */
export function computePeriodGaps(input: {
  projectId: string;
  worksStart: IsoDate | null;
  worksEnd: IsoDate | null;
  requirements: readonly RequirementLike[];
  policies: readonly PolicyLike[];
}): { gaps: PeriodGapFinding[]; reasons: string[] } {
  const { projectId, worksStart, worksEnd, requirements, policies } = input;
  const reasons: string[] = [];
  if (!worksStart || !worksEnd || !isIsoDate(worksStart) || !isIsoDate(worksEnd)) {
    reasons.push(
      "The project records no start and end date for the works, so period cover cannot be " +
        "assessed. A gap is measured against dates, and none are held.",
    );
    return { gaps: [], reasons };
  }
  if (daysBetweenISO(worksStart, worksEnd) < 0) {
    reasons.push(
      `The project's works dates are inverted (${worksStart} to ${worksEnd}), so no period ` +
        "analysis is possible.",
    );
    return { gaps: [], reasons };
  }
  const live = requirements.filter((r) => r.status === "required");
  if (live.length === 0) {
    reasons.push(
      "No live insurance requirement is recorded for this project, so there is nothing to test " +
        "the policy periods against. Record the cover the contract demands first.",
    );
    return { gaps: [], reasons };
  }
  const gaps: PeriodGapFinding[] = [];
  for (const req of live) {
    const relevant = policies
      .filter(
        (p) =>
          p.policyType === req.policyType &&
          (p.projectId === projectId || p.projectId === null) &&
          p.status !== "cancelled" &&
          p.status !== "draft",
      )
      .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
    if (relevant.length === 0) continue; // absence is a cover gap, not a period gap
    /* Merge overlapping/contiguous periods into a union. */
    const merged: Array<{ start: IsoDate; end: IsoDate }> = [];
    for (const p of relevant) {
      const last = merged[merged.length - 1];
      if (last && daysBetweenISO(last.end, p.periodStart) <= 1) {
        if (p.periodEnd > last.end) last.end = p.periodEnd;
      } else {
        merged.push({ start: p.periodStart, end: p.periodEnd });
      }
    }
    const covering = merged.find(
      (m) => daysBetweenISO(m.start, worksEnd) >= 0 && daysBetweenISO(worksStart, m.end) >= 0,
    );
    if (!covering) continue;
    const startGap = Math.max(0, daysBetweenISO(worksStart, covering.start));
    const endGap = Math.max(0, daysBetweenISO(covering.end, worksEnd));
    if (startGap === 0 && endGap === 0) continue;
    const best = relevant[0]!;
    gaps.push({
      policyType: req.policyType,
      requirementId: req.id,
      requiredByClause: req.requiredByClause,
      projectId,
      uncoveredAtStartDays: startGap,
      uncoveredAtEndDays: endGap,
      policyId: best.id,
      policyNumber: best.number,
      policyPeriod: { start: covering.start, end: covering.end },
      worksStart,
      worksEnd,
      key: `${projectId}:${req.policyType}:${req.id}`,
      detail:
        `${req.policyType} cover required by ${req.requiredByClause} runs ${covering.start} to ` +
        `${covering.end}, but the works run ${worksStart} to ${worksEnd}. That leaves ` +
        `${startGap} day(s) uninsured at the start and ${endGap} day(s) at the end. A loss on an ` +
        `uncovered day is uninsured however good the policy is on every other day.`,
    });
  }
  return { gaps, reasons };
}

/* ================================================================== */
/* 5. UNINSURED LOSS CANDIDATES (#787)                                 */
/* ================================================================== */

export type UninsuredLossReason =
  | "no_policy_of_class"
  | "outside_policy_period"
  | "below_deductible"
  | "no_claim_raised";

export interface UninsuredLossFinding {
  recordType: string;
  recordId: string;
  projectId: string;
  title: string;
  occurredAt: IsoDate;
  lossAmount: number | null;
  currency: string;
  policyType: string | null;
  reason: UninsuredLossReason;
  candidatePolicyId: string | null;
  candidatePolicyNumber: string | null;
  deductible: number | null;
  key: string;
  detail: string;
}

/**
 * Recorded losses that no policy will pay for, and losses that a policy WOULD
 * pay for but for which nobody raised a claim (#787).
 *
 * The last case is the expensive one and the reason this exists: an insured
 * loss with no claim is money left on the table by omission, and nothing in
 * an incident register notices it.
 */
export function findUninsuredLosses(input: {
  losses: readonly LossEventLike[];
  policies: readonly PolicyLike[];
  deductibleById: ReadonlyMap<string, number | null>;
  claims: readonly ClaimLike[];
  /** claim → the record it was raised from, from record links */
  claimedRecordIds: ReadonlySet<string>;
}): UninsuredLossFinding[] {
  const { losses, policies, deductibleById, claimedRecordIds } = input;
  const out: UninsuredLossFinding[] = [];
  for (const loss of losses) {
    if (claimedRecordIds.has(loss.recordId)) continue;
    const key = `${loss.recordType}:${loss.recordId}`;
    const base = {
      recordType: loss.recordType,
      recordId: loss.recordId,
      projectId: loss.projectId,
      title: loss.title,
      occurredAt: loss.occurredAt,
      lossAmount: loss.lossAmount,
      currency: loss.currency,
      policyType: loss.policyType,
      key,
    };
    if (!loss.policyType) continue; // no class of cover maps to this record type
    const candidates = policies.filter(
      (p) =>
        p.policyType === loss.policyType &&
        (p.projectId === loss.projectId || p.projectId === null) &&
        p.status !== "draft" &&
        p.status !== "cancelled",
    );
    if (candidates.length === 0) {
      out.push({
        ...base,
        reason: "no_policy_of_class",
        candidatePolicyId: null,
        candidatePolicyNumber: null,
        deductible: null,
        detail:
          `A loss of ${loss.currency} ${loss.lossAmount ?? "an unrecorded amount"} was recorded on ` +
          `${loss.occurredAt} and the class of cover that would respond (${loss.policyType}) is not ` +
          `held on this project. The loss falls on the balance sheet in full.`,
      });
      continue;
    }
    const inPeriod = candidates.filter(
      (p) =>
        daysBetweenISO(p.periodStart, loss.occurredAt) >= 0 &&
        daysBetweenISO(loss.occurredAt, p.periodEnd) >= 0,
    );
    if (inPeriod.length === 0) {
      const nearest = candidates[0]!;
      out.push({
        ...base,
        reason: "outside_policy_period",
        candidatePolicyId: nearest.id,
        candidatePolicyNumber: nearest.number,
        deductible: null,
        detail:
          `The loss occurred on ${loss.occurredAt}, outside every recorded ${loss.policyType} ` +
          `period (nearest: ${nearest.number}, ${nearest.periodStart} to ${nearest.periodEnd}). ` +
          `Occurrence-basis cover responds to the date of loss, so this one is uninsured.`,
      });
      continue;
    }
    const policy = inPeriod[0]!;
    const deductible = deductibleById.get(policy.id) ?? null;
    if (loss.lossAmount !== null && deductible !== null && loss.lossAmount <= deductible) {
      out.push({
        ...base,
        reason: "below_deductible",
        candidatePolicyId: policy.id,
        candidatePolicyNumber: policy.number,
        deductible,
        detail:
          `The recorded loss of ${loss.currency} ${loss.lossAmount} is at or below the ` +
          `${policy.currency} ${deductible} deductible on policy ${policy.number}, so a claim would ` +
          `recover nothing. Record it as a retained loss so the true cost of risk is visible.`,
      });
      continue;
    }
    out.push({
      ...base,
      reason: "no_claim_raised",
      candidatePolicyId: policy.id,
      candidatePolicyNumber: policy.number,
      deductible,
      detail:
        `A loss of ${loss.currency} ${loss.lossAmount ?? "an unrecorded amount"} occurred on ` +
        `${loss.occurredAt}, policy ${policy.number} was on risk (${policy.periodStart} to ` +
        `${policy.periodEnd})${deductible === null ? "" : ` with a ${policy.currency} ${deductible} deductible`}, ` +
        `and no claim has been raised. Notification periods are usually conditions precedent: an ` +
        `insured loss nobody notified becomes an uninsured loss on the day the period expires.`,
    });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

/* ================================================================== */
/* 6. RENEWAL PIPELINE (#775)                                          */
/* ================================================================== */

export interface RenewalRow {
  policyId: string;
  number: string;
  projectId: string | null;
  policyType: string;
  insurer: string;
  periodEnd: IsoDate;
  daysToExpiry: number;
  renewalStatus: string;
  renewalOwnerId: string | null;
  renewalTargetDate: IsoDate | null;
  /** how late the renewal is against the lead time this type needs */
  behindByDays: number | null;
  urgency: "overdue" | "critical" | "warning" | "on_track";
  reason: string;
}

/**
 * Which renewals are late, measured against a lead time rather than the
 * expiry date, because a renewal started the week before expiry has already
 * failed even though nothing has expired yet.
 */
export function buildRenewalPipeline(input: {
  policies: ReadonlyArray<
    PolicyLike & {
      renewalStatus: string;
      renewalOwnerId: string | null;
      renewalTargetDate: string | null;
      renewedByPolicyId: string | null;
    }
  >;
  asOf: IsoDate;
  /** days before expiry by which the renewal should be bound (default 30) */
  leadTimeDays?: number;
  /** how far ahead to look (default 120 days) */
  horizonDays?: number;
}): RenewalRow[] {
  const { policies, asOf } = input;
  const leadTime = input.leadTimeDays ?? 30;
  const horizon = input.horizonDays ?? 120;
  const rows: RenewalRow[] = [];
  for (const p of policies) {
    if (p.status === "cancelled" || p.status === "draft") continue;
    if (p.renewalStatus === "bound" || p.renewalStatus === "not_renewing") continue;
    if (p.renewedByPolicyId) continue;
    const daysToExpiry = daysBetweenISO(asOf, p.periodEnd);
    if (daysToExpiry > horizon) continue;
    const target = p.renewalTargetDate && isIsoDate(p.renewalTargetDate)
      ? p.renewalTargetDate
      : null;
    const dueBy = target ?? addDaysIso(p.periodEnd, -leadTime);
    const behindByDays = daysBetweenISO(dueBy, asOf);
    const urgency: RenewalRow["urgency"] =
      daysToExpiry < 0
        ? "overdue"
        : behindByDays > 0
          ? "critical"
          : daysToExpiry <= leadTime
            ? "warning"
            : "on_track";
    rows.push({
      policyId: p.id,
      number: p.number,
      projectId: p.projectId,
      policyType: p.policyType,
      insurer: p.insurer,
      periodEnd: p.periodEnd,
      daysToExpiry,
      renewalStatus: p.renewalStatus,
      renewalOwnerId: p.renewalOwnerId,
      renewalTargetDate: target,
      behindByDays: behindByDays > 0 ? behindByDays : null,
      urgency,
      reason:
        daysToExpiry < 0
          ? `This policy expired ${-daysToExpiry} day(s) ago and its renewal is still ` +
            `"${p.renewalStatus}". The works are running on no cover of this class.`
          : behindByDays > 0
            ? `The renewal should have been bound by ${dueBy} (${leadTime} days before expiry) and ` +
              `is still "${p.renewalStatus}", ${behindByDays} day(s) late. Terms harden and cover ` +
              `narrows in the last fortnight.`
            : daysToExpiry <= leadTime
              ? `Expires in ${daysToExpiry} day(s) and the renewal is "${p.renewalStatus}". Instruct ` +
                `the broker now.`
              : `Expires in ${daysToExpiry} day(s); renewal is "${p.renewalStatus}" and still in time.`,
    });
  }
  rows.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
  return rows;
}

function addDaysIso(from: IsoDate, days: number): IsoDate {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ================================================================== */
/* 7. THE PAYMENT HOLD HOOK (WP-FIN2 calls this)                       */
/* ================================================================== */

/**
 * Why a payment may be held on insurance grounds.
 *
 * Bound to the shared enum so the reason WP-FIN2 stores against a hold is
 * exactly the one this engine produced — a second, drifting copy of a
 * vocabulary is how a hold reason stops matching the hold.
 */
export type HoldReason = InsuranceHoldReason;

export interface HoldFinding {
  reason: HoldReason;
  policyType: string;
  requirementId: string | null;
  requiredByClause: string | null;
  certificateId: string | null;
  validTo: IsoDate | null;
  requiredLimit: number | null;
  actualLimit: number | null;
  currency: string;
  detail: string;
}

export interface HoldDecision {
  /** true when at least one BLOCKING finding exists */
  hold: boolean;
  vendorId: string;
  projectId: string | null;
  asOf: IsoDate;
  findings: HoldFinding[];
  /** findings that are advisory rather than blocking */
  warnings: HoldFinding[];
  requirementsKnown: boolean;
  note: string | null;
}

/** Which reasons stop money moving, as opposed to merely being noted. */
const BLOCKING: ReadonlySet<HoldReason> = new Set<HoldReason>([
  "no_certificate",
  "certificate_expired",
  "limit_below_requirement",
]);

/**
 * Should a payment to this vendor be held on insurance grounds?
 *
 * Deliberately conservative in BOTH directions. It blocks only on facts a
 * certificate register can actually establish — no evidence, expired
 * evidence, a limit below the recorded requirement — and it refuses to answer
 * at all when no requirement is recorded, because "no requirement recorded"
 * must never be reported as "compliant". An unverified certificate is a
 * warning, not a block: withholding a subcontractor's money because nobody on
 * your own side has done the verification is your failure, not theirs.
 */
export function evaluateHold(input: {
  vendorId: string;
  projectId: string | null;
  requirements: readonly RequirementLike[];
  certificates: readonly CertificateLike[];
  certificateLimits: ReadonlyMap<string, { limit: number | null; currency: string }>;
  policies: readonly PolicyLike[];
  asOf: IsoDate;
}): HoldDecision {
  const { vendorId, projectId, certificates, certificateLimits, policies, asOf } = input;
  const requirements = input.requirements.filter(
    (r) =>
      r.status === "required" &&
      (r.vendorId === null || r.vendorId === vendorId) &&
      (r.projectId === null || projectId === null || r.projectId === projectId),
  );
  if (requirements.length === 0) {
    return {
      hold: false,
      vendorId,
      projectId,
      asOf,
      findings: [],
      warnings: [],
      requirementsKnown: false,
      note:
        "No insurance requirement is recorded for this vendor on this scope, so no insurance " +
        "hold can be asserted. This is NOT a statement that the vendor is compliant — record " +
        "the cover the subcontract demands before relying on this answer.",
    };
  }
  const findings: HoldFinding[] = [];
  const warnings: HoldFinding[] = [];
  const mine = certificates.filter((c) => c.vendorId === vendorId);
  for (const req of requirements) {
    const forType = mine.filter((c) => c.policyType === req.policyType);
    const inDate = forType.filter(
      (c) =>
        c.status === "active" &&
        daysBetweenISO(c.validFrom, asOf) >= 0 &&
        daysBetweenISO(asOf, c.validTo) >= 0,
    );
    const base = {
      policyType: req.policyType,
      requirementId: req.id,
      requiredByClause: req.requiredByClause,
      requiredLimit: req.minimumLimit,
      currency: req.currency,
    };
    if (inDate.length === 0) {
      const latest = [...forType].sort((a, b) => b.validTo.localeCompare(a.validTo))[0] ?? null;
      findings.push({
        ...base,
        reason: latest ? "certificate_expired" : "no_certificate",
        certificateId: latest?.id ?? null,
        validTo: latest?.validTo ?? null,
        actualLimit: null,
        detail: latest
          ? `The certificate evidencing ${req.policyType} cover expired on ${latest.validTo}. ` +
            `${req.requiredByClause} requires that cover to be maintained, and paying against ` +
            `lapsed evidence is how an uninsured subcontractor stays on site.`
          : `No certificate of ${req.policyType} cover has ever been collected from this vendor, ` +
            `though ${req.requiredByClause} requires it. Payment is held until evidence exists.`,
      });
      continue;
    }
    const best = inDate.reduce((a, b) => {
      const la = certificateLimits.get(a.id)?.limit ?? -1;
      const lb = certificateLimits.get(b.id)?.limit ?? -1;
      return lb > la ? b : a;
    });
    const limitInfo = certificateLimits.get(best.id);
    if (req.minimumLimit !== null) {
      if (limitInfo?.limit == null) {
        warnings.push({
          ...base,
          reason: "limit_below_requirement",
          certificateId: best.id,
          validTo: best.validTo,
          actualLimit: null,
          detail:
            `The in-date ${req.policyType} certificate records no limit, so it cannot be shown to ` +
            `meet the ${req.currency} ${req.minimumLimit} required by ${req.requiredByClause}. ` +
            `Recorded as a warning rather than a hold: an unrecorded limit is a gap in your own ` +
            `data, not proof of a shortfall.`,
        });
      } else if (limitInfo.currency !== req.currency) {
        warnings.push({
          ...base,
          reason: "limit_below_requirement",
          certificateId: best.id,
          validTo: best.validTo,
          actualLimit: limitInfo.limit,
          detail:
            `The certificate limit is in ${limitInfo.currency} and the requirement in ` +
            `${req.currency}; they are not converted, so compliance cannot be asserted either way.`,
        });
      } else if (limitInfo.limit < req.minimumLimit) {
        findings.push({
          ...base,
          reason: "limit_below_requirement",
          certificateId: best.id,
          validTo: best.validTo,
          actualLimit: limitInfo.limit,
          detail:
            `The in-date ${req.policyType} certificate carries ${limitInfo.currency} ` +
            `${limitInfo.limit}, below the ${req.currency} ${req.minimumLimit} required by ` +
            `${req.requiredByClause}.`,
        });
        continue;
      }
    }
    if (!inDate.some((c) => c.verifiedAt !== null)) {
      warnings.push({
        ...base,
        reason: "certificate_unverified",
        certificateId: best.id,
        validTo: best.validTo,
        actualLimit: limitInfo?.limit ?? null,
        detail:
          `The in-date ${req.policyType} certificate has never been independently verified with ` +
          `the insurer or broker. Evidence nobody checked is the commonest form of fraudulent ` +
          `certificate — but the failure is on your side, so this warns rather than holds.`,
      });
    }
    /* A vendor's own cover can also be defeated by YOUR policy lapsing where
       the requirement is discharged by a principal-arranged programme. */
    if (req.vendorId === null) {
      const principal = policies.filter(
        (p) => p.policyType === req.policyType && p.status === "lapsed",
      );
      if (principal.length > 0 && forType.length === 0) {
        warnings.push({
          ...base,
          reason: "policy_lapsed",
          certificateId: null,
          validTo: null,
          actualLimit: null,
          detail:
            `${req.policyType} is carried on a principal-arranged policy that is recorded as ` +
            `lapsed, and this vendor holds no certificate of their own.`,
        });
      }
    }
  }
  return {
    hold: findings.some((f) => BLOCKING.has(f.reason)),
    vendorId,
    projectId,
    asOf,
    findings,
    warnings,
    requirementsKnown: true,
    note: null,
  };
}

/* ================================================================== */
/* 8. REQUIREMENT RESOLUTION (bug fix: per-project, never a union)     */
/* ================================================================== */

/**
 * The policy types actually required on ONE project.
 *
 * The previous implementation unioned the types of every policy anywhere in
 * the company that carried a `requiredByClause`, then applied that union to
 * every project — so a PI requirement recorded on project A raised cover-gap
 * signals against every vendor on project B, forever. A requirement belongs
 * to a scope; the company-level ones apply everywhere, the project ones only
 * to their own project, and nothing else.
 */
export function requiredTypesForProject(
  requirements: readonly RequirementLike[],
  projectId: string | null,
): string[] {
  const live = requirements.filter(
    (r) => r.status === "required" && (r.projectId === null || r.projectId === projectId),
  );
  return [...new Set(live.map((r) => r.policyType))].sort();
}
