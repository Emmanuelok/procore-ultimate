/**
 * Shared vocabulary for the INVOICING workspace (module M6).
 *
 * Billing runs in both directions off the same schedule of values: owner
 * applications for payment against a prime contract, and subcontractor
 * invoices against a commitment. One table, one discriminator, the same AIA
 * G702/G703 arithmetic — and two workflows that differ only in who signs.
 *
 * FIVE CONTROLS this workspace exists to make visible, all of them enforced by
 * the API rather than by this screen:
 *
 *   1. A closed billing period takes no new billing; a locked one takes no
 *      writes at all. That is what makes a monthly cost report reproducible.
 *   2. Billing past a schedule-of-values line is refused, with the overage
 *      named to the cent.
 *   3. Retainage moves only through an approved release, approved by someone
 *      who is neither its author nor its requester.
 *   4. Paying an invoice whose required lien waiver is not on file is refused;
 *      overriding it records the payment ON HOLD and leaves the exposure on
 *      the outstanding-waiver report.
 *   5. The approver is never the author or the submitter, and a rejection
 *      always carries a reason.
 *
 * MONEY DISCIPLINE. Figures in different currencies are never summed. Every
 * report returns per-currency buckets and this workspace renders them as
 * separate blocks — there is no exchange rate on any of these records, and
 * inventing one would be fabrication.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiClientError, api } from "../../lib/api";
import { Alert, Badge, Card, CardBody, Skeleton } from "../../ui";
import type { Tone } from "../../ui/tokens";

/* ============================================================================
   Wire shapes — mirrored from apps/api/src/modules/invoicing
============================================================================ */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** `{ value, reasons }` — a figure the platform could not derive. */
export interface Unknowable<T = number> {
  value: T | null;
  reasons: string[];
}

export interface ReconciliationCheck {
  identity: string;
  left: number;
  right: number;
  delta: number;
  ok: boolean;
}

export interface BillingPeriodRow {
  id: string;
  projectId: string;
  number: number;
  reference: string;
  name: string;
  status: "open" | "closed" | "locked" | string;
  startDate: string;
  endDate: string;
  billingDate: string;
  subcontractorSubmitStart: string | null;
  subcontractorSubmitEnd: string | null;
  ownerBillingDate: string | null;
  dueDate: string | null;
  ownerBilledAmount: number;
  subcontractorBilledAmount: number;
  retainageHeldAmount: number;
  retainageReleasedAmount: number;
  invoiceCount: number;
  closedAt: string | null;
  closedBy: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CurrentPeriodResponse {
  period: BillingPeriodRow | null;
  openCount: number;
  reasons: string[];
}

export interface PeriodInvoiceSummary {
  id: string;
  kind: string;
  reference: string;
  status: string;
  currency: string;
  vendorId: string | null;
  totalCompletedAndStored: number;
  totalRetainage: number;
  currentPaymentDue: number;
  amountPaid: number;
}

export interface PeriodDetail extends BillingPeriodRow {
  invoices: PeriodInvoiceSummary[];
}

export type InvoiceKind = "owner_billing" | "subcontractor_invoice";

export interface InvoiceRow {
  id: string;
  projectId: string;
  kind: InvoiceKind | string;
  number: number;
  reference: string;
  title: string | null;
  status: string;
  primeContractId: string | null;
  commitmentId: string | null;
  vendorId: string | null;
  billingPeriodId: string | null;
  invoiceNumber: string | null;
  currency: string;
  billingDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  dueDate: string | null;
  receivedDate: string | null;
  originalContractSum: number;
  netChangeOrders: number;
  revisedContractSum: number;
  completedToDate: number;
  storedMaterials: number;
  totalCompletedAndStored: number;
  retainagePercentWork: number;
  retainageWork: number;
  retainagePercentMaterials: number;
  retainageMaterials: number;
  totalRetainage: number;
  retainageReleased: number;
  totalEarnedLessRetainage: number;
  previousPaymentsAmount: number;
  currentPaymentDue: number;
  balanceToFinishPlusRetainage: number;
  subtotal: number;
  taxAmount: number;
  total: number;
  amountPaid: number;
  paidDate: string | null;
  reviewNotes: string | null;
  rejectionReason: string | null;
  requiresLienWaiver: number;
  lienWaiverStatus: string | null;
  detail: Record<string, unknown>;
  createdBy: string;
  submittedBy: string | null;
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceLineRow {
  id: string;
  invoiceId: string;
  lineNumber: string;
  sortOrder: number;
  primeContractSovLineId: string | null;
  commitmentSovLineId: string | null;
  costCode: string | null;
  costType: string | null;
  budgetLineItemId: string | null;
  description: string;
  source: string;
  billingMethod: string;
  unit: string | null;
  quantity: number | null;
  unitRate: number | null;
  scheduledValue: number;
  previousBilled: number;
  previousStoredMaterials: number;
  thisPeriodWork: number;
  thisPeriodStoredMaterials: number;
  materialsPresentlyStored: number;
  totalCompletedAndStored: number;
  percentComplete: number;
  balanceToFinish: number;
  retainagePercent: number;
  retainageThisPeriod: number;
  retainageHeldToDate: number;
  retainageReleased: number;
  amount: number;
  taxPercent: number | null;
  taxAmount: number;
  changeOrderPackageId: string | null;
  notes: string | null;
  detail: Record<string, unknown>;
}

export interface InvoiceDetail extends InvoiceRow {
  lines: InvoiceLineRow[];
  reconciliation: { checks: ReconciliationCheck[]; reconciles: boolean };
  outstanding: number;
}

/** The API's per-line refusal, returned in `details.issues`. */
export interface LineIssue {
  lineNumber: string;
  code:
    | "over_billed"
    | "regression_without_credit_reason"
    | "inconsistent_work_input"
    | "inconsistent_materials_input"
    | "negative_materials"
    | "release_exceeds_held"
    | string;
  message: string;
  detail: Record<string, number | string>;
}

export interface RetainageReleaseRow {
  id: string;
  projectId: string;
  number: number;
  reference: string;
  scope: "prime_contract" | "commitment" | string;
  primeContractId: string | null;
  commitmentId: string | null;
  vendorId: string | null;
  invoiceId: string | null;
  billingPeriodId: string | null;
  status: string;
  basis: string;
  retainageHeldBefore: number;
  amount: number;
  retainageHeldAfter: number;
  newRetainagePercent: number | null;
  lines: unknown[];
  effectiveDate: string | null;
  releaseDate: string | null;
  reason: string | null;
  conditions: string | null;
  requiresLienWaiver: number;
  lienWaiverId: string | null;
  createdBy: string;
  requestedBy: string | null;
  requestedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
  /** added by the create and detail routes */
  currency?: string;
  currentlyHeld?: number;
  stillValid?: boolean;
}

export interface RetainageContractPosition {
  contractId?: string;
  commitmentId?: string;
  reference: string;
  title: string;
  vendorId?: string | null;
  currency: string;
  retainageHeld: number;
  retainageReleased: number;
}

export interface RetainageSummary {
  projectId: string;
  receivable: {
    byCurrency: Array<{
      currency: string;
      contracts: number;
      retainageHeld: number;
      retainageReleased: number;
    }>;
    contracts: RetainageContractPosition[];
  };
  payable: {
    byCurrency: Array<{
      currency: string;
      contracts: number;
      retainageHeld: number;
      retainageReleased: number;
    }>;
    commitments: RetainageContractPosition[];
  };
  pendingReleases: Array<{
    id: string;
    reference: string;
    scope: string;
    status: string;
    amount: number;
    effectiveDate: string | null;
  }>;
  note: string;
}

export interface LienWaiverRow {
  id: string;
  projectId: string;
  number: number;
  reference: string;
  waiverType: string;
  status: string;
  commitmentId: string | null;
  invoiceId: string | null;
  paymentId: string | null;
  billingPeriodId: string | null;
  vendorId: string | null;
  tier: number;
  claimantName: string | null;
  amount: number;
  currency: string;
  throughDate: string | null;
  exceptionsNoted: string | null;
  jurisdiction: string | null;
  statutoryForm: string | null;
  requestedBy: string | null;
  requestedAt: string | null;
  sentAt: string | null;
  signedAt: string | null;
  signedByName: string | null;
  receivedAt: string | null;
  verifiedAt: string | null;
  rejectionReason: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WaiverGate {
  required: boolean;
  satisfied: boolean;
  waivers: Array<{
    id: string;
    reference: string;
    waiverType: string;
    status: string;
    throughDate: string | null;
    amount: number;
    tier: number;
  }>;
  reasons: string[];
}

export interface OutstandingWaiverReport {
  asOf: string;
  projectId: string;
  exposureByCurrency: Array<{
    currency: string;
    invoices: number;
    paidWithoutWaiver: number;
    blockedFromPayment: number;
  }>;
  outstanding: Array<{
    invoiceId: string;
    reference: string;
    invoiceNumber: string | null;
    kind: string;
    status: string;
    vendorId: string | null;
    vendorName: string | null;
    commitmentId: string | null;
    currency: string;
    currentPaymentDue: number;
    amountPaid: number;
    paidUnwaived: number;
    billingDate: string | null;
    daysOutstanding: number | null;
    waivers: Array<{
      id: string;
      reference: string;
      status: string;
      waiverType: string;
      throughDate: string | null;
    }>;
    blocking: "paid_without_waiver" | "payment_blocked" | string;
  }>;
  inFlight: Array<{
    id: string;
    reference: string;
    status: string;
    waiverType: string;
    vendorId: string | null;
    vendorName: string | null;
    amount: number;
    currency: string;
    throughDate: string | null;
    tier: number;
    daysSinceRequested: number | null;
  }>;
  untieredWarning: string | null;
}

export type AgingBucket = "d0_30" | "d31_60" | "d61_90" | "d90_plus";

export interface AgingVendorRow {
  vendorId: string | null;
  vendorName: string | null;
  buckets: Record<AgingBucket, number>;
  total: number;
  oldestDays: number;
  invoices: Array<{
    invoiceId: string;
    reference: string;
    invoiceNumber: string | null;
    status: string;
    dueDate: string | null;
    daysOutstanding: number;
    bucket: AgingBucket;
    outstanding: number;
  }>;
}

export interface AgingCurrencyBlock {
  currency: string;
  buckets: Record<AgingBucket, number>;
  total: number;
  invoiceCount: number;
  vendors: AgingVendorRow[];
}

export interface AgingReport {
  asOf: string;
  projectId: string;
  bucketLabels: Record<AgingBucket, string>;
  bucketDefinition: string;
  receivable: { byCurrency: AgingCurrencyBlock[] };
  payable: { byCurrency: AgingCurrencyBlock[] };
  unaged: Array<{
    invoiceId: string;
    reference: string;
    currency: string;
    outstanding: number;
    reasons: string[];
  }>;
  reasons: string[];
}

export interface CashPositionBlock {
  currency: string;
  receivableBilledUnpaid: number;
  receivableRetainageHeldByOwner: number;
  payableInvoicedUnpaid: number;
  payableRetainageWeHold: number;
  receivableOverdue: number;
  payableOverdue: number;
  netWorkingPosition: number;
  netPositionIncludingRetainage: number;
}

export interface CashPosition {
  asOf: string;
  projectId: string;
  byCurrency: CashPositionBlock[];
  openBillingPeriods: Array<{
    id: string;
    reference: string;
    name: string;
    startDate: string;
    endDate: string;
    billingDate: string;
    dueDate: string | null;
  }>;
  currencyNote: string | null;
  reasons: string[];
}

export interface PaymentRow {
  id: string;
  commitmentId: string;
  invoiceId: string | null;
  vendorId: string | null;
  number: number;
  reference: string;
  method: string;
  status: string;
  amount: number;
  retainageReleasedAmount: number;
  discountTaken: number;
  currency: string;
  paymentDate: string | null;
  clearedDate: string | null;
  checkNumber: string | null;
  transactionReference: string | null;
  holdReason: string | null;
  lienWaiverId: string | null;
  notes: string | null;
  createdAt: string;
}

export interface InvoicePaymentsResponse {
  invoiceId: string;
  currency: string;
  currentPaymentDue: number;
  amountPaid: number;
  payable: number;
  payments: PaymentRow[];
}

export interface PrimeContractRow {
  id: string;
  number: number;
  reference: string;
  title: string;
  status: string;
  currency: string;
  originalContractSum: number;
  revisedContractSum: number;
  totalBilled: number;
  totalPaid: number;
  retainageHeld: number;
}

export interface CommitmentRow {
  id: string;
  kind: string;
  number: number;
  reference: string;
  title: string;
  status: string;
  currency: string;
  vendorId: string | null;
  originalCommitmentSum: number;
  revisedCommitmentSum: number;
  totalPaid: number;
}

export interface VendorRow {
  id: string;
  name: string;
  status: string;
}

/* ============================================================================
   Enumerations
============================================================================ */

export const INVOICE_STATUSES = [
  "draft",
  "submitted",
  "under_review",
  "revise_and_resubmit",
  "approved",
  "approved_as_noted",
  "rejected",
  "paid",
  "void",
] as const;

export const BILLING_PERIOD_STATUSES = ["open", "closed", "locked"] as const;

export const LIEN_WAIVER_TYPES = [
  "conditional_progress",
  "unconditional_progress",
  "conditional_final",
  "unconditional_final",
] as const;

export const LIEN_WAIVER_STATUSES = [
  "draft",
  "requested",
  "sent",
  "signed",
  "received",
  "verified",
  "rejected",
  "not_required",
  "void",
] as const;

export const RETAINAGE_RELEASE_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "released",
  "void",
] as const;

export const RETAINAGE_BASES = [
  "percent_work_completed",
  "percent_stored_materials",
  "fixed_amount",
  "milestone_reduction",
  "none",
] as const;

export const PAYMENT_METHODS = [
  "check",
  "ach",
  "wire",
  "credit_card",
  "cash",
  "joint_check",
  "other",
] as const;

export const AGING_BUCKET_ORDER: readonly AgingBucket[] = [
  "d0_30",
  "d31_60",
  "d61_90",
  "d90_plus",
];

export const AGING_BUCKET_LABEL: Record<AgingBucket, string> = {
  d0_30: "0-30 days",
  d31_60: "31-60 days",
  d61_90: "61-90 days",
  d90_plus: "90+ days",
};

/**
 * A waiver counts as ON FILE only in these three states. Anything earlier —
 * requested, sent, even signed — means the document is not in our hands, and
 * "the sub says they posted it" has never defeated a mechanic's lien.
 */
export const SATISFYING_WAIVER_STATUSES = ["received", "verified", "not_required"] as const;

const INVOICE_TONE: Record<string, Tone> = {
  draft: "neutral",
  submitted: "info",
  under_review: "info",
  revise_and_resubmit: "warning",
  approved: "success",
  approved_as_noted: "warning",
  rejected: "danger",
  paid: "success",
  void: "neutral",
};

const PERIOD_TONE: Record<string, Tone> = {
  open: "success",
  closed: "warning",
  locked: "neutral",
};

const WAIVER_TONE: Record<string, Tone> = {
  draft: "neutral",
  requested: "info",
  sent: "info",
  signed: "warning",
  received: "success",
  verified: "success",
  rejected: "danger",
  not_required: "neutral",
  void: "neutral",
};

const RELEASE_TONE: Record<string, Tone> = {
  draft: "neutral",
  pending_approval: "warning",
  approved: "info",
  rejected: "danger",
  released: "success",
  void: "neutral",
};

const PAYMENT_TONE: Record<string, Tone> = {
  scheduled: "info",
  on_hold: "danger",
  issued: "success",
  cleared: "success",
  failed: "danger",
  voided: "neutral",
};

export const invoiceTone = (s: string): Tone => INVOICE_TONE[s] ?? "neutral";
export const periodTone = (s: string): Tone => PERIOD_TONE[s] ?? "neutral";
export const waiverTone = (s: string): Tone => WAIVER_TONE[s] ?? "neutral";
export const releaseTone = (s: string): Tone => RELEASE_TONE[s] ?? "neutral";
export const paymentTone = (s: string): Tone => PAYMENT_TONE[s] ?? "neutral";

export const KIND_LABEL: Record<string, string> = {
  owner_billing: "Owner application",
  subcontractor_invoice: "Subcontractor invoice",
};

/* ============================================================================
   Formatting
============================================================================ */

export function money(amount: number | null | undefined, currency: string | null): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "—";
  if (!currency) {
    return `${amount.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} (currency unknown)`;
  }
  try {
    return amount.toLocaleString(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    });
  } catch {
    return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

export function num(value: number | null | undefined, dp = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: dp });
}

export function percent(value: number | null | undefined, dp = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: dp })}%`;
}

export function isoDate(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function isoDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function label(value: string | null | undefined): string {
  if (!value) return "—";
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* ============================================================================
   Errors — the server's refusal, kept intact
============================================================================ */

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export interface ServerRefusal {
  status: number;
  /** the server's sentence, VERBATIM — it names figures to the cent */
  message: string;
  /** which control was enforced, when the server said */
  control: string | null;
  /** per-line refusals from the billing-entry route */
  issues: LineIssue[];
  details: Record<string, unknown> | null;
}

export function refusalFrom(err: unknown): ServerRefusal | null {
  if (!(err instanceof ApiClientError)) return null;
  const body = err.details as { details?: unknown } | undefined;
  const raw = body && typeof body === "object" ? body.details : undefined;
  const details =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const rawIssues = details?.["issues"];
  const issues: LineIssue[] = Array.isArray(rawIssues)
    ? rawIssues.map((issue) => {
        const rec = (issue ?? {}) as Record<string, unknown>;
        const detail = rec["detail"];
        return {
          lineNumber: typeof rec["lineNumber"] === "string" ? rec["lineNumber"] : "?",
          code: typeof rec["code"] === "string" ? rec["code"] : "unknown",
          message: typeof rec["message"] === "string" ? rec["message"] : "Refused",
          detail:
            detail && typeof detail === "object" && !Array.isArray(detail)
              ? (detail as Record<string, number | string>)
              : {},
        };
      })
    : [];
  return {
    status: err.status,
    message: err.message,
    control: details && typeof details["control"] === "string" ? details["control"] : null,
    issues,
    details,
  };
}

const ISSUE_EXPLAIN: Record<string, string> = {
  over_billed:
    "Billing past a schedule-of-values line is refused. The overage is named to the cent so the line can be corrected rather than guessed at.",
  regression_without_credit_reason:
    "Percent complete cannot regress without a stated credit reason. Un-billing work silently is how a G703 stops reconciling.",
  inconsistent_work_input:
    "Two of quantity, percent complete and completed-to-date were given and they disagree. The server refuses rather than picking one.",
  inconsistent_materials_input:
    "Stored-materials this period and materials presently stored disagree.",
  negative_materials: "Stored materials cannot be negative.",
  release_exceeds_held: "The retainage release is larger than what is actually held on the line.",
};

/**
 * The server's refusal, rendered word for word with the figures it named.
 * Nothing is paraphrased: the exact numbers are the only actionable part.
 */
export function RefusalPanel({
  refusal,
  title,
}: {
  refusal: ServerRefusal | null;
  title?: ReactNode;
}) {
  if (!refusal) return null;
  const isControl = refusal.control !== null;
  return (
    <Alert
      tone={isControl ? "warning" : "danger"}
      variant="subtle"
      title={
        title ??
        (isControl
          ? `Refused by the "${label(refusal.control)}" control`
          : "The server refused this")
      }
    >
      <p className="whitespace-pre-wrap">{refusal.message}</p>

      {refusal.issues.length > 0 ? (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[28rem] text-2xs">
            <thead>
              <tr className="border-b border-border text-content-subtle">
                <th className="py-1 pr-3 text-left font-semibold">Line</th>
                <th className="py-1 pr-3 text-left font-semibold">Refusal</th>
                <th className="py-1 text-left font-semibold">Figures</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {refusal.issues.map((issue, index) => (
                <tr key={`${issue.lineNumber}-${index}`} className="align-top">
                  <td className="py-1.5 pr-3 font-mono">{issue.lineNumber}</td>
                  <td className="py-1.5 pr-3">
                    {issue.message}
                    {ISSUE_EXPLAIN[issue.code] ? (
                      <span className="mt-0.5 block text-content-subtle">
                        {ISSUE_EXPLAIN[issue.code]}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-1.5">
                    {Object.entries(issue.detail).length === 0 ? (
                      "—"
                    ) : (
                      <ul className="space-y-0.5">
                        {Object.entries(issue.detail).map(([key, value]) => (
                          <li key={key} className="tabular-nums">
                            <span className="text-content-subtle">{label(key)}:</span>{" "}
                            {typeof value === "number" ? num(value, 2) : String(value)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Alert>
  );
}

/* ============================================================================
   Honesty components
============================================================================ */

export function Reasons({
  reasons,
  tone = "info",
  title,
}: {
  reasons: readonly string[] | null | undefined;
  tone?: Tone;
  title?: ReactNode;
}) {
  if (!reasons || reasons.length === 0) return null;
  return (
    <Alert tone={tone} variant="subtle" size="sm" title={title}>
      <ul className="ml-4 list-disc space-y-1">
        {reasons.map((reason, index) => (
          <li key={index}>{reason}</li>
        ))}
      </ul>
    </Alert>
  );
}

/** `{ value: null, reasons }` — "not available", plus the reasons verbatim. */
export function UnknowableValue({
  value,
  currency,
  format = "money",
}: {
  value: Unknowable | null | undefined;
  currency?: string | null;
  format?: "money" | "number" | "percent";
}) {
  if (!value) return <span className="text-content-subtle">—</span>;
  if (value.value === null) {
    return (
      <span>
        <span className="italic text-content-subtle">Not available</span>
        {value.reasons.length > 0 ? (
          <span className="mt-0.5 block text-2xs leading-snug text-content-muted">
            {value.reasons.join(" ")}
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <span>
      {format === "money"
        ? money(value.value, currency ?? null)
        : format === "percent"
          ? percent(value.value)
          : num(value.value)}
    </span>
  );
}

/** A figure with no source. The reason it is absent, never a zero. */
export function NoFigure({ reason }: { reason: string }) {
  return (
    <span className="text-content-subtle">
      <span className="italic">Not available</span>
      <span className="mt-0.5 block text-2xs leading-snug text-content-muted">{reason}</span>
    </span>
  );
}

export function ChecksList({
  checks,
  currency,
}: {
  checks: readonly ReconciliationCheck[];
  currency: string | null;
}) {
  if (checks.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {checks.map((check, index) => (
        <li
          key={index}
          className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-border-subtle px-2.5 py-1.5"
        >
          <span className="font-mono text-2xs text-content-muted">{check.identity}</span>
          <span className="flex items-center gap-2 text-meta tabular-nums">
            <span className="text-content">{money(check.left, currency)}</span>
            <span className="text-content-subtle">vs</span>
            <span className="text-content">{money(check.right, currency)}</span>
            <Badge tone={check.ok ? "success" : "danger"} size="xs">
              {check.ok ? "ties" : `out by ${money(check.delta, currency)}`}
            </Badge>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A block of money per currency. There is no "total" row and there will not be
 * one: the platform holds no exchange rate, so a cross-currency sum would be a
 * number this screen invented.
 */
export function CurrencyBlocks<T extends { currency: string }>({
  blocks,
  render,
  emptyTitle,
  emptyHint,
}: {
  blocks: readonly T[];
  render: (block: T) => ReactNode;
  emptyTitle: string;
  emptyHint: string;
}) {
  if (blocks.length === 0) {
    return (
      <Card>
        <CardBody>
          <p className="text-body font-medium text-content">{emptyTitle}</p>
          <p className="mt-1 text-meta text-content-muted">{emptyHint}</p>
        </CardBody>
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {blocks.map((block) => (
        <div key={block.currency}>{render(block)}</div>
      ))}
      {blocks.length > 1 ? (
        <p className="text-2xs text-content-subtle">
          {blocks.length} currencies are reported separately above. They are never summed — there is
          no exchange rate on any of these records.
        </p>
      ) : null}
    </div>
  );
}

export function PanelSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Card>
      <CardBody className="space-y-3">
        <Skeleton height={14} width="34%" />
        {Array.from({ length: rows }).map((_, index) => (
          <Skeleton key={index} height={12} width={`${88 - index * 9}%`} />
        ))}
      </CardBody>
    </Card>
  );
}

/* ============================================================================
   Data hooks
============================================================================ */

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function useResource<T>(path: string | null): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<T>(path)
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, `Failed to load ${path}`));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

export interface InvoicingContext {
  contracts: PrimeContractRow[];
  commitments: CommitmentRow[];
  vendors: VendorRow[];
  periods: BillingPeriodRow[];
  contractById: Map<string, PrimeContractRow>;
  commitmentById: Map<string, CommitmentRow>;
  periodById: Map<string, BillingPeriodRow>;
  vendorName: (id: string | null | undefined) => string | null;
  /** the counterparty on an invoice: the vendor, or the owner on a prime bill */
  counterparty: (invoice: InvoiceRow) => string;
  currencies: string[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useInvoicingContext(projectId: string): InvoicingContext {
  const contracts = useResource<ListResponse<PrimeContractRow>>(
    `/api/v1/projects/${projectId}/prime-contracts?page=1&pageSize=200`,
  );
  const commitments = useResource<ListResponse<CommitmentRow>>(
    `/api/v1/projects/${projectId}/commitments?page=1&pageSize=500`,
  );
  const vendors = useResource<ListResponse<VendorRow>>(`/api/v1/vendors?page=1&pageSize=500`);
  const periods = useResource<ListResponse<BillingPeriodRow>>(
    `/api/v1/projects/${projectId}/billing-periods?page=1&pageSize=200`,
  );

  const contractRows = useMemo(() => contracts.data?.items ?? [], [contracts.data]);
  const commitmentRows = useMemo(() => commitments.data?.items ?? [], [commitments.data]);
  const vendorRows = useMemo(() => vendors.data?.items ?? [], [vendors.data]);
  const periodRows = useMemo(() => periods.data?.items ?? [], [periods.data]);

  const contractById = useMemo(() => new Map(contractRows.map((c) => [c.id, c])), [contractRows]);
  const commitmentById = useMemo(
    () => new Map(commitmentRows.map((c) => [c.id, c])),
    [commitmentRows],
  );
  const periodById = useMemo(() => new Map(periodRows.map((p) => [p.id, p])), [periodRows]);
  const vendorById = useMemo(() => new Map(vendorRows.map((v) => [v.id, v])), [vendorRows]);

  const currencies = useMemo(() => {
    const set = new Set<string>();
    for (const c of contractRows) set.add(c.currency.toUpperCase());
    for (const c of commitmentRows) set.add(c.currency.toUpperCase());
    return [...set].sort();
  }, [contractRows, commitmentRows]);

  const reload = useCallback(() => {
    contracts.reload();
    commitments.reload();
    vendors.reload();
    periods.reload();
  }, [contracts, commitments, vendors, periods]);

  const vendorName = useCallback(
    (id: string | null | undefined) => (id ? (vendorById.get(id)?.name ?? null) : null),
    [vendorById],
  );

  const counterparty = useCallback(
    (invoice: InvoiceRow): string => {
      if (invoice.kind === "owner_billing") {
        const contract = invoice.primeContractId
          ? contractById.get(invoice.primeContractId)
          : undefined;
        return contract ? `Owner — ${contract.reference}` : "Owner";
      }
      return (
        vendorName(invoice.vendorId) ??
        (invoice.commitmentId
          ? (commitmentById.get(invoice.commitmentId)?.reference ?? "Vendor not named")
          : "Vendor not named")
      );
    },
    [contractById, commitmentById, vendorName],
  );

  return {
    contracts: contractRows,
    commitments: commitmentRows,
    vendors: vendorRows,
    periods: periodRows,
    contractById,
    commitmentById,
    periodById,
    vendorName,
    counterparty,
    currencies,
    loading: contracts.loading || commitments.loading || vendors.loading || periods.loading,
    error: contracts.error ?? commitments.error ?? vendors.error ?? periods.error,
    reload,
  };
}

/**
 * Is this billing period accepting new billing? A closed period is not an
 * error state — it is the rule that makes a monthly cost report reproducible.
 */
export function periodAcceptsBilling(period: BillingPeriodRow | null | undefined): {
  ok: boolean;
  rule: string | null;
} {
  if (!period) return { ok: true, rule: null };
  if (period.status === "closed") {
    return {
      ok: false,
      rule: `${period.reference} (${period.name}) is closed. A closed period takes no new billing — reopen it, or bill into the next one.`,
    };
  }
  if (period.status === "locked") {
    return {
      ok: false,
      rule: `${period.reference} (${period.name}) is locked. Its figures are frozen for reporting and can never take billing again — open a new period.`,
    };
  }
  return { ok: true, rule: null };
}
