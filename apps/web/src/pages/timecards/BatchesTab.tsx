/**
 * BATCHES — a crew's week, which is how approval actually happens.
 *
 * Nobody signs off forty individual day cards; the foreman sends the week. So
 * the batch carries the totals and the cards carry the detail — and the totals
 * are RE-DERIVED from the cards on every read rather than incremented in
 * place. A rollup that has drifted from the rows underneath it is the number a
 * payroll export is built on, and nobody checks it twice.
 *
 * `totalCost` is null when ANY card in the batch could not be costed. A batch
 * total that silently omits the three cards with no overtime rate is worse
 * than no total at all: it is a smaller, plausible, wrong number.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DescriptionList,
  EmptyState,
  SkeletonTable,
  Input,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Timeline,
  Tooltip,
  Tr,
  type TimelineItem,
} from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { BatchActions } from "./TimecardForms";
import type { Tone } from "../../ui/tokens";
import { IconCalendarCheck, IconDocument, IconWarning } from "../../ui/icons";
import {
  BATCH_STATUS_TONE,
  EM_DASH,
  LoadError,
  NOT_AVAILABLE,
  NotComparable,
  ReasonList,
  SectionHeading,
  TIMECARD_STATUS_TONE,
  actorName,
  dateTime,
  hoursText,
  labelize,
  money,
  shiftDays,
  signedHours,
  today,
  useResource,
  type Approval,
  type BatchDetail,
  type BatchRecord,
  type CertifiedPayrollReport,
  type CertifiedPayrollRow,
  type ListResponse,
  type Loadable,
} from "./timecardsShared";

export default function BatchesTab({
  batches,
  selectedBatchId,
  onSelectBatch,
  detail,
  users,
  onOpenCard,
  projectId,
  onChanged,
}: {
  batches: Loadable<ListResponse<BatchRecord>>;
  selectedBatchId: string | null;
  onSelectBatch: (batchId: string | null) => void;
  detail: Loadable<BatchDetail>;
  users: Map<string, string>;
  onOpenCard: (timecardId: string) => void;
  projectId: string;
  onChanged: () => void;
}) {
  const rows = useMemo(() => batches.data?.items ?? [], [batches.data]);

  const columns = useMemo<DataColumns<BatchRecord>>(
    () => [
      {
        id: "reference",
        header: "Batch",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 108,
        mono: true,
      },
      {
        id: "period",
        header: "Period",
        accessor: "periodEnd",
        type: "text",
        width: 190,
        cell: ({ row }) => (
          <span className="text-content-muted">
            {row.periodStart} → {row.periodEnd}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 165,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={BATCH_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "timecardCount",
        header: "Cards",
        accessor: "timecardCount",
        type: "number",
        align: "right",
        width: 100,
        aggregate: "sum",
      },
      {
        id: "workerCount",
        header: "Workers",
        accessor: "workerCount",
        type: "number",
        align: "right",
        width: 110,
        aggregate: "sum",
      },
      {
        id: "totalHours",
        header: "Hours",
        accessor: "totalHours",
        type: "custom",
        align: "right",
        width: 120,
        aggregate: "sum",
        cell: ({ row }) => <span className="tabular-nums">{hoursText(row.totalHours, 1)}</span>,
      },
      {
        id: "exceptionCount",
        header: "Exceptions",
        headerTooltip:
          "Cards with a computed variance beyond tolerance that nobody has explained. Cards with no access record are NOT counted here — a data gap is not an exception.",
        accessor: "exceptionCount",
        type: "custom",
        align: "right",
        width: 140,
        aggregate: "sum",
        sortDescFirst: true,
        cell: ({ row }) =>
          row.exceptionCount === 0 ? (
            <span className="text-content-subtle">—</span>
          ) : (
            <span className="font-semibold tabular-nums text-danger-fg">{row.exceptionCount}</span>
          ),
      },
      {
        id: "totalCost",
        header: "Cost",
        accessor: "totalCost",
        type: "custom",
        align: "right",
        width: 155,
        aggregate: "none",
        cell: ({ row }) =>
          row.totalCost === null ? (
            <NotComparable
              reason={
                row.costNote ??
                "A card in this week carries hours the platform holds no rate for, so the week's " +
                  "cost is unknown rather than the sum of the rest."
              }
            />
          ) : (
            <span className="tabular-nums">{money(row.totalCost, row.currency)}</span>
          ),
        toCsv: ({ row }) => (row.totalCost === null ? "" : `${row.totalCost} ${row.currency}`),
      },
      {
        id: "payrollBatchRef",
        header: "Payroll",
        accessor: (row) => row.payrollBatchRef ?? "",
        type: "code",
        width: 150,
        mono: true,
        cell: ({ row }) =>
          row.payrollBatchRef ? (
            <Badge tone="highlight" size="xs" variant="outline">
              {row.payrollBatchRef}
            </Badge>
          ) : (
            <span className="text-2xs text-content-subtle">{EM_DASH}</span>
          ),
      },
    ],
    [],
  );

  if (batches.error) return <LoadError message={batches.error} onRetry={batches.reload} />;
  if (batches.loading && rows.length === 0) return <SkeletonTable rows={6} columns={7} />;

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Weekly batches"
        hint="A batch is a crew's week or a subcontractor's week. It always names one or the other, so there is somebody to send it back to when the hours are wrong."
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={IconCalendarCheck}
          title="No batches on this project"
          hint="Cards can be approved one at a time, but nobody does: a foreman sends the week. Without batches every card needs its own signature, and the hours that never get one are the hours nobody notices are missing."
        />
      ) : (
        <DataTable<BatchRecord>
          tableId="timecard-batches"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={batches.loading}
          height={Math.min(420, 140 + rows.length * 40)}
          stickyHeader
          gridLines
          filterRow
          exportFileName="timecard-batches"
          searchPlaceholder="Search batches…"
          defaultSort={[{ id: "period", desc: true }]}
          rowTone={(row) => (row.exceptionCount > 0 ? ("danger" as Tone) : undefined)}
          onRowClick={({ row }) => onSelectBatch(row.id)}
          rowActions={(row) => [
            { id: "open", label: "Open the batch", onSelect: () => onSelectBatch(row.id) },
          ]}
          empty={{ title: "No batches" }}
          aria-label="Timecard batches"
        />
      )}

      {selectedBatchId ? (
        <BatchPanel
          detail={detail}
          users={users}
          onClose={() => onSelectBatch(null)}
          onOpenCard={onOpenCard}
          projectId={projectId}
          onChanged={() => {
            detail.reload();
            batches.reload();
            onChanged();
          }}
        />
      ) : rows.length > 0 ? (
        <p className="text-2xs text-content-subtle">
          Select a batch to see its re-derived rollup, its cards, and the approval acts recorded
          against it.
        </p>
      ) : null}

      <CertifiedPayrollPanel projectId={projectId} />
    </div>
  );
}

/* ========================================================================== */
/* Certified payroll (WH-347 shape)                                            */
/* ========================================================================== */

/**
 * The weekly certified payroll a public-works contract requires — assembled
 * from the cards, with the payroll-side deduction and net-pay columns filled
 * only where a payroll entry has actually been ingested.
 *
 * The statement of compliance is NOT signed here and there is no button that
 * signs it. Signing it is a personal representation by a named officer that
 * every worker on the sheet was paid the full prevailing wage with no
 * unlawful deduction; a screen that pre-ticks that is manufacturing a false
 * certification. This assembles the evidence and stops.
 */
function CertifiedPayrollPanel({ projectId }: { projectId: string }) {
  const [weekEnding, setWeekEnding] = useState<string>(() => today());
  const [contractorName, setContractorName] = useState("");
  const [contractNumber, setContractNumber] = useState("");
  const [open, setOpen] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams({ weekEnding });
    if (contractorName.trim()) params.set("contractorName", contractorName.trim());
    if (contractNumber.trim()) params.set("contractNumber", contractNumber.trim());
    return params.toString();
  }, [weekEnding, contractorName, contractNumber]);

  const report = useResource<CertifiedPayrollReport>(
    open ? `/api/v1/projects/${projectId}/certified-payroll?${query}` : null,
  );

  return (
    <Card>
      <CardBody className="space-y-3">
        <SectionHeading
          title="Certified payroll"
          hint="A WH-347 style weekly return: every worker, the hours they worked on each day of the week, the rate applied and — where a payroll file has been ingested — what was actually deducted and paid."
          className="mb-0"
          actions={
            <Button size="sm" variant={open ? "ghost" : "secondary"} onClick={() => setOpen(!open)}>
              {open ? "Hide" : "Assemble a week"}
            </Button>
          }
        />

        {open ? (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-label uppercase tracking-wide text-content-subtle">
                  Week ending
                </span>
                <Input
                  type="date"
                  value={weekEnding}
                  className="w-44"
                  onChange={(e) => setWeekEnding(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-label uppercase tracking-wide text-content-subtle">
                  Contractor name
                </span>
                <Input
                  value={contractorName}
                  className="w-56"
                  placeholder="as named on the contract"
                  onChange={(e) => setContractorName(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-label uppercase tracking-wide text-content-subtle">
                  Contract number
                </span>
                <Input
                  value={contractNumber}
                  className="w-44"
                  onChange={(e) => setContractNumber(e.target.value)}
                />
              </label>
              <div className="text-2xs text-content-subtle">
                {shiftDays(weekEnding, -6)} → {weekEnding}
              </div>
            </div>

            {report.error ? (
              <LoadError message={report.error} onRetry={report.reload} />
            ) : report.loading && !report.data ? (
              <SkeletonTable rows={5} columns={6} />
            ) : report.data ? (
              <CertifiedPayrollTable report={report.data} />
            ) : null}
          </>
        ) : (
          <p className="text-2xs text-content-subtle">
            Assembled on demand from approved and later cards, never stored: a certified payroll is
            a statement about a week that has closed, and a stored copy would go stale the moment a
            dated adjustment landed.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function CertifiedPayrollTable({ report }: { report: CertifiedPayrollReport }) {
  const dayColumns = report.weekDates;

  if (report.rows.length === 0) {
    return (
      <EmptyState
        size="sm"
        icon={IconDocument}
        title="No hours in this week"
        hint="No approved or later card falls in the seven days ending on this date, so there is nothing to certify. An empty return is not the same as a week with no work: check the cards were approved."
      />
    );
  }

  return (
    <div className="space-y-3">
      {report.reasons.length > 0 ? (
        <Alert tone="warning" title="What this return cannot state" icon={IconWarning}>
          <ReasonList reasons={report.reasons} />
        </Alert>
      ) : null}

      <div className="overflow-x-auto">
        <Table dense tableClassName="min-w-[880px] text-meta">
          <THead>
            <Tr>
              <Th>Worker</Th>
              <Th>Classification</Th>
              {dayColumns.map((date) => (
                <Th key={date} align="right">
                  {date.slice(5)}
                </Th>
              ))}
              <Th align="right">Plain</Th>
              <Th align="right">OT</Th>
              <Th align="right">Rate</Th>
              <Th align="right">Gross</Th>
              <Th align="right">Deductions</Th>
              <Th align="right">Net</Th>
            </Tr>
          </THead>
          <TBody>
            {report.rows.map((row: CertifiedPayrollRow) => (
              <Tr key={row.workerReference}>
                <Td>
                  <div className="font-medium text-content">{row.workerName}</div>
                  <div className="font-mono text-2xs text-content-subtle">
                    {row.workerReference}
                  </div>
                  {row.incomplete.length > 0 ? (
                    <Tooltip content={row.incomplete.join(" ")}>
                      <span>
                        <Badge tone="warning" size="xs" variant="outline">
                          incomplete
                        </Badge>
                      </span>
                    </Tooltip>
                  ) : null}
                </Td>
                <Td className="text-content-muted">
                  {row.classification ?? (
                    <span className="italic text-content-subtle">not stated</span>
                  )}
                </Td>
                {dayColumns.map((date) => {
                  const day = row.dayHours.find((d) => d.date === date);
                  return (
                    <Td key={date} align="right" numeric>
                      {day && day.regular + day.overtime > 0 ? (
                        <span>
                          {hoursText(day.regular, 1)}
                          {day.overtime > 0 ? (
                            <span className="text-warning-fg"> +{hoursText(day.overtime, 1)}</span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-content-subtle">{EM_DASH}</span>
                      )}
                    </Td>
                  );
                })}
                <Td align="right" numeric>
                  {hoursText(row.totalRegularHours, 1)}
                </Td>
                <Td align="right" numeric>
                  {hoursText(row.totalOvertimeHours, 1)}
                </Td>
                <Td align="right">
                  {row.regularRate === null ? (
                    <NotComparable
                      reason="No hourly rate is recorded for this worker in this week, so no rate can be certified. A certified payroll with an assumed rate is a false statement."
                      label={NOT_AVAILABLE}
                    />
                  ) : (
                    <span className="tabular-nums">{money(row.regularRate, row.currency)}</span>
                  )}
                </Td>
                <Td align="right">
                  {row.grossAmount === null ? (
                    <NotComparable
                      reason="Gross pay cannot be derived without a rate for every hour on the sheet."
                      label={NOT_AVAILABLE}
                    />
                  ) : (
                    <span className="font-medium tabular-nums">
                      {money(row.grossAmount, row.currency)}
                    </span>
                  )}
                </Td>
                <Td align="right">
                  {row.deductions === null ? (
                    <NotComparable
                      reason="No payroll entry has been ingested for this worker for this period, so what was deducted is unknown — never zero."
                      label={EM_DASH}
                    />
                  ) : (
                    <span className="tabular-nums">{money(row.deductions, row.currency)}</span>
                  )}
                </Td>
                <Td align="right">
                  {row.netPay === null ? (
                    <span className="text-content-subtle">{EM_DASH}</span>
                  ) : (
                    <span className="tabular-nums">{money(row.netPay, row.currency)}</span>
                  )}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </div>

      <Alert tone="info" title="Statement of compliance">
        {report.statementOfCompliance.note}
      </Alert>
    </div>
  );
}

function BatchPanel({
  detail,
  users,
  onClose,
  onOpenCard,
  projectId,
  onChanged,
}: {
  detail: Loadable<BatchDetail>;
  users: Map<string, string>;
  onClose: () => void;
  onOpenCard: (timecardId: string) => void;
  projectId: string;
  onChanged: () => void;
}) {
  if (detail.error) return <LoadError message={detail.error} onRetry={detail.reload} />;
  if (detail.loading && !detail.data) return <SkeletonTable rows={6} columns={5} />;
  const batch = detail.data;
  if (!batch) return null;

  const rollup = batch.rollup;
  const approvals: TimelineItem[] = batch.approvals.map((approval: Approval) => ({
    id: approval.id,
    title:
      approval.isSelfApproval === 1
        ? `Self-approval refused at level ${approval.level}`
        : `${labelize(approval.decision)} at level ${approval.level}`,
    timestamp: approval.decidedAt,
    actor: actorName(users, approval.approverId),
    tone:
      approval.isSelfApproval === 1
        ? "danger"
        : approval.decision === "approved"
          ? "success"
          : "info",
    description: approval.comment ?? undefined,
    badge:
      approval.isSelfApproval === 1 ? (
        <Badge tone="danger" size="xs" variant="solid">
          recorded &amp; refused
        </Badge>
      ) : undefined,
  }));

  return (
    <Card>
      <CardBody className="space-y-4">
        <SectionHeading
          title={
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{batch.reference}</span>
              <span>{batch.crewName ?? batch.vendorId ?? "no crew named"}</span>
              <Badge tone={BATCH_STATUS_TONE[batch.status] ?? "neutral"} size="xs" dot>
                {labelize(batch.status)}
              </Badge>
            </span>
          }
          hint={`${batch.periodStart} to ${batch.periodEnd}${
            batch.weekEnding ? ` · week ending ${batch.weekEnding}` : ""
          }`}
          className="mb-0"
          actions={
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          }
        />

        <BatchActions projectId={projectId} batch={batch} onDone={onChanged} />

        {rollup.reasons.length > 0 ? (
          <Alert tone="warning" title="Why this batch's totals read as they do" icon={IconWarning}>
            <ReasonList reasons={rollup.reasons} />
          </Alert>
        ) : null}

        <DescriptionList
          columns={4}
          size="sm"
          items={[
            {
              label: "Cards",
              value: (
                <span className="text-display-xs font-semibold tabular-nums">
                  {rollup.timecardCount}
                </span>
              ),
              hint: `${rollup.workerCount} worker(s)`,
            },
            {
              label: "Hours",
              value: (
                <span className="text-display-xs font-semibold tabular-nums">
                  {hoursText(rollup.totalHours, 1)}
                </span>
              ),
              hint: `${rollup.regularHours} plain · ${rollup.overtimeHours} OT · ${rollup.doubleTimeHours} DT · ${rollup.premiumHours} premium`,
            },
            {
              label: "Cost",
              value:
                rollup.totalCost === null ? (
                  <Tooltip content="One or more cards in this batch carry hours the platform holds no rate for, so the batch cost is unknown rather than the sum of the rest. A partial total dressed as a full one is worse than none.">
                    <span className="inline-flex items-center gap-1 text-content-muted">
                      <span className="text-body font-medium">Not available</span>
                      <Badge tone="warning" size="xs">
                        why
                      </Badge>
                    </span>
                  </Tooltip>
                ) : (
                  <span className="text-display-xs font-semibold tabular-nums">
                    {money(rollup.totalCost, rollup.currency)}
                  </span>
                ),
              hint: rollup.currency,
            },
            {
              label: "Variance across the batch",
              value:
                rollup.varianceHours === null ? (
                  <NotComparable
                    reason="No card in this batch has a usable site-access record, so no aggregate variance exists. That is a statement about the gate feed, not about the hours."
                  />
                ) : (
                  <span className="text-display-xs font-semibold tabular-nums">
                    {signedHours(rollup.varianceHours)}
                  </span>
                ),
              hint: `${rollup.exceptionCount} unexplained exception(s)`,
            },
          ]}
        />

        <div className="flex flex-wrap gap-2">
          {rollup.uncostedCards.length > 0 ? (
            <Tooltip content={rollup.uncostedCards.join(", ")}>
              <span>
                <Badge tone="warning" size="xs">
                  {rollup.uncostedCards.length} card(s) with no rate
                </Badge>
              </span>
            </Tooltip>
          ) : null}
          {rollup.unallocatedCards.length > 0 ? (
            <Tooltip content={rollup.unallocatedCards.join(", ")}>
              <span>
                <Badge tone="danger" size="xs">
                  {rollup.unallocatedCards.length} card(s) not cost coded
                </Badge>
              </span>
            </Tooltip>
          ) : null}
          {rollup.unexplainedVarianceCards.length > 0 ? (
            <Tooltip content={rollup.unexplainedVarianceCards.join(", ")}>
              <span>
                <Badge tone="danger" size="xs" dot>
                  {rollup.unexplainedVarianceCards.length} unexplained variance(s)
                </Badge>
              </span>
            </Tooltip>
          ) : null}
          {rollup.cardsWithoutAccessRecord.length > 0 ? (
            <Tooltip content={`No site-access record backs these cards, so their claimed hours are neither confirmed nor contradicted: ${rollup.cardsWithoutAccessRecord.join(", ")}`}>
              <span>
                <Badge tone="neutral" size="xs" variant="outline">
                  {rollup.cardsWithoutAccessRecord.length} not comparable
                </Badge>
              </span>
            </Tooltip>
          ) : null}
        </div>

        <div>
          <SectionHeading
            title="Cards in this batch"
            hint="The batch carries the totals; these carry the detail. The totals above are re-derived from these rows on every read."
          />
          {batch.timecards.length === 0 ? (
            <EmptyState
              size="sm"
              title="This batch holds no timecards yet"
              hint="It has no totals to state, because there is nothing underneath it to total. Collect the crew's cards into it, or the week goes to payroll empty."
            />
          ) : (
            <Table dense tableClassName="min-w-[640px] text-meta">
                <THead>
                  <Tr>
                    <Th>Card</Th>
                    <Th>Worker</Th>
                    <Th>Date</Th>
                    <Th align="right">Hours</Th>
                    <Th align="right">Variance</Th>
                    <Th>Status</Th>
                  </Tr>
                </THead>
                <TBody>
                  {batch.timecards.map((card) => (
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
                      <Td className="text-content">{card.workerName}</Td>
                      <Td className="text-content-muted">{card.workDate}</Td>
                      <Td align="right" numeric>
                        {hoursText(card.totalHours, 1)}
                      </Td>
                      <Td align="right">
                        {card.varianceHours === null ? (
                          <NotComparable
                            reason="No site-access record exists for this worker on this date, so the hours actually present are unknown — never zero."
                            label="No record"
                          />
                        ) : (
                          <span
                            className={
                              Math.abs(card.varianceHours) > 0.5 && !(card.varianceExplanation ?? "").trim()
                                ? "font-semibold tabular-nums text-danger-fg"
                                : "tabular-nums text-content-muted"
                            }
                          >
                            {signedHours(card.varianceHours)}
                          </span>
                        )}
                      </Td>
                      <Td>
                        <Badge tone={TIMECARD_STATUS_TONE[card.status] ?? "neutral"} size="xs" dot>
                          {labelize(card.status)}
                        </Badge>
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
          )}
        </div>

        <div>
          <SectionHeading
            title="Approval trail"
            hint="Every act on this batch, including any self-approval that was refused and written down."
          />
          {approvals.length === 0 ? (
            <EmptyState
              size="sm"
              title="Nothing has been decided on this batch"
              hint={
                batch.status === "draft"
                  ? "It is still a draft. The trail begins when somebody submits it."
                  : "No approval act has been recorded against this batch."
              }
            />
          ) : (
            <Timeline items={approvals} timeFormat="absolute" aria-label="Batch approval trail" />
          )}
        </div>

        <DescriptionList
          columns={3}
          size="sm"
          dividers
          items={[
            {
              label: "Submitted",
              value: actorName(users, batch.submittedBy),
              hint: batch.submittedAt ? dateTime(batch.submittedAt) : "not submitted",
            },
            {
              label: "Approved",
              value: actorName(users, batch.approvedBy),
              hint: batch.approvedAt ? dateTime(batch.approvedAt) : "not approved",
            },
            {
              label: "Exported to payroll",
              value: batch.exportedAt ? dateTime(batch.exportedAt) : "No",
              hint: batch.exportedAt
                ? "after an export a correction is a new dated adjustment, never an edit"
                : undefined,
            },
          ]}
        />
      </CardBody>
    </Card>
  );
}
