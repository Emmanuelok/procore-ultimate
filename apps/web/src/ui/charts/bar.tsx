/**
 * charts/bar.tsx — BarChart, StackedBarChart, GroupedBarChart.
 *
 * Bars are the workhorse of a construction dashboard: cost by cost-code, RFIs
 * by status, hours by trade. All three components are one implementation with
 * different defaults, so a stacked chart and a grouped chart never drift apart
 * in spacing, corner radius or tooltip behaviour.
 */
import { useMemo } from "react";
import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { cx } from "../cx";
import {
  CHART_CURSOR_BAR,
  CHART_MARGIN,
  ChartFrame,
  ChartPatternDefs,
  makeChartTooltip,
} from "./primitives";
import {
  categoryAxisProps,
  chartRootA11y,
  gridProps,
  rechartsLayout,
  renderBands,
  renderReferences,
  useCartesianChart,
  valueAxisProps,
  type ChartOrientation,
} from "./cartesian";
import { CHART_SURFACE_COLOR, patternFill, resolveMarkColor, withAlpha } from "./palette";
import { toChartNumber } from "./format";
import type { CartesianChartProps, ChartDatum } from "./types";

export interface BarChartProps extends CartesianChartProps {
  /** "vertical" draws columns (default). "horizontal" draws bars rightwards. */
  orientation?: ChartOrientation;
  /** Stack the series instead of grouping them. */
  stacked?: boolean;
  /** "expand" turns a stack into 100%; "sign" splits positives and negatives. */
  stackOffset?: "none" | "expand" | "sign";
  /** Fixed bar thickness in px. Default: derived from the category band. */
  barSize?: number;
  maxBarSize?: number;
  /** Rounded data-end radius. Default 4. */
  cornerRadius?: number;
  /** 2px surface gap between stacked segments. Default true. */
  segmentGap?: boolean;
  /**
   * Print the value on each bar. Defaults to on for a single un-stacked series
   * with 12 categories or fewer — never a number on every point of a dense chart.
   */
  valueLabels?: boolean;
  /**
   * Give every category its own colour. Only legitimate when the category IS
   * the dimension (status, trade, discipline) and there is exactly one series.
   */
  colorByCategory?: boolean;
  /** Per-datum colour override key, used with `colorByCategory`. */
  colorKey?: string;
  /** Hatch fills — for print, forced-colors, or extra CVD relief. */
  texture?: boolean;
  /** Faint track behind each bar showing the category maximum. */
  showTrack?: boolean;
  /** Gap between category bands. Default "22%". */
  categoryGap?: number | string;
}

export function BarChart({
  data,
  categoryKey,
  series,
  orientation = "vertical",
  stacked = false,
  stackOffset = "none",
  barSize,
  maxBarSize = 56,
  cornerRadius = 4,
  segmentGap = true,
  valueLabels,
  colorByCategory = false,
  colorKey,
  texture = false,
  showTrack = false,
  categoryGap = "22%",
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
}: BarChartProps) {
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
    glyph: "square",
    valueFormat,
    formatOptions,
    labelFormat,
    state,
    animate,
    idPrefix: "bar",
  });

  const isPercent = stacked && stackOffset === "expand";
  const showLabels =
    valueLabels ?? (!stacked && visible.length === 1 && data.length <= 12 && !colorByCategory);

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

  const trackMax = useMemo(() => {
    if (!showTrack) return 0;
    let max = 0;
    for (const datum of data) {
      let rowTotal = 0;
      for (const entry of visible) {
        const value = toChartNumber(datum[entry.key]);
        if (value !== null) rowTotal = stacked ? rowTotal + value : Math.max(rowTotal, value);
      }
      max = Math.max(max, rowTotal);
    }
    return max;
  }, [showTrack, data, visible, stacked]);

  const layout = rechartsLayout(orientation);
  const lastVisibleKey = visible[visible.length - 1]?.key;

  const radiusFor = (index: number): [number, number, number, number] | undefined => {
    if (cornerRadius <= 0) return undefined;
    const isCap = !stacked || visible[index]?.key === lastVisibleKey;
    if (!isCap) return [0, 0, 0, 0];
    return orientation === "horizontal"
      ? [0, cornerRadius, cornerRadius, 0]
      : [cornerRadius, cornerRadius, 0, 0];
  };

  const categoryAxis = categoryAxisProps({
    categoryKey,
    labelFormatter: formatters.label,
    orientation,
    hidden: hideCategoryAxis,
    title: categoryAxisLabel,
  });
  const valueAxis = valueAxisProps({
    axisFormatter: formatters.axis,
    orientation,
    hidden: hideValueAxis,
    title: valueAxisLabel,
    domain: valueDomain,
    width: valueAxisWidth,
    percentDomain: isPercent,
  });

  return (
    <ChartFrame
      state={chartState}
      ariaLabel={ariaLabel}
      ariaDescription={ariaDescription}
      height={height}
      legend={legend}
      legendToggle={legendToggle}
      legendSeries={colorByCategory ? [] : all}
      onLegendToggle={toggle}
      dataTable={dataTable}
      dataTableLabel={dataTableLabel}
      table={{ ...table, categoryHeader: categoryAxisLabel ?? "Category" }}
      footnote={footnote}
      className={className}
      plotClassName={cx(plotClassName)}
      id={id}
      loadingVariant="bar"
      {...state}
    >
      <RechartsBarChart
        data={data as ChartDatum[]}
        layout={layout}
        margin={CHART_MARGIN}
        stackOffset={stackOffset}
        barCategoryGap={categoryGap}
        barGap={2}
        maxBarSize={maxBarSize}
        {...(barSize ? { barSize } : {})}
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
        {texture ? (
          <ChartPatternDefs scopeId={chartId} colors={visible.map((entry) => entry.color)} />
        ) : null}

        <CartesianGrid {...gridProps(grid, orientation)} />

        {orientation === "horizontal" ? (
          <>
            <XAxis {...valueAxis} />
            <YAxis {...categoryAxis} />
          </>
        ) : (
          <>
            <XAxis {...categoryAxis} />
            <YAxis {...valueAxis} />
          </>
        )}

        {renderBands(bands, orientation)}
        {renderReferences(references, { orientation, formatter: formatters.value })}

        {tooltip ? (
          <Tooltip
            content={tooltipContent}
            cursor={CHART_CURSOR_BAR}
            isAnimationActive={false}
            wrapperStyle={{ outline: "none", zIndex: 90 }}
          />
        ) : null}

        {visible.map((entry, index) => (
          <Bar
            key={entry.key}
            dataKey={entry.key}
            name={entry.label}
            fill={texture ? patternFill(chartId, index) : entry.color}
            {...(stacked ? { stackId: entry.stackId ?? "stack" } : {})}
            radius={radiusFor(index)}
            isAnimationActive={animated}
            animationDuration={380}
            animationEasing="ease-out"
            activeBar={{ fillOpacity: 0.82 }}
            {...(stacked && segmentGap && visible.length > 1
              ? { stroke: CHART_SURFACE_COLOR, strokeWidth: 2 }
              : {})}
            {...(showTrack && trackMax > 0 && index === 0
              ? { background: { fill: "var(--ds-content)", fillOpacity: 0.035, radius: 4 } }
              : {})}
          >
            {colorByCategory
              ? data.map((datum, cellIndex) => (
                  <Cell
                    key={`cell-${cellIndex}`}
                    fill={resolveMarkColor(
                      {
                        color: colorKey ? (datum[colorKey] as string | undefined) : undefined,
                        tone: undefined,
                      },
                      cellIndex,
                    )}
                  />
                ))
              : null}
            {showLabels ? (
              <LabelList
                dataKey={entry.key}
                position={orientation === "horizontal" ? "right" : "top"}
                offset={6}
                fill="var(--ds-content-muted)"
                fontSize={11}
                formatter={(value) => {
                  const numeric = toChartNumber(value);
                  return numeric === null ? "" : formatters.value(numeric);
                }}
              />
            ) : null}
          </Bar>
        ))}
      </RechartsBarChart>
    </ChartFrame>
  );
}

/* ============================================================================
   Presets
============================================================================ */

export type StackedBarChartProps = Omit<BarChartProps, "stacked">;

/** Composition of a whole: budget by category, hours by trade, cost by phase. */
export function StackedBarChart(props: StackedBarChartProps) {
  return <BarChart {...props} stacked />;
}

export type GroupedBarChartProps = Omit<BarChartProps, "stacked" | "stackOffset">;

/** Side-by-side comparison: this period vs last, budget vs actual vs forecast. */
export function GroupedBarChart(props: GroupedBarChartProps) {
  return <BarChart {...props} stacked={false} />;
}

/** The subtle fill used when a bar needs to read as "context, not data". */
export const BAR_GHOST_FILL = withAlpha("var(--ds-content)", 0.06);
