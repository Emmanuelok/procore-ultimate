/**
 * Shared helpers for the field-tool pages (RFIs, submittals, daily logs,
 * punch, photos). Kept as a sibling of the RFI pages so every field page can
 * import it without duplicating the company-user lookup.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";

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

/** Today's date as an ISO date string (YYYY-MM-DD, local-agnostic UTC). */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Loads the company directory once and exposes an id → display-name lookup. */
export function useCompanyUsers() {
  const [users, setUsers] = useState<CompanyUser[]>([]);
  useEffect(() => {
    api
      .get<ListResponse<{ id?: string; userId?: string; name: string; email: string }>>(
        "/api/v1/company/users?pageSize=200",
      )
      .then((res) =>
        setUsers(
          res.items.map((u) => ({ id: u.id ?? u.userId ?? "", name: u.name, email: u.email })),
        ),
      )
      .catch(() => setUsers([]));
  }, []);
  const byId = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const nameOf = useCallback(
    (id: string | null | undefined) => (id ? (byId.get(id)?.name ?? "Unknown user") : "—"),
    [byId],
  );
  return { users, nameOf };
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
