/**
 * Budget summary header — the six figures a project director reads first, and
 * the bridge that explains how the original budget became the forecast.
 *
 * The PLAN side (original / revised / forecast / variance) is owned by the
 * budget module and is always available. The COST side (committed, spent,
 * contingency) is read LIVE from the commitments and invoices tools by
 * GET /budgets/:id/summary, and each component arrives as
 * `{ value, inputs, reasons }`. When `value` is null this header says "Not
 * available" and quotes the reasons — a project director reading "$0
 * committed" on a job with forty live subcontracts will make a decision on it,
 * so that number is never fabricated here.
 */
import { useMemo, type ReactNode } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Stat,
  cx,
} from "../../ui";
import { IconBudget, IconRefresh, IconWarning } from "../../ui/icons";
import { ChartCard, WaterfallChart } from "../../ui/charts";
import type { WaterfallStep } from "../../ui/charts";
import {
  EM_DASH,
  FigureValue,
  LoadError,
  ReasonList,
  ReconciliationBadge,
  dateTime,
  money,
  varianceTone,
  varianceWord,
  type BudgetDetail,
  type BudgetSummary,
  type Figure,
} from "./budgetShared";

const round2 = (n: number): number => Math.round(n * 100) / 100;

interface UnavailableComponent {
  label: string;
  reasons: string[];
}

export interface SummaryHeaderProps {
  budget: BudgetDetail | null;
  summary: BudgetSummary | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onRecalculate: () => void;
  recalculating: boolean;
}

export default function SummaryHeader({
  budget,
  summary,
  loading,
  error,
  onRetry,
  onRecalculate,
  recalculating,
}: SummaryHeaderProps) {
  const currency = summary?.currency ?? budget?.currency ?? "USD";
  const plan = summary?.plan ?? null;

  const steps = useMemo<WaterfallStep[]>(() => {
    if (!plan) return [];
    const out: WaterfallStep[] = [
      { label: "Original budget", value: plan.originalBudget, kind: "total" },
    ];
    if (plan.budgetModifications !== 0) {
      out.push({
        label: "Approved transfers",
        value: plan.budgetModifications,
        note: "Net of approved transfers and contingency draws. Transfers balance to zero across the whole budget.",
      });
    }
    if (plan.approvedChanges !== 0) {
      out.push({
        label: "Approved changes",
        value: plan.approvedChanges,
        note: "Owner-funded increases, each behind an executed prime contract change order.",
      });
    }
    out.push({ label: "Revised budget", kind: "subtotal" });
    if (plan.pendingChanges !== 0) {
      out.push({
        label: "Pending changes",
        value: plan.pendingChanges,
        note: "Exposure only. A pending transfer is deliberately NOT part of the revised budget.",
      });
    }
    const exposed = round2(plan.revisedBudget + plan.pendingChanges);
    out.push({
      label: "Forecast movement",
      value: round2(plan.forecastFinal - exposed),
      note: "Forecast at completion measured against the exposed budget (revised plus pending).",
    });
    out.push({ label: "Forecast at completion", kind: "total" });
    return out;
  }, [plan]);

  const unavailable = useMemo<UnavailableComponent[]>(() => {
    if (!summary) return [];
    const entries: Array<[string, Figure]> = [
      ["Committed cost", summary.components.committed],
      ["Pending commitments", summary.components.pendingCommitments],
      ["Invoiced to date", summary.components.invoicedToDate],
      ["Job-to-date cost", summary.components.jobToDateCosts],
      ["Contingency remaining", summary.components.contingencyRemaining],
    ];
    return entries
      .filter(([, figure]) => figure.value === null)
      .map(([label, figure]) => ({ label, reasons: figure.reasons }));
  }, [summary]);

  const disclosed = useMemo<UnavailableComponent[]>(() => {
    if (!summary) return [];
    const entries: Array<[string, Figure]> = [
      ["Committed cost", summary.components.committed],
      ["Pending commitments", summary.components.pendingCommitments],
      ["Invoiced to date", summary.components.invoicedToDate],
    ];
    return entries
      .filter(([, figure]) => figure.value !== null && figure.reasons.length > 0)
      .map(([label, figure]) => ({ label, reasons: figure.reasons }));
  }, [summary]);

  if (error) {
    return (
      <div className="mb-5">
        <LoadError message={error} onRetry={onRetry} title="The budget summary could not be loaded" />
      </div>
    );
  }

  const variance = plan?.variance ?? 0;
  const varianceShare =
    plan && plan.revisedBudget !== 0 ? Math.abs(variance) / Math.abs(plan.revisedBudget) : null;

  const driftCommitted = summary?.drift.committed ?? null;
  const driftJtd = summary?.drift.jobToDateCosts ?? null;
  const hasDrift =
    (driftCommitted !== null && Math.abs(driftCommitted) >= 0.01) ||
    (driftJtd !== null && Math.abs(driftJtd) >= 0.01);

  return (
    <div className="mb-5 flex flex-col gap-4">
      <Card>
        <CardBody className="p-0">
          <div className="grid grid-cols-2 gap-px bg-border md:grid-cols-3 xl:grid-cols-6">
            <Tile>
              <Stat
                label="Original budget"
                loading={loading}
                value={plan ? money(plan.originalBudget, currency) : EM_DASH}
                hint={`${currency} · frozen at lock`}
                icon={IconBudget}
              />
            </Tile>
            <Tile>
              <Stat
                label="Revised budget"
                loading={loading}
                value={plan ? money(plan.revisedBudget, currency) : EM_DASH}
                hint="Original + transfers + approved changes"
              />
            </Tile>
            <Tile>
              <Stat
                label="Committed"
                loading={loading}
                value={
                  summary ? (
                    <FigureValue figure={summary.components.committed} currency={currency} />
                  ) : (
                    EM_DASH
                  )
                }
                hint="Live from approved commitments"
              />
            </Tile>
            <Tile>
              <Stat
                label="Spent (job to date)"
                loading={loading}
                value={
                  summary ? (
                    <FigureValue figure={summary.components.jobToDateCosts} currency={currency} />
                  ) : (
                    EM_DASH
                  )
                }
                hint="Invoiced commitment cost + direct cost"
              />
            </Tile>
            <Tile>
              <Stat
                label="Forecast at completion"
                loading={loading}
                value={plan ? money(plan.forecastFinal, currency) : EM_DASH}
                hint="Job-to-date + forecast to complete"
              />
            </Tile>
            <Tile>
              <Stat
                label="Variance"
                loading={loading}
                value={
                  <span className={cx(variance < 0 ? "text-danger-fg" : variance > 0 ? "text-success-fg" : undefined)}>
                    {plan ? money(variance, currency, { signed: true }) : EM_DASH}
                  </span>
                }
                delta={plan ? variance : null}
                deltaLabel={
                  plan
                    ? `${varianceWord(variance)}${
                        varianceShare !== null ? ` · ${(varianceShare * 100).toFixed(1)}% of revised` : ""
                      }`
                    : undefined
                }
                higherIsBetter
                tone={varianceTone(variance)}
                hint="Revised budget − forecast at completion"
              />
            </Tile>
          </div>
        </CardBody>
      </Card>

      {hasDrift ? (
        <Alert
          tone="warning"
          title="The stored cost columns are behind the source tools"
          actions={
            <Button
              size="xs"
              variant="secondary"
              leadingIcon={IconRefresh}
              loading={recalculating}
              onClick={onRecalculate}
            >
              Recalculate
            </Button>
          }
        >
          <ul className="space-y-1">
            {driftCommitted !== null && Math.abs(driftCommitted) >= 0.01 ? (
              <li>
                Committed cost differs by{" "}
                <strong className="tabular-nums">
                  {money(driftCommitted, currency, { signed: true })}
                </strong>{" "}
                from what the commitments tool holds right now.
              </li>
            ) : null}
            {driftJtd !== null && Math.abs(driftJtd) >= 0.01 ? (
              <li>
                Job-to-date cost differs by{" "}
                <strong className="tabular-nums">{money(driftJtd, currency, { signed: true })}</strong>{" "}
                from what the invoices tool holds right now.
              </li>
            ) : null}
            <li className="text-meta text-content-muted">
              Totals last calculated {dateTime(summary?.drift.totalsCalculatedAt)}.
            </li>
          </ul>
        </Alert>
      ) : null}

      {summary && summary.reconciliation.some((identity) => !identity.ok) ? (
        <Alert tone="danger" title="This budget does not reconcile" icon={IconWarning}>
          <ul className="space-y-1">
            {summary.reconciliation
              .filter((identity) => !identity.ok)
              .map((identity) => (
                <li key={identity.identity} className="tabular-nums">
                  {identity.identity} — {money(identity.left, currency)} vs{" "}
                  {money(identity.right, currency)} (out by {money(identity.delta, currency)})
                </li>
              ))}
          </ul>
        </Alert>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <ChartCard
            title="Original budget → forecast at completion"
            subtitle="Every step is a stored figure; nothing between the bars is inferred"
            metric={plan ? money(plan.forecastFinal, currency) : undefined}
            metricCaption={`Forecast at completion · ${currency}`}
            loading={loading}
            footnote={
              plan
                ? "Pending changes are exposure, not budget: they sit outside the revised budget on purpose, and only an approved movement moves it."
                : undefined
            }
            footerMeta={
              summary ? (
                <ReconciliationBadge identities={summary.reconciliation} currency={currency} />
              ) : undefined
            }
          >
            <WaterfallChart
              data={steps}
              valueFormat="currency"
              formatOptions={{ currency }}
              higherIsBetter={false}
              height={280}
              ariaLabel="Bridge from original budget to forecast at completion"
              emptyTitle="No bridge to draw"
              emptyMessage="This budget holds no lines yet, so there is no movement between the original budget and a forecast."
              empty={steps.length === 0}
              dataTableLabel="View the bridge as a table"
            />
          </ChartCard>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardBody>
              <h3 className="text-label uppercase text-content-subtle">Contingency remaining</h3>
              <p className="mt-1 text-display-xs font-semibold tabular-nums text-content">
                {summary ? (
                  <FigureValue
                    figure={summary.components.contingencyRemaining}
                    currency={currency}
                    reasonsBelow
                  />
                ) : (
                  EM_DASH
                )}
              </p>
              {summary && summary.components.contingencyRemaining.value !== null ? (
                <p className="mt-1 text-meta text-content-muted">
                  Drawn to date{" "}
                  <span className="tabular-nums">
                    {money(
                      numberInput(summary.components.contingencyRemaining.inputs, "drawn"),
                      currency,
                      { signed: true },
                    )}
                  </span>{" "}
                  across{" "}
                  {String(summary.components.contingencyRemaining.inputs["lines"] ?? "0")} contingency
                  line(s).
                </p>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <h3 className="text-label uppercase text-content-subtle">Largest overruns</h3>
              {summary === null ? (
                <p className="mt-2 text-meta text-content-muted">Loading…</p>
              ) : summary.overrunLines.length === 0 ? (
                <p className="mt-2 text-meta text-content-muted">
                  No line is currently forecast above its revised budget.
                </p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {summary.overrunLines.slice(0, 6).map((line) => (
                    <li key={line.lineItemId} className="flex items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block truncate font-mono text-code text-content">
                          {line.costCode}
                        </span>
                        <span className="block truncate text-meta text-content-muted">
                          {line.description}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block text-body font-semibold tabular-nums text-danger-fg">
                          {money(line.projectedOverUnder, currency, { signed: true })}
                        </span>
                        <span className="block text-meta text-content-subtle tabular-nums">
                          {money(line.revisedBudget, currency, { compact: true })} budget
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      {unavailable.length > 0 ? (
        <Card variant="sunken">
          <CardBody>
            <div className="flex items-center gap-2">
              <Badge tone="warning" size="sm">
                {unavailable.length} figure{unavailable.length === 1 ? "" : "s"} not available
              </Badge>
              <span className="text-meta text-content-muted">
                Shown as “Not available”, never as zero. The platform's own reasons follow, unedited.
              </span>
            </div>
            <dl className="mt-3 grid gap-3 md:grid-cols-2">
              {unavailable.map((entry) => (
                <div key={entry.label}>
                  <dt className="text-meta font-semibold text-content">{entry.label}</dt>
                  <dd className="mt-1">
                    <ReasonList reasons={entry.reasons} />
                  </dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>
      ) : null}

      {disclosed.length > 0 ? (
        <Card variant="sunken">
          <CardBody>
            <h3 className="text-label uppercase text-content-subtle">Disclosures on the cost side</h3>
            <dl className="mt-2 grid gap-3 md:grid-cols-2">
              {disclosed.map((entry) => (
                <div key={entry.label}>
                  <dt className="text-meta font-semibold text-content">{entry.label}</dt>
                  <dd className="mt-1">
                    <ReasonList reasons={entry.reasons} />
                  </dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

function Tile({ children }: { children: ReactNode }) {
  return <div className="bg-surface-raised p-card">{children}</div>;
}

function numberInput(inputs: Record<string, unknown>, key: string): number | null {
  const raw = inputs[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}
