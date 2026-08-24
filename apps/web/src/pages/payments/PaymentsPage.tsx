/**
 * Statutory payment security workspace — spec Vol II Domain F / M10
 * (#358-393 foundation subset): regime reference cards, payment claim
 * register with the deadline radar and deemed-liability surfacing,
 * days-to-pay analytics and the claim drawer's statutory timeline.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import {
  CountdownBadge,
  fmtMoney,
  paymentStatusTone,
  pcLabel,
  previewTimeline,
  regimeShort,
  type ContractLite,
  type DeadlineItem,
  type ListResponse,
  type PaymentClaimRow,
  type PaymentsAnalytics,
  type RegimeDef,
  type ValuationLite,
} from "./paymentsShared";
import PaymentClaimDrawer from "./PaymentClaimDrawer";

const PAGE_SIZE = 25;

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: "red" | "amber" | "green";
}) {
  const valueCls =
    tone === "red"
      ? "text-red-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "green"
          ? "text-emerald-700"
          : "text-ink-900";
  return (
    <Card>
      <CardBody className="px-4 py-3">
        <div className={`text-xl font-bold tabular-nums ${valueCls}`}>{value}</div>
        <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-ink-400">
          {label}
        </div>
      </CardBody>
    </Card>
  );
}

function radarChipClass(days: number): string {
  if (days < 0) return "bg-red-900 text-red-100";
  if (days <= 2) return "bg-red-100 text-red-800 ring-1 ring-red-200";
  if (days <= 7) return "bg-amber-100 text-amber-800 ring-1 ring-amber-200";
  return "bg-ink-100 text-ink-700 ring-1 ring-ink-200";
}

export default function PaymentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const base = `/api/v1/projects/${projectId}`;

  const [items, setItems] = useState<PaymentClaimRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [analytics, setAnalytics] = useState<PaymentsAnalytics | null>(null);
  const [deadlines, setDeadlines] = useState<DeadlineItem[]>([]);
  const [regimes, setRegimes] = useState<RegimeDef[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      const [list, stats, radar] = await Promise.all([
        api.get<ListResponse<PaymentClaimRow>>(`${base}/payment-claims?${params}`),
        api.get<PaymentsAnalytics>(`${base}/payments/analytics`),
        api.get<{ items: DeadlineItem[] }>(`${base}/payments/deadlines?days=14`),
      ]);
      setItems(list.items);
      setTotal(list.total);
      setAnalytics(stats);
      setDeadlines(radar.items ?? []);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load payment claims");
    }
  }, [base, projectId, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ items: RegimeDef[] }>("/api/v1/payment-regimes");
        if (!cancelled) setRegimes(res.items);
      } catch {
        // reference cards simply don't render
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ----------------------------- create modal ----------------------------- */

  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cRegime, setCRegime] = useState("uk_hgcra");
  const [cRefDate, setCRefDate] = useState("");
  const [cAmount, setCAmount] = useState("");
  const [cCurrency, setCCurrency] = useState("GBP");
  const [cDescription, setCDescription] = useState("");
  const [cContractId, setCContractId] = useState("");
  const [cValuationId, setCValuationId] = useState("");
  const [contracts, setContracts] = useState<ContractLite[]>([]);
  const [valuations, setValuations] = useState<ValuationLite[]>([]);

  async function openCreate() {
    setCreateError(null);
    setCRegime(regimes[0]?.regime ?? "uk_hgcra");
    setCRefDate("");
    setCAmount("");
    setCCurrency("GBP");
    setCDescription("");
    setCContractId("");
    setCValuationId("");
    setCreateOpen(true);
    try {
      const [con, val] = await Promise.all([
        api.get<ListResponse<ContractLite>>(`${base}/contracts?pageSize=100`),
        api.get<ListResponse<ValuationLite>>(`${base}/valuations?pageSize=100`),
      ]);
      setContracts(con.items);
      setValuations(val.items);
    } catch {
      // optional pickers
    }
  }

  function onValuationChange(id: string) {
    setCValuationId(id);
    if (id) {
      const v = valuations.find((x) => x.id === id);
      if (v) setCAmount(String(v.netDue));
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        regime: cRegime,
        referenceDate: cRefDate,
        claimedAmount: Number(cAmount) || 0,
      };
      const cur = cCurrency.trim().toUpperCase();
      if (cur) payload["currency"] = cur;
      if (cDescription.trim()) payload["description"] = cDescription.trim();
      if (cContractId) payload["contractId"] = cContractId;
      if (cValuationId) payload["valuationId"] = cValuationId;
      const created = await api.post<PaymentClaimRow>(`${base}/payment-claims`, payload);
      setCreateOpen(false);
      setPage(1);
      await load();
      setSelectedId(created.id);
    } catch (err) {
      setCreateError(
        err instanceof ApiClientError ? err.message : "Failed to create the payment claim.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- drawer --------------------------------- */

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const selectedRegimeDef = regimes.find((r) => r.regime === cRegime) ?? null;
  const preview =
    selectedRegimeDef && cRefDate ? previewTimeline(selectedRegimeDef, cRefDate) : null;

  if (!projectId) return null;

  return (
    <div>
      <PageHeader
        title="Payment Security"
        subtitle="Statutory payment claims, response deadlines, deemed liability and the right to suspend"
        actions={<Button onClick={() => void openCreate()}>New payment claim</Button>}
      />

      {/* Analytics */}
      {analytics ? (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <Stat label="Claims" value={analytics.claims} />
          <Stat label="Served" value={analytics.served} />
          <Stat label="Responded" value={analytics.responded} />
          <Stat
            label="Deemed"
            value={analytics.deemed}
            tone={analytics.deemed > 0 ? "red" : undefined}
          />
          <Stat label="Paid" value={analytics.paid} tone={analytics.paid > 0 ? "green" : undefined} />
          <Stat
            label="Avg days to pay"
            value={analytics.avgDaysToPay ?? "—"}
          />
          <Stat
            label="Deemed exposure"
            value={fmtMoney(analytics.deemedExposure)}
            tone={analytics.deemedExposure > 0 ? "red" : undefined}
          />
        </div>
      ) : null}

      {/* Deadline radar */}
      {deadlines.length > 0 ? (
        <Card className="mb-4 border-l-4 border-l-amber-500">
          <CardBody className="py-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
              Deadline radar — statutory response deadlines inside 14 days
            </div>
            <div className="flex flex-wrap gap-2">
              {deadlines.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setSelectedId(d.id)}
                  title={`${pcLabel(d.number)} — response due ${formatDate(d.responseDeadline)}`}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${radarChipClass(d.daysRemaining)}`}
                >
                  <span className="font-mono">{pcLabel(d.number)}</span>
                  <span>{fmtMoney(d.claimedAmount, d.currency)}</span>
                  <span className="font-semibold whitespace-nowrap">
                    {d.daysRemaining < 0
                      ? "OVERDUE"
                      : d.daysRemaining === 0
                        ? "due today"
                        : `${d.daysRemaining}d`}
                  </span>
                </button>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* Regime reference cards */}
      {regimes.length > 0 ? (
        <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {regimes.map((r) => (
            <Card key={r.regime}>
              <CardBody className="px-4 py-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-sm font-semibold text-ink-900">
                    {regimeShort(r.regime)}
                  </span>
                  <span className="text-xs text-ink-400">{r.jurisdiction}</span>
                </div>
                <div className="space-y-0.5 text-xs text-ink-600">
                  <div>
                    Respond:{" "}
                    <strong>
                      {r.responseDeadlineDays} {r.responseDayBasis === "business" ? "bus." : "cal."}{" "}
                      days
                    </strong>
                  </div>
                  <div>
                    Pay:{" "}
                    <strong>
                      {r.finalPaymentDays} {r.finalPaymentBasis === "business" ? "bus." : "cal."}{" "}
                      days
                    </strong>
                  </div>
                  <div>
                    Interest: <strong>{r.annualInterestPercent}% p.a.</strong>
                  </div>
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-brand-700 hover:text-brand-800">
                    Summary
                  </summary>
                  <p className="mt-1 text-xs font-medium leading-5 text-ink-700">{r.name}</p>
                  <p className="mt-1 text-xs leading-5 text-ink-500">{r.summary}</p>
                  <p className="mt-1 text-xs leading-5 text-ink-400">{r.deemedRule}</p>
                </details>
              </CardBody>
            </Card>
          ))}
        </div>
      ) : null}

      <ErrorAlert message={error} />

      {/* Register */}
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No payment claims yet"
          hint="Raise a payment claim under a statutory regime — the deadline engine computes the response and final payment clocks when it is served."
          action={<Button onClick={() => void openCreate()}>Create the first claim</Button>}
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>No.</Th>
                <Th>Regime</Th>
                <Th className="text-right">Claimed</Th>
                <Th>Served</Th>
                <Th>Response deadline</Th>
                <Th>Status</Th>
                <Th>Final payment</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {items.map((c) => (
                <tr
                  key={c.id}
                  className="cursor-pointer hover:bg-ink-50/60"
                  onClick={() => setSelectedId(c.id)}
                >
                  <Td className="whitespace-nowrap font-mono text-xs text-ink-500">
                    {pcLabel(c.number)}
                  </Td>
                  <Td>
                    <Badge tone="blue">{regimeShort(c.regime)}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-right font-medium tabular-nums">
                    {fmtMoney(c.claimedAmount, c.currency)}
                  </Td>
                  <Td className="whitespace-nowrap">{formatDate(c.servedAt)}</Td>
                  <Td className="whitespace-nowrap">
                    {c.responseDeadline ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="text-xs">{formatDate(c.responseDeadline)}</span>
                        {c.status === "served" ? (
                          <CountdownBadge days={c.daysToResponseDeadline} />
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-xs text-ink-300">on service</span>
                    )}
                  </Td>
                  <Td>
                    {c.status === "deemed" ? (
                      <span className="inline-flex items-center rounded-full bg-red-900 px-2 py-0.5 text-xs font-bold text-red-100">
                        DEEMED
                      </span>
                    ) : (
                      <Badge tone={paymentStatusTone(c.status)}>{humanize(c.status)}</Badge>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-xs">{formatDate(c.finalPaymentDate)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
            <span>
              {total} claim{total === 1 ? "" : "s"} · page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      {/* ------------------------------ create modal ------------------------------ */}
      <Modal open={createOpen} title="New payment claim" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Statutory regime">
              <Select value={cRegime} onChange={(e) => setCRegime(e.target.value)}>
                {regimes.map((r) => (
                  <option key={r.regime} value={r.regime}>
                    {regimeShort(r.regime)} — {r.jurisdiction}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reference date" hint="The statutory reference date the clocks run from.">
              <Input
                type="date"
                required
                value={cRefDate}
                onChange={(e) => setCRefDate(e.target.value)}
              />
            </Field>
          </div>

          {preview ? (
            <div className="rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-800 ring-1 ring-brand-100">
              Indicative timeline if served today: response due{" "}
              <strong>{formatDate(preview.responseDeadline)}</strong> · final payment{" "}
              <strong>{formatDate(preview.finalPaymentDate)}</strong>
              <span className="block text-xs text-brand-700/70">
                Authoritative dates are computed at the moment of service.
              </span>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Valuation" hint="Optional — prefills the claimed amount with its net due.">
              <Select value={cValuationId} onChange={(e) => onValuationChange(e.target.value)}>
                <option value="">None</option>
                {valuations.map((v) => (
                  <option key={v.id} value={v.id}>
                    VAL-{v.number} · {formatDate(v.valuationDate)} · net {v.netDue}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Claimed amount">
              <Input
                type="number"
                min="0"
                step="any"
                required
                value={cAmount}
                onChange={(e) => setCAmount(e.target.value)}
              />
            </Field>
            <Field label="Currency">
              <Input
                value={cCurrency}
                maxLength={3}
                onChange={(e) => setCCurrency(e.target.value)}
                placeholder="GBP"
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Contract">
              <Select value={cContractId} onChange={(e) => setCContractId(e.target.value)}>
                <option value="">None</option>
                {contracts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Description">
              <Textarea
                value={cDescription}
                onChange={(e) => setCDescription(e.target.value)}
                className="min-h-10"
                placeholder="Interim application no. 14 — works to end of July…"
              />
            </Field>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create claim"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* --------------------------------- drawer --------------------------------- */}
      {selectedId ? (
        <PaymentClaimDrawer
          projectId={projectId}
          claimId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => void load()}
        />
      ) : null}
    </div>
  );
}
