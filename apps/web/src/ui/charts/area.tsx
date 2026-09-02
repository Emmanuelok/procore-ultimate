/**
 * charts/area.tsx — AreaChart and StackedAreaChart.
 *
 * A single area gets a gradient because the fill is decoration for one line.
 * Stacked areas get flat fills separated by a 2px surface-coloured edge,
 * because there the fill IS the data and a gradient would make the top band
 * look heavier than the one beneath it.
 */
import { useMemo } from "react";
import {
  Area,
  AreaChart as RechartsAreaChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  CHART_CURSOR_LINE,
  CHART_MARGIN,
  ChartFrame,
  makeChartTooltip,
} from "./primitives";
import {
  categoryAxisProps,
  chartRootA11y,
  gridProps,
  renderBands,
  renderReferences,
  useCartesianChart,
  valueAxisProps,
} from "./cartesian";
import { CHART_SURFACE_COLOR } from "./palette";
import type { ChartCurve } from "./line";
import type { CartesianChartProps, ChartDatum } from "./types";

export interface AreaChartProps extends CartesianChartProps {
  curve?: ChartCurve;
  strokeWidth?: number;
  /** Stack the series. */
  stacked?: boolean;
  /** "expand" turns the stack into a 100% composition chart. */
  stackOffset?: "none" | "expand";
  /** Gradient fill. Default: on for un-stacked, off for stacked. */
  gradient?: boolean;
  /** Peak fill opacity. Default 0.3 un-stacked, 0.85 stacked. */
  fillOpacity?: number;
  dots?: boolean;
  connectNulls?: boolean;
  /** 2px surface edge between stacked bands. Default true when stacked. */
  segmentGap?: boolean;
}

export function AreaChart({
  data,
  categoryKey,
  series,
  curve = "monotone",
  strokeWidth = 2,
  stacked = false,
  stackOffset = "none",
  gradient,
  fillOpacity,
  dots = false,
  connectNulls = false,
  segmentGap,
  valueFormat,
  formatOptions,
  labelFormat,
  valueAxisLabel,
  categoryAxisLabel,
  hideValueAxis,
  hideCategoryAxis,
  valueDomain,
  valueAxisWidth,
  grid = "y",
  references,
  bands,
  tooltip = true,
  tooltipTotal,
  syncId,
  animate,
  onCategoryClick,
  ariaLabel,
  ariaDescription,
  height = 260,
  legend,
  legendToggle,
  dataTable,
  dataTableLabel,
  footnote,
  className,
  plotClassName,
  id,
  ...state
}: AreaChartProps) {
  const {
    chartId,
    all,
    visible,
    byKey,
    toggle,
    chartState,
    formatters,
    animate: animated,
    table,
  } = useCartesianChart({
    data,
    categoryKey,
    series,
    glyph: "area",
    valueFormat,
    formatOptions,
    labelFormat,
    state,
    animate,
    idPrefix: "area",
  });

  const useGradient = gradient ?? !stacked;
  const peakOpacity = fillOpacity ?? (stacked ? 0.85 : 0.3);
  const isPercent = stacked && stackOffset === "expand";
  const showEdge = (segmentGap ?? true) && stacked && visible.length > 1;

  const tooltipContent = useMemo(
    () =>
      makeChartTooltip({
        byKey,
        valueFormat,
        formatOptions,
        labelFormatter: formatters.label,
        total: tooltipTotal ?? (stacked && visible.length > 1),
        sort: stacked,
      }),
    [byKey, valueFormat, formatOptions, formatters.label, tooltipTotal, stacked, visible.length],
  );

  return (
    <ChartFrame
      state={chartState}
      ariaLabel={ariaLabel}
      ariaDescription={ariaDescription}
      height={height}
      legend={legend}
      legendToggle={legendToggle}
      legendSeries={all}
      onLegendToggle={toggle}
      dataTable={dataTable}
      dataTableLabel={dataTableLabel}
      table={{ ...table, categoryHeader: categoryAxisLabel ?? "Period" }}
      footnote={footnote}
      className={className}
      plotClassName={plotClassName}
      id={id}
      loadingVariant="line"
      {...state}
    >
      <RechartsAreaChart
        data={data as ChartDatum[]}
        margin={CHART_MARGIN}
        stackOffset={stackOffset}
        {...(syncId ? { syncId } : {})}
        {...chartRootA11y({ ariaLabel, ariaDescription, interactive: tooltip })}
        {...(onCategoryClick
          ? {
              onClick: (next: { activeIndex?: number | string | null }) => {
                const index = typeof next?.activeIndex === "number" ? next.activeIndex : -1;
                const datum = index >= 0 ? data[index] : undefined;
                if (datum) onCategoryClick(datum, index);
              },
            }
          : {})}
      >
        {useGradient ? (
          <defs>
            {visible.map((entry, index) => (
              <linearGradient
                key={entry.key}
                id={`${chartId}-fill-${index}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor={entry.color} stopOpacity={peakOpacity} />
                <stop offset="100%" stopColor={entry.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
        ) : null}

        <CartesianGrid {...gridProps(grid, "vertical")} />
        <XAxis
          {...categoryAxisProps({
            categoryKey,
            labelFormatter: formatters.label,
            orientation: "vertical",
            hidden: hideCategoryAxis,
            title: categoryAxisLabel,
          })}
        />
        <YAxis
          {...valueAxisProps({
            axisFormatter: formatters.axis,
            orientation: "vertical",
            hidden: hideValueAxis,
            title: valueAxisLabel,
            domain: valueDomain,
            width: valueAxisWidth,
            percentDomain: isPercent,
          })}
        />

        {renderBands(bands)}
        {renderReferences(references, { orientation: "vertical", formatter: formatters.value })}

        {tooltip ? (
          <Tooltip
            content={tooltipContent}
            cursor={CHART_CURSOR_LINE}
            isAnimationActive={false}
            wrapperStyle={{ outline: "none", zIndex: 90 }}
          />
        ) : null}

        {visible.map((entry, index) => (
          <Area
            key={entry.key}
            type={curve}
            dataKey={entry.key}
            name={entry.label}
            stroke={showEdge ? CHART_SURFACE_COLOR : entry.color}
            strokeWidth={showEdge ? 2 : strokeWidth}
            strokeDasharray={entry.dashed ? "6 4" : undefined}
            fill={useGradient ? `url(#${chartId}-fill-${index})` : entry.color}
            fillOpacity={useGradient ? 1 : peakOpacity}
            {...(stacked ? { stackId: entry.stackId ?? "stack" } : {})}
            dot={dots ? { r: 2.5, fill: entry.color, stroke: CHART_SURFACE_COLOR, strokeWidth: 2 } : false}
            activeDot={{ r: 4.5, fill: entry.color, stroke: CHART_SURFACE_COLOR, strokeWidth: 2 }}
            connectNulls={connectNulls}
            isAnimationActive={animated}
            animationDuration={420}
          />
        ))}
      </RechartsAreaChart>
    </ChartFrame>
  );
}

export type StackedAreaChartProps = Omit<AreaChartProps, "stacked">;

/** Cumulative composition over time: spend by category, hours by trade. */
export function StackedAreaChart(props: StackedAreaChartProps) {
  return <AreaChart {...props} stacked />;
}
