/**
 * Shared types, vocabulary and presentational primitives for the Insurance &
 * Bonds workspace (spec Vol II Domain P / #771-797).
 *
 * Three deadlines govern this domain and the whole workspace is built to make
 * them impossible to miss:
 *
 *  · a policy's claim-notification period is normally a CONDITION PRECEDENT —
 *    late notification is fatal to the claim however good its merits (#783);
 *  · a bond demand made after the demand deadline is worthless, and that date
 *    usually falls before the bond's expiry (#794);
 *  · a cover gap is invisible until there is a loss (#778) — and it cannot be
 *    asserted at all unless the requirement set is known.
 *
 * The view-models mirror the API exactly, including every disclosure it
 * returns (`coverNote`, `limitNote`, `headroomNote`, `verificationStrength`,
 * `notificationRule.note`, `consequence`). Those strings are rendered VERBATIM
 * wherever they appear: they are the API telling the reader what a number does
 * not mean, and paraphrasing them is how an honest figure becomes a lie.
 */
import type { ReactNode } from "react";
import { ApiClientError } from "../../lib/api";
import { Card, CardBody } from "../../ui";

/* ================================= Types ================================== */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface InsuredParty {
  name: string;
  capacity?: string;
  vendorId?: string | null;
}

export interface PolicyCondition {
  ref: string;
  text: string;
  isConditionPrecedent?: boolean;
}

/** Policy row + the derived fields the API decorates it with. */
export interface PolicyRow {
  id: string;
  companyId: string;
  projectId: string | null;
  number: string;
  policyType: string;
  insurer: string;
  brokerVendorId: string | null;
  policyNumber: string;
  insuredParties: unknown;
  limitOfIndemnity: number | null;
  limitBasis: string | null;
  currency: string;
  deductible: number | null;
  deductibleBasis: string | null;
  periodStart: string;
  periodEnd: string;
  notificationDays: number | null;
  territorialLimits: string | null;
  conditions: unknown;
  requiredByClause: string | null;
  contractId: string | null;
  status: string;
  documentId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** derived — expiry is computed from periodEnd, never typed */
  derivedStatus: string;
  daysToExpiry: number;
  inForce: boolean;
}

/** The company-level list adds the owning project and the scope. */
export interface CompanyPolicyRow extends PolicyRow {
  projectName: string | null;
  scope: "project" | "company";
}

export interface NotificationRule {
  notificationDays: number | null;
  note: string;
}

export interface PolicyDetail extends PolicyRow {
  certificates?: CertificateRow[];
  claims?: ClaimRow[];
  notificationRule?: NotificationRule;
  scope?: "project" | "company";
}

export interface CertificateRow {
  id: string;
  companyId: string;
  projectId: string | null;
  policyId: string | null;
  vendorId: string | null;
  subjectName: string;
  policyType: string;
  certificateNumber: string | null;
  insurer: string | null;
  limitOfIndemnity: number | null;
  currency: string;
  validFrom: string;
  validTo: string;
  fileId: string | null;
  fileSha256: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  verificationMethod: string | null;
  status: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** derived */
  daysToExpiry: number;
  inDate: boolean;
  verified: boolean;
}

/** POST /certificates — `selfEvidenced` is reported once, at filing. */
export interface CertificateCreated extends CertificateRow {
  selfEvidenced: boolean;
}

/** POST /certificates/:id/verify — never hide these two fields. */
export interface CertificateVerified extends CertificateRow {
  independentVerification: boolean;
  verificationStrength: string;
}

export interface CertificateFileMeta {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

export interface CertificateFiled extends CertificateRow {
  file: CertificateFileMeta;
}

export interface ReductionStep {
  trigger: string;
  reducesToPercent: number;
  occurredAt: string | null;
}

export interface BondExposure {
  faceAmount: number;
  currentAmount: number;
  appliedPercent: number;
  applied: ReductionStep[];
  pending: ReductionStep[];
  unparsableSteps: number;
}

export interface BondRow {
  id: string;
  companyId: string;
  projectId: string | null;
  contractId: string | null;
  number: string;
  bondType: string;
  guarantor: string;
  bondNumber: string | null;
  principalVendorId: string | null;
  beneficiary: string | null;
  amount: number;
  currency: string;
  percentOfContract: number | null;
  /** 0/1 — an on-demand bond pays against a compliant demand, a conditional one does not */
  isOnDemand: number;
  issuedAt: string | null;
  expiryAt: string | null;
  demandDeadline: string | null;
  reductionSchedule: unknown;
  status: string;
  documentId: string | null;
  releasedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** derived */
  exposure: BondExposure;
  daysToDemandDeadline: number | null;
  daysToExpiry: number | null;
  demandStillPossible: boolean | null;
}

export interface BondCallRow {
  id: string;
  companyId: string;
  bondId: string;
  calledAt: string;
  amount: number;
  reason: string;
  evidenceRefs: Record<string, unknown>;
  outcome: string | null;
  proceedsReceivedAt: string | null;
  proceedsAmount: number | null;
  calledBy: string;
  createdAt: string;
}

export interface BondDetail extends BondRow {
  calls: BondCallRow[];
}

export interface BondCallResult {
  call: BondCallRow;
  bond: BondRow;
  daysBeforeDeadline: number | null;
}

/** The 400 body the API returns when a demand is made out of time. */
export interface OutOfTimeDetails {
  demandDeadline: string | null;
  calledAt: string;
  daysLate: number | null;
}

export interface ClaimRow {
  id: string;
  companyId: string;
  projectId: string | null;
  policyId: string;
  number: string;
  title: string;
  description: string | null;
  incidentDate: string;
  awareDate: string;
  notifiedAt: string | null;
  notificationDueAt: string | null;
  obligationId: string | null;
  quantum: number | null;
  reserve: number | null;
  currency: string;
  status: string;
  insurerRef: string | null;
  lossAdjuster: string | null;
  repudiationReason: string | null;
  settledAmount: number | null;
  settledAt: string | null;
  linkedRecords: unknown;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** derived */
  daysToNotificationDue: number | null;
  notificationOutstanding: boolean;
  notifiedLate: boolean;
}

export interface ClaimNotificationRule {
  notificationDays: number | null;
  notificationDueAt: string | null;
  obligationId: string | null;
  note: string;
}

export interface ClaimCreated extends ClaimRow {
  notificationRule: ClaimNotificationRule;
}

export interface ObligationRow {
  id: string;
  companyId: string;
  projectId: string;
  sourceClause: string;
  obligorId: string | null;
  obligeeId: string | null;
  trigger: string;
  deadline: string | null;
  warnDaysBefore: number | null;
  evidenceRequirement: string | null;
  status: string;
  satisfiedEvidenceId: string | null;
  createdBy: string;
  createdAt: string;
}

export interface ClaimDetail extends ClaimRow {
  policy: PolicyRow | null;
  obligation: ObligationRow | null;
}

/** POST /claims/:id/notify — `consequence` is rendered verbatim. */
export interface ClaimNotifyResult extends ClaimRow {
  late: boolean;
  daysLate: number | null;
  consequence: string;
}

/* ------------------------------ Expiry radar ------------------------------ */

export interface PolicyExpiry {
  policyId: string;
  number: string;
  projectId: string | null;
  policyType: string;
  insurer: string;
  policyNumber: string;
  periodStart: string;
  periodEnd: string;
  daysRemaining: number;
  status: string;
  limitOfIndemnity: number | null;
  currency: string;
}

export interface CertificateExpiry {
  certificateId: string;
  projectId: string | null;
  policyId: string | null;
  vendorId: string | null;
  subjectName: string;
  policyType: string;
  validFrom: string;
  validTo: string;
  daysRemaining: number;
  status: string;
  verified: boolean;
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
  expiryAt: string | null;
  demandDeadline: string | null;
  daysRemaining: number | null;
}

export type CoverGapReason = "no_certificate" | "expired" | "not_yet_effective" | "unverified";

export interface CoverGap {
  vendorId: string;
  vendorName: string;
  projectId: string | null;
  policyType: string;
  reason: CoverGapReason | string;
  source: "workers_on_site" | "bond_principal" | string;
  lastCertificateId: string | null;
  lastValidTo: string | null;
  key: string;
}

export interface ExpiryReport {
  asOf: string;
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
  actionableCount: number;
  scope: "project" | "company";
  projectId: string | null;
  requiredTypes: string[];
  requiredTypesSource: "query" | "policies_with_required_by_clause" | "none_recorded";
  vendorsAtWork: number;
}

/* -------------------------------- Summary --------------------------------- */

export interface CurrencyTotal {
  currency: string;
  total: number;
}

export interface CoverByType {
  policyType: string;
  required: boolean;
  policies: number;
  activePolicies: number;
  certificates: number;
  certificatesInDate: number;
  certificatesVerified: number;
  covered: boolean;
  totalLimits: CurrencyTotal[];
  policiesWithoutLimit: number;
  limitNote: string | null;
  gaps: CoverGap[];
}

export interface BondTypeExposure {
  bondType: string;
  currency: string;
  count: number;
  faceAmount: number;
  currentExposure: number;
}

export interface GuarantorExposure {
  guarantor: string;
  currency: string;
  count: number;
  faceAmount: number;
  currentExposure: number;
  bondTypes: string[];
}

export interface AggregateExposure {
  currency: string;
  count: number;
  faceAmount: number;
  currentExposure: number;
}

export interface ClaimCurrencyTotal {
  currency: string;
  claims: number;
  reserve: number | null;
  claimsWithReserve: number;
  claimsWithoutReserve: number;
  settled: number | null;
  claimsSettled: number;
}

export interface InsuranceSummary {
  scope: "project" | "company";
  companyId: string;
  projectId: string | null;
  asOf: string;
  policies: { total: number; inForce: number; companyLevel: number; expiringSoon: number };
  certificates: { total: number; inDate: number; verified: number; expiringSoon: number };
  cover: {
    requirementsKnown: boolean;
    requiredTypes: string[];
    note: string | null;
    vendorsAtWork: number;
    byType: CoverByType[];
    gaps: CoverGap[];
    unverified: CoverGap[];
  };
  bonds: {
    total: number;
    outstanding: number;
    outstandingByType: BondTypeExposure[];
    byGuarantor: GuarantorExposure[];
    aggregateExposure: AggregateExposure[];
    pastDemandDeadline: number;
    called: number;
    released: number;
    note: string;
    /**
     * Bonding lines (#796). Utilisation is DERIVED from the bonds drawn
     * against each facility, never stored, and headroom is refused across
     * currencies — a bond in another currency is excluded and named rather
     * than converted at a rate nobody recorded.
     */
    facilities: {
      facilityId: string;
      number: string;
      name: string;
      provider: string;
      currency: string;
      limitAmount: number;
      drawnAmount: number;
      headroom: number | null;
      utilisationPct: number | null;
      bondCount: number;
      excludedForeignCurrency: { bondId: string; currency: string; amount: number }[];
      outsidePermittedTypes: string[];
      inForce: boolean | null;
      daysToReview: number | null;
      reasons: string[];
    }[];
    headroomNote: string;
  };
  claims: {
    total: number;
    byStatus: Record<string, number>;
    totals: ClaimCurrencyTotal[];
    notificationsOutstanding: number;
    notificationsMissed: number;
    notificationDeadlineUnknown: number;
    note: string | null;
  };
  obligations: { open: number; satisfied: number; breached: number; total: number };
  signals: { total: number; open: number; byDetector: Record<string, number> };
}

export interface VendorLite {
  id: string;
  name: string;
}

/**
 * A jump from the radar into the register that owns the record. `nonce` makes
 * two jumps to the same record distinguishable so the target tab re-opens.
 */
export interface FocusRequest {
  recordId?: string | null;
  vendorId?: string | null;
  nonce: number;
}

/* =============================== Vocabulary =============================== */

export const POLICY_TYPE_LABELS: Record<string, string> = {
  contractors_all_risks: "Contractors' all risks",
  erection_all_risks: "Erection all risks",
  third_party_liability: "Third-party liability",
  professional_indemnity: "Professional indemnity",
  employers_liability: "Employers' liability",
  marine_cargo: "Marine cargo",
  delay_in_startup: "Delay in start-up",
  contractors_plant: "Contractors' plant",
  environmental_impairment: "Environmental impairment",
  decennial: "Decennial",
  other: "Other",
};

export const BOND_TYPE_LABELS: Record<string, string> = {
  performance: "Performance bond",
  advance_payment: "Advance payment bond",
  retention: "Retention bond",
  bid: "Bid bond",
  warranty: "Warranty bond",
  payment: "Payment bond",
  customs: "Customs bond",
  parent_company_guarantee: "Parent company guarantee",
};

export const CLAIM_STATUS_LABELS: Record<string, string> = {
  notified: "Notified",
  acknowledged: "Acknowledged",
  under_assessment: "Under assessment",
  accepted: "Accepted",
  repudiated: "Repudiated",
  settled: "Settled",
  withdrawn: "Withdrawn",
};

export const VERIFICATION_METHODS = [
  "insurer_confirmation",
  "broker_confirmation",
  "document_review",
  "portal_check",
  "other",
] as const;

export const VERIFICATION_METHOD_LABELS: Record<string, string> = {
  insurer_confirmation: "Insurer confirmation",
  broker_confirmation: "Broker confirmation",
  document_review: "Document review",
  portal_check: "Portal check",
  other: "Other",
};

/**
 * What each method actually is. `insurer_confirmation` is a self-declared
 * claim about a phone call, not a machine check — the workspace says so
 * wherever a verification is offered or displayed.
 */
export const VERIFICATION_METHOD_DESCRIPTIONS: Record<string, string> = {
  insurer_confirmation:
    "Someone says they confirmed the cover with the insurer. This is a self-declared account of a conversation, not a machine-checked fact — it is the strongest evidence available here, and it is still hearsay recorded by a colleague.",
  broker_confirmation:
    "Someone says they confirmed the cover with the placing broker. Self-declared, and one step further from the insurer than an insurer confirmation.",
  document_review:
    "Someone read the certificate. A certificate is a summary written for the insured — it is not the policy and it does not prove the policy is still on risk.",
  portal_check:
    "Someone looked the cover up in an insurer or broker portal. Recorded as a self-declared check; the platform did not make the request.",
  other: "Some other method, recorded as free text. The platform makes no claim about its strength.",
};

export const NOTIFICATION_METHODS = ["email", "letter", "portal", "broker", "telephone"] as const;

export const BOND_CALL_OUTCOMES = [
  "pending",
  "paid",
  "partially_paid",
  "rejected",
  "withdrawn",
] as const;

export const BOND_CALL_OUTCOME_LABELS: Record<string, string> = {
  pending: "Pending",
  paid: "Paid",
  partially_paid: "Partially paid",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

export const LIMIT_BASES = ["per_occurrence", "in_the_aggregate"] as const;

export const LIMIT_BASIS_LABELS: Record<string, string> = {
  per_occurrence: "Per occurrence",
  in_the_aggregate: "In the aggregate",
};

export const CERTIFICATE_STATUSES = ["active", "expired", "superseded", "withdrawn"] as const;

export const COVER_GAP_REASON_LABELS: Record<string, string> = {
  no_certificate: "No certificate on file",
  expired: "Certificate expired",
  not_yet_effective: "Certificate not yet effective",
  unverified: "In date but never independently verified",
};

export const COVER_GAP_REASON_DETAIL: Record<string, string> = {
  no_certificate:
    "This party is performing work and there is no certificate at all for a policy type the requirement set demands.",
  expired:
    "The most recent certificate for this party and policy type has run out. Work is continuing against evidence that has expired.",
  not_yet_effective:
    "The certificate on file starts in the future — the party is at work now, and the evidence covers a period that has not begun.",
  unverified:
    "There is in-date evidence, but nobody independent of the party who submitted it has confirmed it is genuine.",
};

export const VENDOR_SOURCE_LABELS: Record<string, string> = {
  workers_on_site: "workers on site",
  bond_principal: "principal under a live bond",
};

export const REQUIRED_TYPES_SOURCE_TEXT: Record<string, string> = {
  query:
    "The requirement set came from the policy types you selected in this view — it is your assertion for this query, not a recorded contractual requirement.",
  policies_with_required_by_clause:
    "The requirement set was derived from policies that record a requiredByClause: the cover the contract demands of this party is taken to be the cover its supply chain must evidence too.",
  none_recorded:
    "No cover requirement is recorded anywhere in this scope, so no requirement set exists to test against.",
};

export const DETECTOR_LABELS: Record<string, string> = {
  insurance_certificate_expired: "Certificate expired",
  insurance_cover_gap: "Cover gap",
  bond_demand_deadline_passed: "Bond demand deadline passed",
  policy_lapsed_during_works: "Policy lapsed during works",
  insurance_notification_missed: "Claim notification missed",
};

/* --------------------------- Transition tables ---------------------------- */
/* Mirrored from the API so the UI never offers a transition the server will
 * refuse. `expired` is absent on purpose in both tables: expiry is derived
 * from the recorded period, never typed. */

export const POLICY_TRANSITIONS: Record<string, string[]> = {
  draft: ["active", "cancelled"],
  active: ["lapsed", "cancelled"],
  lapsed: ["active", "cancelled"],
  expired: [],
  cancelled: [],
};

/** Plain status transitions only — call, release and expiry have their own routes. */
export const BOND_STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ["issued"],
  issued: ["active"],
  active: [],
  called: [],
  released: [],
  expired: [],
};

export const CLAIM_TRANSITIONS: Record<string, string[]> = {
  notified: ["acknowledged", "withdrawn"],
  acknowledged: ["under_assessment", "withdrawn"],
  under_assessment: ["accepted", "repudiated", "withdrawn"],
  accepted: ["settled", "withdrawn"],
  repudiated: [],
  settled: [],
  withdrawn: [],
};

/* ================================ Formats ================================= */

export function policyTypeLabel(t: string): string {
  return POLICY_TYPE_LABELS[t] ?? t;
}

export function bondTypeLabel(t: string): string {
  return BOND_TYPE_LABELS[t] ?? t;
}

export function fmtMoney(
  value: number | null | undefined,
  currency?: string | null,
  dp = 2,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "GBP",
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    }).format(value);
  } catch {
    return `${currency ?? ""} ${new Intl.NumberFormat(undefined, {
      maximumFractionDigits: dp,
    }).format(value)}`.trim();
  }
}

export function fmtNum(value: number | null | undefined, dp = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: dp }).format(value);
}

export function fmtPct(value: number | null | undefined, dp = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: dp }).format(value)}%`;
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (UTC, date-only). Negative = `to` is past. */
export function daysBetweenIso(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

export function addDaysIso(from: string, days: number): string | null {
  const t = Date.parse(`${from}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysWord(days: number): string {
  const n = Math.abs(days);
  return `${n} day${n === 1 ? "" : "s"}`;
}

/* ================================= Errors ================================= */

export function errMsg(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

/** The `details` object the API attaches to an out-of-time demand refusal. */
export function outOfTimeDetails(err: unknown): OutOfTimeDetails | null {
  if (!(err instanceof ApiClientError)) return null;
  const body = err.details as { details?: unknown } | null | undefined;
  const d = body && typeof body === "object" ? (body.details as Record<string, unknown>) : null;
  if (!d || typeof d !== "object") return null;
  const deadline = d["demandDeadline"];
  const calledAt = d["calledAt"];
  if (typeof calledAt !== "string") return null;
  const daysLate = d["daysLate"];
  return {
    demandDeadline: typeof deadline === "string" ? deadline : null,
    calledAt,
    daysLate: typeof daysLate === "number" ? daysLate : null,
  };
}

/* ================================= Tones ================================== */

export function policyTone(derivedStatus: string): string {
  switch (derivedStatus) {
    case "active":
      return "green";
    case "draft":
      return "gray";
    case "lapsed":
      return "red";
    case "expired":
      return "amber";
    case "cancelled":
      return "gray";
    default:
      return "gray";
  }
}

export function certificateTone(c: { status: string; inDate: boolean }): string {
  if (c.status !== "active") return "gray";
  return c.inDate ? "green" : "red";
}

export function bondTone(status: string): string {
  switch (status) {
    case "active":
    case "issued":
      return "green";
    case "called":
      return "violet";
    case "released":
      return "gray";
    case "expired":
      return "amber";
    default:
      return "gray"; // draft
  }
}

export function claimTone(status: string): string {
  switch (status) {
    case "notified":
      return "blue";
    case "acknowledged":
    case "under_assessment":
      return "amber";
    case "accepted":
      return "green";
    case "settled":
      return "green";
    case "repudiated":
      return "red";
    default:
      return "gray"; // withdrawn
  }
}

export function callOutcomeTone(outcome: string | null): string {
  switch (outcome) {
    case "paid":
      return "green";
    case "partially_paid":
      return "amber";
    case "rejected":
      return "red";
    case "withdrawn":
      return "gray";
    default:
      return "blue"; // pending
  }
}

/* ============================= Chart palette ============================== */

/** One palette for every hand-rolled chart here, so the workspace reads as one system. */
export const CHART = {
  brand900: "#19398d",
  brand700: "#164bde",
  brand600: "#1d60f1",
  brand400: "#59a1ff",
  brand200: "#bcdaff",
  brand50: "#eef6ff",
  ink100: "#ebedf1",
  ink200: "#d3d8e0",
  ink300: "#acb6c5",
  ink400: "#7f8ea4",
  ink600: "#4b5a72",
  amber: "#d97706",
  amber200: "#fde68a",
  emerald: "#059669",
  red: "#dc2626",
  red900: "#7f1d1d",
  violet: "#7c3aed",
} as const;

/* =========================== JSON field parsing =========================== */

export function parseInsuredParties(raw: unknown): InsuredParty[] {
  if (!Array.isArray(raw)) return [];
  const out: InsuredParty[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e["name"] !== "string") continue;
    out.push({
      name: e["name"],
      capacity: typeof e["capacity"] === "string" ? e["capacity"] : undefined,
      vendorId: typeof e["vendorId"] === "string" ? e["vendorId"] : null,
    });
  }
  return out;
}

export function parseConditions(raw: unknown): PolicyCondition[] {
  if (!Array.isArray(raw)) return [];
  const out: PolicyCondition[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e["ref"] !== "string" || typeof e["text"] !== "string") continue;
    out.push({
      ref: e["ref"],
      text: e["text"],
      isConditionPrecedent: e["isConditionPrecedent"] === true,
    });
  }
  return out;
}

/* =============================== Components =============================== */

export function TabBar({
  tabs,
  active,
  onSelect,
}: {
  tabs: { key: string; label: string }[];
  active: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="mb-5 flex flex-wrap gap-1 border-b border-ink-200">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onSelect(t.key)}
          className={
            active === t.key
              ? "-mb-px border-b-2 border-brand-600 px-3 py-2 text-sm font-medium text-brand-700"
              : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-ink-500 hover:text-ink-800"
          }
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone,
  title,
  emphasized,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "brand" | "red" | "amber" | "green";
  title?: string;
  emphasized?: boolean;
}) {
  const valueCls =
    tone === "red"
      ? "text-red-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "green"
          ? "text-emerald-700"
          : tone === "brand"
            ? "text-brand-700"
            : "text-ink-900";
  return (
    <Card className={emphasized ? "ring-2 ring-brand-200" : undefined}>
      <CardBody className="py-3">
        <div className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-ink-400">
          <span>{label}</span>
          {title ? (
            <span
              title={title}
              aria-label={title}
              className="cursor-help rounded-full border border-ink-200 px-1 text-[9px] leading-4 text-ink-400"
            >
              ?
            </span>
          ) : null}
        </div>
        <div
          className={`mt-0.5 ${emphasized ? "text-2xl" : "text-xl"} font-semibold tabular-nums ${valueCls}`}
        >
          {value}
        </div>
        {hint ? <div className="mt-0.5 text-xs leading-4 text-ink-400">{hint}</div> : null}
      </CardBody>
    </Card>
  );
}

/** Right-hand slide-over for record detail. */
export function Drawer({
  open,
  title,
  onClose,
  children,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink-950/40">
      <div
        className={`h-full overflow-y-auto bg-white p-5 shadow-xl ${wide ? "w-full max-w-3xl" : "w-full max-w-xl"}`}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-ink-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * A disclosure returned by the API, rendered verbatim and attributed.
 *
 * These strings exist to stop a number being read as more than it is —
 * `limitNote` says a total is a floor, `headroomNote` says there is no
 * denominator, `coverNote` says gaps cannot be computed at all. They are never
 * summarised, truncated or hidden behind a toggle.
 */
export function Disclosure({
  label,
  children,
  tone = "amber",
}: {
  label: string;
  children: ReactNode;
  tone?: "amber" | "red" | "ink" | "brand";
}) {
  const cls =
    tone === "red"
      ? "bg-red-50 text-red-900 ring-red-200"
      : tone === "ink"
        ? "bg-ink-50 text-ink-700 ring-ink-200"
        : tone === "brand"
          ? "bg-brand-50 text-brand-900 ring-brand-100"
          : "bg-amber-50 text-amber-900 ring-amber-200";
  return (
    <div className={`rounded-md px-3 py-2 text-xs leading-relaxed ring-1 ${cls}`}>
      <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide opacity-70">
        {label}
      </span>
      {children}
    </div>
  );
}

/** A quiet caveat strip for figures that must not be mistaken for verified data. */
export function Caveat({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
      {children}
    </div>
  );
}

/**
 * Deadline countdown chip.
 *
 * `fatal` is for the two deadlines whose breach is normally terminal — a claim
 * notification period and a bond demand deadline. Those go black-red once
 * passed rather than the ordinary red, because nothing about them is routine.
 */
export function DeadlineChip({
  days,
  fatal,
  unknownLabel = "no deadline",
  unknownTitle,
  suffix,
}: {
  days: number | null | undefined;
  fatal?: boolean;
  unknownLabel?: string;
  unknownTitle?: string;
  suffix?: string;
}) {
  if (days === null || days === undefined) {
    return (
      <span
        title={unknownTitle}
        className="inline-flex items-center rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600 ring-1 ring-ink-200"
      >
        {unknownLabel}
      </span>
    );
  }
  const cls =
    days < 0
      ? fatal
        ? "bg-red-900 text-red-50"
        : "bg-red-100 text-red-800 ring-1 ring-red-200"
      : days <= 2
        ? "bg-red-100 text-red-800 ring-1 ring-red-200"
        : days <= 7
          ? "bg-amber-100 text-amber-800 ring-1 ring-amber-200"
          : days <= 30
            ? "bg-brand-50 text-brand-800 ring-1 ring-brand-100"
            : "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-100";
  const text =
    days < 0
      ? `${daysWord(days)} past`
      : days === 0
        ? "due today"
        : `${daysWord(days)} left`;
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}
    >
      {text}
      {suffix ? <span className="ml-1 font-normal opacity-80">{suffix}</span> : null}
    </span>
  );
}

/** Label/value pair used across the detail drawers. */
export function DetailRow({
  label,
  children,
  title,
}: {
  label: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-3 border-b border-ink-50 py-1.5 text-sm last:border-0">
      <span className="text-xs font-medium uppercase tracking-wide text-ink-400" title={title}>
        {label}
      </span>
      <span className="text-ink-800">{children}</span>
    </div>
  );
}

export function SectionTitle({
  children,
  hint,
}: {
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="mb-2 mt-5 first:mt-0">
      <h3 className="text-sm font-semibold text-ink-900">{children}</h3>
      {hint ? <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{hint}</p> : null}
    </div>
  );
}

/** A confirmation strip for an action that cannot be undone. */
export function ConfirmStrip({
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  busy,
}: {
  message: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <div className="rounded-md bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-900 ring-1 ring-red-200">
      <div>{message}</div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="rounded bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-60"
        >
          {busy ? "Working…" : confirmLabel}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded bg-white px-2.5 py-1 text-xs font-medium text-ink-700 ring-1 ring-ink-200 hover:bg-ink-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Pagination footer shared by the registers. */
export function Pager({
  page,
  total,
  pageSize,
  noun,
  onPage,
}: {
  page: number;
  total: number;
  pageSize: number;
  noun: string;
  onPage: (p: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
      <span>
        {total} {noun}
        {total === 1 ? "" : "s"} · page {page} of {totalPages}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(Math.max(1, page - 1))}
          className="rounded-md bg-white px-2.5 py-1.5 text-xs font-medium text-ink-800 ring-1 ring-ink-200 hover:bg-ink-50 disabled:opacity-50"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
          className="rounded-md bg-white px-2.5 py-1.5 text-xs font-medium text-ink-800 ring-1 ring-ink-200 hover:bg-ink-50 disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}
