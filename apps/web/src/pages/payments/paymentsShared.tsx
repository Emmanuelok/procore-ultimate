/**
 * Shared types + presentational helpers for the statutory payment security
 * workspace (spec Vol II Domain F / M10). Regime definitions come from the
 * API's code-resident library; the client only mirrors the date arithmetic
 * for the *indicative* pre-service deadline preview.
 */

/* --------------------------------- Types ----------------------------------- */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RegimeDef {
  regime: string;
  name: string;
  jurisdiction: string;
  summary: string;
  responseDeadlineDays: number;
  responseDayBasis: "calendar" | "business";
  finalPaymentDays: number;
  finalPaymentBasis: "calendar" | "business";
  suspensionNoticeDays: number;
  annualInterestPercent: number;
  interestNote: string;
  deemedRule: string;
  adjudicationNote: string;
}

export interface PaymentClaimRow {
  id: string;
  number: number;
  regime: string;
  referenceDate: string;
  claimedAmount: number;
  currency: string;
  description: string | null;
  contractId: string | null;
  valuationId: string | null;
  servedAt: string | null;
  serviceMethod: string | null;
  serviceReference: string | null;
  responseDeadline: string | null;
  finalPaymentDate: string | null;
  status: string;
  paidAt: string | null;
  paidAmount: number | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  daysToResponseDeadline?: number | null;
}

export interface PaymentResponseRow {
  id: string;
  kind: string;
  amount: number;
  reasons: string | null;
  servedAt: string;
  /** 0/1 — served after the statutory deadline */
  late: number;
  servedBy: string;
}

export interface SuspensionNoticeRow {
  id: string;
  paymentClaimId: string;
  servedAt: string;
  effectiveFrom: string;
  liftedAt: string | null;
  servedBy: string;
}

export interface PaymentClaimDetail extends PaymentClaimRow {
  responses: PaymentResponseRow[];
  suspensionNotices: SuspensionNoticeRow[];
  regimeDef: RegimeDef | null;
}

export interface PaymentsAnalytics {
  claims: number;
  served: number;
  responded: number;
  deemed: number;
  paid: number;
  suspended: number;
  avgDaysToPay: number | null;
  totalOutstanding: number;
  deemedExposure: number;
}

export interface DeadlineItem {
  id: string;
  number: number;
  regime: string;
  claimedAmount: number;
  currency: string;
  servedAt: string | null;
  responseDeadline: string | null;
  finalPaymentDate: string | null;
  daysRemaining: number;
}

export interface InterestResult {
  claimId: string;
  status: string;
  currency: string;
  outstanding: number;
  finalPaymentDate: string | null;
  daysLate: number;
  annualRate: number;
  interest: number;
  basis: string;
}

export interface ValuationLite {
  id: string;
  number: number;
  valuationDate: string;
  status: string;
  netDue: number;
}

export interface ContractLite {
  id: string;
  name: string;
}

/* -------------------------------- Helpers ----------------------------------- */

export function pcLabel(n: number): string {
  return `PC-${String(n).padStart(3, "0")}`;
}

/** Short display labels for the (long) statutory regime names. */
export const REGIME_SHORT: Record<string, string> = {
  uk_hgcra: "UK HGCRA",
  sg_sopa: "SG SOPA",
  au_nsw_sopa: "NSW SOPA",
  my_cipaa: "MY CIPAA",
  nz_cca: "NZ CCA",
};

export function regimeShort(regime: string): string {
  return REGIME_SHORT[regime] ?? regime;
}

export function paymentStatusTone(status: string): string {
  switch (status) {
    case "draft":
      return "gray";
    case "served":
      return "blue";
    case "responded":
      return "green";
    case "deemed":
      return "red";
    case "paid":
      return "green";
    case "suspended":
      return "amber";
    case "referred":
      return "violet";
    default:
      return "gray";
  }
}

export const SERVICE_METHODS = ["email", "portal", "registered_post", "letter"] as const;

/** Money with 2 decimals — statutory sums are exact figures. */
export function fmtMoney(
  value: number | null | undefined,
  currency?: string | null,
): string {
  if (value === null || value === undefined) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "GBP",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  }
}

/* ------------------------- Indicative date arithmetic ------------------------ */
/* Mirrors the API's simplified model (Mon-Fri business days, no holidays) so
 * the create modal can preview deadlines BEFORE service. Authoritative dates
 * are always the ones computed server-side at the moment of service. */

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isBusinessDayIso(date: string): boolean {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
}

export function addBusinessDaysIso(date: string, days: number): string {
  let d = date;
  let remaining = days;
  while (remaining > 0) {
    d = addDaysIso(d, 1);
    if (isBusinessDayIso(d)) remaining -= 1;
  }
  return d;
}

/** Indicative statutory timeline if the claim were served today. */
export function previewTimeline(
  def: RegimeDef,
  referenceDate: string,
): { responseDeadline: string; finalPaymentDate: string } {
  const today = todayIso();
  const base = today > referenceDate ? today : referenceDate;
  const add = (basis: "calendar" | "business", days: number) =>
    basis === "business" ? addBusinessDaysIso(base, days) : addDaysIso(base, days);
  return {
    responseDeadline: add(def.responseDayBasis, def.responseDeadlineDays),
    finalPaymentDate: add(def.finalPaymentBasis, def.finalPaymentDays),
  };
}

/* ------------------------------ Components ---------------------------------- */

/** Deadline countdown chip: red past/≤2d, amber ≤7d, green otherwise. */
export function CountdownBadge({ days }: { days: number | null | undefined }) {
  if (days === null || days === undefined) {
    return <span className="text-xs text-ink-300">—</span>;
  }
  const cls =
    days < 0
      ? "bg-red-900 text-red-100"
      : days <= 2
        ? "bg-red-100 text-red-800"
        : days <= 7
          ? "bg-amber-100 text-amber-800"
          : "bg-emerald-100 text-emerald-800";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}
    >
      {days < 0 ? `${-days}d overdue` : days === 0 ? "due today" : `${days}d left`}
    </span>
  );
}
