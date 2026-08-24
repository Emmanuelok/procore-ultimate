/**
 * Payment claim drawer: the statutory timeline visual, state-driven actions
 * (serve / respond / suspend / lift / mark paid), the responses list with
 * late badges, suspension notice status and the late-payment interest card
 * (spec Domain F #358-362, #387).
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { PAYMENT_RESPONSE_KINDS } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
} from "../../ui";
import { formatDate, formatDateTime, humanize } from "../format";
import {
  addDaysIso,
  CountdownBadge,
  fmtMoney,
  paymentStatusTone,
  pcLabel,
  regimeShort,
  SERVICE_METHODS,
  todayIso,
  type InterestResult,
  type PaymentClaimDetail,
} from "./paymentsShared";

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">
      {children}
    </div>
  );
}

function WarnBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
      {message}
    </div>
  );
}

/* ------------------------- Statutory timeline visual ------------------------- */

function pctBetween(startIso: string, endIso: string, pointIso: string): number {
  const start = Date.parse(`${startIso}T00:00:00Z`);
  const end = Date.parse(`${endIso}T00:00:00Z`);
  const point = Date.parse(`${pointIso}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 50;
  return Math.min(100, Math.max(0, ((point - start) / (end - start)) * 100));
}

function StatutoryTimeline({ claim }: { claim: PaymentClaimDetail }) {
  if (!claim.servedAt || !claim.responseDeadline || !claim.finalPaymentDate) {
    return (
      <p className="text-xs text-ink-400">
        The statutory clocks start when the claim is served — serve it to compute the response
        deadline and final date for payment.
      </p>
    );
  }
  const served = claim.servedAt.slice(0, 10);
  const today = todayIso();
  const responsePct = pctBetween(served, claim.finalPaymentDate, claim.responseDeadline);
  const todayPct = pctBetween(served, claim.finalPaymentDate, today);
  const showToday = today >= served;

  const steps = [
    { label: "Served", date: served, pct: 0, done: true },
    {
      label: "Response deadline",
      date: claim.responseDeadline,
      pct: responsePct,
      done: today > claim.responseDeadline || claim.status === "responded",
    },
    {
      label: "Final payment",
      date: claim.finalPaymentDate,
      pct: 100,
      done: claim.status === "paid",
    },
  ];

  return (
    <div className="px-2 pb-8 pt-2">
      <div className="relative h-1.5 rounded-full bg-ink-100">
        {/* elapsed portion */}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-brand-500/70"
          style={{ width: `${todayPct}%` }}
        />
        {/* today marker */}
        {showToday ? (
          <div
            className="absolute -top-2.5 flex -translate-x-1/2 flex-col items-center"
            style={{ left: `${todayPct}%` }}
            title={`Today — ${formatDate(today)}`}
          >
            <div className="h-6 w-0.5 bg-ink-700" />
            <span className="mt-0.5 whitespace-nowrap text-[10px] font-semibold uppercase text-ink-700">
              today
            </span>
          </div>
        ) : null}
        {steps.map((s) => (
          <div
            key={s.label}
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${Math.min(99, Math.max(1, s.pct))}%` }}
          >
            <div
              className={`h-3.5 w-3.5 rounded-full border-2 border-white shadow ${
                s.done ? "bg-brand-600" : "bg-ink-300"
              }`}
            />
            <div
              className={`absolute top-4 w-28 text-center text-[10px] leading-tight ${
                s.pct === 0 ? "left-0 text-left" : s.pct === 100 ? "right-0 -left-24 text-right" : "-left-12"
              }`}
            >
              <div className="font-semibold text-ink-700">{s.label}</div>
              <div className="text-ink-400">{formatDate(s.date)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------- Drawer ---------------------------------- */

export default function PaymentClaimDrawer({
  projectId,
  claimId,
  onClose,
  onChanged,
}: {
  projectId: string;
  claimId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;

  const [claim, setClaim] = useState<PaymentClaimDetail | null>(null);
  const [interest, setInterest] = useState<InterestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const detail = await api.get<PaymentClaimDetail>(`${base}/payment-claims/${claimId}`);
      setClaim(detail);
      if (detail.servedAt && detail.finalPaymentDate) {
        try {
          setInterest(
            await api.get<InterestResult>(`${base}/payment-claims/${claimId}/interest`),
          );
        } catch {
          setInterest(null);
        }
      } else {
        setInterest(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the payment claim");
    }
  }, [base, claimId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    await load();
    onChanged();
  }

  /* --------------------------------- serve --------------------------------- */

  const [serveOpen, setServeOpen] = useState(false);
  const [serveMethod, setServeMethod] = useState("email");
  const [serveRef, setServeRef] = useState("");
  const [serveError, setServeError] = useState<string | null>(null);

  async function onServe(e: FormEvent) {
    e.preventDefault();
    setServeError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { method: serveMethod };
      if (serveRef.trim()) payload["reference"] = serveRef.trim();
      await api.post(`${base}/payment-claims/${claimId}/serve`, payload);
      setServeOpen(false);
      await refresh();
    } catch (err) {
      setServeError(err instanceof ApiClientError ? err.message : "Service failed.");
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------- respond -------------------------------- */

  const [respondOpen, setRespondOpen] = useState(false);
  const [respKind, setRespKind] = useState("payment_notice");
  const [respAmount, setRespAmount] = useState("");
  const [respReasons, setRespReasons] = useState("");
  const [respError, setRespError] = useState<string | null>(null);

  function openRespond() {
    if (!claim) return;
    setRespKind("payment_notice");
    setRespAmount(String(claim.claimedAmount));
    setRespReasons("");
    setRespError(null);
    setRespondOpen(true);
  }

  async function onRespond(e: FormEvent) {
    e.preventDefault();
    setRespError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        kind: respKind,
        amount: Number(respAmount) || 0,
      };
      if (respReasons.trim()) payload["reasons"] = respReasons.trim();
      await api.post(`${base}/payment-claims/${claimId}/respond`, payload);
      setRespondOpen(false);
      await refresh();
    } catch (err) {
      setRespError(err instanceof ApiClientError ? err.message : "Response failed.");
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------- suspend -------------------------------- */

  const [suspendOpen, setSuspendOpen] = useState(false);
  const [suspendError, setSuspendError] = useState<string | null>(null);

  async function onSuspend() {
    setSuspendError(null);
    setBusy(true);
    try {
      await api.post(`${base}/payment-claims/${claimId}/suspend`);
      setSuspendOpen(false);
      await refresh();
    } catch (err) {
      setSuspendError(err instanceof ApiClientError ? err.message : "Suspension failed.");
    } finally {
      setBusy(false);
    }
  }

  async function liftNotice(noticeId: string) {
    setError(null);
    setBusy(true);
    try {
      await api.post(`${base}/suspension-notices/${noticeId}/lift`);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to lift the suspension.");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------- mark paid ------------------------------- */

  const [paidOpen, setPaidOpen] = useState(false);
  const [paidAmount, setPaidAmount] = useState("");
  const [paidError, setPaidError] = useState<string | null>(null);

  function openPaid() {
    if (!claim) return;
    const onTime = [...claim.responses].reverse().find((r) => r.late === 0);
    setPaidAmount(String(onTime ? onTime.amount : claim.claimedAmount));
    setPaidError(null);
    setPaidOpen(true);
  }

  async function onPaid(e: FormEvent) {
    e.preventDefault();
    setPaidError(null);
    setBusy(true);
    try {
      await api.post(`${base}/payment-claims/${claimId}/mark-paid`, {
        paidAmount: Number(paidAmount) || 0,
      });
      setPaidOpen(false);
      await refresh();
    } catch (err) {
      setPaidError(err instanceof ApiClientError ? err.message : "Failed to record payment.");
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- render --------------------------------- */

  const respondLate =
    claim !== null &&
    (claim.status === "deemed" ||
      (claim.daysToResponseDeadline !== null &&
        claim.daysToResponseDeadline !== undefined &&
        claim.daysToResponseDeadline < 0));

  const respShort =
    claim !== null && respAmount.trim() !== "" && Number(respAmount) < claim.claimedAmount;

  const activeNotice = claim?.suspensionNotices.find((n) => !n.liftedAt) ?? null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink-950/40" onClick={onClose}>
      <div
        className="h-full w-full max-w-2xl overflow-y-auto bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {claim === null ? (
          <Spinner />
        ) : (
          <>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <span className="font-mono text-xs text-ink-400">{pcLabel(claim.number)}</span>
                  <Badge tone="blue">{regimeShort(claim.regime)}</Badge>
                  {claim.status === "deemed" ? (
                    <span className="inline-flex items-center rounded-full bg-red-900 px-2 py-0.5 text-xs font-bold text-red-100">
                      DEEMED
                    </span>
                  ) : (
                    <Badge tone={paymentStatusTone(claim.status)}>{humanize(claim.status)}</Badge>
                  )}
                </div>
                <h2 className="text-base font-semibold text-ink-900">
                  {fmtMoney(claim.claimedAmount, claim.currency)}
                  <span className="ml-2 text-sm font-normal text-ink-400">
                    claimed · ref date {formatDate(claim.referenceDate)}
                  </span>
                </h2>
                {claim.description ? (
                  <p className="mt-0.5 text-sm text-ink-500">{claim.description}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <ErrorAlert message={error} />

            {/* Statutory timeline */}
            <Card className="mb-4">
              <CardBody>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-semibold text-ink-900">Statutory timeline</div>
                  {claim.status === "served" ? (
                    <CountdownBadge days={claim.daysToResponseDeadline} />
                  ) : null}
                </div>
                <StatutoryTimeline claim={claim} />
                {claim.regimeDef ? (
                  <p className="mt-1 text-xs text-ink-400">
                    {claim.regimeDef.name} — respond within {claim.regimeDef.responseDeadlineDays}{" "}
                    {claim.regimeDef.responseDayBasis} days; pay within{" "}
                    {claim.regimeDef.finalPaymentDays} {claim.regimeDef.finalPaymentBasis} days.
                  </p>
                ) : null}
                {claim.servedAt ? (
                  <p className="mt-1 text-xs text-ink-400">
                    Served {formatDateTime(claim.servedAt)} via{" "}
                    {humanize(claim.serviceMethod ?? "")}
                    {claim.serviceReference ? ` (${claim.serviceReference})` : ""}
                  </p>
                ) : null}
                {claim.status === "paid" ? (
                  <p className="mt-1 text-xs font-medium text-emerald-700">
                    Paid {fmtMoney(claim.paidAmount, claim.currency)} on{" "}
                    {formatDate(claim.paidAt)}
                  </p>
                ) : null}
              </CardBody>
            </Card>

            {/* Deemed banner */}
            {claim.status === "deemed" && claim.regimeDef ? (
              <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
                <strong>Deemed liability.</strong> {claim.regimeDef.deemedRule}
              </div>
            ) : null}

            {/* Actions */}
            <div className="mb-4 flex flex-wrap gap-2">
              {claim.status === "draft" ? (
                <Button onClick={() => setServeOpen(true)}>Serve claim…</Button>
              ) : null}
              {claim.status === "served" || claim.status === "deemed" ? (
                <Button variant="secondary" onClick={openRespond}>
                  Respond…
                </Button>
              ) : null}
              {claim.status === "deemed" ? (
                <Button variant="danger" onClick={() => setSuspendOpen(true)}>
                  Serve suspension notice…
                </Button>
              ) : null}
              {["served", "responded", "deemed", "suspended"].includes(claim.status) ? (
                <Button variant="secondary" onClick={openPaid}>
                  Mark paid…
                </Button>
              ) : null}
            </div>

            {/* Interest card */}
            {interest && interest.daysLate > 0 ? (
              <Card className="mb-4 border-l-4 border-l-red-500">
                <CardBody className="py-3">
                  <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
                    <div>
                      <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                        Days late
                      </div>
                      <div className="text-lg font-bold text-red-700">{interest.daysLate}</div>
                    </div>
                    <div>
                      <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                        Rate
                      </div>
                      <div className="text-lg font-bold text-ink-900">
                        {interest.annualRate}% p.a.
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                        Statutory interest
                      </div>
                      <div className="text-lg font-bold text-red-700">
                        {fmtMoney(interest.interest, interest.currency)}
                      </div>
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-ink-500">{interest.basis}</p>
                </CardBody>
              </Card>
            ) : interest ? (
              <p className="mb-4 text-xs text-ink-400">{interest.basis}</p>
            ) : null}

            {/* Responses */}
            <div className="mb-4">
              <SectionTitle>Payment responses ({claim.responses.length})</SectionTitle>
              {claim.responses.length === 0 ? (
                <p className="text-xs text-ink-400">
                  No payment notice or pay-less notice on file.
                </p>
              ) : (
                <ul className="divide-y divide-ink-100 rounded-md border border-ink-100">
                  {claim.responses.map((r) => (
                    <li key={r.id} className="px-3 py-2">
                      <div className="flex items-center gap-2 text-sm">
                        <Badge tone={r.kind === "pay_less_notice" ? "amber" : "blue"}>
                          {humanize(r.kind)}
                        </Badge>
                        <span className="font-semibold text-ink-900">
                          {fmtMoney(r.amount, claim.currency)}
                        </span>
                        {r.late === 1 ? (
                          <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-800">
                            LATE
                          </span>
                        ) : null}
                        <span className="ml-auto text-xs text-ink-400">
                          {formatDateTime(r.servedAt)}
                        </span>
                      </div>
                      {r.reasons ? (
                        <p className="mt-1 whitespace-pre-wrap text-xs text-ink-500">
                          {r.reasons}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Suspension notices */}
            {claim.suspensionNotices.length > 0 ? (
              <div className="mb-4">
                <SectionTitle>Suspension notices</SectionTitle>
                <ul className="divide-y divide-ink-100 rounded-md border border-ink-100">
                  {claim.suspensionNotices.map((n) => (
                    <li key={n.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                      {n.liftedAt ? (
                        <Badge tone="gray">Lifted</Badge>
                      ) : (
                        <Badge tone="amber">Active</Badge>
                      )}
                      <span className="text-ink-700">
                        Served {formatDate(n.servedAt)} · effective from{" "}
                        {formatDate(n.effectiveFrom)}
                        {n.liftedAt ? ` · lifted ${formatDate(n.liftedAt)}` : ""}
                      </span>
                      {!n.liftedAt ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="ml-auto"
                          disabled={busy}
                          onClick={() => void liftNotice(n.id)}
                        >
                          Lift suspension
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {activeNotice ? (
              <WarnBanner
                message={`Work may be suspended from ${formatDate(activeNotice.effectiveFrom)}. Lifting the notice returns the claim to its deemed state — the underlying liability is unaffected.`}
              />
            ) : null}
          </>
        )}

        {/* ------------------------------- serve modal ------------------------------- */}
        <Modal open={serveOpen} title="Serve payment claim" onClose={() => setServeOpen(false)}>
          <p className="mb-3 text-sm text-ink-500">
            Service starts the statutory clocks: the response deadline and the final date for
            payment are computed from the regime the moment the claim is served, and a served
            claim becomes immutable.
          </p>
          <ErrorAlert message={serveError} />
          <form onSubmit={onServe} className="space-y-4">
            <Field label="Method of service">
              <Select value={serveMethod} onChange={(e) => setServeMethod(e.target.value)}>
                {SERVICE_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {humanize(m)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Service reference" hint="Tracking no., email subject, portal id…">
              <Input value={serveRef} onChange={(e) => setServeRef(e.target.value)} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setServeOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Serving…" : "Serve claim"}
              </Button>
            </div>
          </form>
        </Modal>

        {/* ------------------------------ respond modal ------------------------------ */}
        <Modal open={respondOpen} title="Serve payment response" onClose={() => setRespondOpen(false)}>
          {respondLate ? (
            <WarnBanner message="The statutory response deadline has passed. A late response is statutorily ineffective under most regimes — the claimed amount may remain payable in full." />
          ) : null}
          <ErrorAlert message={respError} />
          <form onSubmit={onRespond} className="space-y-4">
            <Field label="Kind">
              <Select value={respKind} onChange={(e) => setRespKind(e.target.value)}>
                {PAYMENT_RESPONSE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Amount">
              <Input
                type="number"
                min="0"
                step="any"
                required
                value={respAmount}
                onChange={(e) => setRespAmount(e.target.value)}
              />
            </Field>
            <Field
              label="Reasons / grounds"
              hint={
                respShort
                  ? "Required — paying less than the claimed amount without stating grounds is exactly what the statute voids."
                  : "Optional valuation basis for the amount."
              }
            >
              <Textarea
                value={respReasons}
                onChange={(e) => setRespReasons(e.target.value)}
                className="min-h-20"
                placeholder="Grounds for withholding, valuation basis…"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setRespondOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Serving…" : "Serve response"}
              </Button>
            </div>
          </form>
        </Modal>

        {/* ------------------------------ suspend modal ------------------------------ */}
        <Modal
          open={suspendOpen}
          title="Serve right-to-suspend notice"
          onClose={() => setSuspendOpen(false)}
        >
          <ErrorAlert message={suspendError} />
          {claim?.regimeDef ? (
            <p className="mb-3 text-sm text-ink-700">
              Under {claim.regimeDef.name}, suspension requires{" "}
              <strong>{claim.regimeDef.suspensionNoticeDays} days&rsquo; written notice</strong>.
              Serving now means suspension may take effect from{" "}
              <strong>
                {formatDate(addDaysIso(todayIso(), claim.regimeDef.suspensionNoticeDays))}
              </strong>{" "}
              (indicative — the effective date is computed on service).
            </p>
          ) : null}
          <p className="mb-4 text-xs text-ink-500">
            Suspension does not extinguish the deemed liability — the claimed amount remains due.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSuspendOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void onSuspend()}>
              {busy ? "Serving…" : "Serve notice"}
            </Button>
          </div>
        </Modal>

        {/* ------------------------------- paid modal ------------------------------- */}
        <Modal open={paidOpen} title="Mark claim paid" onClose={() => setPaidOpen(false)}>
          <ErrorAlert message={paidError} />
          <form onSubmit={onPaid} className="space-y-4">
            <Field
              label="Amount paid"
              hint="Prefilled with the latest on-time response amount, else the claimed amount."
            >
              <Input
                type="number"
                min="0"
                step="any"
                required
                value={paidAmount}
                onChange={(e) => setPaidAmount(e.target.value)}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setPaidOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Recording…" : "Record payment"}
              </Button>
            </div>
          </form>
        </Modal>
      </div>
    </div>
  );
}
