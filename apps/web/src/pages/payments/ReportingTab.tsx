/**
 * SUPPLY-CHAIN PAYMENT PRACTICE REPORTING (spec Vol II F #391–393).
 *
 * The UK's Reporting on Payment Practices and Performance Regulations (and
 * the Australian Payment Times scheme it resembles) make a large payer
 * publish how quickly it actually paid. These figures are COMPUTED from the
 * invoice and payment registers, per currency, and a metric that cannot be
 * derived — "not paid within agreed terms" where no invoice carried a due
 * date — comes back as "not available" with the reason, never as 0%.
 *
 * The report is company-wide, so it lives beside the project register rather
 * than inside it, and publishing freezes it: a published report is a fact.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDate } from "../format";
import { fmtMoney } from "./paymentsShared";

interface Metrics {
  currency: string;
  invoicesPaid: number;
  invoicesOutstandingAtPeriodEnd: number;
  averageDaysToPay: number | null;
  medianDaysToPay: number | null;
  paidWithin30Pct: number | null;
  paid31To60Pct: number | null;
  paid61PlusPct: number | null;
  notPaidWithinTermsPct: number | null;
  termsUnknownCount: number;
  amountPaid: number;
  reasons: string[];
}

interface ReportRow {
  id: string;
  regime: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  metrics: { byCurrency: Metrics[]; sampleSize: number };
  generatedAt: string | null;
  publishedAt: string | null;
  notes: string | null;
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);
const monthsAgoIso = (n: number): string => {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
};

export default function ReportingTab() {
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [periodStart, setPeriodStart] = useState(monthsAgoIso(6));
  const [periodEnd, setPeriodEnd] = useState(todayIso());
  const [preview, setPreview] = useState<{
    metrics: Metrics[];
    sampleSize: number;
  } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ items: ReportRow[] }>("/api/v1/supply-chain-payment-reports");
      setRows(res.items);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "The reports could not be loaded.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runPreview() {
    setBusy(true);
    setError(null);
    try {
      setPreview(
        await api.get<{ metrics: Metrics[]; sampleSize: number }>(
          `/api/v1/supply-chain-payment-reports/preview?periodStart=${periodStart}&periodEnd=${periodEnd}`,
        ),
      );
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : "The preview could not be computed.");
    } finally {
      setBusy(false);
    }
  }

  async function publishDraft(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/v1/supply-chain-payment-reports/${id}/publish`, {});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The report could not be published.");
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/v1/supply-chain-payment-reports", {
        regime: "uk_ppr_2017",
        periodStart,
        periodEnd,
      });
      setPreview(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The report could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Alert tone="info" variant="subtle" size="sm" title="Computed, never typed">
        Days to pay run from the date each invoice was received to the date its first payment was
        issued. Figures are per currency and never summed across them; a metric with no basis is
        reported as unavailable with the reason.
      </Alert>

      <ErrorAlert message={error} />

      <Card>
        <CardHeader title="Reporting period" subtitle="Half-yearly under the UK regulations." />
        <CardBody className="grid items-end gap-3 sm:grid-cols-4">
          <Field label="Period start">
            <Input
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
            />
          </Field>
          <Field label="Period end">
            <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </Field>
          <Button variant="secondary" disabled={busy} onClick={() => void runPreview()}>
            Preview the figures
          </Button>
          <Button disabled={busy} onClick={() => void create()}>
            Create a draft report
          </Button>
        </CardBody>
      </Card>

      {preview ? (
        <Card>
          <CardHeader
            title="Preview"
            subtitle={`${preview.sampleSize} paid invoice(s) in the window. Nothing has been saved.`}
          />
          <CardBody>
            <MetricsTable metrics={preview.metrics} />
          </CardBody>
        </Card>
      ) : null}

      {rows === null ? (
        <Spinner label="Loading reports…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No payment practice reports yet"
          hint="Create a draft for a half-year window; the metrics come from the registers as they stand, and publishing freezes them."
        />
      ) : (
        rows.map((r) => (
          <Card key={r.id}>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <span>
                    {formatDate(r.periodStart)} — {formatDate(r.periodEnd)}
                  </span>
                  <Badge size="xs" tone={r.status === "published" ? "success" : "neutral"}>
                    {r.status}
                  </Badge>
                </span>
              }
              subtitle={
                r.publishedAt
                  ? `Published ${formatDate(r.publishedAt)} · ${r.metrics.sampleSize} invoices`
                  : `Generated ${formatDate(r.generatedAt)} · ${r.metrics.sampleSize} invoices`
              }
              actions={
                r.status === "draft" ? (
                  <Button size="xs" disabled={busy} onClick={() => void publishDraft(r.id)}>
                    Publish
                  </Button>
                ) : null
              }
            />
            <CardBody>
              <MetricsTable metrics={r.metrics.byCurrency} />
            </CardBody>
          </Card>
        ))
      )}
    </div>
  );
}

function pct(v: number | null): string {
  return v === null ? "—" : `${v}%`;
}

function MetricsTable({ metrics }: { metrics: Metrics[] }) {
  if (metrics.length === 0) {
    return (
      <p className="text-meta text-content-subtle">
        No invoices were paid in this window, so no figure can be stated.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <Table>
        <thead>
          <tr>
            <Th>Currency</Th>
            <Th className="text-right">Paid</Th>
            <Th className="text-right">Outstanding at period end</Th>
            <Th className="text-right">Avg days</Th>
            <Th className="text-right">Median</Th>
            <Th className="text-right">≤30d</Th>
            <Th className="text-right">31–60d</Th>
            <Th className="text-right">61d+</Th>
            <Th className="text-right">Not within terms</Th>
            <Th className="text-right">Amount</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {metrics.map((m) => (
            <tr key={m.currency}>
              <Td className="font-mono">{m.currency}</Td>
              <Td className="text-right tabular-nums">{m.invoicesPaid}</Td>
              <Td className="text-right tabular-nums">{m.invoicesOutstandingAtPeriodEnd}</Td>
              <Td className="text-right tabular-nums">{m.averageDaysToPay ?? "—"}</Td>
              <Td className="text-right tabular-nums">{m.medianDaysToPay ?? "—"}</Td>
              <Td className="text-right tabular-nums">{pct(m.paidWithin30Pct)}</Td>
              <Td className="text-right tabular-nums">{pct(m.paid31To60Pct)}</Td>
              <Td className="text-right tabular-nums">{pct(m.paid61PlusPct)}</Td>
              <Td className="text-right tabular-nums">
                {pct(m.notPaidWithinTermsPct)}
                {m.termsUnknownCount > 0 ? (
                  <span className="ml-1 text-2xs text-content-subtle">
                    ({m.termsUnknownCount} with no due date)
                  </span>
                ) : null}
              </Td>
              <Td className="text-right font-mono tabular-nums">
                {fmtMoney(m.amountPaid, m.currency)}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {metrics.some((m) => m.reasons.length > 0) ? (
        <Alert tone="warning" size="sm" variant="subtle" title="Figures that cannot be stated">
          <ul className="list-disc pl-4">
            {metrics.flatMap((m) => m.reasons.map((r) => <li key={`${m.currency}-${r}`}>{r}</li>))}
          </ul>
        </Alert>
      ) : null}
    </div>
  );
}
