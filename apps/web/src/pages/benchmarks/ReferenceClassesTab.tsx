/**
 * Reference-class forecasting (#833-838, #846-849).
 *
 * "How much contingency should this project carry?" answered the way Flyvbjerg
 * argues it must be: not from an inside view of this project's own plan, but
 * from what COMPARABLE PROJECTS ACTUALLY DID. A reference class is metric ×
 * asset class × region (× currency for money metrics), and the uplift is the
 * empirical distribution of that class — no fitted curve, no smoothing.
 *
 * What the screen must never let the reader forget, and therefore states next
 * to every figure:
 *   · n and the number of DISTINCT CONTRIBUTORS. With eight samples the answer
 *     moves in eighths, and a p80 drawn from one company is not a benchmark.
 *   · Whether the class is suppressed, and the rule that suppressed it.
 *   · Whether the numbers are illustrative SEED data rather than contributed
 *     outcomes — in which case the uplift is a worked example, not advice.
 */
import { useCallback, useEffect, useState } from "react";
import { PROCUREMENT_ROUTES, SIZE_BANDS } from "@constructos/shared";
import { api } from "../../lib/api";
import {
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
  Table,
  Td,
  Th,
} from "../../ui";
import {
  HealthWarningBanner,
  errorMessage,
  fmtNum,
  label,
  useMetrics,
  useProjects,
} from "./benchmarksShared";

interface ClassRow {
  id: string;
  metric: string;
  assetClass: string;
  region: string;
  currency: string | null;
  contributors: number;
  sampleSize: number;
  describable: boolean;
  reasons: string[];
}

interface ClassesResponse {
  classes: ClassRow[];
  minSampleN: number;
  maxContributorShare: number;
  membership: string;
}

interface Exceedance {
  threshold: number;
  probability: number | null;
}

interface ForecastResponse {
  metric: string;
  unit: string;
  assetClass: string;
  region: string;
  currency: string | null;
  /** the criteria the QUERY applied — never a criterion it did not */
  sizeBand: string | null;
  procurementRoute: string | null;
  requestedSizeBand: string | null;
  requestedProcurementRoute: string | null;
  /** criteria that could not be applied (seed rows carry neither) */
  narrowingDropped: string[];
  contributors: number;
  sampleSize: number;
  p50Uplift: number | null;
  p80Uplift: number | null;
  exceedance: Exceedance[];
  budget: number | null;
  recommended: {
    p50: number;
    p80: number;
    contingencyAtP80: number;
    currency: string | null;
  } | null;
  seedIncluded: boolean;
  disclosures: string[];
}

const GROWTH_METRICS = ["cost_growth_pct", "schedule_growth_pct"];

export default function ReferenceClassesTab() {
  const { metrics } = useMetrics();
  const { projects } = useProjects();

  const [classes, setClasses] = useState<ClassesResponse | null>(null);
  const [classesError, setClassesError] = useState<string | null>(null);

  const [metric, setMetric] = useState("cost_growth_pct");
  const [assetClass, setAssetClass] = useState("commercial");
  const [region, setRegion] = useState("GB");
  const [budget, setBudget] = useState("");
  const [currency, setCurrency] = useState("");
  /*
   * Narrowing the class (#833-838). These are applied to the QUERY and then
   * published with the figure; a criterion the query could not apply is
   * reported as dropped rather than asserted, which is why the answer shows
   * what it was actually drawn from rather than echoing the form.
   */
  const [sizeBand, setSizeBand] = useState("");
  const [procurementRoute, setProcurementRoute] = useState("");
  const [forecast, setForecast] = useState<ForecastResponse | null>(null);
  const [forecastError, setForecastError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const [projectId, setProjectId] = useState("");
  const [storeNote, setStoreNote] = useState<string | null>(null);
  const [storing, setStoring] = useState(false);

  const loadClasses = useCallback(async () => {
    setClassesError(null);
    try {
      setClasses(await api.get<ClassesResponse>("/api/v1/benchmarks/reference-classes"));
    } catch (err) {
      setClassesError(errorMessage(err, "Failed to load reference classes"));
    }
  }, []);

  useEffect(() => {
    void loadClasses();
  }, [loadClasses]);

  const assetClasses = [
    ...new Set([
      "commercial",
      "residential",
      "hospital",
      "school",
      "road",
      "rail",
      "water",
      "energy",
      ...(classes?.classes.map((c) => c.assetClass) ?? []),
    ]),
  ];

  async function onForecast() {
    setRunning(true);
    setForecastError(null);
    setStoreNote(null);
    try {
      const params = new URLSearchParams({ metric, assetClass, region });
      if (budget.trim() !== "") params.set("budget", budget.trim());
      if (currency.trim() !== "") params.set("currency", currency.trim().toUpperCase());
      if (sizeBand) params.set("sizeBand", sizeBand);
      if (procurementRoute) params.set("procurementRoute", procurementRoute);
      setForecast(
        await api.get<ForecastResponse>(
          `/api/v1/benchmarks/reference-classes/forecast?${params.toString()}`,
        ),
      );
    } catch (err) {
      setForecast(null);
      setForecastError(errorMessage(err, "The forecast could not be computed"));
    } finally {
      setRunning(false);
    }
  }

  async function onStore() {
    if (!projectId) return;
    setStoring(true);
    setStoreNote(null);
    try {
      const body: Record<string, unknown> = { metric, assetClass, region };
      if (budget.trim() !== "") body["budget"] = Number(budget.trim());
      if (currency.trim() !== "") body["currency"] = currency.trim().toUpperCase();
      if (sizeBand) body["sizeBand"] = sizeBand;
      if (procurementRoute) body["procurementRoute"] = procurementRoute;
      await api.post(`/api/v1/projects/${projectId}/benchmarks/rcf`, body);
      setStoreNote(
        "Stored against the project. The uplift a contingency decision cites can now be produced " +
          "again later, with the class it was drawn from.",
      );
    } catch (err) {
      setStoreNote(errorMessage(err, "The forecast could not be stored"));
    } finally {
      setStoring(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-ink-900">Reference-class forecast</h2>
            <p className="text-xs text-ink-400">
              What comparable projects actually did — the outside view, rather than this project's
              own optimism.
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-5">
            <Field label="Metric">
              <Select value={metric} onChange={(e) => setMetric(e.target.value)}>
                {(metrics ?? [])
                  .filter((m) => GROWTH_METRICS.includes(m.key))
                  .map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.name}
                    </option>
                  ))}
                {metrics === null
                  ? GROWTH_METRICS.map((k) => (
                      <option key={k} value={k}>
                        {label(k)}
                      </option>
                    ))
                  : null}
              </Select>
            </Field>
            <Field label="Asset class">
              <Select value={assetClass} onChange={(e) => setAssetClass(e.target.value)}>
                {assetClasses.map((a) => (
                  <option key={a} value={a}>
                    {label(a)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Region" hint="ISO country, or a declared region key">
              <Input value={region} onChange={(e) => setRegion(e.target.value)} maxLength={40} />
            </Field>
            <Field label="Budget" hint="Optional — turns the uplift into money">
              <Input
                type="number"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                placeholder="10000000"
              />
            </Field>
            <Field label="Currency" hint="ISO 4217">
              <Input
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                maxLength={3}
                placeholder="GBP"
              />
            </Field>
            <Field label="Size band" hint="Narrows the class, and is published with it">
              <Select value={sizeBand} onChange={(e) => setSizeBand(e.target.value)}>
                <option value="">Any size</option>
                {SIZE_BANDS.map((b) => (
                  <option key={b} value={b}>
                    {label(b)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Procurement route" hint="Narrows the class, and is published with it">
              <Select
                value={procurementRoute}
                onChange={(e) => setProcurementRoute(e.target.value)}
              >
                <option value="">Any route</option>
                {PROCUREMENT_ROUTES.map((r) => (
                  <option key={r} value={r}>
                    {label(r)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <p className="text-xs text-ink-400">
            A narrowing is applied to the query and published with the figure. Narrowing a thin
            class usually suppresses it — which is the honest answer, and the reason the sample
            size and contributor count sit next to every number below.
          </p>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void onForecast()} disabled={running}>
              {running ? "Computing…" : "Forecast"}
            </Button>
          </div>

          <ErrorAlert message={forecastError} />

          {forecast ? (
            <div className="space-y-3">
              <HealthWarningBanner
                warning={
                  forecast.seedIncluded
                    ? "These are illustrative seed samples, not contributed outcomes. Treat the uplift as a worked example, not a recommendation."
                    : null
                }
              />

              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
                <Badge tone={forecast.sampleSize === 0 ? "gray" : "blue"}>
                  n = {forecast.sampleSize}
                </Badge>
                <Badge tone="gray">{forecast.contributors} contributor(s)</Badge>
                <span>
                  {label(forecast.assetClass)} · {forecast.region}
                  {forecast.currency ? ` · ${forecast.currency}` : ""}
                  {forecast.sizeBand ? ` · ${label(forecast.sizeBand)}` : ""}
                  {forecast.procurementRoute ? ` · ${label(forecast.procurementRoute)}` : ""}
                </span>
              </div>

              {forecast.narrowingDropped.length > 0 ? (
                <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  The {forecast.narrowingDropped.join(" and ")} you asked for was NOT applied —
                  illustrative seed samples carry neither, so this figure describes the whole
                  class. It is not recorded as a membership criterion of anything stored from
                  here.
                </div>
              ) : null}

              {forecast.sampleSize === 0 ? (
                <EmptyState
                  title="Nothing describable in this class"
                  hint="The class is suppressed or empty. The disclosures below name the rule that applies."
                />
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Stat
                      label="P50 uplift"
                      value={forecast.p50Uplift === null ? "—" : `${fmtNum(forecast.p50Uplift, 1)}%`}
                    />
                    <Stat
                      label="P80 uplift"
                      value={forecast.p80Uplift === null ? "—" : `${fmtNum(forecast.p80Uplift, 1)}%`}
                    />
                    <Stat
                      label="Contingency at P80"
                      value={
                        forecast.recommended
                          ? `${fmtNum(forecast.recommended.contingencyAtP80, 0)} ${
                              forecast.recommended.currency ?? ""
                            }`
                          : "—"
                      }
                      hint={forecast.recommended ? undefined : "Give a budget to see this in money"}
                    />
                  </div>

                  <Table>
                    <thead>
                      <tr>
                        <Th>Exceedance</Th>
                        <Th className="text-right">Probability</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {forecast.exceedance.map((e) => (
                        <tr key={e.threshold}>
                          <Td>Growth greater than {e.threshold}%</Td>
                          <Td className="text-right tabular-nums">
                            {e.probability === null
                              ? "—"
                              : `${fmtNum(e.probability * 100, 0)}%`}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </>
              )}

              <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-ink-500">
                {forecast.disclosures.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>

              <div className="flex flex-wrap items-end gap-2 border-t border-ink-100 pt-3">
                <Field label="Store against project">
                  <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                    <option value="">Select a project…</option>
                    {(projects ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button
                  variant="secondary"
                  onClick={() => void onStore()}
                  disabled={!projectId || storing || forecast.sampleSize === 0}
                >
                  {storing ? "Storing…" : "Freeze forecast"}
                </Button>
              </div>
              {storeNote ? <p className="text-xs text-ink-600">{storeNote}</p> : null}
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <div>
            <h2 className="text-base font-semibold text-ink-900">Classes with contributed data</h2>
            <p className="text-xs text-ink-400">
              {classes?.membership ??
                "A reference class is metric × asset class × region (× currency for money metrics)."}
            </p>
          </div>
          <ErrorAlert message={classesError} />
          {classes === null ? (
            <Spinner label="Loading classes…" />
          ) : classes.classes.length === 0 ? (
            <EmptyState
              title="No contributed classes yet"
              hint="Contribute a snapshot from the Snapshots tab; a class becomes describable once enough distinct companies have contributed to it."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Metric</Th>
                  <Th>Asset class</Th>
                  <Th>Region</Th>
                  <Th>Currency</Th>
                  <Th className="text-right">Contributors</Th>
                  <Th className="text-right">Samples</Th>
                  <Th>Describable</Th>
                </tr>
              </thead>
              <tbody>
                {classes.classes.map((c) => (
                  <tr key={c.id}>
                    <Td>{label(c.metric)}</Td>
                    <Td>{label(c.assetClass)}</Td>
                    <Td>{c.region}</Td>
                    <Td>{c.currency ?? <span className="text-ink-300">—</span>}</Td>
                    <Td className="text-right tabular-nums">{c.contributors}</Td>
                    <Td className="text-right tabular-nums">{c.sampleSize}</Td>
                    <Td>
                      {c.describable ? (
                        <Badge tone="green">yes</Badge>
                      ) : (
                        <span
                          className="text-xs text-amber-800"
                          title={c.reasons.join(" ")}
                        >
                          suppressed
                        </span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {classes ? (
            <p className="text-xs text-ink-400">
              A cell is described only when at least {classes.minSampleN} distinct companies have
              contributed to it and no single contributor holds{" "}
              {Math.round(classes.maxContributorShare * 100)}% or more of it. Your own samples are
              excluded from the figures you are compared with.
            </p>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}

function Stat({ label: text, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-ink-100 px-3 py-2">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-400">{text}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums text-ink-900">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-ink-400">{hint}</div> : null}
    </div>
  );
}
