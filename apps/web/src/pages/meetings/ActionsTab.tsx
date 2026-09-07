/**
 * ACTION ITEMS — every promise the project has made in a room.
 *
 * Two things this screen refuses to let slide:
 *
 *  · A MOVED DATE DOES NOT LOOK CLEAN. Where an action has been re-dated, the
 *    original date and the number of moves sit next to the current one. The
 *    overdue signal raised against it was never cleared by the move, and the
 *    row says so.
 *  · OVERDUE IS FOUND ON READ. The list endpoint runs an idempotent lazy sweep
 *    — never a cron — and reports what it scanned and raised. That is printed
 *    under the grid rather than hidden, because "the read is the moment the
 *    answer has to be true" is a design decision users deserve to know about.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  EmptyState,
  Field,
  SegmentedControl,
  Select,
  Skeleton,
  Stat,
  Tooltip,
  type DataColumns,
} from "../../ui";
import { IconAssurance, IconCheckCircle, IconTask, IconWarning } from "../../ui/icons";
import ActionItemCard from "./ActionItemCard";
import {
  ACTION_PRIORITIES,
  ACTION_STATUSES,
  ACTION_STATUS_TONE,
  CarryBadge,
  DueDate,
  EMPTY_ACTION_FILTERS,
  LoadError,
  PRIORITY_TONE,
  ReasonList,
  SweepNote,
  count,
  titleCase,
  todayISO,
  type ActionFilters,
  type ActionItem,
  type ActionsResponse,
  type Loadable,
  type MeetingSeries,
  type OverdueReport,
} from "./meetingsShared";

type Layout = "queue" | "grid";

export default function ActionsTab({
  projectId,
  actions,
  overdueReport,
  series,
  filters,
  onFilters,
  onMutated,
  onOpenMeeting,
}: {
  projectId: string;
  actions: Loadable<ActionsResponse>;
  overdueReport: Loadable<OverdueReport>;
  series: MeetingSeries[];
  filters: ActionFilters;
  onFilters: (next: ActionFilters) => void;
  onMutated: () => void;
  onOpenMeeting: (meetingId: string) => void;
}) {
  const [layout, setLayout] = useState<Layout>("queue");
  const today = todayISO();

  const rows = actions.data?.items ?? [];
  const report = overdueReport.data;

  const tally = useMemo(() => {
    let overdue = 0;
    let promoted = 0;
    let slipped = 0;
    let unowned = 0;
    let carried = 0;
    for (const a of rows) {
      const isOpen = a.status === "open" || a.status === "in_progress" || a.status === "blocked";
      if (a.isOverdue ?? (isOpen && a.dueDate !== null && a.dueDate < today)) overdue += 1;
      if (a.obligationId) promoted += 1;
      if (a.revisedCount > 0) slipped += 1;
      if (!a.ownerId && !a.ownerName) unowned += 1;
      if (a.carryCount > 0) carried += 1;
    }
    return { overdue, promoted, slipped, unowned, carried };
  }, [rows, today]);

  /** Worst first: overdue, then most-slipped, then most-carried. */
  const queue = useMemo(
    () =>
      rows.slice().sort((a, b) => {
        const overdueOf = (x: ActionItem) => (x.isOverdue ? 0 : 1);
        const byOverdue = overdueOf(a) - overdueOf(b);
        if (byOverdue !== 0) return byOverdue;
        if (a.revisedCount !== b.revisedCount) return b.revisedCount - a.revisedCount;
        if (a.carryCount !== b.carryCount) return b.carryCount - a.carryCount;
        return (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999");
      }),
    [rows],
  );

  const columns = useMemo<DataColumns<ActionItem>>(
    () => [
      {
        id: "reference",
        header: "Action",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 105,
        mono: true,
      },
      { id: "title", header: "What was agreed", accessor: "title", type: "text", width: 280 },
      {
        id: "ownerName",
        header: "Owner",
        accessor: (row) => row.ownerName ?? row.ownerId ?? "",
        type: "text",
        width: 170,
        groupable: true,
        cell: ({ row }) =>
          row.ownerName ?? row.ownerId ?? (
            <Tooltip content="An action nobody owns is a wish. The API demands a name at minimum, so an unowned row here predates that or carries only a vendor.">
              <span className="italic text-danger-fg">unowned</span>
            </Tooltip>
          ),
      },
      {
        id: "dueDate",
        header: "Due",
        headerTooltip:
          "Where a date has been moved, the original is printed beneath it with the number of moves. Re-dating is slippage and is kept as evidence.",
        accessor: (row) => row.dueDate ?? "",
        type: "text",
        width: 175,
        cell: ({ row }) => (
          <DueDate
            dueDate={row.dueDate}
            originalDueDate={row.originalDueDate}
            revisedCount={row.revisedCount}
            {...(row.isOverdue !== undefined ? { overdue: row.isOverdue } : {})}
            className="text-meta"
          />
        ),
        toCsv: ({ row }) =>
          row.revisedCount > 0 && row.originalDueDate
            ? `${row.dueDate ?? ""} (originally ${row.originalDueDate}, moved ${row.revisedCount}x)`
            : (row.dueDate ?? ""),
      },
      {
        id: "revisedCount",
        header: "Re-dated",
        accessor: "revisedCount",
        type: "number",
        align: "right",
        width: 100,
        sortDescFirst: true,
        aggregate: "sum",
        cell: ({ row }) =>
          row.revisedCount === 0 ? (
            <span className="text-2xs text-content-subtle">never</span>
          ) : (
            <Badge tone="warning" size="xs" variant={row.revisedCount >= 3 ? "solid" : "subtle"}>
              ×{row.revisedCount}
            </Badge>
          ),
      },
      {
        id: "carryCount",
        header: "Discussed at",
        headerTooltip:
          "How many meetings this action has been carried through. Open actions on a carried agenda item are never duplicated — the count moves instead.",
        accessor: "carryCount",
        type: "number",
        align: "right",
        width: 130,
        sortDescFirst: true,
        aggregate: "max",
        cell: ({ row }) =>
          row.carryCount === 0 ? (
            <span className="text-2xs text-content-subtle">one meeting</span>
          ) : (
            <CarryBadge carryCount={row.carryCount} />
          ),
      },
      {
        id: "status",
        header: "State",
        accessor: "status",
        type: "status",
        width: 130,
        groupable: true,
        options: ACTION_STATUSES.map((s) => ({
          value: s,
          text: titleCase(s),
          label: titleCase(s),
          tone: ACTION_STATUS_TONE[s] ?? "neutral",
        })),
        cell: ({ row }) => (
          <Badge tone={ACTION_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "priority",
        header: "Priority",
        accessor: "priority",
        type: "enum",
        width: 110,
        groupable: true,
        options: ACTION_PRIORITIES.map((p) => ({
          value: p,
          text: titleCase(p),
          label: titleCase(p),
          tone: PRIORITY_TONE[p] ?? "neutral",
        })),
        cell: ({ row }) => (
          <Badge tone={PRIORITY_TONE[row.priority] ?? "neutral"} size="xs" variant="outline">
            {titleCase(row.priority)}
          </Badge>
        ),
      },
      {
        id: "obligationId",
        header: "Promoted",
        accessor: (row) => (row.obligationId ? "yes" : "no"),
        type: "enum",
        width: 160,
        groupable: true,
        options: [
          { value: "yes", text: "Promoted", label: "Promoted", tone: "accent" },
          { value: "no", text: "Not promoted", label: "Not promoted", tone: "neutral" },
        ],
        cell: ({ row }) =>
          row.obligationId ? (
            <Tooltip content="The obligation owns the time bar for this action now. Overdue warnings come from the obligations sweep from here on, and this action can no longer be cancelled here.">
              <span>
                <Badge tone="accent" size="xs" icon={IconAssurance}>
                  Obligation
                </Badge>
              </span>
            </Tooltip>
          ) : (
            <span className="text-2xs text-content-subtle">—</span>
          ),
      },
      {
        id: "sourceClause",
        header: "Clause",
        accessor: (row) => row.sourceClause ?? "",
        type: "text",
        width: 180,
        defaultHidden: true,
        cell: ({ row }) =>
          row.sourceClause ?? <span className="italic text-content-subtle">none recorded</span>,
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      {actions.error ? (
        <LoadError
          message={actions.error}
          onRetry={actions.reload}
          title="The action items could not be loaded"
        />
      ) : null}

      <Card>
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Stat
            label="Overdue"
            value={count(tally.overdue)}
            tone={tally.overdue > 0 ? "danger" : "success"}
            icon={IconWarning}
            hint="Open, past its date, and not promoted to an obligation."
          />
          <Stat
            label="Dates moved"
            value={count(tally.slipped)}
            tone={tally.slipped > 0 ? "warning" : "neutral"}
            hint="Each one keeps its original date and its open signal."
          />
          <Stat
            label="Carried between meetings"
            value={count(tally.carried)}
            tone={tally.carried > 0 ? "warning" : "neutral"}
            hint="Discussed at more than one occurrence without closing."
          />
          <Stat
            label="Promoted to obligations"
            value={count(tally.promoted)}
            tone="accent"
            icon={IconAssurance}
            hint="Their time bars are enforced by the obligations sweep, not here."
          />
          <Stat
            label="Unowned"
            value={count(tally.unowned)}
            tone={tally.unowned > 0 ? "danger" : "neutral"}
            hint="An action nobody owns is a wish."
          />
        </CardBody>
      </Card>

      {report && report.summary.overdue > 0 ? (
        <Alert
          tone="danger"
          title={`${count(report.summary.overdue)} action${report.summary.overdue === 1 ? " is" : "s are"} overdue as at ${report.asOf}`}
        >
          <ul className="mt-1 space-y-1 text-meta">
            {report.byOwner.slice(0, 5).map((o) => (
              <li key={o.owner}>
                <span className="font-medium text-content">{o.owner}</span> — {count(o.count)}{" "}
                overdue, worst {count(o.worstDays)} day{o.worstDays === 1 ? "" : "s"} past its date
              </li>
            ))}
          </ul>
          {report.summary.unassigned > 0 ? (
            <p className="mt-2 text-meta">
              {count(report.summary.unassigned)} of them have no owner recorded at all, so nobody is
              chasing them.
            </p>
          ) : null}
        </Alert>
      ) : report && report.summary.reasons.length > 0 ? (
        <Alert tone="info" variant="subtle" size="sm" title="No overdue actions to report">
          <ReasonList reasons={report.summary.reasons} />
        </Alert>
      ) : null}

      <Card>
        <CardBody className="grid gap-3 md:grid-cols-5">
          <Field label="State">
            <Select
              value={filters.status}
              onChange={(e) => onFilters({ ...filters, status: e.target.value })}
            >
              <option value="">Every state</option>
              {ACTION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select
              value={filters.priority}
              onChange={(e) => onFilters({ ...filters, priority: e.target.value })}
            >
              <option value="">Any priority</option>
              {ACTION_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {titleCase(p)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Series">
            <Select
              value={filters.seriesId}
              onChange={(e) => onFilters({ ...filters, seriesId: e.target.value })}
            >
              <option value="">Every series</option>
              {series.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.reference} · {s.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Overdue only">
            <Select
              value={filters.overdue}
              onChange={(e) => onFilters({ ...filters, overdue: e.target.value })}
            >
              <option value="">No</option>
              <option value="1">Yes</option>
            </Select>
          </Field>
          <Field label="Promotion">
            <Select
              value={filters.promoted}
              onChange={(e) => onFilters({ ...filters, promoted: e.target.value })}
            >
              <option value="">Either</option>
              <option value="1">Promoted to an obligation</option>
              <option value="0">Not promoted</option>
            </Select>
          </Field>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl<Layout>
          value={layout}
          onChange={setLayout}
          size="sm"
          options={[
            { value: "queue", label: "Worst first" },
            { value: "grid", label: "Grid" },
          ]}
        />
        {hasFilters(filters) ? (
          <Button size="xs" variant="ghost" onClick={() => onFilters(EMPTY_ACTION_FILTERS)}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {actions.loading && rows.length === 0 ? (
        <Card>
          <CardBody className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-5/6" />
          </CardBody>
        </Card>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={hasFilters(filters) ? IconTask : IconCheckCircle}
          tone={hasFilters(filters) ? "neutral" : "success"}
          title={
            hasFilters(filters)
              ? "No action matches these filters"
              : "No action has been agreed at any meeting on this project"
          }
          hint={
            hasFilters(filters)
              ? "The filters above exclude every action item held on this project. Clear them to see the register."
              : "The minutes are not the product — the action item is. Nothing here means either that no meeting has produced a commitment yet, or that commitments are being made in rooms and never written down. The second is the one worth checking."
          }
        />
      ) : layout === "queue" ? (
        <div className="space-y-2">
          {queue.map((a) => (
            <div key={a.id}>
              <ActionItemCard
                projectId={projectId}
                action={a}
                onMutated={onMutated}
                showMeeting
              />
              {a.meetingId ? (
                <div className="mt-1 pl-3">
                  <button
                    type="button"
                    className="text-2xs text-accent-text underline"
                    onClick={() => onOpenMeeting(a.meetingId as string)}
                  >
                    Open the meeting it was agreed at
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <DataTable<ActionItem>
          tableId="meeting-action-items"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={actions.loading}
          height={620}
          rowHeight={56}
          stickyHeader
          gridLines
          filterRow
          savedViews
          builtInViews={[
            {
              id: "builtin:open",
              name: "Still open",
              builtIn: true,
              state: { columnFilters: [{ id: "status", value: ["open", "in_progress", "blocked"] }] },
            },
            {
              id: "builtin:slipped",
              name: "Dates moved",
              builtIn: true,
              state: { sorting: [{ id: "revisedCount", desc: true }] },
            },
            {
              id: "builtin:promoted",
              name: "Promoted to obligations",
              builtIn: true,
              state: { columnFilters: [{ id: "obligationId", value: ["yes"] }] },
            },
          ]}
          exportFileName="meeting-action-items"
          searchPlaceholder="Search actions…"
          defaultSort={[{ id: "dueDate", desc: false }]}
          rowTone={(row) =>
            row.isOverdue
              ? "danger"
              : row.revisedCount > 0 || row.carryCount >= 3
                ? "warning"
                : undefined
          }
          onRowClick={({ row }) => {
            if (row.meetingId) onOpenMeeting(row.meetingId);
          }}
          rowActions={(row) => [
            {
              id: "meeting",
              label: "Open the meeting it was agreed at",
              disabled: row.meetingId === null,
              onSelect: () => {
                if (row.meetingId) onOpenMeeting(row.meetingId);
              },
            },
          ]}
          empty={{
            title: "No action item",
            description: "Actions are agreed at a meeting and carry an owner and a date.",
          }}
          emptyFiltered={{
            title: "No action matches these filters",
            description: "Widen the state, priority or series filter.",
          }}
          aria-label="Meeting action items"
        />
      )}

      <SweepNote sweptBy={actions.data?.sweptBy} />
      {report ? (
        <p className="text-2xs text-content-subtle">
          {count(report.summary.openActions)} open action
          {report.summary.openActions === 1 ? "" : "s"} on this project as at {report.asOf};{" "}
          {count(report.summary.promotedToObligations)} of them have had their time bar handed to
          an obligation, whose own sweep warns about it from here on.
        </p>
      ) : null}
    </div>
  );
}

function hasFilters(filters: ActionFilters): boolean {
  return (
    filters.status !== "" ||
    filters.priority !== "" ||
    filters.seriesId !== "" ||
    filters.overdue !== "" ||
    filters.promoted !== ""
  );
}
