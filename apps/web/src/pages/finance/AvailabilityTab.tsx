/**
 * PPP / availability payment mechanism — spec Vol II Domain O.
 *
 * The unitary charge is earned in full only when the asset is available AND
 * performing. This tab records the mechanism's negotiated terms, the events
 * that reduce the charge in a period, and what the mechanism therefore pays.
 *
 * Two honesty rules show through the UI: a draft period is an unagreed
 * number and is excluded from the totals, and a period with no required
 * availability hours reports the availability element as uncomputable rather
 * than paying it in full.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
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
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import { fmtMoney, fmtNum } from "./financeShared";

interface AvailabilityModel {
  id: string;
  name: string;
  currency: string;
  unitaryCharge: number;
  periodMonths: number;
  availabilityWeightPercent: number;
  performanceWeightPercent: number;
  performancePointValuePercent: number;
  deductionCapPercent: number | null;
  persistentBreachPoints: number | null;
  notes: string | null;
}

interface Computed {
  currency: string;
  grossCharge: number;
  weightedUnavailableHours: number;
  requiredHours: number;
  availabilityRatio: number | null;
  availabilityDeduction: number;
  performanceDeduction: number;
  rawDeduction: number;
  totalDeduction: number;
  capApplied: boolean;
  netPayment: number;
  persistentBreach: boolean;
  warnings: string[];
  basis: string;
}

interface PeriodRow {
  id: string;
  periodStart: string;
  periodEnd: string;
  requiredHours: number;
  unavailabilityEvents: Array<{ area: string; hours: number; weight: number; note?: string | null }>;
  performancePoints: number;
  status: string;
  computed: Computed | null;
  certifiedBy: string | null;
  certifiedAt: string | null;
  createdBy: string;
}

interface PeriodsResponse {
  model: AvailabilityModel;
  items: PeriodRow[];
  totals: {
    currency: string;
    periods: number;
    certifiedPeriods: number;
    certifiedGross: number;
    certifiedDeductions: number;
    certifiedNet: number;
  };
  basis: string;
}

interface EventDraft {
  area: string;
  hours: string;
  weight: string;
}

export default function AvailabilityTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;
  const [models, setModels] = useState<AvailabilityModel[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [periods, setPeriods] = useState<PeriodsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadModels = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ items: AvailabilityModel[] }>(`${base}/availability-models`);
      setModels(res.items ?? []);
      setSelectedId((prev) => prev ?? res.items[0]?.id ?? null);
    } catch (err) {
      setModels([]);
      setError(
        err instanceof ApiClientError ? err.message : "Could not load availability payment models",
      );
    }
  }, [base]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const loadPeriods = useCallback(async () => {
    if (!selectedId) {
      setPeriods(null);
      return;
    }
    try {
      setPeriods(
        await api.get<PeriodsResponse>(`${base}/availability-models/${selectedId}/periods`),
      );
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load the payment periods");
    }
  }, [base, selectedId]);

  useEffect(() => {
    void loadPeriods();
  }, [loadPeriods]);

  /* ------------------------------- create model ----------------------------- */

  const [modelOpen, setModelOpen] = useState(false);
  const [mName, setMName] = useState("");
  const [mCharge, setMCharge] = useState("");
  const [mCurrency, setMCurrency] = useState("GBP");
  const [mAvail, setMAvail] = useState("70");
  const [mPerf, setMPerf] = useState("30");
  const [mPointValue, setMPointValue] = useState("0.1");
  const [mCap, setMCap] = useState("");
  const [mBreach, setMBreach] = useState("");
  const [mNotes, setMNotes] = useState("");
  const [modelError, setModelError] = useState<string | null>(null);

  async function createModel(e: FormEvent) {
    e.preventDefault();
    setModelError(null);
    setBusy(true);
    try {
      const created = await api.post<AvailabilityModel>(`${base}/availability-models`, {
        name: mName.trim(),
        unitaryCharge: Number(mCharge),
        currency: mCurrency.trim().toUpperCase() || "GBP",
        availabilityWeightPercent: Number(mAvail),
        performanceWeightPercent: Number(mPerf),
        performancePointValuePercent: Number(mPointValue),
        ...(mCap.trim() ? { deductionCapPercent: Number(mCap) } : {}),
        ...(mBreach.trim() ? { persistentBreachPoints: Number(mBreach) } : {}),
        ...(mNotes.trim() ? { notes: mNotes.trim() } : {}),
      });
      setModelOpen(false);
      setMName("");
      setMCharge("");
      setMNotes("");
      await loadModels();
      setSelectedId(created.id);
    } catch (err) {
      setModelError(err instanceof ApiClientError ? err.message : "Could not create the model");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------- create period ---------------------------- */

  const [periodOpen, setPeriodOpen] = useState(false);
  const [pStart, setPStart] = useState("");
  const [pEnd, setPEnd] = useState("");
  const [pHours, setPHours] = useState("");
  const [pPoints, setPPoints] = useState("0");
  const [pEvents, setPEvents] = useState<EventDraft[]>([]);
  const [periodError, setPeriodError] = useState<string | null>(null);

  async function createPeriod(e: FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setPeriodError(null);
    setBusy(true);
    try {
      await api.post(`${base}/availability-models/${selectedId}/periods`, {
        periodStart: pStart,
        periodEnd: pEnd,
        requiredHours: Number(pHours),
        performancePoints: Number(pPoints) || 0,
        unavailabilityEvents: pEvents
          .filter((ev) => ev.area.trim())
          .map((ev) => ({
            area: ev.area.trim(),
            hours: Number(ev.hours) || 0,
            weight: Number(ev.weight) || 0,
          })),
      });
      setPeriodOpen(false);
      setPEvents([]);
      setPHours("");
      setPPoints("0");
      await loadPeriods();
    } catch (err) {
      setPeriodError(err instanceof ApiClientError ? err.message : "Could not record the period");
    } finally {
      setBusy(false);
    }
  }

  async function certify(period: PeriodRow) {
    setError(null);
    try {
      await api.post(`${base}/availability-periods/${period.id}/certify`, {});
      await loadPeriods();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not certify the period");
    }
  }

  if (models === null) return <Spinner label="Loading availability models…" />;

  const model = periods?.model ?? models.find((m) => m.id === selectedId) ?? null;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {models.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setSelectedId(m.id)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ring-1 ${
                m.id === selectedId
                  ? "bg-brand-600 text-white ring-brand-600"
                  : "bg-white text-ink-600 ring-ink-200 hover:bg-ink-50"
              }`}
            >
              {m.name}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={() => setModelOpen(true)}>
          New mechanism
        </Button>
      </div>

      <ErrorAlert message={error} />

      {models.length === 0 ? (
        <EmptyState
          title="No availability payment mechanism"
          hint="Record the concession's unitary charge and its availability / performance weights, then log each period's unavailability and failure points to compute what is actually payable."
          action={<Button onClick={() => setModelOpen(true)}>Define the mechanism</Button>}
        />
      ) : (
        <>
          {model ? (
            <Card className="mb-4">
              <CardBody>
                <div className="flex flex-wrap items-baseline gap-4 text-xs text-ink-600">
                  <span>
                    Unitary charge{" "}
                    <strong className="tabular-nums text-ink-900">
                      {fmtMoney(model.unitaryCharge, model.currency)}
                    </strong>{" "}
                    per {model.periodMonths === 1 ? "month" : `${model.periodMonths} months`}
                  </span>
                  <span>
                    availability {fmtNum(model.availabilityWeightPercent)}% · performance{" "}
                    {fmtNum(model.performanceWeightPercent)}%
                  </span>
                  <span>
                    point value {fmtNum(model.performancePointValuePercent)}% of the charge
                  </span>
                  <span>
                    cap{" "}
                    {model.deductionCapPercent === null
                      ? "none"
                      : `${fmtNum(model.deductionCapPercent)}%`}
                  </span>
                  <span>
                    persistent breach{" "}
                    {model.persistentBreachPoints === null
                      ? "not set"
                      : `${fmtNum(model.persistentBreachPoints)} points`}
                  </span>
                </div>
                {model.notes ? (
                  <p className="mt-1.5 text-xs leading-5 text-ink-500">{model.notes}</p>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          {periods ? (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Card>
                <CardBody className="px-4 py-3">
                  <div className="text-lg font-bold tabular-nums text-ink-900">
                    {periods.totals.certifiedPeriods} / {periods.totals.periods}
                  </div>
                  <div className="text-xs uppercase tracking-wide text-ink-400">
                    Periods certified
                  </div>
                </CardBody>
              </Card>
              <Card>
                <CardBody className="px-4 py-3">
                  <div className="text-lg font-bold tabular-nums text-ink-900">
                    {fmtMoney(periods.totals.certifiedGross, periods.totals.currency)}
                  </div>
                  <div className="text-xs uppercase tracking-wide text-ink-400">Gross certified</div>
                </CardBody>
              </Card>
              <Card>
                <CardBody className="px-4 py-3">
                  <div className="text-lg font-bold tabular-nums text-red-700">
                    {fmtMoney(periods.totals.certifiedDeductions, periods.totals.currency)}
                  </div>
                  <div className="text-xs uppercase tracking-wide text-ink-400">Deductions</div>
                </CardBody>
              </Card>
              <Card>
                <CardBody className="px-4 py-3">
                  <div className="text-lg font-bold tabular-nums text-brand-700">
                    {fmtMoney(periods.totals.certifiedNet, periods.totals.currency)}
                  </div>
                  <div className="text-xs uppercase tracking-wide text-ink-400">Net payable</div>
                </CardBody>
              </Card>
            </div>
          ) : null}

          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink-900">Payment periods</h3>
            <Button
              size="sm"
              variant="secondary"
              disabled={!selectedId}
              onClick={() => {
                setPeriodError(null);
                setPeriodOpen(true);
              }}
            >
              Record period
            </Button>
          </div>

          {!periods || periods.items.length === 0 ? (
            <p className="rounded-md bg-ink-50 px-3 py-3 text-center text-xs text-ink-400">
              No periods recorded against this mechanism.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Period</Th>
                    <Th className="text-right">Availability</Th>
                    <Th className="text-right">Avail. deduction</Th>
                    <Th className="text-right">Points</Th>
                    <Th className="text-right">Perf. deduction</Th>
                    <Th className="text-right">Net payable</Th>
                    <Th>Status</Th>
                    <Th className="text-right" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {periods.items.map((p) => (
                    <tr key={p.id}>
                      <Td className="whitespace-nowrap text-xs">
                        {formatDate(p.periodStart)} → {formatDate(p.periodEnd)}
                        {p.computed?.warnings.length ? (
                          <div className="mt-0.5 max-w-xs text-[11px] leading-4 text-amber-700">
                            {p.computed.warnings.join(" ")}
                          </div>
                        ) : null}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {p.computed?.availabilityRatio === null ||
                        p.computed?.availabilityRatio === undefined
                          ? "—"
                          : `${fmtNum(p.computed.availabilityRatio * 100)}%`}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {fmtMoney(p.computed?.availabilityDeduction ?? null, periods.totals.currency)}
                      </Td>
                      <Td className="text-right tabular-nums">{fmtNum(p.performancePoints)}</Td>
                      <Td className="text-right tabular-nums">
                        {fmtMoney(p.computed?.performanceDeduction ?? null, periods.totals.currency)}
                      </Td>
                      <Td className="text-right font-semibold tabular-nums">
                        {fmtMoney(p.computed?.netPayment ?? null, periods.totals.currency)}
                      </Td>
                      <Td>
                        <Badge
                          tone={
                            p.status === "certified"
                              ? "green"
                              : p.status === "disputed"
                                ? "red"
                                : "gray"
                          }
                        >
                          {humanize(p.status)}
                        </Badge>
                        {p.computed?.persistentBreach ? (
                          <div className="mt-0.5">
                            <Badge tone="red">persistent breach</Badge>
                          </div>
                        ) : null}
                      </Td>
                      <Td className="text-right">
                        {p.status === "draft" ? (
                          <Button
                            size="sm"
                            title="Admin — the person who recorded the period cannot certify it"
                            onClick={() => void certify(p)}
                          >
                            Certify
                          </Button>
                        ) : p.certifiedAt ? (
                          <span className="text-[11px] text-ink-400">
                            {formatDate(p.certifiedAt)}
                          </span>
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <p className="mt-2 text-xs leading-5 text-ink-400">{periods.basis}</p>
            </div>
          )}
        </>
      )}

      {/* ------------------------------- model modal ------------------------------ */}
      <Modal open={modelOpen} title="Availability payment mechanism" onClose={() => setModelOpen(false)} wide>
        <ErrorAlert message={modelError} />
        <form onSubmit={createModel} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Field label="Name">
                <Input required value={mName} onChange={(e) => setMName(e.target.value)} />
              </Field>
            </div>
            <Field label="Currency">
              <Input
                value={mCurrency}
                onChange={(e) => setMCurrency(e.target.value)}
                maxLength={3}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Unitary charge per period">
              <Input
                type="number"
                min="0.01"
                step="0.01"
                required
                value={mCharge}
                onChange={(e) => setMCharge(e.target.value)}
              />
            </Field>
            <Field label="Availability weight %">
              <Input
                type="number"
                min="0"
                max="100"
                step="1"
                value={mAvail}
                onChange={(e) => setMAvail(e.target.value)}
              />
            </Field>
            <Field label="Performance weight %" hint="The two weights cannot exceed 100% together.">
              <Input
                type="number"
                min="0"
                max="100"
                step="1"
                value={mPerf}
                onChange={(e) => setMPerf(e.target.value)}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Value of one failure point (% of charge)">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={mPointValue}
                onChange={(e) => setMPointValue(e.target.value)}
              />
            </Field>
            <Field label="Deduction cap (% of charge)" hint="Blank = uncapped.">
              <Input
                type="number"
                min="0"
                max="100"
                step="1"
                value={mCap}
                onChange={(e) => setMCap(e.target.value)}
              />
            </Field>
            <Field label="Persistent breach threshold (points)" hint="Blank = not modelled.">
              <Input
                type="number"
                min="0"
                step="1"
                value={mBreach}
                onChange={(e) => setMBreach(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Notes">
            <Textarea
              value={mNotes}
              onChange={(e) => setMNotes(e.target.value)}
              className="min-h-16 text-xs"
              placeholder="Schedule 14 payment mechanism; deductions applied monthly in arrears…"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setModelOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Create mechanism"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ------------------------------ period modal ------------------------------ */}
      <Modal open={periodOpen} title="Record a payment period" onClose={() => setPeriodOpen(false)} wide>
        <ErrorAlert message={periodError} />
        <form onSubmit={createPeriod} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <Field label="Period start">
              <Input type="date" required value={pStart} onChange={(e) => setPStart(e.target.value)} />
            </Field>
            <Field label="Period end">
              <Input type="date" required value={pEnd} onChange={(e) => setPEnd(e.target.value)} />
            </Field>
            <Field
              label="Required hours"
              hint="Hours the asset was contractually required to be available."
            >
              <Input
                type="number"
                min="0"
                step="1"
                required
                value={pHours}
                onChange={(e) => setPHours(e.target.value)}
              />
            </Field>
            <Field label="Performance failure points">
              <Input
                type="number"
                min="0"
                step="1"
                value={pPoints}
                onChange={(e) => setPPoints(e.target.value)}
              />
            </Field>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                Unavailability events
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPEvents((es) => [...es, { area: "", hours: "", weight: "1" }])}
              >
                + Add event
              </Button>
            </div>
            {pEvents.length === 0 ? (
              <div className="rounded-md border border-dashed border-ink-200 px-3 py-2 text-xs text-ink-400">
                No unavailability recorded — the availability element is earned in full.
              </div>
            ) : (
              <div className="space-y-2">
                {pEvents.map((ev, i) => (
                  <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                    <div className="sm:col-span-6">
                      <Input
                        value={ev.area}
                        placeholder="Area or system"
                        onChange={(e) =>
                          setPEvents((es) =>
                            es.map((x, j) => (j === i ? { ...x, area: e.target.value } : x)),
                          )
                        }
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <Input
                        type="number"
                        min="0"
                        step="0.25"
                        value={ev.hours}
                        placeholder="hours"
                        onChange={(e) =>
                          setPEvents((es) =>
                            es.map((x, j) => (j === i ? { ...x, hours: e.target.value } : x)),
                          )
                        }
                      />
                    </div>
                    <div className="sm:col-span-3">
                      <Input
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        value={ev.weight}
                        placeholder="weight 0–1"
                        onChange={(e) =>
                          setPEvents((es) =>
                            es.map((x, j) => (j === i ? { ...x, weight: e.target.value } : x)),
                          )
                        }
                      />
                    </div>
                    <div className="flex items-center sm:col-span-1">
                      <button
                        type="button"
                        className="text-xs text-ink-400 hover:text-red-700"
                        aria-label="Remove event"
                        onClick={() => setPEvents((es) => es.filter((_, j) => j !== i))}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-1 text-xs text-ink-400">
              Weight is the share of the asset the area represents — 1 is the whole asset. A plant
              room out of service is not the same loss as a ward.
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPeriodOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Computing…" : "Record period"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
