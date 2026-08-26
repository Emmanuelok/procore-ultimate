/**
 * charts/waterfall.tsx — WaterfallChart.
 *
 * The bridge chart. Original contract → change orders → approved variations →
 * revised contract; or budget → committed → forecast variance → EAC. Every
 * commercial conversation in construction is a waterfall, and no chart library
 * ships one, so this builds it on a ranged bar with a custom shape that also
 * draws the connector to the next step.
 *
 *   <WaterfallChart
 *     data={[
 *       { label: "Original", value: 12_400_000, kind: "total" },
 *       { label: "Approved COs", value: 840_000 },
 *       { label: "Pending COs", value: 260_000 },
 *       { label: "Credits", value: -95_000 },
 *       { label: "Revised", kind: "total" },
 *     ]}
 *     valueFormat="currency"
 *     higherIsBetter={false}
 *     ariaLabel="Contract value bridge"
 *   />
 */
import { useMemo } from "react";
import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
} from "recharts";

import type { Tone } from "../tokens";
import {
  CHART_CURSOR_BAR,
  CHART_MARGIN,
  ChartFrame,
  ChartTooltipRow,
  ChartTooltipSurface,
  deriveChartState,
  useChartAnimation,
  useChartFormatters,
} from "./primitives";
import {
  categoryAxisProps,
  chartRootA11y,
  gridProps,
  renderReferences,
  valueAxisProps,
} from "./cartesian";
import { toneColor, withAlpha } from "./palette";
import { CHART_NO_VALUE, type ChartFormatOptions, type ValueFormat } from "./format";
import type { ChartDatum, ChartFrameProps, ChartReference } from "./types";
import type { LabelFormatter } from "./format";

/* ============================================================================
   Model
============================================================================ */

export type WaterfallKind = "delta" | "subtotal" | "total";

export interface WaterfallStep {
  label: string;
  /**
   * For a `delta` step: the movement. For `subtotal` / `total`: the absolute
   * value of the bar — omit it and the running total is used, which is the
   * usual case for a closing balance.
   */
  value?: number | null;
  kind?: WaterfallKind;
  /** Override the automatic up/down colouring. */
  tone?: Tone;
  color?: string;
  /** Extra line in the tooltip — "3 pending, 1 disputed". */
  note?: string;
}

interface WaterfallRow extends ChartDatum {
  label: string;
  span: [number, number] | null;
  delta: number | null;
  running: number;
  kind: WaterfallKind;
  note?: string | undefined;
  fill: string;
  connectorTop: boolean;
  showConnector: boolean;
}

export interface WaterfallChartProps extends ChartFrameProps {
  data: ReadonlyArray<WaterfallStep>;
  /** Opening balance the first delta builds on. Default 0. */
  baseline?: number;
  valueFormat?: ValueFormat;
  formatOptions?: ChartFormatOptions;
  labelFormat?: LabelFormatter;
  /**
   * Whether a rising bar is good news. Cost bridges want `false` so an increase
   * paints as danger; revenue and progress bridges want the default `true`.
   */
  higherIsBetter?: boolean;
  positiveTone?: Tone;
  negativeTone?: Tone;
  totalTone?: Tone;
  subtotalTone?: Tone;
  valueAxisLabel?: string;
  categoryAxisLabel?: string;
  hideValueAxis?: boolean;
  valueAxisWidth?: number;
  grid?: "x" | "y" | "both" | "none";
  references?: ReadonlyArray<ChartReference>;
  tooltip?: boolean;
  animate?: boolean;
  /** Show the connector line between steps. Default true. */
  connectors?: boolean;
  /** Print each step's movement above its bar. Default true. */
  valueLabels?: boolean;
  onStepClick?: (step: WaterfallStep, index: number) => void;
}

/** Fraction of the category band left empty; also the connector length. */
const CATEGORY_GAP = 0.26;

/* ============================================================================
   Bar + connector
============================================================================ */

function WaterfallShape(props: BarShapeProps) {
  const { x, y, width, height, payload } = props;
  const row = payload as WaterfallRow | undefined;
  if (row?.span == null || typeof x !== "number" || typeof y !== "number") return null;
  const w = typeof width === "number" ? width : 0;
  const rawHeight = typeof height === "number" ? Math.abs(height) : 0;
  const h = Math.max(rawHeight, 2);
  const top = rawHeight < 2 ? y - (2 - rawHeight) / 2 : y;
  const radius = Math.min(4, w / 2, h / 2);
  const connectorLength = (w * CATEGORY_GAP) / (1 - CATEGORY_GAP);
  const connectorY = row.connectorTop ? top : top + h;

  return (
    <g>
      <rect x={x} y={top} width={w} height={h} rx={radius} ry={radius} fill={row.fill} />
      {row.showConnector ? (
        <line
          x1={x + w}
          y1={connectorY}
          x2={x + w + connectorLength}
          y2={connectorY}
          stroke="var(--ds-chart-axis)"
          strokeOpacity={0.55}
          strokeWidth={1}
          strokeDasharray="2 2"
        />
      ) : null}
    </g>
  );
}

/* ============================================================================
   Component
============================================================================ */

export function WaterfallChart({
  data,
  baseline = 0,
  valueFormat = "number",
  formatOptions,
  labelFormat,
  higherIsBetter = true,
  positiveTone,
  negativeTone,
  totalTone = "accent",
  subtotalTone = "neutral",
  valueAxisLabel,
  categoryAxisLabel,
  hideValueAxis,
  valueAxisWidth,
  grid = "y",
  references,
  tooltip = true,
  animate,
  connectors = true,
  valueLabels = true,
  onStepClick,
  ariaLabel,
  ariaDescription,
  height = 280,
  legend = "none",
  dataTable,
  dataTableLabel,
  footnote,
  className,
  plotClassName,
  id,
  ...state
}: WaterfallChartProps) {
  const formatters = useChartFormatters({ valueFormat, formatOptions, labelFormat });
  const animated = useChartAnimation(animate);

  const upTone: Tone = positiveTone ?? (higherIsBetter ? "success" : "danger");
  const downTone: Tone = negativeTone ?? (higherIsBetter ? "danger" : "success");

  const rows = useMemo<WaterfallRow[]>(() => {
    let running = baseline;
    const out: WaterfallRow[] = [];

    data.forEach((step, index) => {
      const kind: WaterfallKind = step.kind ?? "delta";
      const isTotal = kind === "total" || kind === "subtotal";
      const raw = typeof step.value === "number" && Number.isFinite(step.value) ? step.value : null;
      const last = index === data.length - 1;

      if (isTotal) {
        const absolute = raw ?? running;
        running = absolute;
        const tone = step.tone ?? (kind === "total" ? totalTone : subtotalTone);
        out.push({
          label: step.label,
          span: [0, absolute],
          delta: null,
          running: absolute,
          kind,
          note: step.note,
          fill: step.color ?? toneColor(tone),
          connectorTop: absolute >= 0,
          showConnector: connectors && !last,
        });
        return;
      }

      if (raw === null) {
        // Nothing reported for this step — leave a gap, do NOT draw a zero bar.
        out.push({
          label: step.label,
          span: null,
          delta: null,
          running,
          kind,
          note: step.note,
          fill: "transparent",
          connectorTop: true,
          showConnector: false,
        });
        return;
      }

      const start = running;
      const end = running + raw;
      running = end;
      const tone = step.tone ?? (raw >= 0 ? upTone : downTone);
      out.push({
        label: step.label,
        span: [start, end],
        delta: raw,
        running: end,
        kind,
        note: step.note,
        fill: step.color ?? toneColor(tone),
        connectorTop: raw >= 0 ? end >= start : end < start,
        showConnector: connectors && !last,
      });
    });

    return out;
  }, [data, baseline, connectors, upTone, downTone, totalTone, subtotalTone]);

  const hasBar = rows.some((row) => row.span !== null);

  const chartState = deriveChartState({
    data: hasBar ? (rows as ChartDatum[]) : [],
    seriesKeys: ["running"],
    state,
  });

  const tableRows = rows.map((row) => ({
    label: row.label,
    values: [
      row.kind === "delta"
        ? row.delta === null
          ? CHART_NO_VALUE
          : formatters.value(row.delta)
        : "—",
      formatters.value(row.running),
    ],
  }));

  return (
    <ChartFrame
      state={chartState}
      ariaLabel={ariaLabel}
      ariaDescription={ariaDescription}
      height={height}
      legend={legend}
      legendSeries={[]}
      dataTable={dataTable}
      dataTableLabel={dataTableLabel}
      table={{
        rows: tableRows,
        columns: [
          { key: "delta", label: "Movement" },
          { key: "running", label: "Running total" },
        ],
        categoryHeader: categoryAxisLabel ?? "Step",
      }}
      footnote={footnote}
      className={className}
      plotClassName={plotClassName}
      id={id}
      loadingVariant="bar"
      {...state}
    >
      <RechartsBarChart
        data={rows}
        margin={{ ...CHART_MARGIN, top: valueLabels ? 20 : 8 }}
        barCategoryGap={`${CATEGORY_GAP * 100}%`}
        {...chartRootA11y({ ariaLabel, ariaDescription, interactive: tooltip })}
        {...(onStepClick
          ? {
              onClick: (next: { activeIndex?: number | string | null }) => {
                const index = typeof next?.activeIndex === "number" ? next.activeIndex : -1;
                const step = index >= 0 ? data[index] : undefined;
                if (step) onStepClick(step, index);
              },
            }
          : {})}
      >
        <CartesianGrid {...gridProps(grid, "vertical")} />
        <XAxis
          {...categoryAxisProps({
            categoryKey: "label",
            labelFormatter: formatters.label,
            orientation: "vertical",
            title: categoryAxisLabel,
            interval: 0,
          })}
        />
        <YAxis
          {...valueAxisProps({
            axisFormatter: formatters.axis,
            orientation: "vertical",
            hidden: hideValueAxis,
            title: valueAxisLabel,
            width: valueAxisWidth,
          })}
        />

        <ReferenceLine y={baseline} stroke="var(--ds-chart-axis)" strokeOpacity={0.6} strokeWidth={1} />
        {renderReferences(references, { orientation: "vertical", formatter: formatters.value })}

        {tooltip ? (
          <Tooltip
            cursor={CHART_CURSOR_BAR}
            isAnimationActive={false}
            wrapperStyle={{ outline: "none", zIndex: 90 }}
            content={(props) => {
              if (!props.active || !props.payload || props.payload.length === 0) return null;
              const row = props.payload[0]?.payload as WaterfallRow | undefined;
              if (!row) return null;
              return (
                <ChartTooltipSurface>
                  <p className="mb-1.5 truncate text-label uppercase text-content-subtle">
                    {row.label}
                  </p>
                  {row.kind === "delta" ? (
                    <ChartTooltipRow
                      color={row.span ? row.fill : undefined}
                      label="Movement"
                      value={
                        row.delta === null
                          ? CHART_NO_VALUE
                          : `${row.delta > 0 ? "+" : ""}${formatters.value(row.delta)}`
                      }
                    />
                  ) : null}
                  <ChartTooltipRow
                    label={row.kind === "delta" ? "Running total" : "Balance"}
                    value={formatters.value(row.running)}
                    muted={row.kind === "delta"}
                  />
                  {row.delta === null && row.kind === "delta" ? (
                    <p className="mt-1.5 border-t border-border-subtle pt-1.5 text-content-subtle">
                      No value reported for this step.
                    </p>
                  ) : null}
                  {row.note ? (
                    <p className="mt-1.5 border-t border-border-subtle pt-1.5 text-content-subtle">
                      {row.note}
                    </p>
                  ) : null}
                </ChartTooltipSurface>
              );
            }}
          />
        ) : null}

        <Bar
          dataKey="span"
          shape={WaterfallShape}
          isAnimationActive={animated}
          animationDuration={380}
          {...(valueLabels
            ? {
                label: {
                  position: "top" as const,
                  offset: 8,
                  fontSize: 11,
                  fill: "var(--ds-content-muted)",
                  valueAccessor: (entry: { payload?: unknown }) => {
                    const row = entry.payload as WaterfallRow | undefined;
                    if (!row) return "";
                    if (row.kind !== "delta") return formatters.axis(row.running);
                    if (row.delta === null) return CHART_NO_VALUE;
                    return `${row.delta > 0 ? "+" : ""}${formatters.axis(row.delta)}`;
                  },
                },
              }
            : {})}
        />
      </RechartsBarChart>
    </ChartFrame>
  );
}

/** Tint used by callers that want to shade a waterfall's background band. */
export const WATERFALL_BAND_FILL = withAlpha("var(--ds-content)", 0.04);
