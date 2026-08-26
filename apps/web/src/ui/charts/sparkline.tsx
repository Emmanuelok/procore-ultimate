/**
 * charts/sparkline.tsx — Sparkline.
 *
 * A word-sized chart for table cells and KPI tiles. Deliberately not recharts:
 * a dense grid can hold several hundred of these, and each one must cost a
 * handful of DOM nodes, not a chart runtime.
 *
 * With no readings it renders an em-dash carrying the reason, never a flat line
 * at zero.
 */
import { useMemo, type CSSProperties } from "react";

import { cx } from "../cx";
import type { Tone } from "../tokens";
import { deltaToTone } from "../tokens";
import { seriesColor, toneColor, withAlpha } from "./palette";
import {
  CHART_NO_VALUE,
  makeValueFormatter,
  toChartNumber,
  type ChartFormatOptions,
  type ValueFormat,
} from "./format";
import type { ChartDatum } from "./types";

export interface SparklineProps {
  /** Numbers, or rows plus `valueKey`. Nulls are gaps, not zeroes. */
  data: ReadonlyArray<number | null | undefined> | ReadonlyArray<ChartDatum>;
  valueKey?: string;
  width?: number;
  height?: number;
  variant?: "line" | "area" | "bar";
  tone?: Tone;
  color?: string;
  /** Colour by the first→last direction instead of a fixed tone. */
  colorByDelta?: boolean;
  /** For `colorByDelta`: is a rise good news? Default true. */
  higherIsBetter?: boolean;
  strokeWidth?: number;
  /** Mark the most recent point. Default true. */
  showEndDot?: boolean;
  /** Horizontal rule — target, budget, baseline. */
  baseline?: number;
  /** Print the latest value beside the plot. */
  showValue?: boolean;
  valueFormat?: ValueFormat;
  formatOptions?: ChartFormatOptions;
  /** Overrides the generated description. */
  ariaLabel?: string;
  /** Shown in place of the chart when there is nothing to draw. */
  emptyMessage?: string;
  className?: string;
  style?: CSSProperties;
}

interface Point {
  index: number;
  value: number | null;
  x: number;
  y: number;
}

export function Sparkline({
  data,
  valueKey = "value",
  width = 96,
  height = 24,
  variant = "line",
  tone,
  color,
  colorByDelta = false,
  higherIsBetter = true,
  strokeWidth = 1.5,
  showEndDot = true,
  baseline,
  showValue = false,
  valueFormat,
  formatOptions,
  ariaLabel,
  emptyMessage = "No readings for this period",
  className,
  style,
}: SparklineProps) {
  const values = useMemo<Array<number | null>>(() => {
    return (data as ReadonlyArray<unknown>).map((entry) => {
      if (entry === null || entry === undefined) return null;
      if (typeof entry === "number") return Number.isFinite(entry) ? entry : null;
      return toChartNumber((entry as ChartDatum)[valueKey]);
    });
  }, [data, valueKey]);

  const readings = useMemo(() => values.filter((value): value is number => value !== null), [values]);
  const formatter = useMemo(
    () => makeValueFormatter(valueFormat, formatOptions ?? {}),
    [valueFormat, formatOptions],
  );

  const first = readings[0];
  const last = readings[readings.length - 1];
  const delta = first !== undefined && last !== undefined ? last - first : 0;

  const resolvedColor =
    color ??
    (tone
      ? toneColor(tone)
      : colorByDelta
        ? toneColor(deltaToTone(delta, { higherIsBetter }))
        : seriesColor(0));

  const inset = Math.max(strokeWidth, showEndDot ? 2.5 : strokeWidth);
  const geometry = useMemo(() => {
    if (readings.length === 0) return null;
    let min = Math.min(...readings);
    let max = Math.max(...readings);
    if (baseline !== undefined) {
      min = Math.min(min, baseline);
      max = Math.max(max, baseline);
    }
    if (min === max) {
      min -= 0.5;
      max += 0.5;
    }
    const span = max - min;
    const usableW = Math.max(width - inset * 2, 1);
    const usableH = Math.max(height - inset * 2, 1);
    const step = values.length > 1 ? usableW / (values.length - 1) : 0;

    const points: Point[] = values.map((value, index) => ({
      index,
      value,
      x: inset + index * step,
      y: value === null ? Number.NaN : inset + usableH - ((value - min) / span) * usableH,
    }));

    const baselineY =
      baseline === undefined ? null : inset + usableH - ((baseline - min) / span) * usableH;

    return { points, min, max, baselineY, usableH, step };
  }, [values, readings, width, height, inset, baseline]);

  const description =
    ariaLabel ??
    (readings.length === 0
      ? emptyMessage
      : `Trend across ${readings.length} readings, from ${formatter(first as number)} to ${formatter(
          last as number,
        )}${delta === 0 ? ", unchanged" : delta > 0 ? ", up" : ", down"}.`);

  if (!geometry || readings.length === 0) {
    return (
      <span
        className={cx("inline-flex items-center text-meta text-content-subtle", className)}
        style={{ width, height, ...style }}
        role="img"
        aria-label={emptyMessage}
        title={emptyMessage}
      >
        {CHART_NO_VALUE}
      </span>
    );
  }

  const { points, baselineY } = geometry;

  /** Split at gaps so a missing reading breaks the line instead of bridging it. */
  const segments: Point[][] = [];
  let current: Point[] = [];
  for (const point of points) {
    if (point.value === null) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push(point);
    }
  }
  if (current.length > 0) segments.push(current);

  const lineFor = (segment: Point[]) =>
    segment.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");

  const areaFor = (segment: Point[]) => {
    const firstPoint = segment[0];
    const lastPoint = segment[segment.length - 1];
    if (!firstPoint || !lastPoint) return "";
    const floor = height - inset / 2;
    return `${lineFor(segment)} L${lastPoint.x.toFixed(2)} ${floor} L${firstPoint.x.toFixed(2)} ${floor} Z`;
  };

  const lastPoint = [...points].reverse().find((point) => point.value !== null);
  const barWidth = points.length > 0 ? Math.max((width - inset * 2) / points.length - 1, 1) : 1;

  return (
    <span
      className={cx("inline-flex items-center gap-1.5 align-middle", className)}
      style={style}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={description}
        className="overflow-visible drag-none"
        focusable="false"
      >
        {baselineY !== null ? (
          <line
            x1={0}
            y1={baselineY}
            x2={width}
            y2={baselineY}
            stroke="var(--ds-chart-axis)"
            strokeOpacity={0.5}
            strokeWidth={1}
            strokeDasharray="2 2"
          />
        ) : null}

        {variant === "bar"
          ? points.map((point) =>
              point.value === null ? null : (
                <rect
                  key={point.index}
                  x={point.x - barWidth / 2}
                  y={Math.min(point.y, height - inset)}
                  width={barWidth}
                  height={Math.max(height - inset - point.y, 1)}
                  rx={Math.min(1.5, barWidth / 2)}
                  fill={resolvedColor}
                  fillOpacity={0.85}
                />
              ),
            )
          : segments.map((segment, index) => (
              <g key={index}>
                {variant === "area" && segment.length > 1 ? (
                  <path d={areaFor(segment)} fill={withAlpha(resolvedColor, 0.16)} />
                ) : null}
                {segment.length === 1 ? (
                  <circle cx={segment[0]?.x} cy={segment[0]?.y} r={strokeWidth} fill={resolvedColor} />
                ) : (
                  <path
                    d={lineFor(segment)}
                    fill="none"
                    stroke={resolvedColor}
                    strokeWidth={strokeWidth}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
              </g>
            ))}

        {showEndDot && lastPoint && variant !== "bar" ? (
          <circle
            cx={lastPoint.x}
            cy={lastPoint.y}
            r={strokeWidth + 0.75}
            fill={resolvedColor}
            stroke="var(--ds-surface-raised)"
            strokeWidth={1}
          />
        ) : null}
      </svg>
      {showValue && last !== undefined ? (
        <span className="text-meta tabular-nums text-content">{formatter(last)}</span>
      ) : null}
    </span>
  );
}
