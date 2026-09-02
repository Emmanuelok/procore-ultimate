/**
 * Shared types + presentational helpers for the delay & disruption
 * forensics workspace (spec Vol II Domain D / M9). Kept as a sibling of the
 * forensics tabs so the register, analysis views and claims workspace agree
 * on labels, tones and chips.
 */
import type { ReactNode } from "react";

/* --------------------------------- Types ----------------------------------- */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TiaResult {
  completionDeltaDays: number;
  beforeFinish: string | null;
  afterFinish: string | null;
  computedAt?: string;
}

export interface DelayEventRow {
  id: string;
  number: number;
  title: string;
  description: string | null;
  cause: string;
  /** stored as 0/1 */
  excusable: number;
  compensable: number;
  status: string;
  taskId: string | null;
  scheduleId: string | null;
  startDate: string;
  durationDays: number;
  contractEventId: string | null;
  evidenceIds: string[];
  tiaResult: TiaResult | null;
  raisedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceLite {
  id: string;
  kind: string;
  source: string;
  capturedAt: string | null;
  independenceScore?: number;
}

export interface DelayEventDetail extends DelayEventRow {
  task: { id: string; name: string } | null;
  contractEvent: { id: string; number: number; title: string } | null;
  evidence: EvidenceLite[];
}

export interface ClaimChain {
  cause?: string;
  effect?: string;
  entitlement?: string;
  quantum?: string;
}

export interface ChronologyItem {
  date: string;
  source: string;
  ref: string;
  title: string;
}

export interface ProlongationBlock {
  compensableDays?: number;
  prelimsRatePerDay?: number;
  amount?: number;
  derivation?: string;
}

export interface ClaimRow {
  id: string;
  number: number;
  title: string;
  kind: string;
  status: string;
  contractId: string | null;
  clauseRef: string | null;
  delayEventIds: string[];
  chain: ClaimChain;
  daysClaimed: number | null;
  amountClaimed: number | null;
  daysAssessed: number | null;
  amountAssessed: number | null;
  prolongation: ProlongationBlock | null;
  chronology: ChronologyItem[] | null;
  chronologyAt: string | null;
  assessedBy: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimEventLite {
  id: string;
  number: number;
  title: string;
  cause: string;
  excusable: number;
  compensable: number;
  status: string;
  startDate: string;
  durationDays: number;
  tiaResult: TiaResult | null;
}

export interface ClaimDetail extends ClaimRow {
  delayEvents: ClaimEventLite[];
}

export interface ScheduleRow {
  id: string;
  name: string;
  projectStart: string;
  isActive: number;
  computedFinish: string | null;
}

export interface ScheduleTaskLite {
  id: string;
  name: string;
  wbsCode: string | null;
  durationDays: number;
}

export interface BaselineRow {
  id: string;
  name: string;
  capturedAt: string;
  taskCount?: number;
}

export interface ContractLite {
  id: string;
  name: string;
}

export interface ContractEventLite {
  id: string;
  number: number;
  title: string;
  eventDate: string;
}

export interface ApvabTask {
  taskId: string;
  name: string;
  wbsCode: string | null;
  plannedStart: string | null;
  plannedFinish: string | null;
  actualOrForecastStart: string | null;
  actualOrForecastFinish: string | null;
  startSlipDays: number | null;
  finishSlipDays: number | null;
  isCritical: boolean;
  hasStarted: boolean;
  hasFinished: boolean;
  inBaseline: boolean;
}

export interface ApvabResponse {
  scheduleId: string;
  scheduleName: string;
  baselineId: string;
  baselineName: string;
  capturedAt: string;
  plannedFinish: string | null;
  currentForecastFinish: string | null;
  totalSlipDays: number | null;
  tasks: ApvabTask[];
}

export interface WindowEvent {
  id: string;
  number: number;
  title: string;
  cause: string;
  excusable: boolean;
  compensable: boolean;
  status: string;
  startDate: string;
  durationDays: number;
  tiaDeltaDays: number | null;
}

export interface AnalysisWindow {
  start: string;
  end: string | null;
  events: WindowEvent[];
  totals: {
    events: number;
    excusableDays: number;
    compensableDays: number;
    nonExcusableDays: number;
    tiaDeltaDays: number;
  };
}

export interface WindowsResponse {
  scheduleId: string;
  scheduleName: string;
  projectStart: string;
  boundaries: string[];
  method: string;
  unattributedEvents: number;
  windows: AnalysisWindow[];
}

export interface ProlongationResult {
  compensableDays: number;
  prelimsRatePerDay: number;
  amount: number;
  derivation: string;
}

/* -------------------------------- Helpers ----------------------------------- */

export function deLabel(n: number): string {
  return `DE-${String(n).padStart(3, "0")}`;
}

export function clmLabel(n: number): string {
  return `CLM-${String(n).padStart(3, "0")}`;
}

export function causeTone(cause: string): string {
  switch (cause) {
    case "client_change":
    case "late_design_information":
      return "blue";
    case "exceptional_weather":
    case "unforeseen_ground_conditions":
    case "force_majeure":
      return "violet";
    case "authority_or_statutory":
    case "supply_chain":
      return "amber";
    case "contractor_performance":
    case "subcontractor_default":
      return "red";
    default:
      return "gray";
  }
}

export function delayStatusTone(status: string): string {
  switch (status) {
    case "open":
      return "blue";
    case "assessed":
      return "green";
    case "withdrawn":
      return "gray";
    case "closed":
      return "gray";
    default:
      return "gray";
  }
}

export function claimStatusTone(status: string): string {
  switch (status) {
    case "draft":
      return "gray";
    case "submitted":
      return "blue";
    case "assessed":
      return "amber";
    case "agreed":
      return "green";
    case "rejected":
      return "red";
    case "withdrawn":
      return "gray";
    default:
      return "gray";
  }
}

export function claimKindTone(kind: string): string {
  switch (kind) {
    case "delay":
      return "blue";
    case "disruption":
      return "amber";
    case "prolongation":
      return "violet";
    case "acceleration":
      return "green";
    default:
      return "gray";
  }
}

/** Legal state machine mirrored from the API (draft→submitted→assessed→…). */
export const CLAIM_NEXT_STATUSES: Record<string, string[]> = {
  draft: ["submitted", "withdrawn"],
  submitted: ["assessed", "withdrawn"],
  assessed: ["agreed", "rejected", "withdrawn"],
  agreed: [],
  rejected: [],
  withdrawn: [],
};

/* ------------------------------ Components ---------------------------------- */

/** TIA completion-delta chip: "+Nd" red when the completion moves out. */
export function TiaChip({ deltaDays }: { deltaDays: number | null | undefined }) {
  if (deltaDays === null || deltaDays === undefined) {
    return <span className="text-xs text-ink-300">not run</span>;
  }
  const cls =
    deltaDays > 0
      ? "bg-red-100 text-red-800"
      : "bg-emerald-100 text-emerald-800";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 font-mono text-xs font-semibold ${cls}`}
    >
      {deltaDays > 0 ? `+${deltaDays}d` : `${deltaDays}d`}
    </span>
  );
}

/** Excusable / compensable entitlement badges (E / C). */
export function EcBadges({
  excusable,
  compensable,
}: {
  excusable: boolean | number;
  compensable: boolean | number;
}) {
  const exc = Boolean(excusable);
  const comp = Boolean(compensable);
  return (
    <span className="inline-flex gap-1">
      <span
        title={exc ? "Excusable — time relief" : "Non-excusable"}
        className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
          exc ? "bg-blue-100 text-blue-800" : "bg-ink-100 text-ink-400 line-through"
        }`}
      >
        E
      </span>
      <span
        title={comp ? "Compensable — money relief" : "Non-compensable"}
        className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
          comp ? "bg-emerald-100 text-emerald-800" : "bg-ink-100 text-ink-400 line-through"
        }`}
      >
        C
      </span>
    </span>
  );
}

/** Signed slip cell: red when late (+), green when early (−). */
export function SlipCell({ days }: { days: number | null }) {
  if (days === null) return <span className="text-xs text-ink-300">—</span>;
  const cls =
    days > 0 ? "text-red-700" : days < 0 ? "text-emerald-700" : "text-ink-400";
  return (
    <span className={`font-mono text-xs font-semibold ${cls}`}>
      {days > 0 ? `+${days}d` : `${days}d`}
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

/** Amber informational banner (self-assessment 403s, method notes). */
export function InfoBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
      {message}
    </div>
  );
}

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

/** Right-hand slide-over used by the register drawers. */
export function Drawer({
  onClose,
  children,
  wide,
}: {
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink-950/40" onClick={onClose}>
      <div
        className={`h-full w-full overflow-y-auto bg-white p-5 shadow-xl ${wide ? "max-w-2xl" : "max-w-xl"}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">
      {children}
    </div>
  );
}
