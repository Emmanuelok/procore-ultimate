/**
 * Shared types + helpers for the commercial workspace (spec Vol II Domain B,
 * module M7): BoQ, taking-off, valuations, certificates, variations.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { Card, CardBody } from "../../ui";

/* --------------------------------- Types ---------------------------------- */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface BoqRow {
  id: string;
  name: string;
  method: string;
  status: string;
  currency: string;
  version: number;
  itemCount?: number;
  totalAmount?: number;
}

export interface RateBuildUpComponent {
  kind: string;
  description: string;
  qty: number;
  unit?: string | null;
  rate: number;
  amount?: number;
}

/** One BQ item, flattened out of the tree (or flat) response with its depth. */
export interface FlatBoqItem {
  id: string;
  parentId: string | null;
  depth: number;
  level: string;
  code: string;
  description: string;
  unit: string | null;
  quantity: number | null;
  rate: number | null;
  amount: number | null;
  itemType: string;
  rateBuildUp: RateBuildUpComponent[] | null;
  path?: string;
}

export interface BoqDetail extends BoqRow {
  items: FlatBoqItem[];
  totalAmount?: number;
}

export interface TakeoffLine {
  id: string;
  description: string;
  timesing: number;
  length: number | null;
  width: number | null;
  depth: number | null;
  quantity: number;
  isManual: number;
  drawingSheetId: string | null;
}

export interface ValuationRow {
  id: string;
  boqId: string;
  number: number;
  valuationDate: string;
  basis: string;
  status: string;
  retentionPercent: number;
  workDoneToDate: number;
  materialsOnSite: number;
  materialsOffSite: number;
  retentionHeld: number;
  previousNet: number;
  netDue: number;
  submittedBy?: string | null;
  submittedAt?: string | null;
}

export interface ValuationLine {
  id: string;
  boqItemId: string;
  qtyToDate: number | null;
  percentToDate: number | null;
  amountToDate: number;
  previousAmount: number;
  thisPeriod: number;
  code?: string;
  description?: string;
  unit?: string | null;
  boqQuantity?: number | null;
  rate?: number | null;
  boqAmount?: number | null;
}

export interface ValuationDetail extends ValuationRow {
  lines?: ValuationLine[];
}

export interface CertificateRow {
  id: string;
  valuationId: string;
  number: number;
  certifiedWorkDone: number;
  certifiedMaterials: number;
  retentionHeld: number;
  previousCertified: number;
  netCertified: number;
  varianceFromApplication: number;
  varianceReason: string | null;
  dueDate: string | null;
  status: string;
  issuedBy: string;
  issuedAt: string;
}

export interface VariationRow {
  id: string;
  number: number;
  title: string;
  description?: string | null;
  status: string;
  basis: string;
  clauseRef?: string | null;
  instructionRef?: string | null;
  instructedAt?: string | null;
  costEstimate: number | null;
  agreedValue: number | null;
  timeImpactDays: number | null;
  boqItemRefs?: string[];
}

export interface CommercialSummary {
  boqTotal: number;
  certifiedToDate: number;
  retentionHeld: number;
  variationsAgreed: number;
  variationsPending: number;
  forecastFinal: number;
}

/* ------------------------------- Formatting -------------------------------- */

const moneyFmts = new Map<string, Intl.NumberFormat>();

function moneyFormatter(currency: string, decimals: number): Intl.NumberFormat {
  const key = `${currency}:${decimals}`;
  let f = moneyFmts.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency || "USD",
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
    } catch {
      f = new Intl.NumberFormat(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
    }
    moneyFmts.set(key, f);
  }
  return f;
}

/** Money in the BoQ currency, 2 decimal places. */
export function money(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return moneyFormatter(currency, 2).format(value);
}

/** Money rounded to whole units — for stat cards. */
export function money0(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return moneyFormatter(currency, 0).format(value);
}

/** Measured quantity, up to 3 decimal places. */
export function qty(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function padNo(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(3, "0")}`;
}

export function methodLabel(method: string): string {
  return method === "custom" ? "Custom" : method.toUpperCase();
}

/* ---------------------------------- Tones ---------------------------------- */

export function boqTone(status: string): string {
  if (status === "issued") return "blue";
  if (status === "agreed") return "green";
  return "gray";
}

export function valuationStatusTone(status: string): string {
  if (status === "submitted") return "blue";
  if (status === "certified") return "green";
  if (status === "paid") return "violet";
  return "gray";
}

export function certTone(status: string): string {
  if (status === "issued") return "blue";
  if (status === "paid") return "green";
  return "gray";
}

export function variationTone(status: string): string {
  switch (status) {
    case "proposed":
      return "blue";
    case "instructed":
      return "amber";
    case "valued":
      return "violet";
    case "agreed":
      return "green";
    case "rejected":
      return "red";
    default:
      return "gray";
  }
}

export function itemTypeTone(itemType: string): string {
  if (itemType.startsWith("provisional")) return "amber";
  if (itemType === "prime_cost") return "violet";
  if (itemType === "daywork") return "blue";
  if (itemType === "contingency") return "red";
  return "gray";
}

/* --------------------------------- Numbers --------------------------------- */

/** Parse a numeric input; returns null for blank, undefined for garbage. */
export function parseNum(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/* ------------------------------ Item flattening ---------------------------- */

const LEVEL_DEPTH: Record<string, number> = { bill: 0, section: 1, item: 2 };

/**
 * The BoQ detail may return `items` as a nested tree ({children}) or as a
 * flat list carrying a materialized `path` — flatten either into depth-first
 * order with an explicit depth for indentation.
 */
export function flattenBoqItems(raw: unknown): FlatBoqItem[] {
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const out: FlatBoqItem[] = [];

  const toFlat = (node: Record<string, unknown>, depth: number): FlatBoqItem => ({
    id: String(node["id"] ?? ""),
    parentId: (node["parentId"] as string | null | undefined) ?? null,
    depth,
    level: String(node["level"] ?? "item"),
    code: String(node["code"] ?? ""),
    description: String(node["description"] ?? ""),
    unit: (node["unit"] as string | null | undefined) ?? null,
    quantity: (node["quantity"] as number | null | undefined) ?? null,
    rate: (node["rate"] as number | null | undefined) ?? null,
    amount: (node["amount"] as number | null | undefined) ?? null,
    itemType: String(node["itemType"] ?? "measured"),
    rateBuildUp: Array.isArray(node["rateBuildUp"])
      ? (node["rateBuildUp"] as RateBuildUpComponent[])
      : null,
    path: typeof node["path"] === "string" ? (node["path"] as string) : undefined,
  });

  const hasTree = list.some((n) => Array.isArray(n["children"]));
  if (hasTree) {
    const walk = (nodes: Record<string, unknown>[], depth: number) => {
      for (const n of nodes) {
        out.push(toFlat(n, depth));
        const children = n["children"];
        if (Array.isArray(children)) walk(children as Record<string, unknown>[], depth + 1);
      }
    };
    walk(list, 0);
    return out;
  }

  // flat list — order by materialized path when present, depth from it
  const sorted = [...list].sort((a, b) =>
    String(a["path"] ?? "").localeCompare(String(b["path"] ?? "")),
  );
  for (const n of sorted) {
    const path = typeof n["path"] === "string" ? (n["path"] as string) : "";
    const depth = path
      ? Math.max(0, path.split("/").length - 1)
      : (LEVEL_DEPTH[String(n["level"] ?? "item")] ?? 0);
    out.push(toFlat(n, depth));
  }
  return out;
}

/* --------------------------------- Directory ------------------------------- */

/** Loads the company directory once and exposes an id → display-name lookup. */
export function useCompanyUsers() {
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    api
      .get<ListResponse<{ id?: string; userId?: string; name: string }>>(
        "/api/v1/company/users?pageSize=200",
      )
      .then((res) =>
        setUsers(res.items.map((u) => ({ id: u.id ?? u.userId ?? "", name: u.name }))),
      )
      .catch(() => setUsers([]));
  }, []);
  const byId = useMemo(() => new Map(users.map((u) => [u.id, u.name])), [users]);
  const nameOf = useCallback(
    (id: string | null | undefined) => (id ? (byId.get(id) ?? "Unknown user") : "—"),
    [byId],
  );
  return { users, nameOf };
}

/* ---------------------------------- Layout --------------------------------- */

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

export function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "emphasis";
}) {
  return (
    <Card>
      <CardBody className="py-3">
        <div className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</div>
        <div
          className={
            tone === "emphasis"
              ? "mt-0.5 text-xl font-semibold text-brand-700 tabular-nums"
              : "mt-0.5 text-xl font-semibold text-ink-900 tabular-nums"
          }
        >
          {value}
        </div>
        {hint ? <div className="mt-0.5 text-xs text-ink-400">{hint}</div> : null}
      </CardBody>
    </Card>
  );
}

/** Right-hand slide-over panel for record detail (BQ item, variation). */
export function Drawer({
  open,
  title,
  onClose,
  children,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink-950/40">
      <div
        className={`h-full overflow-y-auto bg-white p-5 shadow-xl ${wide ? "w-full max-w-2xl" : "w-full max-w-lg"}`}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
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
