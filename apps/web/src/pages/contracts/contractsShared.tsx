/**
 * Shared types + presentational helpers for the contract intelligence
 * workspace (spec Vol II Domain C / M8). Kept as a sibling of the contract
 * pages so the register, detail tabs and modals agree on labels, tones and
 * deadline arithmetic.
 */
import type { ReactNode } from "react";

/* --------------------------------- Types ----------------------------------- */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ContractRow {
  id: string;
  name: string;
  form: string;
  necOption: string | null;
  parties: Record<string, string>;
  baseDate: string | null;
  commencementDate: string | null;
  completionDate: string | null;
  currency: string;
  contractSum: number | null;
  retentionPercent: number;
  retentionCap: number | null;
  defectsPeriodMonths: number | null;
  ldRatePerDay: number | null;
  ldCap: number | null;
  particularConditions: { clauseRef: string; amendment: string }[];
  status: string;
  createdAt: string;
}

export interface EffectiveClause {
  clauseRef: string;
  title: string;
  summary: string;
  category: string;
  timeBarDays?: number | null;
  noticeBy?: string | null;
  noticeRequired: boolean;
  standingObligation?: { party: string; description: string } | null;
  amended: boolean;
  amendment: string | null;
}

export interface ContractDetail extends ContractRow {
  effectiveClauses: EffectiveClause[];
  obligationCount: number;
  eventCounts: Record<string, number>;
}

export interface ContractEventRow {
  id: string;
  number: number;
  kind: string;
  clauseRef: string | null;
  title: string;
  description: string | null;
  eventDate: string;
  noticeDeadline: string | null;
  noticeServedAt: string | null;
  noticeMethod: string | null;
  noticeReference: string | null;
  status: string;
  costImpactEstimate: number | null;
  timeImpactDaysEstimate: number | null;
  daysToDeadline?: number | null;
  createdAt: string;
}

export interface EotClaimRow {
  id: string;
  number: number;
  title: string;
  clauseRef: string | null;
  eventIds: string[];
  daysClaimed: number;
  daysAwarded: number | null;
  status: string;
  narrative: string | null;
  assessedAt: string | null;
  createdAt: string;
}

export interface DeadlineItem {
  id: string;
  contractId: string;
  contractName: string | null;
  number: number;
  kind: string;
  title: string;
  clauseRef: string | null;
  clauseTitle: string | null;
  eventDate: string;
  noticeDeadline: string | null;
  daysRemaining: number;
}

export type LdExposure =
  | { applicable: false }
  | {
      applicable: true;
      completionDate: string;
      daysLate: number;
      ldRatePerDay: number;
      ldCap: number | null;
      accrued: number;
      capReached: boolean;
    };

/* --------------------------------- Labels ---------------------------------- */

const FORM_LABELS: Record<string, string> = {
  fidic_red_1999: "FIDIC Red Book 1999",
  fidic_red_2017: "FIDIC Red Book 2017",
  fidic_yellow_2017: "FIDIC Yellow Book 2017",
  fidic_silver_2017: "FIDIC Silver Book 2017",
  nec3_ecc: "NEC3 ECC",
  nec4_ecc: "NEC4 ECC",
  jct_sbc_2016: "JCT SBC 2016",
  jct_db_2016: "JCT Design & Build 2016",
  bespoke: "Bespoke",
};

export function formLabel(form: string | null | undefined): string {
  if (!form) return "—";
  return FORM_LABELS[form] ?? form;
}

export function isNecForm(form: string): boolean {
  return form.startsWith("nec");
}

/** Contract-administrator role name per family of forms. */
export function administratorLabel(form: string): string {
  if (form.startsWith("fidic")) return "Engineer";
  if (form.startsWith("nec")) return "Project Manager";
  if (form.startsWith("jct")) return "Contract Administrator";
  return "Contract Administrator";
}

export const NOTICE_METHODS = ["email", "letter", "portal", "registered_post"] as const;

export function eventLabel(number: number): string {
  return `EV-${String(number).padStart(3, "0")}`;
}

export function eotLabel(number: number): string {
  return `EOT-${String(number).padStart(3, "0")}`;
}

/* --------------------------------- Tones ----------------------------------- */

export function contractStatusTone(status: string): string {
  switch (status) {
    case "draft":
      return "gray";
    case "executed":
      return "green";
    case "completed":
      return "blue";
    case "terminated":
      return "red";
    default:
      return "gray";
  }
}

export function eventStatusTone(status: string): string {
  switch (status) {
    case "open":
      return "blue";
    case "notice_served":
      return "green";
    case "time_barred":
      return "red";
    case "resolved":
      return "green";
    case "withdrawn":
      return "gray";
    default:
      return "gray";
  }
}

export function eotStatusTone(status: string): string {
  switch (status) {
    case "notified":
      return "blue";
    case "submitted":
      return "blue";
    case "assessed":
      return "amber";
    case "agreed":
      return "green";
    case "rejected":
      return "red";
    case "referred":
      return "violet";
    default:
      return "gray";
  }
}

export function kindTone(kind: string): string {
  switch (kind) {
    case "early_warning":
      return "amber";
    case "compensation_event":
    case "eot_claim":
    case "delay_event":
      return "violet";
    case "claim_notice":
    case "pay_less_notice":
      return "red";
    case "variation_instruction":
      return "blue";
    case "payment_notice":
      return "green";
    default:
      return "gray";
  }
}

/* --------------------------------- Dates ----------------------------------- */

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from today (UTC) to an ISO date; negative = already past. */
export function daysUntilIso(isoDate: string): number {
  return Math.round(
    (Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${todayIso()}T00:00:00Z`)) / 86_400_000,
  );
}

/* ------------------------------- Components -------------------------------- */

/**
 * Countdown chip for a notice deadline: green while comfortable, amber inside
 * 14 days, red inside 5, dark red once the time bar has fallen.
 */
export function DeadlineBadge({
  daysRemaining,
  timeBarred,
}: {
  daysRemaining: number | null | undefined;
  timeBarred?: boolean;
}) {
  if (timeBarred || (daysRemaining !== null && daysRemaining !== undefined && daysRemaining < 0)) {
    return (
      <span className="inline-flex items-center rounded-full bg-red-900 px-2 py-0.5 text-xs font-semibold text-red-100">
        TIME BARRED
      </span>
    );
  }
  if (daysRemaining === null || daysRemaining === undefined) {
    return <span className="text-xs text-ink-400">—</span>;
  }
  const cls =
    daysRemaining <= 5
      ? "bg-red-100 text-red-800"
      : daysRemaining <= 14
        ? "bg-amber-100 text-amber-800"
        : "bg-emerald-100 text-emerald-800";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {daysRemaining === 0 ? "Due today" : `${daysRemaining}d left`}
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

/** Amber informational banner (self-assessment 403s, late-service warnings). */
export function InfoBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
      {message}
    </div>
  );
}

/** Label/value line used by the overview cards and the event drawer. */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-ink-400">
        {label}
      </span>
      <span className="text-right text-sm text-ink-800">{children}</span>
    </div>
  );
}
