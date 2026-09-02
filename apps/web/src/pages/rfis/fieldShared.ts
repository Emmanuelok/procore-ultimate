/**
 * Shared helpers for the field-tool pages (RFIs, submittals, daily logs,
 * punch, observations, photos). Kept as a sibling of the RFI pages so every
 * field page can import it without duplicating the company-user lookup.
 *
 * House rules these helpers enforce:
 *  - a figure the API did not return renders "—" with its reason, never 0;
 *  - every panel loads, fails and empties on its own (`useFieldResource`);
 *  - permission-bearing buttons are driven by the API's `permissions` block,
 *    so a user never sees an action that will 403.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiClientError, tokenStore } from "../../lib/api";
import { useAuth } from "../../lib/auth";

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CompanyUser {
  id: string;
  name: string;
  email: string;
}

export const DASH = "—";

/** Today's date as an ISO date string (YYYY-MM-DD, local-agnostic UTC). */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Query-string builder that drops empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function errorMessage(err: unknown, fallback = "The request failed."): string {
  if (err instanceof ApiClientError) {
    const details = err.details as { details?: { issues?: Array<{ path?: unknown[]; message?: string }> } } | undefined;
    const issues = details?.details?.issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return issues
        .slice(0, 3)
        .map((i) => `${Array.isArray(i.path) && i.path.length > 0 ? `${i.path.join(".")}: ` : ""}${i.message ?? "invalid"}`)
        .join("; ");
    }
    return err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

/** Loads the company directory once and exposes an id → display-name lookup. */
export function useCompanyUsers() {
  const [users, setUsers] = useState<CompanyUser[]>([]);
  useEffect(() => {
    api
      .get<ListResponse<{ id?: string; userId?: string; name: string; email: string }>>("/api/v1/company/users?pageSize=200")
      .then((res) => setUsers(res.items.map((u) => ({ id: u.id ?? u.userId ?? "", name: u.name, email: u.email }))))
      .catch(() => setUsers([]));
  }, []);
  const byId = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const nameOf = useCallback(
    (id: string | null | undefined) => (id ? (byId.get(id)?.name ?? "Unknown user") : DASH),
    [byId],
  );
  return { users, nameOf };
}

/** The signed-in user and their company role — for permission-aware buttons. */
export function useMe(): { id: string | null; role: string | null; isCompanyAdmin: boolean } {
  const { user, company } = useAuth();
  const role = company?.role ?? null;
  return { id: user?.id ?? null, role, isCompanyAdmin: role === "owner" || role === "admin" };
}

export interface LocationRow {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
}

/** Project locations with a "Building / Level / Room" label lookup. */
export function useLocations(projectId: string | undefined) {
  const [items, setItems] = useState<LocationRow[]>([]);
  useEffect(() => {
    if (!projectId) return;
    api
      .get<{ items: LocationRow[] }>(`/api/v1/projects/${projectId}/locations`)
      .then((res) => setItems(res.items))
      .catch(() => setItems([]));
  }, [projectId]);
  const byId = useMemo(() => new Map(items.map((l) => [l.id, l])), [items]);
  const labelOf = useCallback(
    (id: string | null | undefined): string => {
      if (!id) return DASH;
      const names: string[] = [];
      let cursor = byId.get(id);
      let guard = 0;
      while (cursor && guard < 32) {
        names.unshift(cursor.name);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
        guard += 1;
      }
      return names.length > 0 ? names.join(" / ") : "Unknown location";
    },
    [byId],
  );
  return { items, labelOf };
}

export interface Loadable<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** One GET, reloadable, aborted on unmount; `null` path = idle. */
export function useFieldResource<T>(path: string | null, deps: unknown[] = []): Loadable<T> {
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
        setError(errorMessage(err));
        setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}

/** Authenticated fetch of a binary/HTML endpoint as a Blob. */
export async function fetchBlob(path: string, init: { method?: string; body?: unknown } = {}): Promise<Blob> {
  const headers: Record<string, string> = {};
  const access = tokenStore.access;
  if (access) headers["authorization"] = `Bearer ${access}`;
  const companyId = tokenStore.companyId;
  if (companyId) headers["x-company-id"] = companyId;
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(path, { method: init.method ?? "GET", headers, body });
  if (!res.ok) throw new ApiClientError(res.status, `Request failed (${res.status})`);
  return res.blob();
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function openBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function rfiLabel(number: number): string {
  return `RFI-${String(number).padStart(3, "0")}`;
}

export function submittalLabel(number: number, revision: number): string {
  const base = String(number).padStart(3, "0");
  return revision > 0 ? `${base}-R${revision}` : base;
}

export function impactTone(value: string): string {
  if (value === "yes") return "red";
  if (value === "no") return "green";
  return "gray";
}

export function priorityTone(priority: string): string {
  if (priority === "high") return "red";
  if (priority === "medium") return "amber";
  return "gray";
}

export function riskTone(risk: string | null | undefined): string {
  if (risk === "late" || risk === "required_on_site_passed") return "red";
  if (risk === "at_risk") return "amber";
  return "gray";
}

export const AGEING_BUCKETS = ["0-7", "8-14", "15-30", "30+"] as const;

export interface AgeingReport {
  groupBy: string;
  asOf: string;
  total: number;
  buckets: Record<string, number>;
  groups: Array<{ key: string; total: number; buckets: Record<string, number> }>;
  items: Array<{ id: string; number: number; subject?: string; title?: string; ageDays: number; daysOverdue: number; group: string; status?: string }>;
  basis?: string;
}

export function bucketTone(bucket: string): string {
  if (bucket === "30+") return "red";
  if (bucket === "15-30") return "amber";
  if (bucket === "8-14") return "blue";
  return "gray";
}

/** "3 days", "1 day", "today" */
export function daysLabel(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  if (n === 0) return "today";
  return `${n} day${n === 1 ? "" : "s"}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
