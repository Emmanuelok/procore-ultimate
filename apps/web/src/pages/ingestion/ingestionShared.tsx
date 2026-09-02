/**
 * Shared types, labels and primitives for the Ingestion workspace (M6 —
 * spec Vol III module map; Domain N; ADR 0014).
 *
 * The view-models mirror the API and the drizzle schema exactly: a run is a
 * staged batch with a retained file hash, staged rows carry their rejection
 * reasons verbatim, and the dataset catalog is the code-resident registry
 * (GET /ingestion/datasets) that drives the mapping UI — a field not listed
 * there cannot be mapped, staged or committed, and this page does not invent
 * any.
 */
import type { ReactNode } from "react";

/* ================================ Types ================================== */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Accept either the platform's ListResponse envelope or a bare array, so a
 * contract drift on the list endpoints degrades to "everything on one page"
 * instead of a blank screen.
 */
export function asList<T>(res: unknown): { items: T[]; total: number } {
  if (Array.isArray(res)) return { items: res as T[], total: res.length };
  if (res && typeof res === "object" && Array.isArray((res as { items?: unknown }).items)) {
    const r = res as { items: T[]; total?: number };
    return { items: r.items, total: typeof r.total === "number" ? r.total : r.items.length };
  }
  return { items: [], total: 0 };
}

/** ingestion_sources row. config NEVER holds credentials (schema contract). */
export interface SourceRow {
  id: string;
  companyId: string;
  projectId: string | null;
  name: string;
  kind: string; // csv | procore | aconex | api_token
  config: Record<string, unknown>;
  isActive: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One entry of the run's capped validation report. */
export interface ReportEntry {
  row?: number;
  field?: string | null;
  code?: string;
  message?: string;
}

/** ingestion_runs row. */
export interface RunRow {
  id: string;
  companyId: string;
  projectId: string | null;
  sourceId: string;
  dataset: string;
  status: string; // staging | validated | committing | committed | failed | discarded
  fileId: string | null;
  fileName: string | null;
  fileSha256: string | null;
  columnMap: Record<string, string>;
  totalRows: number;
  stagedCount: number;
  committedCount: number;
  rejectedCount: number;
  skippedCount: number;
  report: ReportEntry[];
  error: string | null;
  startedBy: string;
  committedBy: string | null;
  committedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** ingested_records row — one staged row awaiting (or after) commit. */
export interface RecordRow {
  id: string;
  runId: string;
  companyId: string;
  rowNumber: number;
  externalId: string | null;
  payload: Record<string, unknown>;
  status: string; // staged | committed | rejected | skipped
  reason: string | null;
  committedRecordId: string | null;
  createdAt: string;
}

/** api_tokens row as listed — never contains the raw token. */
export interface TokenRow {
  id: string;
  companyId: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
}

/** GET /ingestion/datasets — the code-resident registry, verbatim. */
export interface DatasetFieldInfo {
  key: string;
  label: string;
  required: boolean;
  type: string; // string | number | integer | date | time | enum
  enumValues?: string[];
  description?: string;
}

export interface DatasetInfo {
  dataset: string;
  label: string;
  target: string;
  requiresProject: boolean;
  fields: DatasetFieldInfo[];
}

export interface ProjectPick {
  id: string;
  name: string;
  number?: string | null;
}

/**
 * POST /ingestion/runs response: the run plus detected header columns and the
 * first raw rows. Key names are normalised defensively so a rename on the API
 * side degrades to a missing preview, not a broken wizard.
 */
export interface CreateRunResult {
  run: RunRow;
  columns: string[];
  preview: string[][];
}

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

export function normalizeCreateRunResponse(res: unknown): CreateRunResult | null {
  if (!res || typeof res !== "object") return null;
  const obj = res as Record<string, unknown>;
  const runCandidate = pick(obj, ["run"]) ?? obj;
  const run =
    runCandidate && typeof runCandidate === "object" && "id" in (runCandidate as object)
      ? (runCandidate as RunRow)
      : null;
  if (!run) return null;
  const colsRaw = pick(obj, ["columns", "detectedColumns", "headerColumns", "headers"]);
  const columns = Array.isArray(colsRaw) ? colsRaw.map((c) => String(c)) : [];
  const previewRaw = pick(obj, ["preview", "previewRows", "sampleRows", "rows", "firstRows"]);
  const preview = Array.isArray(previewRaw)
    ? (previewRaw as unknown[])
        .filter((r): r is unknown[] => Array.isArray(r))
        .map((r) => r.map((c) => String(c ?? "")))
    : [];
  return { run, columns, preview };
}

/**
 * Find the raw once-only token in a POST /ingestion/tokens response without
 * betting on the key name: the value format (cok_ + 40 hex) is the contract.
 */
export function extractRawToken(res: unknown): string | null {
  const RE = /^cok_[0-9a-f]{40}$/;
  const seen = new Set<unknown>();
  const scan = (v: unknown, depth: number): string | null => {
    if (typeof v === "string") return RE.test(v) ? v : null;
    if (!v || typeof v !== "object" || depth > 2 || seen.has(v)) return null;
    seen.add(v);
    for (const value of Object.values(v as Record<string, unknown>)) {
      const hit = scan(value, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return scan(res, 0);
}

/* =============================== Labels ================================== */

export const RUN_STATUS_LABELS: Record<string, string> = {
  staging: "Staging",
  validated: "Validated",
  committing: "Committing",
  committed: "Committed",
  failed: "Failed",
  discarded: "Discarded",
};

export const RECORD_STATUS_LABELS: Record<string, string> = {
  staged: "Staged",
  committed: "Committed",
  rejected: "Rejected",
  skipped: "Skipped",
};

export const SOURCE_KIND_LABELS: Record<string, string> = {
  csv: "CSV upload",
  procore: "Procore connector",
  aconex: "Aconex connector",
  api_token: "API token (machine push)",
};

export const ISSUE_CODE_LABELS: Record<string, string> = {
  required_missing: "Required missing",
  type_invalid: "Wrong type",
  enum_invalid: "Not an accepted value",
  row_invalid: "Row check failed",
  duplicate_in_run: "Duplicate in run",
  duplicate_committed: "Already committed",
};

/* ================================ Tones ================================== */

export function runTone(status: string): string {
  switch (status) {
    case "committed":
      return "green";
    case "validated":
      return "blue";
    case "staging":
    case "committing":
      return "amber";
    case "failed":
      return "red";
    default:
      return "gray"; // discarded
  }
}

export function recordTone(status: string): string {
  switch (status) {
    case "committed":
      return "green";
    case "staged":
      return "blue";
    case "rejected":
      return "red";
    default:
      return "gray"; // skipped
  }
}

export function kindTone(kind: string): string {
  switch (kind) {
    case "csv":
      return "blue";
    case "api_token":
      return "violet";
    default:
      return "gray"; // procore | aconex — scaffolded, not live
  }
}

/* =============================== Helpers ================================= */

export function fmtInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat().format(value);
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? `${sha.slice(0, 12)}…` : "—";
}

/** Best-effort column auto-map: normalised header name ↔ field key/label. */
export function guessColumnMap(fields: DatasetFieldInfo[], columns: string[]): Record<string, string> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const map: Record<string, string> = {};
  const used = new Set<string>();
  for (const field of fields) {
    const fk = norm(field.key);
    const fl = norm(field.label);
    const hit = columns.find((c) => {
      if (used.has(c)) return false;
      const n = norm(c);
      return n === fk || n === fl;
    });
    if (hit) {
      map[field.key] = hit;
      used.add(hit);
    }
  }
  return map;
}

/* ============================== Components =============================== */

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

/** Right-hand slide-over for record detail (same idiom as ESG/workforce). */
export function Drawer({
  open,
  title,
  onClose,
  children,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink-950/40">
      <div
        className={`h-full overflow-y-auto bg-white p-5 shadow-xl ${wide ? "w-full max-w-3xl" : "w-full max-w-lg"}`}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-ink-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A quiet caveat strip for disclosures that must not be missed. */
export function Caveat({ children, tone = "amber" }: { children: ReactNode; tone?: "amber" | "red" }) {
  return (
    <div
      className={
        tone === "red"
          ? "rounded-md bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-900 ring-1 ring-red-200"
          : "rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200"
      }
    >
      {children}
    </div>
  );
}

/** Count cell used in the run drawer and wizard summaries. */
export function CountStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "green" | "red" | "blue" | "gray";
}) {
  const cls =
    tone === "green"
      ? "text-emerald-700"
      : tone === "red"
        ? "text-red-700"
        : tone === "blue"
          ? "text-brand-700"
          : "text-ink-900";
  return (
    <div className="rounded-md bg-ink-50 px-3 py-2">
      <div className={`text-lg font-semibold tabular-nums ${cls}`}>{fmtInt(value)}</div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{label}</div>
    </div>
  );
}

/**
 * Hand-rolled stacked composition bar: how the run's rows split between
 * committed / staged / rejected / skipped. Pure divs, no chart library.
 */
export function RowSplitBar({ run }: { run: RunRow }) {
  const total = Math.max(run.totalRows, run.stagedCount + run.committedCount + run.rejectedCount + run.skippedCount);
  if (total <= 0) return null;
  const seg = (n: number) => `${(n / total) * 100}%`;
  const parts: { n: number; cls: string; label: string }[] = [
    { n: run.committedCount, cls: "bg-emerald-600", label: "committed" },
    { n: run.stagedCount, cls: "bg-brand-500", label: "staged" },
    { n: run.rejectedCount, cls: "bg-red-500", label: "rejected" },
    { n: run.skippedCount, cls: "bg-ink-300", label: "skipped" },
  ];
  return (
    <div>
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-ink-100"
        role="img"
        aria-label={parts.map((p) => `${p.n} ${p.label}`).join(", ")}
      >
        {parts.map((p) =>
          p.n > 0 ? <div key={p.label} className={p.cls} style={{ width: seg(p.n) }} title={`${fmtInt(p.n)} ${p.label}`} /> : null,
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-500">
        {parts.map((p) => (
          <span key={p.label} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-sm ${p.cls}`} />
            {fmtInt(p.n)} {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The capped validation report, shown wherever a run is inspected. */
export function ReportTable({ report, rejectedCount }: { report: ReportEntry[]; rejectedCount: number }) {
  if (!report || report.length === 0) {
    return <p className="text-xs text-ink-400">No validation findings recorded on this run.</p>;
  }
  return (
    <div>
      <div className="max-h-72 overflow-auto rounded-md ring-1 ring-ink-100">
        <table className="min-w-full divide-y divide-ink-100 text-xs">
          <thead className="sticky top-0 bg-ink-50">
            <tr>
              <th className="px-3 py-1.5 text-left font-semibold uppercase tracking-wide text-ink-500">Row</th>
              <th className="px-3 py-1.5 text-left font-semibold uppercase tracking-wide text-ink-500">Field</th>
              <th className="px-3 py-1.5 text-left font-semibold uppercase tracking-wide text-ink-500">Problem</th>
              <th className="px-3 py-1.5 text-left font-semibold uppercase tracking-wide text-ink-500">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-50 bg-white">
            {report.map((entry, i) => (
              <tr key={i}>
                <td className="px-3 py-1.5 tabular-nums text-ink-800">{entry.row ?? "—"}</td>
                <td className="px-3 py-1.5 font-mono text-[11px] text-ink-600">{entry.field ?? "(row)"}</td>
                <td className="px-3 py-1.5 text-ink-600">
                  {entry.code ? (ISSUE_CODE_LABELS[entry.code] ?? entry.code) : "—"}
                </td>
                <td className="px-3 py-1.5 text-ink-800">{entry.message ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rejectedCount > report.length ? (
        <p className="mt-1.5 text-[11px] text-ink-400">
          The stored report is capped server-side: showing {fmtInt(report.length)} findings for{" "}
          {fmtInt(rejectedCount)} rejected rows. Every rejected row still carries its own reason —
          see the staged records table, filtered to rejected.
        </p>
      ) : null}
    </div>
  );
}

/** Compact payload rendering for a staged row. */
export function PayloadCell({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload ?? {});
  if (entries.length === 0) return <span className="text-ink-300">—</span>;
  const text = entries.map(([k, v]) => `${k}=${String(v)}`).join("  ·  ");
  return (
    <span className="block max-w-md truncate font-mono text-[11px] text-ink-600" title={JSON.stringify(payload, null, 2)}>
      {text}
    </span>
  );
}
