/**
 * ../ui/charts — the DATA-VISUALISATION layer.
 *
 *     import { ChartCard, BarChart, SCurveChart } from "../../ui";
 *     // or, before the barrel wires this module up:
 *     import { ChartCard, BarChart } from "../../ui/charts";
 *
 * ---------------------------------------------------------------------------
 * THE SHORT VERSION
 *
 *   <ChartCard
 *     title="Cost by trade"
 *     subtitle="Committed vs forecast, current period"
 *     metric={formatChartCurrency(18_420_000)}
 *     delta={-0.043}
 *     higherIsBetter={false}
 *     deltaCaption="vs last month"
 *     footnote="Excludes retention and unapproved variations."
 *     actions={<Button size="sm" variant="ghost">Export</Button>}
 *   >
 *     <GroupedBarChart
 *       data={rows}
 *       categoryKey="trade"
 *       series={[
 *         { key: "committed", label: "Committed" },
 *         { key: "forecast",  label: "Forecast" },
 *       ]}
 *       valueFormat="currency"
 *       ariaLabel="Committed and forecast cost by trade"
 *     />
 *   </ChartCard>
 *
 * ---------------------------------------------------------------------------
 * WHAT IS IN HERE
 *
 *   ChartCard          the panel: title, subtitle, hero metric + delta, actions,
 *                      toolbar, legend rail, footnote rail.
 *   BarChart           columns or horizontal bars, 1..n series.
 *   StackedBarChart    composition of a whole (`stackOffset="expand"` → 100%).
 *   GroupedBarChart    side-by-side comparison.
 *   LineChart          multi-series time series; `forecastFrom` continues each
 *                      line as a dashed projection.
 *   AreaChart          one or more filled series, gradient fill.
 *   StackedAreaChart   cumulative composition over time.
 *   DonutChart         composition with a headline metric in the hole.
 *   PieChart           composition without one.
 *   WaterfallChart     budget / change-order / variance bridges with connectors.
 *   SCurveChart        planned vs actual vs forecast cumulative progress.
 *   GanttChart         real schedule: WBS tree, dependencies, critical path,
 *                      baseline bars, today marker, day→quarter zoom, pan.
 *   Sparkline          word-sized trend for table cells and KPI tiles.
 *   ProgressRing       ring gauge with an optional centre metric.
 *   Gauge              arc gauge with threshold bands and a target marker.
 *   HeatmapCalendar    day-grid intensity, GitHub-style.
 *   FunnelChart        stage-to-stage attrition with conversion rates.
 *
 * Plus the shared machinery: `ChartFrame`, `ChartLegend`, `ChartTooltipSurface`,
 * `ChartDataTable`, the palette (`CHART_SERIES_PALETTE`, `seriesColor`), and the
 * formatter set (`formatChartCurrency`, `makeValueFormatter`, …).
 *
 * ---------------------------------------------------------------------------
 * FIVE RULES THIS LAYER ENFORCES FOR YOU
 *
 * 1. NO FABRICATED DATA. A chart with no rows, no series, or nothing but nulls
 *    renders its empty state WITH THE REASON. It never draws a zero line,
 *    because a flat line at zero is a factual claim about the project.
 *    `null` and `0` are always drawn differently.
 *
 * 2. ONE PALETTE, COLOUR-BLIND SAFE. Series take `--ds-chart-*` slots in a
 *    fixed order chosen so adjacent series stay separable under protanopia and
 *    deuteranopia (worst adjacent pair ΔE 8.7 light / 8.9 dark, measured).
 *    Colour follows the entity, not its rank — hiding a series never repaints
 *    the survivors. Nothing cycles: an 8th series gets the reserved neutral
 *    slot, it does not reuse hue 1.
 *
 * 3. NEVER A SECOND Y-AXIS. Two measures of different scale go in two charts,
 *    or get indexed to a common base. There is no `rightAxis` prop and there
 *    will not be one.
 *
 * 4. IDENTITY IS NEVER COLOUR ALONE. Two or more series always get a legend;
 *    every chart offers a real `<table>` fallback under a disclosure; slices,
 *    stages and gauge bands carry text labels.
 *
 * 5. EVERYTHING IS A TOKEN. No hex values, in either theme. Charts re-theme
 *    live because they are painted in `var(--ds-*)`, and `color-mix()` derives
 *    the sequential and diverging ramps from the same tokens.
 *
 * ---------------------------------------------------------------------------
 * ACCESSIBILITY CONTRACT
 *
 *   · Pass `ariaLabel` to every chart (ChartCard's title is a good source).
 *   · The plot is wrapped in a labelled <figure>; the recharts root is an
 *     `application` with keyboard point navigation when a tooltip is on, and
 *     an `img` when it is not.
 *   · `dataTable` (default on) renders a real <table> in a <details>.
 *   · Legends are <button aria-pressed>; the Gantt WBS is a full ARIA tree
 *     with the standard arrow-key model; the heatmap is a grid with roving
 *     tabindex.
 *   · Every animation is suppressed under `prefers-reduced-motion`.
 *
 * ---------------------------------------------------------------------------
 * ONE NAME CLASH TO KNOW ABOUT
 *
 * `ProgressRing` also exists in ./primitives (a 40px inline indicator). This
 * module's version is a strict SUPERSET of that prop contract and renders
 * identically at default props, so either resolution is safe — but a barrel
 * that star-exports both must PIN one of them, or the name becomes ambiguous
 * and disappears. `ChartProgressRing` is the unambiguous alias for this one.
 * ------------------------------------------------------------------------- */

/* ===========================================================================
   Vocabulary
   =========================================================================== */

export type {
  CartesianChartProps,
  ChartAxisBound,
  ChartBand,
  ChartDatum,
  ChartFrameProps,
  ChartGlyph,
  ChartLegendPlacement,
  ChartReference,
  ChartSeries,
  ChartSeriesInput,
  ChartStateKind,
  ChartStateProps,
  ResolvedSeries,
} from "./charts/types";

export type { ChartOrientation } from "./charts/cartesian";

/* ===========================================================================
   Formatting
   =========================================================================== */

export {
  CHART_NO_VALUE,
  formatChartCompact,
  formatChartCurrency,
  formatChartCurrencyCompact,
  formatChartDate,
  formatChartDays,
  formatChartDelta,
  formatChartHours,
  formatChartNumber,
  formatChartPercent,
  formatChartPercent100,
  makeAxisFormatter,
  makeLabelFormatter,
  makeValueFormatter,
  toChartDate,
  toChartNumber,
} from "./charts/format";

export type {
  ChartFormatOptions,
  DateStyleName,
  LabelFormatter,
  NumberFormatName,
  ValueFormat,
  ValueFormatter,
} from "./charts/format";

/* ===========================================================================
   Palette
   =========================================================================== */

export {
  CHART_AXIS_COLOR,
  CHART_GRID_COLOR,
  CHART_NEUTRAL_COLOR,
  CHART_PALETTE_SIZE,
  CHART_PATTERN_ID_PREFIX,
  CHART_REFERENCE_COLOR,
  CHART_SERIES_PALETTE,
  CHART_SLOT_HUE,
  CHART_SLOT_ORDER,
  CHART_SURFACE_COLOR,
  CHART_TOKEN_NAMES,
  CHART_TRACK_COLOR,
  SEQUENTIAL_EMPTY,
  SEQUENTIAL_ZERO,
  divergingColor,
  divergingSteps,
  patternFill,
  resolveMarkColor,
  sequentialColor,
  sequentialSteps,
  seriesColor,
  toneColor,
  towardSurface,
  withAlpha,
} from "./charts/palette";

export type { ChartTokenName } from "./charts/palette";

/* ===========================================================================
   Shared machinery
   =========================================================================== */

export {
  CHART_AXIS_LINE,
  CHART_CURSOR_BAR,
  CHART_CURSOR_LINE,
  CHART_GRID_PROPS,
  CHART_MARGIN,
  CHART_TICK_STYLE,
  ChartDataTable,
  ChartEmpty,
  ChartError,
  ChartFrame,
  ChartLegend,
  ChartLoading,
  ChartPatternDefs,
  ChartTooltipRow,
  ChartTooltipSurface,
  DERIVED_KEY_SUFFIX,
  axisTitle,
  buildDataTable,
  deriveChartState,
  derivedKey,
  makeChartTooltip,
  normalizeSeries,
  resolveSeries,
  stripDerivedSuffix,
  useChartAnimation,
  useChartFormatters,
  useChartId,
  useChartSeries,
  useElementSize,
} from "./charts/primitives";

export type {
  ChartDataTableProps,
  ChartFrameOwnProps,
  ChartLegendProps,
  ChartTooltipConfig,
  DerivedChartState,
  UseChartSeriesResult,
} from "./charts/primitives";

/* ===========================================================================
   The panel
   =========================================================================== */

export { ChartCard, ChartStatCard } from "./charts/ChartCard";
export type { ChartCardProps, ChartStatCardProps } from "./charts/ChartCard";

/* ===========================================================================
   Charts
   =========================================================================== */

export { BAR_GHOST_FILL, BarChart, GroupedBarChart, StackedBarChart } from "./charts/bar";
export type { BarChartProps, GroupedBarChartProps, StackedBarChartProps } from "./charts/bar";

export { LineChart, hasSeriesData } from "./charts/line";
export type { ChartCurve, LineChartProps } from "./charts/line";

export { AreaChart, StackedAreaChart } from "./charts/area";
export type { AreaChartProps, StackedAreaChartProps } from "./charts/area";

export { DonutChart, PieChart } from "./charts/pie";
export type { ChartSlice, DonutChartProps, PieChartProps } from "./charts/pie";

export { WATERFALL_BAND_FILL, WaterfallChart } from "./charts/waterfall";
export type { WaterfallChartProps, WaterfallKind, WaterfallStep } from "./charts/waterfall";

export { SCurveChart } from "./charts/scurve";
export type { SCurveChartProps, SCurveKeys, SCurveLabels } from "./charts/scurve";

export { GANTT_ZOOMS, GanttChart } from "./charts/gantt";
export type {
  GanttChartProps,
  GanttLink,
  GanttLinkType,
  GanttTask,
  GanttZoom,
} from "./charts/gantt";

export { Sparkline } from "./charts/sparkline";
export type { SparklineProps } from "./charts/sparkline";

// `ProgressRing` is deliberately NOT re-exported here: apps/web/src/ui/primitives.tsx
// owns that name in the barrel (a compact inline indicator). The chart version is
// already surfaced as ChartProgressRing, which is the one to use for dashboards.
export { ChartProgressRing, Gauge, describeArc } from "./charts/radial";
export type {
  ChartProgressRingProps,
  GaugeProps,
  GaugeThreshold,
  // ProgressRingProps stays unexported here for the same reason as the value:
  // the primitive of that name owns it in the barrel.
  ProgressRingSegment,
  ProgressRingSize,
} from "./charts/radial";

export { HeatmapCalendar } from "./charts/heatmap";
export type { HeatmapCalendarProps, HeatmapDay } from "./charts/heatmap";

export { FunnelChart } from "./charts/funnel";
export type { FunnelChartProps, FunnelStage } from "./charts/funnel";
