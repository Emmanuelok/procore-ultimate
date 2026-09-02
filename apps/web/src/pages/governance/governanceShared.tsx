/**
 * Shared types + small components for the Governance workspace (spec Vol III
 * Domain G / M12): five-case business cases with options appraisal, OGC/IPA
 * style stage gates with RAG delivery confidence, and the benefits register.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../../lib/api";

/* --------------------------------- Types ---------------------------------- */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OptionComputed {
  capexAdjusted: number;
  pvBenefits: number;
  pvCosts: number;
  npv: number;
  bcr: number | null;
  paybackYear: number | null;
}

export interface BcOption {
  id: string;
  name: string;
  isCounterfactual: boolean;
  capex: number;
  annualBenefits: number[];
  annualCosts: number[];
  computed: OptionComputed;
}

export interface AppraisalConfig {
  discountRatePercent?: number;
  appraisalYears?: number;
  optimismBiasPercent?: number;
}

export interface BusinessCaseRow {
  id: string;
  stage: string;
  status: string;
  title: string;
  cases: Record<string, string>;
  appraisal: AppraisalConfig;
  options: BcOption[];
  preferredOptionId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface GateCriterion {
  id: string;
  text: string;
  evidenceRequired: boolean;
}

export interface GateFinding {
  criterionId: string;
  met: boolean;
  note?: string;
}

export interface GateCondition {
  id: string;
  text: string;
  dueDate: string | null;
  obligationId: string;
  closed: boolean;
  closedAt: string | null;
  closedBy: string | null;
  closeNote: string | null;
}

export interface GateReview {
  id: string;
  gateId: string;
  reviewDate: string;
  rag: string;
  decision: string;
  narrative: string | null;
  findings: GateFinding[];
  conditions: GateCondition[];
  reviewedBy: string;
  createdAt: string;
}

export interface StageGateRow {
  id: string;
  gateNumber: number;
  name: string;
  description: string | null;
  criteria: GateCriterion[];
  plannedDate: string | null;
  status: string; // pending | in_review | decided
  latestReview?: { decision: string; rag: string; reviewDate: string } | null;
}

export interface StageGateDetail extends StageGateRow {
  reviews: GateReview[];
}

export interface OpenCondition {
  reviewId: string;
  gateId: string;
  gateNumber: number | null;
  gateName: string | null;
  decision: string;
  conditionId: string;
  text: string;
  dueDate: string | null;
  obligationId: string;
  daysToDue: number | null;
}

export interface BenefitRow {
  id: string;
  number: number;
  name: string;
  description: string | null;
  ownerId: string | null;
  measurementMethod: string | null;
  unit: string;
  baselineValue: number;
  targetValue: number;
  targetDate: string | null;
  isDisbenefit: number;
  status: string;
  latestValue: number | null;
  progressPercent: number | null;
}

export interface BenefitReading {
  id: string;
  readingDate: string;
  value: number;
  note: string | null;
  recordedBy: string;
  createdAt: string;
}

export interface BenefitDetail extends BenefitRow {
  readings: BenefitReading[];
}

/* --------------------------------- Labels --------------------------------- */

const STAGE_META: Record<string, { short: string; label: string; tone: string }> = {
  strategic_outline: { short: "SOC", label: "Strategic outline case", tone: "gray" },
  outline: { short: "OBC", label: "Outline business case", tone: "blue" },
  full: { short: "FBC", label: "Full business case", tone: "violet" },
};

export function stageShort(stage: string): string {
  return STAGE_META[stage]?.short ?? stage.toUpperCase();
}

export function stageLabel(stage: string): string {
  return STAGE_META[stage]?.label ?? stage;
}

export function bcStageTone(stage: string): string {
  return STAGE_META[stage]?.tone ?? "gray";
}

/** The five-state delivery confidence scale (#414). */
export const RAG_META: Record<string, { label: string; chip: string; dot: string }> = {
  green: { label: "Green", chip: "bg-emerald-100 text-emerald-800", dot: "#10b981" },
  amber_green: { label: "Amber/Green", chip: "bg-lime-100 text-lime-800", dot: "#84cc16" },
  amber: { label: "Amber", chip: "bg-amber-100 text-amber-800", dot: "#f59e0b" },
  amber_red: { label: "Amber/Red", chip: "bg-orange-100 text-orange-800", dot: "#f97316" },
  red: { label: "Red", chip: "bg-red-100 text-red-800", dot: "#dc2626" },
};

export function RagChip({ rag }: { rag: string }) {
  const meta = RAG_META[rag] ?? { label: rag, chip: "bg-ink-100 text-ink-700", dot: "#7f8ea4" };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${meta.chip}`}
    >
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: meta.dot }} />
      {meta.label}
    </span>
  );
}

export const DECISION_META: Record<string, { label: string; chip: string; node: string }> = {
  proceed: {
    label: "Proceed",
    chip: "bg-emerald-100 text-emerald-800",
    node: "bg-emerald-500 text-white",
  },
  proceed_with_conditions: {
    label: "Proceed with conditions",
    chip: "bg-amber-100 text-amber-800",
    node: "bg-amber-500 text-white",
  },
  hold: { label: "Hold", chip: "bg-amber-100 text-amber-800", node: "bg-amber-500 text-white" },
  stop: { label: "Stop", chip: "bg-red-100 text-red-800", node: "bg-red-600 text-white" },
};

export function DecisionChip({ decision }: { decision: string }) {
  const meta = DECISION_META[decision] ?? {
    label: decision,
    chip: "bg-ink-100 text-ink-700",
    node: "",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${meta.chip}`}
    >
      {meta.label}
    </span>
  );
}

export function benefitTone(status: string): string {
  switch (status) {
    case "tracking":
      return "blue";
    case "realised":
      return "green";
    case "at_risk":
      return "amber";
    case "missed":
      return "red";
    default:
      return "gray";
  }
}

/* -------------------------------- Numbers --------------------------------- */

export function fmtNum(
  value: number | null | undefined,
  maxDp = 0,
  minDp = 0,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: minDp,
    maximumFractionDigits: maxDp,
  });
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------- Due badge -------------------------------- */

export function DueBadge({ days }: { days: number | null }) {
  if (days === null) {
    return (
      <span className="inline-flex items-center rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-500">
        no due date
      </span>
    );
  }
  const cls =
    days < 0
      ? "bg-red-900 text-red-100"
      : days <= 7
        ? "bg-amber-100 text-amber-800 ring-1 ring-amber-200"
        : "bg-ink-100 text-ink-700";
  const label =
    days < 0
      ? `OVERDUE ${Math.abs(days)}d`
      : days === 0
        ? "due today"
        : `${days}d to due`;
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${cls}`}
    >
      {label}
    </span>
  );
}

/* --------------------------------- Layout --------------------------------- */

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

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">
      {children}
    </div>
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

/* --------------------------------- Users ---------------------------------- */

export function useUsers() {
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    api
      .get<ListResponse<{ id?: string; userId?: string; name: string }>>(
        "/api/v1/company/users?pageSize=200",
      )
      .then((res) =>
        setUsers(res.items.map((u) => ({ id: u.id ?? u.userId ?? "", name: u.name }))),
      )
      .catch(() => setUsers([]));
  }, []);
  const byId = useMemo(() => new Map(users.map((u) => [u.id, u.name])), [users]);
  const nameOf = useCallback(
    (id: string | null | undefined) => (id ? (byId.get(id) ?? "Unknown user") : "—"),
    [byId],
  );
  return { users, nameOf };
}
