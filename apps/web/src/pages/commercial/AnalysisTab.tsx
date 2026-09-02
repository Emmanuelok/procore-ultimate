/**
 * Rates & fluctuations tab (spec Vol II Domain B #145-149, #171, #178).
 *
 * Three panels: the rate analyser (build-up composition plus a benchmark
 * verdict drawn from the tenant's own priced history), the star-rate register
 * (every variation line priced on a basis other than the BQ rates), and the
 * indexed price-adjustment calculator with its published index series.
 *
 * The benchmark verdict is honest about ignorance: with fewer than three
 * comparable rates it says `no benchmark` and explains why, rather than
 * inventing a market price.
 */
import { useCallback, useEffect, useState } from "react";
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
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import {
  flattenBoqItems,
  money,
  parseNum,
  percent,
  qty,
  verdictTone,
  type BoqDetail,
  type BoqRow,
  type FlatBoqItem,
  type FluctuationCalcRow,
  type IndexSeriesRow,
  type ListResponse,
  type RateAnalysis,
} from "./commercialShared";

interface StarRateRow {
  id: string;
  variationId: string;
  variationNumber: number | null;
  variationTitle: string | null;
  description: string;
  unit: string | null;
  qty: number;
  rate: number;
  amount: number;
  basis: string;
  currency: string;
}

export default function AnalysisTab({
  projectId,
  boqs,
  currency,
}: {
  projectId: string;
  boqs: BoqRow[] | null;
  currency: string;
}) {
  return (
    <div className="space-y-8">
      <RatePanel boqs={boqs} />
      <StarRatePanel projectId={projectId} />
      <FluctuationPanel projectId={projectId} currency={currency} />
    </div>
  );
}

/* ------------------------------- Rate analysis ----------------------------- */

function RatePanel({ boqs }: { boqs: BoqRow[] | null }) {
  const [boqId, setBoqId] = useState("");
  const [items, setItems] = useState<FlatBoqItem[]>([]);
  const [itemId, setItemId] = useState("");
  const [analysis, setAnalysis] = useState<RateAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!boqId && boqs?.[0]) setBoqId(boqs[0].id);
  }, [boqs, boqId]);

  useEffect(() => {
    if (!boqId) return;
    api
      .get<BoqDetail>(`/api/v1/boqs/${boqId}`)
      .then((d) => setItems(flattenBoqItems(d.items).filter((i) => i.level === "item")))
      .catch(() => setItems([]));
  }, [boqId]);

  useEffect(() => {
    if (!itemId) {
      setAnalysis(null);
      return;
    }
    setLoading(true);
    setError(null);
    api
      .get<RateAnalysis>(`/api/v1/boq-items/${itemId}/rate-analysis`)
      .then(setAnalysis)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Failed to analyse the rate"),
      )
      .finally(() => setLoading(false));
  }, [itemId]);

  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold text-ink-900">Rate build-up analysis</h2>
      <p className="mb-3 text-xs text-ink-500">
        What the rate is made of, and how it compares with the company&rsquo;s own priced history for
        the same unit and work.
      </p>
      <ErrorAlert message={error} />

      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Bill">
          <Select value={boqId} onChange={(e) => setBoqId(e.target.value)}>
            {(boqs ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Item">
          <Select value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">— choose an item —</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.code} · {i.description.slice(0, 70)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {loading ? <Spinner /> : null}

      {analysis ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardBody>
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-sm font-semibold text-ink-900">Build-up</h3>
                <span className="text-lg font-semibold tabular-nums">
                  {money(analysis.rate, analysis.currency)}
                  {analysis.unit ? (
                    <span className="text-xs text-ink-400"> / {analysis.unit}</span>
                  ) : null}
                </span>
              </div>
              {Object.keys(analysis.buildUp.split).length === 0 ? (
                <p className="text-sm text-ink-500">
                  No build-up is recorded for this item — the rate has no audit trail.
                </p>
              ) : (
                <>
                  <div className="mb-3 flex h-3 w-full overflow-hidden rounded-full bg-ink-100">
                    {Object.entries(analysis.buildUp.splitPercent).map(([kind, pct]) => (
                      <div
                        key={kind}
                        title={`${humanize(kind)} ${pct}%`}
                        className={
                          kind === "labour"
                            ? "bg-brand-500"
                            : kind === "material"
                              ? "bg-emerald-500"
                              : kind === "plant"
                                ? "bg-amber-500"
                                : kind === "overhead"
                                  ? "bg-violet-500"
                                  : "bg-ink-400"
                        }
                        style={{ width: `${pct}%` }}
                      />
                    ))}
                  </div>
                  <dl className="space-y-1 text-sm">
                    {Object.entries(analysis.buildUp.split).map(([kind, amount]) => (
                      <div key={kind} className="flex justify-between">
                        <dt className="text-ink-600">{humanize(kind)}</dt>
                        <dd className="tabular-nums">
                          {money(amount, analysis.currency)}{" "}
                          <span className="text-xs text-ink-400">
                            {percent(analysis.buildUp.splitPercent[kind], 0)}
                          </span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </>
              )}
              {!analysis.buildUp.reconciles ? (
                <div className="mt-3 rounded-md bg-red-50 p-2 text-xs text-red-800 ring-1 ring-red-100">
                  The build-up totals {money(analysis.buildUp.total, analysis.currency)} but the item
                  rate is {money(analysis.rate, analysis.currency)} — a difference of{" "}
                  {money(analysis.buildUp.difference, analysis.currency)}.
                </div>
              ) : null}
              {analysis.buildUp.observations.length > 0 ? (
                <ul className="mt-3 space-y-1 text-xs text-ink-500">
                  {analysis.buildUp.observations.map((o) => (
                    <li key={o}>• {o}</li>
                  ))}
                </ul>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-ink-900">Benchmark</h3>
                <Badge tone={verdictTone(analysis.benchmark.verdict)}>
                  {humanize(analysis.benchmark.verdict)}
                </Badge>
              </div>
              <p className="text-sm text-ink-600">{analysis.benchmark.basis}</p>
              {analysis.benchmark.median != null ? (
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-ink-400">P25</div>
                    <div className="tabular-nums">
                      {money(analysis.benchmark.p25, analysis.currency)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-ink-400">Median</div>
                    <div className="font-semibold tabular-nums">
                      {money(analysis.benchmark.median, analysis.currency)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-ink-400">P75</div>
                    <div className="tabular-nums">
                      {money(analysis.benchmark.p75, analysis.currency)}
                    </div>
                  </div>
                </div>
              ) : null}
              {analysis.benchmark.samples.length > 0 ? (
                <div className="mt-3 max-h-48 overflow-y-auto rounded-md bg-ink-50 p-2">
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
                    Comparison set ({analysis.benchmark.sampleSize})
                  </div>
                  <ul className="space-y-1 text-xs text-ink-600">
                    {analysis.benchmark.samples.map((s, i) => (
                      <li key={`${s.label}-${i}`} className="flex justify-between gap-3">
                        <span className="truncate">{s.label}</span>
                        <span className="shrink-0 tabular-nums">{money(s.rate, s.currency)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardBody>
          </Card>
        </div>
      ) : null}
    </section>
  );
}

/* -------------------------------- Star rates ------------------------------- */

function StarRatePanel({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<StarRateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<ListResponse<StarRateRow>>(
        `/api/v1/projects/${projectId}/commercial/star-rates?pageSize=200`,
      )
      .then((r) => setRows(r.items))
      .catch((err: unknown) => {
        setRows([]);
        setError(err instanceof Error ? err.message : "Failed to load star rates");
      });
  }, [projectId]);

  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold text-ink-900">Star-rate register</h2>
      <p className="mb-3 text-xs text-ink-500">
        Every variation line priced on a basis other than the bill rates — the rates that have to be
        defended.
      </p>
      <ErrorAlert message={error} />
      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No star rates yet"
          hint="Value a variation on a star_rate, pro_rata or daywork basis and its build-up lines appear here."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Variation</Th>
              <Th>Description</Th>
              <Th>Basis</Th>
              <Th className="text-right">Qty</Th>
              <Th className="text-right">Rate</Th>
              <Th className="text-right">Amount</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-ink-50/60">
                <Td className="whitespace-nowrap text-xs">
                  <span className="font-mono font-medium">
                    VO-{String(r.variationNumber ?? 0).padStart(3, "0")}
                  </span>
                  <span className="block max-w-[16rem] truncate text-ink-500">
                    {r.variationTitle ?? ""}
                  </span>
                </Td>
                <Td className="max-w-md truncate">{r.description}</Td>
                <Td>
                  <Badge tone={r.basis === "star_rate" ? "violet" : "blue"}>
                    {humanize(r.basis)}
                  </Badge>
                </Td>
                <Td className="text-right tabular-nums">
                  {qty(r.qty)} {r.unit ?? ""}
                </Td>
                <Td className="text-right tabular-nums">{money(r.rate, r.currency)}</Td>
                <Td className="text-right font-medium tabular-nums">
                  {money(r.amount, r.currency)}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

/* ------------------------------- Fluctuations ------------------------------ */

interface FluctuationResult {
  ok: boolean;
  factor: number | null;
  adjustment: number | null;
  explanation: string;
  reasons: string[];
  currency: string;
  components: Array<{
    seriesCode: string;
    label: string;
    weighting: number;
    basePeriod: string;
    baseIndex: number | null;
    currentPeriod: string;
    currentIndex: number | null;
    ratio: number | null;
    reason: string | null;
  }>;
}

function FluctuationPanel({ projectId, currency }: { projectId: string; currency: string }) {
  const [series, setSeries] = useState<IndexSeriesRow[]>([]);
  const [history, setHistory] = useState<FluctuationCalcRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [basePeriod, setBasePeriod] = useState("");
  const [currentPeriod, setCurrentPeriod] = useState("");
  const [nonAdjustable, setNonAdjustable] = useState("0.2");
  const [workDone, setWorkDone] = useState("");
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [result, setResult] = useState<FluctuationResult | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([
        api.get<{ items: IndexSeriesRow[] }>(`/api/v1/commercial/index-series`),
        api.get<ListResponse<FluctuationCalcRow>>(
          `/api/v1/projects/${projectId}/commercial/fluctuations?pageSize=50`,
        ),
      ]);
      setSeries(s.items);
      setHistory(h.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load index series");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function compute(persist: boolean) {
    setError(null);
    setBusy(true);
    try {
      const components = Object.entries(weights)
        .map(([seriesCode, w]) => ({ seriesCode, weighting: parseNum(w) ?? 0 }))
        .filter((c) => c.weighting > 0);
      const res = await api.post<FluctuationResult & { calculationId: string | null }>(
        `/api/v1/projects/${projectId}/commercial/fluctuations`,
        {
          formula: "fidic_13_8",
          basePeriod,
          currentPeriod,
          nonAdjustable: parseNum(nonAdjustable) ?? 0,
          components,
          workDoneAmount: parseNum(workDone) ?? 0,
          persist,
        },
      );
      setResult(res);
      if (persist) await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to compute the adjustment");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold text-ink-900">Price adjustment (fluctuations)</h2>
      <p className="mb-3 text-xs text-ink-500">
        Pn = a + b(Ln/Lo) + c(En/Eo) + … Every index used is shown with its period, so the
        adjustment can be recomputed from its own record.
      </p>
      <ErrorAlert message={error} />

      {series.length === 0 ? (
        <EmptyState
          title="No index series recorded"
          hint="A company owner or admin adds published index series before an adjustment can be computed."
        />
      ) : (
        <Card>
          <CardBody>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Field label="Base period">
                <Input
                  placeholder="2025-01"
                  value={basePeriod}
                  onChange={(e) => setBasePeriod(e.target.value)}
                />
              </Field>
              <Field label="Current period">
                <Input
                  placeholder="2026-01"
                  value={currentPeriod}
                  onChange={(e) => setCurrentPeriod(e.target.value)}
                />
              </Field>
              <Field label="Non-adjustable (a)">
                <Input
                  value={nonAdjustable}
                  inputMode="decimal"
                  onChange={(e) => setNonAdjustable(e.target.value)}
                />
              </Field>
              <Field label="Work done">
                <Input
                  value={workDone}
                  inputMode="decimal"
                  onChange={(e) => setWorkDone(e.target.value)}
                />
              </Field>
            </div>

            <div className="mt-3">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-400">
                Weightings (must total 1 with the non-adjustable element)
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {series.map((s) => (
                  <Field key={s.id} label={`${s.code} — ${s.name}`}>
                    <Input
                      value={weights[s.code] ?? ""}
                      inputMode="decimal"
                      placeholder="0.0"
                      onChange={(e) =>
                        setWeights((w) => ({ ...w, [s.code]: e.target.value }))
                      }
                    />
                  </Field>
                ))}
              </div>
            </div>

            <div className="mt-3 flex justify-end gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => void compute(false)}>
                Compute
              </Button>
              <Button disabled={busy || !result?.ok} onClick={() => void compute(true)}>
                Record as evidence
              </Button>
            </div>

            {result ? (
              <div
                className={`mt-3 rounded-md p-3 text-sm ring-1 ${
                  result.ok
                    ? "bg-emerald-50 text-emerald-900 ring-emerald-100"
                    : "bg-amber-50 text-amber-900 ring-amber-100"
                }`}
              >
                <div className="font-medium">
                  {result.ok
                    ? `Adjustment ${money(result.adjustment, result.currency || currency)} (factor ${result.factor})`
                    : "Not computed"}
                </div>
                <p className="mt-1 text-xs">{result.explanation}</p>
                {result.components.length > 0 ? (
                  <ul className="mt-2 space-y-0.5 text-xs">
                    {result.components.map((c) => (
                      <li key={c.seriesCode}>
                        {c.label}: {c.baseIndex ?? "—"} ({c.basePeriod}) →{" "}
                        {c.currentIndex ?? "—"} ({c.currentPeriod}) × {c.weighting}
                        {c.reason ? ` — ${c.reason}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </CardBody>
        </Card>
      )}

      {history.length > 0 ? (
        <div className="mt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
            Recorded adjustments
          </h3>
          <Table>
            <thead>
              <tr>
                <Th>Computed</Th>
                <Th>Formula</Th>
                <Th>Base → current</Th>
                <Th className="text-right">Work done</Th>
                <Th className="text-right">Factor</Th>
                <Th className="text-right">Adjustment</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {history.map((h) => (
                <tr key={h.id}>
                  <Td className="whitespace-nowrap">{formatDate(h.createdAt)}</Td>
                  <Td>{humanize(h.formula)}</Td>
                  <Td className="whitespace-nowrap">
                    {h.baseDate} → {h.currentPeriod}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {money(h.workDoneAmount, h.currency)}
                  </Td>
                  <Td className="text-right tabular-nums">{h.factor}</Td>
                  <Td className="text-right font-medium tabular-nums">
                    {money(h.adjustment, h.currency)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : null}
    </section>
  );
}
