/**
 * IDLE HIRED PLANT STILL ON HIRE — the thing on this project that is costing
 * money right now for nothing in return.
 *
 * A plant register that lists machines answers "what have we got". It does not
 * answer the only question that costs money: what are we paying for that is
 * not working. So this tab leads with the accumulated standing cost of the
 * TRAILING idle run — the run that is still running — because "the 30-tonner
 * has stood for nine days" is an observation and "the 30-tonne excavator has
 * cost £6,300 standing since the 4th" is a decision.
 *
 * Two honesty rules are visible on every row:
 *
 *  · A machine with no usable hire rate shows its standing cost as NOT
 *    AVAILABLE with the engine's reason, never as £0. A zero would read as
 *    "free", and free is the one thing idle hired plant is not.
 *  · Utilisation that could not be computed is null with a reason, not 0%.
 *    0% reads as "stood all week"; "we do not know" is a different fact.
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
import { DataTable, type DataColumns } from "../../ui/data";
import { ChartCard, GroupedBarChart } from "../../ui/charts";
import type { Tone } from "../../ui/tokens";
import { IconEquipment, IconRefresh } from "../../ui/icons";
import {
  CurrencyRail,
  FigureCell,
  IDLE_REASON_LABEL,
  LoadError,
  OWNERSHIP_LABEL,
  ReasonList,
  SectionHeading,
  bucketsOf,
  hours,
  isoDate,
  labelize,
  money,
  percent,
  utilisationTone,
  type IdlePlantAssessment,
  type IdleQuery,
  type IdleReport,
  type Loadable,
  type Scope,
} from "./equipmentShared";

const WINDOWS = [7, 14, 30, 60, 90];
const THRESHOLDS = [10, 20, 30, 40, 50];
const SUSTAINED = [2, 3, 5, 7, 10];

export default function IdleTab({
  report,
  scope,
  query,
  onQuery,
  onOpenMachine,
}: {
  report: Loadable<IdleReport>;
  scope: Scope;
  query: IdleQuery;
  onQuery: (next: IdleQuery) => void;
  onOpenMachine: (equipmentId: string) => void;
}) {
  const data = report.data;

  const flagged = useMemo(
    () => (data?.items ?? []).filter((row) => row.isIdleOnHire),
    [data],
  );
  const notFlagged = useMemo(
    () => (data?.items ?? []).filter((row) => !row.isIdleOnHire),
    [data],
  );

  const costBuckets = useMemo(() => bucketsOf(data?.idleCostByCurrency), [data]);

  /** One bar pair per flagged machine: idle-run cost against whole-window
   *  cost, in ONE currency only — the chart never mixes them. */
  const chartCurrency = costBuckets[0]?.currency ?? null;
  const chartRows = useMemo(() => {
    if (!chartCurrency) return [];
    return flagged
      .filter((row) => row.currency === chartCurrency && row.idleCost !== null)
      .slice(0, 12)
      .map((row) => ({
        machine: row.reference,
        idleRun: row.idleCost ?? 0,
        window: row.windowCost ?? 0,
      }));
  }, [flagged, chartCurrency]);

  const columns = useMemo<DataColumns<IdlePlantAssessment>>(
    () => [
      {
        id: "reference",
        header: "Plant",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 122,
        mono: true,
      },
      { id: "name", header: "Machine", accessor: "name", type: "text", width: 230 },
      {
        id: "ownership",
        header: "Held as",
        accessor: "ownership",
        type: "enum",
        width: 140,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone="neutral" size="xs" variant="outline">
            {OWNERSHIP_LABEL[row.ownership] ?? labelize(row.ownership)}
          </Badge>
        ),
      },
      {
        id: "utilisationPercent",
        header: "Utilisation",
        headerTooltip:
          "Working hours over the available window across the whole period. Travel counts in the denominator and not the numerator.",
        accessor: "utilisationPercent",
        type: "custom",
        align: "right",
        width: 130,
        aggregate: "none",
        sortDescFirst: false,
        cell: ({ row }) => (
          <FigureCell
            value={row.utilisationPercent}
            reasons={row.reasons}
            render={(value) => (
              <span
                className={
                  utilisationTone(value) === "danger"
                    ? "font-semibold text-danger-fg"
                    : utilisationTone(value) === "warning"
                      ? "font-semibold text-warning-fg"
                      : ""
                }
              >
                {percent(value)}
              </span>
            )}
          />
        ),
        toCsv: ({ row }) => row.utilisationPercent,
      },
      {
        id: "consecutiveLowDays",
        header: "Standing run",
        headerTooltip:
          "The TRAILING run of low-utilisation days — the run that is still going on. Scattered low days across a month are a sequencing problem, not an off-hire one.",
        accessor: "consecutiveLowDays",
        type: "number",
        align: "right",
        width: 130,
        aggregate: "none",
        sortDescFirst: true,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.consecutiveLowDays} of {row.daysRecorded} d
          </span>
        ),
      },
      {
        id: "idleCost",
        header: "Cost of the run",
        headerTooltip:
          "What this machine has cost standing since the run began. This is the number an off-hire request stops.",
        accessor: "idleCost",
        type: "custom",
        align: "right",
        width: 165,
        aggregate: "none",
        sortDescFirst: true,
        cell: ({ row }) => (
          <FigureCell
            value={row.idleCost}
            reasons={row.reasons}
            className="font-semibold text-danger-fg"
            render={(value) => money(value, row.currency)}
          />
        ),
        toCsv: ({ row }) => (row.idleCost === null ? "" : `${row.idleCost} ${row.currency}`),
      },
      {
        id: "windowCost",
        header: "Cost of the window",
        accessor: "windowCost",
        type: "custom",
        align: "right",
        width: 165,
        aggregate: "none",
        defaultHidden: true,
        cell: ({ row }) => (
          <FigureCell
            value={row.windowCost}
            reasons={row.reasons}
            render={(value) => money(value, row.currency)}
          />
        ),
      },
      {
        id: "workingHours",
        header: "Worked",
        accessor: "workingHours",
        type: "custom",
        align: "right",
        width: 110,
        aggregate: "none",
        cell: ({ row }) => <span className="tabular-nums">{hours(row.workingHours)}</span>,
      },
      {
        id: "idleHours",
        header: "Stood",
        accessor: "idleHours",
        type: "custom",
        align: "right",
        width: 110,
        aggregate: "none",
        cell: ({ row }) => <span className="tabular-nums">{hours(row.idleHours)}</span>,
      },
      {
        id: "idleReasons",
        header: "Site says",
        headerTooltip:
          "The idle reasons recorded on the plant sheets, most frequent first. This is the field that turns a cost into an action — 'awaiting materials' and 'weather' are different conversations.",
        accessor: (row) => row.idleReasons.join(", "),
        type: "text",
        width: 220,
        cell: ({ row }) =>
          row.idleReasons.length === 0 ? (
            <span className="text-content-subtle italic">nothing recorded</span>
          ) : (
            <span className="flex flex-wrap gap-1">
              {row.idleReasons.slice(0, 2).map((reason) => (
                <Badge key={reason} tone="warning" size="xs" variant="outline">
                  {IDLE_REASON_LABEL[reason] ?? labelize(reason)}
                </Badge>
              ))}
              {row.idleReasons.length > 2 ? (
                <Badge tone="neutral" size="xs">
                  +{row.idleReasons.length - 2}
                </Badge>
              ) : null}
            </span>
          ),
      },
      {
        id: "offHireRequestedAt",
        header: "Off-hire asked",
        accessor: (row) => row.offHireRequestedAt ?? "",
        type: "text",
        width: 160,
        cell: ({ row }) =>
          row.offHireRequestedAt ? (
            <Tooltip content="Off-hire was requested and the machine is still here. Chase collection, and check the invoice stops at the request date.">
              <span>
                <Badge tone="info" size="xs" dot>
                  Asked {isoDate(row.offHireRequestedAt)}
                </Badge>
              </span>
            </Tooltip>
          ) : (
            <span className="text-content-subtle italic">not requested</span>
          ),
      },
    ],
    [],
  );

  if (report.error) return <LoadError message={report.error} onRetry={report.reload} />;

  if (report.loading && !data) {
    return (
      <div className="space-y-4">
        <Card>
          <CardBody>
            <SkeletonTable rows={2} columns={4} header={false} />
          </CardBody>
        </Card>
        <SkeletonTable rows={8} columns={7} />
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-4">
      <Controls query={query} onQuery={onQuery} onReload={report.reload} loading={report.loading} />

      <CurrencyRail
        buckets={costBuckets}
        label="Standing cost of the idle runs"
        note={data.currencyNote}
        tone="danger"
      />

      <Card>
        <CardBody className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={data.flaggedCount > 0 ? "danger" : "success"} size="sm" dot>
              {data.flaggedCount} machine{data.flaggedCount === 1 ? "" : "s"} flagged
            </Badge>
            <span className="text-meta text-content-muted">
              {scope === "project" ? "on this project" : "across the company fleet"} ·{" "}
              {data.from} to {data.to} ({data.days} days)
            </span>
          </div>
          <p className="text-2xs text-content-muted">
            Criteria: {data.criteria}. Owned plant is excluded — it is already paid for, and the
            loss on an idle owned machine is opportunity, not invoice. A machine already off-hired
            is excluded too: the leak has stopped.
          </p>
        </CardBody>
      </Card>

      {chartCurrency && chartRows.length > 1 ? (
        <ChartCard
          title="What the standing runs have cost"
          subtitle={`Accumulated cost of the current idle run against the whole-window cost, ${chartCurrency} only`}
          icon={IconEquipment}
          footnote={
            costBuckets.length > 1
              ? `Only ${chartCurrency} plant is plotted. Machines hired in another currency are in the table below and are never added to these bars.`
              : "The idle-run bar is the cost that stops the day the machine goes back."
          }
        >
          <GroupedBarChart
            data={chartRows}
            categoryKey="machine"
            series={[
              { key: "idleRun", label: "Idle run to date" },
              { key: "window", label: "Whole window" },
            ]}
            valueFormat="currency"
            formatOptions={{ currency: chartCurrency }}
            ariaLabel={`Idle run cost against whole window cost per machine, in ${chartCurrency}`}
            height={260}
          />
        </ChartCard>
      ) : null}

      <div>
        <SectionHeading
          title="Flagged — hired, standing, still on hire"
          hint="Off-hire it, or record the decision to hold it and why the standby is worth the day rate. Nothing about the situation improves by waiting."
        />
        {flagged.length === 0 ? (
          <EmptyState
            icon={IconEquipment}
            tone="success"
            title="No hired plant is standing on this window"
            hint={`Every hired machine ${
              scope === "project" ? "on this project" : "in the fleet"
            } either worked above ${data.thresholdPercent}% of its available hours, or has already been off-hired, or was never on hire in the first place. The list is empty because the test found nothing, not because nothing was tested — ${data.criteria}.`}
          />
        ) : (
          <DataTable<IdlePlantAssessment>
            tableId="equipment-idle"
            data={flagged}
            columns={columns}
            getRowId={(row) => row.equipmentId}
            loading={report.loading}
            height={Math.min(560, 140 + flagged.length * 40)}
            stickyHeader
            gridLines
            filterRow
            exportFileName="idle-plant-on-hire"
            searchPlaceholder="Search flagged plant…"
            defaultSort={[{ id: "idleCost", desc: true }]}
            rowTone={() => "danger" as Tone}
            onRowClick={({ row }) => onOpenMachine(row.equipmentId)}
            rowActions={(row) => [
              {
                id: "open",
                label: "Open the machine",
                onSelect: () => onOpenMachine(row.equipmentId),
              },
            ]}
            empty={{ title: "Nothing flagged" }}
            aria-label="Idle hired plant"
          />
        )}
      </div>

      {query.includeAll && notFlagged.length > 0 ? (
        <div>
          <SectionHeading
            title="Not flagged, and why"
            hint="Every machine the assessment declined to flag, carrying the engine's own reason. A machine absent from a list is a claim about that machine, so the claim is shown."
          />
          <div className="space-y-2">
            {notFlagged.slice(0, 40).map((row) => (
              <Card key={row.equipmentId}>
                <CardBody className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenMachine(row.equipmentId)}
                      className="font-mono text-sm font-semibold text-accent-text hover:underline"
                    >
                      {row.reference}
                    </button>
                    <span className="truncate text-sm text-content">{row.name}</span>
                    <Badge tone="neutral" size="xs" variant="outline">
                      {OWNERSHIP_LABEL[row.ownership] ?? labelize(row.ownership)}
                    </Badge>
                    <span className="text-2xs text-content-subtle">
                      {row.daysRecorded} day(s) recorded · {row.lowDays} low ·{" "}
                      {row.utilisationPercent === null
                        ? "utilisation not computable"
                        : percent(row.utilisationPercent)}
                    </span>
                  </div>
                  <ReasonList reasons={row.reasons} />
                </CardBody>
              </Card>
            ))}
            {notFlagged.length > 40 ? (
              <p className="text-2xs text-content-subtle">
                {notFlagged.length - 40} further machine(s) not shown. Narrow the window or raise
                the threshold to see them.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Controls({
  query,
  onQuery,
  onReload,
  loading,
}: {
  query: IdleQuery;
  onQuery: (next: IdleQuery) => void;
  onReload: () => void;
  loading: boolean;
}) {
  return (
    <Card>
      <CardBody className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-label uppercase tracking-wide text-content-subtle">Window</span>
          <Select
            size="sm"
            value={String(query.days)}
            onChange={(event) => onQuery({ ...query, days: Number(event.target.value) })}
            aria-label="Assessment window in days"
          >
            {WINDOWS.map((days) => (
              <option key={days} value={days}>
                Last {days} days
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-label uppercase tracking-wide text-content-subtle">
            Idle at or below
          </span>
          <Select
            size="sm"
            value={String(query.thresholdPercent)}
            onChange={(event) =>
              onQuery({ ...query, thresholdPercent: Number(event.target.value) })
            }
            aria-label="Utilisation threshold"
          >
            {THRESHOLDS.map((value) => (
              <option key={value} value={value}>
                {value}% utilisation
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-label uppercase tracking-wide text-content-subtle">
            Sustained for
          </span>
          <Select
            size="sm"
            value={String(query.sustainedDays)}
            onChange={(event) => onQuery({ ...query, sustainedDays: Number(event.target.value) })}
            aria-label="Sustained days before flagging"
          >
            {SUSTAINED.map((value) => (
              <option key={value} value={value}>
                {value} consecutive day{value === 1 ? "" : "s"}
              </option>
            ))}
          </Select>
        </label>
        <Switch
          checked={query.includeAll}
          onChange={(next) => onQuery({ ...query, includeAll: next })}
          label="Show machines that were not flagged"
        />
        <Button
          size="sm"
          variant="ghost"
          icon={IconRefresh}
          loading={loading}
          onClick={onReload}
          className="ml-auto"
        >
          Re-assess
        </Button>
      </CardBody>
    </Card>
  );
}
