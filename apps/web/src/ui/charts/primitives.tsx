/**
 * charts/primitives.tsx — the shell every chart in the layer is built from.
 *
 * One frame, one tooltip, one legend, one empty state, one loading state, one
 * data-table fallback. If a chart needs to say "there is nothing here", it says
 * it the same way as every other chart, with the reason attached.
 */
import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { TooltipContentProps } from "recharts";
import { ResponsiveContainer } from "recharts";

import { cx } from "../cx";
import {
  IconChartBar,
  IconWarning,
  type IconComponent,
} from "../icons";
import { useReducedMotion } from "../motion";
import {
  CHART_AXIS_COLOR,
  CHART_GRID_COLOR,
  CHART_PATTERN_ID_PREFIX,
  CHART_SURFACE_COLOR,
  seriesColor,
  toneColor,
  withAlpha,
} from "./palette";
import {
  CHART_NO_VALUE,
  makeAxisFormatter,
  makeLabelFormatter,
  makeValueFormatter,
  toChartNumber,
  type ChartFormatOptions,
  type LabelFormatter,
  type ValueFormat,
  type ValueFormatter,
} from "./format";
import type {
  ChartDatum,
  ChartFrameProps,
  ChartGlyph,
  ChartSeries,
  ChartSeriesInput,
  ChartStateKind,
  ChartStateProps,
  ResolvedSeries,
} from "./types";

/* ============================================================================
   Ids
============================================================================ */

/** A DOM-safe, stable id for gradients / clip paths / pattern defs. */
export function useChartId(prefix = "chart"): string {
  const raw = useId();
  return useMemo(() => `${prefix}-${raw.replace(/[^a-zA-Z0-9-]/g, "")}`, [prefix, raw]);
}

/* ============================================================================
   Series resolution
============================================================================ */

/** `"cost"` → `[{ key: "cost" }]`; a single object → a one-element array. */
export function normalizeSeries(input: ChartSeriesInput): ChartSeries[] {
  if (typeof input === "string") return [{ key: input }];
  if (Array.isArray(input)) {
    return input.map((entry) => (typeof entry === "string" ? { key: entry } : entry));
  }
  return [input as ChartSeries];
}

/**
 * Apply labels, palette slots and visibility.
 *
 * The palette slot comes from the series' position in the DECLARED list, never
 * from its position among the visible ones — hiding "Subcontract" must not
 * repaint "Labour".
 */
export function resolveSeries(
  input: ChartSeriesInput,
  options: { hidden?: ReadonlySet<string>; glyph?: ChartGlyph } = {},
): ResolvedSeries[] {
  const { hidden, glyph = "square" } = options;
  return normalizeSeries(input).map((series, index) => ({
    ...series,
    index,
    label: series.label ?? series.key,
    color: series.color ?? (series.tone ? toneColor(series.tone) : seriesColor(index)),
    hidden: hidden?.has(series.key) ?? series.defaultHidden ?? false,
    glyph: series.glyph ?? (series.dashed && glyph === "line" ? "dashed" : glyph),
  }));
}

export interface UseChartSeriesResult {
  /** Every declared series, with palette + visibility applied. */
  all: ResolvedSeries[];
  /** Only the ones currently drawn. */
  visible: ResolvedSeries[];
  hidden: ReadonlySet<string>;
  toggle: (key: string) => void;
  reset: () => void;
  /** Fast lookup for tooltips and table fallbacks. */
  byKey: Map<string, ResolvedSeries>;
  allHidden: boolean;
}

/** Owns legend toggling for a chart. */
export function useChartSeries(
  input: ChartSeriesInput,
  options: { glyph?: ChartGlyph } = {},
): UseChartSeriesResult {
  const declared = useMemo(() => normalizeSeries(input), [input]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(
    () => new Set(declared.filter((s) => s.defaultHidden).map((s) => s.key)),
  );

  const toggle = useCallback((key: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const reset = useCallback(() => setHidden(new Set()), []);

  const glyph = options.glyph;
  const all = useMemo(
    () => resolveSeries(declared, glyph ? { hidden, glyph } : { hidden }),
    [declared, hidden, glyph],
  );
  const visible = useMemo(() => all.filter((s) => !s.hidden), [all]);
  const byKey = useMemo(() => new Map(all.map((s) => [s.key, s])), [all]);

  return {
    all,
    visible,
    hidden,
    toggle,
    reset,
    byKey,
    allHidden: all.length > 0 && visible.length === 0,
  };
}

/* ============================================================================
   State derivation — the "never fabricate" rule, in one place
============================================================================ */

export interface DerivedChartState {
  kind: ChartStateKind;
  /** Present for "empty" and "error". Always shown to the user. */
  reason?: ReactNode;
}

export function deriveChartState(args: {
  data: ReadonlyArray<ChartDatum> | undefined | null;
  seriesKeys: ReadonlyArray<string>;
  state: ChartStateProps;
  /** Hidden because the viewer switched every series off, not because of data. */
  allHidden?: boolean;
}): DerivedChartState {
  const { data, seriesKeys, state, allHidden } = args;

  if (state.loading) return { kind: "loading" };
  if (state.error) {
    const message =
      state.error instanceof Error ? state.error.message : (state.error as ReactNode);
    return { kind: "error", reason: message };
  }
  if (state.empty) {
    return { kind: "empty", reason: state.emptyMessage ?? "This chart was given no data." };
  }
  if (allHidden) {
    return { kind: "empty", reason: state.emptyMessage ?? "Every series is hidden. Turn one back on in the legend." };
  }
  if (!data || data.length === 0) {
    return { kind: "empty", reason: state.emptyMessage ?? "No records match the current filters." };
  }
  if (seriesKeys.length === 0) {
    return { kind: "empty", reason: state.emptyMessage ?? "No measure was selected for this chart." };
  }

  let numeric = 0;
  for (const datum of data) {
    for (const key of seriesKeys) {
      if (toChartNumber(datum[key]) !== null) {
        numeric += 1;
        break;
      }
    }
    if (numeric > 0) break;
  }
  if (numeric === 0) {
    return {
      kind: "empty",
      reason:
        state.emptyMessage ??
        "Every value in this series is missing — nothing has been reported yet for this period.",
    };
  }

  return { kind: "ready" };
}

/* ============================================================================
   Loading / empty / error blocks
============================================================================ */

const SKELETON_BARS = [0.42, 0.68, 0.55, 0.86, 0.62, 0.94, 0.7, 0.5, 0.78, 0.6, 0.88, 0.46];

export function ChartLoading({
  variant = "bar",
  className,
}: {
  variant?: "bar" | "line" | "block";
  className?: string;
}) {
  if (variant === "block") {
    return <div className={cx("skeleton h-full w-full rounded-md", className)} aria-hidden="true" />;
  }
  if (variant === "line") {
    return (
      <div className={cx("flex h-full w-full flex-col justify-end gap-2 p-2", className)} aria-hidden="true">
        <div className="skeleton h-px w-full" />
        <div className="skeleton h-24 w-full rounded-md" />
        <div className="flex gap-3">
          {SKELETON_BARS.slice(0, 6).map((_, index) => (
            <div key={index} className="skeleton h-2 flex-1 rounded-xs" />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div
      className={cx("flex h-full w-full items-end gap-[3%] px-2 pb-6 pt-2", className)}
      aria-hidden="true"
    >
      {SKELETON_BARS.map((height, index) => (
        <div
          key={index}
          className="skeleton min-w-0 flex-1 rounded-t-xs"
          style={{ height: `${height * 100}%` }}
        />
      ))}
    </div>
  );
}

export function ChartEmpty({
  title = "No data",
  message,
  action,
  icon: Icon = IconChartBar,
  compact = false,
  className,
}: {
  title?: string;
  message?: ReactNode;
  action?: ReactNode;
  icon?: IconComponent;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "grid-bg flex h-full w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border px-6 text-center",
        className,
      )}
    >
      <span className="grid size-9 place-items-center rounded-full bg-surface-sunken text-content-subtle">
        <Icon size={compact ? 14 : 18} />
      </span>
      <p className="text-sm font-medium text-content">{title}</p>
      {message ? (
        <p className="max-w-[42ch] text-meta text-content-muted">{message}</p>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function ChartError({ message, className }: { message?: ReactNode; className?: string }) {
  return (
    <div
      role="alert"
      className={cx(
        "flex h-full w-full flex-col items-center justify-center gap-2 rounded-md border border-danger-border bg-danger-subtle px-6 text-center",
        className,
      )}
    >
      <IconWarning size={18} className="text-danger-fg" />
      <p className="text-sm font-medium text-danger-fg">Chart unavailable</p>
      <p className="max-w-[42ch] text-meta text-danger-fg/85">
        {message ?? "This chart could not be loaded."}
      </p>
    </div>
  );
}

/* ============================================================================
   Legend
============================================================================ */

export interface ChartLegendProps {
  series: ReadonlyArray<ResolvedSeries>;
  /** Omit to render a static legend. */
  onToggle?: ((key: string) => void) | undefined;
  /** Right-aligned value beside each entry — share, total, latest reading. */
  values?: Record<string, ReactNode> | undefined;
  align?: "start" | "center" | "end";
  /** Stack vertically — for donut/pie legends beside the plot. */
  orientation?: "horizontal" | "vertical";
  className?: string;
  /** Accessible name of the list. */
  label?: string;
}

function LegendGlyph({ glyph, color }: { glyph: ChartGlyph; color: string }) {
  if (glyph === "line" || glyph === "dashed") {
    return (
      <svg width="14" height="10" viewBox="0 0 14 10" aria-hidden="true" className="shrink-0">
        <line
          x1="0"
          y1="5"
          x2="14"
          y2="5"
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={glyph === "dashed" ? "4 3" : undefined}
        />
      </svg>
    );
  }
  if (glyph === "dot") {
    return (
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
    );
  }
  if (glyph === "ring") {
    return (
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-full border-2"
        style={{ borderColor: color }}
      />
    );
  }
  if (glyph === "area") {
    return (
      <span
        aria-hidden="true"
        className="h-2.5 w-3.5 shrink-0 rounded-xs border-t-2"
        style={{ backgroundColor: withAlpha(color, 0.28), borderTopColor: color }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="size-2.5 shrink-0 rounded-xs"
      style={{ backgroundColor: color }}
    />
  );
}

export function ChartLegend({
  series,
  onToggle,
  values,
  align = "start",
  orientation = "horizontal",
  className,
  label = "Chart series",
}: ChartLegendProps) {
  if (series.length === 0) return null;

  const alignClass =
    align === "center" ? "justify-center" : align === "end" ? "justify-end" : "justify-start";

  return (
    <ul
      aria-label={label}
      className={cx(
        "flex min-w-0 list-none flex-wrap gap-x-4 gap-y-1.5",
        orientation === "vertical" ? "flex-col flex-nowrap gap-y-1" : alignClass,
        className,
      )}
    >
      {series.map((entry) => {
        const content = (
          <>
            <LegendGlyph
              glyph={entry.glyph}
              color={entry.hidden ? "var(--ds-content-disabled)" : entry.color}
            />
            <span className="truncate">{entry.label}</span>
            {values?.[entry.key] !== undefined ? (
              <span
                className={cx(
                  "ml-auto shrink-0 tabular-nums",
                  entry.hidden ? "text-content-disabled" : "text-content",
                )}
              >
                {values[entry.key]}
              </span>
            ) : null}
          </>
        );

        if (!onToggle) {
          return (
            <li
              key={entry.key}
              title={entry.description}
              className={cx(
                "flex min-w-0 items-center gap-1.5 text-meta",
                orientation === "vertical" && "w-full",
                entry.hidden ? "text-content-disabled" : "text-content-muted",
              )}
            >
              {content}
            </li>
          );
        }

        return (
          <li key={entry.key} className={cx("min-w-0", orientation === "vertical" && "w-full")}>
            <button
              type="button"
              aria-pressed={!entry.hidden}
              title={entry.description ?? `${entry.hidden ? "Show" : "Hide"} ${entry.label}`}
              onClick={() => onToggle(entry.key)}
              className={cx(
                "flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-meta transition-colors duration-fast",
                "hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                entry.hidden
                  ? "text-content-disabled line-through decoration-content-disabled/60"
                  : "text-content-muted",
              )}
            >
              {content}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* ============================================================================
   Tooltip
============================================================================ */

export function ChartTooltipSurface({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cx(
        "pointer-events-none min-w-[9rem] max-w-[20rem] rounded-md border border-border",
        "bg-surface-overlay px-2.5 py-2 text-meta shadow-e3",
        className,
      )}
      style={style}
    >
      {children}
    </div>
  );
}

export function ChartTooltipRow({
  color,
  glyph = "square",
  label,
  value,
  muted = false,
}: {
  color?: string;
  glyph?: ChartGlyph;
  label: ReactNode;
  value: ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      {color ? (
        <span className="flex translate-y-[-1px] items-center">
          <LegendGlyph glyph={glyph} color={color} />
        </span>
      ) : (
        <span className="size-2.5" aria-hidden="true" />
      )}
      <span className={cx("min-w-0 flex-1 truncate", muted ? "text-content-subtle" : "text-content-muted")}>
        {label}
      </span>
      <span className="shrink-0 font-medium tabular-nums text-content">{value}</span>
    </div>
  );
}

export interface ChartTooltipConfig {
  byKey: Map<string, ResolvedSeries>;
  valueFormat?: ValueFormat | undefined;
  formatOptions?: ChartFormatOptions | undefined;
  labelFormatter?: LabelFormatter | undefined;
  /** Add a Total row. */
  total?: boolean;
  totalLabel?: string;
  /** Extra content under the rows — variance, % complete, notes. */
  footer?: ((datum: ChartDatum) => ReactNode) | undefined;
  hideLabel?: boolean;
  /** Largest value first. Default: declaration order. */
  sort?: boolean;
}

/**
 * Build the `content` renderer for a recharts <Tooltip>. Returns HTML (recharts
 * v3 requires HTML, not SVG, in tooltip content).
 */
export function makeChartTooltip(config: ChartTooltipConfig) {
  const {
    byKey,
    valueFormat,
    formatOptions,
    labelFormatter,
    total = false,
    totalLabel = "Total",
    footer,
    hideLabel = false,
    sort = false,
  } = config;

  const fallbackFormatter = makeValueFormatter(valueFormat, formatOptions ?? {});

  return function ChartTooltipContent(props: TooltipContentProps): ReactNode {
    if (!props.active || !props.payload || props.payload.length === 0) return null;

    const seen = new Set<string>();
    const rows: Array<{ series: ResolvedSeries | undefined; key: string; value: number }> = [];

    for (const entry of props.payload) {
      const rawKey = typeof entry.dataKey === "string" ? entry.dataKey : String(entry.name ?? "");
      const key = stripDerivedSuffix(rawKey);
      if (!key || seen.has(key)) continue;
      const value = toChartNumber(entry.value);
      if (value === null) continue;
      seen.add(key);
      rows.push({ series: byKey.get(key), key, value });
    }

    if (rows.length === 0) return null;
    if (sort) rows.sort((a, b) => b.value - a.value);

    const datum = (props.payload[0]?.payload ?? {}) as ChartDatum;
    const label = labelFormatter ? labelFormatter(props.label as string | number) : props.label;
    const sum = rows.reduce((acc, row) => acc + row.value, 0);

    return (
      <ChartTooltipSurface>
        {!hideLabel && label != null && label !== "" ? (
          <p className="mb-1.5 truncate text-label uppercase text-content-subtle">{label}</p>
        ) : null}
        <div className="flex flex-col gap-1">
          {rows.map((row) => {
            const formatter = row.series?.format
              ? makeValueFormatter(row.series.format, formatOptions ?? {})
              : fallbackFormatter;
            const unit = row.series?.unit;
            return (
              <ChartTooltipRow
                key={row.key}
                color={row.series?.color ?? seriesColor(0)}
                glyph={row.series?.glyph ?? "square"}
                label={row.series?.label ?? row.key}
                value={unit ? `${formatter(row.value)} ${unit}` : formatter(row.value)}
              />
            );
          })}
        </div>
        {total && rows.length > 1 ? (
          <div className="mt-1.5 flex items-baseline gap-2 border-t border-border-subtle pt-1.5">
            <span className="size-2.5" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-content-subtle">{totalLabel}</span>
            <span className="shrink-0 font-semibold tabular-nums text-content">
              {fallbackFormatter(sum)}
            </span>
          </div>
        ) : null}
        {footer ? <div className="mt-1.5 border-t border-border-subtle pt-1.5">{footer(datum)}</div> : null}
      </ChartTooltipSurface>
    );
  };
}

/** Series rendered as a second, dashed pass carry this suffix on their key. */
export const DERIVED_KEY_SUFFIX = "__ds";

export function derivedKey(key: string, variant: string): string {
  return `${key}${DERIVED_KEY_SUFFIX}${variant}`;
}

export function stripDerivedSuffix(key: string): string {
  const at = key.indexOf(DERIVED_KEY_SUFFIX);
  return at === -1 ? key : key.slice(0, at);
}

/* ============================================================================
   Axis / grid presets
============================================================================ */

export const CHART_TICK_STYLE = {
  fill: "var(--ds-content-subtle)",
  fontSize: 11,
  fontFamily: "var(--font-sans)",
} as const;

export const CHART_AXIS_LINE = { stroke: CHART_AXIS_COLOR, strokeOpacity: 0.55 } as const;

export const CHART_MARGIN = { top: 8, right: 8, bottom: 0, left: 0 } as const;

export const CHART_GRID_PROPS = {
  stroke: CHART_GRID_COLOR,
  strokeDasharray: "0",
  vertical: false,
  horizontal: true,
} as const;

export const CHART_CURSOR_BAR = {
  fill: "var(--ds-content)",
  fillOpacity: 0.04,
} as const;

export const CHART_CURSOR_LINE = {
  stroke: CHART_AXIS_COLOR,
  strokeWidth: 1,
  strokeDasharray: "3 3",
} as const;

/** Axis title props, positioned so the label never collides with ticks. */
export function axisTitle(value: string | undefined, orientation: "x" | "y") {
  if (!value) return undefined;
  return {
    value,
    position: orientation === "y" ? ("insideLeft" as const) : ("insideBottom" as const),
    angle: orientation === "y" ? -90 : 0,
    offset: orientation === "y" ? 4 : -4,
    style: { fill: "var(--ds-content-subtle)", fontSize: 11, textAnchor: "middle" as const },
  };
}

/* ============================================================================
   Texture — the CVD / print / forced-colors escape hatch
============================================================================ */

export function ChartPatternDefs({
  scopeId,
  colors,
}: {
  scopeId: string;
  colors: ReadonlyArray<string>;
}) {
  return (
    <defs>
      {colors.map((color, index) => (
        <pattern
          key={index}
          id={`${CHART_PATTERN_ID_PREFIX}-${scopeId}-${index}`}
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform={`rotate(${index % 2 === 0 ? 45 : 135})`}
        >
          <rect width="6" height="6" fill={color} />
          <line
            x1="0"
            y1="0"
            x2="0"
            y2="6"
            stroke={CHART_SURFACE_COLOR}
            strokeWidth="2.4"
            strokeOpacity="0.55"
          />
        </pattern>
      ))}
    </defs>
  );
}

/* ============================================================================
   Data-table fallback
============================================================================ */

export interface ChartDataTableProps {
  caption: string;
  /** Header of the first column. */
  categoryHeader?: string;
  rows: ReadonlyArray<{ label: ReactNode; values: ReadonlyArray<ReactNode> }>;
  columns: ReadonlyArray<{ key: string; label: ReactNode }>;
  summaryLabel?: string;
  className?: string;
  /** Render open. Default closed. */
  open?: boolean;
}

export function ChartDataTable({
  caption,
  categoryHeader = "Category",
  rows,
  columns,
  summaryLabel = "View as table",
  className,
  open,
}: ChartDataTableProps) {
  if (rows.length === 0 || columns.length === 0) return null;
  return (
    <details className={cx("group mt-2", className)} open={open}>
      <summary
        className={cx(
          "inline-flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm px-1.5 py-0.5",
          "text-meta text-content-subtle transition-colors duration-fast",
          "hover:bg-surface-hover hover:text-content",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden="true"
          className="transition-transform duration-fast group-open:rotate-90"
        >
          <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {summaryLabel}
      </summary>
      <div className="mt-1.5 max-h-72 overflow-auto rounded-md border border-border">
        <table className="w-full border-collapse text-meta">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky-head">
            <tr>
              <th scope="col" className="px-2 py-1.5 text-left font-semibold text-content-muted">
                {categoryHeader}
              </th>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className="px-2 py-1.5 text-right font-semibold text-content-muted"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-t border-border-subtle">
                <th scope="row" className="px-2 py-1 text-left font-normal text-content-muted">
                  {row.label}
                </th>
                {row.values.map((value, valueIndex) => (
                  <td key={valueIndex} className="px-2 py-1 text-right tabular-nums text-content">
                    {value ?? CHART_NO_VALUE}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Build the table fallback rows straight from cartesian chart inputs. */
export function buildDataTable(args: {
  data: ReadonlyArray<ChartDatum>;
  categoryKey: string;
  series: ReadonlyArray<ResolvedSeries>;
  valueFormatter: ValueFormatter;
  labelFormatter: LabelFormatter;
  formatOptions?: ChartFormatOptions | undefined;
}): Pick<ChartDataTableProps, "rows" | "columns"> {
  const { data, categoryKey, series, valueFormatter, labelFormatter, formatOptions } = args;
  const columns = series.map((entry) => ({ key: entry.key, label: entry.label }));
  const rows = data.map((datum) => ({
    label: labelFormatter(datum[categoryKey] as string | number),
    values: series.map((entry) => {
      const value = toChartNumber(datum[entry.key]);
      if (value === null) return CHART_NO_VALUE;
      const formatter = entry.format
        ? makeValueFormatter(entry.format, formatOptions ?? {})
        : valueFormatter;
      return entry.unit ? `${formatter(value)} ${entry.unit}` : formatter(value);
    }),
  }));
  return { rows, columns };
}

/* ============================================================================
   ChartFrame
============================================================================ */

export interface ChartFrameOwnProps extends ChartFrameProps {
  state: DerivedChartState;
  /** Series for the legend. Pass [] to suppress it. */
  legendSeries?: ReadonlyArray<ResolvedSeries>;
  onLegendToggle?: ((key: string) => void) | undefined;
  legendValues?: Record<string, ReactNode> | undefined;
  legendOrientation?: "horizontal" | "vertical";
  /** Replaces the generated legend entirely. */
  legendContent?: ReactNode;
  /** Table fallback content. */
  table?: (Pick<ChartDataTableProps, "rows" | "columns"> & { categoryHeader?: string }) | undefined;
  loadingVariant?: "bar" | "line" | "block";
  /** The recharts tree (or any absolutely-positioned plot). */
  children: ReactNode;
  /** Rendered on top of the plot — centre metrics, overlays, watermarks. */
  overlay?: ReactNode;
  /** Skip <ResponsiveContainer>; the child sizes itself. */
  raw?: boolean;
}

/** Wraps the plot and a side legend in a row — and adds no DOM when there isn't one. */
function SideBySide({ active, children }: { active: boolean; children: ReactNode }) {
  if (!active) return <>{children}</>;
  return <div className="flex min-w-0 items-center gap-4">{children}</div>;
}

export function ChartFrame({
  state,
  ariaLabel,
  ariaDescription,
  height = 260,
  legend,
  legendToggle = true,
  legendSeries = [],
  onLegendToggle,
  legendValues,
  legendOrientation = "horizontal",
  legendContent,
  dataTable = true,
  dataTableLabel,
  table,
  footnote,
  className,
  plotClassName,
  id,
  emptyTitle,
  emptyAction,
  emptyIcon,
  loadingVariant = "bar",
  children,
  overlay,
  raw = false,
}: ChartFrameOwnProps) {
  const autoId = useChartId("frame");
  const frameId = id ?? autoId;
  const descriptionId = ariaDescription ? `${frameId}-desc` : undefined;

  const placement: "top" | "bottom" | "left" | "right" | "none" =
    legend === false || legend === "none"
      ? "none"
      : legend === true
        ? "bottom"
        : typeof legend === "string"
          ? legend
          : legendSeries.length > 1
            ? "bottom"
            : "none";
  const sideLegend = placement === "left" || placement === "right";

  const legendNode =
    placement === "none" ? null : (
      legendContent ?? (
        <ChartLegend
          series={legendSeries}
          onToggle={legendToggle ? onLegendToggle : undefined}
          values={legendValues}
          orientation={sideLegend ? "vertical" : legendOrientation}
          label={ariaLabel ? `${ariaLabel} — series` : "Chart series"}
        />
      )
    );

  const plotStyle: CSSProperties = { height: typeof height === "number" ? `${height}px` : height };

  return (
    <figure
      id={frameId}
      aria-label={ariaLabel}
      aria-describedby={descriptionId}
      className={cx("m-0 flex min-w-0 flex-col gap-2", className)}
    >
      {ariaDescription ? (
        <span id={descriptionId} className="sr-only">
          {ariaDescription}
        </span>
      ) : null}

      {placement === "top" && legendNode ? <div className="min-w-0">{legendNode}</div> : null}

      <SideBySide active={sideLegend}>
      {sideLegend && placement === "left" && legendNode ? (
        <div className="max-h-full w-40 shrink-0 overflow-y-auto no-scrollbar">{legendNode}</div>
      ) : null}

      <div
        className={cx("relative min-w-0", sideLegend && "flex-1", plotClassName)}
        style={plotStyle}
      >
        {state.kind === "loading" ? (
          <>
            <ChartLoading variant={loadingVariant} />
            <span className="sr-only" role="status">
              Loading {ariaLabel ?? "chart"}…
            </span>
          </>
        ) : state.kind === "error" ? (
          <ChartError message={state.reason} />
        ) : state.kind === "empty" ? (
          <ChartEmpty
            title={emptyTitle}
            message={state.reason}
            action={emptyAction}
            icon={emptyIcon}
          />
        ) : raw ? (
          children
        ) : (
          <ResponsiveContainer width="100%" height="100%" debounce={60}>
            {children as never}
          </ResponsiveContainer>
        )}
        {state.kind === "ready" ? overlay : null}
      </div>

      {sideLegend && placement === "right" && legendNode ? (
        <div className="max-h-full w-40 shrink-0 overflow-y-auto no-scrollbar">{legendNode}</div>
      ) : null}
      </SideBySide>

      {placement === "bottom" && legendNode ? <div className="min-w-0">{legendNode}</div> : null}

      {footnote ? (
        <figcaption className="text-meta text-content-subtle">{footnote}</figcaption>
      ) : null}

      {dataTable && table && state.kind === "ready" ? (
        <ChartDataTable
          caption={ariaLabel ?? "Chart data"}
          categoryHeader={table.categoryHeader}
          rows={table.rows}
          columns={table.columns}
          summaryLabel={dataTableLabel}
        />
      ) : null}
    </figure>
  );
}

/* ============================================================================
   Shared hooks
============================================================================ */

/** Animation is on unless the caller says no, or the OS says no. */
export function useChartAnimation(animate: boolean | undefined): boolean {
  const reduced = useReducedMotion();
  return animate !== false && !reduced;
}

/** Formatter bundle every cartesian chart derives once. */
export function useChartFormatters(args: {
  valueFormat?: ValueFormat | undefined;
  formatOptions?: ChartFormatOptions | undefined;
  labelFormat?: LabelFormatter | string | undefined;
}) {
  const { valueFormat, formatOptions, labelFormat } = args;
  return useMemo(() => {
    const options = formatOptions ?? {};
    return {
      value: makeValueFormatter(valueFormat, options),
      axis: makeAxisFormatter(valueFormat, options),
      label: makeLabelFormatter(labelFormat as never, options.locale),
    };
  }, [valueFormat, formatOptions, labelFormat]);
}

/** Measures its element; used by the hand-rolled (non-recharts) charts. */
export function useElementSize<T extends HTMLElement>(): [
  (node: T | null) => void,
  { width: number; height: number },
] {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect();
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const box = entry.contentRect;
      setSize((current) =>
        current.width === box.width && current.height === box.height
          ? current
          : { width: box.width, height: box.height },
      );
    });
    observer.observe(node);
    observerRef.current = observer;
    setSize({ width: node.clientWidth, height: node.clientHeight });
  }, []);

  return [ref, size];
}

