/**
 * TIMECARDS, CREWS & T&M TICKETS — module M24. Routed at
 * /projects/:projectId/timecards.
 *
 * Labour is the only major cost on a construction project that is claimed,
 * approved and paid before anybody independently checks it. So this workspace
 * is not a timesheet screen with a total at the bottom; it is three
 * reconciliations with a timesheet attached, and the tabs are in that order:
 *
 *   Timecards      the claim, with the rule that split its hours named on
 *                  every row
 *   Reconciliation claimed against PRESENT — the turnstile stream, which is
 *                  independent evidence, and its refusal to conclude anything
 *                  where no record exists
 *   Cost report    hours against the budget lines they were coded to, and the
 *                  hours that reach no report at all
 *   Batches        the crew's week, which is how approval actually happens
 *   Crews          the pay rule, and the dated membership that keeps "who was
 *                  in this gang that day" answerable
 *   T&M tickets    our hours against THEIR signature — signed, signed under
 *                  protest, or refused, all three recorded distinctly
 *
 * WORKERS ARE NOT DUPLICATED HERE. Every worker referenced belongs to the
 * workforce register, which already carries identity verification, induction,
 * employer and agreed rate. This workspace adds crews, hours and cost coding
 * on top of it and creates no second person list.
 */
import { useCallback, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Alert, Badge, Button, PageHeader, Tabs } from "../../ui";
import { IconWorkforce } from "../../ui/icons";
import BatchesTab from "./BatchesTab";
import CardsTab from "./CardsTab";
import CostReportTab from "./CostReportTab";
import CrewsTab from "./CrewsTab";
import ReconcileTab from "./ReconcileTab";
import TicketDrawer from "./TicketDrawer";
import TicketsTab from "./TicketsTab";
import TimecardDrawer from "./TimecardDrawer";
import {
  BatchCreateModal,
  TicketCreateModal,
  TicketSourceModal,
  TimecardCreateModal,
  type WorkerOption,
} from "./TimecardForms";
import {
  hoursText,
  shiftDays,
  today,
  useBatchDetail,
  useBatches,
  useCostCodes,
  useCostReport,
  useCompanyUsers,
  useCrewDetail,
  useCrews,
  useReconciliation,
  useTicketDetail,
  useTickets,
  useTimecardDetail,
  useResource,
  useTimecards,
  type CardFilters,
} from "./timecardsShared";

type TabKey = "cards" | "reconcile" | "cost" | "batches" | "crews" | "tickets";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "cards", label: "Timecards" },
  { value: "reconcile", label: "Reconciliation" },
  { value: "cost", label: "Cost report" },
  { value: "batches", label: "Batches" },
  { value: "crews", label: "Crews" },
  { value: "tickets", label: "T&M tickets" },
];

const isTabKey = (value: string | null): value is TabKey =>
  value !== null && TABS.some((tab) => tab.value === value);

export default function TimecardsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tab, setTab] = useState<TabKey>(() => {
    const requested = searchParams.get("tab");
    return isTabKey(requested) ? requested : "cards";
  });
  const [openCard, setOpenCard] = useState<string | null>(() => searchParams.get("card"));
  const [openTicket, setOpenTicket] = useState<string | null>(() => searchParams.get("ticket"));
  const [crewId, setCrewId] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [crewDate, setCrewDate] = useState<string>(() => today());
  const [windowDays, setWindowDays] = useState(30);
  const [reconcileDays, setReconcileDays] = useState(30);
  const [costDays, setCostDays] = useState(30);

  const to = useMemo(() => today(), []);
  const cardsFrom = useMemo(() => shiftDays(to, -(windowDays - 1)), [to, windowDays]);
  const reconcileFrom = useMemo(() => shiftDays(to, -(reconcileDays - 1)), [to, reconcileDays]);
  const costFrom = useMemo(() => shiftDays(to, -(costDays - 1)), [to, costDays]);

  const [filters, setFilters] = useState<Omit<CardFilters, "from" | "to">>({
    status: "",
    crewId: "",
    exceptions: false,
    unallocated: false,
  });
  const cardFilters = useMemo<CardFilters>(
    () => ({ ...filters, from: cardsFrom, to }),
    [filters, cardsFrom, to],
  );

  const users = useCompanyUsers();
  /** which write form is open */
  const [form, setForm] = useState<"card" | "batch" | "ticket" | "source" | null>(null);
  const crews = useCrews(projectId);
  const cards = useTimecards(projectId, cardFilters, tab === "cards");
  const reconciliation = useReconciliation(projectId, reconcileFrom, to, tab === "reconcile");
  const costReport = useCostReport(projectId, costFrom, to, tab === "cost");
  const batches = useBatches(projectId, tab === "batches");
  const batchDetail = useBatchDetail(projectId, batchId);
  const crewDetail = useCrewDetail(projectId, crewId, crewDate);
  const tickets = useTickets(projectId, tab === "tickets");
  const ticketDetail = useTicketDetail(projectId, openTicket);
  const cardDetail = useTimecardDetail(projectId, openCard);
  const costCodes = useCostCodes(projectId, openCard !== null || form !== null);
  /** the worker register this module reads from and never duplicates */
  const workerList = useResource<{ items: WorkerOption[] }>(
    form === "card" && projectId
      ? `/api/v1/projects/${projectId}/workers?page=1&pageSize=500&status=active`
      : null,
  );

  const refresh = useCallback(() => {
    cards.reload();
    batches.reload();
    batchDetail.reload();
    costReport.reload();
    reconciliation.reload();
  }, [cards, batches, batchDetail, costReport, reconciliation]);

  const selectTab = useCallback(
    (next: TabKey) => {
      setTab(next);
      const params = new URLSearchParams(searchParams);
      params.set("tab", next);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const openCardDrawer = useCallback(
    (timecardId: string | null) => {
      setOpenCard(timecardId);
      const params = new URLSearchParams(searchParams);
      if (timecardId) params.set("card", timecardId);
      else params.delete("card");
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const openTicketDrawer = useCallback(
    (ticketId: string | null) => {
      setOpenTicket(ticketId);
      const params = new URLSearchParams(searchParams);
      if (ticketId) params.set("ticket", ticketId);
      else params.delete("ticket");
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  /** Any write anywhere refreshes every list that could have moved. */
  const refreshAll = useCallback(() => {
    cards.reload();
    batches.reload();
    if (batchId) batchDetail.reload();
    if (tab === "reconcile") reconciliation.reload();
    if (tab === "cost") costReport.reload();
    if (tab === "tickets") tickets.reload();
  }, [cards, batches, batchId, batchDetail, tab, reconciliation, costReport, tickets]);

  if (!projectId) {
    return (
      <Alert tone="danger" title="No project in the route">
        This workspace is project-scoped. Hours are claimed against a project, reconciled against
        that project&rsquo;s access records and coded to that project&rsquo;s budget lines — none of
        which means anything without knowing which project.
      </Alert>
    );
  }

  const cardRows = cards.data?.items ?? [];
  const unexplained = cardRows.filter(
    (row) =>
      row.varianceHours !== null &&
      row.varianceHours > (row.detail?.variance?.toleranceHours ?? 0.5) &&
      !(row.varianceExplanation ?? "").trim(),
  ).length;
  const uncoded = cardRows.filter((row) => !row.isAllocated).length;
  const overclaims = reconciliation.data?.overclaimPatterns ?? 0;
  const unsignedTickets = (tickets.data?.items ?? []).filter(
    (ticket) => !ticket.signature.hasClientResponse,
  ).length;
  const uncodedHours = costReport.data?.totals.uncodedHours ?? 0;

  return (
    <div>
      <PageHeader
        icon={IconWorkforce}
        title="Timecards, crews & T&amp;M"
        subtitle="Labour is the only major cost claimed, approved and paid before anybody independently checks it. This workspace is three reconciliations with a timesheet attached."
        meta={
          <span className="flex flex-wrap items-center gap-2">
            {cards.data ? (
              <span>
                {cards.data.total} card{cards.data.total === 1 ? "" : "s"} in the last {windowDays}{" "}
                days · {cardsFrom} to {to}
              </span>
            ) : (
              <span>Reading the register…</span>
            )}
            {uncodedHours > 0 ? (
              <Badge tone="danger" size="sm" dot>
                {hoursText(uncodedHours, 1)} reaching no cost report
              </Badge>
            ) : null}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {tab === "tickets" ? (
              <>
                <Button size="sm" variant="secondary" onClick={() => setForm("ticket")}>
                  Raise a T&amp;M ticket
                </Button>
                {openTicket ? (
                  <Button size="sm" variant="secondary" onClick={() => setForm("source")}>
                    Source lines
                  </Button>
                ) : null}
              </>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => setForm("batch")}>
              Start a week
            </Button>
            <Button size="sm" variant="primary" onClick={() => setForm("card")}>
              Raise a timecard
            </Button>
          </div>
        }
        tabs={
          <Tabs
            items={TABS.map((entry) => ({
              value: entry.value,
              label: entry.label,
              ...(entry.value === "cards" && unexplained + uncoded > 0
                ? { count: unexplained + uncoded, tone: "danger" as const }
                : {}),
              ...(entry.value === "reconcile" && overclaims > 0
                ? { count: overclaims, tone: "danger" as const }
                : {}),
              ...(entry.value === "tickets" && unsignedTickets > 0
                ? { count: unsignedTickets, tone: "warning" as const }
                : {}),
            }))}
            value={tab}
            onChange={selectTab}
          />
        }
      />

      {tab === "cards" ? (
        <CardsTab
          cards={cards}
          crews={crews}
          filters={cardFilters}
          onFilters={(next) =>
            setFilters({
              status: next.status,
              crewId: next.crewId,
              exceptions: next.exceptions,
              unallocated: next.unallocated,
            })
          }
          windowDays={windowDays}
          onWindowDays={setWindowDays}
          onOpenCard={openCardDrawer}
        />
      ) : tab === "reconcile" ? (
        <ReconcileTab
          report={reconciliation}
          windowDays={reconcileDays}
          onWindowDays={setReconcileDays}
          onOpenCard={openCardDrawer}
        />
      ) : tab === "cost" ? (
        <CostReportTab
          projectId={projectId}
          report={costReport}
          windowDays={costDays}
          onWindowDays={setCostDays}
          onOpenCard={openCardDrawer}
        />
      ) : tab === "batches" ? (
        <BatchesTab
          batches={batches}
          selectedBatchId={batchId}
          onSelectBatch={setBatchId}
          detail={batchDetail}
          users={users}
          onOpenCard={openCardDrawer}
          projectId={projectId}
          onChanged={refresh}
        />
      ) : tab === "crews" ? (
        <CrewsTab
          crews={crews}
          selectedCrewId={crewId}
          onSelectCrew={setCrewId}
          detail={crewDetail}
          onDate={crewDate}
          onDateChange={setCrewDate}
        />
      ) : (
        <TicketsTab tickets={tickets} onOpenTicket={openTicketDrawer} />
      )}

      <TimecardDrawer
        projectId={projectId}
        timecardId={openCard}
        detail={cardDetail}
        costCodes={costCodes.data?.items ?? []}
        users={users}
        onClose={() => openCardDrawer(null)}
        onMutated={refreshAll}
      />

      <TicketDrawer
        projectId={projectId}
        ticketId={openTicket}
        detail={ticketDetail}
        onClose={() => openTicketDrawer(null)}
        onMutated={refreshAll}
      />

      <TimecardCreateModal
        open={form === "card"}
        onClose={() => setForm(null)}
        onDone={refresh}
        projectId={projectId}
        workers={workerList.data?.items ?? []}
        crews={crews.data?.items ?? []}
        costCodes={costCodes.data?.items ?? []}
      />
      <BatchCreateModal
        open={form === "batch"}
        onClose={() => setForm(null)}
        onDone={refresh}
        projectId={projectId}
        crews={crews.data?.items ?? []}
      />
      <TicketCreateModal
        open={form === "ticket"}
        onClose={() => setForm(null)}
        onDone={(ticketId) => {
          tickets.reload();
          openTicketDrawer(ticketId);
        }}
        projectId={projectId}
        crews={crews.data?.items ?? []}
      />
      <TicketSourceModal
        open={form === "source"}
        onClose={() => setForm(null)}
        onDone={() => {
          tickets.reload();
          ticketDetail.reload();
        }}
        projectId={projectId}
        ticketId={openTicket}
        ticketReference={ticketDetail.data?.reference ?? "this ticket"}
      />
    </div>
  );
}
