/**
 * Shared types, hooks and presentation helpers for the Organisational
 * Learning workspace — spec Vol II Domain W (#976-994) / module M12.
 *
 * Lessons registers fail for two reasons, and this workspace is built around
 * refusing both of them:
 *
 *   · CAPTURE IS VOLUNTARY — so the module raises triggers (and obligations)
 *     off records other modules already write. The UI therefore has to make an
 *     ageing open-trigger backlog *look* like the failure it is, never round it
 *     away into a tidy number.
 *   · RETRIEVAL IS NOBODY'S JOB — so ranking is deterministic and every hit
 *     carries the reasons it surfaced. Those reasons are rendered, always.
 *
 * Honesty rules kept throughout the workspace:
 *   · every server-supplied note, methodology, rationale, ranking explanation
 *     and refusal message is rendered VERBATIM, never paraphrased or hidden;
 *   · a degraded (deterministic) search is labelled as degraded;
 *   · a null metric is "not available" plus the server's reasons — never 0;
 *   · the company register defaults to `status=published`, because a draft is
 *     not organisational memory and must never be counted as one.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { Badge, Card, CardBody } from "../../ui";

/* ---------------------------------- Types ---------------------------------- */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ProjectRow {
  id: string;
  name: string;
  number: string | null;
  stage: string;
}

export type LessonStatus =
  | "draft"
  | "submitted"
  | "validated"
  | "published"
  | "superseded"
  | "rejected";

export interface EvidenceRef {
  tool: string;
  recordId: string;
  label?: string | null;
}

export interface Lesson {
  id: string;
  companyId: string;
  projectId: string | null;
  originProjectId: string | null;
  number: string;
  title: string;
  category: string;
  phase: string | null;
  context: string | null;
  whatHappened: string;
  rootCause: string | null;
  recommendation: string;
  impactValue: number | null;
  impactCurrency: string | null;
  impactDays: number | null;
  tags: string[];
  evidenceRefs: EvidenceRef[];
  status: LessonStatus;
  submittedBy: string | null;
  submittedAt: string | null;
  validatedBy: string | null;
  validatedAt: string | null;
  rejectionReason: string | null;
  publishedAt: string | null;
  supersededById: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Register rows carry the application count the loop-closing view depends on. */
export interface LessonListRow extends Lesson {
  applicationCount: number;
}

/**
 * What actually happened after a lesson was applied (#979, #981-984).
 *
 * `unknown` is a real answer and the default: an application whose outcome
 * nobody measured must not be counted as a success, which is precisely how
 * lessons registers come to report impact they never had.
 */
export const LESSON_OUTCOMES = [
  "unknown",
  "avoided",
  "partially_avoided",
  "no_effect",
  "counterproductive",
] as const;

export const LESSON_OUTCOME_LABELS: Record<string, string> = {
  unknown: "Not yet measured",
  avoided: "The problem was avoided",
  partially_avoided: "Partly avoided",
  no_effect: "No effect",
  counterproductive: "Made it worse",
};

export interface LessonApplication {
  id: string;
  companyId: string;
  lessonId: string;
  projectId: string;
  appliedTo: { tool?: string; recordId?: string; label?: string | null } | null;
  action: string;
  outcome: string | null;
  outcomeNote: string | null;
  outcomeValue: number | null;
  outcomeCurrency: string | null;
  outcomeDays: number | null;
  measuredAt: string | null;
  measuredBy: string | null;
  appliedBy: string;
  appliedAt: string;
  /** present on the impact report only */
  projectName?: string | null;
  crossedProjectBoundary?: boolean;
}

/**
 * An AI PROPOSAL for a lesson, from the record that obliged its capture.
 *
 * `created` is always false and the trigger stays open: a lesson nobody chose
 * to write is a lesson nobody stands behind, and the validation step that
 * follows would then be checking a machine's work against nothing.
 */
export interface LessonDraft {
  triggerId: string;
  runId: string | null;
  aiAvailable: boolean;
  created: false;
  proposal: {
    title: string | null;
    whatHappened: string | null;
    rootCause: string | null;
    recommendation: string | null;
    category: string | null;
    tags: string[];
  } | null;
  confidence: number | null;
  citations: { recordId: string; excerpt: string | null }[];
  evidenceRefs: { tool: string; recordId: string; label: string }[];
  note: string;
}

/**
 * Applied-lesson outcome measurement (#979, #981-984).
 *
 * `effectiveness` is computed over MEASURED applications only, with the
 * denominator stated: an unmeasured application is not a successful one, and a
 * register that reads it as one reports impact it never had.
 */
export interface LessonOutcomes {
  lessonId: string;
  number: string;
  applications: number;
  measured: number;
  unmeasured: number;
  byOutcome: Record<string, number>;
  effectiveness: { value: number | null; denominator: number; reasons: string[] };
  valueByCurrency: { currency: string; value: number; applications: number }[];
  daysAvoided: number | null;
  daysMeasuredOn: number;
  reasons: string[];
  items: LessonApplication[];
}

export interface LessonDetail extends Lesson {
  applicationCount: number;
  applications: LessonApplication[];
  trigger: Trigger | null;
  supersededBy: { id: string; number: string; title: string } | null;
}

export interface ImpactProject {
  projectId: string;
  projectName: string | null;
  isOriginProject: boolean;
  applications: number;
  firstAppliedAt: string | null;
  lastAppliedAt: string | null;
}

export interface LessonImpact {
  lesson: {
    id: string;
    number: string;
    title: string;
    status: LessonStatus;
    category: string;
    phase: string | null;
    originProjectId: string | null;
    publishedAt: string | null;
    impactValue: number | null;
    impactCurrency: string | null;
    impactDays: number | null;
  };
  applicationCount: number;
  crossProjectApplicationCount: number;
  crossedProjectBoundary: boolean;
  projectsReached: number;
  projects: ImpactProject[];
  outcomesRecorded: number;
  applications: LessonApplication[];
  /** the server's own verdict on whether this lesson changed anything */
  note: string;
}

export type TriggerStatus = "open" | "captured" | "dismissed";

export interface Trigger {
  id: string;
  companyId: string;
  projectId: string;
  kind: string;
  sourceRef: { tool?: string; recordId?: string; label?: string | null } | null;
  rationale: string;
  dueAt: string | null;
  obligationId: string | null;
  lessonId: string | null;
  status: TriggerStatus;
  dismissedReason: string | null;
  dismissedBy: string | null;
  raisedAt: string;
  closedAt: string | null;
}

export interface TriggerRow extends Trigger {
  ageDays: number;
  overdue: boolean;
}

export interface TriggerRule {
  kind: string;
  name: string;
  /** which platform records the rule reads, in the server's own prose */
  reads: string;
  dueDays: number;
}

export interface SweepResult {
  scanned: number;
  created: number;
  alreadyOpen: number;
  createdTriggerIds: string[];
  threshold: { value: number; source: string };
  rules?: TriggerRule[];
  note?: string;
}

export interface TriggerListResponse extends ListResponse<TriggerRow> {
  /** the lazy sweep the read itself performed */
  sweep: SweepResult;
}

export interface RelevanceReason {
  code:
    | "category_match"
    | "tool_affinity"
    | "tool_tag"
    | "phase_match"
    | "tag_overlap"
    | "impact_magnitude"
    | "recency"
    | "previously_applied";
  points: number;
  detail: string;
}

export interface RelevantItem {
  lesson: Lesson;
  applicationCount: number;
  score: number;
  reasons: RelevanceReason[];
}

export interface RelevantResponse {
  query: {
    tool: string | null;
    category: string | null;
    phase: string | null;
    tags: string[];
    toolImpliesCategories: string[];
  };
  registerSize: number;
  matched: number;
  items: RelevantItem[];
  /** how the ranking works, in the server's words — the feature is that it is arguable */
  ranking: string;
}

export interface SearchCitation {
  lessonId: string;
  number: string;
  title: string;
  excerpt?: string;
}

export interface SearchResult {
  lesson: Lesson;
  score: number;
  matchedTerms: string[];
  matchedFields: string[];
  why: string;
}

export interface SearchResponse {
  mode: "ai" | "deterministic";
  aiAvailable: boolean;
  /** ALWAYS rendered verbatim: in deterministic mode it names what is missing */
  note: string;
  runId: string | null;
  answer: string | null;
  confidence: number | null;
  citations: SearchCitation[];
  results: SearchResult[];
  registerSize: number;
}

export interface OldestOpenTrigger {
  id: string;
  projectId: string;
  kind: string;
  rationale: string;
  dueAt: string | null;
  ageDays: number;
}

export interface LearningSummary {
  triggers: {
    raised: number;
    open: number;
    captured: number;
    dismissed: number;
    openByAge: Record<string, number>;
    oldestOpenDays: number | null;
    byKind: Record<string, number>;
    oldestOpen: OldestOpenTrigger[];
  };
  captureRate: {
    raised: number;
    discharged: number;
    dismissed: number;
    open: number;
    percent: number | null;
    note: string;
  };
  lessons: { total: number; byStatus: Record<string, number>; published: number };
  publishedNeverApplied: {
    count: number;
    percentOfPublished: number | null;
    lessons: {
      lessonId: string;
      number: string;
      title: string;
      category: string;
      impactValue: number | null;
      impactCurrency: string | null;
      publishedAt: string | null;
    }[];
  };
  mostApplied: {
    lessonId: string;
    number: string;
    title: string;
    category: string;
    applications: number;
    projects: number;
  }[];
  applications: { total: number; crossProject: number };
}

export type ReviewStatus =
  | "scheduled"
  | "in_progress"
  | "completed"
  | "signed_off"
  | "cancelled";

export interface ReviewParticipant {
  userId?: string | null;
  name: string;
  role?: string | null;
}

export interface ReviewFinding {
  id?: string;
  text: string;
  category?: string | null;
  lessonId?: string | null;
}

export interface ReviewMetric {
  key: string;
  name: string;
  unit: string;
  /** null is a FIRST-CLASS RESULT: the platform does not hold the inputs */
  value: number | null;
  inputs: Record<string, unknown>;
  /** why value is null — rendered verbatim, never summarised away */
  reasons: string[];
}

export interface ReviewMetricsResult {
  computedAt: string;
  projectId: string;
  currency: string | null;
  metrics: ReviewMetric[];
  unavailable: string[];
  methodology: string;
}

export interface Review {
  id: string;
  companyId: string;
  projectId: string;
  title: string;
  status: ReviewStatus;
  scheduledFor: string | null;
  heldAt: string | null;
  facilitator: string | null;
  participants: ReviewParticipant[];
  /** the last computed metrics result, persisted on the review */
  metrics: Partial<ReviewMetricsResult> | null;
  findings: ReviewFinding[];
  whatWentWell: string | null;
  whatDidNot: string | null;
  signedOffBy: string | null;
  signedOffAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The server's review state machine, mirrored so the UI never offers an
 * impossible transition (`signed_off` is terminal; `completed` needs heldAt).
 */
export const REVIEW_TRANSITIONS: Record<ReviewStatus, ReviewStatus[]> = {
  scheduled: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: ["in_progress"],
  signed_off: [],
  cancelled: ["scheduled"],
};

/* -------------------------------- Formatting -------------------------------- */

export const BRAND = "#1d60f1";
export const BRAND_PALE = "#cddcfe";
export const GRID = "#ebedf1";
export const AXIS_INK = "#7f8ea4";
export const MARK_INK = "#4b5a72";

/** Age buckets get progressively uglier — an old backlog should look bad. */
export const AGE_BUCKETS = ["0-7", "8-30", "31-90", "90+"] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

export const AGE_COLOR: Record<AgeBucket, string> = {
  "0-7": "#059669",
  "8-30": "#d97706",
  "31-90": "#ea580c",
  "90+": "#dc2626",
};

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function fmtNum(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: dp });
}

export function fmtPercent(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "—";
  return `${fmtNum(p, 1)}%`;
}

export function label(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .split(/[_\s]+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function projectLabel(p: ProjectRow): string {
  return p.number ? `${p.number} — ${p.name}` : p.name;
}

/** Impact in the lesson's own currency plus its day impact, when recorded. */
export function impactLabel(
  value: number | null | undefined,
  currency: string | null | undefined,
  days: number | null | undefined,
): string {
  const parts: string[] = [];
  if (value !== null && value !== undefined && Number.isFinite(value)) {
    try {
      parts.push(
        new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: currency || "USD",
          maximumFractionDigits: 0,
        }).format(value),
      );
    } catch {
      parts.push(`${fmtNum(value, 0)} ${currency ?? ""}`.trim());
    }
  }
  if (days !== null && days !== undefined && Number.isFinite(days)) {
    parts.push(`${days > 0 ? "+" : ""}${fmtInt(days)}d`);
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
}

export function lessonStatusTone(status: string): string {
  switch (status) {
    case "published":
      return "green";
    case "validated":
      return "blue";
    case "submitted":
      return "violet";
    case "rejected":
      return "red";
    case "superseded":
      return "gray";
    default:
      return "amber"; // draft
  }
}

export function triggerStatusTone(status: string): string {
  switch (status) {
    case "captured":
      return "green";
    case "dismissed":
      return "gray";
    default:
      return "red"; // open — the backlog, and it should read as debt
  }
}

export function reviewStatusTone(status: string): string {
  switch (status) {
    case "signed_off":
      return "green";
    case "completed":
      return "blue";
    case "in_progress":
      return "violet";
    case "cancelled":
      return "gray";
    default:
      return "amber"; // scheduled
  }
}

export const REASON_LABEL: Record<RelevanceReason["code"], string> = {
  category_match: "Category match",
  tool_affinity: "Tool affinity",
  tool_tag: "Tool tag",
  phase_match: "Phase match",
  tag_overlap: "Tag overlap",
  impact_magnitude: "Impact magnitude",
  recency: "Recency",
  previously_applied: "Previously applied",
};

/** csv text field ("delay, design") → normalized tag list. */
export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/* ---------------------------------- Hooks ---------------------------------- */

/** Company project list — the picker every project-scoped tab needs. */
export function useProjects(): {
  projects: ProjectRow[] | null;
  error: string | null;
  reload: () => void;
} {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<ProjectRow>>("/api/v1/projects?page=1&pageSize=200");
      setProjects(res.items);
    } catch (err) {
      setProjects((prev) => prev ?? []);
      setError(errorMessage(err, "Failed to load projects"));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { projects, error, reload: () => void load() };
}

/** id → display label, so an application on another project reads as a place. */
export function projectNameOf(
  projects: ProjectRow[] | null,
  projectId: string | null | undefined,
): string {
  if (!projectId) return "—";
  const hit = projects?.find((p) => p.id === projectId);
  return hit ? projectLabel(hit) : projectId;
}

/* ------------------------------- Components -------------------------------- */

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
        className={`h-full overflow-y-auto bg-white p-5 shadow-xl ${wide ? "w-full max-w-3xl" : "w-full max-w-lg"}`}
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
 * A failed load is not an empty register. Rendering "nothing here" over a
 * failed request would be the quietest possible lie.
 */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-red-200 bg-red-50/40 px-6 py-12 text-center">
      <p className="text-sm font-medium text-red-800">This view could not be loaded</p>
      <p className="mt-1 max-w-md text-xs text-red-700">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-ink-800 ring-1 ring-ink-200 hover:bg-ink-50"
      >
        Retry
      </button>
    </div>
  );
}

/** A server-supplied note, rendered exactly as sent. */
export function NoteCard({
  note,
  tone = "brand",
  title,
}: {
  note: string | null | undefined;
  tone?: "brand" | "amber" | "red" | "ink";
  title?: string;
}) {
  if (!note) return null;
  const cls =
    tone === "amber"
      ? "bg-amber-50 text-amber-900 ring-amber-200"
      : tone === "red"
        ? "bg-red-50 text-red-900 ring-red-200"
        : tone === "ink"
          ? "bg-ink-50 text-ink-700 ring-ink-200"
          : "bg-brand-50 text-brand-900 ring-brand-100";
  return (
    <div className={`rounded-md px-3 py-2 text-sm leading-relaxed ring-1 ${cls}`}>
      {title ? <span className="font-semibold">{title} </span> : null}
      {note}
    </div>
  );
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-2">
      <h2 className="text-sm font-semibold text-ink-900">{children}</h2>
      {hint ? <p className="mt-0.5 text-xs text-ink-400">{hint}</p> : null}
    </div>
  );
}

export function Stat({
  label: statLabel,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "default" | "bad" | "good";
}) {
  const ring =
    tone === "bad" ? "ring-2 ring-red-200" : tone === "good" ? "ring-2 ring-emerald-200" : undefined;
  const valueCls =
    tone === "bad" ? "text-red-700" : tone === "good" ? "text-emerald-700" : "text-ink-900";
  return (
    <Card className={ring}>
      <CardBody className="px-4 py-3">
        <div className={`text-xl font-bold tabular-nums ${valueCls}`}>{value}</div>
        <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-ink-400">
          {statLabel}
        </div>
        {hint ? <div className="mt-0.5 text-xs text-ink-400">{hint}</div> : null}
      </CardBody>
    </Card>
  );
}

export function TagList({ tags }: { tags: string[] | null | undefined }) {
  if (!tags || tags.length === 0) return <span className="text-xs text-ink-300">no tags</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-medium text-ink-600"
        >
          {t}
        </span>
      ))}
    </span>
  );
}

/** { tool, recordId, label } refs — the evidence a lesson is anchored to. */
export function RefLine({ refs }: { refs: EvidenceRef[] | null | undefined }) {
  if (!refs || refs.length === 0) {
    return <p className="text-xs text-ink-400">No evidence references recorded.</p>;
  }
  return (
    <ul className="space-y-1">
      {refs.map((r, i) => (
        <li key={`${r.tool}-${r.recordId}-${i}`} className="text-xs text-ink-600">
          <Badge tone="gray">{label(r.tool)}</Badge>{" "}
          <span className="font-medium text-ink-800">{r.label || r.recordId}</span>{" "}
          <span className="font-mono text-[10px] text-ink-400">{r.recordId}</span>
        </li>
      ))}
    </ul>
  );
}

/** Key/value line used throughout the drawers. */
export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 py-0.5 text-sm">
      <span className="min-w-32 text-xs font-medium uppercase tracking-wide text-ink-400">{k}</span>
      <span className="text-ink-800">{v}</span>
    </div>
  );
}

/** Long free text preserved as written (root cause, recommendation, …). */
export function Prose({ text }: { text: string | null | undefined }) {
  if (!text || !text.trim()) return <p className="text-xs text-ink-300">—</p>;
  return <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-700">{text}</p>;
}
