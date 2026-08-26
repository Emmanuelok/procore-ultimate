/**
 * PROJECT COMMAND CENTRE — /projects/:projectId
 *
 * The one screen a project director opens first. Seven KPIs, the progress
 * curve, the contract bridge, the milestone strip, the cost and cash position,
 * the change pipeline, the open items by tool, the risk and signal registers,
 * and what has moved since yesterday.
 *
 * ---------------------------------------------------------------------------
 * THREE RULES, VISIBLE EVERYWHERE ON THIS PAGE
 *
 *  1. NO FABRICATED NUMBERS. Every figure is read from an endpoint. Where a
 *     figure has no source, the tile or panel renders its empty state WITH THE
 *     REASON. Where the API returns `{ value: null, reasons: [...] }` the
 *     reasons are printed verbatim next to "not available". Nothing missing is
 *     ever drawn as 0 — 0 is a claim about the project, "—" is a claim about
 *     our records, and they are different sentences.
 *
 *  2. MONEY IS NEVER SUMMED ACROSS CURRENCIES. When this project holds money
 *     in more than one currency the page puts a currency switch at the top and
 *     every money panel reports that currency alone, saying where the others
 *     are. There is no exchange rate on the record and inventing one would be
 *     a fabrication.
 *
 *  3. EVERY PANEL FAILS ALONE. Each block owns its request, its skeleton and
 *     its error. A budget the user cannot read must not blank the RFI list.
 */
import { useMemo, useState } from "react";
import { Alert, Button, SegmentedControl } from "../../ui";
import { IconRefresh } from "../../ui/icons";
import { useProjectWorkspace } from "../../layouts/project/context";
import ActivityPanel from "./overview/ActivityPanel";
import ChangePanel from "./overview/ChangePanel";
import { ContractMovement, ProgressCurve } from "./overview/CostCharts";
import { CashPositionPanel, CostPositionPanel } from "./overview/FinancialPanels";
import KpiRow from "./overview/KpiRow";
import MilestoneStrip from "./overview/MilestoneStrip";
import { OpenPunchPanel, OpenRfisPanel, OpenSubmittalsPanel } from "./overview/OpenItems";
import SignalsPanel from "./overview/SignalsPanel";
import {
  useBudgetSummary,
  useBudgets,
  useCashPosition,
  useChangeLog,
  useCommitments,
  useOpenPunch,
  useOpenRfis,
  useOwnerInvoices,
  usePunchAnalytics,
  useRfiAnalytics,
  useRisks,
  useScheduleDetail,
  useSchedules,
  useSubmittals,
} from "./overview/hooks";

export default function ProjectOverviewPage() {
  const workspace = useProjectWorkspace();
  const { projectId, project, contracts, summary, reloadProject } = workspace;

  /* ------------------------------------------------------------- requests */
  const commitments = useCommitments(projectId);
  const budgets = useBudgets(projectId);
  const budgetSummary = useBudgetSummary(budgets);
  const invoices = useOwnerInvoices(projectId);
  const cash = useCashPosition(projectId);
  const changeLog = useChangeLog(projectId);
  const rfiAnalytics = useRfiAnalytics(projectId);
  const punchAnalytics = usePunchAnalytics(projectId);
  const rfis = useOpenRfis(projectId);
  const submittals = useSubmittals(projectId);
  const punch = useOpenPunch(projectId);
  const schedules = useSchedules(projectId);
  const scheduleDetail = useScheduleDetail(projectId, schedules);
  const risks = useRisks(projectId);

  /* ------------------------------------------------------------ currency */
  const currencies = useMemo(() => {
    const found = new Set<string>();
    for (const group of contracts.data?.groups ?? []) found.add(group.currency);
    for (const totals of commitments.data?.totalsByCurrency ?? []) found.add(totals.currency);
    for (const bucket of cash.data?.byCurrency ?? []) found.add(bucket.currency);
    for (const code of changeLog.data?.currencies ?? []) found.add(code);
    if (budgetSummary.data) found.add(budgetSummary.data.currency);
    if (project.data?.currency) found.add(project.data.currency);
    return [...found].sort();
  }, [
    contracts.data,
    commitments.data,
    cash.data,
    changeLog.data,
    budgetSummary.data,
    project.data,
  ]);

  const [chosen, setChosen] = useState<string | null>(null);
  const preferred = project.data?.currency ?? null;
  const currency =
    (chosen && currencies.includes(chosen) ? chosen : null) ??
    (preferred && currencies.includes(preferred) ? preferred : null) ??
    currencies[0] ??
    preferred ??
    "USD";

  const contractGroup = contracts.data?.groups.find((g) => g.currency === currency) ?? null;
  const contractCurrencies = (contracts.data?.groups ?? []).map((g) => g.currency);

  const refreshAll = () => {
    reloadProject();
    commitments.reload();
    budgets.reload();
    invoices.reload();
    cash.reload();
    changeLog.reload();
    rfiAnalytics.reload();
    punchAnalytics.reload();
    rfis.reload();
    submittals.reload();
    punch.reload();
    schedules.reload();
    risks.reload();
  };

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------ page toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="text-sm font-semibold text-content">Command centre</h2>
          {currencies.length > 1 ? (
            <SegmentedControl
              size="xs"
              aria-label="Reporting currency"
              value={currency}
              onChange={setChosen}
              options={currencies.map((code) => ({ value: code, label: code }))}
            />
          ) : (
            <span className="rounded border border-border bg-surface-sunken px-1.5 py-0.5 font-mono text-2xs text-content-muted">
              {currency}
            </span>
          )}
        </div>
        <Button variant="ghost" size="sm" leadingIcon={IconRefresh} onClick={refreshAll}>
          Refresh
        </Button>
      </div>

      {currencies.length > 1 ? (
        <Alert tone="info" size="sm" title={`This project holds money in ${currencies.length} currencies`}>
          {currencies.join(", ")} all appear on this project&rsquo;s records. Every money figure
          below is reported in <strong>{currency}</strong> alone and none of them is added across
          currencies — there is no exchange rate on the record, and inventing one would make every
          total here a fabrication. Switch currency above to read the others.
        </Alert>
      ) : null}

      {/* ------------------------------------------------------------- KPIs */}
      <KpiRow
        currency={currency}
        commitments={commitments}
        budgets={budgets}
        budgetSummary={budgetSummary}
        rfiAnalytics={rfiAnalytics}
        punchAnalytics={punchAnalytics}
      />

      {/* ----------------------------------------------------------- charts */}
      <div className="grid gap-4 xl:grid-cols-5">
        <ProgressCurve
          className="xl:col-span-3"
          currency={currency}
          invoices={invoices}
          contractGroup={contractGroup}
        />
        <ContractMovement
          className="xl:col-span-2"
          currency={currency}
          contractGroup={contractGroup}
          loading={contracts.loading && !contracts.data}
          error={contracts.error}
          availableCurrencies={contractCurrencies}
        />
      </div>

      {/* -------------------------------------------------------- milestones */}
      <MilestoneStrip schedules={schedules} detail={scheduleDetail} />

      {/* ------------------------------------------------------------- money */}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <CostPositionPanel currency={currency} budgets={budgets} summary={budgetSummary} />
        <CashPositionPanel currency={currency} cash={cash} />
        <ChangePanel
          className="lg:col-span-2 xl:col-span-1"
          currency={currency}
          changeLog={changeLog}
        />
      </div>

      {/* --------------------------------------------------------- open items */}
      <div className="grid gap-4 lg:grid-cols-3">
        <OpenRfisPanel
          rfis={rfis}
          open={rfiAnalytics.data?.open ?? summary.data?.rfisOpen ?? null}
          overdue={rfiAnalytics.data?.overdue ?? null}
        />
        <OpenSubmittalsPanel
          submittals={submittals}
          open={summary.data?.submittalsOpen ?? null}
        />
        <OpenPunchPanel
          punch={punch}
          open={summary.data?.punchOpen ?? null}
          overdue={punchAnalytics.data?.overdue ?? null}
        />
      </div>

      {/* -------------------------------------------------- signals + activity */}
      <div className="grid gap-4 lg:grid-cols-2">
        <SignalsPanel risks={risks} />
        <ActivityPanel
          rfis={rfis}
          submittals={submittals}
          punch={punch}
          commitments={commitments}
          invoices={invoices}
        />
      </div>
    </div>
  );
}
