/**
 * Contingency release authority and the planned drawdown curve
 * (spec Vol II Domain H #451, #471-472).
 *
 * A drawdown is money leaving the risk pot, so above a threshold it goes
 * through request → approval by somebody else, exactly like a payment. And
 * a drawdown curve with nothing to compare against cannot answer the only
 * question worth asking of it — whether the burn is running ahead of plan —
 * so the planned series lives here too.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDate, formatDateTime, formatMoney, humanize } from "../format";
import type { ContingencyRow } from "./riskShared";

interface Release {
  id: string;
  contingencyId: string;
  amount: number;
  reason: string;
  riskId: string | null;
  drawnAt: string;
  status: string;
  requiresAdmin: number;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  drawdownId: string | null;
  createdAt: string;
}

interface PlanPoint {
  date: string;
  plannedRemaining: number;
}

interface Drift {
  plannedRemaining: number | null;
  actualRemaining: number;
  variance: number | null;
  variancePercent: number | null;
  aheadOfPlan: boolean;
  breached: boolean;
  tolerancePercent: number;
  basis: string;
}

export interface CurveWithPlan {
  contingencyId: string;
  name: string;
  currency: string;
  amount: number;
  points: Array<{ date: string; drawn: number; remaining: number; reason: string }>;
  plan: PlanPoint[];
  planSource: string | null;
  drift: Drift;
}

function statusTone(status: string): "green" | "amber" | "red" | "gray" {
  switch (status) {
    case "approved":
      return "green";
    case "requested":
      return "amber";
    case "rejected":
      return "red";
    default:
      return "gray";
  }
}

export default function ContingencyGovernance({
  base,
  contingency,
  onChanged,
}: {
  base: string;
  contingency: ContingencyRow;
  onChanged: () => void;
}) {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [curve, setCurve] = useState<CurveWithPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [drawnAt, setDrawnAt] = useState(new Date().toISOString().slice(0, 10));

  const [shape, setShape] = useState("s_curve");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [planError, setPlanError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rel, cur] = await Promise.all([
        api.get<{ items: Release[] }>(`${base}/contingencies/${contingency.id}/releases`),
        api.get<CurveWithPlan>(`${base}/contingencies/${contingency.id}/drawdown-curve`),
      ]);
      setReleases(rel.items ?? []);
      setCurve(cur);
    } catch (err) {
      setReleases([]);
      setError(err instanceof ApiClientError ? err.message : "Could not load release history");
    }
  }, [base, contingency.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function request(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api.post(`${base}/contingencies/${contingency.id}/releases`, {
        amount: Number(amount),
        reason: reason.trim(),
        drawnAt,
      });
      setAmount("");
      setReason("");
      await load();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "Could not raise the request");
    } finally {
      setBusy(false);
    }
  }

  async function decide(release: Release, verb: "approve" | "reject" | "withdraw") {
    setBusy(true);
    setFormError(null);
    try {
      await api.post(`${base}/contingency-releases/${release.id}/${verb}`, {});
      await load();
      onChanged();
    } catch (err) {
      setFormError(
        err instanceof ApiClientError ? err.message : `Could not ${verb} the release request`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function generatePlan(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setPlanError(null);
    try {
      await api.put(`${base}/contingencies/${contingency.id}/plan`, {
        shape,
        startDate,
        endDate,
        intervals: 12,
      });
      await load();
    } catch (err) {
      setPlanError(err instanceof ApiClientError ? err.message : "Could not set the planned curve");
    } finally {
      setBusy(false);
    }
  }

  const pending = (releases ?? []).filter((r) => r.status === "requested");

  return (
    <div className="space-y-4">
      <ErrorAlert message={error} onRetry={() => void load()} />
      {formError ? <ErrorAlert message={formError} /> : null}

      {/* ---------------- drift against plan ---------------- */}
      <div className="rounded-md border border-ink-200 p-3">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            Planned vs actual
          </h4>
          {curve?.planSource ? (
            <Badge tone="blue">{humanize(curve.planSource)}</Badge>
          ) : (
            <Badge tone="gray">No plan</Badge>
          )}
        </div>
        {curve === null ? (
          <Spinner label="Loading…" size="sm" inline />
        ) : curve.plan.length === 0 ? (
          <>
            <p className="mb-3 text-xs text-ink-500">
              {curve.drift.basis ||
                "No planned drawdown curve has been set, so nothing can be said about whether the burn is ahead of plan."}
            </p>
            {planError ? <ErrorAlert message={planError} /> : null}
            <form className="grid gap-2 md:grid-cols-4" onSubmit={generatePlan}>
              <Field label="Shape">
                <Select value={shape} onChange={(e) => setShape(e.target.value)}>
                  <option value="s_curve">S-curve</option>
                  <option value="linear">Linear</option>
                  <option value="front_loaded">Front loaded</option>
                  <option value="back_loaded">Back loaded</option>
                </Select>
              </Field>
              <Field label="From">
                <Input
                  type="date"
                  value={startDate}
                  required
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </Field>
              <Field label="To">
                <Input
                  type="date"
                  value={endDate}
                  required
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </Field>
              <div className="flex items-end">
                <Button type="submit" size="sm" disabled={busy}>
                  Generate curve
                </Button>
              </div>
            </form>
          </>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline gap-4 text-sm">
              <span>
                <span className="text-ink-500">Planned remaining </span>
                <strong className="tabular-nums">
                  {curve.drift.plannedRemaining === null
                    ? "—"
                    : formatMoney(curve.drift.plannedRemaining, curve.currency)}
                </strong>
              </span>
              <span>
                <span className="text-ink-500">Actual </span>
                <strong className="tabular-nums">
                  {formatMoney(curve.drift.actualRemaining, curve.currency)}
                </strong>
              </span>
              {curve.drift.variancePercent !== null ? (
                <Badge tone={curve.drift.breached ? "red" : curve.drift.aheadOfPlan ? "amber" : "green"}>
                  {curve.drift.aheadOfPlan ? "ahead of plan" : "behind plan"} by{" "}
                  {Math.abs(curve.drift.variancePercent)}%
                </Badge>
              ) : null}
            </div>
            <p className="text-xs leading-relaxed text-ink-500">{curve.drift.basis}</p>
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th className="text-right">Planned remaining</Th>
                </tr>
              </thead>
              <tbody>
                {curve.plan.slice(0, 8).map((p) => (
                  <tr key={p.date}>
                    <Td>{formatDate(p.date)}</Td>
                    <Td className="text-right tabular-nums">
                      {formatMoney(p.plannedRemaining, curve.currency)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {curve.plan.length > 8 ? (
              <p className="text-xs text-ink-400">
                {curve.plan.length - 8} further planned point(s) not shown.
              </p>
            ) : null}
          </div>
        )}
      </div>

      {/* ---------------- release workflow ---------------- */}
      <div className="rounded-md border border-ink-200 p-3">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            Release requests
          </h4>
          {pending.length > 0 ? <Badge tone="amber">{pending.length} awaiting decision</Badge> : null}
        </div>
        {releases === null ? (
          <Spinner label="Loading…" size="sm" inline />
        ) : releases.length === 0 ? (
          <EmptyState
            size="sm"
            title="No release requests"
            description="A drawdown above the direct-draw threshold must be requested here and approved by somebody other than the requester; the over-draw check runs inside the approving transaction."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="text-right">Amount</Th>
                <Th>Reason</Th>
                <Th>Dated</Th>
                <Th>Status</Th>
                <Th>Decision</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {releases.map((r) => (
                <tr key={r.id}>
                  <Td className="text-right tabular-nums font-medium">
                    {formatMoney(r.amount, contingency.currency)}
                  </Td>
                  <Td className="max-w-xs text-xs">{r.reason}</Td>
                  <Td>{formatDate(r.drawnAt)}</Td>
                  <Td>
                    <Badge tone={statusTone(r.status)}>{humanize(r.status)}</Badge>
                    {r.requiresAdmin === 1 ? (
                      <span className="ml-1 text-[11px] text-ink-400">admin</span>
                    ) : null}
                  </Td>
                  <Td className="text-xs text-ink-500">
                    {r.decidedAt ? formatDateTime(r.decidedAt) : "—"}
                  </Td>
                  <Td>
                    {r.status === "requested" ? (
                      <div className="flex gap-1">
                        <Button size="sm" disabled={busy} onClick={() => void decide(r, "approve")}>
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void decide(r, "reject")}
                        >
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void decide(r, "withdraw")}
                        >
                          Withdraw
                        </Button>
                      </div>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        <form className="mt-3 grid gap-2 md:grid-cols-4" onSubmit={request}>
          <Field label="Amount">
            <Input
              type="number"
              min={0.01}
              step="0.01"
              value={amount}
              required
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label="Reason" className="md:col-span-2">
            <Input value={reason} required onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field label="Dated">
            <Input type="date" value={drawnAt} onChange={(e) => setDrawnAt(e.target.value)} />
          </Field>
          <div className="md:col-span-4">
            <Button type="submit" size="sm" variant="secondary" disabled={busy}>
              Request release
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
