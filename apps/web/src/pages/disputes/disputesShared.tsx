/**
 * Shared types + presentational helpers for the dispute support workspace
 * (spec Vol II Domain E / M15). Row shapes mirror the disputes API module;
 * the client renders — it never recomputes deadlines or hashes.
 */
import type { ReactNode } from "react";

/* --------------------------------- Types ----------------------------------- */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Procedural timetable step (#330/#338) as stored on the dispute row. */
export interface TimetableStep {
  id: string;
  name: string;
  dueDate: string | null;
  obligationId: string | null;
  done: boolean;
  doneAt: string | null;
  breachedAt: string | null;
}

export interface DisputeRow {
  id: string;
  number: number;
  title: string;
  kind: string;
  forum: string | null;
  rules: string | null;
  contractId: string | null;
  claimIds: string[];
  counterpartyEntityId: string | null;
  amountInDispute: number | null;
  currency: string;
  status: string;
  timetable: TimetableStep[];
  outcome: string | null;
  decidedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  nextDeadline: string | null;
  daysToNext: number | null;
}

export interface ClaimRef {
  id: string;
  number: number;
  title: string;
}

export interface SubmissionRow {
  id: string;
  disputeId: string;
  kind: string;
  title: string;
  party: string;
  servedAt: string;
  fileId: string | null;
  note: string | null;
  recordedBy: string;
  createdAt: string;
}

export interface BundleItem {
  id: string;
  tab: string | null;
  title: string;
  date: string | null;
  recordType: string | null;
  recordId: string | null;
  fileId: string | null;
  sha256: string | null;
}

export interface ManifestIndexEntry {
  tab: string;
  title: string;
  date: string | null;
  source: string;
  sha256: string;
}

export interface BundleManifest {
  generatedAt: string;
  itemCount: number;
  merkleRoot: string;
  index: ManifestIndexEntry[];
}

export interface BundleRow {
  id: string;
  disputeId: string;
  name: string;
  status: string; // draft | generated | issued
  items: BundleItem[];
  manifest: BundleManifest | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface OfferRow {
  id: string;
  disputeId: string;
  direction: string; // made | received
  basis: string;
  amount: number;
  currency: string;
  terms: string | null;
  offeredAt: string;
  expiresAt: string | null;
  status: string; // open | accepted | rejected | lapsed | withdrawn
  recordedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DisputeDetail extends DisputeRow {
  claims: ClaimRef[];
  submissions: SubmissionRow[];
  bundles: BundleRow[];
  offers: OfferRow[];
}

export interface VerifyResult {
  intact: boolean;
  merkleRoot: string;
  itemCount: number;
  mismatches: { tab: string; title: string; expected: string; actual: string | null }[];
}

export interface SettlementAnalysisResult {
  disputeId: string;
  currency: string;
  winProbability: number;
  expectedAward: number;
  legalCosts: number;
  expectedValueOfProceeding: number;
  bestOpenOffer: {
    id: string;
    direction: string;
    status: string;
    amount: number;
    currency: string;
    basis: string;
    offeredAt: string;
  } | null;
  recommendation: "settle" | "proceed";
  rationale: string;
}

/* ------------------------------ Picker types -------------------------------- */

export interface ContractLite {
  id: string;
  name: string;
}

export interface EntityLite {
  id: string;
  name: string;
  kind: string;
}

export interface FileLite {
  id: string;
  name: string;
  updatedAt: string;
}

export interface RfiLite {
  id: string;
  number: number;
  subject: string;
  status: string;
  dueDate: string | null;
}

export interface DelayEventLite {
  id: string;
  number: number;
  title: string;
  startDate: string | null;
  status: string;
}

export interface ClaimLite {
  id: string;
  number: number;
  title: string;
  kind: string;
  status: string;
}

export interface EvidenceLite {
  id: string;
  kind: string;
  source: string;
  capturedAt: string | null;
}

/* -------------------------------- Helpers ----------------------------------- */

export function dspLabel(n: number): string {
  return `DSP-${String(n).padStart(3, "0")}`;
}

/** Human labels for the resolution-forum kinds (#321, #329, #334-336). */
export const KIND_LABELS: Record<string, string> = {
  adjudication: "Adjudication",
  daab: "DAAB",
  mediation: "Mediation",
  arbitration: "Arbitration",
  expert_determination: "Expert determination",
  litigation: "Litigation",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** The forward-only procedural ladder mirrored from the API. */
export const FORWARD_ORDER = ["notified", "referred", "submissions", "hearing", "decided"] as const;
export const TERMINAL_STATUSES = ["decided", "settled", "withdrawn"] as const;

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function disputeStatusTone(status: string): string {
  switch (status) {
    case "notified":
      return "gray";
    case "referred":
      return "blue";
    case "submissions":
      return "blue";
    case "hearing":
      return "violet";
    case "decided":
      return "green";
    case "settled":
      return "green";
    case "withdrawn":
      return "gray";
    default:
      return "gray";
  }
}

export function offerStatusTone(status: string): string {
  switch (status) {
    case "open":
      return "blue";
    case "accepted":
      return "green";
    case "rejected":
      return "red";
    case "lapsed":
    case "withdrawn":
      return "gray";
    default:
      return "gray";
  }
}

/** Short chips for the settlement-privilege bases (#350-351). */
export const BASIS_SHORT: Record<string, string> = {
  without_prejudice: "WP",
  without_prejudice_save_as_to_costs: "WPSATC",
  open: "Open",
};

export const BASIS_LONG: Record<string, string> = {
  without_prejudice: "Without prejudice",
  without_prejudice_save_as_to_costs: "Without prejudice save as to costs",
  open: "Open offer",
};

export function basisShort(basis: string): string {
  return BASIS_SHORT[basis] ?? basis;
}

export function basisTone(basis: string): string {
  if (basis === "open") return "blue";
  if (basis === "without_prejudice_save_as_to_costs") return "amber";
  return "gray";
}

export function partyTone(party: string): string {
  if (party === "claimant") return "blue";
  if (party === "respondent") return "amber";
  if (party === "tribunal") return "violet";
  return "gray";
}

export const BUNDLE_SOURCE_LABELS: Record<string, string> = {
  file: "File",
  rfi: "RFI",
  delay_event: "Delay event",
  contract_event: "Contract event",
  claim: "Claim",
  evidence: "Evidence",
};

export function bundleSourceLabel(item: {
  fileId: string | null;
  recordType: string | null;
}): string {
  if (item.fileId) return "File";
  return BUNDLE_SOURCE_LABELS[item.recordType ?? ""] ?? item.recordType ?? "—";
}

/** Money with 2 decimals — sums in dispute are exact figures. */
export function fmtMoney(value: number | null | undefined, currency?: string | null): string {
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

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Whole days from today to an ISO date; negative = already past. */
export function daysUntilIso(isoDate: string): number {
  return Math.round(
    (Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${todayIso()}T00:00:00Z`)) / 86_400_000,
  );
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
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${cls}`}
    >
      {days < 0 ? `${-days}d overdue` : days === 0 ? "due today" : `${days}d left`}
    </span>
  );
}

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
    <div className="mb-4 flex flex-wrap gap-1 border-b border-ink-200">
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

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">{children}</div>
  );
}

export function WarnBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
      {message}
    </div>
  );
}
