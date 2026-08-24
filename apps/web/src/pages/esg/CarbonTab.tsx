/**
 * Embodied carbon register — spec Vol II Domain I (#491-492, #494-495, #498,
 * #501, #505-508).
 *
 * The headline is three numbers a client actually asks for: the total, the
 * intensity per m² GIA (the RICS reporting unit), and how much of the total
 * stands on a product-specific EPD rather than a library average. Below it
 * the EN 15978 life-cycle split, the GHG-Protocol scope split, the budgets
 * with their drawdown, and the entries themselves — each one a quantity, a
 * factor and a provenance, never a bare number.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { CARBON_MODULES, CARBON_SCOPES } from "@constructos/shared";
import { api, ApiClientError, fetchBlobUrl } from "../../lib/api";
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
import { formatDate } from "../format";
import { LifeCycleChart, ScopeDonut } from "./CarbonCharts";
import {
  Caveat,
  EpdBadge,
  FACTOR_SOURCE_LABELS,
  MODULE_DESCRIPTIONS,
  Meter,
  SCOPE_LABELS,
  StatCard,
  budgetTone,
  factorSourceTone,
  fmtNum,
  fmtPct,
  fmtT,
  type BoqImportResult,
  type BoqPickRow,
  type BudgetRow,
  type CarbonSummary,
  type EntryRow,
  type FactorRow,
  type ListResponse,
} from "./esgShared";

const PRODUCT_SPECIFIC_TOOLTIP =
  "Share of the reported tCO2e calculated from a product-specific Environmental Product " +
  "Declaration (an EPD — a verified, declared figure for the actual product specified) rather " +
  "than a generic library average for the material class. Generic factors are fine for early " +
  "design; a contractual or disclosure figure should be standing mostly on EPDs. A low share " +
  "is not an error, it is the honest maturity of the assessment.";

const INTENSITY_TOOLTIP =
  "Whole-life carbon intensity: total kgCO2e divided by gross internal area (GIA) in m². " +
  "This is the unit benchmarks and planning conditions are written in. It appears once GIA is " +
  "set on the project.";

/* --------------------------- unit reconciliation -------------------------- */

/** Mirrors the API's unit aliasing so the live preview tells the truth. */
const UNIT_ALIASES: Record<string, string> = {
  kg: "kg", kgs: "kg", kilogram: "kg", kilograms: "kg",
  t: "t", te: "t", tonne: "t", tonnes: "t", ton: "t",
  m3: "m3", "m^3": "m3", "m³": "m3", cum: "m3",
  m2: "m2", "m^2": "m2", "m²": "m2", sqm: "m2",
  m: "m", lm: "m", metre: "m", metres: "m",
  l: "litre", ltr: "litre", litre: "litre", litres: "litre", liter: "litre", liters: "litre",
  item: "item", items: "item", no: "item", nr: "item", each: "item", ea: "item",
  kwh: "kwh", hr: "hr", hour: "hr", hours: "hr",
};

function normaliseUnit(unit: string): string {
  const k = unit.trim().toLowerCase().replace(/\s+/g, "");
  return UNIT_ALIASES[k] ?? k;
}

function unitsMatch(a: string, b: string): boolean {
  return normaliseUnit(a) === normaliseUnit(b);
}

function factorOptionLabel(f: FactorRow): string {
  const src = FACTOR_SOURCE_LABELS[f.source] ?? f.source;
  const epd = f.isProductSpecific === 1 ? " · EPD" : "";
  return `${f.name} — ${src}${epd} · ${fmtNum(f.factorKgCo2ePerUnit, 4)} kgCO₂e/${f.unit}`;
}

/** Factor provenance chips, shown next to a Select that can only carry text. */
function FactorChips({ factor }: { factor: FactorRow | undefined }) {
  if (!factor) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone={factorSourceTone(factor.source)}>
        {FACTOR_SOURCE_LABELS[factor.source] ?? factor.source}
      </Badge>
      <EpdBadge
        isProductSpecific={factor.isProductSpecific === 1}
        reference={factor.epdReference}
      />
      <span className="tabular-nums text-xs text-ink-500">
        {fmtNum(factor.factorKgCo2ePerUnit, 4)} kgCO₂e / {factor.unit}
      </span>
      {factor.validUntil ? (
        <span className="text-xs text-ink-400">valid to {formatDate(factor.validUntil)}</span>
      ) : null}
    </span>
  );
}

/* ================================== Tab =================================== */

interface MappingDraft {
  prefix: string;
  factorId: string;
}

export default function CarbonTab({
  projectId,
  factors,
  onFactorsNeeded,
}: {
  projectId: string;
  factors: FactorRow[] | null;
  onFactorsNeeded: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;

  const [summary, setSummary] = useState<CarbonSummary | null>(null);
  const [budgets, setBudgets] = useState<BudgetRow[] | null>(null);
  const [entries, setEntries] = useState<EntryRow[] | null>(null);
  const [entryTotal, setEntryTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [sum, bud, ent] = await Promise.all([
        api.get<CarbonSummary>(`${base}/carbon/summary`),
        api.get<ListResponse<BudgetRow>>(`${base}/carbon-budgets?pageSize=100`),
        api.get<ListResponse<EntryRow>>(`${base}/carbon-entries?pageSize=100`),
      ]);
      setSummary(sum);
      setBudgets(bud.items);
      setEntries(ent.items);
      setEntryTotal(ent.total);
    } catch (err) {
      setBudgets((p) => p ?? []);
      setEntries((p) => p ?? []);
      setError(err instanceof Error ? err.message : "Failed to load the carbon register");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const factorById = useMemo(
    () => new Map((factors ?? []).map((f) => [f.id, f])),
    [factors],
  );

  /* ------------------------------ entry modal ----------------------------- */

  const [entryOpen, setEntryOpen] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [eDesc, setEDesc] = useState("");
  const [eModule, setEModule] = useState<string>("A1-A3");
  const [eScope, setEScope] = useState<string>("scope_3");
  const [eFactorId, setEFactorId] = useState<string>("");
  const [eManual, setEManual] = useState("");
  const [eQty, setEQty] = useState("");
  const [eUnit, setEUnit] = useState("");
  const [eBudgetId, setEBudgetId] = useState("");
  const [eDate, setEDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [eNote, setENote] = useState("");

  function openEntry() {
    setEntryError(null);
    setEDesc("");
    setEModule("A1-A3");
    setEScope("scope_3");
    setEFactorId(factors && factors.length > 0 ? (factors[0]?.id ?? "") : "__manual__");
    setEManual("");
    setEQty("");
    setEUnit(factors && factors.length > 0 ? (factors[0]?.unit ?? "") : "");
    setEBudgetId("");
    setEDate(new Date().toISOString().slice(0, 10));
    setENote("");
    setEntryOpen(true);
    if (!factors) onFactorsNeeded();
  }

  function pickFactor(id: string) {
    setEFactorId(id);
    const f = factorById.get(id);
    if (f) setEUnit(f.unit);
  }

  const selectedFactor = factorById.get(eFactorId);
  const isManual = eFactorId === "__manual__";
  const factorValue = isManual ? Number(eManual) : (selectedFactor?.factorKgCo2ePerUnit ?? 0);
  const qtyNum = Number(eQty);
  const previewTco2e =
    Number.isFinite(qtyNum) && qtyNum > 0 && Number.isFinite(factorValue) && factorValue > 0
      ? (qtyNum * factorValue) / 1000
      : null;
  const unitMismatch =
    !isManual && selectedFactor != null && eUnit.trim() !== ""
      ? !unitsMatch(eUnit, selectedFactor.unit)
      : false;

  async function onCreateEntry(e: FormEvent) {
    e.preventDefault();
    setEntryError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        description: eDesc.trim(),
        lifecycleModule: eModule,
        quantity: Number(eQty),
        unit: eUnit.trim(),
        entryDate: eDate,
      };
      if (eScope) payload["scope"] = eScope;
      if (isManual) payload["manualFactor"] = Number(eManual);
      else payload["factorId"] = eFactorId;
      if (eBudgetId) payload["budgetId"] = eBudgetId;
      if (eNote.trim()) payload["sourceNote"] = eNote.trim();
      await api.post<EntryRow>(`${base}/carbon-entries`, payload);
      setEntryOpen(false);
      await load();
    } catch (err) {
      setEntryError(
        err instanceof ApiClientError ? err.message : "Failed to record the carbon entry.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteEntry(entry: EntryRow) {
    if (
      !window.confirm(
        `Delete "${entry.description}" (${fmtT(entry.tco2e)} tCO₂e)? The deletion is recorded in the ledger.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      await api.del(`${base}/carbon-entries/${entry.id}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete the entry");
    }
  }

  /* ----------------------------- budget modal ----------------------------- */

  const [budgetOpen, setBudgetOpen] = useState(false);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [bName, setBName] = useState("");
  const [bElement, setBElement] = useState("");
  const [bBaseline, setBBaseline] = useState("");
  const [bTarget, setBTarget] = useState("");

  function openBudget() {
    setBudgetError(null);
    setBName("");
    setBElement("");
    setBBaseline("");
    setBTarget("");
    setBudgetOpen(true);
  }

  const baselineNum = Number(bBaseline);
  const targetNum = Number(bTarget);
  const reduction =
    baselineNum > 0 && targetNum > 0 ? ((baselineNum - targetNum) / baselineNum) * 100 : null;

  async function onCreateBudget(e: FormEvent) {
    e.preventDefault();
    setBudgetError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: bName.trim(),
        baselineTco2e: Number(bBaseline),
        targetTco2e: Number(bTarget),
      };
      if (bElement.trim()) payload["element"] = bElement.trim();
      await api.post<BudgetRow>(`${base}/carbon-budgets`, payload);
      setBudgetOpen(false);
      await load();
    } catch (err) {
      setBudgetError(
        err instanceof ApiClientError ? err.message : "Failed to create the carbon budget.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------ BoQ import ------------------------------ */

  const [importOpen, setImportOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [boqs, setBoqs] = useState<BoqPickRow[] | null>(null);
  const [iBoqId, setIBoqId] = useState("");
  const [iBudgetId, setIBudgetId] = useState("");
  const [mappings, setMappings] = useState<MappingDraft[]>([]);
  const [importResult, setImportResult] = useState<BoqImportResult | null>(null);

  const openImport = useCallback(async () => {
    setImportError(null);
    setImportResult(null);
    setIBoqId("");
    setIBudgetId("");
    setMappings([{ prefix: "", factorId: "" }]);
    setImportOpen(true);
    if (!factors) onFactorsNeeded();
    if (boqs === null) {
      try {
        const res = await api.get<ListResponse<BoqPickRow>>(`${base}/boqs?pageSize=100`);
        setBoqs(res.items);
        if (res.items[0]) setIBoqId(res.items[0].id);
      } catch {
        setBoqs([]);
      }
    } else if (boqs[0]) {
      setIBoqId(boqs[0].id);
    }
  }, [base, boqs, factors, onFactorsNeeded]);

  function setMapping(i: number, patch: Partial<MappingDraft>) {
    setMappings((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  const validMappings = mappings.filter((m) => m.prefix.trim() && m.factorId);

  async function onRunImport(e: FormEvent) {
    e.preventDefault();
    setImportError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        boqId: iBoqId,
        mappings: validMappings.map((m) => ({
          boqItemCodePrefix: m.prefix.trim(),
          factorId: m.factorId,
        })),
      };
      if (iBudgetId) payload["budgetId"] = iBudgetId;
      const res = await api.post<BoqImportResult>(`${base}/carbon-entries/from-boq`, payload);
      setImportResult(res);
      await load();
    } catch (err) {
      setImportError(
        err instanceof ApiClientError ? err.message : "Failed to import from the Bill of Quantities.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------- export -------------------------------- */

  const [exporting, setExporting] = useState(false);

  async function onExport() {
    setExporting(true);
    setError(null);
    try {
      const url = await fetchBlobUrl(`${base}/carbon/report.csv`);
      const a = document.createElement("a");
      a.href = url;
      a.download = `carbon-report-${projectId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export the carbon report");
    } finally {
      setExporting(false);
    }
  }

  /* -------------------------------- render -------------------------------- */

  if (summary === null && entries === null && !error) return <Spinner label="Loading carbon register…" />;

  const skippedByReason = new Map<string, BoqImportResult["skipped"]>();
  for (const s of importResult?.skipped ?? []) {
    const list = skippedByReason.get(s.reason) ?? [];
    list.push(s);
    skippedByReason.set(s.reason, list);
  }

  return (
    <div>
      <ErrorAlert message={error} />

      {/* ------------------------------ headline ------------------------------ */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Total embodied carbon"
          value={<>{fmtT(summary?.totalTco2e)} <span className="text-sm font-medium text-ink-400">tCO₂e</span></>}
          hint={`${summary?.entryCount ?? 0} entr${summary?.entryCount === 1 ? "y" : "ies"} assessed`}
          tone="brand"
          emphasized
        />
        <StatCard
          label="Intensity"
          value={
            summary?.intensityPerSqm != null ? (
              <>
                {fmtNum(summary.intensityPerSqm, 1)}{" "}
                <span className="text-sm font-medium text-ink-400">kgCO₂e/m²</span>
              </>
            ) : (
              <span className="text-base font-medium text-ink-300">GIA not set</span>
            )
          }
          hint={summary?.gia != null ? `over ${fmtNum(summary.gia, 0)} m² GIA` : "set GIA on the project to report intensity"}
          title={INTENSITY_TOOLTIP}
        />
        <StatCard
          label="Product-specific data"
          value={fmtPct(summary?.productSpecificSharePercent ?? 0)}
          hint={
            summary
              ? `${fmtT(summary.productSpecificTco2e)} of ${fmtT(summary.totalTco2e)} tCO₂e on EPDs`
              : undefined
          }
          title={PRODUCT_SPECIFIC_TOOLTIP}
          tone={
            (summary?.productSpecificSharePercent ?? 0) >= 50
              ? "green"
              : (summary?.productSpecificSharePercent ?? 0) > 0
                ? "amber"
                : undefined
          }
        />
        <StatCard
          label="Unbudgeted"
          value={<>{fmtT(summary?.unbudgetedTco2e)} <span className="text-sm font-medium text-ink-400">tCO₂e</span></>}
          hint="not attributed to any carbon budget"
          title="Emissions recorded against no budget. They count towards the total but are outside every drawdown, so a budget can read on-track while the project is not."
          tone={(summary?.unbudgetedTco2e ?? 0) > 0 ? "amber" : undefined}
        />
      </div>

      {/* -------------------------------- charts ------------------------------- */}
      {summary && summary.entryCount > 0 ? (
        <div className="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardBody>
              <h3 className="mb-1 text-sm font-semibold text-ink-900">
                Life-cycle modules — EN 15978
              </h3>
              <p className="mb-3 text-xs text-ink-400">
                Every module is plotted, zeros included. A whole-life assessment that omits the
                stages nobody measured reads as complete when it is not.
              </p>
              <LifeCycleChart byModule={summary.byModule} />
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <h3 className="mb-1 text-sm font-semibold text-ink-900">GHG Protocol scopes</h3>
              <p className="mb-3 text-xs text-ink-400">
                On construction, purchased goods and services put most of the footprint in Scope 3.
              </p>
              <ScopeDonut byScope={summary.byScope} />
            </CardBody>
          </Card>
        </div>
      ) : null}

      {/* ------------------------------- budgets ------------------------------- */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">
          Carbon budgets{" "}
          <span className="font-normal text-ink-400">— target drawdown by element</span>
        </h3>
        <Button variant="secondary" size="sm" onClick={openBudget}>
          New budget
        </Button>
      </div>

      {budgets === null ? (
        <Spinner label="Loading budgets…" />
      ) : budgets.length === 0 ? (
        <div className="mb-5">
          <EmptyState
            title="No carbon budgets set"
            hint="A budget turns a reduction target into something that can be drawn down and exceeded. Set one per element or work package, with the baseline it is measured against."
            action={<Button onClick={openBudget}>Set the first budget</Button>}
          />
        </div>
      ) : (
        <div className="mb-5 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {budgets.map((b) => {
            const tone = budgetTone(b.status);
            return (
              <Card key={b.id} className={b.status === "exceeded" ? "ring-1 ring-red-200" : undefined}>
                <CardBody className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-ink-900">{b.name}</div>
                      {b.element ? (
                        <div className="text-xs text-ink-400">{b.element}</div>
                      ) : null}
                    </div>
                    {b.status === "exceeded" ? (
                      <Badge tone="red">✗ Exceeded</Badge>
                    ) : b.status === "at_risk" ? (
                      <Badge tone="amber">At risk</Badge>
                    ) : (
                      <Badge tone="green">On track</Badge>
                    )}
                  </div>

                  <div className="mt-2.5">
                    <div className="mb-1 flex items-baseline justify-between text-xs">
                      <span className="text-ink-500">
                        <span className="font-semibold tabular-nums text-ink-800">
                          {fmtT(b.actualTco2e)}
                        </span>{" "}
                        of {fmtT(b.targetTco2e)} tCO₂e
                      </span>
                      <span className={`font-semibold tabular-nums ${
                        b.status === "exceeded"
                          ? "text-red-700"
                          : b.status === "at_risk"
                            ? "text-amber-700"
                            : "text-emerald-700"
                      }`}>
                        {fmtPct(b.drawdownPercent)}
                      </span>
                    </div>
                    <Meter
                      percent={b.drawdownPercent}
                      tone={tone}
                      size="lg"
                      title={`${fmtPct(b.drawdownPercent)} of the ${fmtT(b.targetTco2e)} tCO₂e target drawn down`}
                    />
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
                      {b.remaining >= 0 ? (
                        <span>
                          <span className="font-medium tabular-nums text-ink-700">
                            {fmtT(b.remaining)}
                          </span>{" "}
                          tCO₂e remaining
                        </span>
                      ) : (
                        <span className="font-semibold text-red-700">
                          Over target by{" "}
                          <span className="tabular-nums">{fmtT(-b.remaining)}</span> tCO₂e
                        </span>
                      )}
                      <span aria-hidden>·</span>
                      <span title="Reduction the target represents against the recorded baseline (#494).">
                        target is {fmtPct(b.reductionFromBaselinePercent)} below the{" "}
                        {fmtT(b.baselineTco2e)} tCO₂e baseline
                      </span>
                    </div>
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      {/* -------------------------------- entries ------------------------------ */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">
          Carbon entries{" "}
          <span className="font-normal text-ink-400">
            — {entryTotal} record{entryTotal === 1 ? "" : "s"}
            {entries && entryTotal > entries.length ? `, showing ${entries.length}` : ""}
          </span>
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onExport} disabled={exporting}>
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void openImport()}>
            Import from Bill of Quantities
          </Button>
          <Button size="sm" onClick={openEntry}>
            New entry
          </Button>
        </div>
      </div>

      {entries === null ? (
        <Spinner label="Loading entries…" />
      ) : entries.length === 0 ? (
        <EmptyState
          title="No carbon entries yet"
          hint="Every figure in this register is a quantity multiplied by a published factor, with the factor's provenance kept. Record entries by hand, or generate them straight off the Bill of Quantities so the carbon model rides the commercial model."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={openEntry}>Record the first entry</Button>
              <Button variant="secondary" onClick={() => void openImport()}>
                Import from BoQ
              </Button>
            </div>
          }
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Description</Th>
              <Th>Module</Th>
              <Th>Scope</Th>
              <Th className="text-right">Quantity</Th>
              <Th>Factor</Th>
              <Th className="text-right">tCO₂e</Th>
              <Th>Date</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {entries.map((e) => (
              <tr key={e.id} className="hover:bg-ink-50/60">
                <Td>
                  <div className="max-w-xs truncate font-medium text-ink-900" title={e.description}>
                    {e.description}
                  </div>
                  {e.sourceNote ? (
                    <div className="max-w-xs truncate text-xs text-ink-400" title={e.sourceNote}>
                      {e.sourceNote}
                    </div>
                  ) : null}
                </Td>
                <Td>
                  <span title={MODULE_DESCRIPTIONS[e.lifecycleModule]}>
                    <Badge tone="blue">{e.lifecycleModule}</Badge>
                  </span>
                </Td>
                <Td className="text-xs text-ink-500">
                  {e.scope ? (SCOPE_LABELS[e.scope] ?? e.scope) : <span className="text-ink-300">—</span>}
                </Td>
                <Td className="whitespace-nowrap text-right tabular-nums">
                  {fmtNum(e.quantity, 3)} <span className="text-xs text-ink-400">{e.unit}</span>
                </Td>
                <Td>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="max-w-44 truncate text-xs text-ink-700" title={e.factorName ?? "Manually entered factor"}>
                      {e.factorName ?? "Manual"}
                    </span>
                    <EpdBadge isProductSpecific={e.isProductSpecific} />
                  </div>
                  <div className="text-[11px] tabular-nums text-ink-400">
                    {fmtNum(e.factorKgCo2ePerUnit, 4)} kgCO₂e/{e.unit} ·{" "}
                    {FACTOR_SOURCE_LABELS[e.factorSource] ?? e.factorSource}
                  </div>
                </Td>
                <Td className="whitespace-nowrap text-right font-semibold tabular-nums text-ink-900">
                  {fmtT(e.tco2e, 3)}
                </Td>
                <Td className="whitespace-nowrap text-xs text-ink-500">{formatDate(e.entryDate)}</Td>
                <Td className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void onDeleteEntry(e)}
                    aria-label={`Delete entry ${e.description}`}
                  >
                    ✕
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* ---------------------------- entry create modal ---------------------- */}
      <Modal open={entryOpen} title="Record a carbon entry" onClose={() => setEntryOpen(false)} wide>
        <ErrorAlert message={entryError} />
        <form onSubmit={onCreateEntry} className="space-y-4">
          <Field label="Description">
            <Input
              required
              value={eDesc}
              onChange={(ev) => setEDesc(ev.target.value)}
              placeholder="In-situ reinforced concrete to substructure"
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Life-cycle module" hint={MODULE_DESCRIPTIONS[eModule]}>
              <Select value={eModule} onChange={(ev) => setEModule(ev.target.value)}>
                {CARBON_MODULES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="GHG Protocol scope">
              <Select value={eScope} onChange={(ev) => setEScope(ev.target.value)}>
                <option value="">Unscoped</option>
                {CARBON_SCOPES.map((s) => (
                  <option key={s} value={s}>
                    {SCOPE_LABELS[s] ?? s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Carbon budget" hint="Unbudgeted entries still count towards the total.">
              <Select value={eBudgetId} onChange={(ev) => setEBudgetId(ev.target.value)}>
                <option value="">No budget</option>
                {(budgets ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="Carbon factor">
            <Select value={eFactorId} onChange={(ev) => pickFactor(ev.target.value)}>
              {factors === null ? <option value="">Loading factors…</option> : null}
              {(factors ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {factorOptionLabel(f)}
                </option>
              ))}
              <option value="__manual__">Manual factor — nothing in the library fits</option>
            </Select>
          </Field>
          {!isManual ? (
            <div className="-mt-2">
              <FactorChips factor={selectedFactor} />
            </div>
          ) : null}
          {factors !== null && factors.length === 0 ? (
            <p className="-mt-2 text-xs text-amber-700">
              The factor library is empty, so this entry can only carry a manually-entered figure.
              Populate the library on the Factors tab to keep the register's provenance intact.
            </p>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            {isManual ? (
              <Field label="kgCO₂e per unit" hint="Record where it came from below.">
                <Input
                  type="number"
                  min="0.000001"
                  step="any"
                  required
                  value={eManual}
                  onChange={(ev) => setEManual(ev.target.value)}
                />
              </Field>
            ) : null}
            <Field label="Quantity">
              <Input
                type="number"
                min="0.000001"
                step="any"
                required
                value={eQty}
                onChange={(ev) => setEQty(ev.target.value)}
              />
            </Field>
            <Field
              label="Unit"
              hint={selectedFactor && !isManual ? `factor published per ${selectedFactor.unit}` : undefined}
            >
              <Input required value={eUnit} onChange={(ev) => setEUnit(ev.target.value)} />
            </Field>
            <Field label="Entry date">
              <Input type="date" required value={eDate} onChange={(ev) => setEDate(ev.target.value)} />
            </Field>
          </div>

          {unitMismatch ? (
            <Caveat>
              The entry is measured in <strong>{eUnit}</strong> but the factor is published per{" "}
              <strong>{selectedFactor?.unit}</strong>. Convert the quantity or pick a factor in
              this unit — the register will not accept a mismatched calculation.
            </Caveat>
          ) : null}

          {/* live calculation preview */}
          <div className="rounded-md bg-brand-50 px-3 py-2.5 ring-1 ring-brand-100">
            <div className="text-[11px] font-medium uppercase tracking-wide text-brand-800">
              Calculated emissions
            </div>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-2">
              <span className="text-xl font-bold tabular-nums text-brand-800">
                {previewTco2e === null ? "—" : fmtT(previewTco2e, 4)}
              </span>
              <span className="text-sm font-medium text-brand-700">tCO₂e</span>
              {previewTco2e !== null ? (
                <span className="text-xs tabular-nums text-brand-700/80">
                  = {fmtNum(qtyNum, 3)} {eUnit || "unit"} × {fmtNum(factorValue, 4)} kgCO₂e ÷ 1000
                </span>
              ) : (
                <span className="text-xs text-ink-400">
                  enter a quantity and a factor to see the calculation
                </span>
              )}
            </div>
          </div>

          <Field label="Provenance note" hint="Where the quantity came from — a drawing, a delivery ticket, a take-off.">
            <Textarea
              value={eNote}
              onChange={(ev) => setENote(ev.target.value)}
              className="min-h-12"
              placeholder="Take-off from GA-201 rev C, concrete schedule item 3.2"
            />
          </Field>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEntryOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || unitMismatch}>
              {busy ? "Recording…" : "Record entry"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* --------------------------- budget create modal ---------------------- */}
      <Modal open={budgetOpen} title="New carbon budget" onClose={() => setBudgetOpen(false)}>
        <ErrorAlert message={budgetError} />
        <form onSubmit={onCreateBudget} className="space-y-4">
          <Field label="Budget name">
            <Input
              required
              value={bName}
              onChange={(ev) => setBName(ev.target.value)}
              placeholder="Substructure — embodied carbon"
            />
          </Field>
          <Field label="Element" hint="NRM1 element or work package this budget covers.">
            <Input
              value={bElement}
              onChange={(ev) => setBElement(ev.target.value)}
              placeholder="1.1 Substructure"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Baseline tCO₂e" hint="The do-nothing case the target is measured against.">
              <Input
                type="number"
                min="0"
                step="any"
                required
                value={bBaseline}
                onChange={(ev) => setBBaseline(ev.target.value)}
              />
            </Field>
            <Field label="Target tCO₂e" hint="What the project has committed to.">
              <Input
                type="number"
                min="0.000001"
                step="any"
                required
                value={bTarget}
                onChange={(ev) => setBTarget(ev.target.value)}
              />
            </Field>
          </div>
          {reduction !== null ? (
            <p
              className={`text-xs tabular-nums ${
                reduction > 0 ? "text-emerald-700" : "font-semibold text-amber-700"
              }`}
            >
              {reduction > 0
                ? `Target is ${fmtPct(reduction)} below the baseline.`
                : `Target is at or above the baseline — this budget commits to no reduction.`}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setBudgetOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create budget"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ----------------------------- BoQ import modal ----------------------- */}
      <Modal
        open={importOpen}
        title="Import carbon entries from the Bill of Quantities"
        onClose={() => setImportOpen(false)}
        wide
      >
        <ErrorAlert message={importError} />

        {importResult ? (
          <div className="space-y-4">
            {importResult.created > 0 ? (
              <div className="rounded-md bg-brand-50 px-4 py-3 ring-1 ring-brand-100">
                <div className="text-sm font-semibold text-brand-900">
                  {importResult.created} entr{importResult.created === 1 ? "y" : "ies"} created —{" "}
                  <span className="tabular-nums">{fmtT(importResult.totalTco2e)}</span> tCO₂e
                </div>
                <p className="mt-1 text-xs text-brand-800/80">
                  Measured items were booked as A1-A3 / Scope 3 with the BoQ item recorded as
                  provenance, so every figure traces back to the bill it was measured from.
                </p>
              </div>
            ) : (
              <div className="rounded-md bg-ink-50 px-4 py-3 ring-1 ring-ink-200">
                <div className="text-sm font-semibold text-ink-900">Nothing was created</div>
                <p className="mt-1 text-xs text-ink-500">
                  {importResult.skipped.length > 0
                    ? "Every item matching the mapped prefixes was skipped — see why below."
                    : "No BoQ item code started with any of the mapped prefixes. Check the prefixes against the bill's own codes and run again."}
                </p>
              </div>
            )}

            {importResult.skipped.length > 0 ? (
              <div>
                <div className="mb-1.5 text-sm font-semibold text-amber-800">
                  {importResult.skipped.length} item
                  {importResult.skipped.length === 1 ? "" : "s"} skipped
                </div>
                <p className="mb-2 text-xs text-ink-500">
                  Skipped items are reported, never guessed — a carbon figure with no quantity
                  behind it is worse than a missing one.
                </p>
                <div className="max-h-56 space-y-2 overflow-y-auto">
                  {[...skippedByReason.entries()].map(([reason, rows]) => (
                    <div key={reason} className="rounded-md bg-amber-50 px-3 py-2 ring-1 ring-amber-200">
                      <div className="text-xs font-semibold text-amber-900">
                        {reason === "no_quantity"
                          ? "No measured quantity"
                          : reason === "no_unit"
                            ? "No unit of measurement"
                            : reason === "unit_mismatch"
                              ? "Unit does not match the factor"
                              : reason}{" "}
                        <span className="font-normal">({rows.length})</span>
                      </div>
                      <div className="mt-1 text-[11px] leading-relaxed text-amber-900/80">
                        {rows[0]?.detail}
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-amber-900/70">
                        {rows.map((r) => r.code).join(", ")}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-xs text-ink-500">
                Every mapped item carried a quantity in a matching unit — nothing was skipped.
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setImportResult(null)}>
                Run another import
              </Button>
              <Button onClick={() => setImportOpen(false)}>Done</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={onRunImport} className="space-y-4">
            <p className="text-xs leading-relaxed text-ink-500">
              Map BoQ item-code prefixes to carbon factors. Every measured item whose code starts
              with a mapped prefix becomes an A1-A3 / Scope 3 entry at the item's own quantity.
              Items with no quantity, no unit, or a unit the factor is not published in are
              skipped and listed.
            </p>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Bill of Quantities">
                <Select
                  required
                  value={iBoqId}
                  onChange={(ev) => setIBoqId(ev.target.value)}
                >
                  {boqs === null ? <option value="">Loading bills…</option> : null}
                  {boqs !== null && boqs.length === 0 ? (
                    <option value="">No bills in this project</option>
                  ) : null}
                  {(boqs ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} — v{b.version}
                      {b.itemCount != null ? ` · ${b.itemCount} items` : ""}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Attribute to budget" hint="Optional — otherwise the entries are unbudgeted.">
                <Select value={iBudgetId} onChange={(ev) => setIBudgetId(ev.target.value)}>
                  <option value="">No budget</option>
                  {(budgets ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium text-ink-600">
                  Mappings{" "}
                  <span className="font-normal text-ink-400">— item-code prefix → factor</span>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setMappings((m) => [...m, { prefix: "", factorId: "" }])}
                >
                  Add mapping
                </Button>
              </div>
              <div className="space-y-2">
                {mappings.map((m, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={m.prefix}
                      onChange={(ev) => setMapping(i, { prefix: ev.target.value })}
                      placeholder="E10"
                      className="w-32 font-mono"
                      aria-label={`Item code prefix ${i + 1}`}
                    />
                    <span aria-hidden className="text-ink-300">
                      →
                    </span>
                    <Select
                      value={m.factorId}
                      onChange={(ev) => setMapping(i, { factorId: ev.target.value })}
                      className="flex-1"
                      aria-label={`Factor for mapping ${i + 1}`}
                    >
                      <option value="">Pick a factor…</option>
                      {(factors ?? []).map((f) => (
                        <option key={f.id} value={f.id}>
                          {factorOptionLabel(f)}
                        </option>
                      ))}
                    </Select>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove mapping ${i + 1}`}
                      onClick={() => setMappings((rows) => rows.filter((_, j) => j !== i))}
                    >
                      ✕
                    </Button>
                  </div>
                ))}
              </div>
              {validMappings.length === 0 ? (
                <p className="mt-1.5 text-xs text-ink-400">
                  Add at least one complete mapping to run the import.
                </p>
              ) : null}
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setImportOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !iBoqId || validMappings.length === 0}>
                {busy ? "Importing…" : `Import ${validMappings.length} mapping${validMappings.length === 1 ? "" : "s"}`}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
