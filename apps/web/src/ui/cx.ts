/**
 * cx — the single class-name joiner for the whole app.
 *
 * clsx handles conditional/array/object syntax; tailwind-merge resolves
 * conflicting Tailwind utilities so a caller's `className` always wins over a
 * component's defaults:
 *
 *   cx("px-3 py-2 bg-surface-raised", props.className)
 *   // caller passing "bg-accent" ⇒ "px-3 py-2 bg-accent"
 *
 * The merge config is extended with this design system's custom namespaces
 * (surface/content/accent/status colours, density spacing, elevation shadows,
 * the extra type steps) so those conflict-resolve correctly too.
 */
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

export type { ClassValue };

/* ------------------------------------------------------------------------- */
/* Custom scale members that tailwind-merge cannot infer from the stock config */
/* ------------------------------------------------------------------------- */

const STATUS_FAMILIES = [
  "neutral",
  "success",
  "warning",
  "danger",
  "info",
  "highlight",
] as const;

const STATUS_STEPS = ["subtle", "solid", "fg", "border", "on-solid"] as const;

const SEMANTIC_COLORS: string[] = [
  "surface",
  "surface-raised",
  "surface-sunken",
  "surface-overlay",
  "surface-hover",
  "surface-active",
  "surface-selected",
  "surface-inverse",
  "surface-inverse-fg",
  "scrim",
  "border",
  "border-subtle",
  "border-strong",
  "border-inverse",
  "content",
  "content-muted",
  "content-subtle",
  "content-disabled",
  "content-inverse",
  "content-on-solid",
  "accent",
  "accent-hover",
  "accent-active",
  "accent-fg",
  "accent-subtle",
  "accent-subtle-hover",
  "accent-subtle-fg",
  "accent-border",
  "accent-text",
  "ring",
  "ring-offset",
  "skeleton",
  "code-bg",
  "grid-line",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "chart-6",
  "chart-7",
  "chart-8",
  "chart-grid",
  "chart-axis",
  ...STATUS_FAMILIES.flatMap((family) =>
    STATUS_STEPS.map((step) => `${family}-${step}`),
  ),
];

const SEMANTIC_SPACING: string[] = [
  "control",
  "control-sm",
  "control-xs",
  "control-lg",
  "control-px",
  "control-px-sm",
  "control-gap",
  "row",
  "row-sm",
  "cell-x",
  "cell-y",
  "card",
  "page-x",
  "page-y",
  "section",
  "stack",
  "inline",
  "sidebar",
  "sidebar-collapsed",
  "rail",
  "topbar",
  "subbar",
  "drawer",
  "drawer-wide",
  "inspector",
  "content-max",
  "prose",
];

const SEMANTIC_TEXT: string[] = [
  "2xs",
  "body",
  "meta",
  "label",
  "code",
  "display-xs",
  "display-sm",
  "display-md",
  "display-lg",
];

const SEMANTIC_SHADOW: string[] = ["e0", "e1", "e2", "e3", "e4", "e5"];

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "bg-color": [{ bg: SEMANTIC_COLORS }],
      "text-color": [{ text: SEMANTIC_COLORS }],
      "border-color": [{ border: SEMANTIC_COLORS }],
      "ring-color": [{ ring: SEMANTIC_COLORS }],
      "outline-color": [{ outline: SEMANTIC_COLORS }],
      "divide-color": [{ divide: SEMANTIC_COLORS }],
      "shadow-color": [{ shadow: SEMANTIC_COLORS }],
      "caret-color": [{ caret: SEMANTIC_COLORS }],
      "accent": [{ accent: SEMANTIC_COLORS }],
      fill: [{ fill: SEMANTIC_COLORS }],
      "stroke": [{ stroke: SEMANTIC_COLORS }],
      "gradient-from": [{ from: SEMANTIC_COLORS }],
      "gradient-via": [{ via: SEMANTIC_COLORS }],
      "gradient-to": [{ to: SEMANTIC_COLORS }],

      p: [{ p: SEMANTIC_SPACING }],
      px: [{ px: SEMANTIC_SPACING }],
      py: [{ py: SEMANTIC_SPACING }],
      pt: [{ pt: SEMANTIC_SPACING }],
      pr: [{ pr: SEMANTIC_SPACING }],
      pb: [{ pb: SEMANTIC_SPACING }],
      pl: [{ pl: SEMANTIC_SPACING }],
      m: [{ m: SEMANTIC_SPACING }],
      mx: [{ mx: SEMANTIC_SPACING }],
      my: [{ my: SEMANTIC_SPACING }],
      gap: [{ gap: SEMANTIC_SPACING }],
      "gap-x": [{ "gap-x": SEMANTIC_SPACING }],
      "gap-y": [{ "gap-y": SEMANTIC_SPACING }],
      w: [{ w: SEMANTIC_SPACING }],
      h: [{ h: SEMANTIC_SPACING }],
      "min-w": [{ "min-w": SEMANTIC_SPACING }],
      "min-h": [{ "min-h": SEMANTIC_SPACING }],
      "max-w": [{ "max-w": SEMANTIC_SPACING }],
      "max-h": [{ "max-h": SEMANTIC_SPACING }],
      size: [{ size: SEMANTIC_SPACING }],

      "font-size": [{ text: SEMANTIC_TEXT }],
      "shadow": [{ shadow: SEMANTIC_SHADOW }],
    },
  },
});

/**
 * Join class names, resolving Tailwind conflicts last-wins.
 * Accepts strings, arrays, objects, and falsy values.
 */
export function cx(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Escape hatch: join without conflict resolution (marginally faster). */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

export default cx;
