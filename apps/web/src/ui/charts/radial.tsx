/**
 * charts/radial.tsx — ProgressRing and Gauge.
 *
 * Two single-number displays. Both are hand-drawn SVG rather than a radial bar
 * chart because at this size the geometry has to be exact: a KPI ring that is
 * two pixels off centre reads as sloppy across an entire dashboard.
 *
 * NOTE ON `ProgressRing`: src/ui/primitives.tsx already exports a small inline
 * ring with the props { value, max, size, thickness, tone, showValue, label }.
 * This implementation is a strict SUPERSET of that contract — same defaults,
 * same rendering at default props — so whichever one a barrel resolves to,
 * existing call sites keep working. `ChartProgressRing` is the unambiguous
 * alias for this one.
 */
import { useId, useMemo, type HTMLAttributes, type ReactNode } from "react";

import { cx } from "../cx";
import type { Tone } from "../tokens";
import { useReducedMotion } from "../motion";
import { CHART_TRACK_COLOR, toneColor } from "./palette";
import {
  CHART_NO_VALUE,
  makeValueFormatter,
  type ChartFormatOptions,
  type ValueFormat,
} from "./format";

/* ============================================================================
   Geometry helpers
============================================================================ */

const TAU = Math.PI * 2;

function polar(cx0: number, cy0: number, radius: number, degrees: number) {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return { x: cx0 + radius * Math.cos(radians), y: cy0 + radius * Math.sin(radians) };
}

/** SVG path for an arc from `startAngle` to `endAngle`, degrees, clockwise. */
export function describeArc(
  cx0: number,
  cy0: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): string {
  const sweep = endAngle - startAngle;
  if (Math.abs(sweep) < 0.01) return "";
  const clamped = Math.max(-359.99, Math.min(359.99, sweep));
  const start = polar(cx0, cy0, radius, startAngle);
  const end = polar(cx0, cy0, radius, startAngle + clamped);
  const largeArc = Math.abs(clamped) > 180 ? 1 : 0;
  const direction = clamped >= 0 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} ${direction} ${end.x} ${end.y}`;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/* ============================================================================
   ProgressRing
============================================================================ */

export type ProgressRingSize = number | "sm" | "md" | "lg" | "xl";

const RING_SIZE: Record<Exclude<ProgressRingSize, number>, number> = {
  sm: 28,
  md: 40,
  lg: 72,
  xl: 112,
};

export interface ProgressRingSegment {
  value: number;
  tone?: Tone;
  color?: string;
  label?: string;
}

export interface ProgressRingProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Current value. Pass null/undefined to render the "no reading" state. */
  value?: number | null;
  max?: number;
  min?: number;
  /** Outer diameter in px, or a named step. Default 40. */
  size?: ProgressRingSize;
  /** Stroke width in px. Default 4, or 8 at size "lg"/"xl". */
  thickness?: number;
  tone?: Tone;
  /** Print the percentage in the middle. */
  showValue?: boolean;
  /** Content for the middle (overrides `showValue`). */
  label?: ReactNode;
  /** Muted line under the middle content. */
  caption?: ReactNode;
  /** Format the centre value as something other than a percentage. */
  valueFormat?: ValueFormat;
  formatOptions?: ChartFormatOptions;
  /** Multi-part ring — committed / spent / remaining. Overrides `value`. */
  segments?: ReadonlyArray<ProgressRingSegment>;
  /** Accessible name. Falls back to "N percent". */
  ariaLabel?: string;
  /** Shown when there is no value. */
  emptyMessage?: string;
  animate?: boolean;
}

export function ProgressRing({
  value = 0,
  max = 100,
  min = 0,
  size = 40,
  thickness,
  tone: ringTone = "accent",
  showValue = false,
  label,
  caption,
  valueFormat,
  formatOptions,
  segments,
  ariaLabel,
  emptyMessage = "No value reported",
  animate,
  className,
  ...rest
}: ProgressRingProps) {
  const reduced = useReducedMotion();
  const animated = animate !== false && !reduced;
  const diameter = typeof size === "number" ? size : RING_SIZE[size];
  const stroke = thickness ?? (diameter >= 72 ? 8 : 4);
  const safeMax = max === min ? min + 100 : max;
  const radius = (diameter - stroke) / 2;
  const circumference = TAU * radius;

  const hasValue = value !== null && value !== undefined && Number.isFinite(value);
  const ratio = hasValue ? clamp01(((value as number) - min) / (safeMax - min)) : 0;
  const pct = ratio * 100;

  const formatter = useMemo(
    () => (valueFormat ? makeValueFormatter(valueFormat, formatOptions ?? {}) : null),
    [valueFormat, formatOptions],
  );

  const centre = label ?? (
    showValue ? (
      <span
        className={cx(
          "font-semibold tabular-nums text-content",
          diameter >= 96 ? "text-display-xs" : diameter >= 64 ? "text-lg" : "text-2xs",
        )}
      >
        {hasValue
          ? formatter
            ? formatter(value as number)
            : `${Math.round(pct)}%`
          : CHART_NO_VALUE}
      </span>
    ) : null
  );

  const resolvedSegments = useMemo(() => {
    if (!segments || segments.length === 0) return null;
    let offset = 0;
    return segments.map((segment, index) => {
      const fraction = clamp01((segment.value - min) / (safeMax - min));
      const entry = {
        key: index,
        color: segment.color ?? toneColor(segment.tone ?? "accent"),
        dash: fraction * circumference,
        offset: offset * circumference,
        label: segment.label,
      };
      offset += fraction;
      return entry;
    });
  }, [segments, min, safeMax, circumference]);

  const accessibleName =
    ariaLabel ?? (hasValue ? `${Math.round(pct)} percent` : emptyMessage);

  return (
    <div
      className={cx("relative inline-grid shrink-0 place-items-center", className)}
      style={{ width: diameter, height: diameter }}
      role="progressbar"
      aria-valuemin={min}
      aria-valuemax={safeMax}
      {...(hasValue ? { "aria-valuenow": value as number } : {})}
      aria-label={accessibleName}
      title={hasValue ? undefined : emptyMessage}
      {...rest}
    >
      <svg
        width={diameter}
        height={diameter}
        viewBox={`0 0 ${diameter} ${diameter}`}
        className="-rotate-90"
        aria-hidden="true"
        focusable="false"
      >
        <circle
          cx={diameter / 2}
          cy={diameter / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          stroke={CHART_TRACK_COLOR}
          {...(hasValue ? {} : { strokeDasharray: "3 4" })}
        />
        {resolvedSegments
          ? resolvedSegments.map((segment) => (
              <circle
                key={segment.key}
                cx={diameter / 2}
                cy={diameter / 2}
                r={radius}
                fill="none"
                strokeWidth={stroke}
                stroke={segment.color}
                strokeLinecap="butt"
                strokeDasharray={`${Math.max(segment.dash - 2, 0)} ${circumference}`}
                strokeDashoffset={-segment.offset}
              />
            ))
          : hasValue && ratio > 0 ? (
              <circle
                cx={diameter / 2}
                cy={diameter / 2}
                r={radius}
                fill="none"
                strokeWidth={stroke}
                stroke={ringTone === "accent" ? "var(--ds-accent)" : toneColor(ringTone)}
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - ratio)}
                className={animated ? "transition-[stroke-dashoffset] duration-slow ease-emphasized" : undefined}
              />
            ) : null}
      </svg>
      {centre || caption ? (
        <span className="absolute inset-0 grid place-items-center">
          <span className="flex flex-col items-center leading-tight">
            {centre}
            {caption ? (
              <span className="mt-0.5 text-meta text-content-muted">{caption}</span>
            ) : null}
          </span>
        </span>
      ) : null}
    </div>
  );
}

/** Unambiguous alias — use this when both ring implementations are in scope. */
export const ChartProgressRing = ProgressRing;
export type ChartProgressRingProps = ProgressRingProps;

/* ============================================================================
   Gauge
============================================================================ */

export interface GaugeThreshold {
  /** Lower bound of this band, in value units. */
  from: number;
  tone: Tone;
  label?: string;
}

export interface GaugeProps {
  /** null/undefined renders the "no reading" state, never a zero needle. */
  value: number | null | undefined;
  min?: number;
  max?: number;
  /** A marker on the arc — target, budget, contractual threshold. */
  target?: number;
  targetLabel?: string;
  /** Coloured zones drawn as a thin ring outside the arc. */
  thresholds?: ReadonlyArray<GaugeThreshold>;
  /** Colour of the value arc when no threshold matches. */
  tone?: Tone;
  /** Overall width in px. Default 168. */
  size?: number;
  /** Arc thickness in px. Default 12. */
  thickness?: number;
  /** Sweep, in degrees. Default 240 (a wide open gauge). */
  sweep?: number;
  label?: ReactNode;
  caption?: ReactNode;
  /** Print min and max at the arc ends. Default true. */
  showRange?: boolean;
  valueFormat?: ValueFormat;
  formatOptions?: ChartFormatOptions;
  ariaLabel?: string;
  emptyMessage?: string;
  animate?: boolean;
  className?: string;
}

export function Gauge({
  value,
  min = 0,
  max = 100,
  target,
  targetLabel = "Target",
  thresholds,
  tone = "accent",
  size = 168,
  thickness = 12,
  sweep = 240,
  label,
  caption,
  showRange = true,
  valueFormat,
  formatOptions,
  ariaLabel,
  emptyMessage = "No reading available",
  animate,
  className,
}: GaugeProps) {
  const reduced = useReducedMotion();
  const animated = animate !== false && !reduced;
  const titleId = useId();

  const safeMax = max === min ? min + 100 : max;
  const hasValue = value !== null && value !== undefined && Number.isFinite(value);
  const ratio = hasValue ? clamp01(((value as number) - min) / (safeMax - min)) : 0;

  const formatter = useMemo(
    () => makeValueFormatter(valueFormat ?? "number", formatOptions ?? {}),
    [valueFormat, formatOptions],
  );

  const width = size;
  const startAngle = -sweep / 2;
  const endAngle = sweep / 2;
  const radius = (width - thickness * 2) / 2;
  const cx0 = width / 2;
  // Only the drawn part of the circle needs vertical room.
  const lowestPoint = polar(0, 0, radius, endAngle).y;
  const cy0 = thickness + radius;
  const height = Math.ceil(cy0 + Math.max(lowestPoint, 0) + thickness + 2);

  const angleFor = (fraction: number) => startAngle + clamp01(fraction) * sweep;

  const activeTone = useMemo<Tone>(() => {
    if (!thresholds || thresholds.length === 0 || !hasValue) return tone;
    const sorted = [...thresholds].sort((a, b) => a.from - b.from);
    let current: Tone = tone;
    for (const band of sorted) {
      if ((value as number) >= band.from) current = band.tone;
    }
    return current;
  }, [thresholds, hasValue, value, tone]);

  const bandRadius = radius + thickness / 2 + 4;

  const accessibleName =
    ariaLabel ?? (hasValue ? `${formatter(value as number)}` : emptyMessage);

  return (
    <div className={cx("inline-flex flex-col items-center", className)}>
      <div
        role="meter"
        aria-valuemin={min}
        aria-valuemax={safeMax}
        {...(hasValue ? { "aria-valuenow": value as number, "aria-valuetext": formatter(value as number) } : {})}
        aria-labelledby={titleId}
        className="relative"
        style={{ width, height }}
      >
        <span id={titleId} className="sr-only">
          {accessibleName}
        </span>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
          <path
            d={describeArc(cx0, cy0, radius, startAngle, endAngle)}
            fill="none"
            stroke={CHART_TRACK_COLOR}
            strokeWidth={thickness}
            strokeLinecap="round"
            {...(hasValue ? {} : { strokeDasharray: "4 6" })}
          />

          {thresholds?.map((band, index) => {
            const next = thresholds[index + 1];
            const from = angleFor((band.from - min) / (safeMax - min));
            const to = next
              ? angleFor((next.from - min) / (safeMax - min)) - 1.5
              : endAngle;
            if (to <= from) return null;
            return (
              <path
                key={index}
                d={describeArc(cx0, cy0, bandRadius, from, to)}
                fill="none"
                stroke={toneColor(band.tone)}
                strokeOpacity={0.5}
                strokeWidth={3}
                strokeLinecap="round"
              >
                {band.label ? <title>{band.label}</title> : null}
              </path>
            );
          })}

          {hasValue && ratio > 0 ? (
            <path
              d={describeArc(cx0, cy0, radius, startAngle, angleFor(ratio))}
              fill="none"
              stroke={tone === "accent" && activeTone === "accent" ? "var(--ds-accent)" : toneColor(activeTone)}
              strokeWidth={thickness}
              strokeLinecap="round"
              className={animated ? "transition-[d] duration-slow ease-emphasized" : undefined}
            />
          ) : null}

          {target !== undefined && Number.isFinite(target) ? (
            (() => {
              const angle = angleFor((target - min) / (safeMax - min));
              const inner = polar(cx0, cy0, radius - thickness / 2 - 1, angle);
              const outer = polar(cx0, cy0, radius + thickness / 2 + 1, angle);
              return (
                <line
                  x1={inner.x}
                  y1={inner.y}
                  x2={outer.x}
                  y2={outer.y}
                  stroke="var(--ds-content)"
                  strokeWidth={2}
                  strokeLinecap="round"
                >
                  <title>{`${targetLabel}: ${formatter(target)}`}</title>
                </line>
              );
            })()
          ) : null}
        </svg>

        <div className="pointer-events-none absolute inset-x-0" style={{ top: cy0 - radius / 2.1 }}>
          <div className="flex flex-col items-center text-center">
            <span
              className={cx(
                "font-semibold tabular-nums text-content",
                width >= 200 ? "text-display-sm" : width >= 140 ? "text-display-xs" : "text-lg",
              )}
            >
              {hasValue ? formatter(value as number) : CHART_NO_VALUE}
            </span>
            {label ? <span className="text-meta text-content-muted">{label}</span> : null}
          </div>
        </div>
      </div>

      {showRange ? (
        <div
          className="-mt-2 flex w-full justify-between px-1 text-meta tabular-nums text-content-subtle"
          style={{ maxWidth: width }}
          aria-hidden="true"
        >
          <span>{formatter(min)}</span>
          <span>{formatter(safeMax)}</span>
        </div>
      ) : null}

      {!hasValue ? (
        <p className="mt-1 max-w-[16rem] text-center text-meta text-content-muted">{emptyMessage}</p>
      ) : caption ? (
        <p className="mt-1 max-w-[16rem] text-center text-meta text-content-muted">{caption}</p>
      ) : null}
    </div>
  );
}
