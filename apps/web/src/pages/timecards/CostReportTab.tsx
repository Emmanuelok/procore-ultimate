/**
 * LABOUR ON THE COST REPORT — allocated hours against the budget lines they
 * were coded to.
 *
 * Three buckets, reported separately because they are three different
 * problems:
 *
 *   ON BUDGET    coded to a budget line — the good case; these hours reach the
 *                cost report.
 *   OFF BUDGET   coded to a cost code with no budget line — visible in a
 *                labour report, invisible on the budget.
 *   UNCODED      not coded at all — invisible until month end, when it arrives
 *                as an unexplained labour overrun with nothing to attribute it
 *                to.
 *
 * This report does NOT write the budget's direct-cost column. The budget
 * module owns that, and a cost report with two authors has no author at all.
 * What it guarantees instead is that the figure the budget posts is derivable,
 * exact and attributable to individual cards.
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
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tooltip,
  Tr,
} from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { ChartCard, StackedBarChart } from "../../ui/charts";
import type { Tone } from "../../ui/tokens";
import { IconCost, IconWarning } from "../../ui/icons";
import {
  FigureCell,
  LoadError,
  ReasonList,
  SectionHeading,
  hoursText,
  labelize,
  money,
  type CostReportLine,
  type LabourCostReport,
  type Loadable,
} from "./timecardsShared";

const WINDOWS = [7, 14, 30, 60, 90];

export default function CostReportTab({
  report,
  windowDays,
  onWindowDays,
  onOpenCard,
}: {
  report: Loadable<LabourCostReport>;
  windowDays: number;
  onWindowDays: (days: number) => void;
  onOpenCard: (timecardId: string) => void;
}) {
  const data = report.data;
  const lines = useMemo(() => data?.lines ?? [], [data]);

  const chartRows = useMemo(
    () =>
      lines.slice(0, 14).map((line) => ({
        code: line.costCode ?? line.costCodeId ?? "uncoded",
        plain: line.regularHours,
        overtime: line.overtimeHours,
        double: line.doubleTimeHours,
        premium: line.premiumHours,
      })),
    [lines],
  );

  const columns = useMemo<DataColumns<CostReportLine>>(
    () => [
      {
        id: "costCode",
        header: "Cost code",
        accessor: (row) => row.costCode ?? row.costCodeId ?? "",
        type: "code",
        sticky: "start",
        width: 140,
        mono: true,
        cell: ({ row }) => (
          <span className="font-mono">
            {row.costCode ?? row.costCodeId ?? (
              <span className="italic text-content-subtle">uncoded</span>
            )}
          </span>
        ),
      },
      {
        id: "description",
        header: "Budget line",
        accessor: (row) => row.description ?? "",
        type: "text",
        width: 260,
        cell: ({ row }) =>
          row.description ?? (
            <span className="italic text-content-subtle">no budget line description</span>
          ),
      },
      {
        id: "onBudget",
        header: "Reaches the budget",
        headerTooltip:
          "Whether these hours land on a budget line. Hours coded to a cost code with no budget line are visible in a labour report and invisible on the cost report.",
        accessor: (row) => (row.onBudget ? "yes" : "no"),
        type: "enum",
        width: 180,
        groupable: true,
        options: [
          { value: "yes", label: "On budget", text: "On budget", tone: "success" },
          { value: "no", label: "Off budget", text: "Off budget", tone: "warning" },
        ],
        cell: ({ row }) =>
          row.onBudget ? (
            <Badge tone="success" size="xs" variant="outline">
              on budget
            </Badge>
          ) : (
            <Tooltip content="This group names a cost code but no budget line. The hours are real and coded, and they do not appear on the cost report.">
              <span>
                <Badge tone="warning" size="xs" icon={IconWarning}>
                  off budget
                </Badge>
              </span>
            </Tooltip>
          ),
      },
      {
        id: "totalHours",
        header: "Hours",
        accessor: "totalHours",
        type: "custom",
        align: "right",
        width: 120,
        aggregate: "sum",
        sortDescFirst: true,
        cell: ({ row }) => (
          <span className="font-medium tabular-nums">{hoursText(row.totalHours, 1)}</span>
        ),
      },
      {
        id: "regularHours",
        header: "Plain",
        accessor: "regularHours",
        type: "number",
        align: "right",
        width: 100,
        aggregate: "sum",
        defaultHidden: true,
      },
      {
        id: "overtimeHours",
        header: "OT",
        accessor: "overtimeHours",
        type: "number",
        align: "right",
        width: 95,
        aggregate: "sum",
      },
      {
        id: "doubleTimeHours",
        header: "DT",
        accessor: "doubleTimeHours",
        type: "number",
        align: "right",
        width: 95,
        aggregate: "sum",
        defaultHidden: true,
      },
      {
        id: "labourCost",
        header: "Labour cost",
        accessor: "labourCost",
        type: "custom",
        align: "right",
        width: 165,
        aggregate: "none",
        sortDescFirst: true,
        cell: ({ row }) => (
          <FigureCell
            value={row.labourCost}
            reasons={row.reasons}
            render={(value) => money(value, row.currency)}
          />
        ),
        toCsv: ({ row }) =>
          row.labourCost === null ? "" : `${row.labourCost} ${row.currency ?? ""}`,
      },
      {
        id: "revisedBudget",
        header: "Revised budget",
        accessor: "revisedBudget",
        type: "custom",
        align: "right",
        width: 165,
        aggregate: "none",
        cell: ({ row }) =>
          row.revisedBudget === null ? (
            <span className="text-content-subtle">—</span>
          ) : (
            <span className="tabular-nums">{money(row.revisedBudget, row.currency)}</span>
          ),
      },
      {
        id: "timecards",
        header: "Cards",
        accessor: "timecards",
        type: "number",
        align: "right",
        width: 95,
        aggregate: "sum",
      },
      {
        id: "workers",
        header: "Workers",
        accessor: "workers",
        type: "number",
        align: "right",
        width: 105,
        aggregate: "sum",
      },
    ],
    [],
  );

  if (report.error) return <LoadError message={report.error} onRetry={report.reload} />;
  if (report.loading && !data) return <SkeletonTable rows={8} columns={7} />;
  if (!data) return null;

  const totals = data.totals;
  const invisibleHours = totals.offBudgetHours + totals.uncodedHours;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3">
          <SectionHeading
            title="Labour on the cost report"
            hint={data.note}
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
                  aria-label="Cost report window"
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
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile label="Total hours" value={hoursText(totals.totalHours, 1)} />
            <Tile
              label="On budget"
              value={hoursText(totals.onBudgetHours, 1)}
              tone="success"
              hint="reaches the cost report"
            />
            <Tile
              label="Off budget"
              value={hoursText(totals.offBudgetHours, 1)}
              tone={totals.offBudgetHours > 0 ? "warning" : "neutral"}
              hint="coded, but not to a budget line"
            />
            <Tile
              label="Uncoded"
              value={hoursText(totals.uncodedHours, 1)}
              tone={totals.uncodedHours > 0 ? "danger" : "neutral"}
              hint="on no report at all"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-label uppercase tracking-wide text-content-subtle">
              Labour cost
            </span>
            {totals.labourCost === null ? (
              <Tooltip
                content={
                  <span className="block max-w-sm space-y-1">
                    {data.reasons.map((reason, index) => (
                      <span key={index} className="block">
                        {reason}
                      </span>
                    ))}
                  </span>
                }
              >
                <span className="inline-flex items-center gap-1 text-content-muted">
                  <span className="text-display-xs font-semibold">Not available</span>
                  <Badge tone="warning" size="xs">
                    why
                  </Badge>
                </span>
              </Tooltip>
            ) : (
              <span className="text-display-xs font-semibold tabular-nums text-content">
                {money(totals.labourCost, totals.currency)}
                <span className="ml-1 text-2xs uppercase tracking-wide text-content-subtle">
                  {totals.currency}
                </span>
              </span>
            )}
            <span className="text-2xs text-content-subtle">
              {data.from} to {data.to} · grouped by {labelize(data.groupBy)}
            </span>
          </div>
        </CardBody>
      </Card>

      {data.reasons.length > 0 ? (
        <Alert tone="warning" title="What this report cannot state, and why" icon={IconWarning}>
          <ReasonList reasons={data.reasons} />
        </Alert>
      ) : null}

      {invisibleHours > 0 ? (
        <Alert
          tone={totals.uncodedHours > 0 ? "danger" : "warning"}
          title={`${hoursText(invisibleHours, 1)} of labour does not reach the budget`}
        >
          {totals.uncodedHours > 0 ? (
            <>
              {hoursText(totals.uncodedHours, 1)} sits on cards with no cost coding at all, and{" "}
              {hoursText(totals.offBudgetHours, 1)} is coded to a cost code that names no budget
              line. Neither appears on the cost report. Labour overruns discovered at month end are
              almost always made of exactly these hours.
            </>
          ) : (
            <>
              {hoursText(totals.offBudgetHours, 1)} is coded to a cost code that names no budget
              line. It is visible in a labour report and does not land on the budget — which means
              the cost report understates labour by that amount without saying so.
            </>
          )}
        </Alert>
      ) : null}

      {chartRows.length > 1 ? (
        <ChartCard
          title="Hours by cost code and pay treatment"
          subtitle={`${data.from} to ${data.to}`}
          icon={IconCost}
          footnote="Split by pay treatment because the buckets carry different rates. Eight plain hours coded as eight overtime hours balances on the total and overstates the cost report by half a day's pay."
        >
          <StackedBarChart
            data={chartRows}
            categoryKey="code"
            series={[
              { key: "plain", label: "Plain time" },
              { key: "overtime", label: "Overtime" },
              { key: "double", label: "Double time" },
              { key: "premium", label: "Premium" },
            ]}
            valueFormat="hours"
            ariaLabel="Hours by cost code split by pay treatment"
            height={280}
          />
        </ChartCard>
      ) : null}

      {lines.length === 0 ? (
        <EmptyState
          icon={IconCost}
          title="No labour has been coded in this window"
          hint={`No timecard allocation exists between ${data.from} and ${data.to}. That is not the same as no labour: cards may exist and simply carry no cost coding, in which case their hours appear in the uncoded list below and on no cost report anywhere.`}
        />
      ) : (
        <DataTable<CostReportLine>
          tableId="labour-cost-report"
          data={lines}
          columns={columns}
          getRowId={(row) =>
            row.budgetLineItemId ?? row.costCodeId ?? row.costCode ?? `line-${row.totalHours}`
          }
          loading={report.loading}
          height={520}
          stickyHeader
          gridLines
          filterRow
          showFooter
          exportFileName="labour-cost-report"
          searchPlaceholder="Search cost codes…"
          defaultSort={[{ id: "totalHours", desc: true }]}
          rowTone={(row) => (row.onBudget ? undefined : ("warning" as Tone))}
          empty={{ title: "No coded labour" }}
          aria-label="Labour cost report"
        />
      )}

      {data.uncodedTimecards.length > 0 ? (
        <div>
          <SectionHeading
            title="Cards with no cost coding at all"
            hint="These hours are on no report. They will surface as an unexplained labour overrun at month end, with nothing to attribute them to."
          />
          <Table dense tableClassName="min-w-[520px] text-meta">
              <THead>
                <Tr>
                  <Th>Card</Th>
                  <Th>Date</Th>
                  <Th align="right">Hours</Th>
                  <Th>Status</Th>
                </Tr>
              </THead>
              <TBody>
                {data.uncodedTimecards.map((card) => (
                  <Tr key={card.id}>
                    <Td>
                      <button
                        type="button"
                        onClick={() => onOpenCard(card.id)}
                        className="font-mono text-accent-text hover:underline"
                      >
                        {card.reference}
                      </button>
                    </Td>
                    <Td className="text-content-muted">{card.workDate}</Td>
                    <Td align="right" numeric className="font-semibold text-danger-fg">
                      {hoursText(card.totalHours, 1)}
                    </Td>
                    <Td>
                      <Badge tone="neutral" size="xs" dot>
                        {labelize(card.status)}
                      </Badge>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
        </div>
      ) : null}

      <p className="text-2xs text-content-subtle">
        The footer sums hours. Labour cost carries no footer total: where any line could not be
        costed, or where cards in the window are denominated in more than one currency, no single
        figure is stated. A smaller, plausible, wrong number is worse than none.
      </p>
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  const valueClass =
    tone === "success"
      ? "text-success-fg"
      : tone === "warning"
        ? "text-warning-fg"
        : tone === "danger"
          ? "text-danger-fg"
          : "text-content";
  return (
    <div className="rounded-lg border border-border bg-surface-raised p-3">
      <div className="text-2xs uppercase tracking-wide text-content-subtle">{label}</div>
      <div className={`mt-0.5 text-display-xs font-semibold tabular-nums ${valueClass}`}>
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-2xs text-content-subtle">{hint}</div> : null}
    </div>
  );
}
