/**
 * BUDGET VS ACTUAL — the variance report (spec #497), grouped by cost code,
 * division, cost type, line kind or sub job, with the movement since the
 * last period capture when one exists.
 *
 * Percentages are null (and shown as such) where there is no revised budget
 * to divide by; movement is null, with the reason, when nothing has been
 * captured to compare with.
 */
import { useState } from "react";
import { Alert, Badge, Card, CardBody, SegmentedControl, Skeleton, Stat, Table, Td, Th, Tr } from "../../ui";
import { api } from "../../lib/api";
import {
  EM_DASH,
  LoadError,
  SectionHeading,
  count,
  labelize,
  money,
  percent,
  useResource,
  varianceTone,
  type BudgetDetail,
  type VarianceReport,
} from "./budgetShared";

type GroupBy = "cost_code" | "division" | "cost_type" | "line_kind" | "sub_job";

export default function VarianceTab({
  budget,
  currency,
  version,
  onOpenLine,
}: {
  budget: BudgetDetail;
  currency: string;
  version: number;
  onOpenLine?: (lineId: string) => void;
}) {
  const [by, setBy] = useState<GroupBy>("division");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const report = useResource<VarianceReport>(
    (signal) => api.get<VarianceReport>(`/api/v1/budgets/${budget.id}/variance?by=${by}`, { signal }),
    [budget.id, by, version],
  );
  const data = report.data;

  if (report.error) return <LoadError message={report.error} onRetry={report.reload} title="The variance report could not be computed" />;
  if (report.loading && !data) return <Skeleton height={320} />;
  if (!data) return null;

  const t = data.totals;
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Revised budget" value={money(t.revisedBudgetTotal, currency)} hint={`${count(data.lineCount)} lines`} />
        <Stat label="Spent (job to date)" value={money(t.jobToDateCostsTotal, currency)} hint={t.spentPct === null ? "No revised budget to divide by" : `${percent(t.spentPct)} of revised`} />
        <Stat label="Forecast at completion" value={money(t.forecastFinalTotal, currency)} hint="Spent + forecast to complete" />
        <Stat
          label="Variance"
          value={money(t.varianceTotal, currency, { signed: true })}
          tone={varianceTone(t.varianceTotal)}
          hint={t.variancePct === null ? "No revised budget to divide by" : `${percent(t.variancePct)} of revised — negative is an overrun`}
        />
      </div>

      {data.comparedWith ? (
        <Alert tone="info" size="sm" title={`Movement is measured since ${data.comparedWith.reference} (as at ${data.comparedWith.asOfDate})`}>
          Each group shows how its revised budget, spend and forecast moved since that capture.
        </Alert>
      ) : (
        <Alert tone="warning" size="sm" title="No movement column">
          {data.reasons.join(" ")}
        </Alert>
      )}

      <section>
        <SectionHeading
          title="Grouped"
          hint="Subtotals are computed server-side over the stored cost report; the identities under the summary prove they add up."
          actions={
            <SegmentedControl<GroupBy>
              value={by}
              onChange={setBy}
              size="sm"
              aria-label="Group by"
              options={[
                { value: "division", label: "Division" },
                { value: "cost_code", label: "Cost code" },
                { value: "cost_type", label: "Cost type" },
                { value: "line_kind", label: "Line kind" },
                { value: "sub_job", label: "Sub job" },
              ]}
            />
          }
        />
        <div className="overflow-x-auto">
          <Table dense stickyHeader>
            <thead>
              <tr>
                <Th>Group</Th>
                <Th numeric>Lines</Th>
                <Th numeric>Revised</Th>
                <Th numeric>Committed</Th>
                <Th numeric>Spent</Th>
                <Th numeric>Spent %</Th>
                <Th numeric>Forecast</Th>
                <Th numeric>Variance</Th>
                <Th numeric>Var %</Th>
                <Th numeric>Δ forecast since capture</Th>
              </tr>
            </thead>
            <tbody>
              {data.groups.map((g) => (
                <GroupRows key={g.key} group={g} currency={currency} open={expanded.has(g.key)} onToggle={() => toggle(g.key)} onOpenLine={onOpenLine} />
              ))}
            </tbody>
          </Table>
        </div>
      </section>

      {data.worst.length > 0 ? (
        <Card>
          <CardBody>
            <p className="text-meta font-semibold text-content">Worst overruns</p>
            <ul className="mt-1 space-y-0.5 text-meta">
              {data.worst.map((w) => (
                <li key={w.id} className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    <span className="font-mono text-code">{w.costCode}</span> {w.description}
                  </span>
                  <span className="font-mono tabular-nums text-danger-fg">
                    {money(w.variance, currency, { signed: true })}
                    {w.variancePct !== null ? ` (${percent(w.variancePct)})` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

function GroupRows({
  group,
  currency,
  open,
  onToggle,
  onOpenLine,
}: {
  group: VarianceReport["groups"][number];
  currency: string;
  open: boolean;
  onToggle: () => void;
  onOpenLine?: (lineId: string) => void;
}) {
  return (
    <>
      <Tr interactive onClick={onToggle}>
        <Td>
          <span className="flex items-center gap-2">
            <span className="text-content-subtle">{open ? "▾" : "▸"}</span>
            <span className="font-medium">{group.label === group.key ? labelize(group.label) : group.label}</span>
          </span>
        </Td>
        <Td numeric>{count(group.lineCount)}</Td>
        <Td numeric>{money(group.revisedBudget, currency)}</Td>
        <Td numeric>{money(group.committed, currency)}</Td>
        <Td numeric>{money(group.jobToDateCosts, currency)}</Td>
        <Td numeric muted>{group.spentPct === null ? EM_DASH : percent(group.spentPct)}</Td>
        <Td numeric>{money(group.forecastFinal, currency)}</Td>
        <Td numeric>
          <Badge tone={varianceTone(group.variance)} size="xs">
            {money(group.variance, currency, { signed: true })}
          </Badge>
        </Td>
        <Td numeric muted>{group.variancePct === null ? EM_DASH : percent(group.variancePct)}</Td>
        <Td numeric muted>{group.movement ? money(group.movement.forecastFinal, currency, { signed: true }) : EM_DASH}</Td>
      </Tr>
      {open
        ? group.lines.map((l) => (
            <Tr key={l.id} interactive={Boolean(onOpenLine)} onClick={() => onOpenLine?.(l.id)}>
              <Td>
                <span className="pl-6">
                  <span className="font-mono text-code">{l.costCode}</span> <span className="text-content-muted">{labelize(l.costType)}</span> · {l.description}
                </span>
              </Td>
              <Td />
              <Td numeric>{money(l.revisedBudget, currency)}</Td>
              <Td />
              <Td numeric>{money(l.jobToDateCosts, currency)}</Td>
              <Td />
              <Td numeric>{money(l.forecastFinal, currency)}</Td>
              <Td numeric className={l.variance < 0 ? "text-danger-fg" : undefined}>{money(l.variance, currency, { signed: true })}</Td>
              <Td />
              <Td />
            </Tr>
          ))
        : null}
    </>
  );
}
