/**
 * The two money pictures on the command centre.
 *
 *   ProgressCurve     cumulative work completed and stored, read straight off
 *                     the owner applications, against the revised contract sum.
 *   ContractMovement  original → approved → pending → revised, as a bridge.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO "PLANNED" LINE ON THE S-CURVE
 *
 * A planned cash-flow curve is a stored baseline. This platform does not hold
 * one: the schedule module stores dates and durations, not a time-phased
 * budget. Drawing a straight line from contract award to completion and
 * calling it "planned" would be a fabricated baseline, and every variance
 * measured against it would be fiction. So the chart draws what exists — the
 * actual curve — states the absence in its footnote, and leaves it there.
 */
import { ChartCard, SCurveChart, WaterfallChart } from "../../../ui";
import { IconChartLine, IconChangeOrder } from "../../../ui/icons";
import type { Loadable, Paginated, PrimeContractCurrencyGroup } from "../../../layouts/project/lib";
import { money } from "../../../layouts/project/lib";
import type { InvoiceRow } from "./types";

/** Invoice statuses the invoicing module itself treats as live. */
const LIVE_INVOICE_STATUSES = [
  "submitted",
  "under_review",
  "approved",
  "approved_as_noted",
  "paid",
];

export interface ProgressCurveProps {
  currency: string;
  invoices: Loadable<Paginated<InvoiceRow>>;
  contractGroup: PrimeContractCurrencyGroup | null;
  className?: string;
}

export function ProgressCurve({
  currency,
  invoices,
  contractGroup,
  className,
}: ProgressCurveProps) {
  const all = invoices.data?.items ?? [];
  const rows = all
    .filter(
      (invoice) =>
        invoice.currency === currency &&
        LIVE_INVOICE_STATUSES.includes(invoice.status) &&
        Boolean(invoice.billingDate),
    )
    .sort((a, b) => (a.billingDate ?? "").localeCompare(b.billingDate ?? ""))
    .map((invoice) => ({
      period: invoice.billingDate!,
      actual: invoice.totalCompletedAndStored,
      reference: invoice.reference,
    }));

  const target = contractGroup?.revisedContractSum;
  const latest = rows.length > 0 ? rows[rows.length - 1] : null;

  const emptyMessage =
    all.length === 0
      ? "No owner application has been raised on this project, so nothing has been billed and there is no curve to draw. A flat line at zero would be a claim that no work has been done."
      : `No live owner application on this project is written in ${currency}. Applications exist in ${[
          ...new Set(all.map((invoice) => invoice.currency)),
        ].join(", ")}.`;

  return (
    <ChartCard
      className={className}
      title="Progress against the contract sum"
      subtitle={`Cumulative work completed and stored, per owner application · ${currency}`}
      icon={IconChartLine}
      metric={latest ? money(latest.actual, currency) : undefined}
      metricCaption={
        latest
          ? `Application ${latest.reference} · ${latest.period}`
          : undefined
      }
      footnote={
        <>
          Read from the <strong>total completed and stored</strong> line of every live owner
          application — the figure is already cumulative, so nothing here is re-derived. No
          time-phased baseline is stored on this project, so no planned curve is drawn rather than
          an invented one.
          {target !== undefined
            ? ` The target line is the revised contract sum, ${money(target, currency)}.`
            : ""}
        </>
      }
      footerMeta={
        invoices.data ? `${rows.length} application${rows.length === 1 ? "" : "s"}` : undefined
      }
    >
      <SCurveChart
        data={rows}
        keys={{ period: "period", actual: "actual" }}
        labels={{ actual: "Completed and stored" }}
        {...(target !== undefined ? { target, targetLabel: "Revised contract sum" } : {})}
        valueFormat="currency-compact"
        formatOptions={{ currency }}
        labelFormat="dayShort"
        height={260}
        loading={invoices.loading && !invoices.data}
        error={invoices.error}
        empty={rows.length === 0}
        emptyTitle="Nothing billed yet"
        emptyMessage={emptyMessage}
        ariaLabel="Cumulative work completed and stored against the revised contract sum"
      />
    </ChartCard>
  );
}

export interface ContractMovementProps {
  currency: string;
  contractGroup: PrimeContractCurrencyGroup | null;
  loading: boolean;
  error: string | null;
  /** Currencies that DO have a prime contract, for the empty-state reason. */
  availableCurrencies: string[];
  className?: string;
}

export function ContractMovement({
  currency,
  contractGroup,
  loading,
  error,
  availableCurrencies,
  className,
}: ContractMovementProps) {
  const steps = contractGroup
    ? [
        {
          label: "Original",
          value: contractGroup.originalContractSum,
          kind: "subtotal" as const,
        },
        {
          label: "Approved changes",
          value: contractGroup.approvedChangeSum,
          kind: "delta" as const,
          note: "Executed change orders on the prime contract",
        },
        {
          label: "Revised",
          kind: "total" as const,
          note: "Original plus approved changes",
        },
        {
          label: "Pending",
          value: contractGroup.pendingChangeSum,
          kind: "delta" as const,
          note: "Submitted but not executed — not yet in the revised sum",
        },
      ]
    : [];

  return (
    <ChartCard
      className={className}
      title="Contract movement"
      subtitle={`Where the contract sum has moved · ${currency}`}
      icon={IconChangeOrder}
      metric={contractGroup ? money(contractGroup.revisedContractSum, currency) : undefined}
      metricCaption={contractGroup ? "Revised contract sum" : undefined}
      footnote={
        contractGroup
          ? "The pending bar sits AFTER the revised total on purpose: a submitted change is not part of the contract sum until it is executed, and drawing it inside the total is how a forecast becomes a claim."
          : undefined
      }
    >
      <WaterfallChart
        data={steps}
        valueFormat="currency-compact"
        formatOptions={{ currency }}
        higherIsBetter
        height={260}
        loading={loading}
        error={error}
        empty={steps.length === 0}
        emptyTitle="No prime contract"
        emptyMessage={
          availableCurrencies.length === 0
            ? "No prime contract has been raised on this project. The contract sum, its changes and the billing position all come from that record."
            : `No prime contract on this project is written in ${currency}. Contracts exist in ${availableCurrencies.join(", ")} — switch currency above to see them.`
        }
        ariaLabel="Movement of the prime contract sum from original to revised"
      />
    </ChartCard>
  );
}
