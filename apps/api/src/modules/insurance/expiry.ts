/**
 * Domain P — the expiry engine (spec #777-780, #792, #794).
 *
 * Pure, deterministic, dependency-free. Everything here is a function of its
 * arguments and an explicit `asOf` date: no clock, no database, no I/O. The
 * route layer reads rows, calls these, and turns the output into Signals and
 * Obligations — which is why this file can be unit-tested exhaustively and
 * the sweep that consumes it can stay idempotent.
 *
 * Three questions it answers, all of them about time running out:
 *
 *  1. What is about to lapse (policies, certificates, bonds) inside a window?
 *  2. Where is there a *hole* — a vendor performing work with no in-date
 *     evidence of a policy type the contract requires (#778, supply-chain
 *     cover gap analysis)?
 *  3. Which bonds are past the last date a demand can be made (#794)? That
 *     date, not expiry, is the one that kills the security.
 *
 * Honesty rule carried through the whole file: a figure that cannot be
 * computed is reported as `null` with a reason, never defaulted to zero. A
 * cover gap cannot be asserted when no cover requirement is recorded, so
 * `requirementsKnown: false` is returned rather than an empty gap list that
 * would read as "all clear".
 */

/** ISO calendar date, `YYYY-MM-DD` — the wire format for every date here. */
export type IsoDate = string;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Policy statuses that mean cover is on risk right now. */
export const POLICY_IN_FORCE_STATUSES = ["active"] as const;

/** Bond statuses that mean the security is still callable. */
export const BOND_LIVE_STATUSES = ["issued", "active"] as const;

/** Certificate statuses that mean the evidence is still being relied on. */
export const CERTIFICATE_LIVE_STATUSES = ["active"] as const;

/* ------------------------------------------------------------------ */
/* Row shapes (structural — real drizzle rows satisfy these)           */
/* ------------------------------------------------------------------ */

export interface PolicyLike {
  id: string;
  number: string;
  projectId: string | null;
  policyType: string;
  insurer: string;
  policyNumber: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  status: string;
  limitOfIndemnity: number | null;
  currency: string;
  requiredByClause: string | null;
}

export interface CertificateLike {
  id: string;
  projectId: string | null;
  policyId: string | null;
  vendorId: string | null;
  subjectName: string;
  policyType: string;
  validFrom: IsoDate;
  validTo: IsoDate;
  status: string;
  verifiedAt: string | null;
}

export interface BondLike {
  id: string;
  number: string;
  projectId: string | null;
  bondType: string;
  guarantor: string;
  principalVendorId: string | null;
  amount: number;
  currency: string;
  status: string;
  expiryAt: IsoDate | null;
  demandDeadline: IsoDate | null;
  reductionSchedule: unknown;
}

/** A party actually performing work, and how we know that. */
export interface VendorAtWork {
  vendorId: string;
  vendorName: string;
  projectId: string | null;
  /** the independent trace that puts this vendor on the works */
  source: "workers_on_site" | "bond_principal";
}

/* ------------------------------------------------------------------ */
/* Date primitives                                                     */
/* ------------------------------------------------------------------ */

export function isIsoDate(value: unknown): value is IsoDate {
  return (
    typeof value === "string" &&
    ISO_DATE_RE.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  );
}

/** Whole days from `from` to `to` (UTC, date-only). Negative = `to` is past. */
export function daysBetweenISO(from: IsoDate, to: IsoDate): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

/** ISO date `days` after `from` (negative subtracts). */
export function addDays(from: IsoDate, days: number): IsoDate {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Policies (#777 — policy period versus contract period)              */
/* ------------------------------------------------------------------ */

export interface PolicyExpiry {
  policyId: string;
  number: string;
  projectId: string | null;
  policyType: string;
  insurer: string;
  policyNumber: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  daysRemaining: number;
  status: string;
  limitOfIndemnity: number | null;
  currency: string;
}

function toPolicyExpiry(p: PolicyLike, asOf: IsoDate): PolicyExpiry {
  return {
    policyId: p.id,
    number: p.number,
    projectId: p.projectId,
    policyType: p.policyType,
    insurer: p.insurer,
    policyNumber: p.policyNumber,
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    daysRemaining: daysBetweenISO(asOf, p.periodEnd),
    status: p.status,
    limitOfIndemnity: p.limitOfIndemnity,
    currency: p.currency,
  };
}

/**
 * Expiry is DERIVED, never typed: a policy whose period has ended is expired
 * whatever the stored status says. This is the single source of truth the
 * sweep uses to flip the stored status, so a stale row and a fresh read agree.
 */
export function derivePolicyStatus(p: PolicyLike, asOf: IsoDate): string {
  if (!POLICY_IN_FORCE_STATUSES.includes(p.status as "active")) return p.status;
  if (!isIsoDate(p.periodEnd)) return p.status;
  return daysBetweenISO(asOf, p.periodEnd) < 0 ? "expired" : p.status;
}

/** In-force policies whose period ends inside `[asOf, asOf + windowDays]`. */
export function policiesExpiringWithin(
  policies: readonly PolicyLike[],
  asOf: IsoDate,
  windowDays: number,
): PolicyExpiry[] {
  return policies
    .filter(
      (p) =>
        POLICY_IN_FORCE_STATUSES.includes(p.status as "active") &&
        isIsoDate(p.periodEnd) &&
        daysBetweenISO(asOf, p.periodEnd) >= 0 &&
        daysBetweenISO(asOf, p.periodEnd) <= windowDays,
    )
    .map((p) => toPolicyExpiry(p, asOf))
    .sort((a, b) => a.daysRemaining - b.daysRemaining);
}

/**
 * Policies still recorded as in force whose period has already ended — the
 * lapse the sweep raises `policy_lapsed_during_works` on.
 */
export function lapsedPolicies(policies: readonly PolicyLike[], asOf: IsoDate): PolicyExpiry[] {
  return policies
    .filter(
      (p) =>
        POLICY_IN_FORCE_STATUSES.includes(p.status as "active") &&
        isIsoDate(p.periodEnd) &&
        daysBetweenISO(asOf, p.periodEnd) < 0,
    )
    .map((p) => toPolicyExpiry(p, asOf))
    .sort((a, b) => a.daysRemaining - b.daysRemaining);
}

/**
 * Policy-period versus works-period gap (#777). A period that starts after
 * the works start, or ends before they finish, leaves an uninsured window —
 * returns the two windows in days, `null` where the works dates are unknown.
 */
export interface PeriodGap {
  uncoveredAtStartDays: number | null;
  uncoveredAtEndDays: number | null;
  covered: boolean | null;
}

export function policyPeriodGap(
  p: PolicyLike,
  worksStart: IsoDate | null,
  worksEnd: IsoDate | null,
): PeriodGap {
  const startGap =
    worksStart && isIsoDate(worksStart) && isIsoDate(p.periodStart)
      ? Math.max(0, daysBetweenISO(worksStart, p.periodStart))
      : null;
  const endGap =
    worksEnd && isIsoDate(worksEnd) && isIsoDate(p.periodEnd)
      ? Math.max(0, daysBetweenISO(p.periodEnd, worksEnd))
      : null;
  const covered = startGap === null && endGap === null ? null : startGap === 0 && endGap === 0;
  return { uncoveredAtStartDays: startGap, uncoveredAtEndDays: endGap, covered };
}

/* ------------------------------------------------------------------ */
/* Certificates (#780 — collection and expiry automation)              */
/* ------------------------------------------------------------------ */

export interface CertificateExpiry {
  certificateId: string;
  projectId: string | null;
  policyId: string | null;
  vendorId: string | null;
  subjectName: string;
  policyType: string;
  validFrom: IsoDate;
  validTo: IsoDate;
  daysRemaining: number;
  status: string;
  verified: boolean;
}

function toCertificateExpiry(c: CertificateLike, asOf: IsoDate): CertificateExpiry {
  return {
    certificateId: c.id,
    projectId: c.projectId,
    policyId: c.policyId,
    vendorId: c.vendorId,
    subjectName: c.subjectName,
    policyType: c.policyType,
    validFrom: c.validFrom,
    validTo: c.validTo,
    daysRemaining: daysBetweenISO(asOf, c.validTo),
    status: c.status,
    verified: c.verifiedAt !== null,
  };
}

export function certificatesExpiringWithin(
  certificates: readonly CertificateLike[],
  asOf: IsoDate,
  windowDays: number,
): CertificateExpiry[] {
  return certificates
    .filter(
      (c) =>
        CERTIFICATE_LIVE_STATUSES.includes(c.status as "active") &&
        isIsoDate(c.validTo) &&
        daysBetweenISO(asOf, c.validTo) >= 0 &&
        daysBetweenISO(asOf, c.validTo) <= windowDays,
    )
    .map((c) => toCertificateExpiry(c, asOf))
    .sort((a, b) => a.daysRemaining - b.daysRemaining);
}

/** Certificates still relied on whose validity has already ended. */
export function expiredCertificates(
  certificates: readonly CertificateLike[],
  asOf: IsoDate,
): CertificateExpiry[] {
  return certificates
    .filter(
      (c) =>
        CERTIFICATE_LIVE_STATUSES.includes(c.status as "active") &&
        isIsoDate(c.validTo) &&
        daysBetweenISO(asOf, c.validTo) < 0,
    )
    .map((c) => toCertificateExpiry(c, asOf))
    .sort((a, b) => a.daysRemaining - b.daysRemaining);
}

/** Is this certificate evidence of cover in force on `asOf`? */
export function isCertificateInDate(c: CertificateLike, asOf: IsoDate): boolean {
  if (!CERTIFICATE_LIVE_STATUSES.includes(c.status as "active")) return false;
  if (!isIsoDate(c.validFrom) || !isIsoDate(c.validTo)) return false;
  return daysBetweenISO(c.validFrom, asOf) >= 0 && daysBetweenISO(asOf, c.validTo) >= 0;
}

/* ------------------------------------------------------------------ */
/* Cover gaps across the supply chain (#778)                           */
/* ------------------------------------------------------------------ */

export type CoverGapReason =
  | "no_certificate"
  | "expired"
  | "not_yet_effective"
  | "unverified";

export interface CoverGap {
  vendorId: string;
  vendorName: string;
  projectId: string | null;
  policyType: string;
  reason: CoverGapReason;
  source: VendorAtWork["source"];
  lastCertificateId: string | null;
  lastValidTo: IsoDate | null;
  /** stable idempotency key for the signal raised from this gap */
  key: string;
}

export interface CoverGapResult {
  gaps: CoverGap[];
  /** in-date cover that nobody independent has verified (ADR 0004) */
  unverified: CoverGap[];
  requirementsKnown: boolean;
  note: string | null;
}

/** The signal-dedupe key for a gap: one per (project, vendor, policy type). */
export function coverGapKey(
  projectId: string | null,
  vendorId: string,
  policyType: string,
): string {
  return `${projectId ?? "company"}:${vendorId}:${policyType}`;
}

/**
 * A required policy type with no in-date certificate for a vendor performing
 * work. `requiredPolicyTypes` of `null` or `[]` means no cover requirement is
 * recorded anywhere — the analysis is refused rather than answered "no gaps",
 * because a silent empty list is the dangerous answer here.
 */
export function computeCoverGaps(input: {
  certificates: readonly CertificateLike[];
  vendorsAtWork: readonly VendorAtWork[];
  requiredPolicyTypes: readonly string[] | null;
  asOf: IsoDate;
}): CoverGapResult {
  const { certificates, vendorsAtWork, requiredPolicyTypes, asOf } = input;
  if (!requiredPolicyTypes || requiredPolicyTypes.length === 0) {
    return {
      gaps: [],
      unverified: [],
      requirementsKnown: false,
      note:
        "No cover requirement is recorded for this scope, so supply-chain gaps cannot be " +
        "computed. Record the policy types the contract requires (a policy carrying " +
        "requiredByClause, or an explicit requiredTypes query) before relying on this figure.",
    };
  }
  const types = [...new Set(requiredPolicyTypes)];

  // De-duplicate vendors, preferring the strongest trace of them being at work.
  const vendors = new Map<string, VendorAtWork>();
  for (const v of vendorsAtWork) {
    const key = `${v.projectId ?? "company"}:${v.vendorId}`;
    const existing = vendors.get(key);
    if (!existing || (existing.source === "bond_principal" && v.source === "workers_on_site")) {
      vendors.set(key, v);
    }
  }

  const gaps: CoverGap[] = [];
  const unverified: CoverGap[] = [];
  for (const vendor of vendors.values()) {
    for (const policyType of types) {
      const candidates = certificates.filter(
        (c) => c.vendorId === vendor.vendorId && c.policyType === policyType,
      );
      const inDate = candidates.filter((c) => isCertificateInDate(c, asOf));
      const base = {
        vendorId: vendor.vendorId,
        vendorName: vendor.vendorName,
        projectId: vendor.projectId,
        policyType,
        source: vendor.source,
        key: coverGapKey(vendor.projectId, vendor.vendorId, policyType),
      };
      if (inDate.length > 0) {
        if (!inDate.some((c) => c.verifiedAt !== null)) {
          const latest = latestByValidTo(inDate);
          unverified.push({
            ...base,
            reason: "unverified",
            lastCertificateId: latest?.id ?? null,
            lastValidTo: latest?.validTo ?? null,
          });
        }
        continue;
      }
      const latest = latestByValidTo(candidates);
      if (!latest) {
        gaps.push({ ...base, reason: "no_certificate", lastCertificateId: null, lastValidTo: null });
        continue;
      }
      const notYet =
        isIsoDate(latest.validFrom) && daysBetweenISO(asOf, latest.validFrom) > 0;
      gaps.push({
        ...base,
        reason: notYet ? "not_yet_effective" : "expired",
        lastCertificateId: latest.id,
        lastValidTo: latest.validTo,
      });
    }
  }
  gaps.sort((a, b) => a.key.localeCompare(b.key));
  unverified.sort((a, b) => a.key.localeCompare(b.key));
  return { gaps, unverified, requirementsKnown: true, note: null };
}

function latestByValidTo(certs: readonly CertificateLike[]): CertificateLike | null {
  let best: CertificateLike | null = null;
  for (const c of certs) {
    if (!best || c.validTo > best.validTo) best = c;
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Bonds (#792-794)                                                    */
/* ------------------------------------------------------------------ */

export interface ReductionStep {
  trigger: string;
  reducesToPercent: number;
  occurredAt: IsoDate | null;
}

export interface ParsedSchedule {
  steps: ReductionStep[];
  /** entries that were not a usable reduction step — reported, never ignored */
  unparsable: number;
}

export function parseReductionSchedule(raw: unknown): ParsedSchedule {
  if (!Array.isArray(raw)) return { steps: [], unparsable: 0 };
  const steps: ReductionStep[] = [];
  let unparsable = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      unparsable += 1;
      continue;
    }
    const e = entry as Record<string, unknown>;
    const trigger = typeof e["trigger"] === "string" ? e["trigger"] : null;
    const pct = typeof e["reducesToPercent"] === "number" ? e["reducesToPercent"] : null;
    if (trigger === null || pct === null || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      unparsable += 1;
      continue;
    }
    const occurred = isIsoDate(e["occurredAt"]) ? (e["occurredAt"] as IsoDate) : null;
    steps.push({ trigger, reducesToPercent: pct, occurredAt: occurred });
  }
  return { steps, unparsable };
}

export interface BondExposure {
  faceAmount: number;
  currentAmount: number;
  appliedPercent: number;
  applied: ReductionStep[];
  pending: ReductionStep[];
  unparsableSteps: number;
}

/**
 * Bond value after milestone reductions (#793). A reduction bites only when
 * its trigger is recorded as having occurred on or before `asOf`; the lowest
 * such percentage governs, because reductions step down, they do not stack.
 */
export function bondCurrentExposure(bond: BondLike, asOf: IsoDate): BondExposure {
  const { steps, unparsable } = parseReductionSchedule(bond.reductionSchedule);
  const applied = steps.filter(
    (s) => s.occurredAt !== null && daysBetweenISO(s.occurredAt, asOf) >= 0,
  );
  const pending = steps.filter((s) => !applied.includes(s));
  const appliedPercent = applied.reduce((min, s) => Math.min(min, s.reducesToPercent), 100);
  return {
    faceAmount: round2(bond.amount),
    currentAmount: round2((bond.amount * appliedPercent) / 100),
    appliedPercent,
    applied,
    pending,
    unparsableSteps: unparsable,
  };
}

export interface BondDeadline {
  bondId: string;
  number: string;
  projectId: string | null;
  bondType: string;
  guarantor: string;
  principalVendorId: string | null;
  amount: number;
  currentAmount: number;
  currency: string;
  status: string;
  expiryAt: IsoDate | null;
  demandDeadline: IsoDate | null;
  daysRemaining: number | null;
}

function toBondDeadline(b: BondLike, asOf: IsoDate, date: IsoDate | null): BondDeadline {
  return {
    bondId: b.id,
    number: b.number,
    projectId: b.projectId,
    bondType: b.bondType,
    guarantor: b.guarantor,
    principalVendorId: b.principalVendorId,
    amount: round2(b.amount),
    currentAmount: bondCurrentExposure(b, asOf).currentAmount,
    currency: b.currency,
    status: b.status,
    expiryAt: b.expiryAt,
    demandDeadline: b.demandDeadline,
    daysRemaining: date && isIsoDate(date) ? daysBetweenISO(asOf, date) : null,
  };
}

/**
 * Live bonds whose last date for making a demand has passed (#794). Expiry is
 * not the operative date — many bonds die on the demand deadline weeks
 * earlier, and a demand made a day late is simply not paid.
 */
export function bondsPastDemandDeadline(
  bonds: readonly BondLike[],
  asOf: IsoDate,
): BondDeadline[] {
  return bonds
    .filter(
      (b) =>
        BOND_LIVE_STATUSES.includes(b.status as "active") &&
        isIsoDate(b.demandDeadline) &&
        daysBetweenISO(asOf, b.demandDeadline as IsoDate) < 0,
    )
    .map((b) => toBondDeadline(b, asOf, b.demandDeadline))
    .sort((a, b) => (a.daysRemaining ?? 0) - (b.daysRemaining ?? 0));
}

/** Live bonds whose demand deadline (or, absent one, expiry) is inside the window. */
export function bondsExpiringWithin(
  bonds: readonly BondLike[],
  asOf: IsoDate,
  windowDays: number,
): BondDeadline[] {
  return bonds
    .filter((b) => BOND_LIVE_STATUSES.includes(b.status as "active"))
    .map((b) => {
      const operative = isIsoDate(b.demandDeadline)
        ? (b.demandDeadline as IsoDate)
        : isIsoDate(b.expiryAt)
          ? (b.expiryAt as IsoDate)
          : null;
      return toBondDeadline(b, asOf, operative);
    })
    .filter((b) => b.daysRemaining !== null && b.daysRemaining >= 0 && b.daysRemaining <= windowDays)
    .sort((a, b) => (a.daysRemaining ?? 0) - (b.daysRemaining ?? 0));
}

/** Live bonds whose expiry date has passed (status flip, not a signal). */
export function expiredBonds(bonds: readonly BondLike[], asOf: IsoDate): BondDeadline[] {
  return bonds
    .filter(
      (b) =>
        BOND_LIVE_STATUSES.includes(b.status as "active") &&
        isIsoDate(b.expiryAt) &&
        daysBetweenISO(asOf, b.expiryAt as IsoDate) < 0,
    )
    .map((b) => toBondDeadline(b, asOf, b.expiryAt));
}

export interface DemandTimeliness {
  outOfTime: boolean;
  deadline: IsoDate | null;
  daysLate: number | null;
}

/**
 * Is a demand made on `demandDate` out of time? The whole reason the deadline
 * is tracked: a compliant demand one day late buys nothing at all.
 */
export function isDemandOutOfTime(bond: BondLike, demandDate: IsoDate): DemandTimeliness {
  if (!isIsoDate(bond.demandDeadline)) {
    return { outOfTime: false, deadline: null, daysLate: null };
  }
  const deadline = bond.demandDeadline as IsoDate;
  const late = daysBetweenISO(deadline, demandDate);
  return { outOfTime: late > 0, deadline, daysLate: late > 0 ? late : 0 };
}

/* ------------------------------------------------------------------ */
/* The whole picture                                                   */
/* ------------------------------------------------------------------ */

export interface ExpiryInput {
  asOf: IsoDate;
  windowDays: number;
  policies: readonly PolicyLike[];
  certificates: readonly CertificateLike[];
  bonds: readonly BondLike[];
  vendorsAtWork: readonly VendorAtWork[];
  requiredPolicyTypes: readonly string[] | null;
}

export interface ExpiryReport {
  asOf: IsoDate;
  windowDays: number;
  policiesExpiring: PolicyExpiry[];
  policiesLapsed: PolicyExpiry[];
  certificatesExpiring: CertificateExpiry[];
  certificatesExpired: CertificateExpiry[];
  bondsExpiring: BondDeadline[];
  bondsPastDemandDeadline: BondDeadline[];
  coverGaps: CoverGap[];
  coverUnverified: CoverGap[];
  coverRequirementsKnown: boolean;
  coverNote: string | null;
  /** everything that needs a human today, across all four detectors */
  actionableCount: number;
}

export function computeExpiryReport(input: ExpiryInput): ExpiryReport {
  const { asOf, windowDays, policies, certificates, bonds } = input;
  const cover = computeCoverGaps({
    certificates,
    vendorsAtWork: input.vendorsAtWork,
    requiredPolicyTypes: input.requiredPolicyTypes,
    asOf,
  });
  const policiesLapsedList = lapsedPolicies(policies, asOf);
  const certificatesExpiredList = expiredCertificates(certificates, asOf);
  const bondsPast = bondsPastDemandDeadline(bonds, asOf);
  return {
    asOf,
    windowDays,
    policiesExpiring: policiesExpiringWithin(policies, asOf, windowDays),
    policiesLapsed: policiesLapsedList,
    certificatesExpiring: certificatesExpiringWithin(certificates, asOf, windowDays),
    certificatesExpired: certificatesExpiredList,
    bondsExpiring: bondsExpiringWithin(bonds, asOf, windowDays),
    bondsPastDemandDeadline: bondsPast,
    coverGaps: cover.gaps,
    coverUnverified: cover.unverified,
    coverRequirementsKnown: cover.requirementsKnown,
    coverNote: cover.note,
    actionableCount:
      policiesLapsedList.length +
      certificatesExpiredList.length +
      bondsPast.length +
      cover.gaps.length,
  };
}

/* ------------------------------------------------------------------ */
/* Notification deadline arithmetic (#783)                             */
/* ------------------------------------------------------------------ */

export interface NotificationWindow {
  awareDate: IsoDate;
  notificationDays: number | null;
  notificationDueAt: IsoDate | null;
  /** null when the policy records no notification period — say so, never assume */
  note: string | null;
}

/**
 * The claim-notification deadline: `notificationDays` counted off the date the
 * insured became AWARE, not the incident date. Awareness is the trigger in
 * every standard wording, and the difference between the two is exactly where
 * claims are lost.
 */
export function computeNotificationWindow(
  awareDate: IsoDate,
  notificationDays: number | null | undefined,
): NotificationWindow {
  if (notificationDays === null || notificationDays === undefined) {
    return {
      awareDate,
      notificationDays: null,
      notificationDueAt: null,
      note:
        "The policy records no notification period, so no deadline could be computed and no " +
        "obligation was created. Read the policy wording and set notificationDays.",
    };
  }
  return {
    awareDate,
    notificationDays,
    notificationDueAt: addDays(awareDate, notificationDays),
    note: null,
  };
}

/** Was notification given after the deadline? Dates only — the deadline is end-of-day. */
export function isNotificationLate(
  notificationDueAt: IsoDate | null,
  notifiedOn: IsoDate,
): boolean {
  if (!isIsoDate(notificationDueAt)) return false;
  return daysBetweenISO(notificationDueAt as IsoDate, notifiedOn) > 0;
}
