/**
 * THE TIMECARD REGISTER — one worker, one day, one shift, on one grid.
 *
 * Four columns carry the module's discipline:
 *
 *  · SPLIT tells you the pay treatment AND whether the platform derived it. A
 *    card whose hours arrived already split was not classified under any rule;
 *    it is an assertion by whoever typed it, and the badge says so.
 *  · PRESENT is the turnstile's account. Where no access record exists it
 *    reads NOT COMPARABLE, never 0.0 h — a gate log with a hole in it would
 *    otherwise turn every honest card that week into a maximal overclaim.
 *  · VARIANCE is claimed minus present, and only where both exist.
 *  · CODED says whether these hours reach the cost report at all. Hours nobody
 *    can code are how a labour overrun stays invisible until month end.
 */
import { useMemo } from "react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Select,
  SkeletonTable,
  Switch,
  Tooltip,
} from "../../ui";
import { DataTable, type DataColumns, type DataView } from "../../ui/data";
import type { Tone } from "../../ui/tokens";
import { IconRefresh, IconWorkforce } from "../../ui/icons";
import {
  CLASSIFICATION_METHOD_LABEL,
  EM_DASH,
  IDLE_REASON_LABEL,
  LoadError,
  NotComparable,
  PREMIUM_KIND_LABEL,
  SectionHeading,
  TIMECARD_STATUS_TONE,
  VarianceCell,
  hoursText,
  labelize,
  money,
  type CardFilters,
  type CrewRecord,
  type Loadable,
  type TimecardListResponse,
  type TimecardListRow,
} from "./timecardsShared";

const STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "revised",
  "locked",
  "exported",
  "void",
] as const;

const WINDOWS = [7, 14, 30, 60, 90];

const BUILT_IN_VIEWS: DataView[] = [
  {
    id: "builtin:exceptions",
    name: "Unexplained variance",
    builtIn: true,
    state: { columnFilters: [{ id: "varianceState", value: ["unexplained"] }] },
  },
  {
    id: "builtin:uncoded",
    name: "Not cost coded",
    builtIn: true,
    state: { columnFilters: [{ id: "coded", value: ["no"] }] },
  },
  {
    id: "builtin:awaiting",
    name: "Awaiting approval",
    builtIn: true,
    state: { columnFilters: [{ id: "status", value: ["submitted"] }] },
  },
];

export default function CardsTab({
  cards,
  crews,
  filters,
  onFilters,
  windowDays,
  onWindowDays,
  onOpenCard,
}: {
  cards: Loadable<TimecardListResponse>;
  crews: Loadable<{ items: CrewRecord[] }>;
  filters: CardFilters;
  onFilters: (next: CardFilters) => void;
  windowDays: number;
  onWindowDays: (days: number) => void;
  onOpenCard: (timecardId: string) => void;
}) {
  const rows = useMemo(() => cards.data?.items ?? [], [cards.data]);

  const notComparable = rows.filter((row) => row.varianceHours === null).length;
  const unexplained = rows.filter(
    (row) =>
      row.varianceHours !== null &&
      row.varianceHours > 0.5 &&
      !(row.varianceExplanation ?? "").trim(),
  ).length;
  const uncoded = rows.filter((row) => !row.isAllocated).length;
  const uncosted = rows.filter((row) => row.totalCost === null).length;

  const columns = useMemo<DataColumns<TimecardListRow>>(
    () => [
      {
        id: "reference",
        header: "Card",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 108,
        mono: true,
      },
      { id: "workDate", header: "Date", accessor: "workDate", type: "date", width: 118 },
      {
        id: "workerName",
        header: "Worker",
        accessor: "workerName",
        type: "text",
        width: 200,
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-content">{row.workerName}</span>
            <span className="truncate font-mono text-2xs text-content-subtle">
              {row.workerReference}
            </span>
          </span>
        ),
      },
      {
        id: "shift",
        header: "Shift",
        accessor: "shift",
        type: "enum",
        width: 100,
        groupable: true,
        cell: ({ row }) => <span className="text-content-muted">{labelize(row.shift)}</span>,
      },
      {
        id: "totalHours",
        header: "Claimed",
        accessor: "totalHours",
        type: "custom",
        align: "right",
        width: 110,
        aggregate: "sum",
        cell: ({ row }) => (
          <span className="font-medium tabular-nums">{hoursText(row.totalHours, 1)}</span>
        ),
      },
      {
        id: "split",
        header: "Split, and by which rule",
        headerTooltip:
          "Plain / overtime / double / premium. A card whose hours were supplied already split BYPASSED the crew's overtime rule and is marked as an assertion rather than a derivation.",
        accessor: (row) =>
          `${row.regularHours}/${row.overtimeHours}/${row.doubleTimeHours}/${row.premiumHours}`,
        type: "text",
        width: 280,
        cell: ({ row }) => <SplitCell row={row} />,
      },
      {
        id: "present",
        header: "Present",
        headerTooltip:
          "Hours the site-access stream recorded. Independent evidence — as opposed to a crew sheet, which is the claimant's own assertion.",
        accessor: "accessHoursOnSite",
        type: "custom",
        align: "right",
        width: 140,
        aggregate: "none",
        cell: ({ row }) =>
          row.varianceHours === null ? (
            <NotComparable
              reason={
                row.detail?.variance?.reasons?.[0] ??
                "No site-access record exists for this worker on this date, so the hours actually present are unknown. A missing turnstile record is a gap in the evidence stream, not zero hours on site — reporting it as a variance would manufacture a fraud finding out of a data-quality problem."
              }
              label="No record"
            />
          ) : (
            <span className="tabular-nums">{hoursText(row.accessHoursOnSite, 1)}</span>
          ),
      },
      {
        id: "varianceHours",
        header: "Variance",
        accessor: "varianceHours",
        type: "custom",
        align: "right",
        width: 175,
        aggregate: "none",
        sortDescFirst: true,
        cell: ({ row }) => (
          <VarianceCell
            varianceHours={row.varianceHours}
            reasons={row.detail?.variance?.reasons ?? []}
            explained={Boolean((row.varianceExplanation ?? "").trim())}
            toleranceHours={row.detail?.variance?.toleranceHours}
          />
        ),
        toCsv: ({ row }) => row.varianceHours,
      },
      {
        id: "varianceState",
        header: "Variance state",
        accessor: (row) =>
          row.varianceHours === null
            ? "not_comparable"
            : Math.abs(row.varianceHours) <= (row.detail?.variance?.toleranceHours ?? 0.5) + 0.005
              ? "within"
              : (row.varianceExplanation ?? "").trim()
                ? "explained"
                : "unexplained",
        type: "enum",
        width: 160,
        defaultHidden: true,
        options: [
          { value: "unexplained", label: "Unexplained", text: "Unexplained", tone: "danger" },
          { value: "explained", label: "Explained", text: "Explained", tone: "success" },
          { value: "within", label: "Within tolerance", text: "Within tolerance" },
          {
            value: "not_comparable",
            label: "Not comparable",
            text: "Not comparable",
            tone: "neutral",
          },
        ],
      },
      {
        id: "coded",
        header: "Coded",
        headerTooltip:
          "Whether these hours are allocated to a cost code. A card with no allocation is hours nobody can code, which is how a labour overrun stays invisible until the month-end journal.",
        accessor: (row) => (row.isAllocated ? "yes" : "no"),
        type: "enum",
        width: 150,
        options: [
          { value: "yes", label: "Coded", text: "Coded", tone: "success" },
          { value: "no", label: "Uncoded", text: "Uncoded", tone: "danger" },
        ],
        cell: ({ row }) =>
          row.isAllocated ? (
            <Badge tone="success" size="xs" variant="outline">
              {row.allocationCount} line{row.allocationCount === 1 ? "" : "s"} ·{" "}
              {hoursText(row.allocatedHours, 1)}
            </Badge>
          ) : (
            <Tooltip content="These hours land on no cost code and no budget line. They will not appear in the cost report, and the overrun they cause will surface at month end with nothing to attribute it to.">
              <span>
                <Badge tone="danger" size="xs">
                  not coded
                </Badge>
              </span>
            </Tooltip>
          ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 140,
        groupable: true,
        options: STATUSES.map((value) => ({
          value,
          label: labelize(value),
          text: labelize(value),
          tone: TIMECARD_STATUS_TONE[value] ?? "neutral",
        })),
        cell: ({ row }) => (
          <Badge tone={TIMECARD_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "totalCost",
        header: "Cost",
        accessor: "totalCost",
        type: "custom",
        align: "right",
        width: 145,
        aggregate: "none",
        cell: ({ row }) =>
          row.totalCost === null ? (
            <Tooltip
              content={
                <span className="block max-w-xs space-y-1">
                  {(row.detail?.cost?.reasons ?? [
                    "The platform holds no rate for these hours, so the card's cost is unknown rather than zero.",
                  ]).map((reason, index) => (
                    <span key={index} className="block">
                      {reason}
                    </span>
                  ))}
                </span>
              }
            >
              <span className="inline-flex items-center gap-1 text-content-muted">
                <span>No rate</span>
                <Badge tone="warning" size="xs">
                  why
                </Badge>
              </span>
            </Tooltip>
          ) : (
            <span className="tabular-nums">{money(row.totalCost, row.currency)}</span>
          ),
        toCsv: ({ row }) => (row.totalCost === null ? "" : `${row.totalCost} ${row.currency}`),
      },
      {
        id: "idleHours",
        header: "Idle",
        accessor: "idleHours",
        type: "custom",
        align: "right",
        width: 145,
        aggregate: "sum",
        defaultHidden: true,
        cell: ({ row }) =>
          row.idleHours > 0 ? (
            <Tooltip content="Idle hours are a memo on hours already claimed and paid, never an addition to them.">
              <span className="inline-flex items-center gap-1">
                <span className="tabular-nums">{hoursText(row.idleHours, 1)}</span>
                {row.idleReason ? (
                  <Badge tone="warning" size="xs" variant="outline">
                    {IDLE_REASON_LABEL[row.idleReason] ?? labelize(row.idleReason)}
                  </Badge>
                ) : null}
              </span>
            </Tooltip>
          ) : (
            <span className="text-content-subtle">{EM_DASH}</span>
          ),
      },
    ],
    [],
  );

  if (cards.error) return <LoadError message={cards.error} onRetry={cards.reload} />;
  if (cards.loading && rows.length === 0) return <SkeletonTable rows={10} columns={8} />;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3">
          <SectionHeading
            title="Timecards"
            hint="Listing this register runs the access-link sweep — lazily, idempotently, on the read. Cards raised before the gate export arrived pick up any record that has since landed, and the variance is recomputed."
            className="mb-0"
            actions={
              <Button size="sm" variant="ghost" icon={IconRefresh} loading={cards.loading} onClick={cards.reload}>
                Re-sweep
              </Button>
            }
          />
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-label uppercase tracking-wide text-content-subtle">Window</span>
              <Select
                size="sm"
                value={String(windowDays)}
                onChange={(event) => onWindowDays(Number(event.target.value))}
                aria-label="Window in days"
              >
                {WINDOWS.map((days) => (
                  <option key={days} value={days}>
                    Last {days} days
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-label uppercase tracking-wide text-content-subtle">Status</span>
              <Select
                size="sm"
                value={filters.status}
                onChange={(event) => onFilters({ ...filters, status: event.target.value })}
                aria-label="Status filter"
              >
                <option value="">Any status</option>
                {STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {labelize(status)}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-label uppercase tracking-wide text-content-subtle">Crew</span>
              <Select
                size="sm"
                value={filters.crewId}
                onChange={(event) => onFilters({ ...filters, crewId: event.target.value })}
                aria-label="Crew filter"
              >
                <option value="">Any crew</option>
                {(crews.data?.items ?? []).map((crew) => (
                  <option key={crew.id} value={crew.id}>
                    {crew.reference} · {crew.name}
                  </option>
                ))}
              </Select>
            </label>
            <Switch
              checked={filters.exceptions}
              onChange={(next) => onFilters({ ...filters, exceptions: next })}
              label="Unexplained variance only"
              size="sm"
            />
            <Switch
              checked={filters.unallocated}
              onChange={(next) => onFilters({ ...filters, unallocated: next })}
              label="Uncoded only"
              size="sm"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral" size="sm">
              {rows.length} card{rows.length === 1 ? "" : "s"}
            </Badge>
            <Badge tone={unexplained > 0 ? "danger" : "success"} size="sm" dot>
              {unexplained} unexplained variance
            </Badge>
            <Badge tone={uncoded > 0 ? "danger" : "success"} size="sm" dot={uncoded > 0}>
              {uncoded} uncoded
            </Badge>
            <Badge tone={uncosted > 0 ? "warning" : "neutral"} size="sm">
              {uncosted} with no rate
            </Badge>
            <Tooltip content="Days where no site-access record exists. These are deliberately NOT exceptions: absence of a turnstile record is absence of evidence, not evidence of absence.">
              <span>
                <Badge tone="neutral" size="sm" variant="outline">
                  {notComparable} not comparable
                </Badge>
              </span>
            </Tooltip>
          </div>
        </CardBody>
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          icon={IconWorkforce}
          title={
            filters.exceptions
              ? "No card in this window carries an unexplained variance"
              : filters.unallocated
                ? "Every card in this window is cost coded"
                : "No timecards in this window"
          }
          hint={
            filters.exceptions
              ? `The test ran across ${filters.from} to ${filters.to} and found no card whose claimed hours exceed the turnstile record beyond tolerance without an explanation. Cards with no access record are excluded from this test by design — a data gap is not an overclaim.`
              : filters.unallocated
                ? "Every card in the window has its hours allocated to a cost code, so all of this labour reaches the cost report."
                : `No hours have been booked on this project between ${filters.from} and ${filters.to}. That is not the same as nobody working: it means no crew sheet has been entered, so there is nothing to reconcile against the gate log and nothing to code to the budget.`
          }
          action={
            filters.exceptions || filters.unallocated ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onFilters({ ...filters, exceptions: false, unallocated: false })}
              >
                Show every card
              </Button>
            ) : undefined
          }
        />
      ) : (
        <DataTable<TimecardListRow>
          tableId="timecards-register"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={cards.loading}
          height={640}
          stickyHeader
          gridLines
          filterRow
          showFooter
          savedViews
          builtInViews={BUILT_IN_VIEWS}
          exportFileName="timecards"
          searchPlaceholder="Search by worker, card or crew…"
          defaultSort={[{ id: "workDate", desc: true }]}
          rowTone={(row) => cardRail(row)}
          onRowClick={({ row }) => onOpenCard(row.id)}
          rowActions={(row) => [
            { id: "open", label: "Open the card", onSelect: () => onOpenCard(row.id) },
          ]}
          empty={{ title: "No timecards" }}
          emptyFiltered={{
            title: "No card matches these filters",
            description: "Widen the window, clear the crew filter, or turn off the exception toggles.",
          }}
          aria-label="Timecard register"
        />
      )}

      <p className="text-2xs text-content-subtle">
        The footer sums hours only. Card costs carry no total: a project can run crews paid in more
        than one currency, and one figure across them would need an FX rate and a date. The labour
        cost report states cost per currency and refuses a single number where more than one is in
        play.
      </p>
    </div>
  );
}

function cardRail(row: TimecardListRow): Tone | undefined {
  if (
    row.varianceHours !== null &&
    row.varianceHours > (row.detail?.variance?.toleranceHours ?? 0.5) &&
    !(row.varianceExplanation ?? "").trim()
  ) {
    return "danger";
  }
  if (!row.isAllocated) return "warning";
  return undefined;
}

/** The split, and — critically — whether a rule produced it. */
function SplitCell({ row }: { row: TimecardListRow }) {
  const classification = row.detail?.hourClassification;
  const rule = classification?.rule ?? null;
  const explicit = classification?.method === "explicit_split";
  const parts: string[] = [];
  if (row.regularHours > 0) parts.push(`${row.regularHours} plain`);
  if (row.overtimeHours > 0) parts.push(`${row.overtimeHours} OT`);
  if (row.doubleTimeHours > 0) parts.push(`${row.doubleTimeHours} DT`);
  if (row.premiumHours > 0) {
    parts.push(
      `${row.premiumHours} ${(PREMIUM_KIND_LABEL[row.premiumKind] ?? row.premiumKind).toLowerCase()}`,
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate tabular-nums text-content">
        {parts.length > 0 ? parts.join(" · ") : hoursText(row.totalHours, 1)}
      </span>
      {classification ? (
        <Tooltip
          content={
            <span className="block max-w-sm space-y-1">
              <span className="block font-medium">
                {CLASSIFICATION_METHOD_LABEL[classification.method]}
              </span>
              <span className="block">
                {rule?.explanation ??
                  classification.note ??
                  "No explanation was recorded for this split."}
              </span>
            </span>
          }
        >
          <span>
            <Badge tone={explicit ? "warning" : "info"} size="xs" variant="outline">
              {explicit
                ? "by hand"
                : rule?.kind === "weekly"
                  ? "weekly rule"
                  : rule?.kind === "none"
                    ? "no OT rule"
                    : "daily rule"}
            </Badge>
          </span>
        </Tooltip>
      ) : (
        <Badge tone="neutral" size="xs" variant="outline">
          no record
        </Badge>
      )}
    </span>
  );
}
