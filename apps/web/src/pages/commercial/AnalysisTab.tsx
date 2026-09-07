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
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api, ApiClientError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
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
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
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
  type FluctuationFormulaInfo,
  type IndexSeriesRow,
  type ListResponse,
  type RateAnalysis,
  type RateBenchmarkRow,
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

export interface BenchmarkSeed {
  description: string;
  unit: string;
  rate: number;
  currency: string;
  code?: string | null;
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
  const [seed, setSeed] = useState<BenchmarkSeed | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [libraryVersion, setLibraryVersion] = useState(0);

  return (
    <div className="space-y-8">
      <RatePanel
        boqs={boqs}
        onAddBenchmark={(s) => {
          setSeed(s);
          setAddOpen(true);
        }}
      />
      <BenchmarkPanel
        version={libraryVersion}
        onAdd={() => {
          setSeed(null);
          setAddOpen(true);
        }}
      />
      <StarRatePanel projectId={projectId} />
      <IndexSeriesPanel />
      <FluctuationPanel projectId={projectId} currency={currency} />
      <AddBenchmarkModal
        open={addOpen}
        seed={seed}
        onClose={() => setAddOpen(false)}
        onSaved={() => {
          setAddOpen(false);
          setLibraryVersion((v) => v + 1);
        }}
      />
    </div>
  );
}

/* ------------------------------- Rate analysis ----------------------------- */

function RatePanel({
  boqs,
  onAddBenchmark,
}: {
  boqs: BoqRow[] | null;
  onAddBenchmark: (seed: BenchmarkSeed) => void;
}) {
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
              {analysis.rate != null && analysis.unit ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  onClick={() =>
                    onAddBenchmark({
                      description: analysis.description,
                      unit: analysis.unit ?? "",
                      rate: analysis.rate ?? 0,
                      currency: analysis.currency,
                      code: analysis.code,
                    })
                  }
                >
                  Add a benchmark for this work
                </Button>
              ) : null}
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

/* --------------------------- Benchmark library ----------------------------- */

/**
 * The comparison set the rate analyser draws on. Without a way to populate it
 * the analyser could only ever compare against the company's own priced bills,
 * so a first project got `no_benchmark` for every rate it holds.
 */
function BenchmarkPanel({ version, onAdd }: { version: number; onAdd: () => void }) {
  const { company } = useAuth();
  const canEdit = company?.role === "owner" || company?.role === "admin";
  const [rows, setRows] = useState<RateBenchmarkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    const q = new URLSearchParams({ pageSize: "100" });
    if (search.trim()) q.set("search", search.trim());
    api
      .get<ListResponse<RateBenchmarkRow>>(`/api/v1/commercial/rate-benchmarks?${q.toString()}`)
      .then((r) => {
        setRows(r.items);
        setError(null);
      })
      .catch((err: unknown) => {
        setRows([]);
        setError(err instanceof Error ? err.message : "Failed to load the benchmark library");
      });
  }, [version, search]);

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">Benchmark library</h2>
          <p className="mt-0.5 text-xs text-ink-500">
            Published or negotiated rates the analyser compares against, alongside the
            company&rsquo;s own priced history.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <Input
            className="w-48"
            placeholder="Search descriptions"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {canEdit ? (
            <Button size="sm" onClick={onAdd}>
              Add benchmark
            </Button>
          ) : null}
        </div>
      </div>
      <ErrorAlert message={error} />
      {!canEdit ? (
        <p className="mb-2 text-xs text-ink-400">
          Only a company owner or admin can maintain the benchmark library.
        </p>
      ) : null}
      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No benchmark rates recorded"
          hint="Add rates from a price book or a negotiated schedule; until then the analyser compares only against your own bills."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Description</Th>
              <Th>Unit</Th>
              <Th>Source</Th>
              <Th>Region</Th>
              <Th>As of</Th>
              <Th className="text-right">Rate</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((b) => (
              <tr key={b.id}>
                <Td className="whitespace-nowrap font-mono text-xs">{b.code ?? "—"}</Td>
                <Td className="max-w-md truncate">{b.description}</Td>
                <Td>{b.unit}</Td>
                <Td>
                  <Badge tone="slate">{humanize(b.source)}</Badge>
                </Td>
                <Td className="text-xs text-ink-500">{b.region ?? "—"}</Td>
                <Td className="whitespace-nowrap text-xs text-ink-500">
                  {b.asOfDate ? formatDate(b.asOfDate) : "—"}
                </Td>
                <Td className="text-right font-medium tabular-nums">
                  {money(b.rate, b.currency)}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

function AddBenchmarkModal({
  open,
  seed,
  onClose,
  onSaved,
}: {
  open: boolean;
  seed: BenchmarkSeed | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [description, setDescription] = useState("");
  const [code, setCode] = useState("");
  const [unit, setUnit] = useState("");
  const [rate, setRate] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [region, setRegion] = useState("");
  const [asOfDate, setAsOfDate] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setDescription(seed?.description ?? "");
    setCode(seed?.code ?? "");
    setUnit(seed?.unit ?? "");
    setRate(seed?.rate != null ? String(seed.rate) : "");
    setCurrency(seed?.currency ?? "USD");
    setRegion("");
    setAsOfDate("");
    setNotes("");
  }, [open, seed]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = parseNum(rate);
    if (typeof value !== "number" || value <= 0) {
      setError("Enter the benchmark rate.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/v1/commercial/rate-benchmarks`, {
        description,
        unit,
        rate: value,
        currency,
        ...(code.trim() ? { code: code.trim() } : {}),
        ...(region.trim() ? { region: region.trim() } : {}),
        ...(asOfDate ? { asOfDate } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      toast.success("Benchmark added");
      onSaved();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to add the benchmark");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="Add a benchmark rate" onClose={onClose}>
      <ErrorAlert message={error} />
      <form onSubmit={submit} className="space-y-4">
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Code">
            <Input value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Field label="Unit">
            <Input value={unit} onChange={(e) => setUnit(e.target.value)} />
          </Field>
          <Field label="Rate">
            <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Currency">
            <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </Field>
          <Field label="Region">
            <Input value={region} onChange={(e) => setRegion(e.target.value)} />
          </Field>
          <Field label="As of">
            <Input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Notes" hint="Where the rate came from — the analyser shows it as the basis.">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !description.trim() || !unit.trim()}>
            {busy ? "Saving…" : "Add benchmark"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------ Index series ------------------------------- */

/**
 * Published index series (BCIS, CPI, a bulletin) are the raw material of every
 * price-adjustment formula. Until this panel existed the API accepted them and
 * nothing in the product could create one, so fluctuations were unreachable on
 * a fresh tenant.
 */
function IndexSeriesPanel() {
  const { company } = useAuth();
  const canEdit = company?.role === "owner" || company?.role === "admin";
  const [series, setSeries] = useState<IndexSeriesRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<IndexSeriesRow | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ items: IndexSeriesRow[] }>(`/api/v1/commercial/index-series`);
      setSeries(res.items);
      setError(null);
    } catch (err) {
      setSeries([]);
      setError(err instanceof Error ? err.message : "Failed to load index series");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">Index series</h2>
          <p className="mt-0.5 text-xs text-ink-500">
            The published indices the adjustment formulae read. Every value is stored with its
            month so an adjustment can be recomputed from its own record.
          </p>
        </div>
        {canEdit ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            Add series
          </Button>
        ) : null}
      </div>
      <ErrorAlert message={error} />
      {!canEdit ? (
        <p className="mb-2 text-xs text-ink-400">
          Only a company owner or admin can maintain index series.
        </p>
      ) : null}
      {series === null ? (
        <Spinner />
      ) : series.length === 0 ? (
        <EmptyState
          title="No index series recorded"
          hint="Add the series named in the Table of Adjustment Data before computing an adjustment."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Name</Th>
              <Th>Source</Th>
              <Th>Country</Th>
              <Th className="text-right">Points</Th>
              <Th>Range</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {series.map((s) => {
              const first = s.values[0];
              const last = s.values[s.values.length - 1];
              return (
                <tr key={s.id}>
                  <Td className="font-mono text-xs font-medium">{s.code}</Td>
                  <Td className="max-w-sm truncate">{s.name}</Td>
                  <Td className="text-xs text-ink-500">{s.source ?? "—"}</Td>
                  <Td className="text-xs text-ink-500">{s.country ?? "—"}</Td>
                  <Td className="text-right tabular-nums">{s.values.length}</Td>
                  <Td className="whitespace-nowrap text-xs text-ink-500">
                    {first && last ? `${first.period} → ${last.period}` : "— none —"}
                  </Td>
                  <Td className="text-right">
                    {canEdit ? (
                      <Button size="sm" variant="secondary" onClick={() => setEditing(s)}>
                        Add values
                      </Button>
                    ) : null}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <CreateSeriesModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          setCreateOpen(false);
          void load();
        }}
      />
      <SeriesValuesModal
        series={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
    </section>
  );
}

/** Parse "2025-01 118.4" / "2025-01,118.4" lines into index points. */
function parseSeriesValues(raw: string): {
  values: Array<{ period: string; value: number }>;
  errors: string[];
} {
  const values: Array<{ period: string; value: number }> = [];
  const errors: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/[\s,;\t]+/).filter(Boolean);
    const period = parts[0] ?? "";
    const value = Number(parts[1]);
    if (!/^\d{4}-\d{2}$/.test(period)) {
      errors.push(`"${trimmed}" — the period must be YYYY-MM.`);
      continue;
    }
    if (!Number.isFinite(value) || value <= 0) {
      errors.push(`"${trimmed}" — the index value must be a positive number.`);
      continue;
    }
    values.push({ period, value });
  }
  return { values, errors };
}

function CreateSeriesModal({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [country, setCountry] = useState("");
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCode("");
    setName("");
    setSource("");
    setCountry("");
    setRaw("");
    setError(null);
  }, [open]);

  const parsed = parseSeriesValues(raw);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (parsed.errors.length > 0) {
      setError(parsed.errors.join(" "));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/v1/commercial/index-series`, {
        code: code.trim(),
        name: name.trim(),
        ...(source.trim() ? { source: source.trim() } : {}),
        ...(country.trim() ? { country: country.trim() } : {}),
        ...(parsed.values.length > 0 ? { values: parsed.values } : {}),
      });
      toast.success("Index series added");
      onSaved();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to add the series");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="Add an index series" onClose={onClose}>
      <ErrorAlert message={error} />
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code" hint="Used in the Table of Adjustment Data, e.g. LAB.">
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </Field>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Source" hint="Who publishes it.">
            <Input value={source} onChange={(e) => setSource(e.target.value)} />
          </Field>
          <Field label="Country">
            <Input value={country} onChange={(e) => setCountry(e.target.value)} />
          </Field>
        </div>
        <Field
          label="Index values"
          hint="One per line: YYYY-MM value (e.g. 2025-01 118.4). Optional — values can be added later."
        >
          <Textarea rows={6} value={raw} onChange={(e) => setRaw(e.target.value)} />
        </Field>
        {parsed.errors.length > 0 ? (
          <ul className="space-y-0.5 text-xs text-red-700">
            {parsed.errors.slice(0, 5).map((m) => (
              <li key={m}>• {m}</li>
            ))}
          </ul>
        ) : parsed.values.length > 0 ? (
          <p className="text-xs text-ink-500">{parsed.values.length} index points understood.</p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !code.trim() || !name.trim()}>
            {busy ? "Saving…" : "Add series"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SeriesValuesModal({
  series,
  onClose,
  onSaved,
}: {
  series: IndexSeriesRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRaw("");
    setError(null);
  }, [series]);

  const parsed = parseSeriesValues(raw);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!series) return;
    if (parsed.values.length === 0) {
      setError("Enter at least one index point.");
      return;
    }
    if (parsed.errors.length > 0) {
      setError(parsed.errors.join(" "));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/v1/commercial/index-series/${series.id}/values`, {
        values: parsed.values,
      });
      toast.success("Index values recorded");
      onSaved();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to record the values");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={series !== null}
      title={series ? `Index values — ${series.code}` : "Index values"}
      onClose={onClose}
    >
      <ErrorAlert message={error} />
      <form onSubmit={submit} className="space-y-4">
        <Field
          label="Index values"
          hint="One per line: YYYY-MM value. An existing month is overwritten."
        >
          <Textarea rows={8} value={raw} onChange={(e) => setRaw(e.target.value)} />
        </Field>
        {parsed.errors.length > 0 ? (
          <ul className="space-y-0.5 text-xs text-red-700">
            {parsed.errors.slice(0, 5).map((m) => (
              <li key={m}>• {m}</li>
            ))}
          </ul>
        ) : parsed.values.length > 0 ? (
          <p className="text-xs text-ink-500">{parsed.values.length} index points understood.</p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || parsed.values.length === 0}>
            {busy ? "Saving…" : "Record values"}
          </Button>
        </div>
      </form>
    </Modal>
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
  const [formulae, setFormulae] = useState<FluctuationFormulaInfo[]>([]);
  const [formula, setFormula] = useState("fidic_13_8");
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
      const [s, h, f] = await Promise.all([
        api.get<{ items: IndexSeriesRow[] }>(`/api/v1/commercial/index-series`),
        api.get<ListResponse<FluctuationCalcRow>>(
          `/api/v1/projects/${projectId}/commercial/fluctuations?pageSize=50`,
        ),
        api.get<{ items: FluctuationFormulaInfo[] }>(`/api/v1/commercial/fluctuation-formulae`),
      ]);
      setSeries(s.items);
      setHistory(h.items);
      setFormulae(f.items);
      if (f.items[0] && !f.items.some((x) => x.formula === formula)) {
        setFormula(f.items[0].formula);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load index series");
    }
  }, [projectId, formula]);

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
          formula,
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
            <Field
              label="Formula"
              hint={
                formulae.find((f) => f.formula === formula)?.reference ??
                "The adjustment rule this contract provides."
              }
            >
              <Select value={formula} onChange={(e) => setFormula(e.target.value)}>
                {formulae.length === 0 ? <option value={formula}>{humanize(formula)}</option> : null}
                {formulae.map((f) => (
                  <option key={f.formula} value={f.formula}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="mb-3 text-xs text-ink-500">
              {formulae.find((f) => f.formula === formula)?.description ?? ""}
            </p>
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
