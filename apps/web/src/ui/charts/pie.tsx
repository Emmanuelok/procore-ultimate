/**
 * charts/pie.tsx — DonutChart and PieChart.
 *
 * A donut with a centre metric is the only pie-family chart most dashboards
 * should ever use: the ring shows composition, the hole carries the headline
 * number so the reader gets the answer without decoding an angle. Both
 * components direct-label their slices in the legend with value AND share, so
 * identity is never carried by colour alone.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Cell, Pie, PieChart as RechartsPieChart, Tooltip } from "recharts";

import { cx } from "../cx";
import type { Tone } from "../tokens";
import {
  ChartFrame,
  ChartPatternDefs,
  ChartTooltipSurface,
  ChartTooltipRow,
  deriveChartState,
  useChartAnimation,
  useChartId,
  type DerivedChartState,
} from "./primitives";
import { chartRootA11y } from "./cartesian";
import {
  CHART_NEUTRAL_COLOR,
  CHART_SURFACE_COLOR,
  patternFill,
  resolveMarkColor,
} from "./palette";
import {
  makeValueFormatter,
  toChartNumber,
  formatChartPercent,
  type ChartFormatOptions,
  type ValueFormat,
} from "./format";
import type { ChartDatum, ChartFrameProps, ResolvedSeries } from "./types";

/* ============================================================================
   Slices
============================================================================ */

export interface ChartSlice {
  /** Stable id. Defaults to `label`. */
  key?: string;
  label: string;
  value: number;
  color?: string;
  tone?: Tone;
  description?: string;
}

interface ResolvedSlice extends ChartSlice {
  key: string;
  color: string;
  index: number;
  share: number;
  hidden: boolean;
}

export interface PieChartProps extends ChartFrameProps {
  /** `ChartSlice[]`, or any rows plus `labelKey` / `valueKey`. */
  data: ReadonlyArray<ChartSlice | ChartDatum>;
  labelKey?: string;
  valueKey?: string;
  colorKey?: string;
  valueFormat?: ValueFormat;
  formatOptions?: ChartFormatOptions;
  /** Print each slice's share of the total in the legend. Default true. */
  showShare?: boolean;
  /** Largest slice first. Default true. */
  sort?: boolean;
  /**
   * Fold everything past the Nth slice into a single, clearly-labelled "Other".
   * Defaults to 7 — the size of the categorical palette. Nothing is ever given
   * a recycled hue.
   */
  maxSlices?: number;
  otherLabel?: string;
  tooltip?: boolean;
  texture?: boolean;
  animate?: boolean;
  /** Where the legend sits. Default "right" for donut, "bottom" for pie. */
  legendPosition?: "bottom" | "right" | "none";
  onSliceClick?: (slice: ChartSlice, index: number) => void;
}

export interface DonutChartProps extends PieChartProps {
  /** Headline in the hole. Defaults to the formatted total. */
  centerValue?: ReactNode;
  /** Small caps label above the headline. */
  centerLabel?: ReactNode;
  /** Muted line under the headline. */
  centerCaption?: ReactNode;
  /** Suppress the automatic total when you have nothing to put in the hole. */
  showCenter?: boolean;
  /** Ring thickness as a fraction of the radius. Default 0.34. */
  thickness?: number;
}

/* ============================================================================
   Shared implementation
============================================================================ */

function readSlices(
  data: ReadonlyArray<ChartSlice | ChartDatum>,
  keys: { labelKey: string; valueKey: string; colorKey: string },
): ChartSlice[] {
  return data.map((row) => {
    const record = row as ChartDatum;
    const value = toChartNumber(record[keys.valueKey]);
    return {
      key: (record["key"] as string | undefined) ?? String(record[keys.labelKey] ?? ""),
      label: String(record[keys.labelKey] ?? ""),
      value: value ?? 0,
      color: record[keys.colorKey] as string | undefined,
      tone: record["tone"] as Tone | undefined,
      description: record["description"] as string | undefined,
    };
  });
}

interface PieBaseProps extends DonutChartProps {
  variant: "pie" | "donut";
}

function PieBase({
  variant,
  data,
  labelKey = "label",
  valueKey = "value",
  colorKey = "color",
  valueFormat,
  formatOptions,
  showShare = true,
  sort = true,
  maxSlices = 7,
  otherLabel = "Other",
  tooltip = true,
  texture = false,
  animate,
  legendPosition,
  onSliceClick,
  centerValue,
  centerLabel,
  centerCaption,
  showCenter = true,
  thickness = 0.34,
  ariaLabel,
  ariaDescription,
  height = 260,
  legend,
  legendToggle = true,
  dataTable,
  dataTableLabel,
  footnote,
  className,
  plotClassName,
  id,
  ...state
}: PieBaseProps) {
  const chartId = useChartId(variant);
  const animated = useChartAnimation(animate);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const formatter = useMemo(
    () => makeValueFormatter(valueFormat, formatOptions ?? {}),
    [valueFormat, formatOptions],
  );

  const toggle = useCallback((key: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const slices = useMemo<ResolvedSlice[]>(() => {
    const raw = readSlices(data, { labelKey, valueKey, colorKey }).filter(
      (slice) => Number.isFinite(slice.value),
    );
    const ordered = sort ? [...raw].sort((a, b) => b.value - a.value) : raw;

    let working = ordered;
    if (maxSlices > 0 && ordered.length > maxSlices) {
      const head = ordered.slice(0, maxSlices - 1);
      const tail = ordered.slice(maxSlices - 1);
      const rest = tail.reduce((sum, slice) => sum + slice.value, 0);
      working = [
        ...head,
        {
          key: "__other",
          label: otherLabel,
          value: rest,
          color: CHART_NEUTRAL_COLOR,
          description: `${tail.length} smaller categories combined`,
        },
      ];
    }

    const visibleTotal = working.reduce(
      (sum, slice) => (hidden.has(slice.key ?? slice.label) ? sum : sum + slice.value),
      0,
    );

    return working.map((slice, index) => {
      const key = slice.key ?? slice.label;
      return {
        ...slice,
        key,
        index,
        color: resolveMarkColor(slice, index),
        share: visibleTotal > 0 ? slice.value / visibleTotal : 0,
        hidden: hidden.has(key),
      };
    });
  }, [data, labelKey, valueKey, colorKey, sort, maxSlices, otherLabel, hidden]);

  const visible = useMemo(() => slices.filter((slice) => !slice.hidden), [slices]);
  const total = useMemo(() => visible.reduce((sum, slice) => sum + slice.value, 0), [visible]);
  const allZero = slices.length > 0 && slices.every((slice) => slice.value === 0);

  const chartState: DerivedChartState = deriveChartState({
    data: slices as unknown as ChartDatum[],
    seriesKeys: ["value"],
    state,
    allHidden: slices.length > 0 && visible.length === 0,
  });
  const resolvedState: DerivedChartState = allZero
    ? {
        kind: "empty",
        reason:
          state.emptyMessage ??
          "Every category is zero — there is no composition to show for this selection.",
      }
    : chartState;

  const legendSeries: ResolvedSeries[] = slices.map((slice) => ({
    key: slice.key,
    label: slice.label,
    color: slice.color,
    index: slice.index,
    hidden: slice.hidden,
    glyph: "square",
    description: slice.description,
  }));

  const legendValues: Record<string, ReactNode> = {};
  for (const slice of slices) {
    legendValues[slice.key] = slice.hidden ? (
      "—"
    ) : (
      <span className="inline-flex items-baseline gap-1.5">
        <span>{formatter(slice.value)}</span>
        {showShare ? (
          <span className="text-content-subtle">{formatChartPercent(slice.share)}</span>
        ) : null}
      </span>
    );
  }

  const tableRows = slices.map((slice) => ({
    label: slice.label,
    values: [formatter(slice.value), formatChartPercent(slice.share)],
  }));

  const outer = variant === "donut" ? "86%" : "88%";
  const inner = variant === "donut" ? `${Math.round((1 - thickness) * 86)}%` : 0;

  const placement =
    legend !== undefined
      ? legend
      : legendPosition ?? (variant === "donut" ? "right" : "bottom");

  const centre =
    variant === "donut" && showCenter ? (
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <div className="flex flex-col items-center text-center">
          {centerLabel ? (
            <span className="text-label uppercase text-content-subtle">{centerLabel}</span>
          ) : null}
          <span className="text-display-xs font-semibold tabular-nums text-content">
            {centerValue ?? formatter(total)}
          </span>
          {centerCaption ? (
            <span className="mt-0.5 max-w-[10rem] text-meta text-content-muted">{centerCaption}</span>
          ) : null}
        </div>
      </div>
    ) : null;

  return (
    <ChartFrame
      state={resolvedState}
      ariaLabel={ariaLabel}
      ariaDescription={ariaDescription}
      height={height}
      legend={placement}
      legendToggle={legendToggle}
      legendSeries={legendSeries}
      onLegendToggle={toggle}
      legendValues={legendValues}
      dataTable={dataTable}
      dataTableLabel={dataTableLabel}
      table={{
        rows: tableRows,
        columns: [
          { key: "value", label: "Value" },
          { key: "share", label: "Share" },
        ],
        categoryHeader: "Category",
      }}
      footnote={footnote}
      className={className}
      plotClassName={cx(plotClassName)}
      id={id}
      loadingVariant="block"
      overlay={centre}
      {...state}
    >
      <RechartsPieChart
        margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
        {...chartRootA11y({ ariaLabel, ariaDescription, interactive: tooltip })}
      >
        {texture ? (
          <ChartPatternDefs scopeId={chartId} colors={visible.map((slice) => slice.color)} />
        ) : null}

        {tooltip ? (
          <Tooltip
            isAnimationActive={false}
            wrapperStyle={{ outline: "none", zIndex: 90 }}
            content={(props) => {
              if (!props.active || !props.payload || props.payload.length === 0) return null;
              const entry = props.payload[0];
              const datum = entry?.payload as ResolvedSlice | undefined;
              if (!datum) return null;
              return (
                <ChartTooltipSurface>
                  <ChartTooltipRow
                    color={datum.color}
                    label={datum.label}
                    value={formatter(datum.value)}
                  />
                  <div className="mt-1 pl-[1.375rem] text-content-subtle">
                    {formatChartPercent(datum.share)} of {formatter(total)}
                  </div>
                </ChartTooltipSurface>
              );
            }}
          />
        ) : null}

        <Pie
          data={visible}
          dataKey="value"
          nameKey="label"
          cx="50%"
          cy="50%"
          innerRadius={inner}
          outerRadius={outer}
          paddingAngle={visible.length > 1 ? 2 : 0}
          cornerRadius={3}
          minAngle={2}
          stroke={CHART_SURFACE_COLOR}
          strokeWidth={1}
          isAnimationActive={animated}
          animationDuration={420}
          {...(onSliceClick
            ? {
                onClick: (_: unknown, index: number) => {
                  const slice = visible[index];
                  if (slice) onSliceClick(slice, index);
                },
              }
            : {})}
        >
          {visible.map((slice, index) => (
            <Cell
              key={slice.key}
              fill={texture ? patternFill(chartId, index) : slice.color}
              style={onSliceClick ? { cursor: "pointer" } : undefined}
            />
          ))}
        </Pie>
      </RechartsPieChart>
    </ChartFrame>
  );
}

/* ============================================================================
   Public components
============================================================================ */

/**
 * Composition with the headline in the hole.
 *
 *   <DonutChart
 *     data={[{ label: "Committed", value: 8_420_000 }, …]}
 *     valueFormat="currency"
 *     centerLabel="Contract value"
 *     ariaLabel="Contract value by commitment status"
 *   />
 */
export function DonutChart(props: DonutChartProps) {
  return <PieBase variant="donut" {...props} />;
}

/** Composition without a centre metric. Prefer <DonutChart> where you have one. */
export function PieChart(props: PieChartProps) {
  return <PieBase variant="pie" {...props} />;
}
