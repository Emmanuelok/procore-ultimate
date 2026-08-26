/**
 * data-table/format — the number, money, date and size formatters the grid
 * uses for its right-aligned columns, footers and CSV export.
 *
 * Every formatter is total: `null`, `undefined`, `NaN` and non-coercible
 * strings return the em-dash placeholder rather than "NaN".
 */

export const EMPTY_VALUE = "—"; // em dash

/* ------------------------------------------------------------------------- */
/* Coercion                                                                   */
/* ------------------------------------------------------------------------- */

/** Coerce to a finite number, or `null`. Strips $ , % and spaces. */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const cleaned = value.replace(/[\s,$% ]/g, "").replace(/^\((.*)\)$/, "-$1");
    if (cleaned === "" || cleaned === "-") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Coerce to a `Date`, or `null`. Accepts ISO strings, epoch ms and Dates. */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Flatten any cell value to a searchable / sortable string. */
export function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["name", "label", "title", "displayName", "email", "id"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate) return candidate;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value);
}

const isBlank = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  value === "" ||
  (typeof value === "number" && Number.isNaN(value));

/* ------------------------------------------------------------------------- */
/* Intl caches — constructing a NumberFormat per cell is the classic grid      */
/* performance bug. One instance per (locale, options) shape.                  */
/* ------------------------------------------------------------------------- */

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(options);
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(undefined, options);
    numberFormats.set(key, format);
  }
  return format;
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();

function dateFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(undefined, options);
    dateFormats.set(key, format);
  }
  return format;
}

/* ------------------------------------------------------------------------- */
/* Numbers                                                                    */
/* ------------------------------------------------------------------------- */

export interface NumberFormatOptions {
  /** Fixed fraction digits. Omit for 0–2 adaptive. */
  precision?: number;
  /** Abbreviate: 1,240,000 → 1.24M. */
  compact?: boolean;
  /** Always show a leading + for positives. */
  signed?: boolean;
  placeholder?: string;
}

export function formatNumber(value: unknown, options: NumberFormatOptions = {}): string {
  const { precision, compact = false, signed = false, placeholder = EMPTY_VALUE } = options;
  const n = toNumber(value);
  if (n === null) return placeholder;

  const intl: Intl.NumberFormatOptions = compact
    ? {
        notation: "compact",
        maximumFractionDigits: precision ?? 1,
        minimumFractionDigits: 0,
      }
    : {
        minimumFractionDigits: precision ?? 0,
        maximumFractionDigits: precision ?? 2,
      };
  if (signed) intl.signDisplay = "exceptZero";
  return numberFormat(intl).format(n);
}

export interface CurrencyFormatOptions extends NumberFormatOptions {
  currency?: string;
  /** Show the code instead of the symbol (USD 1,200 vs $1,200). */
  code?: boolean;
  /** Wrap negatives in parentheses, as accounting statements do. */
  accounting?: boolean;
}

export function formatCurrency(value: unknown, options: CurrencyFormatOptions = {}): string {
  const {
    currency = "USD",
    precision,
    compact = false,
    signed = false,
    code = false,
    accounting = false,
    placeholder = EMPTY_VALUE,
  } = options;
  const n = toNumber(value);
  if (n === null) return placeholder;

  const intl: Intl.NumberFormatOptions = {
    style: "currency",
    currency,
    currencyDisplay: code ? "code" : "narrowSymbol",
    minimumFractionDigits: precision ?? 0,
    maximumFractionDigits: precision ?? 0,
  };
  if (compact) {
    intl.notation = "compact";
    intl.maximumFractionDigits = precision ?? 1;
    intl.minimumFractionDigits = 0;
  }
  if (signed) intl.signDisplay = "exceptZero";
  if (accounting) intl.currencySign = "accounting";

  try {
    return numberFormat(intl).format(n);
  } catch {
    // Unknown currency code — fall back to a plain number.
    return formatNumber(n, { precision: precision ?? 0, compact, signed });
  }
}

/** `0.184` → "18.4%" when `fraction`, `18.4` → "18.4%" otherwise. */
export function formatPercent(
  value: unknown,
  options: NumberFormatOptions & { fraction?: boolean } = {},
): string {
  const { precision = 1, signed = false, fraction = false, placeholder = EMPTY_VALUE } = options;
  const n = toNumber(value);
  if (n === null) return placeholder;
  const intl: Intl.NumberFormatOptions = {
    style: "percent",
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  };
  if (signed) intl.signDisplay = "exceptZero";
  return numberFormat(intl).format(fraction ? n : n / 100);
}

/** 1_240_000 → "1.2M". */
export function formatCompactNumber(value: unknown, precision = 1): string {
  return formatNumber(value, { compact: true, precision });
}

export function formatFileSize(value: unknown, placeholder = EMPTY_VALUE): string {
  const bytes = toNumber(value);
  if (bytes === null || bytes < 0) return placeholder;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const unit = units[unitIndex] ?? "PB";
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${unit}`;
}

/** Seconds or an ISO duration-ish number → "3h 12m". */
export function formatDuration(value: unknown, placeholder = EMPTY_VALUE): string {
  const seconds = toNumber(value);
  if (seconds === null) return placeholder;
  const abs = Math.abs(Math.round(seconds));
  if (abs < 60) return `${abs}s`;
  const minutes = Math.floor(abs / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

/* ------------------------------------------------------------------------- */
/* Dates                                                                      */
/* ------------------------------------------------------------------------- */

export function formatDateCell(value: unknown, placeholder = EMPTY_VALUE): string {
  const date = toDate(value);
  if (!date) return placeholder;
  return dateFormat({ year: "numeric", month: "short", day: "2-digit" }).format(date);
}

export function formatDateTimeCell(value: unknown, placeholder = EMPTY_VALUE): string {
  const date = toDate(value);
  if (!date) return placeholder;
  return dateFormat({
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatTimeCell(value: unknown, placeholder = EMPTY_VALUE): string {
  const date = toDate(value);
  if (!date) return placeholder;
  return dateFormat({ hour: "numeric", minute: "2-digit" }).format(date);
}

const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 31_536_000_000],
  ["month", 2_592_000_000],
  ["week", 604_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

let relativeFormat: Intl.RelativeTimeFormat | null = null;

/** "3 days ago", "in 2 hours", "just now". */
export function formatRelativeTime(value: unknown, now: number = Date.now()): string {
  const date = toDate(value);
  if (!date) return EMPTY_VALUE;
  const delta = date.getTime() - now;
  const abs = Math.abs(delta);
  if (abs < 45_000) return "just now";
  relativeFormat ??= new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const entry of RELATIVE_UNITS) {
    const [unit, ms] = entry;
    if (abs >= ms) return relativeFormat.format(Math.round(delta / ms), unit);
  }
  return relativeFormat.format(Math.round(delta / 60_000), "minute");
}

/** "Today", "Yesterday", or a long date — for grouping activity feeds. */
export function formatDayBucket(value: unknown): string {
  const date = toDate(value);
  if (!date) return "Unknown";
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) {
    return dateFormat({ weekday: "long" }).format(date);
  }
  return dateFormat({ year: "numeric", month: "long", day: "numeric" }).format(date);
}

/** ISO date (`yyyy-mm-dd`) for `<input type="date">` round-trips. */
export function toDateInputValue(value: unknown): string {
  const date = toDate(value);
  if (!date) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/* ------------------------------------------------------------------------- */
/* Deltas                                                                     */
/* ------------------------------------------------------------------------- */

/** "+12.4%" / "−3 days" style variance strings. */
export function formatDelta(
  value: unknown,
  options: NumberFormatOptions & { percent?: boolean; currency?: string } = {},
): string {
  const { percent = false, currency, ...rest } = options;
  if (percent) return formatPercent(value, { ...rest, signed: true });
  if (currency) return formatCurrency(value, { ...rest, currency, signed: true });
  return formatNumber(value, { ...rest, signed: true });
}

/* ------------------------------------------------------------------------- */
/* Aggregates                                                                 */
/* ------------------------------------------------------------------------- */

export type AggregateKind =
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "count"
  | "countUnique"
  | "median"
  | "extent"
  | "first"
  | "last"
  | "none";

/** Compute an aggregate over raw cell values. Non-numeric entries are skipped. */
export function aggregateValues(kind: AggregateKind, values: readonly unknown[]): number | null {
  if (kind === "none") return null;
  if (kind === "count") return values.length;
  if (kind === "countUnique") {
    const seen = new Set<string>();
    for (const value of values) if (!isBlank(value)) seen.add(toText(value));
    return seen.size;
  }
  if (kind === "first" || kind === "last") {
    const value = kind === "first" ? values[0] : values[values.length - 1];
    return toNumber(value);
  }

  const numbers: number[] = [];
  for (const value of values) {
    const n = toNumber(value);
    if (n !== null) numbers.push(n);
  }
  if (numbers.length === 0) return null;

  switch (kind) {
    case "sum":
      return numbers.reduce((total, n) => total + n, 0);
    case "avg":
      return numbers.reduce((total, n) => total + n, 0) / numbers.length;
    case "min":
      return Math.min(...numbers);
    case "max":
    case "extent":
      return Math.max(...numbers);
    case "median": {
      const sorted = [...numbers].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 1) return sorted[middle] ?? null;
      const low = sorted[middle - 1] ?? 0;
      const high = sorted[middle] ?? 0;
      return (low + high) / 2;
    }
    default:
      return null;
  }
}

export const AGGREGATE_LABEL: Record<AggregateKind, string> = {
  sum: "Total",
  avg: "Average",
  min: "Min",
  max: "Max",
  count: "Count",
  countUnique: "Unique",
  median: "Median",
  extent: "Range",
  first: "First",
  last: "Last",
  none: "",
};

/* ------------------------------------------------------------------------- */
/* Bundle                                                                     */
/* ------------------------------------------------------------------------- */

/** Every formatter in one object, for call sites that prefer a namespace. */
export const dataFormat = {
  number: formatNumber,
  currency: formatCurrency,
  percent: formatPercent,
  compact: formatCompactNumber,
  fileSize: formatFileSize,
  duration: formatDuration,
  date: formatDateCell,
  dateTime: formatDateTimeCell,
  time: formatTimeCell,
  relative: formatRelativeTime,
  dayBucket: formatDayBucket,
  delta: formatDelta,
  text: toText,
  toNumber,
  toDate,
  aggregate: aggregateValues,
  EMPTY: EMPTY_VALUE,
} as const;
