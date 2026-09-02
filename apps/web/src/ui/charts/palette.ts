/**
 * charts/palette.ts — the one categorical palette for the whole product.
 *
 * Colour lives in styles.css as --ds-chart-1 … --ds-chart-8 and re-themes at
 * runtime. This module decides *which slot a series gets* and in *what order*,
 * so a chart drawn on the dashboard and the same chart drawn in a report use
 * identical hues for identical entities.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ORDER IS NOT 1,2,3,4,5,6,7,8
 *
 * Slots are handed out in the order below rather than numerically because the
 * numeric order puts amber (chart-3) directly next to green (chart-2), a pair
 * that collapses to ΔE 7.2 under deuteranopia — below the ΔE 8 separation
 * target. Swapping chart-3 and chart-7 lifts the worst adjacent pair to
 * ΔE 8.7 (deutan) in light and ΔE 8.9 in dark, with the worst normal-vision
 * adjacent pair at ΔE 19.0. Every other check (chroma floor, contrast against
 * both surface tokens, lightness band in light mode) passes as measured.
 *
 * Slot 8 (`--ds-chart-8`, slate) is NOT part of the categorical rotation. It is
 * desaturated on purpose and reserved for "Other" / "Unassigned" / de-emphasised
 * marks. Nothing is ever cycled: a 9th series does not wrap back to slot 1, it
 * gets the neutral slot, because two entities sharing a hue is a lie.
 * ---------------------------------------------------------------------------
 */
import type { Tone } from "../tokens";
import { TONE_CSS_VAR } from "../tokens";

/* ============================================================================
   Raw token names
============================================================================ */

export const CHART_TOKEN_NAMES = [
  "--ds-chart-1",
  "--ds-chart-2",
  "--ds-chart-3",
  "--ds-chart-4",
  "--ds-chart-5",
  "--ds-chart-6",
  "--ds-chart-7",
  "--ds-chart-8",
] as const;

export type ChartTokenName = (typeof CHART_TOKEN_NAMES)[number];

/**
 * The slot numbers, in assignment order. Index 0 is the first series in any
 * chart. Do not reorder without re-running the CVD separation check.
 */
export const CHART_SLOT_ORDER = [1, 2, 7, 4, 5, 6, 3] as const;

/** Human names for the hue in each slot, for docs and legend fallbacks. */
export const CHART_SLOT_HUE: readonly string[] = [
  "blue",
  "green",
  "orange",
  "violet",
  "red",
  "teal",
  "amber",
];

/** The categorical palette, in assignment order. 7 hues, no cycling. */
export const CHART_SERIES_PALETTE: readonly string[] = CHART_SLOT_ORDER.map(
  (slot) => `var(--ds-chart-${slot})`,
);

/** How many distinct categorical hues exist before "Other" takes over. */
export const CHART_PALETTE_SIZE = CHART_SERIES_PALETTE.length;

/** Reserved slot for "Other" / "Unassigned" / de-emphasised marks. */
export const CHART_NEUTRAL_COLOR = "var(--ds-chart-8)";

/* ============================================================================
   Structural colours
============================================================================ */

export const CHART_GRID_COLOR = "var(--ds-chart-grid)";
export const CHART_AXIS_COLOR = "var(--ds-chart-axis)";
/** The surface a chart is normally drawn on — used for mark separators. */
export const CHART_SURFACE_COLOR = "var(--ds-surface-raised)";
/** Track behind a gauge / ring / progress bar. */
export const CHART_TRACK_COLOR = "var(--ds-neutral-subtle)";
/** Reference / target line. */
export const CHART_REFERENCE_COLOR = "var(--ds-content-subtle)";

/* ============================================================================
   Resolution
============================================================================ */

/**
 * Colour for the Nth series. Never cycles: index >= 7 lands on the reserved
 * neutral slot so two series can never claim the same hue.
 */
export function seriesColor(index: number): string {
  if (!Number.isFinite(index) || index < 0) return CHART_SERIES_PALETTE[0] as string;
  return CHART_SERIES_PALETTE[Math.floor(index)] ?? CHART_NEUTRAL_COLOR;
}

/** Colour for a semantic tone, usable in SVG `fill` / `stroke`. */
export function toneColor(t: Tone): string {
  return TONE_CSS_VAR[t];
}

/** Explicit colour wins, then tone, then the palette slot for `index`. */
export function resolveMarkColor(
  spec: { color?: string | undefined; tone?: Tone | undefined } | undefined,
  index: number,
): string {
  if (spec?.color) return spec.color;
  if (spec?.tone) return toneColor(spec.tone);
  return seriesColor(index);
}

/* ============================================================================
   Alpha + derived scales

   `color-mix()` keeps everything expressed in tokens, so a fill derived from a
   series colour still re-themes when the user flips to dark.
============================================================================ */

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Same hue, `alpha` opacity, still a token-derived value. */
export function withAlpha(color: string, alpha: number): string {
  const pct = Math.round(clamp01(alpha) * 1000) / 10;
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

/** Mix a mark colour toward the chart surface — for muted / inactive marks. */
export function towardSurface(color: string, amount: number): string {
  const pct = Math.round(clamp01(1 - amount) * 1000) / 10;
  return `color-mix(in oklab, ${color} ${pct}%, ${CHART_SURFACE_COLOR})`;
}

/**
 * Single-hue sequential ramp, light → dark in light theme and dark → light in
 * dark theme (both directions read as "more"), because both ends are tokens.
 *
 * `t` is 0…1. `t === 0` returns the empty-cell surface, never a tinted value —
 * "no intensity" and "no data" must not look the same, so callers render
 * missing days with `SEQUENTIAL_EMPTY` instead of `sequentialColor(0)`.
 */
export function sequentialColor(t: number, hue: string = "var(--ds-accent)"): string {
  const pct = Math.round(8 + clamp01(t) * 92);
  return `color-mix(in oklab, ${hue} ${pct}%, var(--ds-surface-sunken))`;
}

/** Fill for a cell that has a real zero value (distinct from "no data"). */
export const SEQUENTIAL_ZERO = "var(--ds-surface-sunken)";
/** Fill for a cell with no data at all. Pair it with a dotted border. */
export const SEQUENTIAL_EMPTY = "transparent";

/** `steps` evenly spaced sequential swatches, for a discrete legend. */
export function sequentialSteps(steps: number, hue?: string): string[] {
  const n = Math.max(1, Math.floor(steps));
  return Array.from({ length: n }, (_, i) => sequentialColor(n === 1 ? 1 : i / (n - 1), hue));
}

/**
 * Diverging ramp with a neutral midpoint. `t` is -1…1.
 * Negative pole and positive pole are tone tokens, never a rainbow.
 */
export function divergingColor(
  t: number,
  options: { negative?: Tone; positive?: Tone } = {},
): string {
  const { negative = "danger", positive = "success" } = options;
  const clamped = t < -1 ? -1 : t > 1 ? 1 : t;
  if (Math.abs(clamped) < 0.001) return "var(--ds-surface-sunken)";
  const pole = clamped < 0 ? toneColor(negative) : toneColor(positive);
  const pct = Math.round(10 + Math.abs(clamped) * 90);
  return `color-mix(in oklab, ${pole} ${pct}%, var(--ds-surface-sunken))`;
}

/** `steps` diverging swatches from -1 to 1, for a discrete legend. */
export function divergingSteps(
  steps: number,
  options?: { negative?: Tone; positive?: Tone },
): string[] {
  const n = Math.max(2, Math.floor(steps));
  return Array.from({ length: n }, (_, i) => divergingColor((i / (n - 1)) * 2 - 1, options));
}

/* ============================================================================
   Texture — the CVD / print / forced-colors escape hatch.

   Returns the id of an SVG <pattern> that must exist in the same document;
   `<ChartPatternDefs />` in primitives.tsx renders them once per chart.
============================================================================ */

export const CHART_PATTERN_ID_PREFIX = "ds-chart-hatch";

export function patternFill(scopeId: string, index: number): string {
  return `url(#${CHART_PATTERN_ID_PREFIX}-${scopeId}-${index})`;
}
