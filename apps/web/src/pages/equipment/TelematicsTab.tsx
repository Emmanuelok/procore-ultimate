/**
 * TELEMATICS RECONCILIATION — the machine's own account of the day against
 * the one a person typed.
 *
 * Engine hours come off a CUMULATIVE counter, so a day's telematics hours are
 * the last reading of the day minus the first. That produces three states, and
 * this screen keeps them apart because collapsing them is how a control gets
 * switched off:
 *
 *   COMPARABLE      both accounts exist and the difference means something.
 *   NOT COMPARABLE  the feed cannot say — no reading, a single reading with no
 *                   interval to measure, or a counter that FELL (a device
 *                   reset or a swapped unit). Real hours were worked and the
 *                   feed can no longer say how many. This is rendered as NOT
 *                   COMPARABLE with the reason, never as a zero variance.
 *   NO PLANT SHEET  the machine ran and nobody filled in a sheet. That is
 *                   missing evidence, not an overclaim.
 *
 * A variance is not proof of a false claim — a counter can be reset, a machine
 * can be worked with the ignition off the clock. It is the question to ask,
 * and the value at risk is what makes asking it worth somebody's morning.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Select,
  SkeletonTable,
  Tooltip,
} from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { ChartCard, GroupedBarChart } from "../../ui/charts";
import type { Tone } from "../../ui/tokens";
import { IconZap } from "../../ui/icons";
import {
  CurrencyRail,
  FigureCell,
  LoadError,
  NOT_COMPARABLE_CLASSES,
  NotComparable,
  ReasonList,
  SectionHeading,
  VARIANCE_CLASS_LABEL,
  bucketsOf,
  hours,
  money,
  type DayVariance,
  type EquipmentReconciliation,
  type Loadable,
  type TelematicsReport,
} from "./equipmentShared";

const WINDOWS = [7, 14, 30, 60];

export default function TelematicsTab({
  report,
  days,
  onDays,
  onOpenMachine,
}: {
  report: Loadable<TelematicsReport>;
  days: number;
  onDays: (next: number) => void;
  onOpenMachine: (equipmentId: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const data = report.data;
  const rows = useMemo(() => data?.rows ?? [], [data]);

  const valueBuckets = useMemo(() => bucketsOf(data?.valueAtRiskByCurrency), [data]);

  const chartRows = useMemo(
    () =>
      rows
        .filter((row) => row.daysCompared > 0)
        .slice(0, 12)
        .map((row) => ({
          machine: row.reference,
          claimed: row.manualHours,
          engine: row.telematicsHours,
        })),
    [rows],
  );

  const columns = useMemo<DataColumns<EquipmentReconciliation>>(
    () => [
      {
        id: "reference",
        header: "Plant",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 118,
        mono: true,
      },
      { id: "name", header: "Machine", accessor: "name", type: "text", width: 210 },
      {
        id: "daysCompared",
        header: "Comparable days",
        headerTooltip:
          "Days on which both accounts exist: a plant sheet AND an engine-hour delta the counter could produce.",
        accessor: "daysCompared",
        type: "number",
        align: "right",
        width: 150,
        aggregate: "sum",
      },
      {
        id: "manualHours",
        header: "Claimed",
        accessor: "manualHours",
        type: "custom",
        align: "right",
        width: 115,
        aggregate: "none",
        cell: ({ row }) => <span className="tabular-nums">{hours(row.manualHours)}</span>,
      },
      {
        id: "telematicsHours",
        header: "Engine",
        accessor: "telematicsHours",
        type: "custom",
        align: "right",
        width: 115,
        aggregate: "none",
        cell: ({ row }) => <span className="tabular-nums">{hours(row.telematicsHours)}</span>,
      },
      {
        id: "varianceHours",
        header: "Variance",
        headerTooltip:
          "Claimed minus engine, across the comparable days only. Null when nothing was comparable — that is a statement about the evidence, not about the claim.",
        accessor: "varianceHours",
        type: "custom",
        align: "right",
        width: 140,
        aggregate: "none",
        sortDescFirst: true,
        cell: ({ row }) => (
          <FigureCell
            value={row.varianceHours}
            reasons={row.reasons}
            label="Not comparable"
            render={(value) => (
              <span
                className={
                  value > 0
                    ? "font-semibold text-danger-fg"
                    : value < 0
                      ? "font-semibold text-info-fg"
                      : ""
                }
              >
                {value > 0 ? "+" : ""}
                {hours(value)}
              </span>
            )}
          />
        ),
        toCsv: ({ row }) => row.varianceHours,
      },
      {
        id: "daysUnsupported",
        header: "Unsupported days",
        headerTooltip:
          "Days where claimed hours exceeded engine hours by more than 1 hour AND more than 1.15x. Both tolerances must be breached before a day is called unsupported.",
        accessor: "daysUnsupported",
        type: "number",
        align: "right",
        width: 165,
        aggregate: "sum",
        sortDescFirst: true,
        cell: ({ row }) => (
          <span
            className={row.daysUnsupported > 0 ? "font-semibold tabular-nums text-danger-fg" : "tabular-nums"}
          >
            {row.daysUnsupported}
          </span>
        ),
      },
      {
        id: "gaps",
        header: "Not comparable",
        headerTooltip:
          "Days the reconciliation could not run on: no telematics, or no plant sheet. These are never counted as variance.",
        accessor: (row) => row.daysWithoutTelematics + row.daysWithoutManual,
        type: "custom",
        align: "right",
        width: 165,
        aggregate: "none",
        cell: ({ row }) => (
          <span className="flex items-center justify-end gap-1">
            {row.daysWithoutTelematics > 0 ? (
              <Tooltip content="Days on which hours were claimed and the feed was silent. Absence of a reading is absence of a reading — it is not evidence of an overclaim.">
                <span>
                  <Badge tone="neutral" size="xs" variant="outline">
                    {row.daysWithoutTelematics} no feed
                  </Badge>
                </span>
              </Tooltip>
            ) : null}
            {row.daysWithoutManual > 0 ? (
              <Tooltip content="Days on which the machine ran and nobody filled in a plant sheet. Not a variance in money terms, but it is missing evidence.">
                <span>
                  <Badge tone="warning" size="xs" variant="outline">
                    {row.daysWithoutManual} no sheet
                  </Badge>
                </span>
              </Tooltip>
            ) : null}
            {row.daysWithoutTelematics === 0 && row.daysWithoutManual === 0 ? (
              <span className="text-content-subtle">—</span>
            ) : null}
          </span>
        ),
      },
      {
        id: "valueAtRisk",
        header: "Value at risk",
        headerTooltip:
          "The unsupported hours priced at the machine's recorded hourly rates. Null where no hourly rate exists — the hours are still unsupported, the money simply cannot be stated.",
        accessor: "valueAtRisk",
        type: "custom",
        align: "right",
        width: 165,
        aggregate: "none",
        sortDescFirst: true,
        cell: ({ row }) => (
          <FigureCell
            value={row.valueAtRisk}
            reasons={row.reasons}
            className="font-semibold text-danger-fg"
            render={(value) => money(value, row.currency)}
          />
        ),
        toCsv: ({ row }) => (row.valueAtRisk === null ? "" : `${row.valueAtRisk} ${row.currency}`),
      },
      {
        id: "persistent",
        header: "Pattern",
        accessor: (row) => (row.persistent ? "yes" : "no"),
        type: "enum",
        width: 140,
        options: [
          { value: "yes", label: "Persistent", text: "Persistent", tone: "danger" },
          { value: "no", label: "Not persistent", text: "Not persistent" },
        ],
        cell: ({ row }) =>
          row.persistent ? (
            <Tooltip content="The variance recurs across enough days to not be noise. A persistent variance raises a signal for the assurance layer.">
              <span>
                <Badge tone="danger" size="xs" dot>
                  Persistent
                </Badge>
              </span>
            </Tooltip>
          ) : (
            <span className="text-2xs text-content-subtle">single days</span>
          ),
      },
    ],
    [],
  );

  if (report.error) return <LoadError message={report.error} onRetry={report.reload} />;
  if (report.loading && !data) return <SkeletonTable rows={8} columns={8} />;
  if (!data) return null;

  const from = data.from ?? data.periodStart ?? "";
  const to = data.to ?? data.periodEnd ?? "";
  const expandedRow = rows.find((row) => row.equipmentId === expanded) ?? null;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3">
          <SectionHeading
            title="Manual hours against engine hours"
            hint="Two independent accounts of the same day, produced by parties who do not share a pathway. That is exactly why the difference is worth something."
            className="mb-0"
            actions={
              <label className="flex items-center gap-2">
                <span className="text-label uppercase tracking-wide text-content-subtle">
                  Window
                </span>
                <Select
                  size="sm"
                  value={String(days)}
                  onChange={(event) => onDays(Number(event.target.value))}
                  aria-label="Reconciliation window"
                >
                  {WINDOWS.map((value) => (
                    <option key={value} value={value}>
                      Last {value} days
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
            <Badge tone={data.machinesWithVariance > 0 ? "warning" : "success"} size="sm" dot>
              {data.machinesWithVariance} with variance
            </Badge>
            <Badge tone={data.machinesPersistent > 0 ? "danger" : "neutral"} size="sm" dot={data.machinesPersistent > 0}>
              {data.machinesPersistent} persistent
            </Badge>
            <span className="text-meta text-content-muted">
              {from} to {to} · {data.totals.daysCompared} comparable day
              {data.totals.daysCompared === 1 ? "" : "s"}
            </span>
          </div>
          <p className="text-2xs text-content-muted">{data.method}</p>
        </CardBody>
      </Card>

      <CurrencyRail
        buckets={valueBuckets}
        label="Value at risk"
        note={data.currencyNote}
        tone="danger"
      />

      {data.machinesPersistent > 0 ? (
        <Alert
          tone="warning"
          title={`${data.machinesPersistent} machine${data.machinesPersistent === 1 ? " has" : "s have"} a persistent unexplained variance`}
        >
          A persistent variance is not proof of a false claim. A counter can be reset, a machine can
          be worked with the ignition off the clock, and a plant sheet can be honestly wrong. It is
          the question to ask — and the answer is worth having before the hire invoice is
          certified, not after.
        </Alert>
      ) : null}

      {chartRows.length > 1 ? (
        <ChartCard
          title="Claimed against the machine"
          subtitle="Hours per machine over the window, comparable days only"
          icon={IconZap}
          footnote="Days with no telematics and days with no plant sheet are excluded from both bars — they are not comparable, and adding a zero for them would tilt every machine towards an overclaim."
        >
          <GroupedBarChart
            data={chartRows}
            categoryKey="machine"
            series={[
              { key: "claimed", label: "Claimed on plant sheets" },
              { key: "engine", label: "Engine hours" },
            ]}
            valueFormat="hours"
            ariaLabel="Claimed hours against engine hours per machine"
            height={280}
          />
        </ChartCard>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={IconZap}
          title="Nothing to reconcile on this project"
          hint={
            data.method ||
            "No plant has been assigned to this project and no utilisation has been recorded, so there are no two accounts of a day to compare."
          }
        />
      ) : (
        <>
          <DataTable<EquipmentReconciliation>
            tableId="equipment-telematics"
            data={rows}
            columns={columns}
            getRowId={(row) => row.equipmentId}
            loading={report.loading}
            height={Math.min(520, 140 + rows.length * 40)}
            stickyHeader
            gridLines
            filterRow
            exportFileName="telematics-reconciliation"
            searchPlaceholder="Search machines…"
            defaultSort={[{ id: "valueAtRisk", desc: true }]}
            rowTone={(row) => (row.persistent ? ("danger" as Tone) : undefined)}
            onRowClick={({ row }) => setExpanded(row.equipmentId)}
            rowActions={(row) => [
              { id: "days", label: "Show the days", onSelect: () => setExpanded(row.equipmentId) },
              {
                id: "open",
                label: "Open the machine",
                onSelect: () => onOpenMachine(row.equipmentId),
              },
            ]}
            empty={{ title: "No machines to reconcile" }}
            aria-label="Telematics reconciliation by machine"
          />

          {expandedRow ? (
            <DayBreakdown
              row={expandedRow}
              onClose={() => setExpanded(null)}
              onOpenMachine={onOpenMachine}
            />
          ) : (
            <p className="text-2xs text-content-subtle">
              Select a machine to see its day-by-day comparison, including the days the
              reconciliation declined to run on and why.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The day grid — the honest part. Every day is one of five classifications and
 * the two that are absence-of-evidence are drawn as NOT COMPARABLE with the
 * engine's reason, never as a zero variance.
 */
function DayBreakdown({
  row,
  onClose,
  onOpenMachine,
}: {
  row: EquipmentReconciliation;
  onClose: () => void;
  onOpenMachine: (equipmentId: string) => void;
}) {
  const columns = useMemo<DataColumns<DayVariance>>(
    () => [
      { id: "date", header: "Date", accessor: "date", type: "date", sticky: "start", width: 120 },
      {
        id: "classification",
        header: "Comparison",
        accessor: "classification",
        type: "enum",
        width: 175,
        groupable: true,
        options: (
          Object.keys(VARIANCE_CLASS_LABEL) as Array<DayVariance["classification"]>
        ).map((value) => ({
          value,
          label: VARIANCE_CLASS_LABEL[value],
          text: VARIANCE_CLASS_LABEL[value],
          tone: dayTone(value),
        })),
        cell: ({ row: day }) =>
          NOT_COMPARABLE_CLASSES.has(day.classification) ? (
            <NotComparable reason={day.reason} label={VARIANCE_CLASS_LABEL[day.classification]} />
          ) : (
            <Badge tone={dayTone(day.classification) ?? "neutral"} size="xs" dot>
              {VARIANCE_CLASS_LABEL[day.classification]}
            </Badge>
          ),
      },
      {
        id: "manualWorkingHours",
        header: "Claimed",
        accessor: "manualWorkingHours",
        type: "custom",
        align: "right",
        width: 120,
        aggregate: "none",
        cell: ({ row: day }) =>
          day.manualWorkingHours === null ? (
            <Tooltip content="No plant sheet exists for this machine on this day. That is a missing record, not zero hours claimed.">
              <span className="text-2xs text-content-subtle italic">no sheet</span>
            </Tooltip>
          ) : (
            <span className="tabular-nums">{hours(day.manualWorkingHours)}</span>
          ),
      },
      {
        id: "telematicsEngineHours",
        header: "Engine",
        accessor: "telematicsEngineHours",
        type: "custom",
        align: "right",
        width: 120,
        aggregate: "none",
        cell: ({ row: day }) =>
          day.telematicsEngineHours === null ? (
            <NotComparable
              reason={
                (day.telematicsReasons ?? []).join(" ") ||
                "The feed cannot state engine hours for this day. Engine hours are a cumulative counter: no reading, one reading with no interval to measure, or a counter that fell all yield null rather than zero."
              }
              label="Feed silent"
            />
          ) : (
            <span className="tabular-nums">{hours(day.telematicsEngineHours)}</span>
          ),
      },
      {
        id: "varianceHours",
        header: "Variance",
        accessor: "varianceHours",
        type: "custom",
        align: "right",
        width: 130,
        aggregate: "none",
        cell: ({ row: day }) =>
          day.varianceHours === null ? (
            <NotComparable reason={day.reason} />
          ) : (
            <span
              className={
                day.varianceHours > 0
                  ? "font-semibold tabular-nums text-danger-fg"
                  : day.varianceHours < 0
                    ? "font-semibold tabular-nums text-info-fg"
                    : "tabular-nums"
              }
            >
              {day.varianceHours > 0 ? "+" : ""}
              {hours(day.varianceHours)}
            </span>
          ),
      },
      {
        id: "ratio",
        header: "Ratio",
        accessor: "ratio",
        type: "custom",
        align: "right",
        width: 105,
        aggregate: "none",
        cell: ({ row: day }) =>
          day.ratio === null ? (
            <span className="text-content-subtle">—</span>
          ) : (
            <span className="tabular-nums">{day.ratio.toFixed(2)}×</span>
          ),
      },
      {
        id: "reason",
        header: "What the engine says",
        accessor: "reason",
        type: "text",
        width: 460,
        truncate: false,
        cell: ({ row: day }) => (
          <span className="block whitespace-normal py-1 text-meta text-content-muted">
            {day.reason}
          </span>
        ),
      },
    ],
    [],
  );

  const notComparable = row.days.filter((day) => day.varianceHours === null).length;

  return (
    <Card>
      <CardBody className="space-y-3">
        <SectionHeading
          title={
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{row.reference}</span>
              <span>{row.name}</span>
              {row.persistent ? (
                <Badge tone="danger" size="xs" dot>
                  Persistent variance
                </Badge>
              ) : null}
            </span>
          }
          hint={`${row.days.length} day(s) in the window · ${row.daysCompared} comparable · ${notComparable} not comparable · ${row.daysUnsupported} unsupported`}
          className="mb-0"
          actions={
            <span className="flex items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => onOpenMachine(row.equipmentId)}>
                Open the machine
              </Button>
              <Button size="sm" variant="ghost" onClick={onClose}>
                Close
              </Button>
            </span>
          }
        />

        {row.reasons.length > 0 ? (
          <div className="rounded-lg border border-border bg-surface-sunken p-3">
            <p className="mb-1.5 text-label uppercase tracking-wide text-content-subtle">
              Why some figures on this machine are null
            </p>
            <ReasonList reasons={row.reasons} />
          </div>
        ) : null}

        <DataTable<DayVariance>
          tableId="equipment-telematics-days"
          data={row.days}
          columns={columns}
          getRowId={(day) => `${row.equipmentId}:${day.date}`}
          height={Math.min(460, 120 + row.days.length * 44)}
          stickyHeader
          gridLines
          rowHeight={52}
          toolbar={false}
          rowTone={(day) => (day.classification === "unsupported_hours" ? ("danger" as Tone) : undefined)}
          empty={{
            title: "No days in the window",
            description: "Neither a plant sheet nor a telematics reading exists for this machine.",
          }}
          aria-label={`Day by day comparison for ${row.reference}`}
        />
      </CardBody>
    </Card>
  );
}

function dayTone(classification: DayVariance["classification"]): Tone | undefined {
  switch (classification) {
    case "unsupported_hours":
      return "danger";
    case "under_reported":
      return "info";
    case "ok":
      return "success";
    default:
      return "neutral";
  }
}
