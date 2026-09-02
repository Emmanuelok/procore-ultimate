/**
 * CLAIMED AGAINST PRESENT — the reconciliation this module exists for.
 *
 * Two findings, kept deliberately apart, because conflating them is how a
 * control gets switched off:
 *
 *   OVERCLAIM PATTERN  repeated unexplained positive variance against access
 *                      records that DO exist. A finding about the claim.
 *   ACCESS GAP         repeated absence of any access record at all. A finding
 *                      about the turnstile feed, raised at low severity and
 *                      worded so nobody reads it as an accusation.
 *
 * Every figure on this page distinguishes days that were COMPARED from days
 * that were NOT COMPARABLE. A worker with 5 days claimed and no gate records at
 * all has an unknown variance, not a 40-hour overclaim, and this screen will
 * never render the second.
 */
import { useMemo } from "react";
import {
  Alert,
  Badge,
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
import { IconAudit, IconWarning } from "../../ui/icons";
import {
  LoadError,
  NotComparable,
  SectionHeading,
  VarianceCell,
  hoursText,
  labelize,
  signedHours,
  type Loadable,
  type ReconciliationReport,
  type VarianceRow,
  type WorkerVariancePattern,
} from "./timecardsShared";

const WINDOWS = [7, 14, 30, 60, 90];

export default function ReconcileTab({
  report,
  windowDays,
  onWindowDays,
  onOpenCard,
}: {
  report: Loadable<ReconciliationReport>;
  windowDays: number;
  onWindowDays: (days: number) => void;
  onOpenCard: (timecardId: string) => void;
}) {
  const data = report.data;
  const workers = useMemo(() => data?.workers ?? [], [data]);
  const rows = useMemo(() => data?.rows ?? [], [data]);

  const patterns = workers.filter((worker) => worker.isOverclaimPattern);
  const gaps = workers.filter((worker) => worker.isAccessGap);

  const chartRows = useMemo(
    () =>
      workers
        .filter((worker) => worker.daysCompared > 0)
        .slice(0, 14)
        .map((worker) => ({
          worker: worker.workerReference,
          claimed: worker.claimedHours,
          present: worker.accessHours,
        })),
    [workers],
  );

  const workerColumns = useMemo<DataColumns<WorkerVariancePattern>>(
    () => [
      {
        id: "workerReference",
        header: "Worker",
        accessor: "workerReference",
        type: "code",
        sticky: "start",
        width: 118,
        mono: true,
      },
      { id: "workerName", header: "Name", accessor: "workerName", type: "text", width: 200 },
      {
        id: "finding",
        header: "Finding",
        accessor: (row) =>
          row.isOverclaimPattern ? "overclaim" : row.isAccessGap ? "gap" : "none",
        type: "enum",
        width: 190,
        groupable: true,
        options: [
          { value: "overclaim", label: "Overclaim pattern", text: "Overclaim pattern", tone: "danger" },
          { value: "gap", label: "Access gap", text: "Access gap", tone: "warning" },
          { value: "none", label: "Nothing found", text: "Nothing found", tone: "success" },
        ],
        cell: ({ row }) => (
          <Tooltip content={<span className="block max-w-sm">{row.reason}</span>}>
            <span>
              {row.isOverclaimPattern ? (
                <Badge tone="danger" size="xs" dot>
                  Overclaim pattern
                </Badge>
              ) : row.isAccessGap ? (
                <Badge tone="warning" size="xs" dot>
                  Access gap
                </Badge>
              ) : (
                <Badge tone="success" size="xs" variant="outline">
                  Nothing found
                </Badge>
              )}
            </span>
          </Tooltip>
        ),
      },
      {
        id: "daysCompared",
        header: "Compared",
        headerTooltip: "Days where a usable access record exists, so the comparison could run.",
        accessor: "daysCompared",
        type: "number",
        align: "right",
        width: 120,
        aggregate: "sum",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.daysCompared}
            <span className="text-content-subtle"> / {row.days}</span>
          </span>
        ),
      },
      {
        id: "daysWithoutAccessRecord",
        header: "Not comparable",
        headerTooltip:
          "Days with NO access record at all. Never counted as an overclaim: absence of a turnstile record is absence of evidence, not evidence of absence.",
        accessor: "daysWithoutAccessRecord",
        type: "custom",
        align: "right",
        width: 165,
        aggregate: "none",
        cell: ({ row }) =>
          row.daysWithoutAccessRecord === 0 ? (
            <span className="text-content-subtle">—</span>
          ) : (
            <NotComparable
              reason={`${row.daysWithoutAccessRecord} of this worker's ${row.days} day(s) in the window carry no site-access record, so the hours actually present on those days are unknown. They contribute nothing to the variance figures on this row.`}
              label={`${row.daysWithoutAccessRecord} day${row.daysWithoutAccessRecord === 1 ? "" : "s"}`}
              tone={row.isAccessGap ? "warning" : "neutral"}
            />
          ),
      },
      {
        id: "claimedHours",
        header: "Claimed",
        accessor: "claimedHours",
        type: "custom",
        align: "right",
        width: 115,
        aggregate: "none",
        cell: ({ row }) => <span className="tabular-nums">{hoursText(row.claimedHours, 1)}</span>,
      },
      {
        id: "accessHours",
        header: "Present",
        headerTooltip: "Hours present on the COMPARABLE days only.",
        accessor: "accessHours",
        type: "custom",
        align: "right",
        width: 115,
        aggregate: "none",
        cell: ({ row }) => <span className="tabular-nums">{hoursText(row.accessHours, 1)}</span>,
      },
      {
        id: "unexplainedOverHours",
        header: "Unexplained over",
        accessor: "unexplainedOverHours",
        type: "custom",
        align: "right",
        width: 170,
        aggregate: "none",
        sortDescFirst: true,
        cell: ({ row }) =>
          row.unexplainedOverHours <= 0 ? (
            <span className="text-content-subtle">—</span>
          ) : (
            <span className="font-semibold tabular-nums text-danger-fg">
              {hoursText(row.unexplainedOverHours, 1)}
              <span className="ml-1 text-2xs font-normal text-content-subtle">
                over {row.unexplainedOverDays} day{row.unexplainedOverDays === 1 ? "" : "s"}
              </span>
            </span>
          ),
      },
      {
        id: "explainedOverDays",
        header: "Explained days",
        accessor: "explainedOverDays",
        type: "number",
        align: "right",
        width: 145,
        aggregate: "sum",
        defaultHidden: true,
      },
      {
        id: "underHours",
        header: "Under",
        headerTooltip:
          "Hours present exceeding hours claimed. Unbilled time — or somebody on site who was not working for us.",
        accessor: "underHours",
        type: "custom",
        align: "right",
        width: 115,
        aggregate: "none",
        defaultHidden: true,
        cell: ({ row }) => <span className="tabular-nums">{hoursText(row.underHours, 1)}</span>,
      },
    ],
    [],
  );

  const dayColumns = useMemo<DataColumns<VarianceRow>>(
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
      { id: "workerName", header: "Worker", accessor: "workerName", type: "text", width: 190 },
      { id: "shift", header: "Shift", accessor: "shift", type: "enum", width: 100 },
      {
        id: "claimedHours",
        header: "Claimed",
        accessor: "claimedHours",
        type: "custom",
        align: "right",
        width: 110,
        aggregate: "sum",
        cell: ({ row }) => <span className="tabular-nums">{hoursText(row.claimedHours, 1)}</span>,
      },
      {
        id: "accessHours",
        header: "Present",
        accessor: "accessHours",
        type: "custom",
        align: "right",
        width: 150,
        aggregate: "none",
        cell: ({ row }) =>
          row.accessHours === null ? (
            <NotComparable
              reason={
                row.reasons[0] ??
                "No usable site-access record for this worker on this date. Hours present are unknown, not zero."
              }
              label="No record"
            />
          ) : (
            <span className="tabular-nums">{hoursText(row.accessHours, 1)}</span>
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
            reasons={row.reasons}
            explained={row.explained}
          />
        ),
      },
      {
        id: "explanation",
        header: "Explanation",
        accessor: (row) => row.explanation ?? "",
        type: "text",
        width: 340,
        truncate: false,
        cell: ({ row }) =>
          row.explanation ? (
            <span className="block whitespace-normal py-1 text-meta text-content-muted">
              {row.explanation}
            </span>
          ) : row.varianceHours === null ? (
            <span className="text-2xs text-content-subtle italic">
              nothing to explain — the comparison could not run
            </span>
          ) : (
            <span className="text-2xs text-content-subtle italic">none recorded</span>
          ),
      },
    ],
    [],
  );

  if (report.error) return <LoadError message={report.error} onRetry={report.reload} />;
  if (report.loading && !data) return <SkeletonTable rows={8} columns={7} />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3">
          <SectionHeading
            title="Claimed against present"
            hint="Every card's hours against the turnstile stream — independent evidence, as opposed to a foreman's crew sheet, which is the claimant's own assertion. This read replays the engine; it never writes."
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
                  aria-label="Reconciliation window"
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
              {data.timecards} card{data.timecards === 1 ? "" : "s"}
            </Badge>
            <Badge tone="info" size="sm" dot>
              {data.compared} compared
            </Badge>
            <Tooltip content="Cards with no usable site-access record. These are excluded from every variance figure on this page — they are a gap in the evidence stream, not an overclaim.">
              <span>
                <Badge tone="neutral" size="sm" variant="outline">
                  {data.withoutAccessRecord} not comparable
                </Badge>
              </span>
            </Tooltip>
            <Badge tone={data.overclaimPatterns > 0 ? "danger" : "success"} size="sm" dot>
              {data.overclaimPatterns} overclaim pattern
              {data.overclaimPatterns === 1 ? "" : "s"}
            </Badge>
            <Badge tone={data.accessGaps > 0 ? "warning" : "neutral"} size="sm" dot={data.accessGaps > 0}>
              {data.accessGaps} access gap{data.accessGaps === 1 ? "" : "s"}
            </Badge>
            <span className="text-2xs text-content-subtle">
              {data.periodStart} to {data.periodEnd}
            </span>
          </div>
          <p className="text-2xs text-content-muted">
            Tolerance ±{data.toleranceHours} h per day. A pattern needs{" "}
            {data.thresholds.overclaimMinDays} unexplained day(s) and{" "}
            {data.thresholds.overclaimMinHours} unexplained hour(s) in the window; an access gap is
            raised at {data.thresholds.accessGapMinDays} day(s) with no record at all. The two
            thresholds are separate on purpose — one is a finding about a claim, the other about a
            feed.
          </p>
        </CardBody>
      </Card>

      {patterns.length > 0 ? (
        <Alert
          tone="danger"
          icon={IconWarning}
          title={`${patterns.length} worker${patterns.length === 1 ? "" : "s"} show a pattern of unexplained overclaim`}
        >
          A single day above tolerance is noise: a mis-keyed hour, a gate someone walked round. A
          repeated, unexplained pattern against records that DO exist is the finding this
          reconciliation exists to produce. Each row below carries the engine&rsquo;s own sentence.
        </Alert>
      ) : null}

      {gaps.length > 0 ? (
        <Alert
          tone="warning"
          title={`${gaps.length} worker${gaps.length === 1 ? " has" : "s have"} too little access data to conclude anything`}
        >
          This is a finding about the TURNSTILE FEED, not about the workers. Repeated days with no
          access record mean the reconciliation cannot run — and it is deliberately not dressed up
          as an overclaim. Fix the feed and the control starts working again; report it as fraud and
          the control gets switched off inside a month, after which the real overclaims go unseen
          too.
        </Alert>
      ) : null}

      {chartRows.length > 1 ? (
        <ChartCard
          title="Claimed against present"
          subtitle="Hours per worker over the window, comparable days only"
          icon={IconAudit}
          footnote="Days with no site-access record are excluded from BOTH bars. Including them as zero present would tilt every worker towards an overclaim and turn a broken turnstile into a fraud finding."
        >
          <GroupedBarChart
            data={chartRows}
            categoryKey="worker"
            series={[
              { key: "claimed", label: "Claimed on cards" },
              { key: "present", label: "Present at the gate" },
            ]}
            valueFormat="hours"
            ariaLabel="Claimed hours against hours present per worker"
            height={280}
          />
        </ChartCard>
      ) : null}

      {workers.length === 0 ? (
        <EmptyState
          icon={IconAudit}
          title="No cards in this window to reconcile"
          hint={`No timecard was raised on this project between ${data.periodStart} and ${data.periodEnd}, so there is nothing to compare against the gate log. That is a statement about the crew sheets, not about who was on site.`}
        />
      ) : (
        <>
          <div>
            <SectionHeading
              title="By worker"
              hint="Each row carries the engine's own conclusion, including its refusal to conclude."
            />
            <DataTable<WorkerVariancePattern>
              tableId="timecards-reconcile-workers"
              data={workers}
              columns={workerColumns}
              getRowId={(row) => row.workerId}
              loading={report.loading}
              height={Math.min(480, 140 + workers.length * 40)}
              stickyHeader
              gridLines
              filterRow
              exportFileName="timecard-reconciliation"
              searchPlaceholder="Search workers…"
              defaultSort={[{ id: "unexplainedOverHours", desc: true }]}
              rowTone={(row) =>
                row.isOverclaimPattern
                  ? ("danger" as Tone)
                  : row.isAccessGap
                    ? ("warning" as Tone)
                    : undefined
              }
              empty={{ title: "No workers in this window" }}
              aria-label="Reconciliation by worker"
            />
          </div>

          <div>
            <SectionHeading
              title="Day by day"
              hint="Every card in the window, including the ones the comparison declined to run on."
            />
            <DataTable<VarianceRow>
              tableId="timecards-reconcile-days"
              data={rows}
              columns={dayColumns}
              getRowId={(row) => row.timecardId}
              loading={report.loading}
              height={520}
              stickyHeader
              gridLines
              filterRow
              showFooter
              rowHeight={48}
              exportFileName="timecard-variance-days"
              searchPlaceholder="Search cards…"
              defaultSort={[{ id: "workDate", desc: true }]}
              rowTone={(row) =>
                row.varianceHours !== null && row.varianceHours > 0.5 && !row.explained
                  ? ("danger" as Tone)
                  : undefined
              }
              onRowClick={({ row }) => onOpenCard(row.timecardId)}
              rowActions={(row) => [
                { id: "open", label: "Open the card", onSelect: () => onOpenCard(row.timecardId) },
              ]}
              empty={{ title: "No cards in this window" }}
              aria-label="Day by day variance"
            />
            <p className="mt-2 text-2xs text-content-subtle">
              The footer sums CLAIMED hours only. Present hours and variance carry no total, because
              a total across days that were not comparable would be a different quantity on each
              row — and reporting it as one number is exactly the shortcut that turns a data gap
              into an accusation.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/** Kept for the export surface: the engine's own words on one worker. */
export function WorkerReason({ worker }: { worker: WorkerVariancePattern }) {
  return (
    <p className="text-meta text-content-muted">
      {worker.workerReference} {worker.workerName}: {worker.reason}{" "}
      {worker.daysWithoutAccessRecord > 0
        ? `(${worker.daysWithoutAccessRecord} day(s) had no access record and contributed nothing — ${signedHours(
            0,
          )} is never assumed for them.)`
        : ""}
      {worker.vendorId ? ` Employer ${labelize(worker.vendorId)}.` : ""}
    </p>
  );
}
