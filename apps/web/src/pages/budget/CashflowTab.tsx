/**
 * CASH FLOW — the S-curve by period: planned (revised budget spread over the
 * linked schedule windows), committed (commitments over their dates), actual
 * (approved subcontractor invoices by billing date) and forecast (actual to
 * date, then the forecast to complete spread to the project finish).
 *
 * Rows the API could not phase are listed with their amounts rather than
 * pushed into the first or last month, and every curve states its basis.
 */
import { useMemo } from "react";
import { Alert, Card, CardBody, Skeleton, Stat, Table, Td, Th, Tr } from "../../ui";
import { ChartCard, SCurveChart } from "../../ui/charts";
import { api } from "../../lib/api";
import {
  LoadError,
  ReasonList,
  SectionHeading,
  count,
  money,
  useResource,
  type BudgetDetail,
  type CashFlow,
} from "./budgetShared";

export default function CashflowTab({
  budget,
  currency,
  version,
}: {
  budget: BudgetDetail;
  currency: string;
  version: number;
}) {
  const flow = useResource<CashFlow>(
    (signal) => api.get<CashFlow>(`/api/v1/budgets/${budget.id}/cashflow`, { signal }),
    [budget.id, version],
  );
  const data = flow.data;
  const chart = useMemo(
    () =>
      (data?.periods ?? []).map((p) => ({
        period: p.month,
        planned: p.cumulativePlanned,
        actual: p.cumulativeActual,
        forecast: p.cumulativeForecast,
        committed: p.cumulativeCommitted,
      })),
    [data],
  );

  if (flow.error) return <LoadError message={flow.error} onRetry={flow.reload} title="The cash-flow forecast could not be computed" />;
  if (flow.loading && !data) return <Skeleton height={360} />;
  if (!data) return null;

  const unphasedCount = data.unphased.planned.length + data.unphased.committed.length + data.unphased.actual.length;
  const asOfKey = data.asOf.slice(0, 7);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Planned (phased)" value={money(data.totals.planned, currency)} hint={data.basis["planned"]} />
        <Stat label="Committed (phased)" value={money(data.totals.committed, currency)} hint={data.basis["committed"]} />
        <Stat label="Actual to date" value={money(data.totals.actual, currency)} hint={data.basis["actual"]} />
        <Stat label="Forecast at completion" value={money(data.totals.forecast, currency)} hint={data.basis["forecast"]} />
      </div>

      {data.reasons.length > 0 ? (
        <Alert tone="info" size="sm" title="What this curve leaves out">
          <ReasonList reasons={data.reasons} />
        </Alert>
      ) : null}

      <ChartCard
        title="Cumulative cash flow"
        subtitle={`${data.from} → ${data.to}, monthly, ${currency}`}
        metric={money(data.totals.forecast, currency)}
        metricCaption="forecast at completion"
        footnote="Planned and committed are spread linearly by days in month over each row's own window; actual is dated by invoice billing date; forecast continues actual with the stored forecast to complete."
      >
        <SCurveChart
          data={chart as ReadonlyArray<Record<string, unknown>>}
          keys={{ period: "period", planned: "planned", actual: "actual", forecast: "forecast" }}
          labels={{ planned: "Planned", actual: "Actual", forecast: "Forecast" }}
          valueFormat="currency"
          formatOptions={{ currency }}
          dataDate={asOfKey}
          dataDateLabel="Today"
          target={budget.revisedBudgetTotal}
          targetLabel="Revised budget"
          height={320}
          emptyTitle="Nothing to phase"
          emptyMessage="No line, commitment or invoice on this budget carries a date the curve could use."
          ariaLabel={`Cash-flow S-curve for ${budget.reference}`}
        />
      </ChartCard>

      <section>
        <SectionHeading title="By period" hint="Period amounts and running totals, in the budget's currency." />
        <div className="overflow-x-auto">
          <Table dense stickyHeader>
            <thead>
              <tr>
                <Th>Month</Th>
                <Th numeric>Planned</Th>
                <Th numeric>Committed</Th>
                <Th numeric>Actual</Th>
                <Th numeric>Forecast</Th>
                <Th numeric>Σ planned</Th>
                <Th numeric>Σ actual</Th>
                <Th numeric>Σ forecast</Th>
              </tr>
            </thead>
            <tbody>
              {data.periods.map((p) => (
                <Tr key={p.month} className={p.month === asOfKey ? "bg-surface-sunken" : undefined}>
                  <Td className="font-mono text-code">{p.month}</Td>
                  <Td numeric>{money(p.planned, currency)}</Td>
                  <Td numeric>{money(p.committed, currency)}</Td>
                  <Td numeric>{money(p.actual, currency)}</Td>
                  <Td numeric>{money(p.forecast, currency)}</Td>
                  <Td numeric muted>{money(p.cumulativePlanned, currency)}</Td>
                  <Td numeric muted>{money(p.cumulativeActual, currency)}</Td>
                  <Td numeric muted>{money(p.cumulativeForecast, currency)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
      </section>

      {unphasedCount > 0 ? (
        <Card variant="sunken">
          <CardBody>
            <p className="text-meta font-semibold text-content">
              {count(unphasedCount)} row{unphasedCount === 1 ? "" : "s"} could not be placed on the axis
            </p>
            <ul className="mt-1 space-y-0.5 text-meta text-content-muted">
              {data.unphased.planned.map((r) => (
                <li key={`p-${r.id}`}>Planned · {r.reference} · {money(r.amount, currency)} — no schedule window and no project window</li>
              ))}
              {data.unphased.committed.map((r) => (
                <li key={`c-${r.id}`}>Committed · {r.reference} · {money(r.amount, currency)} — no start / completion dates</li>
              ))}
              {data.unphased.actual.map((r) => (
                <li key={`a-${r.id}`}>Actual · {r.reference} · {money(r.amount, currency)} — no billing date</li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
