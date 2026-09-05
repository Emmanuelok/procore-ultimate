/**
 * Shared types + small presentational helpers for the assurance surfaces
 * (project workspace, company register) and the AI workspace.
 */
import { useState, type ReactNode } from "react";
import { fetchBlobUrl } from "../../lib/api";

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/* ------------------------------- Domain types ------------------------------ */

export interface SignalRow {
  id: string;
  companyId: string;
  projectId: string | null;
  detector: string;
  severity: string;
  confidence: number;
  title: string;
  explanation: string;
  evidenceRefs: unknown;
  disposition: string;
  reviewerId: string | null;
  reviewerNotes: string | null;
  createdAt: string;
}

export interface AssertionRow {
  id: string;
  kind: string;
  claimantId: string;
  claimantKind: string;
  value: number | null;
  unit: string | null;
  basis: string;
  contractRef: string | null;
  sourceType: string | null;
  sourceId: string | null;
  assertedAt: string;
}

export interface EvidenceRow {
  id: string;
  kind: string;
  source: string;
  contentHash: string;
  fileId: string | null;
  capturedAt: string | null;
  ingestedAt: string;
  independenceScore: number;
  metadata: Record<string, unknown>;
  submittedBy: string;
}

export interface ReconciliationRow {
  id: string;
  assertionId: string;
  evidenceIds: string[];
  method: string;
  result: string;
  variance: number | null;
  variancePercent: number | null;
  confidence: number | null;
  reviewerId: string | null;
  disposition: string | null;
  notes: string | null;
  createdAt?: string;
}

export interface ObligationRow {
  id: string;
  sourceClause: string;
  trigger: string;
  deadline: string | null;
  warnDaysBefore: number | null;
  evidenceRequirement: string | null;
  status: string;
  satisfiedEvidenceId: string | null;
  createdAt: string;
}

export interface LedgerEntryRow {
  seq: number;
  action: string;
  objectType: string;
  objectId: string;
  actorId: string | null;
  payloadHash: string;
  prevHash: string;
  entryHash: string;
  at: string;
}

export interface EntityRow {
  id: string;
  kind: string;
  name: string;
  identifiers: Record<string, string>;
  jurisdiction: string | null;
  screeningStatus: string | null;
  notes: string | null;
  createdAt: string;
}

export interface EntityRelationshipRow {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  kind: string;
  since: string | null;
  source: string | null;
  confidence: number | null;
  createdAt: string;
}

/* --------------------------------- Tones ----------------------------------- */

export function severityTone(severity: string): string {
  if (severity === "critical" || severity === "high") return "red";
  if (severity === "medium") return "amber";
  return "gray";
}

export function dispositionTone(disposition: string | null): string {
  switch (disposition) {
    case "new":
      return "blue";
    case "under_review":
      return "amber";
    case "confirmed":
    case "escalated":
      return "red";
    case "false_positive":
      return "gray";
    case "closed":
      return "green";
    default:
      return "gray";
  }
}

export function reconResultTone(result: string): string {
  switch (result) {
    case "supported":
      return "green";
    case "partially_supported":
      return "amber";
    case "contradicted":
      return "red";
    case "unsupported":
      return "red";
    default:
      return "gray";
  }
}

/* -------------------------------- Formatting ------------------------------- */

export function pct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

export function truncateMiddle(s: string | null | undefined, keep = 8): string {
  if (!s) return "—";
  if (s.length <= keep * 2 + 1) return s;
  return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return null;
  return Math.ceil((d - Date.now()) / 86_400_000);
}

/**
 * Download a file from an API route that requires the bearer token.
 *
 * A plain `<a href="/api/v1/…">` cannot work here: the client puts the access
 * token and the tenant header on every request itself, and a browser
 * navigation carries neither, so the link returned 401 and the pack never
 * arrived (nor was its download logged in the chain-of-custody register).
 */
export async function downloadAuthenticated(path: string, filename: string): Promise<void> {
  const url = await fetchBlobUrl(path);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* -------------------------------- Components ------------------------------- */

export function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: "red" | "amber" | "gray" | "default";
}) {
  const color =
    tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-600" : "text-ink-900";
  return (
    <div className="rounded-lg bg-white p-3 shadow-sm ring-1 ring-ink-100">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</div>
      <div className={`mt-0.5 text-2xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}

/** Thin horizontal meter for 0..1 scores (independence, confidence). */
export function ScoreMeter({ value, tone }: { value: number | null | undefined; tone?: string }) {
  const v = value === null || value === undefined ? 0 : Math.max(0, Math.min(1, value));
  const bar =
    tone === "red"
      ? "bg-red-500"
      : tone === "amber"
        ? "bg-amber-500"
        : v >= 0.7
          ? "bg-emerald-500"
          : v >= 0.4
            ? "bg-amber-500"
            : "bg-ink-300";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-ink-100">
        <div className={`h-full ${bar}`} style={{ width: `${v * 100}%` }} />
      </div>
      <span className="text-xs tabular-nums text-ink-500">{pct(value)}</span>
    </div>
  );
}

export function HashChip({ value }: { value: string | null | undefined }) {
  return (
    <span className="font-mono text-xs text-ink-500" title={value ?? undefined}>
      {truncateMiddle(value)}
    </span>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded border border-ink-200 px-2 py-0.5 text-xs text-ink-600 hover:bg-ink-50"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Amber informational banner (segregation-of-duties 403s etc.). */
export function WarnBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
      {message}
    </div>
  );
}

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
