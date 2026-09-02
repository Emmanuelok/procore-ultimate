/**
 * The cost and cash panels.
 *
 * These are where the "never fabricate a figure" rule is most visible. The
 * budget summary returns its cost-side components as `{ value, reasons }`
 * because they are read live from the commitments and invoicing modules and
 * may genuinely be unknown. `<Figure>` prints the reasons rather than a zero,
 * and the drift block reports when the stored rollups disagree with what the
 * source tools say right now — because "these two numbers disagree" is more
 * useful than showing whichever was read last.
 */
import { Link } from "react-router-dom";
import { Alert, Badge } from "../../../ui";
import { IconCost, IconPayment } from "../../../ui/icons";
import { cx } from "../../../ui/cx";
import { toneClass } from "../../../ui/tokens";
import {
  DASH,
  Figure,
  ReasonList,
  StatLine,
  isoDate,
  money,
  type Loadable,
  type Paginated,
} from "../../../layouts/project/lib";
import Panel from "./Panel";
import { activeBudget } from "./hooks";
import type { BudgetRow, BudgetSummary, CashPosition } from "./types";

/* ============================================================== cost ====== */

export interface CostPositionPanelProps {
  currency: string;
  budgets: Loadable<Paginated<BudgetRow>>;
  summary: Loadable<BudgetSummary>;
  className?: string;
}

export function CostPositionPanel({
  currency,
  budgets,
  summary,
  className,
}: CostPositionPanelProps) {
  const budget = activeBudget(budgets.data);
  const data = summary.data;
  const loading = budgets.loading || (budget !== null && summary.loading && !data);
  const mismatched = data !== null && data.currency !== currency;

  const driftCommitted = data?.drift.committed ?? null;
  const drifted = driftCommitted !== null && Math.abs(driftCommitted) > 0.005;

  return (
    <Panel
      className={className}
      title="Cost position"
      subtitle={
        data
          ? `${data.reference} · ${data.name} · ${data.lineCount} line${data.lineCount === 1 ? "" : "s"} · ${data.currency}`
          : "The active budget, and what it has been consumed by"
      }
      icon={IconCost}
      loading={loading}
      error={budgets.error ?? summary.error}
      onRetry={summary.reload}
      isEmpty={!budget}
      emptyTitle="No budget on this project"
      emptyHint="A budget is what committed cost, invoiced cost and forecast are measured against. Create one in Budget and this panel fills in."
      emptyAction={
        <Link
          to="budget"
          className="text-meta text-accent-text underline underline-offset-2"
        >
          Open Budget
        </Link>
      }
      actions={
        <Link
          to="budget"
          className="rounded px-1 text-meta text-accent-text underline-offset-2 hover:underline"
        >
          Open
        </Link>
      }
      footer={
        data
          ? `Plan figures are this budget's own rollups. Cost figures are read live from commitments and invoicing at ${isoDate(data.asOf)}.`
          : undefined
      }
    >
      {data ? (
        <div className="space-y-3">
          {mismatched ? (
            <Alert tone="info" size="sm" title={`This budget is written in ${data.currency}`}>
              The rail above is showing {currency}. Budgets are never converted, so the figures
              below stay in {data.currency} rather than being restated in a currency the budget was
              not written in.
            </Alert>
          ) : null}

          <dl className="space-y-1.5">
            <StatLine
              label="Original budget"
              value={money(data.plan.originalBudget, data.currency)}
            />
            <StatLine
              label="Approved changes"
              value={money(data.plan.approvedChanges, data.currency)}
            />
            <StatLine
              label="Pending changes"
              value={money(data.plan.pendingChanges, data.currency)}
            />
            <StatLine
              label="Revised budget"
              value={money(data.plan.revisedBudget, data.currency)}
              strong
            />
          </dl>

          <div className="border-t border-border-subtle pt-3">
            <dl className="space-y-1.5">
              <StatLine
                label="Committed"
                value={
                  <Figure
                    figure={data.components.committed}
                    render={(value) => money(value, data.currency)}
                  />
                }
              />
              <StatLine
                label="Invoiced to date"
                value={
                  <Figure
                    figure={data.components.invoicedToDate}
                    render={(value) => money(value, data.currency)}
                  />
                }
              />
              <StatLine
                label="Job-to-date cost"
                value={
                  <Figure
                    figure={data.components.jobToDateCosts}
                    render={(value) => money(value, data.currency)}
                  />
                }
              />
              <StatLine
                label="Contingency remaining"
                value={
                  <Figure
                    figure={data.components.contingencyRemaining}
                    render={(value) => money(value, data.currency)}
                  />
                }
              />
            </dl>
          </div>

          <div className="border-t border-border-subtle pt-3">
            <dl className="space-y-1.5">
              <StatLine
                label="Forecast final"
                value={money(data.plan.forecastFinal, data.currency)}
              />
              <StatLine
                label="Variance"
                value={money(data.plan.variance, data.currency)}
                tone={data.plan.variance < 0 ? "danger" : "success"}
                strong
              />
            </dl>
          </div>

          {drifted ? (
            <Alert tone="warning" size="sm" title="The stored rollups are behind">
              Committed cost read live from the commitments module differs from this budget&rsquo;s
              stored total by {money(driftCommitted, data.currency)}. Recalculate the budget
              to bring them back into agreement — until then the two figures disagree, and this
              panel is showing both rather than picking one.
            </Alert>
          ) : null}

          {data.overrunLines.length > 0 ? (
            <div className="border-t border-border-subtle pt-3">
              <p className="mb-1.5 text-label uppercase text-content-subtle">
                Lines forecast to overrun
              </p>
              <ul className="space-y-1">
                {data.overrunLines.slice(0, 4).map((line) => (
                  <li key={line.lineItemId} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-meta text-content">
                      <span className="font-mono text-2xs text-content-subtle">
                        {line.costCode ?? "—"}
                      </span>{" "}
                      {line.description ?? "Untitled line"}
                    </span>
                    <span className={cx("shrink-0 text-meta tabular-nums", toneClass("danger", "text"))}>
                      {money(line.projectedOverUnder, data.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

/* ============================================================== cash ====== */

export interface CashPositionPanelProps {
  currency: string;
  cash: Loadable<CashPosition>;
  className?: string;
}

export function CashPositionPanel({ currency, cash, className }: CashPositionPanelProps) {
  const data = cash.data;
  const bucket = data?.byCurrency.find((b) => b.currency === currency) ?? null;
  const otherCurrencies = (data?.byCurrency ?? [])
    .map((b) => b.currency)
    .filter((code) => code !== currency);

  return (
    <Panel
      className={className}
      title="Cash position"
      subtitle={
        data ? `Billed but unpaid, both directions · as at ${isoDate(data.asOf)}` : "Money in and money out"
      }
      icon={IconPayment}
      loading={cash.loading && !data}
      error={cash.error}
      onRetry={cash.reload}
      isEmpty={bucket === null}
      emptyTitle={otherCurrencies.length > 0 ? `Nothing outstanding in ${currency}` : "No cash position yet"}
      emptyHint={
        otherCurrencies.length > 0
          ? `This project has an outstanding position in ${otherCurrencies.join(", ")} but not in ${currency}. Positions are reported per currency and never netted across them — there is no exchange rate on the record.`
          : (data?.reasons.join(" ") ??
            "No live invoice on this project has an amount outstanding, so there is no receivable or payable position to report.")
      }
      actions={
        <Link
          to="invoicing"
          className="rounded px-1 text-meta text-accent-text underline-offset-2 hover:underline"
        >
          Open
        </Link>
      }
      footer={
        <>
          Retainage is reported separately from billed-unpaid because it is withheld by agreement,
          not late. A cash forecast that treats retainage as overdue receivables is a cash forecast
          that lies.
          {data?.currencyNote ? ` ${data.currencyNote}` : ""}
        </>
      }
    >
      {bucket ? (
        <div className="space-y-3">
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-label uppercase text-content-subtle">Owed to us</p>
              {bucket.receivableOverdue > 0 ? (
                <Badge tone="danger" size="xs" variant="subtle">
                  {money(bucket.receivableOverdue, currency)} overdue
                </Badge>
              ) : null}
            </div>
            <dl className="space-y-1.5">
              <StatLine
                label="Billed, unpaid"
                value={money(bucket.receivableBilledUnpaid, currency)}
                strong
              />
              <StatLine
                label="Retainage held by owner"
                value={money(bucket.receivableRetainageHeldByOwner, currency)}
              />
            </dl>
          </div>

          <div className="border-t border-border-subtle pt-3">
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-label uppercase text-content-subtle">Owed by us</p>
              {bucket.payableOverdue > 0 ? (
                <Badge tone="warning" size="xs" variant="subtle">
                  {money(bucket.payableOverdue, currency)} overdue
                </Badge>
              ) : null}
            </div>
            <dl className="space-y-1.5">
              <StatLine
                label="Invoiced, unpaid"
                value={money(bucket.payableInvoicedUnpaid, currency)}
                strong
              />
              <StatLine
                label="Retainage we hold"
                value={money(bucket.payableRetainageWeHold, currency)}
              />
            </dl>
          </div>

          <div className="border-t border-border-subtle pt-3">
            <dl className="space-y-1.5">
              <StatLine
                label="Net working position"
                value={money(bucket.netWorkingPosition, currency)}
                tone={bucket.netWorkingPosition < 0 ? "danger" : "success"}
                strong
              />
              <StatLine
                label="Including retainage"
                value={money(bucket.netPositionIncludingRetainage, currency)}
              />
            </dl>
          </div>

          {data?.openBillingPeriods.length ? (
            <div className="border-t border-border-subtle pt-3">
              <p className="mb-1 text-label uppercase text-content-subtle">Open billing periods</p>
              <ul className="space-y-1 text-meta text-content-muted">
                {data.openBillingPeriods.slice(0, 3).map((period) => (
                  <li key={period.id} className="flex items-baseline justify-between gap-3">
                    <span className="truncate">{period.name ?? period.reference}</span>
                    <span className="shrink-0 tabular-nums text-content-subtle">
                      {period.dueDate ? `due ${isoDate(period.dueDate)}` : DASH}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {data && data.reasons.length > 0 ? (
            <div className="border-t border-border-subtle pt-3">
              <ReasonList reasons={data.reasons} />
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
