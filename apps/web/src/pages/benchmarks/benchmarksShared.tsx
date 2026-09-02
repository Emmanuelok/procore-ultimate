/**
 * Shared types and presentation helpers for the Benchmarks workspace —
 * spec Vol II Domain V (#821-858) / module M11.
 *
 * The workspace's honesty rules mirror the API's:
 *   · n is ALWAYS disclosed (#831) — even when everything else is withheld;
 *   · min-n suppression ({suppressed:true}) is a privacy outcome, rendered
 *     as an explanatory card, never as an error;
 *   · seed-derived statistics carry the server's healthWarning verbatim in
 *     an amber banner — illustrative numbers must never look like evidence;
 *   · seed_only access is labelled and the upgrade note shown as sent.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiClientError, api } from "../../lib/api";
import { Badge, Card, CardBody } from "../../ui";

/* --------------------------------- Types ---------------------------------- */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface MetricDef {
  key: string;
  name: string;
  unit: string;
  higherIsBetter: boolean;
  description: string;
  /** which platform records the computation reads, in prose */
  inputs: string;
}

export interface MetricsResponse {
  metrics: MetricDef[];
  minSampleN: number;
  accessModel: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  number: string | null;
  stage: string;
}

export interface SnapshotRow {
  id: string;
  projectId: string;
  metric: string;
  value: number;
  unit: string;
  /** the exact figures the computation read, persisted for auditability */
  inputs: Record<string, unknown> | null;
  contributedSampleId: string | null;
  computedBy: string;
  createdAt: string;
}

export interface SampleView {
  id: string;
  metric: string;
  assetClass: string;
  region: string;
  value: number;
  unit: string;
  source: string;
  dataYear: number | null;
  methodology: string | null;
  createdAt: string;
}

export interface ContributeResponse {
  alreadyContributed: boolean;
  snapshotId: string;
  sample: SampleView | null;
}

export interface HistogramBin {
  lo: number;
  hi: number;
  count: number;
}

/** Full stats when computable; bare {n} (+suppressed) when withheld. */
export interface DistributionBody {
  n: number;
  suppressed?: boolean;
  min?: number;
  p25?: number;
  median?: number;
  p75?: number;
  p90?: number;
  max?: number;
  histogram?: HistogramBin[];
}

export type AccessLevel = "contributed" | "seed_only";

export interface DistributionResponse {
  metric: string;
  unit: string;
  higherIsBetter: boolean;
  assetClass: string;
  region: string;
  accessLevel: AccessLevel;
  minSampleN: number;
  /** upgrade note — present when accessLevel is seed_only */
  note?: string;
  distribution: DistributionBody;
  seedIncluded: boolean;
  /** verbatim seed health warning — present when seed rows back the stats */
  healthWarning?: string;
  disclosures: string[];
}

export interface CompareOutlier {
  adverse: boolean;
  side: "above_p90" | "below_p10" | null;
  signalRaised: boolean;
}

export interface CompareResponse {
  metric: string;
  assetClass: string;
  region: string;
  snapshotId: string;
  value: number;
  unit: string;
  computedAt: string;
  accessLevel: AccessLevel;
  minSampleN: number;
  percentile: number | null;
  distribution: { n: number; suppressed?: boolean; p10?: number; median?: number; p90?: number };
  outlier?: CompareOutlier;
  seedIncluded: boolean;
  healthWarning?: string;
  disclosures: string[];
}

/* ------------------------------- Formatting -------------------------------- */

export const BRAND = "#1d60f1";
export const BRAND_PALE = "#cddcfe";
export const GRID = "#ebedf1";
export const AXIS_INK = "#7f8ea4";
export const MARK_INK = "#4b5a72";
export const AMBER = "#d97706";

export function fmtNum(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: dp });
}

export function label(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .split(/[_\s]+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** "58.5th" reads badly — percentile ranks are shown as "p58.5". */
export function fmtPercentile(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "—";
  return `p${fmtNum(p, 1)}`;
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * The 422 the compute endpoint raises when a metric's inputs are missing.
 * The server's reasons are shown VERBATIM — they name exactly which platform
 * records are absent, and paraphrasing them would blur that.
 */
export interface ComputeFailure {
  metric: string;
  message: string;
  reasons: string[];
  inputs: Record<string, unknown> | null;
}

export function computeFailureFrom(err: unknown, metric: string): ComputeFailure | null {
  if (!(err instanceof ApiClientError) || err.status !== 422) return null;
  const body = err.details as
    | { message?: unknown; details?: { reasons?: unknown; inputs?: unknown } }
    | undefined;
  const rawReasons = body?.details?.reasons;
  const reasons = Array.isArray(rawReasons) ? rawReasons.map((r) => String(r)) : [];
  const inputs =
    body?.details?.inputs && typeof body.details.inputs === "object"
      ? (body.details.inputs as Record<string, unknown>)
      : null;
  return { metric, message: err.message, reasons, inputs };
}

/* ---------------------------------- Hooks ---------------------------------- */

/** The code-resident metric registry — loaded once, shared by every tab. */
export function useMetrics(): {
  metrics: MetricDef[] | null;
  minSampleN: number;
  accessModel: string | null;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<MetricsResponse>("/api/v1/benchmarks/metrics"));
    } catch (err) {
      setError(errorMessage(err, "Failed to load the metric registry"));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return {
    metrics: data?.metrics ?? null,
    minSampleN: data?.minSampleN ?? 5,
    accessModel: data?.accessModel ?? null,
    error,
    reload: () => void load(),
  };
}

/** Company project list — the project picker for snapshots and compare. */
export function useProjects(): {
  projects: ProjectRow[] | null;
  error: string | null;
  reload: () => void;
} {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<ProjectRow>>("/api/v1/projects?page=1&pageSize=200");
      setProjects(res.items);
    } catch (err) {
      setProjects((prev) => prev ?? []);
      setError(errorMessage(err, "Failed to load projects"));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { projects, error, reload: () => void load() };
}

/* ------------------------------- Components -------------------------------- */

export function TabBar({
  tabs,
  active,
  onSelect,
}: {
  tabs: { key: string; label: string }[];
  active: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="mb-5 flex flex-wrap gap-1 border-b border-ink-200">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onSelect(t.key)}
          className={
            active === t.key
              ? "-mb-px border-b-2 border-brand-600 px-3 py-2 text-sm font-medium text-brand-700"
              : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-ink-500 hover:text-ink-800"
          }
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A failed load is not an empty benchmark. Rendering "no data" over a failed
 * request would be the quietest possible lie, so failures are named and
 * offered a retry.
 */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-red-200 bg-red-50/40 px-6 py-12 text-center">
      <p className="text-sm font-medium text-red-800">This view could not be loaded</p>
      <p className="mt-1 max-w-md text-xs text-red-700">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-ink-800 ring-1 ring-ink-200 hover:bg-ink-50"
      >
        Retry
      </button>
    </div>
  );
}

/** The server's seed health warning, amber and VERBATIM (#831 honesty). */
export function HealthWarningBanner({ warning }: { warning: string | null | undefined }) {
  if (!warning) return null;
  return (
    <div
      className="mb-3 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200"
      role="alert"
    >
      <span aria-hidden className="mt-0.5">⚠</span>
      <span>{warning}</span>
    </div>
  );
}

/** seed_only access + the server's upgrade note, shown as sent (#855). */
export function SeedOnlyNote({ note }: { note: string | null | undefined }) {
  if (!note) return null;
  return (
    <div className="mb-3 rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-800 ring-1 ring-brand-100">
      <span className="font-medium">Seed-only access.</span> {note}
    </div>
  );
}

export function AccessBadge({ level }: { level: AccessLevel }) {
  return level === "contributed" ? (
    <Badge tone="green">Contributed access</Badge>
  ) : (
    <Badge tone="amber">Seed-only access</Badge>
  );
}

export function DirectionBadge({ higherIsBetter }: { higherIsBetter: boolean }) {
  return higherIsBetter ? (
    <Badge tone="blue">Higher is better</Badge>
  ) : (
    <Badge tone="violet">Lower is better</Badge>
  );
}

/**
 * Min-n suppression is deliberate privacy protection, NOT a failure: with
 * fewer than minSampleN contributors, aggregates would let one contributor
 * infer another's figure. n itself is still disclosed (#831).
 */
export function SuppressedCard({ n, minSampleN }: { n: number; minSampleN: number }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-ink-300 bg-white px-6 py-12 text-center">
      <p className="text-sm font-semibold text-ink-800">
        Distribution withheld — fewer than {minSampleN} contributors
      </p>
      <p className="mt-2 text-sm text-ink-600">
        This cell holds <span className="font-semibold tabular-nums">n = {n}</span> contributed
        sample{n === 1 ? "" : "s"} (sample size is always disclosed).
      </p>
      <p className="mt-1 max-w-md text-xs text-ink-400">
        Statistics over so few contributors could let one contributor infer another's figure, so
        everything except the sample size is suppressed. This is the anonymization working as
        designed, not an error. The distribution unlocks once the cell reaches {minSampleN}{" "}
        contributed samples.
      </p>
    </div>
  );
}

/** Every disclosure line the server sent, in full. */
export function DisclosureList({ disclosures }: { disclosures: string[] }) {
  if (disclosures.length === 0) return null;
  return (
    <Card>
      <CardBody>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Disclosures</h3>
        <ul className="mt-2 space-y-1.5">
          {disclosures.map((d, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-ink-600">
              <span aria-hidden className="mt-0.5 text-ink-300">▪</span>
              <span>{d}</span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

export function Stat({
  label: statLabel,
  value,
  hint,
  emphasized,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  emphasized?: boolean;
}) {
  return (
    <Card className={emphasized ? "ring-2 ring-brand-200" : undefined}>
      <CardBody className="px-4 py-3">
        <div className="text-xl font-bold tabular-nums text-ink-900">{value}</div>
        <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-ink-400">
          {statLabel}
        </div>
        {hint ? <div className="mt-0.5 text-xs text-ink-400">{hint}</div> : null}
      </CardBody>
    </Card>
  );
}

export function projectLabel(p: ProjectRow): string {
  return p.number ? `${p.number} — ${p.name}` : p.name;
}
