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
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Alert,
  Badge,
  Button,
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
import { api } from "../../lib/api";
import { DataTable, type DataColumns } from "../../ui/data";
import { ChartCard, StackedBarChart } from "../../ui/charts";
import type { Tone } from "../../ui/tokens";
import { IconCost, IconWarning } from "../../ui/icons";
import {
  FigureCell,
  LoadError,
  ReasonList,
  RefusalNotice,
  SectionHeading,
  hoursText,
  labelize,
  money,
  useAction,
  useCostCodes,
  useCrews,
  useProductivity,
  useProgressEntries,
  type CostReportLine,
  type LabourCostReport,
  type LabourPostingResult,
  type Loadable,
} from "./timecardsShared";
import { FieldProgressModal } from "./TimecardForms";

const WINDOWS = [7, 14, 30, 60, 90];

export default function CostReportTab({
  projectId,
  report,
  windowDays,
  onWindowDays,
  onOpenCard,
}: {
  projectId: string | undefined;
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

      <ProductivityPanel projectId={projectId} windowDays={windowDays} />
      <PostToBudgetPanel projectId={projectId} windowDays={windowDays} onDone={report.reload} />
    </div>
  );
}

/* ========================================================================== */
/* Productivity — earned hours against actual                                  */
/* ========================================================================== */

/**
 * EARNED HOURS AGAINST ACTUAL, which is the only labour number that says
 * whether the job is going well rather than how much it cost.
 *
 * Earned hours = installed quantity × the budget line's PLANNED unit rate.
 * That needs three things the platform will not invent: planned hours, planned
 * quantity and an installed quantity in a MATCHING unit. A line missing any of
 * them is reported as unmeasurable with the reason, never as a productivity
 * factor of 1.0 — a factor of 1.0 reads as "exactly on plan", which is the
 * most reassuring possible way to say "we did not measure it".
 */
function ProductivityPanel({
  projectId,
  windowDays,
}: {
  projectId: string | undefined;
  windowDays: number;
}) {
  const to = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const from = useMemo(() => {
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (windowDays - 1));
    return d.toISOString().slice(0, 10);
  }, [to, windowDays]);
  const productivity = useProductivity(projectId, from, to, Boolean(projectId));
  const progress = useProgressEntries(projectId, from, to, Boolean(projectId));
  const crews = useCrews(projectId);
  const costCodes = useCostCodes(projectId, Boolean(projectId));
  const [progressOpen, setProgressOpen] = useState(false);
  const { busy, refusal, clear, run } = useAction();
  const data = productivity.data;

  const budgetLines = useMemo(
    () =>
      (data?.lines ?? []).map((l) => ({
        id: l.budgetLineItemId,
        costCode: l.code ?? l.budgetLineItemId.slice(0, 8),
        description: l.description,
        unit: l.unit,
      })),
    [data],
  );

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <SectionHeading
            title="Labour productivity"
            hint="Earned hours against actual hours, per budget line, per crew and per week. A line that cannot be measured says so rather than reading as on plan."
            className="mb-0"
          />
          <Button size="sm" variant="secondary" onClick={() => setProgressOpen(true)}>
            Record field progress
          </Button>
        </div>
        {refusal ? <RefusalNotice refusal={refusal} onDismiss={clear} /> : null}
        {productivity.error ? (
          <LoadError message={productivity.error} onRetry={productivity.reload} />
        ) : productivity.loading ? (
          <SkeletonTable rows={4} />
        ) : !data ? null : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Tile label="Actual hours" value={hoursText(data.totals.actualHours)} />
              <Tile
                label="Earned hours"
                value={
                  data.totals.earnedHours === null
                    ? "Not available"
                    : hoursText(data.totals.earnedHours)
                }
                hint={
                  data.totals.earnedHours === null
                    ? "at least one line contributing hours could not be earned"
                    : undefined
                }
              />
              <Tile
                label="Productivity factor"
                value={
                  data.totals.productivityFactor === null
                    ? "Not available"
                    : data.totals.productivityFactor.toFixed(2)
                }
                tone={
                  data.totals.productivityFactor === null
                    ? "neutral"
                    : data.totals.productivityFactor < data.thresholds.floor
                      ? "danger"
                      : data.totals.productivityFactor < 1
                        ? "warning"
                        : "success"
                }
                hint="earned ÷ actual — above 1 the crew is beating the plan"
              />
              <Tile
                label="Lines measured"
                value={`${data.totals.linesMeasured} of ${data.totals.linesMeasured + data.totals.linesUnmeasurable}`}
                tone={data.totals.linesUnmeasurable > 0 ? "warning" : "neutral"}
                hint={
                  data.totals.linesUnmeasurable > 0
                    ? `${data.totals.linesUnmeasurable} line(s) carry no measurable quantity`
                    : undefined
                }
              />
            </div>

            {data.deviation ? (
              <Alert tone="danger" title="Productivity has been under the floor for a pattern">
                {data.deviation.explanation}
              </Alert>
            ) : null}

            {data.lines.length === 0 ? (
              <EmptyState
                icon={<IconCost />}
                title="Nothing measurable in this window"
                description="Productivity needs installed quantity against the hours. Record quantity on the allocations, and the budget line's planned hours and quantity, and it becomes computable."
              />
            ) : (
              <Table>
                <THead>
                  <Tr>
                    <Th>Budget line</Th>
                    <Th align="right">Actual h</Th>
                    <Th align="right">Installed</Th>
                    <Th align="right">Earned h</Th>
                    <Th align="right">Factor</Th>
                    <Th align="right">Forecast h</Th>
                    <Th>Why not</Th>
                  </Tr>
                </THead>
                <TBody>
                  {data.lines.map((line) => (
                    <Tr key={line.budgetLineItemId}>
                      <Td>
                        <span className="font-mono">{line.code ?? "—"}</span>{" "}
                        <span className="text-content-muted">{line.description}</span>
                      </Td>
                      <Td align="right">{hoursText(line.actualHours)}</Td>
                      <Td align="right">
                        {line.installedQuantity === null ? (
                          "—"
                        ) : (
                          <Tooltip
                            content={
                              line.quantitySource === "field_progress"
                                ? "Measured in the field, separately from the timesheets that claimed the hours."
                                : "Typed on the timesheets that claimed the hours — one author on both sides of the ratio. A field measurement supersedes it."
                            }
                          >
                            <span className="inline-flex items-center gap-1">
                              {line.installedQuantity} {line.unit ?? ""}
                              <Badge
                                size="xs"
                                variant="outline"
                                tone={
                                  line.quantitySource === "field_progress" ? "success" : "warning"
                                }
                              >
                                {line.quantitySource === "field_progress" ? "measured" : "claimed"}
                              </Badge>
                            </span>
                          </Tooltip>
                        )}
                      </Td>
                      <Td align="right">
                        {line.earnedHours === null ? "—" : hoursText(line.earnedHours)}
                      </Td>
                      <Td align="right">
                        {line.productivityFactor === null ? (
                          <span className="text-content-subtle">—</span>
                        ) : (
                          <Badge
                            size="xs"
                            tone={
                              line.productivityFactor < data.thresholds.floor
                                ? "danger"
                                : line.productivityFactor < 1
                                  ? "warning"
                                  : "success"
                            }
                          >
                            {line.productivityFactor.toFixed(2)}
                          </Badge>
                        )}
                      </Td>
                      <Td align="right">
                        {line.forecastHoursAtCompletion === null
                          ? "—"
                          : hoursText(line.forecastHoursAtCompletion)}
                      </Td>
                      <Td>
                        <ReasonList reasons={line.reasons} />
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}

            {data.crews.length > 0 ? (
              <div>
                <SectionHeading title="By crew" hint="The same measure, per gang." />
                <Table>
                  <THead>
                    <Tr>
                      <Th>Crew</Th>
                      <Th align="right">Actual h</Th>
                      <Th align="right">Earned h</Th>
                      <Th align="right">Factor</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {data.crews.map((crew) => (
                      <Tr key={crew.crewId ?? "none"}>
                        <Td>{crew.crewName ?? "No crew recorded"}</Td>
                        <Td align="right">{hoursText(crew.actualHours)}</Td>
                        <Td align="right">
                          {crew.earnedHours === null ? "—" : hoursText(crew.earnedHours)}
                        </Td>
                        <Td align="right">
                          {crew.productivityFactor === null
                            ? "—"
                            : crew.productivityFactor.toFixed(2)}
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </div>
            ) : null}

            <ReasonList reasons={data.reasons} />
            <p className="text-2xs text-content-subtle">{data.method}</p>
          </>
        )}

        {/*
          THE MEASUREMENTS THEMSELVES. A productivity factor is only as good
          as the quantity behind it, so the entries are shown with their
          method and whether anybody other than their author has seen them —
          and countersigning is offered here rather than hidden in a drawer.
        */}
        <div>
          <SectionHeading
            title="Field progress"
            hint="Installed quantity measured separately from the timesheets. Where it exists the report earns from it and ignores the quantity typed on the cards."
          />
          {progress.error ? (
            <LoadError message={progress.error} onRetry={progress.reload} />
          ) : progress.loading ? (
            <SkeletonTable rows={2} />
          ) : (progress.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              icon={<IconCost />}
              title="Nothing measured in this window"
              description="Without a field measurement, the only quantity available is the one the person claiming the hours typed on their own timesheet — one author on both sides of the ratio."
            />
          ) : (
            <Table>
              <THead>
                <Tr>
                  <Th>Date</Th>
                  <Th>Cost code</Th>
                  <Th align="right">Quantity</Th>
                  <Th>Method</Th>
                  <Th>Countersigned</Th>
                </Tr>
              </THead>
              <TBody>
                {(progress.data?.items ?? []).map((entry) => (
                  <Tr key={entry.id}>
                    <Td>{entry.progressDate}</Td>
                    <Td>
                      <span className="font-mono">{entry.costCode ?? "—"}</span>
                    </Td>
                    <Td align="right">
                      {entry.quantity} {entry.unit}
                    </Td>
                    <Td>{labelize(entry.method)}</Td>
                    <Td>
                      {entry.verifiedBy ? (
                        <Badge size="xs" tone="success" variant="outline">
                          {entry.verifiedAt?.slice(0, 10) ?? "yes"}
                        </Badge>
                      ) : (
                        <Button
                          size="xs"
                          variant="secondary"
                          loading={busy === entry.id}
                          onClick={async () => {
                            const done = await run(entry.id, () =>
                              api.post(
                                `/api/v1/projects/${projectId}/labour-progress/${entry.id}/verify`,
                                {},
                              ),
                            );
                            if (done) {
                              toast.success("Measurement countersigned");
                              progress.reload();
                              productivity.reload();
                            }
                          }}
                        >
                          Countersign
                        </Button>
                      )}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </div>
      </CardBody>

      {projectId ? (
        <FieldProgressModal
          open={progressOpen}
          onClose={() => setProgressOpen(false)}
          onDone={() => {
            progress.reload();
            productivity.reload();
          }}
          projectId={projectId}
          crews={crews.data?.items ?? []}
          costCodes={costCodes.data?.items ?? []}
          budgetLines={budgetLines}
        />
      ) : null}
    </Card>
  );
}

/* ========================================================================== */
/* Posting labour onto the budget                                              */
/* ========================================================================== */

/**
 * The join that makes labour a cost rather than a timesheet.
 *
 * Only APPROVED and later cards post: a draft is a claim nobody has checked,
 * and posting it would make the cost report move every time a foreman opened a
 * form. Hours with no budget line, and hours with no rate, are reported as
 * excluded with the reason rather than posted at zero. Re-posting the same
 * window REPLACES this module's contribution, so a second click is safe.
 */
function PostToBudgetPanel({
  projectId,
  windowDays,
  onDone,
}: {
  projectId: string | undefined;
  windowDays: number;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [result, setResult] = useState<LabourPostingResult | null>(null);
  const to = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const from = useMemo(() => {
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (windowDays - 1));
    return d.toISOString().slice(0, 10);
  }, [to, windowDays]);

  if (!projectId) return null;

  return (
    <Card>
      <CardBody className="space-y-3">
        <SectionHeading
          title="Post labour onto the budget"
          hint="Writes the window's approved, coded labour cost onto the budget lines it was coded to. Re-posting the same window replaces the figure rather than adding to it."
          className="mb-0"
          actions={
            <Button
              size="sm"
              variant="primary"
              loading={busy === "post"}
              onClick={async () => {
                const res = await run("post", () =>
                  api.post<LabourPostingResult>(
                    `/api/v1/projects/${projectId}/labour-cost-report/post-to-budget`,
                    { from, to },
                  ),
                );
                if (res) {
                  setResult(res);
                  toast.success(
                    res.posted === 0
                      ? "Nothing was posted — the reasons are below"
                      : `Posted to ${res.posted} budget line(s)`,
                  );
                  onDone();
                }
              }}
            >
              Post {from} to {to}
            </Button>
          }
        />
        {refusal ? <RefusalNotice refusal={refusal} onDismiss={clear} /> : null}
        {result ? (
          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="text-2xs text-content-muted">
              {result.posted === 0
                ? "Nothing was posted."
                : `Posted to ${result.posted} budget line(s).`}
            </div>
            {result.lines.length > 0 ? (
              <Table>
                <THead>
                  <Tr>
                    <Th>Cost code</Th>
                    <Th align="right">Labour cost</Th>
                    <Th align="right">Hours</Th>
                  </Tr>
                </THead>
                <TBody>
                  {result.lines.map((line) => (
                    <Tr key={line.budgetLineItemId}>
                      <Td className="font-mono">{line.costCode}</Td>
                      <Td align="right">{money(line.labourCost, line.currency)}</Td>
                      <Td align="right">{hoursText(line.labourHours)}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            ) : null}
            <ReasonList reasons={result.reasons} />
          </div>
        ) : null}
      </CardBody>
    </Card>
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
