/**
 * charts/cartesian.tsx — the shared spine of the bar / line / area family.
 *
 * Axes, grids, reference marks and the state/format/series plumbing that all
 * three need. Recharts discovers <XAxis> / <ReferenceLine> by element type, so
 * these are prop builders and element factories rather than components — a
 * wrapper component would be invisible to the chart.
 */
import type { ReactNode } from "react";
import { ReferenceArea, ReferenceLine } from "recharts";
import type { AxisDomainItem } from "recharts";

import {
  CHART_AXIS_LINE,
  CHART_TICK_STYLE,
  axisTitle,
  buildDataTable,
  deriveChartState,
  useChartAnimation,
  useChartFormatters,
  useChartId,
  useChartSeries,
  type ChartDataTableProps,
  type DerivedChartState,
} from "./primitives";
import { CHART_GRID_COLOR, toneColor, withAlpha } from "./palette";
import type { ValueFormatter } from "./format";
import type {
  ChartBand,
  ChartDatum,
  ChartGlyph,
  ChartReference,
  ChartSeriesInput,
  ChartStateProps,
  ResolvedSeries,
} from "./types";
import type { ChartFormatOptions, LabelFormatter, ValueFormat } from "./format";

export type ChartOrientation = "vertical" | "horizontal";

/** Our orientation names describe the BARS; recharts' describe the axes. */
export function rechartsLayout(orientation: ChartOrientation): "horizontal" | "vertical" {
  return orientation === "horizontal" ? "vertical" : "horizontal";
}

/* ============================================================================
   Axis prop builders
============================================================================ */

export interface CategoryAxisArgs {
  categoryKey: string;
  labelFormatter: LabelFormatter;
  orientation: ChartOrientation;
  hidden?: boolean | undefined;
  title?: string | undefined;
  /** px reserved for category labels on a horizontal-bar chart. */
  width?: number | undefined;
  /** Rotate long labels rather than dropping them. */
  angle?: number | undefined;
  /** Category axes on time series can thin their ticks. */
  interval?: number | "preserveStart" | "preserveEnd" | "preserveStartEnd" | "equidistantPreserveStart" | undefined;
}

export function categoryAxisProps(args: CategoryAxisArgs) {
  const { categoryKey, labelFormatter, orientation, hidden, title, width, angle, interval } = args;
  const shared = {
    dataKey: categoryKey,
    type: "category" as const,
    tick: hidden ? false : ({ ...CHART_TICK_STYLE } as const),
    tickLine: false,
    axisLine: CHART_AXIS_LINE,
    tickMargin: 8,
    minTickGap: 4,
    hide: hidden === true,
    tickFormatter: (value: string | number) => labelFormatter(value),
    label: axisTitle(title, orientation === "horizontal" ? "y" : "x"),
  };
  if (orientation === "horizontal") {
    return { ...shared, width: width ?? 120, interval: interval ?? 0 } as const;
  }
  return {
    ...shared,
    height: angle ? 56 : 24,
    interval: interval ?? ("equidistantPreserveStart" as const),
    ...(angle ? { angle, textAnchor: "end" as const, dy: 6 } : {}),
  } as const;
}

export interface ValueAxisArgs {
  axisFormatter: ValueFormatter;
  orientation: ChartOrientation;
  hidden?: boolean | undefined;
  title?: string | undefined;
  domain?: readonly [AxisDomainItem, AxisDomainItem] | undefined;
  width?: number | undefined;
  allowDecimals?: boolean | undefined;
  /** "expand" stacks are always 0…1. */
  percentDomain?: boolean | undefined;
}

export function valueAxisProps(args: ValueAxisArgs) {
  const { axisFormatter, orientation, hidden, title, domain, width, allowDecimals, percentDomain } =
    args;
  const shared = {
    type: "number" as const,
    tick: hidden ? false : ({ ...CHART_TICK_STYLE } as const),
    tickLine: false,
    axisLine: false,
    tickMargin: 6,
    hide: hidden === true,
    allowDecimals: allowDecimals ?? false,
    tickFormatter: (value: number) => axisFormatter(value),
    label: axisTitle(title, orientation === "horizontal" ? "x" : "y"),
    ...(percentDomain ? { domain: [0, 1] as [number, number] } : domain ? { domain } : {}),
  };
  if (orientation === "horizontal") {
    return { ...shared, height: 28 } as const;
  }
  return { ...shared, width: width ?? 52 } as const;
}

export function gridProps(grid: "x" | "y" | "both" | "none" | undefined, orientation: ChartOrientation) {
  const mode = grid ?? "y";
  if (mode === "none") return { horizontal: false, vertical: false, stroke: "transparent" } as const;
  // Rules always run PERPENDICULAR to the bars: value-axis rules, never category ones.
  const valueIsX = orientation === "horizontal";
  const showValueRules = mode === "y" || mode === "both";
  const showCategoryRules = mode === "x" || mode === "both";
  return {
    stroke: CHART_GRID_COLOR,
    strokeDasharray: "0",
    horizontal: valueIsX ? showCategoryRules : showValueRules,
    vertical: valueIsX ? showValueRules : showCategoryRules,
  } as const;
}

/* ============================================================================
   Annotations
============================================================================ */

export function renderReferences(
  references: ReadonlyArray<ChartReference> | undefined,
  options: { orientation: ChartOrientation; formatter: ValueFormatter },
): ReactNode {
  if (!references || references.length === 0) return null;
  return references.map((reference, index) => {
    const color = reference.color ?? (reference.tone ? toneColor(reference.tone) : "var(--ds-content-subtle)");
    const dashed = reference.dashed ?? true;
    const labelValue =
      reference.label ??
      (reference.y !== undefined ? options.formatter(reference.y) : undefined);
    const position =
      reference.align === "start"
        ? ("insideTopLeft" as const)
        : reference.align === "middle"
          ? ("insideTop" as const)
          : ("insideTopRight" as const);
    // `y` always means the VALUE axis and `x` the CATEGORY axis. On a
    // horizontal-bar chart those are swapped in recharts' own terms.
    const swap = options.orientation === "horizontal";
    const valueProp = swap ? "x" : "y";
    const categoryProp = swap ? "y" : "x";
    return (
      <ReferenceLine
        key={`ref-${index}`}
        {...(reference.y !== undefined ? { [valueProp]: reference.y } : {})}
        {...(reference.x !== undefined ? { [categoryProp]: reference.x } : {})}
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray={dashed ? "5 4" : undefined}
        ifOverflow="extendDomain"
        label={
          labelValue != null
            ? {
                value: typeof labelValue === "string" || typeof labelValue === "number" ? labelValue : String(labelValue),
                position,
                fill: color,
                fontSize: 11,
                offset: 6,
              }
            : undefined
        }
      />
    );
  });
}

export function renderBands(
  bands: ReadonlyArray<ChartBand> | undefined,
  orientation: ChartOrientation = "vertical",
): ReactNode {
  if (!bands || bands.length === 0) return null;
  const swap = orientation === "horizontal";
  return bands.map((band, index) => {
    const color = band.color ?? (band.tone ? toneColor(band.tone) : "var(--ds-content)");
    const declared = band.axis ?? "y";
    const axis = swap ? (declared === "y" ? "x" : "y") : declared;
    return (
      <ReferenceArea
        key={`band-${index}`}
        {...(axis === "y" ? { y1: band.from as number, y2: band.to as number } : { x1: band.from, x2: band.to })}
        fill={withAlpha(color, 0.08)}
        stroke={withAlpha(color, 0.24)}
        strokeDasharray="4 4"
        ifOverflow="extendDomain"
        {...(band.label
          ? {
              label: {
                value: String(band.label),
                position: "insideTopLeft" as const,
                fill: "var(--ds-content-subtle)",
                fontSize: 11,
              },
            }
          : {})}
      />
    );
  });
}

/* ============================================================================
   The shared hook
============================================================================ */

export interface UseCartesianArgs {
  data: ReadonlyArray<ChartDatum>;
  categoryKey: string;
  series: ChartSeriesInput;
  glyph: ChartGlyph;
  valueFormat?: ValueFormat | undefined;
  formatOptions?: ChartFormatOptions | undefined;
  labelFormat?: LabelFormatter | string | undefined;
  state: ChartStateProps;
  animate?: boolean | undefined;
  idPrefix: string;
}

export interface UseCartesianResult {
  chartId: string;
  all: ResolvedSeries[];
  visible: ResolvedSeries[];
  byKey: Map<string, ResolvedSeries>;
  toggle: (key: string) => void;
  chartState: DerivedChartState;
  formatters: { value: ValueFormatter; axis: ValueFormatter; label: LabelFormatter };
  animate: boolean;
  table: Pick<ChartDataTableProps, "rows" | "columns">;
}

export function useCartesianChart(args: UseCartesianArgs): UseCartesianResult {
  const { data, categoryKey, series, glyph, valueFormat, formatOptions, labelFormat, state, animate, idPrefix } = args;

  const chartId = useChartId(idPrefix);
  const seriesState = useChartSeries(series, { glyph });
  const formatters = useChartFormatters({ valueFormat, formatOptions, labelFormat });
  const animated = useChartAnimation(animate);

  const chartState = deriveChartState({
    data,
    seriesKeys: seriesState.all.map((entry) => entry.key),
    state,
    allHidden: seriesState.allHidden,
  });

  const table = buildDataTable({
    data,
    categoryKey,
    series: seriesState.all,
    valueFormatter: formatters.value,
    labelFormatter: formatters.label,
    formatOptions,
  });

  return {
    chartId,
    all: seriesState.all,
    visible: seriesState.visible,
    byKey: seriesState.byKey,
    toggle: seriesState.toggle,
    chartState,
    formatters,
    animate: animated,
    table,
  };
}

/** ARIA role for the recharts root: interactive charts are applications. */
export function chartRootA11y(args: {
  ariaLabel: string | undefined;
  ariaDescription: string | undefined;
  interactive: boolean;
}) {
  return {
    accessibilityLayer: args.interactive,
    role: args.interactive ? "application" : "img",
    "aria-label": args.ariaLabel,
    ...(args.ariaLabel ? { title: args.ariaLabel } : {}),
    ...(args.ariaDescription ? { desc: args.ariaDescription } : {}),
  } as const;
}
