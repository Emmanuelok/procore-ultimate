/**
 * Lender disbursement discipline (spec Vol II Domain O #736-751).
 *
 * Four panels that sit under the facility detail: the draw-stop verdict
 * (availability period + covenant standing), the disbursement forecast
 * against actuals, the ineligible-expenditure recovery register, and the
 * interest / commitment-fee accrual schedule.
 *
 * Deliberately not here: anything that moves money. Every panel is a read
 * with the one exception of opening a recovery, which is an admin action.
 * Figures the API declines to compute are rendered with their stated reason
 * rather than as zero.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  ErrorAlert,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { INELIGIBILITY_REASONS, INELIGIBLE_RECOVERY_STATUSES } from "@constructos/shared";
import { formatDate, humanize } from "../format";
import {
  fmtMoney,
  fmtNum,
  type CostOfFinance,
  type DrawStop,
  type ForecastResponse,
  type RecoveryRow,
} from "./financeShared";

/* ---------------------------------------------------------------- */
/* Draw-stop banner (#747)                                           */
/* ---------------------------------------------------------------- */

/**
 * The one question a treasury team asks first: can we draw today? Rendered
 * green when clear so the absence of a banner is never mistaken for "not
 * checked".
 */
export function DrawStopBanner({ drawStop }: { drawStop: DrawStop | null }) {
  if (!drawStop) return null;
  if (!drawStop.stopped) {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800 ring-1 ring-emerald-200">
        <Badge tone="green">Drawable</Badge>
        <span>
          Inside the availability period and no covenant is in unwaived breach — requests may be
          submitted and paid.
        </span>
      </div>
    );
  }
  return (
    <div className="mb-4 rounded-md border-l-4 border-l-red-600 bg-red-50 px-3 py-3 ring-1 ring-red-100">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="red">Draw-stop in force</Badge>
        <span className="text-sm font-semibold text-red-800">
          No further drawings may be requested or paid
        </span>
      </div>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs leading-5 text-red-800">
        {drawStop.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {drawStop.covenants.some((c) => c.waivedBy) ? (
        <p className="mt-1.5 text-xs text-red-700">
          Waivers on record:{" "}
          {drawStop.covenants
            .filter((c) => c.waivedBy)
            .map(
              (c) =>
                `${c.name}${c.waivedBy?.reference ? ` (${c.waivedBy.reference})` : ""}${
                  c.waivedBy?.effectiveTo ? ` until ${c.waivedBy.effectiveTo}` : ""
                }`,
            )
            .join("; ")}
          .
        </p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Disbursement forecast vs actual (#745-746)                        */
/* ---------------------------------------------------------------- */

export function ForecastPanel({
  base,
  facilityId,
  currency,
}: {
  base: string;
  facilityId: string;
  currency: string;
}) {
  const [data, setData] = useState<ForecastResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [pStart, setPStart] = useState("");
  const [pEnd, setPEnd] = useState("");
  const [pAmount, setPAmount] = useState("");
  const [pMilestone, setPMilestone] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<ForecastResponse>(`${base}/facilities/${facilityId}/forecast`));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load the drawdown forecast");
    } finally {
      setLoading(false);
    }
  }, [base, facilityId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addPeriod(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      await api.post(`${base}/facilities/${facilityId}/forecasts`, {
        periodStart: pStart,
        periodEnd: pEnd,
        plannedAmount: Number(pAmount),
        ...(pMilestone.trim() ? { milestoneTaskId: pMilestone.trim() } : {}),
      });
      setOpen(false);
      setPStart("");
      setPEnd("");
      setPAmount("");
      setPMilestone("");
      await load();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "Could not add the forecast period");
    } finally {
      setBusy(false);
    }
  }

  async function removePeriod(id: string) {
    setError(null);
    try {
      await api.del(`${base}/disbursement-forecasts/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not delete the forecast period");
    }
  }

  return (
    <Card className="mb-5">
      <CardBody>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">Disbursement forecast</h3>
            <p className="text-xs text-ink-400">
              Planned tranches against what was actually paid (#745-746). A tranche tied to an
              incomplete milestone is named, never netted away.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? "Cancel" : "Add period"}
          </Button>
        </div>

        {open ? (
          <form
            onSubmit={addPeriod}
            className="mb-4 grid grid-cols-1 gap-3 rounded-md bg-ink-50 p-3 ring-1 ring-ink-100 sm:grid-cols-5"
          >
            <Field label="Period start">
              <Input type="date" required value={pStart} onChange={(e) => setPStart(e.target.value)} />
            </Field>
            <Field label="Period end">
              <Input type="date" required value={pEnd} onChange={(e) => setPEnd(e.target.value)} />
            </Field>
            <Field label={`Planned (${currency})`}>
              <Input
                type="number"
                min="0"
                step="0.01"
                required
                value={pAmount}
                onChange={(e) => setPAmount(e.target.value)}
              />
            </Field>
            <Field label="Milestone task id" hint="Optional — a tranche gated on a schedule task.">
              <Input value={pMilestone} onChange={(e) => setPMilestone(e.target.value)} />
            </Field>
            <div className="flex items-end">
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? "Saving…" : "Add"}
              </Button>
            </div>
            {formError ? (
              <div className="sm:col-span-5">
                <ErrorAlert message={formError} />
              </div>
            ) : null}
          </form>
        ) : null}

        <ErrorAlert message={error} />

        {loading ? (
          <Spinner label="Loading forecast…" />
        ) : !data || data.points.length === 0 ? (
          <p className="py-4 text-center text-xs text-ink-400">
            No forecast periods recorded — forecast vs actual is unavailable until a drawdown plan
            exists.
          </p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <Badge tone={data.behindPlan ? "red" : "green"}>
                {data.behindPlan ? "Behind plan" : "On or ahead of plan"}
              </Badge>
              <span className="text-xs text-ink-600">
                Planned to date{" "}
                <span className="font-semibold tabular-nums">
                  {fmtMoney(data.totalPlanned, data.currency)}
                </span>{" "}
                · actual{" "}
                <span className="font-semibold tabular-nums">
                  {fmtMoney(data.totalActual, data.currency)}
                </span>{" "}
                · lag{" "}
                <span
                  className={`font-semibold tabular-nums ${
                    data.lagAmount > 0 ? "text-amber-700" : "text-ink-700"
                  }`}
                >
                  {fmtMoney(data.lagAmount, data.currency)}
                  {data.lagPercent === null ? "" : ` (${fmtNum(data.lagPercent)}%)`}
                </span>
              </span>
            </div>

            {data.milestoneBreaches.length > 0 ? (
              <ul className="mb-3 list-disc space-y-1 rounded-md bg-amber-50 px-5 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
                {data.milestoneBreaches.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            ) : null}

            <Table>
              <thead>
                <tr>
                  <Th>Period</Th>
                  <Th className="text-right">Planned</Th>
                  <Th className="text-right">Actual</Th>
                  <Th className="text-right">Variance</Th>
                  <Th className="text-right">Cumulative</Th>
                  <Th>Milestone</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {data.points.map((p) => {
                  const row = data.forecasts.find(
                    (f) => f.periodStart === p.periodStart && f.periodEnd === p.periodEnd,
                  );
                  const milestone = row?.milestoneTaskId
                    ? data.milestones.find((m) => m.id === row.milestoneTaskId)
                    : null;
                  return (
                    <tr key={`${p.periodStart}-${p.periodEnd}`}>
                      <Td className="whitespace-nowrap text-xs">
                        {formatDate(p.periodStart)} → {formatDate(p.periodEnd)}
                      </Td>
                      <Td className="whitespace-nowrap text-right tabular-nums">
                        {fmtMoney(p.planned, data.currency)}
                      </Td>
                      <Td className="whitespace-nowrap text-right tabular-nums">
                        {fmtMoney(p.actual, data.currency)}
                      </Td>
                      <Td
                        className={`whitespace-nowrap text-right tabular-nums ${
                          p.variance < 0 ? "text-amber-700" : "text-emerald-700"
                        }`}
                      >
                        {fmtMoney(p.variance, data.currency)}
                        {p.variancePercent === null ? "" : ` (${fmtNum(p.variancePercent)}%)`}
                      </Td>
                      <Td className="whitespace-nowrap text-right text-xs tabular-nums text-ink-500">
                        {fmtMoney(p.cumulativeActual, data.currency)} /{" "}
                        {fmtMoney(p.cumulativePlanned, data.currency)}
                      </Td>
                      <Td className="text-xs">
                        {milestone ? (
                          <span
                            className={
                              p.milestoneOutstanding ? "font-medium text-red-700" : "text-ink-600"
                            }
                          >
                            {milestone.name}
                            {p.milestoneOutstanding ? " — not complete" : ""}
                          </span>
                        ) : (
                          <span className="text-ink-300">—</span>
                        )}
                      </Td>
                      <Td className="text-right">
                        {row ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void removePeriod(row.id)}
                            title="Remove this forecast period"
                          >
                            Remove
                          </Button>
                        ) : null}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <p className="mt-2 text-xs leading-5 text-ink-400">{data.basis}</p>
          </>
        )}
      </CardBody>
    </Card>
  );
}

/* ---------------------------------------------------------------- */
/* Ineligible expenditure recoveries (#744)                          */
/* ---------------------------------------------------------------- */

export function RecoveriesPanel({
  base,
  facilityId,
  currency,
}: {
  base: string;
  facilityId: string;
  currency: string;
}) {
  const [items, setItems] = useState<RecoveryRow[] | null>(null);
  const [openByCurrency, setOpenByCurrency] = useState<
    Array<{ currency: string; amount: number }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState("");
  const [detail, setDetail] = useState("");
  const [reason, setReason] = useState<string>("outside_scope");

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{
        items: RecoveryRow[];
        openByCurrency: Array<{ currency: string; amount: number }>;
      }>(`${base}/facilities/${facilityId}/recoveries`);
      setItems(res.items);
      setOpenByCurrency(res.openByCurrency ?? []);
    } catch (err) {
      setItems([]);
      setError(err instanceof ApiClientError ? err.message : "Could not load recoveries");
    }
  }, [base, facilityId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      await api.post(`${base}/facilities/${facilityId}/recoveries`, {
        amount: Number(amount),
        reason,
        ...(detail.trim() ? { detail: detail.trim() } : {}),
      });
      setFormOpen(false);
      setAmount("");
      setDetail("");
      await load();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "Could not open the recovery");
    } finally {
      setBusy(false);
    }
  }

  async function resolve(row: RecoveryRow, status: string) {
    setError(null);
    try {
      await api.post(`${base}/recoveries/${row.id}/resolve`, { status });
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not resolve the recovery");
    }
  }

  return (
    <Card className="mb-5">
      <CardBody>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">Ineligible expenditure recoveries</h3>
            <p className="text-xs text-ink-400">
              Amounts financed that a lender audit would disallow (#744) — open until recovered,
              offset or written off.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setFormOpen((v) => !v)}>
            {formOpen ? "Cancel" : "Open recovery"}
          </Button>
        </div>

        {openByCurrency.length > 0 ? (
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            {openByCurrency.map((b) => (
              <span
                key={b.currency}
                className="rounded-full bg-red-50 px-2.5 py-1 font-semibold tabular-nums text-red-800 ring-1 ring-red-200"
              >
                {fmtMoney(b.amount, b.currency)} open
              </span>
            ))}
          </div>
        ) : null}

        {formOpen ? (
          <form
            onSubmit={create}
            className="mb-4 grid grid-cols-1 gap-3 rounded-md bg-ink-50 p-3 ring-1 ring-ink-100 sm:grid-cols-3"
          >
            <Field label={`Amount (${currency})`}>
              <Input
                type="number"
                min="0"
                step="0.01"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Reason">
              <Select value={reason} onChange={(e) => setReason(e.target.value)}>
                {INELIGIBILITY_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {humanize(r)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Detail" hint="What exactly was disallowed, and under which clause.">
              <Input
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                placeholder="Taxes financed contrary to loan agreement clause 3.4…"
              />
            </Field>
            <div className="sm:col-span-3 flex justify-end">
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? "Saving…" : "Open recovery"}
              </Button>
            </div>
            {formError ? (
              <div className="sm:col-span-3">
                <ErrorAlert message={formError} />
              </div>
            ) : null}
          </form>
        ) : null}

        <ErrorAlert message={error} />

        {items === null ? (
          <Spinner />
        ) : items.length === 0 ? (
          <p className="py-4 text-center text-xs text-ink-400">
            No ineligible expenditure has been identified on this facility.
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="text-right">Amount</Th>
                <Th>Reason</Th>
                <Th>Detail</Th>
                <Th>Status</Th>
                <Th>Opened</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {items.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap text-right font-medium tabular-nums">
                    {fmtMoney(r.amount, r.currency)}
                  </Td>
                  <Td className="text-xs">{humanize(r.reason)}</Td>
                  <Td className="text-xs">{r.detail ?? "—"}</Td>
                  <Td>
                    <Badge tone={r.status === "open" ? "red" : "gray"}>{humanize(r.status)}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-ink-500">
                    {formatDate(r.createdAt)}
                  </Td>
                  <Td className="text-right">
                    {r.status === "open" ? (
                      <div className="flex justify-end gap-1.5">
                        {INELIGIBLE_RECOVERY_STATUSES.filter((s) => s !== "open").map((s) => (
                          <Button
                            key={s}
                            variant="secondary"
                            size="sm"
                            onClick={() => void resolve(r, s)}
                          >
                            {humanize(s)}
                          </Button>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-ink-400">
                        {r.resolvedAt ? formatDate(r.resolvedAt) : "—"}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </CardBody>
    </Card>
  );
}

/* ---------------------------------------------------------------- */
/* Cost of finance (#748-751)                                        */
/* ---------------------------------------------------------------- */

export function CostOfFinancePanel({
  base,
  facilityId,
}: {
  base: string;
  facilityId: string;
}) {
  const [data, setData] = useState<CostOfFinance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<CostOfFinance>(`${base}/facilities/${facilityId}/cost-of-finance`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof ApiClientError ? err.message : "Could not load the accrual schedule",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [base, facilityId]);

  return (
    <Card className="mb-5">
      <CardBody>
        <h3 className="mb-1 text-sm font-semibold text-ink-900">
          Interest during construction &amp; commitment fees
        </h3>
        <p className="mb-3 text-xs text-ink-400">
          Accrued on the time-weighted drawn and undrawn balances from the disbursement ledger
          (#748-751).
        </p>
        <ErrorAlert message={error} />
        {loading ? (
          <Spinner />
        ) : !data ? null : data.unavailableReason ? (
          <p className="rounded-md bg-ink-50 px-3 py-2 text-xs leading-5 text-ink-600 ring-1 ring-ink-100">
            — {data.unavailableReason}
          </p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-4 text-xs">
              <span>
                Interest{" "}
                <span className="font-semibold tabular-nums text-ink-900">
                  {fmtMoney(data.totalInterest, data.currency)}
                </span>
              </span>
              <span>
                Commitment fees{" "}
                <span className="font-semibold tabular-nums text-ink-900">
                  {fmtMoney(data.totalCommitmentFees, data.currency)}
                </span>
              </span>
              <span>
                Total cost of finance{" "}
                <span className="font-semibold tabular-nums text-brand-700">
                  {fmtMoney(data.totalCostOfFinance, data.currency)}
                </span>
              </span>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Period</Th>
                    <Th className="text-right">Days</Th>
                    <Th className="text-right">Opening drawn</Th>
                    <Th className="text-right">Drawn</Th>
                    <Th className="text-right">Avg drawn</Th>
                    <Th className="text-right">Avg undrawn</Th>
                    <Th className="text-right">Interest</Th>
                    <Th className="text-right">Fee</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {data.periods.map((p) => (
                    <tr key={p.periodEnd}>
                      <Td className="whitespace-nowrap text-xs">
                        {formatDate(p.periodStart)} → {formatDate(p.periodEnd)}
                      </Td>
                      <Td className="text-right tabular-nums text-xs">{p.days}</Td>
                      <Td className="text-right tabular-nums text-xs">
                        {fmtMoney(p.openingDrawn, data.currency)}
                      </Td>
                      <Td className="text-right tabular-nums text-xs">
                        {fmtMoney(p.drawnInPeriod, data.currency)}
                      </Td>
                      <Td className="text-right tabular-nums text-xs">
                        {fmtMoney(p.averageDrawn, data.currency)}
                      </Td>
                      <Td className="text-right tabular-nums text-xs">
                        {fmtMoney(p.averageUndrawn, data.currency)}
                      </Td>
                      <Td className="text-right tabular-nums text-xs font-medium">
                        {fmtMoney(p.interest, data.currency)}
                      </Td>
                      <Td className="text-right tabular-nums text-xs">
                        {fmtMoney(p.commitmentFee, data.currency)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
            <p className="mt-2 text-xs leading-5 text-ink-400">{data.basis}</p>
          </>
        )}
      </CardBody>
    </Card>
  );
}

/* ---------------------------------------------------------------- */
/* Eligibility classification (#736-737)                             */
/* ---------------------------------------------------------------- */

export interface EligibilityDraft {
  evidenceId: string;
  eligibility: string;
  reason: string;
  amount: string;
}

/**
 * Classify every attached item before the application can be submitted.
 * "Unassessed" is deliberately allowed as a saved state and deliberately
 * blocks submission — the classification is the work, not the paperwork.
 */
export function EligibilityForm({
  base,
  disbursementId,
  evidenceIds,
  existing,
  currency,
  onSaved,
  onCancel,
}: {
  base: string;
  disbursementId: string;
  evidenceIds: string[];
  existing: Array<{ evidenceId: string; eligibility: string; reason?: string | null; amount?: number | null }>;
  currency: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<EligibilityDraft[]>(() =>
    evidenceIds.map((id) => {
      const prior = existing.find((e) => e.evidenceId === id);
      return {
        evidenceId: id,
        eligibility: prior?.eligibility ?? "unassessed",
        reason: prior?.reason ?? "",
        amount: prior?.amount === null || prior?.amount === undefined ? "" : String(prior.amount),
      };
    }),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function patch(i: number, next: Partial<EligibilityDraft>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...next } : r)));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.put(`${base}/disbursements/${disbursementId}/eligibility`, {
        entries: rows.map((r) => ({
          evidenceId: r.evidenceId,
          eligibility: r.eligibility,
          ...(r.reason.trim() ? { reason: r.reason.trim() } : {}),
          ...(r.amount.trim() ? { amount: Number(r.amount) } : {}),
        })),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not save the classification");
    } finally {
      setBusy(false);
    }
  }

  if (evidenceIds.length === 0) {
    return (
      <div>
        <p className="text-sm text-ink-600">
          This request has no evidence attached, so there is nothing to classify. Attach expenditure
          evidence first.
        </p>
        <div className="mt-3 flex justify-end">
          <Button variant="secondary" onClick={onCancel}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={save} className="space-y-3">
      <ErrorAlert message={error} />
      <p className="text-xs leading-5 text-ink-500">
        Every attached item must be classified before the application can be submitted. An
        ineligible classification must state why.
      </p>
      <div className="space-y-3">
        {rows.map((r, i) => (
          <div key={r.evidenceId} className="rounded-md bg-ink-50 p-3 ring-1 ring-ink-100">
            <div className="mb-2 font-mono text-xs text-ink-500">{r.evidenceId}</div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Eligibility">
                <Select
                  value={r.eligibility}
                  onChange={(e) => patch(i, { eligibility: e.target.value })}
                >
                  <option value="eligible">Eligible</option>
                  <option value="ineligible">Ineligible</option>
                  <option value="unassessed">Unassessed</option>
                </Select>
              </Field>
              <Field label={`Amount (${currency})`} hint="Optional — the portion assessed.">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={r.amount}
                  onChange={(e) => patch(i, { amount: e.target.value })}
                />
              </Field>
              <Field
                label="Reason"
                hint={r.eligibility === "ineligible" ? "Required for an ineligible item." : "Optional."}
              >
                <Input value={r.reason} onChange={(e) => patch(i, { reason: e.target.value })} />
              </Field>
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save classification"}
        </Button>
      </div>
    </form>
  );
}

/** Certification block (#738): the independent engineer's sign-off. */
export function CertifyForm({
  base,
  disbursementId,
  onDone,
  onCancel,
}: {
  base: string;
  disbursementId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const ids = evidence
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await api.post(`${base}/disbursements/${disbursementId}/certify`, {
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(ids.length ? { evidenceIds: ids } : {}),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Certification failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <ErrorAlert message={error} />
      <p className="text-xs leading-5 text-ink-500">
        Certification is the independent engineer&rsquo;s statement that the works claimed were
        executed. The certifier may not be the requester, the submitter or the approver.
      </p>
      <Field label="Certification note">
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Works inspected on site 12 March; quantities agree with the measured record…"
        />
      </Field>
      <Field label="Certification evidence ids" hint="Space or comma separated — optional.">
        <Input value={evidence} onChange={(e) => setEvidence(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Certifying…" : "Certify"}
        </Button>
      </div>
    </form>
  );
}
