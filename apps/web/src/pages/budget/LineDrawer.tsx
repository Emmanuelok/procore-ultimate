/**
 * One budget line, opened from the grid.
 *
 * GET /budget-lines/:lineId returns the stored row PLUS the `derived` block
 * calc.ts produces from it (obligated, uncommitted budget, exposure,
 * cost-based progress) and the line's forecast history. The point of the panel
 * is that the forecast figure never appears without the METHOD that produced
 * it: "£412,000 to complete" carries very different weight depending on
 * whether an estimator typed it or a formula extrapolated it, and a report
 * that shows only the figure hides which it is.
 */
import { useState } from "react";
import { Badge, Button, Card, CardBody, Drawer, Skeleton, Table, Td, Th, Tr } from "../../ui";
import { DescriptionList, Timeline } from "../../ui/data";
import type { DescriptionItem, TimelineItem } from "../../ui/data";
import { api } from "../../lib/api";
import {
  COMPONENT_LABEL,
  EM_DASH,
  FORECAST_METHOD_HINT,
  FORECAST_METHOD_LABEL,
  FORECAST_STATUS_TONE,
  LINE_KIND_LABEL,
  LINE_STATUS_TONE,
  LoadError,
  MethodBadge,
  ReasonList,
  actorName,
  dateTime,
  isoDate,
  labelize,
  money,
  percent,
  useResource,
  varianceBand,
  varianceWord,
  VARIANCE_BAND_NOTE,
  type BudgetLineDetail,
  type LineTransactions,
} from "./budgetShared";

export interface LineDrawerProps {
  lineId: string | null;
  currency: string;
  users: Map<string, string>;
  onClose: () => void;
  onForecast?: (lineId: string) => void;
  onTransfer?: (lineId: string) => void;
}

export default function LineDrawer({
  lineId,
  currency,
  users,
  onClose,
  onForecast,
  onTransfer,
}: LineDrawerProps) {
  const line = useResource<BudgetLineDetail>(
    (signal) => api.get<BudgetLineDetail>(`/api/v1/budget-lines/${lineId}`, { signal }),
    [lineId ?? ""],
    lineId !== null,
  );

  const row = line.data;
  const band = row ? varianceBand(row.projectedOverUnder, row.revisedBudget) : null;
  const transactions = useResource<LineTransactions>(
    (signal) => api.get<LineTransactions>(`/api/v1/budget-lines/${lineId}/transactions`, { signal }),
    [lineId ?? ""],
    lineId !== null,
  );

  const amounts: DescriptionItem[] = row
    ? [
        { label: "Original budget", value: money(row.originalBudget, currency) },
        {
          label: "Approved transfers",
          value: money(row.budgetModifications, currency, { signed: true }),
          hint: "Net of approved budget changes in and out of this line",
        },
        {
          label: "Approved changes",
          value: money(row.approvedChanges, currency, { signed: true }),
          hint: "Owner-funded, behind an executed prime contract change order",
        },
        {
          label: "Pending changes",
          value: money(row.pendingBudgetChanges, currency, { signed: true }),
          hint: "Exposure only — deliberately outside the revised budget",
        },
        { label: "Revised budget", value: money(row.revisedBudget, currency) },
        { label: "Committed", value: money(row.committedCost, currency) },
        { label: "Pending commitments", value: money(row.pendingCommitments, currency) },
        { label: "Direct cost", value: money(row.directCosts, currency) },
        { label: "Spent (job to date)", value: money(row.jobToDateCosts, currency) },
      ]
    : [];

  const derived: DescriptionItem[] = row
    ? [
        {
          label: "Obligated",
          value: money(row.derived.obligated, currency),
          hint: "Committed + pending commitments",
        },
        {
          label: "Uncommitted budget",
          value: money(row.derived.uncommittedBudget, currency),
          hint: "Floored at zero — an over-committed line has an overrun, not a balance",
        },
        {
          label: "Exposure",
          value: money(row.derived.exposure, currency),
          hint: "Revised budget + pending transfers, if every one lands",
        },
        {
          label: "Cost progress",
          value:
            row.derived.costPercentComplete === null ? (
              <span className="text-content-muted">
                Not available
                <span className="mt-1 block text-meta">
                  There is no revised budget to divide job-to-date cost by.
                </span>
              </span>
            ) : (
              percent(row.derived.costPercentComplete)
            ),
          hint: "Job-to-date ÷ revised budget",
        },
        { label: "Reported progress", value: percent(row.percentComplete) },
        {
          label: "Unit basis",
          value:
            row.quantity === null || row.unitRate === null
              ? "Lump sum"
              : `${row.quantity.toLocaleString()} ${row.unit ?? ""} @ ${money(row.unitRate, currency, { precision: 2 })}`,
        },
      ]
    : [];

  const history: TimelineItem[] = (row?.forecastHistory ?? []).map((forecast) => ({
    id: forecast.id,
    title: (
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{forecast.reference}</span>
        <MethodBadge method={forecast.method} />
        <Badge tone={FORECAST_STATUS_TONE[forecast.status]} size="xs">
          {labelize(forecast.status)}
        </Badge>
      </span>
    ),
    timestamp: forecast.createdAt,
    actor: actorName(users, forecast.createdBy),
    description: (
      <span className="block">
        <span className="tabular-nums">
          {money(forecast.forecastToComplete, currency)} to complete ·{" "}
          {money(forecast.forecastFinal, currency)} at completion
        </span>
        <span className="block text-meta text-content-subtle">
          As at {isoDate(forecast.asOfDate)} · {percent(forecast.percentComplete)} complete · moved{" "}
          {money(forecast.deltaFromPrevious, currency, { signed: true })} from the previous position
        </span>
        <span className="block text-meta text-content-subtle">
          {FORECAST_METHOD_HINT[forecast.method]}
        </span>
        {forecast.assumptions ? (
          <span className="mt-1 block text-meta text-content-muted">“{forecast.assumptions}”</span>
        ) : null}
      </span>
    ),
    tone: forecast.status === "approved" ? "success" : "neutral",
    muted: forecast.status === "superseded",
  }));

  return (
    <Drawer
      open={lineId !== null}
      onClose={onClose}
      size="lg"
      title={row ? `${row.costCode} · ${row.description}` : "Budget line"}
      description={row ? `${labelize(row.costType)} · ${LINE_KIND_LABEL[row.lineKind]}` : undefined}
      headerActions={
        row ? (
          <span className="flex items-center gap-2">
            <Badge tone={LINE_STATUS_TONE[row.status]} size="sm" dot>
              {labelize(row.status)}
            </Badge>
          </span>
        ) : undefined
      }
      footer={
        row ? (
          <>
            {onTransfer ? (
              <Button variant="secondary" onClick={() => onTransfer(row.id)}>
                Move budget on this line
              </Button>
            ) : null}
            {onForecast ? (
              <Button onClick={() => onForecast(row.id)}>Record a forecast</Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      {line.error ? (
        <LoadError message={line.error} onRetry={line.reload} title="This line could not be loaded" />
      ) : null}

      {line.loading && !row ? (
        <div className="space-y-3">
          <Skeleton height={72} />
          <Skeleton height={180} />
          <Skeleton height={140} />
        </div>
      ) : null}

      {row ? (
        <div className="space-y-4">
          <Card variant="sunken">
            <CardBody>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-label uppercase text-content-subtle">Forecast at completion</p>
                  <p className="text-display-xs font-semibold tabular-nums text-content">
                    {money(row.forecastFinal, currency)}
                  </p>
                  <p className="mt-1 flex items-center gap-2 text-meta text-content-muted">
                    Derived by <MethodBadge method={row.forecastMethod} />
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-label uppercase text-content-subtle">Variance</p>
                  <p
                    className={
                      row.projectedOverUnder < 0
                        ? "text-display-xs font-semibold tabular-nums text-danger-fg"
                        : "text-display-xs font-semibold tabular-nums text-success-fg"
                    }
                  >
                    {money(row.projectedOverUnder, currency, { signed: true })}
                  </p>
                  <p className="mt-1 text-meta text-content-muted">
                    {varianceWord(row.projectedOverUnder)}
                    {band ? ` · ${VARIANCE_BAND_NOTE[band]}` : ""}
                  </p>
                </div>
              </div>
              <p className="mt-3 text-meta text-content-muted">
                {FORECAST_METHOD_LABEL[row.forecastMethod]}:{" "}
                {FORECAST_METHOD_HINT[row.forecastMethod]}
              </p>
              {row.forecastNotice && row.forecastNotice.length > 0 ? (
                <div className="mt-2">
                  <p className="text-meta font-semibold text-warning-fg">
                    The stored figure was retained rather than recomputed:
                  </p>
                  <ReasonList reasons={row.forecastNotice} />
                </div>
              ) : null}
            </CardBody>
          </Card>

          <section>
            <h3 className="mb-2 text-label uppercase text-content-subtle">The cost report</h3>
            <DescriptionList items={amounts} columns={2} layout="stacked" size="sm" dividers />
          </section>

          <section>
            <h3 className="mb-2 text-label uppercase text-content-subtle">Derived</h3>
            <DescriptionList items={derived} columns={2} layout="stacked" size="sm" dividers />
          </section>

          {row.notes ? (
            <section>
              <h3 className="mb-2 text-label uppercase text-content-subtle">Notes</h3>
              <p className="whitespace-pre-wrap text-body text-content">{row.notes}</p>
            </section>
          ) : null}

          <section>
            <h3 className="mb-2 text-label uppercase text-content-subtle">Where the numbers come from</h3>
            {transactions.error ? (
              <LoadError message={transactions.error} onRetry={transactions.reload} title="The source transactions could not be loaded" />
            ) : transactions.loading && !transactions.data ? (
              <Skeleton height={120} />
            ) : transactions.data ? (
              <ExplainTable data={transactions.data} currency={currency} />
            ) : null}
          </section>

          <section>
            <h3 className="mb-2 text-label uppercase text-content-subtle">Forecast history</h3>
            {history.length === 0 ? (
              <p className="text-meta text-content-muted">
                No forecast has been recorded against this line. The stored figure comes from the
                line's own method ({FORECAST_METHOD_LABEL[row.forecastMethod]}), applied to its
                current inputs.
              </p>
            ) : (
              <Timeline items={history} timeFormat="absolute" />
            )}
          </section>

          <p className="text-meta text-content-subtle">
            WBS path {row.wbsPath ?? EM_DASH} · updated {dateTime(row.updatedAt)}
          </p>
        </div>
      ) : null}
    </Drawer>
  );
}

/**
 * "Explain this number" (#500): per stored column, the source rows that
 * compose it, read live, with the stored figure beside the rebuilt one so a
 * drift names the exact rows that disagree.
 */
function ExplainTable({ data, currency }: { data: LineTransactions; currency: string }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Table dense>
        <thead>
          <tr>
            <Th>Column</Th>
            <Th numeric>Stored</Th>
            <Th numeric>From sources</Th>
            <Th numeric>Drift</Th>
            <Th numeric>Rows</Th>
          </tr>
        </thead>
        <tbody>
          {data.components.map((c) => (
            <Tr key={c.component} interactive onClick={() => setOpen(open === c.component ? null : c.component)}>
              <Td>{COMPONENT_LABEL[c.component] ?? labelize(c.component)}</Td>
              <Td numeric>{money(c.stored, currency)}</Td>
              <Td numeric>
                {c.value === null ? (
                  <span className="text-content-muted" title={c.reasons.join(" ")}>
                    Not available
                  </span>
                ) : (
                  money(c.value, currency)
                )}
              </Td>
              <Td numeric>
                {c.drift === null ? (
                  EM_DASH
                ) : Math.abs(c.drift) < 0.005 ? (
                  <Badge tone="success" size="xs">
                    agrees
                  </Badge>
                ) : (
                  <Badge tone="warning" size="xs">
                    {money(c.drift, currency, { signed: true })}
                  </Badge>
                )}
              </Td>
              <Td numeric muted>{c.rows.length}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {open ? (
        (() => {
          const c = data.components.find((x) => x.component === open);
          if (!c) return null;
          return (
            <Card variant="sunken">
              <CardBody className="space-y-2">
                <p className="text-meta text-content-muted">{c.basis}</p>
                {c.reasons.length > 0 ? <ReasonList reasons={c.reasons} /> : null}
                {c.rows.length === 0 ? (
                  <p className="text-meta text-content-subtle">No source row composes this column.</p>
                ) : (
                  <Table dense>
                    <thead>
                      <tr>
                        <Th>Source</Th>
                        <Th>Reference</Th>
                        <Th>Status</Th>
                        <Th numeric>Amount</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.rows.map((r) => (
                        <Tr key={`${r.sourceType}-${r.sourceId}`}>
                          <Td muted>{labelize(r.sourceType)}</Td>
                          <Td>
                            <span className="font-mono text-code">{r.reference}</span>
                            <span className="block truncate text-meta text-content-subtle">{r.description}</span>
                            {r.excluded ? <span className="block text-2xs text-warning-fg">{r.excluded}</span> : null}
                          </Td>
                          <Td muted>{r.status ? labelize(r.status) : EM_DASH}</Td>
                          <Td numeric className={r.excluded ? "line-through text-content-subtle" : undefined}>
                            {money(r.amount, r.currency)}
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </CardBody>
            </Card>
          );
        })()
      ) : null}
      <p className="text-2xs text-content-subtle">
        {data.lastReconciliation
          ? `Last reconciled ${dateTime(data.lastReconciliation.createdAt)} (${data.lastReconciliation.reference}, ${data.lastReconciliation.driftCount} drift row${data.lastReconciliation.driftCount === 1 ? "" : "s"}); ${data.postings.length} posting${data.postings.length === 1 ? "" : "s"} on record for this line.`
          : "No reconciliation has run on this budget yet; the stored columns have not been checked against their sources."}
      </p>
    </div>
  );
}
