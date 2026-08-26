/**
 * charts/scurve.tsx — SCurveChart.
 *
 * The canonical construction progress chart: cumulative planned vs cumulative
 * actual, with the forecast drawn dashed from the data date onward and the
 * gap between plan and actual shaded so slippage is visible at a glance.
 *
 * A series that has no readings at all is not drawn and is not put in the
 * legend — an S-curve with a flat "actual" line at zero would say the project
 * has done nothing, which is a very different statement from "not reported".
 */
import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  CHART_CURSOR_LINE,
  CHART_MARGIN,
  ChartFrame,
  ChartTooltipRow,
  ChartTooltipSurface,
  deriveChartState,
  useChartAnimation,
  useChartFormatters,
  useChartSeries,
} from "./primitives";
import { categoryAxisProps, chartRootA11y, gridProps, valueAxisProps } from "./cartesian";
import { CHART_SURFACE_COLOR, seriesColor, withAlpha } from "./palette";
import { CHART_NO_VALUE, formatChartPercent, toChartNumber } from "./format";
import type { ChartFormatOptions, LabelFormatter, ValueFormat } from "./format";
import type { ChartAxisBound, ChartDatum, ChartFrameProps, ChartSeries } from "./types";

export interface SCurveKeys {
  period?: string;
  planned?: string;
  actual?: string;
  forecast?: string;
  earned?: string;
}

export interface SCurveLabels {
  planned?: string;
  actual?: string;
  forecast?: string;
  earned?: string;
}

export interface SCurveChartProps extends ChartFrameProps {
  data: ReadonlyArray<ChartDatum>;
  /** Defaults: period / planned / actual / forecast / earned. */
  keys?: SCurveKeys;
  labels?: SCurveLabels;
  /**
   * Treat the inputs as PERIOD values and running-sum them into a cumulative
   * curve. Off by default — most schedule exports are already cumulative.
   */
  cumulate?: boolean;
  /** The progress cut-off. Draws a labelled vertical rule. */
  dataDate?: string | number;
  dataDateLabel?: string;
  /** Horizontal target line, e.g. the contract value or 100% of scope. */
  target?: number;
  targetLabel?: string;
  /** Shade the gap between planned and actual. Default true. */
  showVariance?: boolean;
  valueFormat?: ValueFormat;
  formatOptions?: ChartFormatOptions;
  labelFormat?: LabelFormatter | "day" | "dayShort" | "month" | "monthYear" | "year" | "quarter";
  valueAxisLabel?: string;
  categoryAxisLabel?: string;
  hideValueAxis?: boolean;
  valueDomain?: readonly [ChartAxisBound, ChartAxisBound];
  valueAxisWidth?: number;
  grid?: "x" | "y" | "both" | "none";
  tooltip?: boolean;
  animate?: boolean;
  syncId?: string;
}

const BAND_KEY = "__scurveBand";

export function SCurveChart({
  data,
  keys,
  labels,
  cumulate = false,
  dataDate,
  dataDateLabel = "Data date",
  target,
  targetLabel = "Target",
  showVariance = true,
  valueFormat = "number",
  formatOptions,
  labelFormat,
  valueAxisLabel,
  categoryAxisLabel,
  hideValueAxis,
  valueDomain,
  valueAxisWidth,
  grid = "y",
  tooltip = true,
  animate,
  syncId,
  ariaLabel,
  ariaDescription,
  height = 300,
  legend,
  legendToggle,
  dataTable,
  dataTableLabel,
  footnote,
  className,
  plotClassName,
  id,
  ...state
}: SCurveChartProps) {
  const periodKey = keys?.period ?? "period";
  const plannedKey = keys?.planned ?? "planned";
  const actualKey = keys?.actual ?? "actual";
  const forecastKey = keys?.forecast ?? "forecast";
  const earnedKey = keys?.earned ?? "earned";

  const formatters = useChartFormatters({ valueFormat, formatOptions, labelFormat });
  const animated = useChartAnimation(animate);

  /** Only curves that actually have readings become series. */
  const present = useMemo(() => {
    const has = (key: string) => data.some((row) => toChartNumber(row[key]) !== null);
    return {
      planned: has(plannedKey),
      actual: has(actualKey),
      forecast: has(forecastKey),
      earned: has(earnedKey),
    };
  }, [data, plannedKey, actualKey, forecastKey, earnedKey]);

  const seriesDefs = useMemo<ChartSeries[]>(() => {
    const out: ChartSeries[] = [];
    if (present.planned) {
      out.push({
        key: plannedKey,
        label: labels?.planned ?? "Planned",
        color: seriesColor(0),
        glyph: "line",
        description: "Baseline cumulative plan",
      });
    }
    if (present.actual) {
      out.push({
        key: actualKey,
        label: labels?.actual ?? "Actual",
        color: seriesColor(1),
        glyph: "line",
        description: "Cumulative progress reported to date",
      });
    }
    if (present.forecast) {
      out.push({
        key: forecastKey,
        label: labels?.forecast ?? "Forecast",
        color: seriesColor(2),
        dashed: true,
        glyph: "dashed",
        description: "Projected completion from the data date",
      });
    }
    if (present.earned) {
      out.push({
        key: earnedKey,
        label: labels?.earned ?? "Earned value",
        color: seriesColor(3),
        dashed: true,
        glyph: "dashed",
      });
    }
    return out;
  }, [present, plannedKey, actualKey, forecastKey, earnedKey, labels]);

  const seriesState = useChartSeries(seriesDefs, { glyph: "line" });

  const rows = useMemo(() => {
    const running: Record<string, number> = {};
    const trackedKeys = [plannedKey, actualKey, forecastKey, earnedKey];

    return data.map((row) => {
      const next: ChartDatum = { ...row };
      for (const key of trackedKeys) {
        const value = toChartNumber(row[key]);
        if (!cumulate) {
          next[key] = value;
          continue;
        }
        if (value === null) {
          next[key] = null;
          continue;
        }
        running[key] = (running[key] ?? 0) + value;
        next[key] = running[key];
      }
      const planned = toChartNumber(next[plannedKey]);
      const actual = toChartNumber(next[actualKey]);
      next[BAND_KEY] =
        showVariance && planned !== null && actual !== null
          ? [Math.min(planned, actual), Math.max(planned, actual)]
          : null;
      return next;
    });
  }, [data, cumulate, showVariance, plannedKey, actualKey, forecastKey, earnedKey]);

  const chartState = deriveChartState({
    data: rows,
    seriesKeys: seriesDefs.map((entry) => entry.key),
    state,
    allHidden: seriesState.allHidden,
  });

  const tableColumns = seriesState.all.map((entry) => ({ key: entry.key, label: entry.label }));
  const tableRows = rows.map((row) => ({
    label: formatters.label(row[periodKey] as string | number),
    values: seriesState.all.map((entry) => {
      const value = toChartNumber(row[entry.key]);
      return value === null ? CHART_NO_VALUE : formatters.value(value);
    }),
  }));

  const visibleKeys = new Set(seriesState.visible.map((entry) => entry.key));

  return (
    <ChartFrame
      state={chartState}
      ariaLabel={ariaLabel}
      ariaDescription={ariaDescription}
      height={height}
      legend={legend}
      legendToggle={legendToggle}
      legendSeries={seriesState.all}
      onLegendToggle={seriesState.toggle}
      dataTable={dataTable}
      dataTableLabel={dataTableLabel}
      table={{
        rows: tableRows,
        columns: tableColumns,
        categoryHeader: categoryAxisLabel ?? "Period",
      }}
      footnote={footnote}
      className={className}
      plotClassName={plotClassName}
      id={id}
      loadingVariant="line"
      {...state}
    >
      <ComposedChart
        data={rows}
        margin={CHART_MARGIN}
        {...(syncId ? { syncId } : {})}
        {...chartRootA11y({ ariaLabel, ariaDescription, interactive: tooltip })}
      >
        <CartesianGrid {...gridProps(grid, "vertical")} />
        <XAxis
          {...categoryAxisProps({
            categoryKey: periodKey,
            labelFormatter: formatters.label,
            orientation: "vertical",
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

        {target !== undefined ? (
          <ReferenceLine
            y={target}
            stroke="var(--ds-content-subtle)"
            strokeDasharray="5 4"
            strokeWidth={1.5}
            label={{
              value: `${targetLabel} · ${formatters.axis(target)}`,
              position: "insideTopRight",
              fill: "var(--ds-content-subtle)",
              fontSize: 11,
              offset: 6,
            }}
          />
        ) : null}

        {dataDate !== undefined ? (
          <ReferenceLine
            x={dataDate}
            stroke="var(--ds-accent)"
            strokeDasharray="4 4"
            strokeWidth={1.5}
            label={{
              value: dataDateLabel,
              position: "insideTopLeft",
              fill: "var(--ds-accent-text)",
              fontSize: 11,
              offset: 6,
            }}
          />
        ) : null}

        {tooltip ? (
          <Tooltip
            cursor={CHART_CURSOR_LINE}
            isAnimationActive={false}
            wrapperStyle={{ outline: "none", zIndex: 90 }}
            content={(props) => {
              if (!props.active || !props.payload || props.payload.length === 0) return null;
              const row = props.payload[0]?.payload as ChartDatum | undefined;
              if (!row) return null;
              const planned = toChartNumber(row[plannedKey]);
              const actual = toChartNumber(row[actualKey]);
              const variance = planned !== null && actual !== null ? actual - planned : null;
              return (
                <ChartTooltipSurface>
                  <p className="mb-1.5 truncate text-label uppercase text-content-subtle">
                    {formatters.label(row[periodKey] as string | number)}
                  </p>
                  <div className="flex flex-col gap-1">
                    {seriesState.visible.map((entry) => {
                      const value = toChartNumber(row[entry.key]);
                      return (
                        <ChartTooltipRow
                          key={entry.key}
                          color={entry.color}
                          glyph={entry.glyph}
                          label={entry.label}
                          value={value === null ? CHART_NO_VALUE : formatters.value(value)}
                        />
                      );
                    })}
                  </div>
                  {variance !== null ? (
                    <div className="mt-1.5 flex flex-col gap-1 border-t border-border-subtle pt-1.5">
                      <ChartTooltipRow
                        label="Variance"
                        muted
                        value={
                          <span
                            className={
                              variance < 0
                                ? "text-danger-fg"
                                : variance > 0
                                  ? "text-success-fg"
                                  : undefined
                            }
                          >
                            {variance > 0 ? "+" : ""}
                            {formatters.value(variance)}
                          </span>
                        }
                      />
                      {planned !== null && planned !== 0 && actual !== null ? (
                        <ChartTooltipRow
                          label="Of plan"
                          muted
                          value={formatChartPercent(actual / planned)}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </ChartTooltipSurface>
              );
            }}
          />
        ) : null}

        {showVariance && present.planned && present.actual && visibleKeys.has(plannedKey) && visibleKeys.has(actualKey) ? (
          <Area
            type="monotone"
            dataKey={BAND_KEY}
            name="Plan vs actual gap"
            stroke="none"
            fill={withAlpha("var(--ds-content)", 0.1)}
            fillOpacity={1}
            legendType="none"
            tooltipType="none"
            isAnimationActive={animated}
            animationDuration={420}
            connectNulls={false}
          />
        ) : null}

        {seriesState.visible.map((entry) => (
          <Line
            key={entry.key}
            type="monotone"
            dataKey={entry.key}
            name={entry.label}
            stroke={entry.color}
            strokeWidth={entry.key === actualKey ? 2.5 : 2}
            strokeLinecap="round"
            strokeDasharray={entry.dashed ? "6 4" : undefined}
            dot={false}
            activeDot={{ r: 4.5, fill: entry.color, stroke: CHART_SURFACE_COLOR, strokeWidth: 2 }}
            connectNulls={false}
            isAnimationActive={animated}
            animationDuration={460}
          />
        ))}
      </ComposedChart>
    </ChartFrame>
  );
}
