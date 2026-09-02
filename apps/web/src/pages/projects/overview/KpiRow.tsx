/**
 * The KPI rail — the seven numbers a project director asks for first.
 *
 * ---------------------------------------------------------------------------
 * THE RULES THIS FILE EXISTS TO ENFORCE
 *
 *   · Money is reported IN ONE CURRENCY at a time, chosen above the rail, and
 *     is never added across currencies. A tile with no figure in the selected
 *     currency says so and names the currencies that do have one.
 *   · A figure with no source renders "not available" WITH THE REASON. There
 *     is no branch in this file that turns an absent number into 0.
 *   · Every reason is the server's own sentence where the server gave one.
 */
import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { Tooltip } from "../../../ui";
import {
  IconAlert,
  IconBudget,
  IconCalendar,
  IconCommitment,
  IconInvoice,
  IconRfi,
  IconTrendDown,
  type IconComponent,
} from "../../../ui/icons";
import { cx } from "../../../ui/cx";
import { toneClass, type Tone } from "../../../ui/tokens";
import { useProjectWorkspace } from "../../../layouts/project/context";
import {
  NotAvailable,
  count,
  daysBetween,
  money,
  todayIso,
  type Loadable,
  type Paginated,
} from "../../../layouts/project/lib";
import type {
  BudgetRow,
  BudgetSummary,
  CommitmentList,
  PunchAnalytics,
  RfiAnalytics,
} from "./types";
import { activeBudget } from "./hooks";

export interface KpiRowProps {
  currency: string;
  commitments: Loadable<CommitmentList>;
  budgets: Loadable<Paginated<BudgetRow>>;
  budgetSummary: Loadable<BudgetSummary>;
  rfiAnalytics: Loadable<RfiAnalytics>;
  punchAnalytics: Loadable<PunchAnalytics>;
}

interface Kpi {
  id: string;
  label: string;
  icon: IconComponent;
  loading: boolean;
  /** `null` means "we do not hold this" — never render it as zero. */
  value: ReactNode | null;
  reasons?: string[];
  /** The unabbreviated figure, surfaced on hover for the compact tiles. */
  valueTitle?: string;
  hint?: ReactNode;
  tone?: Tone;
  to?: string;
}

export default function KpiRow({
  currency,
  commitments,
  budgets,
  budgetSummary,
  rfiAnalytics,
  punchAnalytics,
}: KpiRowProps) {
  const { project, contracts, summary } = useProjectWorkspace();

  const contractGroups = contracts.data?.groups ?? [];
  const contractGroup = contractGroups.find((g) => g.currency === currency) ?? null;
  const commitmentTotals =
    commitments.data?.totalsByCurrency.find((t) => t.currency === currency) ?? null;
  const budget = activeBudget(budgets.data);
  const summaryData = budgetSummary.data;
  const budgetMatchesCurrency = summaryData ? summaryData.currency === currency : false;

  const remaining = daysBetween(todayIso(), project.data?.finishDate ?? null);

  /* -------------------------------------------------------- contract value */
  const contractValue: Kpi = {
    id: "contract-value",
    label: "Contract value",
    icon: IconBudget,
    loading: contracts.loading && !contracts.data,
    value: contractGroup
      ? money(contractGroup.revisedContractSum, currency, { compact: true })
      : null,
    valueTitle: contractGroup
      ? money(contractGroup.revisedContractSum, currency)
      : undefined,
    reasons: contractGroup
      ? undefined
      : contractGroups.length === 0
        ? [
            "No prime contract has been raised on this project, so there is no contract sum to report.",
          ]
        : [
            `No prime contract on this project is written in ${currency}. ` +
              `Contracts exist in ${contractGroups.map((g) => g.currency).join(", ")}.`,
          ],
    hint: contractGroup
      ? `Revised · ${contractGroup.contractCount} contract${contractGroup.contractCount === 1 ? "" : "s"}`
      : undefined,
    to: "prime-contract",
  };

  /* -------------------------------------------------------------- committed */
  const committed: Kpi = {
    id: "committed",
    label: "Committed",
    icon: IconCommitment,
    loading: commitments.loading && !commitments.data,
    value: commitmentTotals
      ? money(commitmentTotals.revisedCommitmentSum, currency, { compact: true })
      : null,
    valueTitle: commitmentTotals
      ? money(commitmentTotals.revisedCommitmentSum, currency)
      : undefined,
    reasons: commitmentTotals
      ? undefined
      : (commitments.data?.totalsByCurrency.length ?? 0) === 0
        ? ["No subcontract or purchase order has been raised on this project."]
        : [
            `No commitment on this project is written in ${currency}. ` +
              `Commitments exist in ${commitments.data?.totalsByCurrency.map((t) => t.currency).join(", ")}.`,
          ],
    hint: commitmentTotals
      ? `${commitmentTotals.commitmentCount} commitment${commitmentTotals.commitmentCount === 1 ? "" : "s"} · revised`
      : undefined,
    to: "commitments",
  };

  /* --------------------------------------------------------------- invoiced */
  const invoiced: Kpi = {
    id: "invoiced",
    label: "Invoiced to owner",
    icon: IconInvoice,
    loading: contracts.loading && !contracts.data,
    value: contractGroup ? money(contractGroup.totalBilled, currency, { compact: true }) : null,
    valueTitle: contractGroup ? money(contractGroup.totalBilled, currency) : undefined,
    reasons: contractGroup
      ? undefined
      : ["Billing to date is read from the prime contract, and this project has none in " + currency + "."],
    hint: contractGroup
      ? `Retainage held ${money(contractGroup.retainageHeld, currency, { compact: true })}`
      : undefined,
    to: "invoicing",
  };

  /* ------------------------------------------------------ forecast variance */
  const varianceValue =
    summaryData && budgetMatchesCurrency ? summaryData.plan.variance : null;
  const forecastVariance: Kpi = {
    id: "variance",
    label: "Forecast variance",
    icon: IconTrendDown,
    loading: budgets.loading || (budget !== null && budgetSummary.loading && !summaryData),
    value: varianceValue === null ? null : money(varianceValue, currency, { compact: true }),
    valueTitle: varianceValue === null ? undefined : money(varianceValue, currency),
    tone: varianceValue === null ? undefined : varianceValue < 0 ? "danger" : "success",
    reasons:
      varianceValue !== null
        ? undefined
        : !budget
          ? ["No budget has been created on this project, so there is nothing to forecast against."]
          : summaryData
            ? [
                `The active budget "${summaryData.reference}" is written in ${summaryData.currency}, ` +
                  `not ${currency}. Budgets are never converted, so no ${currency} variance exists.`,
              ]
            : [
                budgetSummary.error ??
                  "The active budget's summary has not been read, so no variance can be stated.",
              ],
    hint:
      varianceValue === null
        ? undefined
        : varianceValue < 0
          ? "Projected overrun against revised budget"
          : "Projected underrun against revised budget",
    to: "budget",
  };

  /* --------------------------------------------------------- days remaining */
  const daysRemaining: Kpi = {
    id: "days",
    label: "Days remaining",
    icon: IconCalendar,
    loading: project.loading && !project.data,
    value: remaining === null ? null : count(Math.abs(remaining)),
    tone: remaining !== null && remaining < 0 ? "danger" : undefined,
    reasons:
      remaining !== null
        ? undefined
        : [
            "No finish date is recorded on the project, so the time remaining is unknown rather than zero.",
          ],
    hint:
      remaining === null
        ? undefined
        : remaining < 0
          ? "past the recorded finish date"
          : "to the recorded finish date",
  };

  /* --------------------------------------------------------------- open RFIs */
  const rfiOpen = rfiAnalytics.data?.open ?? summary.data?.rfisOpen ?? null;
  const openRfis: Kpi = {
    id: "rfis",
    label: "Open RFIs",
    icon: IconRfi,
    loading: rfiAnalytics.loading && !rfiAnalytics.data && summary.loading,
    value: rfiOpen === null ? null : count(rfiOpen),
    reasons:
      rfiOpen === null
        ? [rfiAnalytics.error ?? "The RFI register could not be read."]
        : undefined,
    hint:
      rfiAnalytics.data?.avgResponseDays !== null && rfiAnalytics.data?.avgResponseDays !== undefined
        ? `${rfiAnalytics.data.avgResponseDays} day average response`
        : rfiAnalytics.data
          ? "no RFI has been answered yet, so there is no average"
          : undefined,
    to: "rfis",
  };

  /* ----------------------------------------------------------- overdue items */
  const rfiOverdue = rfiAnalytics.data?.overdue ?? null;
  const punchOverdue = punchAnalytics.data?.overdue ?? null;
  const overdueKnown = rfiOverdue !== null || punchOverdue !== null;
  const overdueTotal = (rfiOverdue ?? 0) + (punchOverdue ?? 0);
  const overdueMissing: string[] = [];
  if (rfiOverdue === null) {
    overdueMissing.push(`overdue RFIs (${rfiAnalytics.error ?? "not read"})`);
  }
  if (punchOverdue === null) {
    overdueMissing.push(`overdue punch items (${punchAnalytics.error ?? "not read"})`);
  }

  const overdue: Kpi = {
    id: "overdue",
    label: "Overdue items",
    icon: IconAlert,
    loading:
      (rfiAnalytics.loading && !rfiAnalytics.data) || (punchAnalytics.loading && !punchAnalytics.data),
    value: overdueKnown ? count(overdueTotal) : null,
    tone: overdueKnown && overdueTotal > 0 ? "warning" : undefined,
    reasons: overdueKnown
      ? overdueMissing.length > 0
        ? [`This count EXCLUDES ${overdueMissing.join(" and ")}.`]
        : undefined
      : ["Neither the RFI nor the punch register could be read, so no overdue count can be stated."],
    hint: overdueKnown && overdueMissing.length === 0 ? "RFIs and punch items past due" : undefined,
  };

  const items: Kpi[] = [
    contractValue,
    committed,
    invoiced,
    forecastVariance,
    daysRemaining,
    openRfis,
    overdue,
  ];

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border-subtle md:grid-cols-4 xl:grid-cols-7">
      {items.map((kpi) => (
        <KpiTile key={kpi.id} kpi={kpi} />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function KpiTile({ kpi }: { kpi: Kpi }) {
  const Glyph = kpi.icon;

  const body = (
    <>
      <div className="flex items-center gap-1.5">
        <Glyph size={12} aria-hidden="true" className="shrink-0 text-content-disabled" />
        <span className="truncate text-label uppercase text-content-subtle">{kpi.label}</span>
      </div>

      {kpi.loading ? (
        <div className="mt-2 skeleton h-6 w-24 rounded-md" aria-hidden="true" />
      ) : kpi.value === null ? (
        <div className="mt-1.5 text-sm">
          <NotAvailable reasons={kpi.reasons} />
        </div>
      ) : (
        <>
          <div
            title={kpi.valueTitle}
            className={cx(
              "mt-1.5 truncate text-display-xs font-semibold tabular-nums tracking-[-0.02em]",
              kpi.tone ? toneClass(kpi.tone, "text") : "text-content",
            )}
          >
            {kpi.value}
          </div>
          {kpi.hint ? (
            <div className="mt-1 truncate text-2xs text-content-subtle">{kpi.hint}</div>
          ) : null}
          {kpi.reasons && kpi.reasons.length > 0 ? (
            <Tooltip content={kpi.reasons.join(" ")} maxWidth={320}>
              <span
                tabIndex={0}
                className="focus-ring mt-1 inline-flex cursor-help items-center gap-1 rounded text-2xs text-warning-fg outline-none"
              >
                <IconAlert size={11} aria-hidden="true" />
                partial
              </span>
            </Tooltip>
          ) : null}
        </>
      )}
    </>
  );

  const className = cx(
    "group/kpi min-w-0 bg-surface-raised px-3.5 py-3 transition-colors duration-fast",
    kpi.to && "hover:bg-surface-hover",
  );

  if (kpi.to && !kpi.loading) {
    return (
      <Link to={kpi.to} className={cx(className, "focus-ring block outline-none")}>
        {body}
      </Link>
    );
  }
  return <div className={className}>{body}</div>;
}
