/**
 * UTILISATION — where the hours actually went, per machine and per day.
 *
 * The definition is stated on screen because every plant hire company uses a
 * different one: utilisation is WORKING hours over the available window.
 * Travel counts in the denominator and not the numerator, because a low-loader
 * move is time the machine was paid for and produced nothing on this project,
 * and hiding it in the numerator is how a fleet reports 90% while the site
 * stands.
 *
 * Three refusals are visible rather than smoothed away:
 *  · a negative bucket — a machine cannot work a negative shift
 *  · a zero denominator — nothing to divide by
 *  · accounted hours exceeding the available window — the row contradicts
 *    itself, and a percentage over 100 would read as over-performance
 *
 * And the cost of a day is a FLOOR whenever a component could not be priced.
 * `totalIsComplete` is printed, so a partial figure is never dressed as a
 * full one.
 */
import { useMemo } from "react";
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  Select,
  SkeletonTable,
  Tooltip,
} from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { ChartCard, StackedBarChart } from "../../ui/charts";
import type { Tone } from "../../ui/tokens";
import { IconChartBar, IconClock } from "../../ui/icons";
import {
  CurrencyRail,
  EM_DASH,
  FigureCell,
  IDLE_REASON_LABEL,
  LoadError,
  SectionHeading,
  bucketsOf,
  hours,
  isoDate,
  labelize,
  money,
  percent,
  utilisationTone,
  type ListResponse,
  type Loadable,
  type UtilisationRow,
  type UtilisationSummary,
  type UtilisationSummaryItem,
} from "./equipmentShared";

const WINDOWS = [7, 14, 30, 60, 90];

export default function UtilisationTab({
  summary,
  rows,
  windowDays,
  onWindowDays,
  onOpenMachine,
}: {
  summary: Loadable<UtilisationSummary>;
  rows: Loadable<ListResponse<UtilisationRow>>;
  windowDays: number;
  onWindowDays: (days: number) => void;
  onOpenMachine: (equipmentId: string) => void;
}) {
  const data = summary.data;
  const items = useMemo(() => data?.items ?? [], [data]);
  const dayRows = useMemo(() => rows.data?.items ?? [], [rows.data]);

  const costBuckets = useMemo(() => bucketsOf(data?.costByCurrency), [data]);

  /** One stacked bar per machine: where the paid window went. */
  const chartRows = useMemo(
    () =>
      items.slice(0, 14).map((item) => ({
        machine: item.reference ?? item.equipmentId.slice(0, 8),
        working: item.hours.workingHours,
        idle: item.hours.idleHours,
        standby: item.hours.standbyHours,
        downtime: item.hours.downtimeHours,
        travel: item.hours.travelHours,
      })),
    [items],
  );

  const summaryColumns = useMemo<DataColumns<UtilisationSummaryItem>>(
    () => [
      {
        id: "reference",
        header: "Plant",
        accessor: (row) => row.reference ?? "",
        type: "code",
        sticky: "start",
        width: 118,
        mono: true,
      },
      {
        id: "name",
        header: "Machine",
        accessor: (row) => row.name ?? "",
        type: "text",
        width: 220,
      },
      {
        id: "utilisation",
        header: "Utilisation",
        headerTooltip:
          "Working hours over the available window. Where the window was never recorded the denominator is the hours accounted for, and the basis column says which was used.",
        accessor: (row) => row.utilisation.utilisationPercent,
        type: "custom",
        align: "right",
        width: 135,
        aggregate: "none",
        cell: ({ row }) => (
          <FigureCell
            value={row.utilisation.utilisationPercent}
            reasons={row.utilisation.reasons}
            render={(value) => (
              <span
                className={
                  utilisationTone(value) === "danger"
                    ? "font-semibold text-danger-fg"
                    : utilisationTone(value) === "warning"
                      ? "font-semibold text-warning-fg"
                      : "font-medium"
                }
              >
                {percent(value)}
              </span>
            )}
          />
        ),
        toCsv: ({ row }) => row.utilisation.utilisationPercent,
      },
      {
        id: "basis",
        header: "Basis",
        accessor: (row) => row.utilisation.basis ?? "",
        type: "enum",
        width: 160,
        cell: ({ row }) =>
          row.utilisation.basis === null ? (
            <span className="text-2xs text-content-subtle italic">none usable</span>
          ) : (
            <Tooltip
              content={
                row.utilisation.basis === "available_hours"
                  ? "The site recorded the window the machine was available to work, so that is the denominator."
                  : "No available window was recorded, so the denominator is the sum of the five hour buckets. The two are not the same number, and a reader comparing machines must know which was used."
              }
            >
              <span>
                <Badge
                  tone={row.utilisation.basis === "available_hours" ? "success" : "warning"}
                  size="xs"
                  variant="outline"
                >
                  {row.utilisation.basis === "available_hours" ? "Available window" : "Accounted hours"}
                </Badge>
              </span>
            </Tooltip>
          ),
      },
      {
        id: "days",
        header: "Days",
        accessor: "days",
        type: "number",
        align: "right",
        width: 90,
        aggregate: "sum",
      },
      {
        id: "workingHours",
        header: "Worked",
        accessor: (row) => row.hours.workingHours,
        type: "custom",
        align: "right",
        width: 110,
        aggregate: "none",
        cell: ({ row }) => <span className="tabular-nums">{hours(row.hours.workingHours)}</span>,
      },
      {
        id: "unproductive",
        header: "Paid, produced nothing",
        headerTooltip: "Idle plus standby plus downtime — hours that were paid for and produced nothing.",
        accessor: (row) => row.utilisation.unproductiveHours,
        type: "custom",
        align: "right",
        width: 190,
        aggregate: "none",
        sortDescFirst: true,
        cell: ({ row }) => (
          <span
            className={
              row.utilisation.unproductiveHours > row.hours.workingHours
                ? "font-semibold tabular-nums text-danger-fg"
                : "tabular-nums"
            }
          >
            {hours(row.utilisation.unproductiveHours)}
          </span>
        ),
      },
      {
        id: "cost",
        header: "Cost in window",
        accessor: (row) => row.cost.total,
        type: "custom",
        align: "right",
        width: 175,
        aggregate: "none",
        sortDescFirst: true,
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1">
            <FigureCell
              value={row.cost.total}
              reasons={row.cost.note ? [row.cost.note] : []}
              render={(value) => money(value, row.currency)}
            />
            {row.cost.total !== null && !row.cost.complete ? (
              <Tooltip content={row.cost.note ?? "Some days in this window could not be priced."}>
                <span>
                  <Badge tone="warning" size="xs" variant="outline">
                    floor
                  </Badge>
                </span>
              </Tooltip>
            ) : null}
          </span>
        ),
        toCsv: ({ row }) => (row.cost.total === null ? "" : `${row.cost.total} ${row.currency}`),
      },
      {
        id: "idleByReason",
        header: "Stood because",
        accessor: (row) => Object.keys(row.idleByReason).join(", "),
        type: "text",
        width: 240,
        cell: ({ row }) => {
          const entries = Object.entries(row.idleByReason).sort((a, b) => b[1] - a[1]);
          if (entries.length === 0) {
            return (
              <Tooltip content="Idle hours were recorded with no reason attached. The reason is the field that turns a cost into an action — 'awaiting materials' is recoverable, 'weather' usually is not.">
                <span className="text-2xs text-content-subtle italic">no reason recorded</span>
              </Tooltip>
            );
          }
          return (
            <span className="flex flex-wrap gap-1">
              {entries.slice(0, 2).map(([reason, value]) => (
                <Badge key={reason} tone="warning" size="xs" variant="outline">
                  {IDLE_REASON_LABEL[reason] ?? labelize(reason)} {value.toFixed(0)}h
                </Badge>
              ))}
              {entries.length > 2 ? (
                <Badge tone="neutral" size="xs">
                  +{entries.length - 2}
                </Badge>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "verification",
        header: "Verified",
        headerTooltip:
          "Hours are a claim for money. A claim checked by its own author is not checked, so verification may never be the operator who claimed the hours.",
        accessor: (row) => row.verification.unverified,
        type: "custom",
        align: "right",
        width: 130,
        aggregate: "none",
        cell: ({ row }) =>
          row.verification.unverified === 0 ? (
            <Badge tone="success" size="xs" variant="outline">
              all {row.verification.verified}
            </Badge>
          ) : (
            <Badge tone="warning" size="xs">
              {row.verification.unverified} unchecked
            </Badge>
          ),
      },
    ],
    [],
  );

  const dayColumns = useMemo<DataColumns<UtilisationRow>>(
    () => [
      {
        id: "utilisationDate",
        header: "Date",
        accessor: "utilisationDate",
        type: "date",
        sticky: "start",
        width: 120,
      },
      {
        id: "equipmentReference",
        header: "Plant",
        accessor: (row) => row.equipmentReference ?? "",
        type: "code",
        width: 118,
        mono: true,
      },
      { id: "shift", header: "Shift", accessor: "shift", type: "enum", width: 100, groupable: true },
      {
        id: "availableHours",
        header: "Window",
        accessor: "availableHours",
        type: "custom",
        align: "right",
        width: 110,
        aggregate: "none",
        cell: ({ row }) =>
          row.availableHours === null ? (
            <Tooltip content="No available window was recorded for this day, so utilisation falls back to the hours accounted for.">
              <span className="text-2xs text-content-subtle italic">not recorded</span>
            </Tooltip>
          ) : (
            <span className="tabular-nums">{hours(row.availableHours)}</span>
          ),
      },
      {
        id: "workingHours",
        header: "Worked",
        accessor: "workingHours",
        type: "custom",
        align: "right",
        width: 100,
        aggregate: "sum",
        cell: ({ row }) => <span className="tabular-nums">{hours(row.workingHours)}</span>,
      },
      {
        id: "idleHours",
        header: "Idle",
        accessor: "idleHours",
        type: "custom",
        align: "right",
        width: 95,
        aggregate: "sum",
        cell: ({ row }) => <span className="tabular-nums">{hours(row.idleHours)}</span>,
      },
      {
        id: "standbyHours",
        header: "Standby",
        accessor: "standbyHours",
        type: "custom",
        align: "right",
        width: 105,
        aggregate: "sum",
        defaultHidden: true,
        cell: ({ row }) => <span className="tabular-nums">{hours(row.standbyHours)}</span>,
      },
      {
        id: "downtimeHours",
        header: "Downtime",
        accessor: "downtimeHours",
        type: "custom",
        align: "right",
        width: 110,
        aggregate: "sum",
        cell: ({ row }) => <span className="tabular-nums">{hours(row.downtimeHours)}</span>,
      },
      {
        id: "utilisation",
        header: "Utilisation",
        accessor: (row) => row.utilisation?.utilisationPercent ?? row.utilisationPercent,
        type: "custom",
        align: "right",
        width: 130,
        aggregate: "none",
        cell: ({ row }) => (
          <FigureCell
            value={row.utilisation?.utilisationPercent ?? row.utilisationPercent}
            reasons={row.utilisation?.reasons ?? []}
            render={(value) => percent(value)}
          />
        ),
      },
      {
        id: "idleReason",
        header: "Stood because",
        accessor: (row) => row.idleReason ?? "",
        type: "enum",
        width: 190,
        cell: ({ row }) =>
          row.idleReason ? (
            <Tooltip content={row.idleNote ?? "No further note was recorded."}>
              <span>
                <Badge tone="warning" size="xs" variant="outline">
                  {IDLE_REASON_LABEL[row.idleReason] ?? labelize(row.idleReason)}
                </Badge>
              </span>
            </Tooltip>
          ) : (
            <span className="text-2xs text-content-subtle">{EM_DASH}</span>
          ),
      },
      {
        id: "totalCost",
        header: "Day cost",
        accessor: (row) => row.cost?.totalCost ?? row.totalCost,
        type: "custom",
        align: "right",
        width: 150,
        aggregate: "none",
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1">
            <FigureCell
              value={row.cost?.totalCost ?? row.totalCost}
              reasons={row.cost?.reasons ?? []}
              render={(value) => money(value, row.currency, { fractionDigits: 2 })}
            />
            {row.cost && row.cost.totalCost !== null && !row.cost.totalIsComplete ? (
              <Tooltip
                content={
                  <span className="block max-w-xs space-y-1">
                    <span className="block">
                      This total is a FLOOR, not the cost: one or more components could not be
                      priced.
                    </span>
                    {row.cost.reasons.map((reason, index) => (
                      <span key={index} className="block">
                        {reason}
                      </span>
                    ))}
                  </span>
                }
              >
                <span>
                  <Badge tone="warning" size="xs" variant="outline">
                    floor
                  </Badge>
                </span>
              </Tooltip>
            ) : null}
          </span>
        ),
      },
      {
        id: "source",
        header: "Source",
        accessor: "source",
        type: "enum",
        width: 130,
        cell: ({ row }) => (
          <Badge tone={row.source === "telematics" ? "success" : "neutral"} size="xs" variant="outline">
            {labelize(row.source)}
          </Badge>
        ),
      },
      {
        id: "costCoding",
        header: "Cost coded",
        accessor: (row) => (row.costCoding?.note ? "no" : "yes"),
        type: "enum",
        width: 140,
        cell: ({ row }) =>
          row.costCoding?.note ? (
            <Tooltip content={row.costCoding.note}>
              <span>
                <Badge tone="danger" size="xs">
                  lands nowhere
                </Badge>
              </span>
            </Tooltip>
          ) : (
            <Badge tone="success" size="xs" variant="outline">
              coded
            </Badge>
          ),
      },
      {
        id: "verifiedBy",
        header: "Verified",
        accessor: (row) => (row.verifiedBy ? "yes" : "no"),
        type: "enum",
        width: 120,
        cell: ({ row }) =>
          row.verifiedBy ? (
            <Badge tone="success" size="xs" variant="outline">
              {isoDate(row.verifiedAt)}
            </Badge>
          ) : (
            <Badge tone="warning" size="xs">
              unchecked
            </Badge>
          ),
      },
    ],
    [],
  );

  if (summary.error) return <LoadError message={summary.error} onRetry={summary.reload} />;
  if (summary.loading && !data) return <SkeletonTable rows={8} columns={7} />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3">
          <SectionHeading
            title="Utilisation"
            hint="Working hours over the available window. Travel is in the denominator and not the numerator — a low-loader move is time the machine was paid for and produced nothing here."
            className="mb-0"
            actions={
              <label className="flex items-center gap-2">
                <span className="text-label uppercase tracking-wide text-content-subtle">
                  Window
                </span>
                <Select
                  size="sm"
                  value={String(windowDays)}
                  onChange={(event) => onWindowDays(Number(event.target.value))}
                  aria-label="Utilisation window"
                >
                  {WINDOWS.map((days) => (
                    <option key={days} value={days}>
                      Last {days} days
                    </option>
                  ))}
                </Select>
              </label>
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral" size="sm">
              {data.machines} machine{data.machines === 1 ? "" : "s"}
            </Badge>
            <span className="text-meta text-content-muted">
              {data.from} to {data.to} · {data.days} days
            </span>
          </div>
        </CardBody>
      </Card>

      <CurrencyRail
        buckets={costBuckets}
        label="Plant cost in the window"
        note={data.currencyNote}
      />

      {chartRows.length > 0 ? (
        <ChartCard
          title="Where the paid window went"
          subtitle="Hours by machine, split into working, idle, standby, downtime and travel"
          icon={IconChartBar}
          footnote="Only working hours count towards utilisation. Everything to the right of the working segment is time somebody paid for and got nothing from — except downtime, which comes off hire under standard hire conditions and is shown so the difference is visible."
        >
          <StackedBarChart
            data={chartRows}
            categoryKey="machine"
            series={[
              { key: "working", label: "Working" },
              { key: "idle", label: "Idle" },
              { key: "standby", label: "Standby" },
              { key: "downtime", label: "Downtime" },
              { key: "travel", label: "Travel" },
            ]}
            valueFormat="hours"
            ariaLabel="Hours by machine split by activity"
            height={280}
          />
        </ChartCard>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          icon={IconClock}
          title="No plant hours have been recorded in this window"
          hint={`Nothing was booked against a machine on this project between ${data.from} and ${data.to}. That is not the same as plant standing idle: no plant sheet exists at all, so the platform has nothing to compute a utilisation from. Widen the window, or record the days on the machines that were here.`}
        />
      ) : (
        <>
          <div>
            <SectionHeading
              title="By machine"
              hint="Worst utilisation first — the machines to have a conversation about."
            />
            <DataTable<UtilisationSummaryItem>
              tableId="equipment-utilisation-summary"
              data={items}
              columns={summaryColumns}
              getRowId={(row) => row.equipmentId}
              loading={summary.loading}
              height={Math.min(520, 140 + items.length * 40)}
              stickyHeader
              gridLines
              filterRow
              exportFileName="equipment-utilisation-summary"
              searchPlaceholder="Search machines…"
              rowTone={(row) => summaryRail(row)}
              onRowClick={({ row }) => onOpenMachine(row.equipmentId)}
              rowActions={(row) => [
                {
                  id: "open",
                  label: "Open the machine",
                  onSelect: () => onOpenMachine(row.equipmentId),
                },
              ]}
              empty={{ title: "No machines in this window" }}
              aria-label="Utilisation by machine"
            />
          </div>

          <div>
            <SectionHeading
              title="Day by day"
              hint="Every plant sheet in the window, with the cost the engine could price and the components it could not."
            />
            {rows.error ? (
              <LoadError message={rows.error} onRetry={rows.reload} />
            ) : (
              <DataTable<UtilisationRow>
                tableId="equipment-utilisation-days"
                data={dayRows}
                columns={dayColumns}
                getRowId={(row) => row.id}
                loading={rows.loading}
                height={520}
                stickyHeader
                gridLines
                filterRow
                showFooter
                exportFileName="equipment-utilisation-days"
                searchPlaceholder="Search plant sheets…"
                defaultSort={[{ id: "utilisationDate", desc: true }]}
                onRowClick={({ row }) => onOpenMachine(row.equipmentId)}
                empty={{
                  title: "No plant sheets in this window",
                  description:
                    "The per-machine rollup above is built from these rows. With none of them, there is nothing to roll up.",
                }}
                aria-label="Plant sheets"
              />
            )}
            <p className="mt-2 text-2xs text-content-subtle">
              The footer sums hours only. Day costs carry no total: a project can hold plant hired
              in more than one currency, and one number across them would need an FX rate and a
              date. The per-currency rail above the tables is the total.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function summaryRail(row: UtilisationSummaryItem): Tone | undefined {
  const value = row.utilisation.utilisationPercent;
  if (value === null) return undefined;
  if (value <= 20) return "danger";
  if (value <= 45) return "warning";
  return undefined;
}
