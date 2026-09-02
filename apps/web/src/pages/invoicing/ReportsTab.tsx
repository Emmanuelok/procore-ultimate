/**
 * AGING AND CASH POSITION.
 *
 * Two rules govern every figure on this page and neither bends:
 *
 *   CURRENCY. Totals are bucketed by currency and never summed across them.
 *   There is no exchange rate on any of these records, and inventing one is
 *   fabrication. Two currencies get two charts.
 *
 *   MISSING INPUTS. An invoice with neither a due date nor a billing date has
 *   no age. It is NOT zero days old and it does not belong in the 0-30 bucket
 *   — it is listed separately with the reason, because a fabricated bucket
 *   here is how a 120-day-overdue payable hides in "current".
 *
 * Retainage is shown apart from billed-unpaid in the cash position, because it
 * is not late: it is withheld by agreement, and a forecast that treats
 * retainage as overdue receivables is a forecast that lies.
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
import { ChartCard, StackedBarChart } from "../../ui/charts";
import { DescriptionList } from "../../ui/data";
import { IconAnalytics, IconWarning } from "../../ui/icons";
import {
  AGING_BUCKET_LABEL,
  AGING_BUCKET_ORDER,
  CurrencyBlocks,
  PanelSkeleton,
  Reasons,
  isoDate,
  label,
  money,
  useResource,
  type AgingCurrencyBlock,
  type AgingReport,
  type CashPosition,
} from "./invoicingShared";

type Side = "payable" | "receivable";

interface ErpPreview {
  format: string;
  currency: string | null;
  currencies: string[];
  invoiceCount: number;
  lineCount: number;
  paymentCount: number;
  totals: { certified: number; paid: number; outstanding: number };
  columns: { invoices: string[]; payments: string[] };
  reasons: string[];
}

function AgingChart({ block, side }: { block: AgingCurrencyBlock; side: Side }) {
  const data = useMemo(
    () =>
      block.vendors.slice(0, 12).map((vendor) => ({
        vendor: vendor.vendorName ?? "Unassigned",
        d0_30: vendor.buckets.d0_30,
        d31_60: vendor.buckets.d31_60,
        d61_90: vendor.buckets.d61_90,
        d90_plus: vendor.buckets.d90_plus,
      })),
    [block.vendors],
  );

  return (
    <ChartCard
      title={`${side === "payable" ? "Payable" : "Receivable"} aging — ${block.currency}`}
      subtitle={`${block.invoiceCount} live invoice(s), ${block.vendors.length} counterpart(ies). Bands are inclusive at the top: 0-30, 31-60, 61-90, 90+.`}
      metric={money(block.total, block.currency)}
      metricCaption={`outstanding in ${block.currency}`}
      icon={IconAnalytics}
      footnote="One chart per currency. Nothing on it is summed across currencies — there is no exchange rate on these records."
    >
      {data.length === 0 ? (
        <EmptyState
          size="sm"
          title="Nothing outstanding in this currency"
          hint="No live invoice in this currency has money still owed on it."
        />
      ) : (
        <StackedBarChart
          data={data}
          categoryKey="vendor"
          orientation="horizontal"
          series={AGING_BUCKET_ORDER.map((bucket) => ({
            key: bucket,
            label: AGING_BUCKET_LABEL[bucket],
          }))}
          valueFormat="currency"
          formatOptions={{ currency: block.currency }}
          ariaLabel={`${side} aging by counterparty in ${block.currency}`}
          height={Math.max(220, data.length * 34 + 80)}
        />
      )}
    </ChartCard>
  );
}

function AgingTable({ block }: { block: AgingCurrencyBlock }) {
  return (
    <Card>
      <CardHeader
        title={`Aging detail — ${block.currency}`}
        subtitle="Per counterparty, oldest first, with every invoice behind the bucket."
      />
      <CardBody className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-meta">
          <thead>
            <tr className="border-b border-border text-2xs uppercase tracking-wide text-content-subtle">
              <th className="py-1.5 pr-3 text-left font-semibold">Counterparty</th>
              {AGING_BUCKET_ORDER.map((bucket) => (
                <th key={bucket} className="py-1.5 pr-3 text-right font-semibold">
                  {AGING_BUCKET_LABEL[bucket]}
                </th>
              ))}
              <th className="py-1.5 pr-3 text-right font-semibold">Total</th>
              <th className="py-1.5 text-right font-semibold">Oldest</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {block.vendors.map((vendor) => (
              <tr key={vendor.vendorId ?? "unassigned"}>
                <td className="py-1.5 pr-3 text-content">
                  {vendor.vendorName ?? (
                    <span className="text-content-subtle">Unassigned</span>
                  )}
                </td>
                {AGING_BUCKET_ORDER.map((bucket) => (
                  <td
                    key={bucket}
                    className={
                      bucket === "d90_plus" && vendor.buckets[bucket] > 0
                        ? "py-1.5 pr-3 text-right tabular-nums text-danger-fg"
                        : "py-1.5 pr-3 text-right tabular-nums text-content"
                    }
                  >
                    {vendor.buckets[bucket] === 0 ? "—" : money(vendor.buckets[bucket], block.currency)}
                  </td>
                ))}
                <td className="py-1.5 pr-3 text-right font-medium tabular-nums text-content">
                  {money(vendor.total, block.currency)}
                </td>
                <td className="py-1.5 text-right tabular-nums text-content-muted">
                  {vendor.oldestDays} d
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-border font-medium">
            <tr>
              <td className="py-2 pr-3 text-content">Total ({block.currency})</td>
              {AGING_BUCKET_ORDER.map((bucket) => (
                <td key={bucket} className="py-2 pr-3 text-right tabular-nums text-content">
                  {money(block.buckets[bucket], block.currency)}
                </td>
              ))}
              <td className="py-2 pr-3 text-right tabular-nums text-content">
                {money(block.total, block.currency)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </CardBody>
    </Card>
  );
}

export default function ReportsTab({ projectId }: { projectId: string }) {
  const aging = useResource<AgingReport>(`/api/v1/projects/${projectId}/invoicing/aging`);
  const cash = useResource<CashPosition>(`/api/v1/projects/${projectId}/invoicing/cash-position`);
  const [side, setSide] = useState<Side>("payable");
  const [erpFormat, setErpFormat] = useState("generic");
  const [erpCurrency, setErpCurrency] = useState("");
  const erp = useResource<ErpPreview>(
    `/api/v1/projects/${projectId}/invoicing/erp-export?format=${erpFormat}${erpCurrency ? `&currency=${erpCurrency}` : ""}`,
  );

  const blocks =
    side === "payable"
      ? (aging.data?.payable.byCurrency ?? [])
      : (aging.data?.receivable.byCurrency ?? []);

  return (
    <div className="space-y-4">
      <ErrorAlert message={aging.error} />
      <ErrorAlert message={cash.error} />

      {/* ---------------- cash position ---------------- */}
      {cash.loading && !cash.data ? (
        <PanelSkeleton rows={4} />
      ) : cash.data ? (
        <Card>
          <CardHeader
            title="Cash position"
            subtitle={`As at ${isoDate(cash.data.asOf)}. Receivable and payable side by side, netted only inside one currency. Retainage is kept apart from billed-unpaid because it is not late — it is withheld by agreement.`}
          />
          <CardBody className="space-y-3">
            <Reasons reasons={cash.data.reasons} tone="warning" />
            {cash.data.currencyNote ? (
              <Alert tone="warning" variant="subtle" size="sm" title="More than one currency">
                {cash.data.currencyNote}
              </Alert>
            ) : null}

            <CurrencyBlocks
              blocks={cash.data.byCurrency}
              emptyTitle="No cash position to report"
              emptyHint="No live invoice and no retainage on this project. That is the evidence, not a zero somebody assumed."
              render={(block) => (
                <div className="rounded-md border border-border p-3">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Badge tone="accent">{block.currency}</Badge>
                    <span className="text-2xs text-content-subtle">
                      netted only inside this currency
                    </span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Stat
                      label="Receivable — billed, unpaid"
                      value={money(block.receivableBilledUnpaid, block.currency)}
                      size="sm"
                      hint={`overdue ${money(block.receivableOverdue, block.currency)}`}
                    />
                    <Stat
                      label="Receivable — retainage held by owner"
                      value={money(block.receivableRetainageHeldByOwner, block.currency)}
                      size="sm"
                      tone="warning"
                      hint="not late — withheld by agreement"
                    />
                    <Stat
                      label="Payable — invoiced, unpaid"
                      value={money(block.payableInvoicedUnpaid, block.currency)}
                      size="sm"
                      hint={`overdue ${money(block.payableOverdue, block.currency)}`}
                    />
                    <Stat
                      label="Payable — retainage we hold"
                      value={money(block.payableRetainageWeHold, block.currency)}
                      size="sm"
                      tone="warning"
                    />
                  </div>
                  <div className="mt-3 grid gap-3 border-t border-border-subtle pt-3 sm:grid-cols-2">
                    <div>
                      <div className="text-2xs uppercase tracking-wide text-content-subtle">
                        Net working position
                      </div>
                      <div className="text-h4 tabular-nums text-content">
                        {money(block.netWorkingPosition, block.currency)}
                      </div>
                      <div className="text-2xs text-content-subtle">
                        billed-unpaid in minus billed-unpaid out; retainage excluded
                      </div>
                    </div>
                    <div>
                      <div className="text-2xs uppercase tracking-wide text-content-subtle">
                        Net position including retainage
                      </div>
                      <div className="text-h4 tabular-nums text-content">
                        {money(block.netPositionIncludingRetainage, block.currency)}
                      </div>
                      <div className="text-2xs text-content-subtle">
                        the end-of-job picture, both sides
                      </div>
                    </div>
                  </div>
                </div>
              )}
            />

            {cash.data.openBillingPeriods.length > 0 ? (
              <div>
                <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                  Open billing periods
                </p>
                <ul className="space-y-1">
                  {cash.data.openBillingPeriods.map((period) => (
                    <li key={period.id} className="text-meta text-content-muted">
                      <span className="font-mono text-2xs">{period.reference}</span> {period.name} ·
                      billed through {isoDate(period.billingDate)}
                      {period.dueDate ? ` · payment due ${isoDate(period.dueDate)}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {/* ---------------- aging ---------------- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-h4 text-content">Aging</h3>
          <p className="text-meta text-content-muted">
            {aging.data?.bucketDefinition ??
              "Days outstanding are measured to the due date where one exists, otherwise the billing date."}
          </p>
        </div>
        <SegmentedControl<Side>
          value={side}
          onChange={setSide}
          options={[
            { value: "payable", label: "Payable (we owe)" },
            { value: "receivable", label: "Receivable (owed to us)" },
          ]}
          aria-label="Aging side"
        />
      </div>

      {aging.loading && !aging.data ? (
        <PanelSkeleton rows={5} />
      ) : blocks.length === 0 ? (
        <EmptyState
          icon={IconAnalytics}
          title={`Nothing outstanding on the ${side} side`}
          hint="No live invoice on this side has money still owed on it. That is the position, not an unread figure."
        />
      ) : (
        <div className="space-y-4">
          {blocks.map((block) => (
            <div key={block.currency} className="space-y-3">
              <AgingChart block={block} side={side} />
              <AgingTable block={block} />
            </div>
          ))}
        </div>
      )}

      {aging.data && aging.data.unaged.length > 0 ? (
        <Card>
          <CardHeader
            title="Invoices that could not be aged"
            subtitle="Excluded from every bucket rather than assumed current."
            icon={IconWarning}
            tone="warning"
          />
          <CardBody className="space-y-2">
            {aging.data.unaged.map((row) => (
              <div key={row.invoiceId} className="rounded-md border border-border px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-2xs text-content-subtle">{row.reference}</span>
                  <span className="tabular-nums text-content">
                    {money(row.outstanding, row.currency)}
                  </span>
                </div>
                <ul className="mt-1 ml-4 list-disc space-y-0.5 text-2xs text-content-muted">
                  {row.reasons.map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                </ul>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="ERP export"
          subtitle="Approved and paid invoices with their continuation-sheet lines and the payments against them, in the layout the finance system imports. One currency per batch."
          icon={IconAnalytics}
          actions={
            <span className="flex items-center gap-2">
              <select
                className="rounded border border-border bg-surface px-1 py-0.5 text-meta"
                value={erpFormat}
                onChange={(e) => setErpFormat(e.target.value)}
                aria-label="ERP format"
              >
                <option value="generic">Generic CSV</option>
                <option value="sage">Sage 300 CRE</option>
                <option value="quickbooks">QuickBooks</option>
                <option value="viewpoint">Viewpoint Vista</option>
              </select>
              {erp.data && erp.data.currencies.length > 1 ? (
                <select
                  className="rounded border border-border bg-surface px-1 py-0.5 text-meta"
                  value={erpCurrency}
                  onChange={(e) => setErpCurrency(e.target.value)}
                  aria-label="Currency"
                >
                  <option value="">Pick a currency…</option>
                  {erp.data.currencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : null}
            </span>
          }
        />
        <CardBody className="space-y-2">
          <ErrorAlert message={erp.error} />
          {erp.data ? (
            erp.data.currency === null ? (
              <Reasons reasons={erp.data.reasons} tone="warning" title="Nothing to export yet" />
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-4">
                  <Stat label="Invoices" value={erp.data.invoiceCount} hint={`${erp.data.lineCount} lines · ${erp.data.currency}`} />
                  <Stat label="Payments" value={erp.data.paymentCount} />
                  <Stat label="Certified" value={money(erp.data.totals.certified, erp.data.currency)} />
                  <Stat label="Outstanding" value={money(erp.data.totals.outstanding, erp.data.currency)} />
                </div>
                <p className="text-2xs text-content-subtle">
                  Columns ({erpFormat}): {erp.data.columns.invoices.join(", ")}
                </p>
                <a
                  className="inline-flex items-center rounded border border-border px-2 py-1 text-meta hover:bg-surface-raised"
                  href={`/api/v1/projects/${projectId}/invoicing/erp-export?format=${erpFormat}&output=csv${erp.data.currency ? `&currency=${erp.data.currency}` : ""}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Download CSV
                </a>
                {erp.data.reasons.length > 0 ? <Reasons reasons={erp.data.reasons} tone="neutral" title="Excluded" /> : null}
              </>
            )
          ) : (
            <PanelSkeleton rows={2} />
          )}
        </CardBody>
      </Card>

      {aging.data ? (
        <DescriptionList
          columns={2}
          size="sm"
          items={[
            { label: "As at", value: isoDate(aging.data.asOf) },
            {
              label: "Bucket definition",
              value: aging.data.bucketDefinition,
              span: "full",
            },
            {
              label: "Buckets",
              value: AGING_BUCKET_ORDER.map((b) => label(AGING_BUCKET_LABEL[b])).join(" · "),
              span: "full",
            },
          ]}
        />
      ) : null}
    </div>
  );
}
