/**
 * Quantum and disruption workspace (spec Vol II Domain D #290-303, #312-313).
 *
 * Left: the head-office overhead formulae (Hudson, Emden, Eichleay), site
 * overhead, finance charges and loss of profit — each showing its formula, its
 * workings and the assumptions the claimant is making, because the assumption
 * is what a respondent attacks.
 *
 * Right: disruption — measured mile from this project's own timecards and
 * daily-log quantities, earned-value productivity, and the published industry
 * curves, which refuse to produce a number without a written justification.
 *
 * Nothing here invents an input: a missing figure comes back as a 400 naming
 * exactly what is missing, and that message is shown verbatim.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiClientError } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Select,
  Spinner,
  Textarea,
  Th,
} from "../../ui";
import { formatDateTime } from "../format";
import type { ListResponse } from "./forensicsShared";

function msg(err: unknown, fallback: string): string {
  return err instanceof ApiClientError || err instanceof Error ? err.message : fallback;
}

function money(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${currency} ${Math.round(value)}`;
  }
}

interface QuantumRow {
  id: string;
  method: string;
  currency: string;
  amount: number | null;
  formula: string | null;
  workings: string | null;
  assumptions: string[];
  claimId: string | null;
  createdAt: string;
}

interface DisruptionRow {
  id: string;
  method: string;
  title: string;
  trade: string | null;
  lostHours: number | null;
  amount: number | null;
  currency: string;
  justification: string | null;
  output: Record<string, unknown>;
  createdAt: string;
}

interface SeriesResponse {
  points: { weekStart: string; hours: number; quantity: number }[];
  suggestedBaseline: { from: string; to: string; productivity: number; weeks: number } | null;
  sources: { timecards: number; dailyLogQuantities: number };
  reasons: string[];
}

const QUANTUM_METHODS = [
  { key: "hudson", label: "Hudson (tendered HO&P %)" },
  { key: "emden", label: "Emden (actual HO %)" },
  { key: "eichleay", label: "Eichleay (billings allocation)" },
  { key: "site_overhead", label: "Site overhead (time-related prelims)" },
  { key: "finance_charge", label: "Finance charge" },
  { key: "loss_of_profit", label: "Loss of profit" },
];

const FIELDS_BY_METHOD: Record<string, { key: string; label: string; placeholder?: string }[]> = {
  hudson: [
    { key: "contractSum", label: "Contract sum" },
    { key: "contractPeriodDays", label: "Contract period (days)" },
    { key: "hoProfitPercent", label: "Tendered HO & profit %" },
    { key: "delayDays", label: "Delay (days)" },
  ],
  emden: [
    { key: "contractSum", label: "Contract sum" },
    { key: "contractPeriodDays", label: "Contract period (days)" },
    { key: "actualOverheadPercent", label: "Actual overhead % (accounts)" },
    { key: "delayDays", label: "Delay (days)" },
  ],
  eichleay: [
    { key: "contractBillings", label: "Billings on this contract" },
    { key: "totalBillings", label: "Total billings in the period" },
    { key: "totalOverhead", label: "Total head-office overhead" },
    { key: "performanceDays", label: "Days of performance" },
    { key: "delayDays", label: "Compensable delay (days)" },
  ],
  site_overhead: [
    { key: "prelimsTimeTotal", label: "Time-related preliminaries" },
    { key: "programmeDays", label: "Programme days" },
    { key: "ratePerDay", label: "Explicit rate/day (optional)" },
    { key: "fixedPrelimsAttributable", label: "Attributable fixed prelims (optional)" },
    { key: "delayDays", label: "Delay (days)" },
  ],
  finance_charge: [
    { key: "principal", label: "Principal financed" },
    { key: "annualRatePercent", label: "Annual rate %" },
    { key: "days", label: "Days financed" },
  ],
  loss_of_profit: [
    { key: "marginPercent", label: "Tendered margin %" },
    { key: "displacedTurnover", label: "Displaced turnover (optional)" },
    { key: "contractSum", label: "Contract sum" },
    { key: "contractPeriodDays", label: "Contract period (days)" },
    { key: "delayDays", label: "Delay (days)" },
  ],
};

const MCAA_KEYS = [
  "stacking_of_trades",
  "morale_and_attitude",
  "reassignment_of_manpower",
  "crew_size_inefficiency",
  "concurrent_operations",
  "dilution_of_supervision",
  "learning_curve",
  "errors_and_omissions",
  "beneficial_occupancy",
  "joint_occupancy",
  "site_access",
  "logistics",
  "fatigue",
  "ripple",
  "overtime",
  "season_and_weather",
];

export default function QuantumTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  const [quantum, setQuantum] = useState<QuantumRow[] | null>(null);
  const [disruption, setDisruption] = useState<DisruptionRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [q, d] = await Promise.all([
          api.get<ListResponse<QuantumRow>>(`${base}/forensics/quantum?pageSize=50`),
          api.get<ListResponse<DisruptionRow>>(`${base}/forensics/disruption?pageSize=50`),
        ]);
        if (cancelled) return;
        setQuantum(q.items);
        setDisruption(d.items);
      } catch (err) {
        if (!cancelled) {
          setQuantum([]);
          setLoadError(msg(err, "The quantum workspace could not be loaded."));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, version]);

  /* -------------------------------- quantum form -------------------------------- */

  const [method, setMethod] = useState("hudson");
  const [values, setValues] = useState<Record<string, string>>({});
  const [currency, setCurrency] = useState("GBP");
  const [basis, setBasis] = useState("simple");
  const [qBusy, setQBusy] = useState(false);
  const [qError, setQError] = useState<string | null>(null);

  async function runQuantum() {
    setQBusy(true);
    setQError(null);
    try {
      const payload: Record<string, unknown> = { method, currency };
      for (const f of FIELDS_BY_METHOD[method] ?? []) {
        const raw = values[f.key];
        if (raw !== undefined && raw.trim() !== "") payload[f.key] = Number(raw);
      }
      if (method === "finance_charge") payload["basis"] = basis;
      await api.post(`${base}/forensics/quantum`, payload);
      reload();
    } catch (err) {
      setQError(msg(err, "The calculation could not be run."));
    } finally {
      setQBusy(false);
    }
  }

  /* ------------------------------- disruption form ------------------------------- */

  const [dMethod, setDMethod] = useState("measured_mile");
  const [dTitle, setDTitle] = useState("");
  const [trade, setTrade] = useState("");
  const [unit, setUnit] = useState("");
  const [hourlyRate, setHourlyRate] = useState("");
  const [baselineFrom, setBaselineFrom] = useState("");
  const [baselineTo, setBaselineTo] = useState("");
  const [impactedFrom, setImpactedFrom] = useState("");
  const [impactedTo, setImpactedTo] = useState("");
  const [baseHours, setBaseHours] = useState("");
  const [changePercent, setChangePercent] = useState("");
  const [factors, setFactors] = useState<string[]>([]);
  const [justification, setJustification] = useState("");
  const [dBusy, setDBusy] = useState(false);
  const [dError, setDError] = useState<string | null>(null);
  const [series, setSeries] = useState<SeriesResponse | null>(null);
  const [seriesBusy, setSeriesBusy] = useState(false);

  async function loadSeries() {
    setSeriesBusy(true);
    setDError(null);
    try {
      const params = new URLSearchParams();
      if (trade) params.set("trade", trade);
      if (unit) params.set("unit", unit);
      const res = await api.get<SeriesResponse>(`${base}/forensics/productivity-series?${params}`);
      setSeries(res);
      if (res.suggestedBaseline) {
        setBaselineFrom(res.suggestedBaseline.from);
        setBaselineTo(res.suggestedBaseline.to);
      }
    } catch (err) {
      setDError(msg(err, "The productivity series could not be built."));
    } finally {
      setSeriesBusy(false);
    }
  }

  async function runDisruption() {
    if (dTitle.trim().length === 0) {
      setDError("Give the analysis a title.");
      return;
    }
    setDBusy(true);
    setDError(null);
    try {
      const payload: Record<string, unknown> = {
        method: dMethod,
        title: dTitle.trim(),
        trade: trade || null,
        unit: unit || undefined,
        currency: currency,
        hourlyRate: hourlyRate ? Number(hourlyRate) : null,
      };
      if (dMethod === "measured_mile") {
        payload["baselineFrom"] = baselineFrom;
        payload["baselineTo"] = baselineTo;
        payload["impactedFrom"] = impactedFrom;
        payload["impactedTo"] = impactedTo;
      }
      if (dMethod.startsWith("industry_curve")) {
        payload["baseHours"] = baseHours ? Number(baseHours) : null;
        payload["justification"] = justification;
        if (dMethod === "industry_curve_mcaa") {
          payload["factors"] = factors.map((key) => ({ key, severity: "average" }));
        } else if (changePercent) {
          payload["changePercent"] = Number(changePercent);
        }
      }
      await api.post(`${base}/forensics/disruption`, payload);
      reload();
    } catch (err) {
      setDError(msg(err, "The disruption analysis could not be run."));
    } finally {
      setDBusy(false);
    }
  }

  if (quantum === null) return <Spinner />;

  return (
    <div className="space-y-8">
      <ErrorAlert message={loadError} />

      {/* --------------------------------- quantum --------------------------------- */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Prolongation & overhead quantum
        </h2>
        <Card>
          <CardBody className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <Field label="Formula">
                <Select
                  value={method}
                  onChange={(e) => {
                    setMethod(e.target.value);
                    setValues({});
                  }}
                >
                  {QUANTUM_METHODS.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Currency">
                <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
              </Field>
              {method === "finance_charge" ? (
                <Field label="Interest basis">
                  <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
                    <option value="simple">Simple</option>
                    <option value="compound">Compound (daily)</option>
                  </Select>
                </Field>
              ) : null}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-5">
              {(FIELDS_BY_METHOD[method] ?? []).map((f) => (
                <Field key={f.key} label={f.label}>
                  <Input
                    inputMode="decimal"
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                    placeholder={f.placeholder}
                  />
                </Field>
              ))}
            </div>
            <Button size="sm" disabled={qBusy} onClick={() => void runQuantum()}>
              {qBusy ? "Calculating…" : "Calculate and record"}
            </Button>
            {qError ? <Alert tone="danger" title="The calculation was refused">{qError}</Alert> : null}
          </CardBody>
        </Card>

        {quantum.length === 0 ? (
          <EmptyState
            title="No quantum recorded"
            hint="Each calculation stores its formula, its workings and its assumptions so it can be defended line by line."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {quantum.map((q) => (
              <Card key={q.id}>
                <CardBody className="space-y-1 py-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-ink-900">{q.method.replace(/_/g, " ")}</span>
                    <span className="text-sm font-semibold tabular-nums text-ink-900">
                      {money(q.amount, q.currency)}
                    </span>
                  </div>
                  {q.formula ? <div className="text-xs text-ink-500">{q.formula}</div> : null}
                  {q.workings ? <div className="text-xs text-ink-600">{q.workings}</div> : null}
                  {q.assumptions.length > 0 ? (
                    <ul className="ml-4 list-disc space-y-0.5 text-[11px] text-ink-400">
                      {q.assumptions.map((a) => (
                        <li key={a}>{a}</li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="text-[11px] text-ink-400">{formatDateTime(q.createdAt)}</div>
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* -------------------------------- disruption -------------------------------- */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Disruption</h2>
        <Card>
          <CardBody className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <Field label="Method">
                <Select value={dMethod} onChange={(e) => setDMethod(e.target.value)}>
                  <option value="measured_mile">Measured mile (this project's records)</option>
                  <option value="earned_value">Earned value (planned vs earned hours)</option>
                  <option value="industry_curve_mcaa">MCAA factors</option>
                  <option value="industry_curve_leonard">Leonard curve</option>
                  <option value="industry_curve_ibbs">Ibbs cumulative-impact curve</option>
                </Select>
              </Field>
              <Field label="Title" className="md:col-span-2">
                <Input value={dTitle} onChange={(e) => setDTitle(e.target.value)} placeholder="Steel fixing disruption" />
              </Field>
              <Field label="Labour rate / hour">
                <Input inputMode="decimal" value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)} />
              </Field>
            </div>

            {dMethod === "measured_mile" ? (
              <>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                  <Field label="Trade (timecard trade)">
                    <Input value={trade} onChange={(e) => setTrade(e.target.value)} placeholder="steel_fixing" />
                  </Field>
                  <Field label="Unit (daily-log quantity unit)">
                    <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="t" />
                  </Field>
                  <div className="flex items-end">
                    <Button size="sm" variant="secondary" disabled={seriesBusy} onClick={() => void loadSeries()}>
                      {seriesBusy ? "Building…" : "Build productivity series"}
                    </Button>
                  </div>
                </div>
                {series ? (
                  <div className="space-y-2">
                    <div className="text-xs text-ink-500">
                      {series.points.length} week(s) from {series.sources.timecards} timecard(s) and{" "}
                      {series.sources.dailyLogQuantities} logged quantity entr
                      {series.sources.dailyLogQuantities === 1 ? "y" : "ies"}.
                      {series.suggestedBaseline
                        ? ` Best unimpacted run: ${series.suggestedBaseline.from} → ${series.suggestedBaseline.to} (${series.suggestedBaseline.weeks} weeks).`
                        : ""}
                    </div>
                    {series.reasons.length > 0 ? (
                      <Alert tone="warning" title="What the records do not support">
                        <ul className="ml-4 list-disc space-y-1 text-xs">
                          {series.reasons.map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </ul>
                      </Alert>
                    ) : null}
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Field label="Baseline from">
                    <Input type="date" value={baselineFrom} onChange={(e) => setBaselineFrom(e.target.value)} />
                  </Field>
                  <Field label="Baseline to">
                    <Input type="date" value={baselineTo} onChange={(e) => setBaselineTo(e.target.value)} />
                  </Field>
                  <Field label="Impacted from">
                    <Input type="date" value={impactedFrom} onChange={(e) => setImpactedFrom(e.target.value)} />
                  </Field>
                  <Field label="Impacted to">
                    <Input type="date" value={impactedTo} onChange={(e) => setImpactedTo(e.target.value)} />
                  </Field>
                </div>
              </>
            ) : null}

            {dMethod.startsWith("industry_curve") ? (
              <div className="space-y-3">
                <Alert tone="warning" title="An industry curve is an assertion about other people's projects">
                  A written justification is required, and the platform records it alongside the figure.
                </Alert>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <Field label="Base hours (unimpacted)">
                    <Input inputMode="decimal" value={baseHours} onChange={(e) => setBaseHours(e.target.value)} />
                  </Field>
                  {dMethod !== "industry_curve_mcaa" ? (
                    <Field label="Change orders as % of base">
                      <Input
                        inputMode="decimal"
                        value={changePercent}
                        onChange={(e) => setChangePercent(e.target.value)}
                        placeholder="derived from variations if blank"
                      />
                    </Field>
                  ) : null}
                </div>
                {dMethod === "industry_curve_mcaa" ? (
                  <div className="flex flex-wrap gap-1">
                    {MCAA_KEYS.map((k) => {
                      const on = factors.includes(k);
                      return (
                        <button
                          key={k}
                          type="button"
                          onClick={() =>
                            setFactors((prev) => (on ? prev.filter((x) => x !== k) : [...prev, k]))
                          }
                          className={`rounded-full px-2 py-0.5 text-[11px] ring-1 ${
                            on ? "bg-brand-50 text-brand-700 ring-brand-200" : "bg-ink-50 text-ink-600 ring-ink-100"
                          }`}
                        >
                          {k.replace(/_/g, " ")}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                <Field label="Justification">
                  <Textarea
                    rows={2}
                    value={justification}
                    onChange={(e) => setJustification(e.target.value)}
                    placeholder="Why these published factors describe this project's conditions."
                  />
                </Field>
              </div>
            ) : null}

            <Button size="sm" disabled={dBusy} onClick={() => void runDisruption()}>
              {dBusy ? "Running…" : "Run and record"}
            </Button>
            {dError ? <Alert tone="danger" title="The analysis was refused">{dError}</Alert> : null}
          </CardBody>
        </Card>

        {disruption.length === 0 ? (
          <EmptyState
            title="No disruption analysis"
            hint="A measured mile drawn from this project's own timecards is the strongest evidence available — start there."
          />
        ) : (
          <Card>
            <CardBody className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <Th>Analysis</Th>
                    <Th>Method</Th>
                    <Th align="right">Lost hours</Th>
                    <Th align="right">Amount</Th>
                    <Th>Recorded</Th>
                  </tr>
                </thead>
                <tbody>
                  {disruption.map((d) => (
                    <tr key={d.id} className="border-t border-ink-100 align-top">
                      <td className="px-3 py-2">
                        <div className="text-ink-800">{d.title}</div>
                        {d.trade ? <div className="text-xs text-ink-400">{d.trade}</div> : null}
                        {d.justification ? (
                          <div className="mt-0.5 text-[11px] text-ink-400">{d.justification}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={d.method === "measured_mile" ? "green" : "neutral"}>
                          {d.method.replace(/industry_curve_/, "").replace(/_/g, " ")}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {d.lostHours === null ? <span className="text-ink-400">—</span> : d.lostHours}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(d.amount, d.currency)}</td>
                      <td className="px-3 py-2 text-xs text-ink-500">{formatDateTime(d.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>
        )}
      </section>
    </div>
  );
}
