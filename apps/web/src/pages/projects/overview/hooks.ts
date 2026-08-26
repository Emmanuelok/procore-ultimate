/**
 * Every request the project command centre makes, in one place.
 *
 * Each panel owns its own request and its own failure. A budget that 403s
 * because the user has no budget permission must not blank the RFI panel, so
 * nothing here is fetched in a single all-or-nothing waterfall — the page
 * renders whatever landed and says what did not.
 *
 * The project record, the cross-tool counters, the open signals and the
 * prime-contract position are NOT here: the workspace shell already holds
 * them and publishes them through `useProjectWorkspace()`.
 */
import {
  useDerivedResource,
  useResource,
  type Loadable,
  type Paginated,
} from "../../../layouts/project/lib";
import type {
  BudgetRow,
  BudgetSummary,
  CashPosition,
  ChangeLog,
  CommitmentList,
  InvoiceRow,
  PunchAnalytics,
  PunchRow,
  RfiAnalytics,
  RfiRow,
  RiskRow,
  ScheduleDetail,
  ScheduleRow,
  SubmittalRow,
} from "./types";

const base = (projectId: string) => `/api/v1/projects/${projectId}`;

/* -------------------------------------------------------------- financials */

/**
 * The buy side. `totalsByCurrency` is computed by the API over the WHOLE
 * filtered set rather than the page, so a small page size still returns
 * complete totals — and the register rows double as activity-feed entries.
 */
export function useCommitments(projectId: string): Loadable<CommitmentList> {
  return useResource<CommitmentList>(
    `${base(projectId)}/commitments?page=1&pageSize=8&sort=updatedAt&dir=desc`,
  );
}

export function useBudgets(projectId: string): Loadable<Paginated<BudgetRow>> {
  return useResource<Paginated<BudgetRow>>(`${base(projectId)}/budgets?page=1&pageSize=25`);
}

/** The active budget, or the newest one when none is marked active. */
export function activeBudget(list: Paginated<BudgetRow> | null): BudgetRow | null {
  if (!list || list.items.length === 0) return null;
  return list.items.find((b) => b.isActive === 1) ?? list.items[0] ?? null;
}

export function useBudgetSummary(budgets: Loadable<Paginated<BudgetRow>>): Loadable<BudgetSummary> {
  return useDerivedResource<Paginated<BudgetRow>, BudgetSummary>(budgets, (list) => {
    const budget = activeBudget(list);
    return budget ? `/api/v1/budgets/${budget.id}/summary` : null;
  });
}

/**
 * Owner applications, newest first. `totalCompletedAndStored` on each is the
 * cumulative earned value at that billing date, which is exactly the actual
 * curve of an S-curve — no client-side accumulation, no invented periods.
 */
export function useOwnerInvoices(projectId: string): Loadable<Paginated<InvoiceRow>> {
  return useResource<Paginated<InvoiceRow>>(
    `${base(projectId)}/invoices?kind=owner_billing&page=1&pageSize=200`,
  );
}

export function useCashPosition(projectId: string): Loadable<CashPosition> {
  return useResource<CashPosition>(`${base(projectId)}/invoicing/cash-position`);
}

export function useChangeLog(projectId: string): Loadable<ChangeLog> {
  return useResource<ChangeLog>(`${base(projectId)}/change-log`);
}

/* ------------------------------------------------------------------- field */

export function useRfiAnalytics(projectId: string): Loadable<RfiAnalytics> {
  return useResource<RfiAnalytics>(`${base(projectId)}/rfis/analytics`);
}

export function usePunchAnalytics(projectId: string): Loadable<PunchAnalytics> {
  return useResource<PunchAnalytics>(`${base(projectId)}/punch/analytics`);
}

export function useOpenRfis(projectId: string): Loadable<Paginated<RfiRow>> {
  return useResource<Paginated<RfiRow>>(
    `${base(projectId)}/rfis?status=open&page=1&pageSize=25`,
  );
}

export function useSubmittals(projectId: string): Loadable<Paginated<SubmittalRow>> {
  return useResource<Paginated<SubmittalRow>>(`${base(projectId)}/submittals?page=1&pageSize=50`);
}

export function useOpenPunch(projectId: string): Loadable<Paginated<PunchRow>> {
  return useResource<Paginated<PunchRow>>(
    `${base(projectId)}/punch?status=open&page=1&pageSize=25`,
  );
}

/* ---------------------------------------------------------------- schedule */

export function useSchedules(projectId: string): Loadable<Paginated<ScheduleRow>> {
  return useResource<Paginated<ScheduleRow>>(`${base(projectId)}/schedules?page=1&pageSize=25`);
}

export function activeSchedule(list: Paginated<ScheduleRow> | null): ScheduleRow | null {
  if (!list || list.items.length === 0) return null;
  return list.items.find((s) => s.isActive === 1) ?? list.items[0] ?? null;
}

export function useScheduleDetail(
  projectId: string,
  schedules: Loadable<Paginated<ScheduleRow>>,
): Loadable<ScheduleDetail> {
  return useDerivedResource<Paginated<ScheduleRow>, ScheduleDetail>(schedules, (list) => {
    const schedule = activeSchedule(list);
    return schedule ? `${base(projectId)}/schedules/${schedule.id}` : null;
  });
}

/* -------------------------------------------------------------------- risk */

export function useRisks(projectId: string): Loadable<Paginated<RiskRow>> {
  return useResource<Paginated<RiskRow>>(`${base(projectId)}/risks?page=1&pageSize=50`);
}
