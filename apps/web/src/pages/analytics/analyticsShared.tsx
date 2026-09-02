/**
 * Shared view-models, labels and presentational primitives for the analytics
 * workspace (spec Vol I §6.1-6.2 / #731-751).
 *
 * The types mirror the API exactly. Three server conventions are load-bearing
 * and stated once, here, so both tabs read them the same way:
 *
 *  · TRUNCATION IS DISCLOSED — every execution reports `truncated` when more
 *    rows matched than were returned (page cap or the definition's limitRows).
 *    The flag is always surfaced; a silently clipped table is a lie.
 *  · SCHEDULES ARE RECORDED, NOT DISPATCHED — this deployment has no worker or
 *    mail transport, and every schedule response says so in its `delivery`
 *    block. That note is rendered verbatim wherever schedules appear.
 *  · REACH IS THE EXECUTOR'S JOB — a report can only read the projects its
 *    caller can otherwise open (#751). Per-widget errors from that check are
 *    rendered in place; the rest of the dashboard still stands.
 */
import type { ReactNode } from "react";
import type { WidgetKind } from "@constructos/shared";
import { Card, CardBody } from "../../ui";
import { formatDate, formatDateTime, humanize } from "../format";

/* ================================ Types ================================== */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type ColumnType = "string" | "number" | "date" | "enum";

/** One column of the dataset catalog, with its valid operators/aggregations. */
export interface CatalogColumn {
  key: string;
  label: string;
  type: ColumnType;
  enumValues?: string[];
  filterable: boolean;
  groupable: boolean;
  aggregatable: boolean;
  operators: string[];
  aggregations: string[];
}

export interface CatalogDataset {
  key: string;
  label: string;
  description: string;
  scope: "project" | "company";
  defaultSort: string;
  columns: CatalogColumn[];
}

/** GET /analytics/datasets — the whitelisted registry the builder is driven by. */
export interface DatasetsResponse {
  datasets: CatalogDataset[];
  operators: string[];
  aggregations: string[];
  widgetKinds: WidgetKind[];
  limits: { maxLimitRows: number; maxDashboardWidgets: number };
}

export interface FilterInput {
  field: string;
  operator: string;
  value?: unknown;
}

export interface AggregationInput {
  field: string;
  fn: string;
  alias: string;
}

export interface ReportRow {
  id: string;
  companyId: string;
  projectId: string | null;
  name: string;
  description: string | null;
  dataset: string;
  columns: string[];
  filters: FilterInput[];
  groupBy: string | null;
  aggregations: AggregationInput[];
  sortBy: string | null;
  sortDir: string;
  limitRows: number;
  isShared: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResultColumn {
  key: string;
  label: string;
  type: ColumnType;
}

export interface ExecutionResult {
  dataset: string;
  columns: ResultColumn[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /** more matching rows exist than were returned — always disclosed */
  truncated: boolean;
  limitRows: number;
  offset: number;
  executedAt: string;
  ms: number;
}

export interface PreviewResponse extends ExecutionResult {
  page: number;
  pageSize: number;
  saved: boolean;
}

export interface RunResponse extends ExecutionResult {
  page: number;
  pageSize: number;
  report: { id: string; name: string; dataset: string; projectId: string | null };
}

/** The API's own statement that scheduled delivery is recorded, not sent. */
export interface DeliveryNotice {
  /** false when no mail transport is configured, so nothing actually leaves */
  dispatches?: boolean;
  provider?: string;
  job?: string;
  enabled: boolean;
  note: string;
}

export interface ScheduleRow {
  id: string;
  reportId: string;
  companyId: string;
  cadence: "daily" | "weekly" | "monthly";
  dayOfPeriod: number | null;
  recipients: string[];
  lastRunAt: string | null;
  nextRunAt: string | null;
  isActive: number;
  createdBy: string;
  createdAt: string;
}

export interface SchedulesResponse {
  items: ScheduleRow[];
  delivery: DeliveryNotice;
}

export interface DashboardWidget {
  id: string;
  kind: WidgetKind;
  title: string;
  reportId: string | null;
  metric: string | null;
  span: number;
}

export interface DashboardRow {
  id: string;
  companyId: string;
  projectId: string | null;
  name: string;
  audience: string | null;
  widgets: DashboardWidget[];
  isDefault: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type MetricResult = { label: string; value: number };

/** One executed widget from GET /dashboards/:id/data — `error` is per-widget. */
export interface WidgetResult {
  widgetId: string;
  kind: WidgetKind;
  title: string;
  span: number;
  reportId?: string;
  metric?: string;
  data: ExecutionResult | MetricResult | null;
  error?: string;
}

export interface DashboardDataResponse {
  dashboard: { id: string; name: string; audience: string | null; projectId: string | null };
  widgets: WidgetResult[];
  /** widgets beyond the server's cap that were NOT executed */
  skipped: number;
  executedAt: string;
}

export interface SeedResponse {
  created: string[];
  adopted: string[];
  createdReports: string[];
  dashboards: DashboardRow[];
}

/* =============================== Labels ================================== */

export const OPERATOR_LABELS: Record<string, string> = {
  eq: "=",
  ne: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  contains: "contains",
  in: "is one of",
  is_null: "is empty",
  not_null: "is not empty",
};

export const AGGREGATION_LABELS: Record<string, string> = {
  count: "Count",
  sum: "Sum",
  avg: "Average",
  min: "Minimum",
  max: "Maximum",
};

export const AUDIENCE_LABELS: Record<string, string> = {
  pm: "Project delivery",
  commercial: "Commercial",
  owner: "Owner",
  assurance: "Assurance",
};

export const CADENCE_LABELS: Record<string, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/* =============================== Formats ================================= */

export function fmtNum(value: number | null | undefined, dp = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: dp,
  }).format(value);
}

/** Render one result cell by its column type. Null is an em-dash, never 0. */
export function fmtCell(value: unknown, type: ColumnType): string {
  if (value === null || value === undefined || value === "") return "—";
  if (type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? fmtNum(n) : String(value);
  }
  if (type === "date") {
    const s = String(value);
    return s.length > 10 ? formatDateTime(s) : formatDate(s);
  }
  if (type === "enum") return humanize(String(value));
  return String(value);
}

/** Error message from an API failure, preferring the server's own wording. */
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Round an axis maximum up to a readable 1 / 2 / 5 × 10ⁿ. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  const n = value / base;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * base;
}

/* ============================ Chart palette ============================== */

export const CHART = {
  brand600: "#1d60f1",
  brand200: "#bcdaff",
  ink100: "#ebedf1",
  ink300: "#acb6c5",
  ink400: "#7f8ea4",
  ink600: "#4b5a72",
  amber: "#d97706",
  emerald: "#059669",
  red: "#dc2626",
} as const;

/**
 * Categorical hues in FIXED order (validated for adjacent-pair CVD
 * separation, chroma and contrast on a white surface). Assigned by position,
 * never cycled: a 7th category folds into a grey "other".
 */
export const CATEGORICAL = [
  "#1d60f1", // brand blue
  "#d97706", // amber
  "#0d9488", // teal
  "#8b5cf6", // violet
  "#db2777", // pink
  "#65a30d", // olive
] as const;

export const OTHER_COLOR = "#acb6c5";

export function categoryColor(index: number): string {
  return index < CATEGORICAL.length ? CATEGORICAL[index]! : OTHER_COLOR;
}

/* ============================= Components ================================ */

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
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "brand" | "red" | "amber" | "green";
  title?: string;
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
    <Card>
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
        <div className={`mt-0.5 text-xl font-semibold tabular-nums ${valueCls}`}>{value}</div>
        {hint ? <div className="mt-0.5 text-xs text-ink-400">{hint}</div> : null}
      </CardBody>
    </Card>
  );
}

/** A quiet caveat strip for figures that must not be read as complete. */
export function Caveat({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
      {children}
    </div>
  );
}

/** Small chart legend row. */
export function Legend({ items }: { items: { color: string; label: string; title?: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-500">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5" title={i.title}>
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: i.color }}
          />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/**
 * The honest-truncation strip: rendered whenever an execution says more rows
 * matched than were returned.
 */
export function TruncationNotice({ result }: { result: ExecutionResult }) {
  if (!result.truncated) return null;
  return (
    <Caveat>
      More rows match than were returned — this execution is capped at{" "}
      {fmtNum(result.limitRows, 0)} rows by the report's row limit. What you see is a slice, not
      the whole population.
    </Caveat>
  );
}

/**
 * The API's own delivery disclosure, rendered verbatim.
 *
 * There are three states and the note distinguishes them, so this component
 * must too: delivery not running at all, delivery running but no transport
 * configured (rendered and recorded, nothing sent), and delivery running with
 * a transport. Only the last is silent.
 */
export function DeliveryNote({ delivery }: { delivery: DeliveryNotice }) {
  if (delivery.enabled && delivery.dispatches !== false) return null;
  return (
    <Caveat>
      <strong>{delivery.enabled ? "Rendered and recorded, not sent." : "Recorded, not dispatched."}</strong>{" "}
      {delivery.note}
    </Caveat>
  );
}

/* =========================== Chart data prep ============================= */

export interface SeriesPoint {
  label: string;
  value: number;
}

export interface Series {
  labelKey: string;
  labelName: string;
  labelType: ColumnType;
  valueKey: string;
  valueName: string;
  points: SeriesPoint[];
}

/**
 * Reduce an execution result to one labelled numeric series for a bar / line /
 * donut widget: the first non-numeric column carries identity, the first
 * numeric column carries magnitude. Returns null when no numeric column
 * exists — the widget then falls back to a table.
 */
export function toSeries(result: ExecutionResult): Series | null {
  const valueCol = result.columns.find((c) => c.type === "number");
  if (!valueCol) return null;
  const labelCol = result.columns.find((c) => c.type !== "number") ?? null;
  const points: SeriesPoint[] = result.rows.map((row, i) => {
    const raw = labelCol ? row[labelCol.key] : null;
    const v = Number(row[valueCol.key]);
    return {
      label: labelCol ? fmtCell(raw, labelCol.type) : `#${i + 1}`,
      value: Number.isFinite(v) ? v : 0,
    };
  });
  return {
    labelKey: labelCol?.key ?? "",
    labelName: labelCol?.label ?? "Row",
    labelType: labelCol?.type ?? "string",
    valueKey: valueCol.key,
    valueName: valueCol.label,
    points,
  };
}

/* ================================ Charts ================================= */

const AXIS_INK = CHART.ink400;
const GRID = CHART.ink100;

/**
 * Horizontal bar chart — the right form for a handful of named categories.
 * One hue: the length carries the magnitude, so a rainbow would only add
 * noise. Every mark carries a <title> and a direct value label.
 */
export function HBars({ series, ariaLabel }: { series: Series; ariaLabel: string }) {
  const rows = series.points;
  if (rows.length === 0) {
    return <p className="py-6 text-center text-xs text-ink-400">No rows to draw.</p>;
  }
  const height = 18;
  const gap = 8;
  const labelWidth = 140;
  const W = 560;
  const PAD_R = 56;
  const plotW = W - labelWidth - PAD_R;
  const max = niceMax(Math.max(...rows.map((d) => d.value), 0));
  const H = rows.length * (height + gap) + gap;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
      {[0, 0.5, 1].map((f) => (
        <line
          key={f}
          x1={labelWidth + f * plotW}
          x2={labelWidth + f * plotW}
          y1={gap / 2}
          y2={H - gap / 2}
          stroke={GRID}
          strokeWidth={1}
        />
      ))}
      {rows.map((d, i) => {
        const y = gap + i * (height + gap);
        const w = max > 0 ? Math.max(2, (d.value / max) * plotW) : 2;
        return (
          <g key={`${d.label}-${i}`}>
            <text
              x={labelWidth - 8}
              y={y + height / 2 + 4}
              textAnchor="end"
              fontSize={11}
              fill={AXIS_INK}
            >
              {d.label.length > 20 ? `${d.label.slice(0, 19)}…` : d.label}
            </text>
            <rect x={labelWidth} y={y} width={w} height={height} rx={3} fill={CHART.brand600}>
              <title>{`${d.label}: ${fmtNum(d.value)}`}</title>
            </rect>
            <text
              x={labelWidth + w + 6}
              y={y + height / 2 + 4}
              fontSize={11}
              fill={AXIS_INK}
              className="tabular-nums"
            >
              {fmtNum(d.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Line chart over ordered rows — first/last x labels, hoverable points. */
export function LineChart({ series, ariaLabel }: { series: Series; ariaLabel: string }) {
  const pts = series.points;
  if (pts.length === 0) {
    return <p className="py-6 text-center text-xs text-ink-400">No rows to draw.</p>;
  }
  const W = 560;
  const H = 190;
  const PAD_L = 52;
  const PAD_R = 14;
  const PAD_T = 12;
  const PAD_B = 26;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const yMax = niceMax(Math.max(...pts.map((p) => p.value), 0));
  const y = (v: number) => PAD_T + plotH - (yMax > 0 ? (v / yMax) * plotH : 0);
  const x = (i: number) => PAD_L + (pts.length > 1 ? (i / (pts.length - 1)) * plotW : plotW / 2);
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.value)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line
            x1={PAD_L}
            x2={W - PAD_R}
            y1={y(f * yMax)}
            y2={y(f * yMax)}
            stroke={GRID}
            strokeWidth={1}
          />
          <text x={PAD_L - 6} y={y(f * yMax) + 3.5} textAnchor="end" fontSize={10} fill={AXIS_INK}>
            {fmtNum(f * yMax, 1)}
          </text>
        </g>
      ))}
      {pts.length > 1 ? (
        <path d={path} fill="none" stroke={CHART.brand600} strokeWidth={2} />
      ) : null}
      {pts.map((p, i) => (
        <circle key={`${p.label}-${i}`} cx={x(i)} cy={y(p.value)} r={3.5} fill={CHART.brand600}>
          <title>{`${p.label}: ${fmtNum(p.value)}`}</title>
        </circle>
      ))}
      <text x={PAD_L} y={H - 8} fontSize={10} fill={AXIS_INK}>
        {pts[0]!.label}
      </text>
      {pts.length > 1 ? (
        <text x={W - PAD_R} y={H - 8} textAnchor="end" fontSize={10} fill={AXIS_INK}>
          {pts[pts.length - 1]!.label}
        </text>
      ) : null}
    </svg>
  );
}

/**
 * Donut for a part-of-whole split. At most six named segments in the fixed
 * categorical order; everything beyond folds into a grey "Other". Identity is
 * never colour-alone: the legend names every segment with its value.
 */
export function Donut({ series, ariaLabel }: { series: Series; ariaLabel: string }) {
  const raw = series.points.filter((p) => p.value > 0);
  if (raw.length === 0) {
    return <p className="py-6 text-center text-xs text-ink-400">No rows to draw.</p>;
  }
  const head = raw.slice(0, CATEGORICAL.length);
  const rest = raw.slice(CATEGORICAL.length);
  const points =
    rest.length > 0
      ? [...head, { label: `Other (${rest.length})`, value: rest.reduce((s, p) => s + p.value, 0) }]
      : head;
  const total = points.reduce((s, p) => s + p.value, 0);

  const CX = 80;
  const CY = 80;
  const R = 56;
  const STROKE = 26;
  const TAU = Math.PI * 2;
  // a slim angular gap keeps adjacent fills apart (surface shows through)
  const gap = points.length > 1 ? 0.03 : 0;

  let angle = -Math.PI / 2;
  const segments = points.map((p, i) => {
    const frac = total > 0 ? p.value / total : 0;
    const a0 = angle + gap / 2;
    const a1 = angle + Math.max(frac * TAU - gap / 2, 0.001);
    angle += frac * TAU;
    return { ...p, a0, a1, color: i < head.length ? categoryColor(i) : OTHER_COLOR };
  });

  function arc(a0: number, a1: number): string {
    const x0 = CX + R * Math.cos(a0);
    const y0 = CY + R * Math.sin(a0);
    const x1 = CX + R * Math.cos(a1);
    const y1 = CY + R * Math.sin(a1);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return `M ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1}`;
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg viewBox="0 0 160 160" className="h-36 w-36 shrink-0" role="img" aria-label={ariaLabel}>
        {segments.length === 1 ? (
          <circle
            cx={CX}
            cy={CY}
            r={R}
            fill="none"
            stroke={segments[0]!.color}
            strokeWidth={STROKE}
          >
            <title>{`${segments[0]!.label}: ${fmtNum(segments[0]!.value)} (100%)`}</title>
          </circle>
        ) : (
          segments.map((s, i) => (
            <path
              key={`${s.label}-${i}`}
              d={arc(s.a0, s.a1)}
              fill="none"
              stroke={s.color}
              strokeWidth={STROKE}
            >
              <title>{`${s.label}: ${fmtNum(s.value)} (${total > 0 ? fmtNum((s.value / total) * 100, 1) : "—"}%)`}</title>
            </path>
          ))
        )}
        <text
          x={CX}
          y={CY + 1}
          textAnchor="middle"
          fontSize={18}
          fontWeight={600}
          fill={CHART.ink600}
          className="tabular-nums"
        >
          {fmtNum(total, 0)}
        </text>
        <text x={CX} y={CY + 16} textAnchor="middle" fontSize={9} fill={AXIS_INK}>
          total
        </text>
      </svg>
      <div className="min-w-0 flex-1 space-y-1 text-xs text-ink-600">
        {segments.map((s, i) => (
          <div key={`${s.label}-${i}`} className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: s.color }}
            />
            <span className="min-w-0 flex-1 truncate" title={s.label}>
              {s.label}
            </span>
            <span className="tabular-nums text-ink-800">{fmtNum(s.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================ Result table =============================== */

/**
 * Type-aware result grid used by preview, run and table widgets. Numbers are
 * right-aligned tabular figures; nulls are em-dashes, never zeros.
 */
export function ResultTable({
  result,
  maxRows,
}: {
  result: ExecutionResult;
  maxRows?: number;
}) {
  const rows = maxRows !== undefined ? result.rows.slice(0, maxRows) : result.rows;
  return (
    <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-ink-100">
      <table className="min-w-full divide-y divide-ink-100 text-sm">
        <thead>
          <tr>
            {result.columns.map((c) => (
              <th
                key={c.key}
                className={`px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-ink-500 ${
                  c.type === "number" ? "text-right" : "text-left"
                }`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {rows.map((row, i) => (
            <tr key={i}>
              {result.columns.map((c) => (
                <td
                  key={c.key}
                  className={`px-4 py-2 text-ink-800 ${
                    c.type === "number" ? "text-right tabular-nums" : ""
                  }`}
                >
                  {fmtCell(row[c.key], c.type)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {maxRows !== undefined && result.rows.length > maxRows ? (
        <p className="border-t border-ink-100 px-4 py-1.5 text-xs text-ink-400">
          Showing {maxRows} of {result.rowCount} returned rows.
        </p>
      ) : null}
    </div>
  );
}
