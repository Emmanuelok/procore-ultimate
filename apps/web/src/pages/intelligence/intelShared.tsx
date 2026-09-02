/**
 * Shared wire shapes and panels of the intelligence layer, used by the
 * company Pulse (pages/pulse) and the project intelligence tab
 * (pages/intelligence). Spec Vol I §6.1–6.3 (#731–758), §7 (#776–789).
 *
 * Everything here renders exactly what /api/v1/pulse, /attention and
 * /projects/:id/health return. The honesty rules: a figure the API did not
 * return is "—" with its reason, never 0; an unrated dimension shows why;
 * every panel fails alone with its own loading, error and empty states.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Drawer,
  EmptyState,
  ErrorAlert,
  Field,
  Progress,
  ProgressRing,
  Skeleton,
  Sparkline,
  Textarea,
  Timeline,
  formatNumber,
  formatRelativeTime,
  formatStatusLabel,
  severityToTone,
  type DataColumns,
  type TimelineItem,
  type Tone,
} from "../../ui";
import { cx } from "../../ui/cx";
import {
  IconAi,
  IconArrowRight,
  IconCheckCircle,
  IconInsight,
  IconLoader,
  IconRefresh,
  IconTarget,
  IconWarning,
} from "../../ui/icons";
import { formatDate, formatDateTime } from "../format";

/* ==========================================================================
   Wire shapes — plan §3.1
========================================================================== */

export type HealthLevel = "on_track" | "watch" | "off_track" | "unrated";

export interface HealthDimension {
  key: string;
  score: number | null;
  level: HealthLevel;
  basis: string;
  inputs: Record<string, unknown>;
}

export interface HealthTrendPoint {
  at: string;
  score: number | null;
}

export interface ProjectHealth {
  projectId: string;
  projectName?: string | null;
  stage?: string | null;
  currency?: string | null;
  level: HealthLevel;
  score: number | null;
  dimensions: HealthDimension[];
  computedAt: string;
  trend: HealthTrendPoint[];
  ratedDimensions?: number;
  basis?: string;
  snapshotId?: string | null;
  computedOnRead?: boolean;
  levelChanged?: boolean;
  previousLevel?: HealthLevel | null;
}

export interface AttentionItem {
  id: string;
  projectId: string | null;
  projectName: string | null;
  kind: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  detail: string;
  dueAt: string | null;
  href: string;
  sourceType: string;
  sourceId: string;
  score: number;
  money?: number | null;
  currency?: string | null;
  status?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export interface AttentionList {
  items: AttentionItem[];
  total: number;
}

export interface PulseChanges {
  since: string | null;
  levelChanges: Array<{
    projectId: string;
    projectName: string | null;
    from: HealthLevel;
    to: HealthLevel;
    scoreFrom: number | null;
    scoreTo: number | null;
  }>;
  newAttention: number;
  resolvedAttention: number;
  openAttentionFrom: number | null;
  openAttentionTo: number;
}

export interface BriefingSummary {
  text: string | null;
  runId: string | null;
  reason: string | null;
  id?: string | null;
  generatedAt?: string | null;
  headline?: string | null;
  proposals?: number;
}

export interface PulseResponse {
  generatedAt: string;
  portfolio: {
    projects: number;
    byStage: Record<string, number>;
    byHealth: Record<HealthLevel, number>;
  };
  attention: AttentionItem[];
  attentionBySeverity: Record<string, number>;
  openAttention: number;
  scores: ProjectHealth[];
  briefing: BriefingSummary;
  changes: PulseChanges;
  computedOnRead: boolean;
}

export interface BriefingCitation {
  ref: number;
  sourceType: string;
  sourceId: string;
  label: string;
  projectId: string | null;
}

export interface BriefingProposal {
  title: string;
  rationale: string;
  kind: string;
  attentionId: string | null;
  citations: number[];
  reviewId: string;
}

export interface BriefingView {
  id: string;
  projectId: string | null;
  runId: string;
  headline: string;
  summary: string;
  highlights: Array<{ text: string; citations: number[] }>;
  citations: BriefingCitation[];
  proposals: BriefingProposal[];
  reviewIds: string[];
  requestedBy: string;
  generatedAt: string;
}

export interface BriefingLatest {
  briefing: BriefingView | null;
  reason: string | null;
  aiEnabled: boolean;
}

export interface AgentRun {
  id: string;
  projectId?: string | null;
  agentKind: string;
  status: string;
  model: string;
  latencyMs: number | null;
  requestedBy: string;
  createdAt: string;
  citations: number;
}

export interface ActivityResponse {
  runs: AgentRun[];
  pendingProposals: number;
  briefings?: BriefingView[];
  aiEnabled: boolean;
}

export interface HealthHistoryItem {
  id: string;
  computedAt: string;
  level: HealthLevel;
  score: number | null;
  ratedDimensions: number;
  trigger: string;
  dimensions: HealthDimension[];
}

export interface HealthHistory {
  items: HealthHistoryItem[];
  days: number;
}

/* ==========================================================================
   Vocabulary
========================================================================== */

export const LEVEL_META: Record<HealthLevel, { label: string; tone: Tone; short: string }> = {
  on_track: { label: "On track", tone: "success", short: "On track" },
  watch: { label: "On watch", tone: "warning", short: "Watch" },
  off_track: { label: "Off track", tone: "danger", short: "Off track" },
  unrated: { label: "Unrated", tone: "neutral", short: "Unrated" },
};

export const LEVEL_ORDER: HealthLevel[] = ["off_track", "watch", "on_track", "unrated"];

export const DIMENSION_META: Record<string, { label: string; hint: string }> = {
  schedule: { label: "Schedule", hint: "Forecast finish vs the project finish, overdue and critical tasks, slipped milestones." },
  cost: { label: "Cost", hint: "Forecast final vs the revised budget and pending change exposure, in the budget's currency." },
  commercial: { label: "Commercial", hint: "Open change-event exposure against the budget, aged change events, pending commitments." },
  assurance: { label: "Assurance", hint: "Open integrity signals by severity and contradicted or unsupported reconciliations." },
  safety: { label: "Safety", hint: "Incidents in the last 90 days by severity, open incidents, overdue corrective actions." },
  quality: { label: "Quality", hint: "Open NCRs by severity, overdue responses, failed ITP activities and pending hold points." },
  field: { label: "Field", hint: "Overdue RFIs, submittals past submit-by and overdue punch items." },
  contract: { label: "Contract", hint: "Time-barred events, notice deadlines within 7 days, breached and imminent obligations." },
  risk: { label: "Risk", hint: "Live risks scored high (P×I ≥ 15) and risks that have been realised." },
  finance: { label: "Finance", hint: "Covenant breaches at the latest reading, deemed or suspended payment claims, overdue facility conditions." },
};

const KIND_LABEL: Record<string, string> = {
  obligation_due: "Obligation",
  time_bar: "Time bar",
  signal: "Integrity signal",
  payment_due: "Payment claim",
  overdue_rfi: "Overdue RFI",
  overdue_submittal: "Overdue submittal",
  safety_incident: "Safety incident",
  ncr_open: "Open NCR",
  schedule_slip: "Schedule slip",
  budget_overrun: "Budget overrun",
  invoice_hold: "Payment hold",
  agent_proposal: "Agent proposal",
  grievance_sla: "Grievance SLA",
  permit_expiry: "Permit expiry",
  insurance_expiry: "Insurance expiry",
  cert_expiry: "Certificate expiry",
  automation_failed: "Automation failed",
  covenant_breach: "Covenant breach",
  change_exposure: "Change event",
  punch_overdue: "Overdue punch",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? formatStatusLabel(kind);
}

export function dimensionLabel(key: string): string {
  return DIMENSION_META[key]?.label ?? formatStatusLabel(key);
}

export function errorMessage(err: unknown, fallback = "The request failed."): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** Days until (negative = overdue); null without a date. */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.round((t - Date.now()) / 86_400_000);
}

export function dueLabel(iso: string | null | undefined): string {
  const d = daysUntil(iso);
  if (d === null) return "No deadline";
  if (d < 0) return `${Math.abs(d)} day${Math.abs(d) === 1 ? "" : "s"} overdue`;
  if (d === 0) return "Due today";
  return `Due in ${d} day${d === 1 ? "" : "s"}`;
}

function formatInputValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return Number.isInteger(value) ? formatNumber(value) : formatNumber(value, { precision: 1 });
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** Flatten one level of nested objects so `openSignals.critical` reads as a row. */
export function flattenInputs(inputs: Record<string, unknown>): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const [k, v] of Object.entries(inputs)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        out.push({ key: `${formatStatusLabel(k)} · ${formatStatusLabel(k2)}`, value: formatInputValue(v2) });
      }
    } else {
      out.push({ key: formatStatusLabel(k), value: formatInputValue(v) });
    }
  }
  return out;
}

/* ==========================================================================
   Small building blocks
========================================================================== */

export function LevelBadge({ level, size = "sm" }: { level: HealthLevel; size?: "xs" | "sm" }) {
  const meta = LEVEL_META[level];
  return (
    <Badge tone={meta.tone} dot size={size}>
      {meta.label}
    </Badge>
  );
}

export function SeverityBadge({ severity, size = "xs" }: { severity: string; size?: "xs" | "sm" }) {
  return (
    <Badge tone={severityToTone(severity)} dot size={size}>
      {formatStatusLabel(severity)}
    </Badge>
  );
}

/** The score as a ring. A null score is a ring with no fill and a dash — never 0. */
export function ScoreRing({ score, level, size = 56, thickness = 5 }: { score: number | null; level: HealthLevel; size?: number; thickness?: number }) {
  return (
    <ProgressRing
      value={score ?? 0}
      max={100}
      size={size}
      thickness={thickness}
      tone={LEVEL_META[level].tone}
      label={
        <span className={cx("font-semibold tabular-nums text-content", size >= 72 ? "text-lg" : "text-sm")}>
          {score === null ? "—" : score}
        </span>
      }
      aria-label={score === null ? "Health score not available" : `Health score ${score} of 100`}
    />
  );
}

export function TrendSparkline({ trend, width = 120, height = 28 }: { trend: HealthTrendPoint[]; width?: number; height?: number }) {
  if (trend.length < 2) {
    return (
      <span className="text-2xs text-content-subtle" title="The trend needs at least two daily snapshots.">
        {trend.length === 0 ? "No history yet" : "One snapshot so far"}
      </span>
    );
  }
  return (
    <Sparkline
      data={trend.map((t) => t.score)}
      width={width}
      height={height}
      colorByDelta
      higherIsBetter
      ariaLabel={`Health score over the last ${trend.length} days`}
    />
  );
}

export function PanelSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} variant="text" width={`${90 - i * 12}%`} />
      ))}
    </div>
  );
}

/* ==========================================================================
   Health dimensions
========================================================================== */

export function DimensionList({
  dimensions,
  onSelect,
  compact = false,
}: {
  dimensions: HealthDimension[];
  onSelect?: (dimension: HealthDimension) => void;
  compact?: boolean;
}) {
  if (dimensions.length === 0) {
    return (
      <EmptyState
        size="sm"
        icon={IconInsight}
        title="No dimensions computed yet"
        hint="Health is computed on first read and every fifteen minutes after that."
      />
    );
  }
  return (
    <ul className="divide-y divide-border">
      {dimensions.map((d) => {
        const meta = LEVEL_META[d.level];
        const body = (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-body font-medium text-content">{dimensionLabel(d.key)}</span>
                <LevelBadge level={d.level} size="xs" />
              </span>
              <span className={cx("shrink-0 tabular-nums", d.score === null ? "text-content-subtle" : "font-semibold text-content")}>
                {d.score === null ? "—" : `${d.score}/100`}
              </span>
            </div>
            <Progress
              className="mt-1.5"
              value={d.score}
              max={100}
              size="xs"
              tone={meta.tone}
              aria-label={`${dimensionLabel(d.key)} score`}
            />
            {!compact ? <p className="mt-1.5 text-meta leading-snug text-content-muted">{d.basis}</p> : null}
          </>
        );
        return (
          <li key={d.key}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(d)}
                className="block w-full rounded-md px-3 py-2.5 text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {body}
              </button>
            ) : (
              <div className="px-3 py-2.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function DimensionDrawer({ dimension, onClose }: { dimension: HealthDimension | null; onClose: () => void }) {
  const rows = dimension ? flattenInputs(dimension.inputs) : [];
  return (
    <Drawer
      open={dimension !== null}
      onClose={onClose}
      size="md"
      icon={IconTarget}
      title={dimension ? `${dimensionLabel(dimension.key)} — the basis` : "Dimension"}
      description={dimension ? DIMENSION_META[dimension.key]?.hint : undefined}
    >
      {dimension ? (
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <ScoreRing score={dimension.score} level={dimension.level} size={72} thickness={6} />
            <div className="min-w-0">
              <LevelBadge level={dimension.level} />
              <p className="mt-2 text-body leading-relaxed text-content">{dimension.basis}</p>
            </div>
          </div>
          <div>
            <h4 className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-content-subtle">Inputs the score was derived from</h4>
            {rows.length === 0 ? (
              <p className="text-meta text-content-subtle">
                No inputs — this dimension is unrated because the platform holds no records for it. The reason is the basis above.
              </p>
            ) : (
              <dl className="divide-y divide-border rounded-md border border-border">
                {rows.map((r) => (
                  <div key={r.key} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
                    <dt className="text-meta text-content-muted">{r.key}</dt>
                    <dd className="text-meta tabular-nums text-content">{r.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}

/* ==========================================================================
   Attention
========================================================================== */

export function AttentionTable({
  items,
  loading,
  error,
  onRetry,
  onSelect,
  showProject = true,
  emptyTitle = "Nothing needs your attention",
  emptyHint = "Every obligation, deadline, signal and overdue record the platform holds is within tolerance.",
  tableId,
}: {
  items: AttentionItem[];
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  onSelect: (item: AttentionItem) => void;
  showProject?: boolean;
  emptyTitle?: ReactNode;
  emptyHint?: ReactNode;
  tableId?: string;
}) {
  const columns = useMemo<DataColumns<AttentionItem>>(() => {
    const cols: Array<DataColumns<AttentionItem>[number]> = [
      {
        id: "severity",
        header: "Severity",
        headerText: "Severity",
        accessor: "severity",
        width: 110,
        cell: ({ row }) => <SeverityBadge severity={row.severity} />,
      },
      {
        id: "title",
        header: "What",
        headerText: "What",
        accessor: "title",
        width: 360,
        minWidth: 220,
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate font-medium text-content">{row.title}</span>
            <span className="truncate text-meta text-content-subtle">{row.detail}</span>
          </span>
        ),
      },
    ];
    if (showProject) {
      cols.push({
        id: "project",
        header: "Project",
        headerText: "Project",
        accessor: (row) => row.projectName ?? "",
        width: 160,
        cell: ({ row }) => <span className="truncate text-content">{row.projectName ?? <span className="text-content-subtle">Company</span>}</span>,
      });
    }
    cols.push(
      {
        id: "kind",
        header: "Kind",
        headerText: "Kind",
        accessor: (row) => kindLabel(row.kind),
        width: 140,
        cell: ({ row }) => <Badge tone="neutral" size="xs">{kindLabel(row.kind)}</Badge>,
      },
      {
        id: "due",
        header: "Due",
        headerText: "Due",
        accessor: (row) => (row.dueAt ? Date.parse(row.dueAt) : Number.POSITIVE_INFINITY),
        type: "number",
        width: 150,
        align: "left",
        cell: ({ row }) => {
          const d = daysUntil(row.dueAt);
          return (
            <span className="flex flex-col leading-tight">
              <span className={cx("text-body", d !== null && d < 0 ? "font-medium text-danger-fg" : "text-content")}>{dueLabel(row.dueAt)}</span>
              {row.dueAt ? <span className="text-2xs text-content-subtle">{formatDate(row.dueAt)}</span> : null}
            </span>
          );
        },
      },
      {
        id: "money",
        header: "At stake",
        headerText: "At stake",
        headerTooltip: "The amount on the source record, in its own currency. Never converted or summed.",
        accessor: (row) => row.money ?? null,
        type: "number",
        align: "right",
        width: 130,
        cell: ({ row }) =>
          row.money === null || row.money === undefined ? (
            <span className="text-content-subtle" title="The source record carries no amount">
              —
            </span>
          ) : (
            <span className="tabular-nums">
              {formatNumber(row.money, { compact: true })} {row.currency ?? ""}
            </span>
          ),
      },
      {
        id: "score",
        header: "Rank",
        headerText: "Rank",
        headerTooltip: "Severity × urgency × money. The feed's sort key.",
        accessor: "score",
        type: "number",
        align: "right",
        width: 90,
        cell: ({ row }) => <span className="tabular-nums text-content-muted">{formatNumber(row.score, { precision: 0 })}</span>,
      },
    );
    return cols;
  }, [showProject]);

  return (
    <DataTable<AttentionItem>
      data={items}
      columns={columns}
      tableId={tableId}
      loading={loading}
      error={error}
      onRetry={onRetry}
      onRowClick={({ row }) => onSelect(row)}
      rowTone={(row) => severityToTone(row.severity)}
      defaultSort={[{ id: "score", desc: true }]}
      searchable
      searchPlaceholder="Search attention items…"
      columnPicker={false}
      densityToggle={false}
      filterBuilder={false}
      savedViews={false}
      exportable={false}
      empty={{ title: emptyTitle, description: emptyHint, icon: IconCheckCircle }}
      aria-label="Attention items"
    />
  );
}

export function AttentionDrawer({
  item,
  onClose,
  canAct,
  onDismiss,
  onReopen,
  busy,
}: {
  item: AttentionItem | null;
  onClose: () => void;
  canAct: boolean;
  onDismiss: (item: AttentionItem, reason: string) => Promise<void>;
  onReopen: (item: AttentionItem) => Promise<void>;
  busy: boolean;
}) {
  const navigate = useNavigate();
  const [reason, setReason] = useState("");
  const dismissed = item?.status === "dismissed";
  return (
    <Drawer
      open={item !== null}
      onClose={onClose}
      size="md"
      icon={IconWarning}
      tone={item ? severityToTone(item.severity) : undefined}
      title={item?.title ?? "Attention item"}
      description={item ? `${kindLabel(item.kind)} · ${item.projectName ?? "Company-wide"}` : undefined}
      footer={
        item ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <Button variant="secondary" size="sm" trailingIcon={IconArrowRight} onClick={() => navigate(item.href)}>
              Open the record
            </Button>
            {canAct ? (
              dismissed ? (
                <Button size="sm" variant="secondary" loading={busy} onClick={() => void onReopen(item)}>
                  Reopen
                </Button>
              ) : (
                <Button size="sm" loading={busy} onClick={() => void onDismiss(item, reason.trim())}>
                  Dismiss
                </Button>
              )
            ) : null}
          </div>
        ) : null
      }
    >
      {item ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={item.severity} size="sm" />
            <Badge tone="neutral">{kindLabel(item.kind)}</Badge>
            {item.status && item.status !== "open" ? <Badge tone={item.status === "dismissed" ? "warning" : "success"}>{formatStatusLabel(item.status)}</Badge> : null}
          </div>
          <p className="text-body leading-relaxed text-content">{item.detail}</p>
          <dl className="divide-y divide-border rounded-md border border-border">
            <Row label="Deadline" value={item.dueAt ? `${formatDateTime(item.dueAt)} · ${dueLabel(item.dueAt)}` : "No deadline on the source record"} />
            <Row
              label="At stake"
              value={
                item.money === null || item.money === undefined
                  ? "Not available — the source record carries no amount"
                  : `${formatNumber(item.money)} ${item.currency ?? ""}`
              }
            />
            <Row label="Rank" value={`${formatNumber(item.score, { precision: 0 })} (severity × urgency × money)`} />
            <Row label="Source" value={`${formatStatusLabel(item.sourceType)} ${item.sourceId}`} mono />
            {item.firstSeenAt ? <Row label="First seen" value={`${formatDateTime(item.firstSeenAt)} (${formatRelativeTime(item.firstSeenAt)})`} /> : null}
          </dl>
          {canAct && !dismissed ? (
            <Field label="Reason for dismissing" hint="Recorded on the ledger with your name. Leave blank if the item simply needs no action.">
              <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Answered by phone, closing tomorrow" />
            </Field>
          ) : null}
          {!canAct ? (
            <p className="text-meta text-content-subtle">You can read this item but not set it aside — that needs standard access to intelligence on the project.</p>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}

function Row({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 py-1.5">
      <dt className="shrink-0 text-meta text-content-muted">{label}</dt>
      <dd className={cx("min-w-0 text-right text-meta text-content", mono && "break-all font-mono text-2xs")}>{value}</dd>
    </div>
  );
}

/* ==========================================================================
   Briefing
========================================================================== */

export function briefingReasonText(reason: string | null | undefined): string {
  switch (reason) {
    case "ai_disabled":
      return "AI is not configured on this server (no ANTHROPIC_API_KEY), so no briefing can be written. Everything else on this page works without it.";
    case "never_generated":
      return "No briefing has been written yet.";
    case "restricted_scope":
      return "The company briefing is written over every project; it is shown only to people who can see all of them.";
    default:
      return reason ? formatStatusLabel(reason) : "No briefing available.";
  }
}

export function BriefingCard({
  briefing,
  reason,
  aiEnabled,
  canGenerate,
  onGenerate,
  generating,
  loading,
  error,
  onRetry,
  title = "Daily briefing",
  reviewHref,
}: {
  briefing: BriefingView | null;
  reason: string | null;
  aiEnabled: boolean;
  canGenerate: boolean;
  onGenerate: () => void;
  generating: boolean;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  title?: string;
  /** SPA path of the AI review queue the proposals were routed to. */
  reviewHref: string;
}) {
  const navigate = useNavigate();
  const citationByRef = useMemo(() => new Map((briefing?.citations ?? []).map((c) => [c.ref, c] as const)), [briefing]);
  return (
    <Card>
      <CardHeader
        icon={IconAi}
        tone="accent"
        title={title}
        subtitle={briefing ? `Written ${formatRelativeTime(briefing.generatedAt)} · every claim cites the platform's own evidence` : "Cited, audited, review-queued"}
        actions={
          canGenerate ? (
            <Button size="sm" variant={briefing ? "secondary" : "primary"} icon={IconAi} loading={generating} disabled={!aiEnabled} title={aiEnabled ? undefined : "AI is not configured on this server"} onClick={onGenerate}>
              {briefing ? "Write a new briefing" : "Write today's briefing"}
            </Button>
          ) : null
        }
      />
      <CardBody>
        {loading ? (
          <PanelSkeleton />
        ) : error ? (
          <ErrorAlert message={error} onRetry={onRetry} />
        ) : !briefing ? (
          <EmptyState
            size="sm"
            icon={IconAi}
            tone={reason === "ai_disabled" ? "neutral" : "accent"}
            title={reason === "ai_disabled" ? "AI is not configured" : reason === "restricted_scope" ? "Not shown for a partial view" : "No briefing yet"}
            hint={briefingReasonText(reason)}
          />
        ) : (
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold leading-snug text-content">{briefing.headline}</h3>
              <p className="mt-1.5 text-body leading-relaxed text-content-muted">{briefing.summary}</p>
            </div>
            {briefing.highlights.length > 0 ? (
              <ul className="space-y-1.5">
                {briefing.highlights.map((h, i) => (
                  <li key={i} className="flex gap-2 text-body leading-relaxed text-content">
                    <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
                    <span>
                      {h.text}{" "}
                      {h.citations.map((ref) => (
                        <CitationChip key={ref} refNo={ref} citation={citationByRef.get(ref)} />
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-meta text-content-subtle">The model offered no highlight that cited evidence, so none is shown.</p>
            )}
            {briefing.proposals.length > 0 ? (
              <div className="rounded-md border border-border bg-surface-sunken p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                    {briefing.proposals.length} proposed action{briefing.proposals.length === 1 ? "" : "s"} — waiting for a person in the AI review queue
                  </span>
                  <Button size="xs" variant="ghost" trailingIcon={IconArrowRight} onClick={() => navigate(reviewHref)}>
                    Review
                  </Button>
                </div>
                <ul className="space-y-2">
                  {briefing.proposals.map((p) => (
                    <li key={p.reviewId} className="text-body leading-snug">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-content">{p.title}</span>
                        <Badge tone="accent" size="xs">
                          {formatStatusLabel(p.kind)}
                        </Badge>
                      </span>
                      <span className="text-meta text-content-muted">
                        {p.rationale}{" "}
                        {p.citations.map((ref) => (
                          <CitationChip key={ref} refNo={ref} citation={citationByRef.get(ref)} />
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {briefing.citations.length > 0 ? (
              <details className="text-meta">
                <summary className="cursor-pointer text-content-muted">
                  {briefing.citations.length} evidence item{briefing.citations.length === 1 ? "" : "s"} cited
                </summary>
                <ol className="mt-1.5 space-y-1 text-content-muted">
                  {briefing.citations.map((c) => (
                    <li key={c.ref} className="flex gap-2">
                      <span className="shrink-0 font-mono text-2xs text-content-subtle">[{c.ref}]</span>
                      <span>{c.label}</span>
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
            <p className="text-2xs text-content-subtle">
              Run {briefing.runId} · audited in the AI run log. Uncited claims were discarded before this was stored.
            </p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function CitationChip({ refNo, citation }: { refNo: number; citation: BriefingCitation | undefined }) {
  return (
    <span
      className="mr-0.5 inline-flex items-center rounded bg-accent-subtle px-1 font-mono text-2xs text-accent-subtle-fg"
      title={citation ? citation.label : `Evidence ${refNo}`}
    >
      [{refNo}]
    </span>
  );
}

/* ==========================================================================
   Agent activity
========================================================================== */

const RUN_TONE: Record<string, Tone> = { succeeded: "success", failed: "danger", refused: "warning" };

export function ActivityPanel({
  data,
  loading,
  error,
  onRetry,
  reviewHref,
}: {
  data: ActivityResponse | null;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  reviewHref: string;
}) {
  const navigate = useNavigate();
  const items = useMemo<TimelineItem[]>(
    () =>
      (data?.runs ?? []).map((r) => ({
        id: r.id,
        title: (
          <span className="text-content">
            <span className="font-medium">{formatStatusLabel(r.agentKind)}</span>{" "}
            <span className="text-content-muted">{formatStatusLabel(r.status)}</span>
          </span>
        ),
        description: (
          <span className="text-meta text-content-subtle">
            {r.model}
            {r.latencyMs !== null ? ` · ${formatNumber(r.latencyMs)} ms` : ""}
            {` · ${r.citations} citation${r.citations === 1 ? "" : "s"}`}
          </span>
        ),
        timestamp: r.createdAt,
        icon: r.status === "succeeded" ? IconCheckCircle : r.status === "failed" ? IconWarning : IconLoader,
        tone: RUN_TONE[r.status] ?? "neutral",
      })),
    [data],
  );
  return (
    <Card>
      <CardHeader
        icon={IconAi}
        title="Agent activity"
        subtitle={data ? (data.aiEnabled ? "Every model invocation is audited" : "AI is not configured — no agent has run") : undefined}
        actions={
          data && data.pendingProposals > 0 ? (
            <Button size="sm" variant="secondary" trailingIcon={IconArrowRight} onClick={() => navigate(reviewHref)}>
              {data.pendingProposals} proposal{data.pendingProposals === 1 ? "" : "s"} to review
            </Button>
          ) : null
        }
      />
      <CardBody>
        {loading ? (
          <PanelSkeleton />
        ) : error ? (
          <ErrorAlert message={error} onRetry={onRetry} />
        ) : items.length === 0 ? (
          <EmptyState size="sm" icon={IconAi} title="No agent runs yet" hint={data?.aiEnabled ? "Runs appear here the moment an agent is invoked." : briefingReasonText("ai_disabled")} />
        ) : (
          <Timeline items={items} compact aria-label="Agent runs" />
        )}
      </CardBody>
    </Card>
  );
}

/* ==========================================================================
   Refresh button used by both pages
========================================================================== */

export function RefreshButton({ onClick, loading, label = "Refresh" }: { onClick: () => void; loading: boolean; label?: string }) {
  return (
    <Button variant="secondary" size="sm" icon={IconRefresh} loading={loading} onClick={onClick}>
      {label}
    </Button>
  );
}
