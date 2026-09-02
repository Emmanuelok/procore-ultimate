/**
 * Settlement tab: the offer register with privilege bases (#350-351) and the
 * expected-value scenario model (#352) — win probability × expected award
 * less irrecoverable costs, compared against the best open received offer.
 */
import { useEffect, useState, type FormEvent } from "react";
import { SETTLEMENT_OFFER_BASES } from "@constructos/shared";
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
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import {
  BASIS_LONG,
  basisShort,
  basisTone,
  daysUntilIso,
  fmtMoney,
  isTerminal,
  offerStatusTone,
  SectionTitle,
  todayIso,
  WarnBanner,
  type DisputeDetail,
  type OfferRow,
  type SettlementAnalysisResult,
} from "./disputesShared";

const BRAND = "#1d60f1";
const GRID = "#ebedf1";
const AXIS_INK = "#7f8ea4";
const RED = "#dc2626";
const INK = "#4b5a72";

/* ------------------------- EV vs offer comparison bars ------------------------ */

function EvComparison({
  ev,
  offer,
  currency,
}: {
  ev: number;
  offer: number | null;
  currency: string;
}) {
  const W = 560;
  const rowH = 30;
  const labelW = 150;
  const valueW = 110;
  const plotW = W - labelW - valueW - 12;
  const rows = [
    { label: "EV of proceeding", value: ev, color: ev < 0 ? RED : BRAND },
    ...(offer !== null ? [{ label: "Best open offer", value: offer, color: INK }] : []),
  ];
  const H = rows.length * rowH + 8;
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      role="img"
      aria-label="Expected value of proceeding compared with the best open offer"
    >
      {/* zero baseline */}
      <line x1={labelW} y1={4} x2={labelW} y2={H - 4} stroke={GRID} strokeWidth={1} />
      {rows.map((r, i) => {
        const y = i * rowH + 6;
        const w = (Math.abs(r.value) / maxAbs) * plotW;
        return (
          <g key={r.label}>
            <title>{`${r.label}: ${fmtMoney(r.value, currency)}`}</title>
            <text
              x={labelW - 8}
              y={y + 14}
              textAnchor="end"
              fontSize={12}
              fill={AXIS_INK}
            >
              {r.label}
            </text>
            <rect x={labelW} y={y} width={Math.max(2, w)} height={18} rx={3} fill={r.color} />
            <text
              x={labelW + Math.max(2, w) + 8}
              y={y + 14}
              fontSize={12}
              fontWeight={600}
              fill={r.value < 0 ? RED : "#0f1c30"}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {fmtMoney(r.value, currency)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ---------------------------------- The tab ---------------------------------- */

export default function SettlementTab({
  projectId,
  dispute,
  onChanged,
}: {
  projectId: string;
  dispute: DisputeDetail;
  onChanged: () => Promise<void>;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = !isTerminal(dispute.status);

  /* ------------------------------- record modal ------------------------------- */

  const [recordOpen, setRecordOpen] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [oDirection, setODirection] = useState("received");
  const [oBasis, setOBasis] = useState("without_prejudice");
  const [oAmount, setOAmount] = useState("");
  const [oCurrency, setOCurrency] = useState(dispute.currency);
  const [oOfferedAt, setOOfferedAt] = useState(todayIso());
  const [oExpiresAt, setOExpiresAt] = useState("");
  const [oTerms, setOTerms] = useState("");

  function openRecord() {
    setRecordError(null);
    setODirection("received");
    setOBasis("without_prejudice");
    setOAmount("");
    setOCurrency(dispute.currency);
    setOOfferedAt(todayIso());
    setOExpiresAt("");
    setOTerms("");
    setRecordOpen(true);
  }

  async function onRecord(e: FormEvent) {
    e.preventDefault();
    setRecordError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        direction: oDirection,
        basis: oBasis,
        amount: Number(oAmount) || 0,
        offeredAt: oOfferedAt,
      };
      const cur = oCurrency.trim().toUpperCase();
      if (cur) payload["currency"] = cur;
      if (oExpiresAt) payload["expiresAt"] = oExpiresAt;
      if (oTerms.trim()) payload["terms"] = oTerms.trim();
      await api.post(`${base}/disputes/${dispute.id}/offers`, payload);
      setRecordOpen(false);
      await onChanged();
    } catch (err) {
      setRecordError(err instanceof ApiClientError ? err.message : "Failed to record the offer.");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------ status actions ------------------------------ */

  const [acceptTarget, setAcceptTarget] = useState<OfferRow | null>(null);

  async function setOfferStatus(offerId: string, status: string) {
    setError(null);
    setBusy(true);
    try {
      await api.post(`${base}/settlement-offers/${offerId}/status`, { status });
      setAcceptTarget(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Offer status change failed.");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------- analysis card ------------------------------- */

  const [winPct, setWinPct] = useState(50);
  const [awardInput, setAwardInput] = useState("");
  const [costsInput, setCostsInput] = useState("");
  const [analysis, setAnalysis] = useState<SettlementAnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const params = new URLSearchParams({
            winProbability: String(winPct / 100),
            legalCosts: String(Number(costsInput) || 0),
          });
          if (awardInput.trim() !== "") {
            params.set("expectedAward", String(Number(awardInput) || 0));
          }
          const res = await api.get<SettlementAnalysisResult>(
            `${base}/disputes/${dispute.id}/settlement-analysis?${params}`,
          );
          if (!cancelled) {
            setAnalysis(res);
            setAnalysisError(null);
          }
        } catch (err) {
          if (!cancelled) {
            setAnalysisError(
              err instanceof Error ? err.message : "Settlement analysis failed to load",
            );
          }
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // re-run when the offer set changes too — the best open offer may move
  }, [base, dispute.id, winPct, awardInput, costsInput, dispute.offers]);

  /* ---------------------------------- render ---------------------------------- */

  return (
    <div>
      <ErrorAlert message={error} />

      <div className="mb-3 flex items-center justify-between">
        <SectionTitle>Offer register ({dispute.offers.length})</SectionTitle>
        {active ? (
          <Button size="sm" onClick={openRecord}>
            Record offer…
          </Button>
        ) : null}
      </div>

      {dispute.offers.length === 0 ? (
        <p className="mb-4 text-xs text-ink-400">
          No offers on record. Calderbank and Part 36-style offers carry costs consequences — keep
          every offer, made or received, on the register with its privilege basis.
        </p>
      ) : (
        <div className="mb-4">
          <Table>
            <thead>
              <tr>
                <Th>Direction</Th>
                <Th>Basis</Th>
                <Th className="text-right">Amount</Th>
                <Th>Offered</Th>
                <Th>Expires</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {dispute.offers.map((o) => {
                const expiryDays =
                  o.status === "open" && o.expiresAt ? daysUntilIso(o.expiresAt) : null;
                return (
                  <tr key={o.id}>
                    <Td className="whitespace-nowrap">
                      <span
                        className={`inline-flex items-center gap-1 text-sm font-medium ${
                          o.direction === "made" ? "text-brand-700" : "text-violet-700"
                        }`}
                      >
                        <span aria-hidden>{o.direction === "made" ? "↗" : "↘"}</span>
                        {humanize(o.direction)}
                      </span>
                    </Td>
                    <Td>
                      <span title={BASIS_LONG[o.basis] ?? o.basis}>
                        <Badge tone={basisTone(o.basis)}>{basisShort(o.basis)}</Badge>
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap text-right font-medium tabular-nums">
                      {fmtMoney(o.amount, o.currency)}
                    </Td>
                    <Td className="whitespace-nowrap text-xs">{formatDate(o.offeredAt)}</Td>
                    <Td className="whitespace-nowrap text-xs">
                      {o.expiresAt ? (
                        <span
                          className={
                            expiryDays !== null && expiryDays < 0
                              ? "font-medium text-amber-700"
                              : ""
                          }
                        >
                          {formatDate(o.expiresAt)}
                          {expiryDays !== null && expiryDays < 0 ? " (expired)" : ""}
                        </span>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td>
                      <Badge tone={offerStatusTone(o.status)}>{humanize(o.status)}</Badge>
                    </Td>
                    <Td>
                      {o.status === "open" && active ? (
                        <span className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => setAcceptTarget(o)}
                          >
                            Accept
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => void setOfferStatus(o.id, "rejected")}
                          >
                            Reject
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void setOfferStatus(o.id, "lapsed")}
                          >
                            Lapse
                          </Button>
                        </span>
                      ) : null}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <OpenOffersFootnote offers={dispute.offers} />
        </div>
      )}

      {/* --------------------------- analysis card (#352) --------------------------- */}
      <Card>
        <CardBody>
          <div className="mb-3 text-sm font-semibold text-ink-900">
            Settlement scenario model
          </div>
          <ErrorAlert message={analysisError} />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label={`Win probability — ${winPct}%`}>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={winPct}
                onChange={(e) => setWinPct(Number(e.target.value))}
                className="mt-2 w-full accent-brand-600"
                aria-label="Win probability percent"
              />
            </Field>
            <Field
              label="Expected award"
              hint={
                dispute.amountInDispute !== null
                  ? `Blank uses the amount in dispute (${fmtMoney(dispute.amountInDispute, dispute.currency)}).`
                  : "The award expected if the claim succeeds."
              }
            >
              <Input
                type="number"
                min="0"
                step="any"
                value={awardInput}
                onChange={(e) => setAwardInput(e.target.value)}
                placeholder={
                  dispute.amountInDispute !== null ? String(dispute.amountInDispute) : "0"
                }
              />
            </Field>
            <Field label="Irrecoverable legal costs">
              <Input
                type="number"
                min="0"
                step="any"
                value={costsInput}
                onChange={(e) => setCostsInput(e.target.value)}
                placeholder="0"
              />
            </Field>
          </div>

          {analysis ? (
            <div className="mt-4">
              <div className="mb-3 grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                    EV of proceeding
                  </div>
                  <div
                    className={`text-xl font-bold tabular-nums ${
                      analysis.expectedValueOfProceeding < 0 ? "text-red-700" : "text-ink-900"
                    }`}
                  >
                    {fmtMoney(analysis.expectedValueOfProceeding, analysis.currency)}
                  </div>
                  <div className="text-xs text-ink-400 tabular-nums">
                    {Math.round(analysis.winProbability * 100)}% ×{" "}
                    {fmtMoney(analysis.expectedAward, analysis.currency)} −{" "}
                    {fmtMoney(analysis.legalCosts, analysis.currency)}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                    Best open offer
                  </div>
                  <div className="text-xl font-bold tabular-nums text-ink-900">
                    {analysis.bestOpenOffer
                      ? fmtMoney(analysis.bestOpenOffer.amount, analysis.bestOpenOffer.currency)
                      : "—"}
                  </div>
                  <div className="text-xs text-ink-400">
                    {analysis.bestOpenOffer
                      ? `${basisShort(analysis.bestOpenOffer.basis)} · received ${formatDate(analysis.bestOpenOffer.offeredAt)}`
                      : "no open received offer on the table"}
                  </div>
                </div>
              </div>

              <EvComparison
                ev={analysis.expectedValueOfProceeding}
                offer={analysis.bestOpenOffer?.amount ?? null}
                currency={analysis.currency}
              />

              <div
                className={`mt-3 rounded-md px-3 py-2 text-sm ring-1 ${
                  analysis.recommendation === "settle"
                    ? "bg-emerald-50 text-emerald-900 ring-emerald-200"
                    : "bg-brand-50 text-brand-900 ring-brand-100"
                }`}
              >
                <strong>
                  Recommendation: {analysis.recommendation === "settle" ? "settle" : "proceed"}.
                </strong>{" "}
                {analysis.rationale}
              </div>
              <p className="mt-2 text-xs text-ink-400">
                A deliberately simple model — single win probability, no costs-shifting or
                discounting. Treat it as a framing aid, not legal advice.
              </p>
            </div>
          ) : analysisError === null ? (
            <p className="mt-4 text-xs text-ink-400">Computing…</p>
          ) : null}
        </CardBody>
      </Card>

      {/* ------------------------------- record modal ------------------------------- */}
      <Modal open={recordOpen} title="Record a settlement offer" onClose={() => setRecordOpen(false)} wide>
        <ErrorAlert message={recordError} />
        <form onSubmit={onRecord} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Direction">
              <Select value={oDirection} onChange={(e) => setODirection(e.target.value)}>
                <option value="received">Received — from the counterparty</option>
                <option value="made">Made — by us</option>
              </Select>
            </Field>
            <Field label="Privilege basis">
              <Select value={oBasis} onChange={(e) => setOBasis(e.target.value)}>
                {SETTLEMENT_OFFER_BASES.map((b) => (
                  <option key={b} value={b}>
                    {BASIS_LONG[b] ?? b}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <Field label="Amount">
              <Input
                type="number"
                min="0"
                step="any"
                required
                value={oAmount}
                onChange={(e) => setOAmount(e.target.value)}
              />
            </Field>
            <Field label="Currency">
              <Input
                value={oCurrency}
                maxLength={3}
                onChange={(e) => setOCurrency(e.target.value)}
              />
            </Field>
            <Field label="Offered on">
              <Input
                type="date"
                required
                value={oOfferedAt}
                onChange={(e) => setOOfferedAt(e.target.value)}
              />
            </Field>
            <Field label="Expires">
              <Input
                type="date"
                value={oExpiresAt}
                onChange={(e) => setOExpiresAt(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Terms">
            <Textarea
              value={oTerms}
              onChange={(e) => setOTerms(e.target.value)}
              className="min-h-10"
              placeholder="All-in, inclusive of interest and costs, open for 21 days…"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRecordOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Recording…" : "Record offer"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ------------------------------- accept modal ------------------------------- */}
      <Modal
        open={acceptTarget !== null}
        title="Accept the offer"
        onClose={() => setAcceptTarget(null)}
      >
        {acceptTarget ? (
          <>
            <WarnBanner
              message={`Accepting settles the dispute at ${fmtMoney(acceptTarget.amount, acceptTarget.currency)} — the dispute file closes as settled and can no longer be edited.`}
            />
            <p className="mb-4 text-sm text-ink-700">
              {humanize(acceptTarget.direction)} offer, {BASIS_LONG[acceptTarget.basis] ?? acceptTarget.basis},
              offered {formatDate(acceptTarget.offeredAt)}.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setAcceptTarget(null)}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={() => void setOfferStatus(acceptTarget.id, "accepted")}
              >
                {busy ? "Accepting…" : "Accept and settle"}
              </Button>
            </div>
          </>
        ) : null}
      </Modal>
    </div>
  );
}

/** Footnote under the offer table. */
function OpenOffersFootnote({ offers }: { offers: OfferRow[] }) {
  const open = offers.filter((x) => x.status === "open").length;
  if (open === 0) return null;
  return (
    <p className="mt-1 text-xs text-ink-400">
      {open} open offer{open === 1 ? "" : "s"} — accepting one settles the dispute.
    </p>
  );
}
