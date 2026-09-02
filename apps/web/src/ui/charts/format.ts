/**
 * charts/format.ts — number, currency, percent and date formatting for charts.
 *
 * Deliberately separate from the data-table formatters: an axis tick has a
 * different budget from a table cell (four characters, not fourteen), so a
 * chart shortens where a table spells out. Every chart takes the same two
 * hooks — `valueFormat` (a preset name or your own function) and
 * `formatOptions` (locale / currency / precision) — so one call site changes
 * every number a chart draws: axis, tooltip, legend, data-table fallback.
 */

/* ============================================================================
   Types
============================================================================ */

export type NumberFormatName =
  | "number"
  | "compact"
  | "currency"
  | "currency-compact"
  | "percent"
  | "percent100"
  | "days"
  | "hours"
  | "none";

export interface ChartFormatOptions {
  /** BCP-47 tag. Defaults to the browser locale. */
  locale?: string | undefined;
  /** ISO-4217 code, used by the currency presets. Default "USD". */
  currency?: string | undefined;
  minimumFractionDigits?: number | undefined;
  maximumFractionDigits?: number | undefined;
  signDisplay?: "auto" | "always" | "never" | "exceptZero" | undefined;
  /** Appended after the formatted number, with a hair space. */
  unit?: string | undefined;
}

/** The signature every chart uses internally once a preset is resolved. */
export type ValueFormatter = (value: number) => string;

/** What callers may pass: a preset name, or their own function. */
export type ValueFormat = NumberFormatName | ValueFormatter;

/** X-axis / category label formatting. */
export type LabelFormatter = (label: string | number) => string;

/* ============================================================================
   Intl caches — building a formatter costs ~50µs; a chart re-renders often.
============================================================================ */

const numberCache = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string | undefined, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale ?? ""}|${JSON.stringify(options)}`;
  let formatter = numberCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    numberCache.set(key, formatter);
  }
  return formatter;
}

const dateCache = new Map<string, Intl.DateTimeFormat>();

function dateFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ""}|${JSON.stringify(options)}`;
  let formatter = dateCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    dateCache.set(key, formatter);
  }
  return formatter;
}

/** The string a chart prints where there is no value. Never "0". */
export const CHART_NO_VALUE = "—";

function isNumeric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/* ============================================================================
   Presets
============================================================================ */

export function formatChartNumber(value: number, options: ChartFormatOptions = {}): string {
  if (!isNumeric(value)) return CHART_NO_VALUE;
  const digits = magnitudeDigits(value);
  return withUnit(
    numberFormat(options.locale, {
      minimumFractionDigits: options.minimumFractionDigits ?? 0,
      maximumFractionDigits: options.maximumFractionDigits ?? digits,
      signDisplay: options.signDisplay ?? "auto",
    }).format(value),
    options.unit,
  );
}

/** 1_240_000 → "1.24M". The axis-tick default for anything above 4 digits. */
export function formatChartCompact(value: number, options: ChartFormatOptions = {}): string {
  if (!isNumeric(value)) return CHART_NO_VALUE;
  return withUnit(
    numberFormat(options.locale, {
      notation: "compact",
      compactDisplay: "short",
      maximumFractionDigits:
        options.maximumFractionDigits ?? (Math.abs(value) >= 1000 ? 1 : magnitudeDigits(value)),
      signDisplay: options.signDisplay ?? "auto",
    }).format(value),
    options.unit,
  );
}

export function formatChartCurrency(value: number, options: ChartFormatOptions = {}): string {
  if (!isNumeric(value)) return CHART_NO_VALUE;
  return numberFormat(options.locale, {
    style: "currency",
    currency: options.currency ?? "USD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
    maximumFractionDigits: options.maximumFractionDigits ?? (Math.abs(value) < 100 ? 2 : 0),
    signDisplay: options.signDisplay ?? "auto",
  }).format(value);
}

/** "$1.24M" — the only sane currency format for a chart axis. */
export function formatChartCurrencyCompact(value: number, options: ChartFormatOptions = {}): string {
  if (!isNumeric(value)) return CHART_NO_VALUE;
  return numberFormat(options.locale, {
    style: "currency",
    currency: options.currency ?? "USD",
    currencyDisplay: "narrowSymbol",
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: options.maximumFractionDigits ?? 1,
    signDisplay: options.signDisplay ?? "auto",
  }).format(value);
}

/** Input is a fraction: 0.42 → "42%". */
export function formatChartPercent(value: number, options: ChartFormatOptions = {}): string {
  if (!isNumeric(value)) return CHART_NO_VALUE;
  return numberFormat(options.locale, {
    style: "percent",
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
    maximumFractionDigits: options.maximumFractionDigits ?? (Math.abs(value) < 0.1 ? 1 : 0),
    signDisplay: options.signDisplay ?? "auto",
  }).format(value);
}

/** Input is already scaled: 42 → "42%". */
export function formatChartPercent100(value: number, options: ChartFormatOptions = {}): string {
  if (!isNumeric(value)) return CHART_NO_VALUE;
  return formatChartPercent(value / 100, options);
}

/** 12 → "12d", 1 → "1d", -3 → "−3d" (schedule float, lag, duration). */
export function formatChartDays(value: number, options: ChartFormatOptions = {}): string {
  if (!isNumeric(value)) return CHART_NO_VALUE;
  return `${formatChartNumber(value, { ...options, unit: undefined, maximumFractionDigits: options.maximumFractionDigits ?? 1 })}d`;
}

export function formatChartHours(value: number, options: ChartFormatOptions = {}): string {
  if (!isNumeric(value)) return CHART_NO_VALUE;
  return `${formatChartNumber(value, { ...options, unit: undefined, maximumFractionDigits: options.maximumFractionDigits ?? 1 })}h`;
}

/** A signed delta, always carrying its sign so "+" reads as a change. */
export function formatChartDelta(value: number, format?: ValueFormat, options: ChartFormatOptions = {}): string {
  if (!isNumeric(value)) return CHART_NO_VALUE;
  const formatter = makeValueFormatter(format ?? "number", { ...options, signDisplay: "exceptZero" });
  return formatter(value);
}

function magnitudeDigits(value: number): number {
  const abs = Math.abs(value);
  if (abs === 0) return 0;
  if (abs < 1) return 2;
  if (abs < 100) return 1;
  return 0;
}

function withUnit(text: string, unit: string | undefined): string {
  return unit ? `${text} ${unit}` : text;
}

/* ============================================================================
   Resolution
============================================================================ */

const PRESETS: Record<NumberFormatName, (value: number, options: ChartFormatOptions) => string> = {
  number: formatChartNumber,
  compact: formatChartCompact,
  currency: formatChartCurrency,
  "currency-compact": formatChartCurrencyCompact,
  percent: formatChartPercent,
  percent100: formatChartPercent100,
  days: formatChartDays,
  hours: formatChartHours,
  none: (value) => (isNumeric(value) ? String(value) : CHART_NO_VALUE),
};

/**
 * Turn whatever the caller passed into a plain `(number) => string`.
 * Falls back to `formatChartNumber` so a chart always prints *something*
 * deterministic rather than "[object Object]".
 */
export function makeValueFormatter(
  format: ValueFormat | undefined,
  options: ChartFormatOptions = {},
): ValueFormatter {
  if (typeof format === "function") return format;
  const preset = format ? PRESETS[format] : undefined;
  if (preset) return (value) => preset(value, options);
  return (value) => formatChartNumber(value, options);
}

/**
 * The axis variant of a formatter: same family, fewer characters. A "currency"
 * value formatter becomes "currency-compact" on the axis so ticks stay short,
 * unless the caller supplied their own function (then it is used verbatim).
 */
export function makeAxisFormatter(
  format: ValueFormat | undefined,
  options: ChartFormatOptions = {},
): ValueFormatter {
  if (typeof format === "function") return format;
  if (format === "currency") return (value) => formatChartCurrencyCompact(value, options);
  if (format === "number" || format === undefined) {
    return (value) =>
      Math.abs(value) >= 10_000
        ? formatChartCompact(value, options)
        : formatChartNumber(value, options);
  }
  return makeValueFormatter(format, options);
}

/** Coerce anything a payload can hold into a finite number, or null. */
export function toChartNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/* ============================================================================
   Dates
============================================================================ */

export type DateStyleName = "day" | "dayShort" | "month" | "monthYear" | "year" | "quarter" | "full" | "weekday";

/** Anything a schedule row or a time series is likely to hand us. */
export function toChartDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Bare "YYYY-MM-DD" must not be dragged across a timezone boundary.
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (bare) {
    const [, y, m, d] = bare;
    return new Date(Number(y), Number(m) - 1, Number(d));
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatChartDate(
  value: Date | string | number | null | undefined,
  style: DateStyleName = "dayShort",
  locale?: string,
): string {
  const date = toChartDate(value);
  if (!date) return CHART_NO_VALUE;
  switch (style) {
    case "day":
      return dateFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(date);
    case "dayShort":
      return dateFormat(locale, { day: "numeric", month: "short" }).format(date);
    case "month":
      return dateFormat(locale, { month: "short" }).format(date);
    case "monthYear":
      return dateFormat(locale, { month: "short", year: "numeric" }).format(date);
    case "year":
      return dateFormat(locale, { year: "numeric" }).format(date);
    case "weekday":
      return dateFormat(locale, { weekday: "short" }).format(date);
    case "quarter":
      return `Q${Math.floor(date.getMonth() / 3) + 1} ${date.getFullYear()}`;
    case "full":
    default:
      return dateFormat(locale, { dateStyle: "medium" }).format(date);
  }
}

/** Category-axis default: passes strings through, formats dates. */
export function makeLabelFormatter(
  format: LabelFormatter | DateStyleName | undefined,
  locale?: string,
): LabelFormatter {
  if (typeof format === "function") return format;
  if (typeof format === "string") {
    return (label) => formatChartDate(label as string | number, format, locale);
  }
  return (label) => (label == null ? CHART_NO_VALUE : String(label));
}
