/**
 * THE CHANGE LOG — the reconciliation everything ties back to.
 *
 * Every figure here comes from rows, and every figure is paired with the
 * identity that says which rows. The one thing it will not do is add up money
 * in two currencies: a project running a USD prime contract and a EUR supply
 * commitment gets two reconciliations and a stated reason, never one number
 * that is true of neither.
 *
 * The contract-sum movement is the figure a monthly report opens with, so it
 * is shown as a bridge — original, plus each executed change, to revised —
 * with the stored revised sum checked against the running total at every step.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorAlert,
  SegmentedControl,
  Stat,
} from "../../ui";
import { DescriptionList } from "../../ui/data";
import {
  ChartCard,
  WaterfallChart,
  type WaterfallStep,
} from "../../ui/charts";
import { IconLedger } from "../../ui/icons";
import {
  ComponentValue,
  IdentityList,
  PanelSkeleton,
  Reasons,
  days,
  label,
  money,
  num,
  useResource,
  type ChangeLogReconciliation,
  type ChangeLogResponse,
} from "./changesShared";

interface ContractMovementResponse {
  projectId: string;
  contracts: Array<{
    primeContractId: string;
    reference: string;
    currency: string;
    originalContractSum: number;
    approvedChangeSum: number;
    pendingChangeSum: number;
    revisedContractSum: number;
    executedChanges: Array<{
      reference: string;
      title: string;
      amount: number;
      executedDate: string | null;
      scheduleImpactDays: number;
      runningContractSum: number;
      storedRevisedContractSum: number;
      agrees: boolean;
    }>;
    reconciles: boolean;
  }>;
}

interface TimeImpactResponse {
  projectId: string;
  totals: {
    daysClaimed: number;
    daysApproved: number;
    daysModelled: { value: number | null; inputs: Record<string, unknown>; reasons: string[] };
    unsupportedDays: { value: number | null; inputs: Record<string, unknown>; reasons: string[] };
    requestsClaimingTime: number;
    requestsClaimingTimeWithNoDelayEvent: number;
  };
  unlinked: Array<{
    changeOrderRequestId: string;
    reference: string;
    daysClaimed: number;
    verdict: string;
  }>;
}

function countsTable(title: string, counts: Record<string, number>) {
  const rows = Object.entries(counts).filter(([, n]) => n > 0);
  return (
    <div>
      <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
        {title}
      </p>
      {rows.length === 0 ? (
        <p className="text-meta text-content-muted">None on the record.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {rows.map(([key, n]) => (
            <Badge key={key} tone="neutral" variant="outline" size="xs">
              {label(key)} {n}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function Reconciliation({
  group,
  movement,
}: {
  group: ChangeLogReconciliation;
  movement: ContractMovementResponse["contracts"][number] | undefined;
}) {
  const currency = group.currency;

  const bridge = useMemo<WaterfallStep[]>(() => {
    if (!movement) return [];
    const steps: WaterfallStep[] = [
      { label: "Original contract sum", value: movement.originalContractSum, kind: "subtotal" },
    ];
    for (const change of movement.executedChanges) {
      steps.push({
        label: change.reference,
        value: change.amount,
        kind: "delta",
        note: `${change.title}${change.agrees ? "" : " — stored revised sum disagrees with the running total"}`,
      });
    }
    steps.push({ label: "Revised contract sum", kind: "total" });
    return steps;
  }, [movement]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Change events"
          value={num(group.events.total, 0)}
          hint={`${group.events.openScheduleImpactDays} days claimed on open events`}
        />
        <Stat
          label="Priced (PCO position)"
          value={money(group.pcos.positionTotal, currency)}
          hint={`${group.pcos.total} PCOs · ${group.pcos.noChargeCount} absorbed at no charge`}
        />
        <Stat
          label="Asked of the owner"
          value={money(group.cors.requestedTotal, currency)}
          hint={`${group.cors.total} change order requests`}
        />
        <Stat
          label="Granted by the owner"
          value={money(group.cors.approvedTotal, currency)}
          hint={`negotiation gap ${money(group.cors.negotiationGap, currency)} on decided requests`}
        />
      </div>

      <Card>
        <CardHeader
          title={`Reconciliation — ${currency}`}
          subtitle="Counts and money, side by side, so every figure can be traced to the rows behind it."
          icon={IconLedger}
          actions={
            <Badge tone={group.ok ? "success" : "danger"}>
              {group.ok ? "ties out" : "does not tie"}
            </Badge>
          }
        />
        <CardBody className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              {countsTable("Change events by status", group.events.byStatus)}
              {countsTable("Change events by cause", group.events.byType)}
              {countsTable("Potential change orders by status", group.pcos.byStatus)}
              {countsTable("Change order requests by status", group.cors.byStatus)}
              {countsTable("Packages by status", group.packages.byStatus)}
            </div>
            <div className="space-y-3">
              <DescriptionList
                columns={2}
                items={[
                  {
                    label: "ROM total",
                    value: money(group.events.roughOrderOfMagnitudeTotal, currency),
                    hint: "first guesses, at identification",
                  },
                  {
                    label: "Estimated cost total",
                    value: money(group.events.estimatedCostTotal, currency),
                  },
                  {
                    label: "Latest cost total",
                    value: money(group.events.latestCostTotal, currency),
                  },
                  {
                    label: "PCO estimate total",
                    value: money(group.pcos.estimatedTotal, currency),
                  },
                  {
                    label: "PCO quoted total",
                    value: money(group.pcos.quotedTotal, currency),
                  },
                  {
                    label: "Quote vs estimate",
                    value: (
                      <ComponentValue
                        component={group.pcos.quoteVarianceAgainstEstimate}
                        currency={currency}
                      />
                    ),
                  },
                  {
                    label: "Rejected by the owner",
                    value: money(group.cors.rejectedTotal, currency),
                  },
                  {
                    label: "Approval rate",
                    value: (
                      <ComponentValue
                        component={group.cors.approvalRatePercent}
                        format="percent"
                      />
                    ),
                  },
                  {
                    label: "Days claimed / granted",
                    value: `${days(group.cors.daysClaimed)} / ${days(group.cors.daysApproved)}`,
                  },
                  {
                    label: "Executed on the prime contract",
                    value: money(group.packages.executedPrimeTotal, currency),
                  },
                  {
                    label: "Executed on commitments",
                    value: money(group.packages.executedCommitmentTotal, currency),
                  },
                  {
                    label: "Executed revenue with no change event",
                    value: money(group.unattributedExecutedRevenue, currency),
                    hint: "money in the contract sum that no change event explains",
                  },
                ]}
              />
            </div>
          </div>

          <div>
            <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
              Identities checked
            </p>
            <IdentityList identities={group.identities} currency={currency} />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Margin on executed change"
          subtitle="Executed revenue against executed cost. Only executed money counts — an approved COR with no commitment change under it is revenue we have not yet bought."
        />
        <CardBody>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Revenue" value={money(group.marginTotal.revenue, currency)} size="sm" />
            <Stat label="Cost" value={money(group.marginTotal.cost, currency)} size="sm" />
            <Stat label="Margin" value={money(group.marginTotal.margin, currency)} size="sm" />
            <div>
              <div className="text-2xs uppercase tracking-wide text-content-subtle">Margin %</div>
              <div className="text-h4">
                <ComponentValue component={group.marginTotal.marginPercent} format="percent" />
              </div>
            </div>
          </div>
        </CardBody>
      </Card>

      {movement ? (
        <ChartCard
          title={`Contract sum movement — ${movement.reference}`}
          subtitle="Original, plus every executed change, to revised. Each step's stored revised sum is checked against the running total."
          metric={money(movement.revisedContractSum, movement.currency)}
          metricCaption={`from ${money(movement.originalContractSum, movement.currency)} original`}
          footnote={
            movement.reconciles
              ? "Every executed change agrees with the contract's stored revised sum."
              : "At least one executed change disagrees with the contract's stored revised sum. The disagreeing steps are noted on the chart."
          }
        >
          {bridge.length <= 1 ? (
            <EmptyState
              size="sm"
              title="No executed change on this contract"
              hint="The revised sum equals the original. That is a fact about the contract, not a missing figure."
            />
          ) : (
            <WaterfallChart
              data={bridge}
              baseline={0}
              valueFormat="currency"
              formatOptions={{ currency: movement.currency }}
              higherIsBetter
              ariaLabel={`Contract sum movement for ${movement.reference}`}
              height={300}
            />
          )}
        </ChartCard>
      ) : null}

      {group.contractMovement.length > 0 ? (
        <Card>
          <CardHeader
            title="Contract movement, per contract"
            subtitle="Σ executed packages against Σ executed contract changes. They must agree, and the identity says by how much they do not."
          />
          <CardBody className="space-y-3">
            {group.contractMovement.map((contract) => (
              <div key={contract.primeContractId} className="rounded-md border border-border p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-meta text-content">{contract.reference}</span>
                  <Badge tone={contract.ok ? "success" : "danger"} size="xs">
                    {contract.ok ? "ties" : "does not tie"}
                  </Badge>
                </div>
                <DescriptionList
                  columns={3}
                  size="sm"
                  items={[
                    { label: "Original", value: money(contract.originalContractSum, currency) },
                    {
                      label: "Approved changes",
                      value: money(contract.approvedChangeSum, currency),
                    },
                    { label: "Pending", value: money(contract.pendingChangeSum, currency) },
                    { label: "Revised", value: money(contract.revisedContractSum, currency) },
                    {
                      label: "Σ executed packages",
                      value: money(contract.executedPackageTotal, currency),
                    },
                    {
                      label: "Σ executed changes",
                      value: money(contract.executedChangeTotal, currency),
                    },
                  ]}
                />
                <div className="mt-2">
                  <IdentityList identities={contract.identities} currency={currency} />
                </div>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

export default function ChangeLogTab({
  projectId,
  changeLog,
  loading,
  error,
  reload,
}: {
  projectId: string;
  changeLog: ChangeLogResponse | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}) {
  const movement = useResource<ContractMovementResponse>(
    `/api/v1/projects/${projectId}/change-log/contract-movement`,
  );
  const timeImpact = useResource<TimeImpactResponse>(
    `/api/v1/projects/${projectId}/change-log/time-impact`,
  );

  const groups = changeLog?.groups ?? [];
  const [currency, setCurrency] = useState<string>("");

  const active = useMemo(() => {
    if (groups.length === 0) return null;
    if (currency) return groups.find((g) => g.currency === currency) ?? groups[0] ?? null;
    return groups[0] ?? null;
  }, [groups, currency]);

  const movementForActive = useMemo(() => {
    if (!active) return undefined;
    return movement.data?.contracts.find((c) => c.currency.toUpperCase() === active.currency);
  }, [active, movement.data]);

  if (loading && !changeLog) return <PanelSkeleton rows={8} />;

  return (
    <div className="space-y-4">
      <ErrorAlert message={error} />

      {changeLog?.mixedCurrency ? (
        <Reasons
          reasons={changeLog.reasons}
          tone="warning"
          title="This project holds money in more than one currency"
        />
      ) : null}

      {groups.length === 0 ? (
        <EmptyState
          icon={IconLedger}
          title="No reconciliation to show"
          hint={
            error ??
            "The change log returned no currency group. That means the project holds no contracts and no change records yet — not that the figures are zero."
          }
        />
      ) : (
        <>
          {groups.length > 1 ? (
            <SegmentedControl
              value={active?.currency ?? groups[0]!.currency}
              onChange={setCurrency}
              options={groups.map((g) => ({ value: g.currency, label: g.currency }))}
              aria-label="Currency"
            />
          ) : null}

          {active ? <Reconciliation group={active} movement={movementForActive} /> : null}
        </>
      )}

      {/* ---- time claimed vs time modelled ---- */}
      <Card>
        <CardHeader
          title="Time claimed against time modelled"
          subtitle="Days claimed on change order requests, set against the delay analysis in the forensics module. What is NOT linked is the finding that matters."
          actions={
            <button
              type="button"
              onClick={() => {
                reload();
                movement.reload();
                timeImpact.reload();
              }}
              className="text-2xs text-accent-text underline-offset-2 hover:underline"
            >
              Refresh
            </button>
          }
        />
        <CardBody>
          {timeImpact.loading && !timeImpact.data ? (
            <PanelSkeleton rows={3} />
          ) : timeImpact.error ? (
            <ErrorAlert message={timeImpact.error} />
          ) : timeImpact.data ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-4">
                <Stat
                  label="Days claimed"
                  value={days(timeImpact.data.totals.daysClaimed)}
                  size="sm"
                />
                <Stat
                  label="Days granted"
                  value={days(timeImpact.data.totals.daysApproved)}
                  size="sm"
                />
                <div>
                  <div className="text-2xs uppercase tracking-wide text-content-subtle">
                    Days modelled
                  </div>
                  <div className="text-h4">
                    <ComponentValue
                      component={timeImpact.data.totals.daysModelled}
                      format="days"
                    />
                  </div>
                </div>
                <div>
                  <div className="text-2xs uppercase tracking-wide text-content-subtle">
                    Unsupported days
                  </div>
                  <div className="text-h4">
                    <ComponentValue
                      component={timeImpact.data.totals.unsupportedDays}
                      format="days"
                    />
                  </div>
                </div>
              </div>

              {timeImpact.data.totals.requestsClaimingTimeWithNoDelayEvent > 0 ? (
                <Alert
                  tone="warning"
                  variant="subtle"
                  size="sm"
                  title={`${timeImpact.data.totals.requestsClaimingTimeWithNoDelayEvent} request(s) claim time with no analysed delay event behind them`}
                >
                  <ul className="ml-4 mt-1 list-disc space-y-0.5">
                    {timeImpact.data.unlinked.map((row) => (
                      <li key={row.changeOrderRequestId}>
                        {row.reference} — {days(row.daysClaimed)} claimed · {label(row.verdict)}
                      </li>
                    ))}
                  </ul>
                </Alert>
              ) : (
                <p className="text-meta text-content-muted">
                  Every request claiming time links to a delay event.
                </p>
              )}
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Alert tone="info" variant="subtle" size="sm" title="Why nothing here is summed across currencies">
        There is no exchange rate on any of these records. A single cross-currency total would be a
        number invented by this screen, so each currency gets its own reconciliation and the
        percentages are computed inside it.
        {changeLog ? ` Currencies on this project: ${changeLog.currencies.join(", ") || "none"}.` : ""}
      </Alert>
    </div>
  );
}
