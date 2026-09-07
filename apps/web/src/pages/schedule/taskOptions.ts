/**
 * Option lists for the per-activity editor (#360 responsible/location, #363-366
 * calendars, #370 cost basis).
 *
 * The schedule API validates every one of these ids against a real record —
 * responsibleId against the company's memberships, locationId against the
 * project's locations, calendarId against the project's work calendars and
 * budgetLineItemId against the project's budget lines — so the UI must offer
 * the real records rather than a free-text box. Each list loads on its own and
 * fails on its own: a missing budget never stops a planner assigning a
 * location, and a list that is empty says WHY it is empty instead of showing an
 * empty dropdown.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";

export interface OptionItem {
  id: string;
  label: string;
  hint?: string;
}

export interface OptionList {
  items: OptionItem[];
  loading: boolean;
  /** why the list is empty or could not be loaded — rendered under the field */
  reason: string | null;
}

const EMPTY: OptionList = { items: [], loading: false, reason: null };

interface CompanyUserRow {
  id: string;
  name?: string | null;
  email?: string | null;
}
interface LocationRow {
  id: string;
  name: string;
  path?: string | null;
}
interface CalendarLite {
  id: string;
  name: string;
  isDefault: number;
  scheduleId: string | null;
  hoursPerDay: number;
}
interface BudgetLite {
  id: string;
  name?: string | null;
  isActive: number;
  currency: string;
}
interface BudgetLineLite {
  id: string;
  costCode: string;
  description: string;
  revisedBudget: number;
}

function useList<T>(
  load: (signal: AbortSignal) => Promise<{ items: T[]; reason?: string | null }>,
  map: (row: T) => OptionItem,
  emptyReason: string,
  enabled: boolean,
  deps: unknown[],
): OptionList {
  const [state, setState] = useState<OptionList>(EMPTY);
  useEffect(() => {
    if (!enabled) {
      setState(EMPTY);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setState({ items: [], loading: true, reason: null });
    load(controller.signal)
      .then((res) => {
        if (cancelled) return;
        const items = (res.items ?? []).map(map);
        setState({
          items,
          loading: false,
          reason: res.reason ?? (items.length === 0 ? emptyReason : null),
        });
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof Error && err.name === "AbortError")) return;
        setState({
          items: [],
          loading: false,
          reason: err instanceof Error ? err.message : "This list could not be loaded",
        });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export interface TaskOptions {
  users: OptionList;
  locations: OptionList;
  calendars: OptionList;
  budgetLines: OptionList;
  /** currency of the active budget the lines came from, for the cost fields */
  budgetCurrency: string | null;
}

/**
 * @param base      `/api/v1/projects/:projectId`
 * @param projectId the project the page is scoped to
 * @param version   bumped by the page after a mutation so lists refresh
 */
export function useTaskOptions(
  base: string,
  projectId: string | undefined,
  version: number,
): TaskOptions {
  const [budgetCurrency, setBudgetCurrency] = useState<string | null>(null);

  const users = useList<CompanyUserRow>(
    (signal) =>
      api
        .get<{ items: CompanyUserRow[] }>("/api/v1/company/users?page=1&pageSize=200", { signal })
        .then((res) => ({ items: res.items ?? [] })),
    (u) => ({ id: u.id, label: u.name || u.email || u.id }),
    "No users are on this company",
    Boolean(projectId),
    [projectId],
  );

  const locations = useList<LocationRow>(
    (signal) =>
      api
        .get<{ items: LocationRow[] }>(`/api/v1/projects/${projectId}/locations`, { signal })
        .then((res) => ({ items: res.items ?? [] })),
    (l) => ({ id: l.id, label: l.path || l.name }),
    "This project has no locations yet — add them in the project settings",
    Boolean(projectId),
    [projectId],
  );

  const calendars = useList<CalendarLite>(
    (signal) =>
      api
        .get<{ items: CalendarLite[] }>(`${base}/schedule-calendars`, { signal })
        .then((res) => ({ items: res.items ?? [] })),
    (c) => ({
      id: c.id,
      label: `${c.name}${c.isDefault === 1 ? " (default)" : ""}`,
      hint: `${c.hoursPerDay} h/day`,
    }),
    "No work calendars exist yet — create one in the Calendars panel",
    Boolean(projectId),
    [projectId, base, version],
  );

  const budgetLines = useList<BudgetLineLite>(
    async (signal) => {
      const budgets = await api.get<{ items: BudgetLite[] }>(
        `${base}/budgets?pageSize=50`,
        { signal },
      );
      const active = (budgets.items ?? []).find((b) => b.isActive === 1) ?? budgets.items?.[0];
      if (!active) {
        setBudgetCurrency(null);
        return { items: [], reason: "This project has no budget — activities cannot be mapped to a budget line yet" };
      }
      setBudgetCurrency(active.currency ?? null);
      const lines = await api.get<{ items: BudgetLineLite[] }>(
        `/api/v1/budgets/${active.id}/lines?page=1&pageSize=200&sort=costCode`,
        { signal },
      );
      return { items: lines.items ?? [] };
    },
    (l) => ({ id: l.id, label: `${l.costCode} · ${l.description}` }),
    "The active budget has no lines yet",
    Boolean(projectId),
    [projectId, base, version],
  );

  return useMemo(
    () => ({ users, locations, calendars, budgetLines, budgetCurrency }),
    [users, locations, calendars, budgetLines, budgetCurrency],
  );
}
