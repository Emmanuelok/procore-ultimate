/**
 * Shared machinery for the project workspace shell and the pages it wraps.
 *
 * ---------------------------------------------------------------------------
 * THE HONESTY RULES, IMPLEMENTED ONCE HERE SO EVERY PANEL OBEYS THEM
 *
 *  1. A figure with no source renders its EMPTY STATE WITH THE REASON, never a
 *     zero. The API returns `{ value: null, reasons: [...] }` for anything it
 *     could not derive; `<Figure>` prints "not available" plus those reasons
 *     verbatim, because paraphrasing them destroys the only thing that makes
 *     them actionable.
 *  2. Money in different currencies is NEVER summed. Anything that totals
 *     buckets by currency first and says so out loud.
 *  3. A missing value is `—` with a reason, not 0. `0` is a claim about the
 *     project; `—` is a claim about our records. They are different sentences.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { formatCurrency, formatNumber } from "../../ui";
import { cx } from "../../ui/cx";
import { toneClass, type Tone } from "../../ui/tokens";

/* ========================================================================== */
/* Wire shapes                                                                */
/* ========================================================================== */

/** A figure the platform either holds the inputs for, or does not. */
export interface Unknowable<T = number> {
  value: T | null;
  inputs?: Record<string, unknown>;
  reasons: string[];
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** The project record, exactly as `GET /api/v1/projects/:id` returns it. */
export interface ProjectRecord {
  id: string;
  name: string;
  number: string | null;
  stage: string;
  type: string | null;
  department: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  startDate: string | null;
  finishDate: string | null;
  currency: string;
  value: number | null;
  description: string | null;
  portfolioId: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** `GET /api/v1/projects/:id/summary` — cross-tool counters. */
export interface ProjectSummary {
  rfisOpen: number;
  submittalsOpen: number;
  punchOpen: number;
  sheets: number;
  models: number;
  assets: number;
  signalsOpen: number;
}

/** One currency bucket of `GET /projects/:id/prime-contracts/summary`. */
export interface PrimeContractCurrencyGroup {
  currency: string;
  contractCount: number;
  executedCount: number;
  originalContractSum: number;
  approvedChangeSum: number;
  pendingChangeSum: number;
  revisedContractSum: number;
  totalBilled: number;
  totalPaid: number;
  retainageHeld: number;
  balanceToFinish: number;
  percentComplete: Unknowable;
}

/**
 * The prime-contract position, per currency and never across it. The API
 * returns `combinedRevisedContractSum` as an `Unknowable` precisely so a
 * multi-currency project gets a reason instead of a meaningless total.
 */
export interface PrimeContractSummary {
  groups: PrimeContractCurrencyGroup[];
  combinedRevisedContractSum: Unknowable;
}

export interface SignalRow {
  id: string;
  projectId: string | null;
  detector: string;
  severity: string;
  confidence: number;
  title: string;
  explanation: string;
  disposition: string;
  createdAt: string;
}

/** Dispositions the assurance module itself treats as still open. */
export const OPEN_SIGNAL_DISPOSITIONS = ["new", "under_review", "confirmed", "escalated"];

/* ========================================================================== */
/* Loading                                                                    */
/* ========================================================================== */

export interface Loadable<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * One GET, reloadable, aborted on unmount. A `null` path means "not yet" and
 * settles into an idle, non-loading state rather than a spinner that never
 * resolves.
 */
export function useResource<T>(path: string | null): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (path === null) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .get<T>(path, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        setData(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "The request failed.");
        setLoading(false);
      });
    return () => controller.abort();
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}

/**
 * A dependent GET: fetch `first`, derive a second path from it, fetch that.
 * Used for budget → budget summary and schedule → schedule detail, where the
 * id of the second request only exists once the first has landed.
 */
export function useDerivedResource<A, B>(
  source: Loadable<A>,
  derive: (data: A) => string | null,
): Loadable<B> {
  // `path` is a string, so recomputing it every render is free: `useResource`
  // keys its effect on the value, not the identity.
  const path = source.data ? derive(source.data) : null;
  const child = useResource<B>(path);
  return {
    data: child.data,
    loading: source.loading || (path !== null && child.loading),
    error: source.error ?? child.error,
    reload: child.reload,
  };
}

/* ========================================================================== */
/* Formatting                                                                 */
/* ========================================================================== */

export const DASH = "—";

/** Money always carries its currency; there is no "the" currency here. */
export function money(
  value: number | null | undefined,
  currency: string,
  options: { compact?: boolean; precision?: number } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const compact = options.compact ?? false;
  // Compact keeps one decimal ($12.5M): rounding to $13M on a KPI tile loses
  // half a million pounds of resolution for no gain in width.
  return formatCurrency(value, {
    currency,
    precision: options.precision ?? (compact ? 1 : 0),
    compact,
  });
}

export function pct(value: number | null | undefined, dp = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${formatNumber(value, { precision: dp })}%`;
}

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return formatNumber(value, { precision: 0 });
}

export function isoDate(value: string | null | undefined): string {
  if (!value) return DASH;
  const d = new Date(value.length > 10 ? value : `${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function isoDateShort(value: string | null | undefined): string {
  if (!value) return DASH;
  const d = new Date(value.length > 10 ? value : `${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function titleCase(value: string | null | undefined): string {
  if (!value) return DASH;
  return value
    .split(/[_\s-]+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`, both ISO dates. Null when either is absent. */
export function daysBetween(
  from: string | null | undefined,
  to: string | null | undefined,
): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from.length > 10 ? from : `${from}T00:00:00Z`);
  const b = Date.parse(to.length > 10 ? to : `${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/* ========================================================================== */
/* Project stage                                                              */
/* ========================================================================== */

export const PROJECT_STAGE_LABEL: Record<string, string> = {
  bidding: "Bidding",
  pre_construction: "Pre-construction",
  course_of_construction: "In construction",
  warranty: "Warranty",
  closed: "Closed",
};

export function stageLabel(stage: string | null | undefined): string {
  if (!stage) return "Unknown stage";
  return PROJECT_STAGE_LABEL[stage] ?? titleCase(stage);
}

export function stageTone(stage: string | null | undefined): Tone {
  switch (stage) {
    case "bidding":
      return "warning";
    case "pre_construction":
      return "info";
    case "course_of_construction":
      return "success";
    case "warranty":
      return "highlight";
    case "closed":
      return "neutral";
    default:
      return "neutral";
  }
}

/* ========================================================================== */
/* Honest figures                                                             */
/* ========================================================================== */

/**
 * "not available", plus the server's own words for why. Never a zero, never a
 * paraphrase.
 */
export function NotAvailable({
  reasons,
  className,
  inline = false,
}: {
  reasons?: readonly string[];
  className?: string;
  inline?: boolean;
}) {
  return (
    <span className={cx("min-w-0", className)}>
      <span className="italic text-content-subtle">not available</span>
      {reasons && reasons.length > 0 && !inline ? (
        <span className="mt-1 block text-2xs leading-snug text-content-subtle">
          {reasons.join(" ")}
        </span>
      ) : null}
    </span>
  );
}

/**
 * An `Unknowable` from the API. A null value prints "not available" plus the
 * reasons; a value is handed to `render`.
 */
export function Figure({
  figure,
  render,
  className,
  fallbackReason,
}: {
  figure: Unknowable | null | undefined;
  render: (value: number) => ReactNode;
  className?: string;
  /** Shown when the figure itself is absent (the request has not landed). */
  fallbackReason?: string;
}) {
  if (!figure) {
    return (
      <NotAvailable
        className={className}
        reasons={fallbackReason ? [fallbackReason] : undefined}
      />
    );
  }
  if (figure.value === null) {
    return <NotAvailable className={className} reasons={figure.reasons} />;
  }
  return <span className={className}>{render(figure.value)}</span>;
}

/** The block of reasons under a panel that could not be computed. */
export function ReasonList({
  reasons,
  className,
}: {
  reasons: readonly string[];
  className?: string;
}) {
  if (reasons.length === 0) return null;
  return (
    <ul className={cx("space-y-1 text-2xs leading-snug text-content-subtle", className)}>
      {reasons.map((reason, index) => (
        <li key={index} className="flex gap-1.5">
          <span aria-hidden="true" className="mt-1 size-1 shrink-0 rounded-full bg-border-strong" />
          <span>{reason}</span>
        </li>
      ))}
    </ul>
  );
}

/** A label/value pair used across the KPI and summary rails. */
export function StatLine({
  label,
  value,
  tone,
  strong = false,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: Tone;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="truncate text-meta text-content-subtle">{label}</dt>
      <dd
        className={cx(
          "shrink-0 text-meta tabular-nums",
          strong ? "font-semibold text-content" : "text-content",
          tone && toneClass(tone, "text"),
        )}
      >
        {value}
      </dd>
    </div>
  );
}
