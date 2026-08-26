/**
 * charts/line.tsx — LineChart.
 *
 * Multi-series time series with first-class support for the thing construction
 * dashboards always need and chart libraries never ship: a forecast tail drawn
 * as a dashed continuation of the same line, so "measured" and "projected" are
 * visually distinct without becoming two unrelated series in the legend.
 */
import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  CHART_CURSOR_LINE,
  CHART_MARGIN,
  ChartFrame,
  derivedKey,
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
import { toChartNumber } from "./format";
import type { CartesianChartProps, ChartDatum } from "./types";

export type ChartCurve = "linear" | "monotone" | "step" | "stepAfter" | "stepBefore";

export interface LineChartProps extends CartesianChartProps {
  /** Interpolation. Default "monotone". Use "step" for discrete states. */
  curve?: ChartCurve;
  strokeWidth?: number;
  /** Point markers. "auto" shows them when there are 24 points or fewer. */
  dots?: boolean | "auto";
  /** Bridge gaps in the data. Default false — a gap is information. */
  connectNulls?: boolean;
  /**
   * Category value at which measured data stops and projection begins.
   * Everything from here on is drawn dashed and labelled as forecast.
   * The boundary point belongs to both segments so the line stays continuous.
   */
  forecastFrom?: string | number;
  /** Label on the forecast divider. Default "Forecast". */
  forecastLabel?: string;
  /** Hide the vertical divider at `forecastFrom`. */
  hideForecastDivider?: boolean;
}

export function LineChart({
  data,
  categoryKey,
  series,
  curve = "monotone",
  strokeWidth = 2,
  dots = "auto",
  connectNulls = false,
  forecastFrom,
  forecastLabel = "Forecast",
  hideForecastDivider = false,
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
  tooltipTotal = false,
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
}: LineChartProps) {
  const {
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
    glyph: "line",
    valueFormat,
    formatOptions,
    labelFormat,
    state,
    animate,
    idPrefix: "line",
  });

  const splitIndex = useMemo(() => {
    if (forecastFrom === undefined) return -1;
    return data.findIndex((datum) => datum[categoryKey] === forecastFrom);
  }, [data, categoryKey, forecastFrom]);

  const hasForecast = splitIndex > -1 && splitIndex < data.length - 1;

  /**
   * Split each series into a measured half and a projected half. The boundary
   * row carries a value in BOTH so the dashed segment starts exactly where the
   * solid one ends — no gap, no double-counting in the tooltip (the tooltip
   * dedupes by the base key, and only one half is non-null at any row).
   */
  const plotData = useMemo(() => {
    if (!hasForecast) return data as ChartDatum[];
    return data.map((datum, index) => {
      const next: ChartDatum = { ...datum };
      for (const entry of visible) {
        const raw = datum[entry.key];
        next[entry.key] = index <= splitIndex ? raw : null;
        next[derivedKey(entry.key, "forecast")] = index >= splitIndex ? raw : null;
      }
      return next;
    });
  }, [data, visible, hasForecast, splitIndex]);

  const showDots = dots === "auto" ? data.length <= 24 : dots === true;

  const tooltipContent = useMemo(
    () =>
      makeChartTooltip({
        byKey,
        valueFormat,
        formatOptions,
        labelFormatter: formatters.label,
        total: tooltipTotal,
      }),
    [byKey, valueFormat, formatOptions, formatters.label, tooltipTotal],
  );

  const dotProps = (color: string) =>
    showDots
      ? { r: 3, fill: color, stroke: CHART_SURFACE_COLOR, strokeWidth: 2 }
      : (false as const);

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
      <RechartsLineChart
        data={plotData}
        margin={CHART_MARGIN}
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
          })}
        />

        {renderBands(bands)}
        {renderReferences(references, { orientation: "vertical", formatter: formatters.value })}

        {hasForecast && !hideForecastDivider ? (
          <ReferenceLine
            x={forecastFrom}
            stroke="var(--ds-content-subtle)"
            strokeDasharray="4 4"
            strokeWidth={1}
            label={{
              value: forecastLabel,
              position: "insideTopRight",
              fill: "var(--ds-content-subtle)",
              fontSize: 11,
              offset: 6,
            }}
          />
        ) : null}

        {tooltip ? (
          <Tooltip
            content={tooltipContent}
            cursor={CHART_CURSOR_LINE}
            isAnimationActive={false}
            wrapperStyle={{ outline: "none", zIndex: 90 }}
          />
        ) : null}

        {visible.map((entry) => (
          <Line
            key={entry.key}
            type={curve}
            dataKey={entry.key}
            name={entry.label}
            stroke={entry.color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={entry.dashed ? "6 4" : undefined}
            dot={dotProps(entry.color)}
            activeDot={{ r: 4.5, fill: entry.color, stroke: CHART_SURFACE_COLOR, strokeWidth: 2 }}
            connectNulls={connectNulls}
            isAnimationActive={animated}
            animationDuration={420}
          />
        ))}

        {hasForecast
          ? visible.map((entry) => (
              <Line
                key={derivedKey(entry.key, "forecast")}
                type={curve}
                dataKey={derivedKey(entry.key, "forecast")}
                name={`${entry.label} (forecast)`}
                stroke={entry.color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeDasharray="6 4"
                strokeOpacity={0.9}
                dot={dotProps(entry.color)}
                activeDot={{ r: 4.5, fill: entry.color, stroke: CHART_SURFACE_COLOR, strokeWidth: 2 }}
                connectNulls={false}
                legendType="none"
                isAnimationActive={animated}
                animationDuration={420}
              />
            ))
          : null}
      </RechartsLineChart>
    </ChartFrame>
  );
}

/** Does this dataset have at least one real reading for `key`? */
export function hasSeriesData(data: ReadonlyArray<ChartDatum>, key: string): boolean {
  return data.some((datum) => toChartNumber(datum[key]) !== null);
}
