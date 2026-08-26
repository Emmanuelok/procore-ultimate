/**
 * charts/types.ts — the vocabulary every chart in the layer shares.
 *
 * The rule that shapes all of it: a chart never invents a value. If a series
 * has no data, or every point in it is null, the chart renders its empty state
 * *with the reason* — it does not draw a zero line, because a flat line at zero
 * is a factual claim about the project and it would be false.
 */
import type { ReactNode } from "react";
import type { Tone } from "../tokens";
import type { IconComponent } from "../icons";
import type { ChartFormatOptions, LabelFormatter, ValueFormat } from "./format";

/** A row of chart data. Keys are series keys; the category key holds the label. */
export type ChartDatum = Record<string, unknown>;

/* ============================================================================
   Series
============================================================================ */

export interface ChartSeries {
  /** Property on each datum holding this series' value. */
  key: string;
  /** Legend / tooltip name. Defaults to `key`. */
  label?: string;
  /** Explicit colour. Overrides `tone` and the palette slot. */
  color?: string;
  /** Semantic tone instead of a categorical slot — for plan/actual/variance. */
  tone?: Tone;
  /** Stack membership. Series sharing a `stackId` stack together. */
  stackId?: string;
  /** Start hidden; the legend can bring it back. */
  defaultHidden?: boolean;
  /** Draw as a dashed stroke — plan, target, forecast, budget. */
  dashed?: boolean;
  /** Per-series value formatting. Falls back to the chart's `valueFormat`. */
  format?: ValueFormat;
  /** Suffix printed after the value in tooltips and labels. */
  unit?: string;
  /** Legend swatch shape. Inferred from the chart type when omitted. */
  glyph?: ChartGlyph;
  /** Longer explanation surfaced in the legend's title attribute. */
  description?: string;
}

export type ChartGlyph = "square" | "line" | "dashed" | "dot" | "area" | "ring";

/** Convenience: `series="cost"` is shorthand for `[{ key: "cost" }]`. */
export type ChartSeriesInput = ReadonlyArray<ChartSeries | string> | ChartSeries | string;

/** A series after defaults, palette assignment and visibility are applied. */
export interface ResolvedSeries extends ChartSeries {
  label: string;
  color: string;
  index: number;
  hidden: boolean;
  glyph: ChartGlyph;
}

/* ============================================================================
   Reference marks
============================================================================ */

export interface ChartReference {
  /** Value-axis position. */
  y?: number;
  /** Category-axis position. */
  x?: string | number;
  label?: ReactNode;
  tone?: Tone;
  color?: string;
  /** Default true — a reference is an annotation, not data. */
  dashed?: boolean;
  /** Where the label sits along the line. */
  align?: "start" | "middle" | "end";
}

/** What a value-axis bound may be: a number, or a recharts keyword. */
export type ChartAxisBound = number | "auto" | "dataMin" | "dataMax";

/** A shaded band, e.g. a target corridor or a shutdown period. */
export interface ChartBand {
  from: number | string;
  to: number | string;
  axis?: "x" | "y";
  label?: ReactNode;
  tone?: Tone;
  color?: string;
}

/* ============================================================================
   State
============================================================================ */

export type ChartStateKind = "ready" | "loading" | "empty" | "error";

export interface ChartStateProps {
  /** Skeleton instead of marks. */
  loading?: boolean;
  /** Message (or Error) instead of marks. */
  error?: ReactNode | Error | null;
  /** Force the empty state even when data is present. */
  empty?: boolean;
  /** Headline of the empty state. Default "No data". */
  emptyTitle?: string;
  /**
   * WHY there is nothing to draw. Always shown. If you omit it the chart
   * derives one ("No rows for this period", "Every value is missing", …) —
   * it never silently draws a baseline.
   */
  emptyMessage?: ReactNode;
  /** Action offered from the empty state — "Change filters", "Import". */
  emptyAction?: ReactNode;
  emptyIcon?: IconComponent;
}

/* ============================================================================
   Frame
============================================================================ */

export type ChartLegendPlacement = "top" | "bottom" | "left" | "right" | "none";

export interface ChartFrameProps extends ChartStateProps {
  /**
   * REQUIRED for a standalone chart: what a screen-reader user is told the
   * picture shows. When the chart sits in a <ChartCard>, the card's title is
   * used automatically and this can be omitted.
   */
  ariaLabel?: string;
  /** Longer description, announced after the label. */
  ariaDescription?: string;
  /** Plot height in px (or any CSS length). Default 260. */
  height?: number | string;
  /** Where the legend sits. Default: "bottom" for 2+ series, "none" for one. */
  legend?: boolean | ChartLegendPlacement;
  /** Clicking a legend entry hides/shows its series. Default true. */
  legendToggle?: boolean;
  /** Render the accessible data-table fallback in a <details>. Default true. */
  dataTable?: boolean;
  /** Label on the data-table disclosure. Default "View as table". */
  dataTableLabel?: string;
  /** Footnote under the plot — disclosures, source, "excludes retention". */
  footnote?: ReactNode;
  className?: string;
  /** Class applied to the plot area only. */
  plotClassName?: string;
  id?: string;
}

/** Everything a cartesian chart (bar / line / area) accepts. */
export interface CartesianChartProps extends ChartFrameProps {
  data: ReadonlyArray<ChartDatum>;
  /** Property holding the category / x value. */
  categoryKey: string;
  series: ChartSeriesInput;
  /** Value formatting for tooltip, labels and the table fallback. */
  valueFormat?: ValueFormat;
  formatOptions?: ChartFormatOptions;
  /** Category label formatting. Pass a date style name for time series. */
  labelFormat?: LabelFormatter | "day" | "dayShort" | "month" | "monthYear" | "year" | "quarter" | "weekday";
  /** Axis title on the value axis. */
  valueAxisLabel?: string;
  /** Axis title on the category axis. */
  categoryAxisLabel?: string;
  /** Hide the value axis entirely (sparkline-ish panels). */
  hideValueAxis?: boolean;
  hideCategoryAxis?: boolean;
  /** Fix the value-axis domain. Default: [0, auto] for bars, auto for lines. */
  valueDomain?: readonly [ChartAxisBound, ChartAxisBound];
  /** Grid lines. Default "y" (value-axis rules only). */
  grid?: "x" | "y" | "both" | "none";
  /** Annotation lines. */
  references?: ReadonlyArray<ChartReference>;
  /** Shaded bands. */
  bands?: ReadonlyArray<ChartBand>;
  /** Show the themed tooltip. Default true. */
  tooltip?: boolean;
  /** Add a Total row to the tooltip. Default true when stacked. */
  tooltipTotal?: boolean;
  /** Synchronise hover across charts sharing this id. */
  syncId?: string;
  /** Disable entry animation (also disabled under prefers-reduced-motion). */
  animate?: boolean;
  /** Fired when a category is clicked. */
  onCategoryClick?: (datum: ChartDatum, index: number) => void;
  /** Extra left padding for the value axis, in px. Default auto. */
  valueAxisWidth?: number;
}
