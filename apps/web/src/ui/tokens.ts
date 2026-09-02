/**
 * tokens.ts — the single semantic vocabulary for ConstructOS.
 *
 * Colour lives in CSS (see styles.css). This module is the *typed index* into
 * it: every component that has to pick a colour for a status, severity, stage,
 * priority or delta resolves it here, so an "at risk" RFI, an "amber" schedule
 * health and a "medium" risk all look the same everywhere in the product.
 *
 * Nothing in this file emits a hex value. It emits class names built from the
 * semantic Tailwind namespaces, and `var(--ds-*)` strings for the few places
 * (SVG charts, canvas, three.js) that need a real colour at runtime.
 */

/* ============================================================================
   Tones
============================================================================ */

export const TONES = [
  "neutral",
  "accent",
  "info",
  "success",
  "warning",
  "danger",
  "highlight",
] as const;

export type Tone = (typeof TONES)[number];

export const TONE_LABEL: Record<Tone, string> = {
  neutral: "Neutral",
  accent: "Primary",
  info: "Info",
  success: "Success",
  warning: "Warning",
  danger: "Critical",
  highlight: "Highlight",
};

/** The class recipes a tone can be rendered with. */
export interface ToneStyle {
  /** Tinted fill + readable foreground. Badges, chips, callouts, cells. */
  subtle: string;
  /** Full-strength fill. Primary buttons, solid pills, KPI accents. */
  solid: string;
  /** Transparent with a tinted 1px edge. Secondary chips, filter tokens. */
  outline: string;
  /** Foreground colour only. */
  text: string;
  /** Background fill only (no foreground). */
  bg: string;
  /** Border colour only (pair with `border`/`border-l-2`…). */
  border: string;
  /** 6px status dot / legend swatch. */
  dot: string;
  /** Focus/selection ring colour. */
  ring: string;
  /** Left rail used by banners and timeline entries. */
  bar: string;
  /** Background for hover states of subtle surfaces. */
  subtleHover: string;
}

function makeTone(family: string): ToneStyle {
  return {
    subtle: `bg-${family}-subtle text-${family}-fg`,
    solid: `bg-${family}-solid text-${family}-on-solid`,
    outline: `border border-${family}-border text-${family}-fg bg-transparent`,
    text: `text-${family}-fg`,
    bg: `bg-${family}-subtle`,
    border: `border-${family}-border`,
    dot: `bg-${family}-solid`,
    ring: `ring-${family}-border`,
    bar: `border-l-2 border-${family}-solid`,
    subtleHover: `hover:bg-${family}-subtle`,
  };
}

/**
 * `tone.success.subtle` → "bg-success-subtle text-success-fg"
 *
 * The accent family is spelled differently in CSS (accent-subtle-fg rather
 * than accent-fg, because accent-fg means "on accent"), so it is written out.
 */
export const tone: Record<Tone, ToneStyle> = {
  neutral: makeTone("neutral"),
  info: makeTone("info"),
  success: makeTone("success"),
  warning: makeTone("warning"),
  danger: makeTone("danger"),
  highlight: makeTone("highlight"),
  accent: {
    subtle: "bg-accent-subtle text-accent-subtle-fg",
    solid: "bg-accent text-accent-fg",
    outline: "border border-accent-border text-accent-text bg-transparent",
    text: "text-accent-text",
    bg: "bg-accent-subtle",
    border: "border-accent-border",
    dot: "bg-accent",
    ring: "ring-accent-border",
    bar: "border-l-2 border-accent",
    subtleHover: "hover:bg-accent-subtle-hover",
  },
};

/** Convenience: `toneClass("danger", "subtle")`. */
export function toneClass(t: Tone, variant: keyof ToneStyle = "subtle"): string {
  return tone[t][variant];
}

/* ============================================================================
   Legacy bridge — the pre-existing Badge tone names in src/ui/index.tsx.
   Keeps ~250 existing `tone="amber"` call sites meaningful while new code
   moves to semantic tones.
============================================================================ */

export type LegacyBadgeTone =
  | "gray"
  | "blue"
  | "green"
  | "amber"
  | "red"
  | "violet"
  /* aliases seen in the existing pages */
  | "ink"
  | "brand"
  | "warn"
  | "critical"
  | "emphasis";

export const LEGACY_TO_TONE: Record<LegacyBadgeTone, Tone> = {
  gray: "neutral",
  ink: "neutral",
  blue: "info",
  brand: "accent",
  emphasis: "accent",
  green: "success",
  amber: "warning",
  warn: "warning",
  red: "danger",
  critical: "danger",
  violet: "highlight",
};

export const TONE_TO_LEGACY: Record<Tone, LegacyBadgeTone> = {
  neutral: "gray",
  accent: "blue",
  info: "blue",
  success: "green",
  warning: "amber",
  danger: "red",
  highlight: "violet",
};

export function fromLegacyBadgeTone(value: string | null | undefined): Tone {
  if (!value) return "neutral";
  return LEGACY_TO_TONE[value as LegacyBadgeTone] ?? "neutral";
}

export function toLegacyBadgeTone(t: Tone): LegacyBadgeTone {
  return TONE_TO_LEGACY[t];
}

/* ============================================================================
   Status vocabulary
   Every lifecycle string the API emits, mapped once.
============================================================================ */

/** snake_case / kebab-case / "In Review" → "in_review" */
export function normalizeKey(value: string | null | undefined): string {
  if (!value) return "";
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export const STATUS_TONE: Record<string, Tone> = {
  /* --- neutral / dormant --------------------------------------------- */
  draft: "neutral",
  new: "neutral",
  not_started: "neutral",
  planned: "neutral",
  scheduled: "neutral",
  inactive: "neutral",
  archived: "neutral",
  superseded: "neutral",
  void: "neutral",
  voided: "neutral",
  withdrawn: "neutral",
  cancelled: "neutral",
  canceled: "neutral",
  closed: "neutral",
  unknown: "neutral",
  na: "neutral",
  none: "neutral",
  skipped: "neutral",
  deferred: "neutral",

  /* --- in flight ------------------------------------------------------ */
  open: "info",
  active: "info",
  in_progress: "info",
  in_review: "info",
  under_review: "info",
  review: "info",
  submitted: "info",
  pending: "info",
  pending_review: "info",
  pending_approval: "info",
  awaiting_response: "info",
  queued: "info",
  running: "info",
  processing: "info",
  syncing: "info",
  issued: "info",
  sent: "info",
  received: "info",
  assigned: "info",
  reopened: "info",
  scheduled_run: "info",

  /* --- good ends ------------------------------------------------------ */
  approved: "success",
  accepted: "success",
  answered: "success",
  resolved: "success",
  complete: "success",
  completed: "success",
  done: "success",
  ready: "success",
  operational: "success",
  healthy: "success",
  passed: "success",
  pass: "success",
  verified: "success",
  signed: "success",
  executed: "success",
  paid: "success",
  settled: "success",
  released: "success",
  supported: "success",
  compliant: "success",
  connected: "success",
  succeeded: "success",
  success: "success",
  published: "success",
  current: "success",
  no_exception: "success",
  approved_as_noted: "success",

  /* --- needs attention ------------------------------------------------ */
  at_risk: "warning",
  warning: "warning",
  degraded: "warning",
  revise_and_resubmit: "warning",
  revise: "warning",
  partially_supported: "warning",
  partial: "warning",
  partially_paid: "warning",
  on_hold: "warning",
  blocked: "warning",
  waiting: "warning",
  unverified: "warning",
  needs_review: "warning",
  due_soon: "warning",
  expiring: "warning",
  expiring_soon: "warning",
  amber: "warning",
  stale: "warning",
  suspended: "warning",
  disputed: "warning",
  escalated: "warning",
  flagged: "warning",
  action_required: "warning",

  /* --- bad ends -------------------------------------------------------- */
  rejected: "danger",
  overdue: "danger",
  late: "danger",
  breached: "danger",
  contradicted: "danger",
  failed: "danger",
  failure: "danger",
  error: "danger",
  critical: "danger",
  expired: "danger",
  terminated: "danger",
  defaulted: "danger",
  non_compliant: "danger",
  noncompliant: "danger",
  unpaid: "danger",
  delinquent: "danger",
  disconnected: "danger",
  offline: "danger",
  rejected_resubmit: "danger",
  claim: "danger",

  /* --- special / AI ---------------------------------------------------- */
  ai_generated: "highlight",
  ai_suggested: "highlight",
  predicted: "highlight",
  simulated: "highlight",
  forecast: "highlight",
  draft_ai: "highlight",
  insight: "highlight",
};

/**
 * Resolve any lifecycle string to a tone. Unknown values fall back to a
 * conservative substring heuristic and finally to `neutral`.
 */
export function statusToTone(status: string | null | undefined): Tone {
  const key = normalizeKey(status);
  if (!key) return "neutral";
  const direct = STATUS_TONE[key];
  if (direct) return direct;

  if (/(reject|fail|overdue|breach|expired|error|critical|termina|default)/.test(key))
    return "danger";
  if (/(risk|hold|block|warn|pending_.*fix|revise|partial|dispute|escalat|stale)/.test(key))
    return "warning";
  if (/(approv|complet|resolv|success|pass|verif|paid|ready|done|healthy)/.test(key))
    return "success";
  if (/(open|active|progress|review|submit|pending|queue|running|sent)/.test(key))
    return "info";
  if (/(draft|archiv|void|cancel|closed|inactive|superseded)/.test(key)) return "neutral";
  return "neutral";
}

/** Tone → the legacy Badge tone string, for components still on the old API. */
export function statusToLegacyTone(status: string | null | undefined): LegacyBadgeTone {
  return toLegacyBadgeTone(statusToTone(status));
}

/** "revise_and_resubmit" → "Revise and Resubmit" */
export function formatStatusLabel(status: string | null | undefined): string {
  const key = normalizeKey(status);
  if (!key) return "—";
  const smallWords = new Set(["and", "or", "of", "to", "as", "in", "on", "for", "the", "a", "an"]);
  return key
    .split("_")
    .filter(Boolean)
    .map((word, index) => {
      if (word === "ai" || word === "rfi" || word === "co" || word === "po") return word.toUpperCase();
      if (index > 0 && smallWords.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/* ============================================================================
   Severity  (risk registers, QA findings, safety observations, alerts)
============================================================================ */

export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_TONE: Record<Severity, Tone> = {
  info: "info",
  low: "neutral",
  medium: "warning",
  high: "danger",
  critical: "danger",
};

export const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  info: "Info",
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export function asSeverity(value: string | null | undefined): Severity {
  const key = normalizeKey(value);
  if (key === "informational" || key === "note") return "info";
  if (key === "moderate") return "medium";
  if (key === "severe" || key === "major" || key === "urgent") return "high";
  if (key === "catastrophic" || key === "blocker" || key === "p0") return "critical";
  if (key === "minor" || key === "trivial") return "low";
  return (SEVERITIES as readonly string[]).includes(key) ? (key as Severity) : "medium";
}

export function severityToTone(value: string | null | undefined): Tone {
  return SEVERITY_TONE[asSeverity(value)];
}

/* ============================================================================
   Stage  (workflow columns, kanban lanes, pipeline steps)
============================================================================ */

export const STAGES = [
  "draft",
  "queued",
  "active",
  "review",
  "blocked",
  "done",
  "cancelled",
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_TONE: Record<Stage, Tone> = {
  draft: "neutral",
  queued: "neutral",
  active: "info",
  review: "highlight",
  blocked: "warning",
  done: "success",
  cancelled: "neutral",
};

export const STAGE_LABEL: Record<Stage, string> = {
  draft: "Draft",
  queued: "Queued",
  active: "In Progress",
  review: "In Review",
  blocked: "Blocked",
  done: "Complete",
  cancelled: "Cancelled",
};

export const STAGE_ORDER: readonly Stage[] = STAGES;

export function asStage(value: string | null | undefined): Stage {
  const key = normalizeKey(value);
  if ((STAGES as readonly string[]).includes(key)) return key as Stage;
  if (/(in_progress|open|running|active|started)/.test(key)) return "active";
  if (/(review|submitted|pending)/.test(key)) return "review";
  if (/(block|hold|risk|waiting)/.test(key)) return "blocked";
  if (/(done|complete|closed|approved|resolved)/.test(key)) return "done";
  if (/(cancel|void|archiv|reject)/.test(key)) return "cancelled";
  if (/(queue|planned|scheduled|backlog)/.test(key)) return "queued";
  return "draft";
}

export function stageToTone(value: string | null | undefined): Tone {
  return STAGE_TONE[asStage(value)];
}

/* ============================================================================
   Priority
============================================================================ */

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_TONE: Record<Priority, Tone> = {
  low: "neutral",
  normal: "info",
  high: "warning",
  urgent: "danger",
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export const PRIORITY_RANK: Record<Priority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

export function asPriority(value: string | null | undefined): Priority {
  const key = normalizeKey(value);
  if ((PRIORITIES as readonly string[]).includes(key)) return key as Priority;
  if (/(critical|blocker|p0|emergency)/.test(key)) return "urgent";
  if (/(major|p1)/.test(key)) return "high";
  if (/(minor|p3|trivial)/.test(key)) return "low";
  return "normal";
}

export function priorityToTone(value: string | null | undefined): Tone {
  return PRIORITY_TONE[asPriority(value)];
}

/* ============================================================================
   RAG / health  (project health, programme status, KPI traffic lights)
============================================================================ */

export const RAG_STATES = ["green", "amber", "red", "grey"] as const;
export type RagState = (typeof RAG_STATES)[number];

export const RAG_TONE: Record<RagState, Tone> = {
  green: "success",
  amber: "warning",
  red: "danger",
  grey: "neutral",
};

export const RAG_LABEL: Record<RagState, string> = {
  green: "On Track",
  amber: "At Risk",
  red: "Off Track",
  grey: "Not Rated",
};

export function asRag(value: string | null | undefined): RagState {
  const key = normalizeKey(value);
  if ((RAG_STATES as readonly string[]).includes(key)) return key as RagState;
  if (/(on_track|good|healthy|ok|pass)/.test(key)) return "green";
  if (/(at_risk|watch|caution|warn)/.test(key)) return "amber";
  if (/(off_track|bad|fail|critical|breach)/.test(key)) return "red";
  return "grey";
}

export function ragToTone(value: string | null | undefined): Tone {
  return RAG_TONE[asRag(value)];
}

/* ============================================================================
   Deltas / trends  (variance columns, KPI arrows)
============================================================================ */

export type Direction = "up" | "down" | "flat";

export function directionOf(delta: number, epsilon = 0): Direction {
  if (delta > epsilon) return "up";
  if (delta < -epsilon) return "down";
  return "flat";
}

/**
 * Tone for a numeric delta. Cost overruns are bad when they go up; schedule
 * float is bad when it goes down — pass `higherIsBetter` accordingly.
 */
export function deltaToTone(
  delta: number,
  options: { higherIsBetter?: boolean; epsilon?: number } = {},
): Tone {
  const { higherIsBetter = true, epsilon = 0 } = options;
  const dir = directionOf(delta, epsilon);
  if (dir === "flat") return "neutral";
  const good = dir === "up" ? higherIsBetter : !higherIsBetter;
  return good ? "success" : "danger";
}

/* ============================================================================
   Raw CSS custom properties
   For SVG/canvas/WebGL consumers (recharts, three.js, pdf overlays) that need
   a colour value rather than a class name.
============================================================================ */

export const cssVar = {
  surface: "var(--ds-surface)",
  surfaceRaised: "var(--ds-surface-raised)",
  surfaceSunken: "var(--ds-surface-sunken)",
  surfaceOverlay: "var(--ds-surface-overlay)",
  surfaceHover: "var(--ds-surface-hover)",
  surfaceActive: "var(--ds-surface-active)",
  surfaceSelected: "var(--ds-surface-selected)",
  scrim: "var(--ds-scrim)",
  border: "var(--ds-border)",
  borderSubtle: "var(--ds-border-subtle)",
  borderStrong: "var(--ds-border-strong)",
  content: "var(--ds-content)",
  contentMuted: "var(--ds-content-muted)",
  contentSubtle: "var(--ds-content-subtle)",
  accent: "var(--ds-accent)",
  accentFg: "var(--ds-accent-fg)",
  accentText: "var(--ds-accent-text)",
  focusRing: "var(--ds-focus-ring)",
  chartGrid: "var(--ds-chart-grid)",
  chartAxis: "var(--ds-chart-axis)",
  success: "var(--ds-success-solid)",
  warning: "var(--ds-warning-solid)",
  danger: "var(--ds-danger-solid)",
  info: "var(--ds-info-solid)",
  highlight: "var(--ds-highlight-solid)",
} as const;

export type CssVarName = keyof typeof cssVar;

/** Ordered categorical palette for charts. Re-themes automatically. */
export const CHART_COLORS: readonly string[] = [
  "var(--ds-chart-1)",
  "var(--ds-chart-2)",
  "var(--ds-chart-3)",
  "var(--ds-chart-4)",
  "var(--ds-chart-5)",
  "var(--ds-chart-6)",
  "var(--ds-chart-7)",
  "var(--ds-chart-8)",
];

export function chartColor(index: number): string {
  const length = CHART_COLORS.length;
  const i = ((index % length) + length) % length;
  return CHART_COLORS[i] ?? "var(--ds-chart-1)";
}

/** Tone → the chart-safe solid colour for that tone. */
export const TONE_CSS_VAR: Record<Tone, string> = {
  neutral: "var(--ds-neutral-solid)",
  accent: "var(--ds-accent)",
  info: "var(--ds-info-solid)",
  success: "var(--ds-success-solid)",
  warning: "var(--ds-warning-solid)",
  danger: "var(--ds-danger-solid)",
  highlight: "var(--ds-highlight-solid)",
};

/**
 * Read a token's *computed* value (e.g. "#12151c") — needed by three.js and
 * canvas APIs that cannot consume `var()`. Returns "" during SSR.
 */
export function readToken(name: string): string {
  if (typeof window === "undefined" || typeof document === "undefined") return "";
  const prop = name.startsWith("--") ? name : `--ds-${name}`;
  return getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
}

/* ============================================================================
   Stacking order — one authority so overlays never fight.
   Use the Tailwind classes in Z_CLASS; the numbers are for inline styles and
   portal containers.
============================================================================ */

export const Z = {
  base: 0,
  raised: 10,
  sticky: 20,
  header: 30,
  dropdown: 40,
  overlay: 50,
  modal: 60,
  popover: 70,
  toast: 80,
  tooltip: 90,
  command: 100,
} as const;

export type ZLayer = keyof typeof Z;

export const Z_CLASS: Record<ZLayer, string> = {
  base: "z-0",
  raised: "z-10",
  sticky: "z-20",
  header: "z-30",
  dropdown: "z-40",
  overlay: "z-50",
  modal: "z-[60]",
  popover: "z-[70]",
  toast: "z-[80]",
  tooltip: "z-[90]",
  command: "z-[100]",
};

/* ============================================================================
   Shared surface recipes
   Small, deliberately un-opinionated class strings that keep every panel in
   the product built from the same three ingredients.
============================================================================ */

export const surface = {
  /** App canvas. */
  page: "bg-surface text-content",
  /** Card / panel. */
  card: "bg-surface-raised border border-border rounded-lg",
  /** Card with lift (use sparingly — borders read better in dark). */
  cardRaised: "bg-surface-raised border border-border rounded-lg shadow-e1",
  /** Inset well: table headers, code blocks, meta strips. */
  well: "bg-surface-sunken border border-border-subtle rounded-md",
  /** Floating layer: menus, popovers, command palette. */
  overlay: "bg-surface-overlay border border-border rounded-lg shadow-e3",
  /** Modal panel. */
  dialog: "bg-surface-overlay border border-border rounded-xl shadow-e4",
  /** Full-screen backdrop. */
  scrim: "bg-scrim backdrop-blur-[2px]",
  /** Row hover/selected states for tables and lists. */
  rowHover: "hover:bg-surface-hover",
  rowSelected: "bg-surface-selected",
  /** Standard hairline separator. */
  divider: "border-border",
} as const;

export const focus = {
  /** Default outside ring. */
  ring: "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
  /** Inside ring for flush toolbar controls. */
  inset: "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ds-focus-ring)]",
  /** Ring drawn on the whole row (tables, list items). */
  row: "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
} as const;

export const text = {
  pageTitle: "text-xl font-semibold tracking-[-0.012em] text-content",
  sectionTitle: "text-sm font-semibold text-content",
  body: "text-body text-content",
  muted: "text-body text-content-muted",
  meta: "text-meta text-content-subtle",
  label: "text-label uppercase text-content-subtle",
  mono: "font-mono text-code tabular-nums",
  numeric: "tabular-nums",
} as const;

/* ============================================================================
   Density & theme literals (mirrors src/lib/theme.tsx — imported by anything
   that must not pull React in).
============================================================================ */

export const THEMES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEMES)[number];
export type ResolvedTheme = "light" | "dark";

export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

export const THEME_STORAGE_KEY = "constructos:theme";
export const DENSITY_STORAGE_KEY = "constructos:density";

/** Values kept in sync with the anti-flash script in index.html. */
export const THEME_COLOR: Record<ResolvedTheme, string> = {
  light: "#f6f7fa",
  dark: "#0a0c11",
};
