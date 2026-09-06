/**
 * Options & disclosure tab — design-option carbon comparison with a marginal
 * abatement cost curve (#502-504), transport carbon legs (A4/A5), the GIA
 * writer behind the RICS intensity unit (#491) and period disclosure assembly
 * for CSRD/ESRS, IFRS S2, TCFD, the GHG Protocol and modern slavery
 * (#541-546).
 *
 * Two rules this screen exists to hold visibly:
 *  · an UNPRICED option is never ranked as though it were free — it is listed
 *    with the reason it could not be priced, which is the commonest way a
 *    carbon option appraisal misleads;
 *  · a disclosure datapoint the platform cannot evidence is reported as
 *    unavailable WITH the reason, never as zero.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
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
import { StatCard, type ListResponse } from "./esgShared";

/* ================================ Types ================================== */

interface MaccRow {
  id: string;
  name: string;
  isBaseline: boolean;
  tco2e: number;
  cost: number | null;
  abatementTco2e: number | null;
  costDelta: number | null;
  abatementCostPerTonne: number | null;
  unavailableReason: string | null;
}

interface Study {
  studyRef: string;
  currency: string | null;
  currencies: string[];
  mixedCurrency: boolean;
  baselineId: string | null;
  rows: MaccRow[];
  bestValueId: string | null;
  noRegretIds: string[];
  note: string | null;
}

interface OptionsResponse {
  items: { id: string; studyRef: string; name: string; decision: string }[];
  total: number;
  studies: Study[];
}

interface TransportLeg {
  id: string;
  description: string;
  origin: string | null;
  destination: string | null;
  mode: string;
  distanceKm: number;
  payloadTonnes: number;
  trips: number;
  tonneKm: number;
  factorKgCo2ePerTonneKm: number;
  factorSource: string;
  tco2e: number;
  lifecycleModule: string;
  legDate: string;
}

interface TransportResponse extends ListResponse<TransportLeg> {
  totals: { legs: number; tonneKm: number; tco2e: number };
  factors: { mode: string; label: string; kgCo2ePerTonneKm: number; source: string }[];
}

interface Datapoint {
  id: string;
  label: string;
  value: number | string | null;
  unit: string | null;
  basis: string;
  sources: string[];
  unavailableReason: string | null;
}

interface DataQuality {
  productSpecificSharePercent: number | null;
  unscopedSharePercent: number | null;
  evidencedDeliverySharePercent: number | null;
  incidentsNotifiedLate: number;
  unavailableDatapoints: number;
  notes: string[];
}

interface DisclosureResult {
  id?: string;
  framework: string;
  periodStart: string;
  periodEnd: string;
  datapoints: Datapoint[];
  dataQuality: DataQuality;
  ledgerSeqTo: number | null;
  committed?: boolean;
}

interface StoredDisclosure {
  id: string;
  framework: string;
  periodStart: string;
  periodEnd: string;
  datapoints: Datapoint[];
  dataQuality: DataQuality;
  ledgerSeqTo: number | null;
  createdAt: string;
}

interface GiaResponse {
  giaSqm: number | null;
  unavailableReason: string | null;
}

const FRAMEWORK_LABELS: Record<string, string> = {
  esrs_e1_climate: "ESRS E1 — Climate change",
  esrs_e5_circular: "ESRS E5 — Circular economy",
  esrs_s1_workforce: "ESRS S1 — Own workforce",
  ifrs_s2_climate: "IFRS S2 — Climate disclosures",
  tcfd: "TCFD",
  modern_slavery_statement: "Modern slavery statement",
  ghg_protocol: "GHG Protocol",
};

const num = (v: number | null | undefined, dp = 2): string =>
  v === null || v === undefined ? "—" : v.toFixed(dp).replace(/\.?0+$/, "") || "0";

type SubView = "options" | "transport" | "disclosure";

const SUB_VIEWS: { key: SubView; label: string }[] = [
  { key: "options", label: "Design options" },
  { key: "transport", label: "Transport" },
  { key: "disclosure", label: "Disclosure" },
];

/* ================================ Shell ================================== */

export default function DisclosureTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;
  const [view, setView] = useState<SubView>("options");

  return (
    <div className="space-y-5">
      <GiaCard base={base} />
      <div className="flex flex-wrap gap-1 border-b border-ink-200">
        {SUB_VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            onClick={() => setView(v.key)}
            className={
              view === v.key
                ? "-mb-px border-b-2 border-brand-600 px-3 py-2 text-sm font-medium text-brand-700"
                : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-ink-500 hover:text-ink-800"
            }
          >
            {v.label}
          </button>
        ))}
      </div>
      {view === "options" ? <OptionsPanel base={base} /> : null}
      {view === "transport" ? <TransportPanel base={base} /> : null}
      {view === "disclosure" ? <DisclosurePanel base={base} /> : null}
    </div>
  );
}

/* --------------------------------- GIA ----------------------------------- */

function GiaCard({ base }: { base: string }) {
  const [gia, setGia] = useState<GiaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<GiaResponse>(`${base}/carbon-settings`);
      setGia(res);
      setValue(res.giaSqm === null ? "" : String(res.giaSqm));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read the project's GIA");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`${base}/carbon-settings`, {
        giaSqm: value === "" ? null : Number(value),
      });
      setEditing(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the GIA");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Gross internal area"
        subtitle="The denominator of the RICS carbon intensity unit — kgCO₂e per m² GIA"
        actions={
          editing ? null : (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              {gia?.giaSqm === null || gia === null ? "Set GIA" : "Change"}
            </Button>
          )
        }
      />
      <CardBody>
        <ErrorAlert message={error} />
        {editing ? (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="GIA (m²)" hint="Leave blank to clear it">
              <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        ) : gia === null ? (
          <Spinner label="Loading…" />
        ) : gia.giaSqm === null ? (
          <p className="text-sm text-ink-500">{gia.unavailableReason}</p>
        ) : (
          <p className="text-sm">
            <span className="text-xl font-semibold tabular-nums">
              {gia.giaSqm.toLocaleString()}
            </span>{" "}
            m² — the carbon summary now reports intensity per m².
          </p>
        )}
      </CardBody>
    </Card>
  );
}

/* ------------------------------- Options --------------------------------- */

function OptionsPanel({ base }: { base: string }) {
  const [data, setData] = useState<OptionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    studyRef: "",
    name: "",
    element: "",
    isBaseline: false,
    tco2e: "",
    cost: "",
    currency: "GBP",
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<OptionsResponse>(`${base}/carbon-options`));
    } catch (err) {
      setData({ items: [], total: 0, studies: [] });
      setError(err instanceof Error ? err.message : "Failed to load design options");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setSaving(true);
    setError(null);
    try {
      await api.post(`${base}/carbon-options`, {
        studyRef: form.studyRef,
        name: form.name,
        element: form.element || null,
        isBaseline: form.isBaseline,
        tco2e: Number(form.tco2e),
        cost: form.cost === "" ? null : Number(form.cost),
        currency: form.currency,
      });
      setOpen(false);
      setForm({ ...form, name: "", tco2e: "", cost: "", isBaseline: false });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add the option");
    } finally {
      setSaving(false);
    }
  }

  async function decide(id: string, decision: string) {
    setError(null);
    try {
      await api.post(`${base}/carbon-options/${id}/decision`, { decision });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record the decision");
    }
  }

  return (
    <Card>
      <CardHeader
        title="Design option carbon comparison"
        subtitle="Marginal abatement cost against the study's baseline — cheapest tonne first"
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            Add option
          </Button>
        }
      />
      <CardBody>
        <ErrorAlert message={error} />
        {data === null ? (
          <Spinner label="Loading options…" />
        ) : data.studies.length === 0 ? (
          <EmptyState
            title="No option studies"
            description="Record the baseline design and the alternatives being appraised against it. Abatement is measured against a reference case, so a study with no baseline cannot be ranked."
          />
        ) : (
          <div className="space-y-6">
            {data.studies.map((s) => (
              <div key={s.studyRef}>
                <div className="mb-2 flex flex-wrap items-center gap-3">
                  <h4 className="text-sm font-semibold text-ink-900">{s.studyRef}</h4>
                  {s.currency ? (
                    <span className="text-xs text-ink-500">{s.currency}</span>
                  ) : (
                    <Badge tone="amber">mixed currency</Badge>
                  )}
                  {s.baselineId === null ? <Badge tone="amber">no baseline</Badge> : null}
                  {s.noRegretIds.length > 0 ? (
                    <Badge tone="green">
                      {s.noRegretIds.length} no-regret option
                      {s.noRegretIds.length === 1 ? "" : "s"}
                    </Badge>
                  ) : null}
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <thead>
                      <tr>
                        <Th>Option</Th>
                        <Th className="text-right">tCO₂e</Th>
                        <Th className="text-right">Cost</Th>
                        <Th className="text-right">Abatement</Th>
                        <Th className="text-right">Cost / tonne</Th>
                        <Th>Decision</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {s.rows.map((r) => {
                        const decision =
                          data.items.find((i) => i.id === r.id)?.decision ?? "under_review";
                        return (
                          <tr
                            key={r.id}
                            className={r.id === s.bestValueId ? "bg-emerald-50/60" : undefined}
                          >
                            <Td className="text-ink-900">
                              <span className="font-medium">{r.name}</span>
                              {r.isBaseline ? (
                                <Badge tone="blue" className="ml-2">
                                  baseline
                                </Badge>
                              ) : null}
                              {r.id === s.bestValueId ? (
                                <Badge tone="green" className="ml-2">
                                  best value
                                </Badge>
                              ) : null}
                            </Td>
                            <Td className="text-right tabular-nums">{num(r.tco2e, 3)}</Td>
                            <Td className="text-right tabular-nums">
                              {r.cost === null ? (
                                <span className="text-ink-400">not priced</span>
                              ) : (
                                r.cost.toLocaleString()
                              )}
                            </Td>
                            <Td className="text-right tabular-nums">
                              {r.abatementTco2e === null ? "—" : num(r.abatementTco2e, 3)}
                            </Td>
                            <Td className="text-right tabular-nums">
                              {r.abatementCostPerTonne === null ? (
                                <span
                                  className="text-ink-400"
                                  title={r.unavailableReason ?? undefined}
                                >
                                  not computable
                                </span>
                              ) : (
                                <span
                                  className={
                                    r.abatementCostPerTonne < 0
                                      ? "font-medium text-emerald-700"
                                      : undefined
                                  }
                                >
                                  {r.abatementCostPerTonne.toLocaleString()}
                                </span>
                              )}
                            </Td>
                            <Td>
                              <Select
                                value={decision}
                                onChange={(e) => void decide(r.id, e.target.value)}
                                className="text-xs"
                              >
                                {["under_review", "adopted", "rejected", "deferred"].map((d) => (
                                  <option key={d} value={d}>
                                    {humanize(d)}
                                  </option>
                                ))}
                              </Select>
                            </Td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </Table>
                </div>
                {s.note ? <p className="mt-2 text-xs text-ink-500">{s.note}</p> : null}
              </div>
            ))}
          </div>
        )}
      </CardBody>

      <Modal open={open} onClose={() => setOpen(false)} title="Add a design option">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Study reference" hint="Options in one study are compared with each other">
              <Input
                value={form.studyRef}
                onChange={(e) => setForm({ ...form, studyRef: e.target.value })}
                placeholder="FRAME-01"
              />
            </Field>
            <Field label="Option name">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="GGBS 50% replacement"
              />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="tCO₂e">
              <Input
                type="number"
                value={form.tco2e}
                onChange={(e) => setForm({ ...form, tco2e: e.target.value })}
              />
            </Field>
            <Field label="Cost" hint="Blank = unpriced, reported as such">
              <Input
                type="number"
                value={form.cost}
                onChange={(e) => setForm({ ...form, cost: e.target.value })}
              />
            </Field>
            <Field label="Currency">
              <Input
                value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
                maxLength={3}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isBaseline}
              onChange={(e) => setForm({ ...form, isBaseline: e.target.checked })}
            />
            This is the study's baseline (reference case)
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void create()}
              disabled={
                saving ||
                form.studyRef.trim() === "" ||
                form.name.trim() === "" ||
                form.tco2e === ""
              }
            >
              {saving ? "Saving…" : "Add"}
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

/* ------------------------------ Transport -------------------------------- */

function TransportPanel({ base }: { base: string }) {
  const [data, setData] = useState<TransportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    description: "",
    origin: "",
    destination: "",
    mode: "articulated_truck",
    distanceKm: "",
    payloadTonnes: "",
    trips: "1",
    legDate: "",
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<TransportResponse>(`${base}/carbon-transport-legs?pageSize=200`));
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : "Failed to load transport legs");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setSaving(true);
    setError(null);
    try {
      await api.post(`${base}/carbon-transport-legs`, {
        description: form.description,
        origin: form.origin || null,
        destination: form.destination || null,
        mode: form.mode,
        distanceKm: Number(form.distanceKm),
        payloadTonnes: Number(form.payloadTonnes),
        trips: Number(form.trips) || 1,
        legDate: form.legDate,
      });
      setOpen(false);
      setForm({ ...form, description: "", distanceKm: "", payloadTonnes: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record the leg");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Transport carbon (A4 / A5)"
        subtitle="tonne-kilometres × a published factor, booked into the project footprint"
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            Add leg
          </Button>
        }
      />
      <CardBody>
        <ErrorAlert message={error} />
        {data === null ? (
          error ? null : <Spinner label="Loading transport legs…" />
        ) : data.items.length === 0 ? (
          <EmptyState
            title="No transport legs"
            description="Record deliveries as tonne-kilometres and they are booked as carbon entries alongside the material quantities, rather than living in a parallel spreadsheet."
          />
        ) : (
          <>
            <div className="mb-4 grid grid-cols-3 gap-3">
              <StatCard label="Legs" value={data.totals.legs} />
              <StatCard
                label="Tonne-km"
                value={data.totals.tonneKm.toLocaleString()}
                hint="payload × distance × trips"
              />
              <StatCard label="tCO₂e" value={num(data.totals.tco2e, 3)} tone="brand" />
            </div>
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Description</Th>
                    <Th>Mode</Th>
                    <Th className="text-right">km</Th>
                    <Th className="text-right">t</Th>
                    <Th className="text-right">Trips</Th>
                    <Th className="text-right">tCO₂e</Th>
                    <Th>Factor source</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {data.items.map((r) => (
                    <tr key={r.id}>
                      <Td className="whitespace-nowrap text-xs text-ink-500">
                        {formatDate(r.legDate)}
                      </Td>
                      <Td className="text-ink-900">{r.description}</Td>
                      <Td className="text-ink-600">{humanize(r.mode)}</Td>
                      <Td className="text-right tabular-nums">{r.distanceKm}</Td>
                      <Td className="text-right tabular-nums">{r.payloadTonnes}</Td>
                      <Td className="text-right tabular-nums">{r.trips}</Td>
                      <Td className="text-right font-medium tabular-nums">{num(r.tco2e, 4)}</Td>
                      <Td className="text-xs text-ink-500">{r.factorSource}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </>
        )}
      </CardBody>

      <Modal open={open} onClose={() => setOpen(false)} title="Add a transport leg">
        <div className="space-y-3">
          <Field label="Description">
            <Input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Precast beams, works to site"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Origin">
              <Input
                value={form.origin}
                onChange={(e) => setForm({ ...form, origin: e.target.value })}
              />
            </Field>
            <Field label="Destination">
              <Input
                value={form.destination}
                onChange={(e) => setForm({ ...form, destination: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Mode">
            <Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
              {(data?.factors ?? []).map((f) => (
                <option key={f.mode} value={f.mode}>
                  {f.label} — {f.kgCo2ePerTonneKm} kgCO₂e/t-km
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-4 gap-3">
            <Field label="Distance (km)">
              <Input
                type="number"
                value={form.distanceKm}
                onChange={(e) => setForm({ ...form, distanceKm: e.target.value })}
              />
            </Field>
            <Field label="Payload (t)">
              <Input
                type="number"
                value={form.payloadTonnes}
                onChange={(e) => setForm({ ...form, payloadTonnes: e.target.value })}
              />
            </Field>
            <Field label="Trips">
              <Input
                type="number"
                value={form.trips}
                onChange={(e) => setForm({ ...form, trips: e.target.value })}
              />
            </Field>
            <Field label="Date">
              <Input
                type="date"
                value={form.legDate}
                onChange={(e) => setForm({ ...form, legDate: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void create()}
              disabled={
                saving ||
                form.description.trim() === "" ||
                form.distanceKm === "" ||
                form.payloadTonnes === "" ||
                form.legDate === ""
              }
            >
              {saving ? "Saving…" : "Add"}
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

/* ----------------------------- Disclosure -------------------------------- */

function DisclosurePanel({ base }: { base: string }) {
  const [stored, setStored] = useState<StoredDisclosure[] | null>(null);
  const [preview, setPreview] = useState<DisclosureResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    framework: "esrs_e1_climate",
    periodStart: "",
    periodEnd: "",
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<StoredDisclosure>>(
        `${base}/esg-disclosures?pageSize=50`,
      );
      setStored(res.items);
    } catch (err) {
      setStored([]);
      setError(err instanceof Error ? err.message : "Failed to load disclosures");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(commit: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<DisclosureResult>(`${base}/esg-disclosures`, {
        framework: form.framework,
        periodStart: form.periodStart,
        periodEnd: form.periodEnd,
        commit,
      });
      setPreview(res);
      if (commit) await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to assemble the return");
    } finally {
      setBusy(false);
    }
  }

  const canRun = form.periodStart !== "" && form.periodEnd !== "";

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Assemble a period return"
          subtitle="Every figure carries its basis and its sources; anything unevidenced is reported as unavailable with the reason"
        />
        <CardBody>
          <ErrorAlert message={error} />
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Framework">
              <Select
                value={form.framework}
                onChange={(e) => setForm({ ...form, framework: e.target.value })}
              >
                {Object.entries(FRAMEWORK_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Period start">
              <Input
                type="date"
                value={form.periodStart}
                onChange={(e) => setForm({ ...form, periodStart: e.target.value })}
              />
            </Field>
            <Field label="Period end">
              <Input
                type="date"
                value={form.periodEnd}
                onChange={(e) => setForm({ ...form, periodEnd: e.target.value })}
              />
            </Field>
            <Button variant="ghost" onClick={() => void run(false)} disabled={!canRun || busy}>
              Preview
            </Button>
            <Button onClick={() => void run(true)} disabled={!canRun || busy}>
              {busy ? "Assembling…" : "Assemble & store"}
            </Button>
          </div>
        </CardBody>
      </Card>

      {preview ? (
        <Card>
          <CardHeader
            title={FRAMEWORK_LABELS[preview.framework] ?? preview.framework}
            subtitle={`${formatDate(preview.periodStart)} – ${formatDate(preview.periodEnd)}${
              preview.ledgerSeqTo === null ? "" : ` · ledger seq ≤ ${preview.ledgerSeqTo}`
            }`}
            actions={
              preview.id ? (
                <a
                  className="text-sm font-medium text-brand-700 underline underline-offset-2"
                  href={`${base}/esg-disclosures/${preview.id}/export.csv`}
                >
                  Export CSV
                </a>
              ) : (
                <Badge tone="amber">preview — not stored</Badge>
              )
            }
          />
          <CardBody>
            <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard
                label="Product-specific"
                value={
                  preview.dataQuality.productSpecificSharePercent === null
                    ? "—"
                    : `${preview.dataQuality.productSpecificSharePercent}%`
                }
                hint="of the footprint on a real EPD"
              />
              <StatCard
                label="Unscoped"
                value={
                  preview.dataQuality.unscopedSharePercent === null
                    ? "—"
                    : `${preview.dataQuality.unscopedSharePercent}%`
                }
                tone={
                  (preview.dataQuality.unscopedSharePercent ?? 0) > 0 ? "amber" : undefined
                }
              />
              <StatCard
                label="Evidenced deliveries"
                value={
                  preview.dataQuality.evidencedDeliverySharePercent === null
                    ? "—"
                    : `${preview.dataQuality.evidencedDeliverySharePercent}%`
                }
              />
              <StatCard
                label="Unavailable datapoints"
                value={preview.dataQuality.unavailableDatapoints}
                tone={preview.dataQuality.unavailableDatapoints > 0 ? "amber" : undefined}
              />
            </div>
            {preview.dataQuality.notes.length > 0 ? (
              <ul className="mb-4 list-disc space-y-1 pl-5 text-xs text-ink-600">
                {preview.dataQuality.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            ) : null}
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Datapoint</Th>
                    <Th className="text-right">Value</Th>
                    <Th>Basis</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {preview.datapoints.map((d) => (
                    <tr key={d.id}>
                      <Td>
                        <div className="font-medium text-ink-900">{d.label}</div>
                        <div className="font-mono text-[11px] text-ink-400">{d.id}</div>
                      </Td>
                      <Td className="whitespace-nowrap text-right tabular-nums">
                        {d.value === null ? (
                          <span className="text-ink-400">not available</span>
                        ) : (
                          <>
                            {typeof d.value === "number" ? num(d.value, 3) : d.value}{" "}
                            <span className="text-ink-400">{d.unit ?? ""}</span>
                          </>
                        )}
                      </Td>
                      <Td className="text-xs text-ink-600">
                        {d.unavailableReason ?? d.basis}
                        {d.sources.length > 0 ? (
                          <div className="mt-0.5 text-[11px] text-ink-400">
                            {d.sources.join(" · ")}
                          </div>
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Stored returns" subtitle="Frozen at a ledger sequence, so they replay" />
        <CardBody>
          {stored === null ? (
            <Spinner label="Loading disclosures…" />
          ) : stored.length === 0 ? (
            <EmptyState
              title="No stored returns"
              description="Assemble a period return above; it is stored with the ledger sequence it was built from."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Framework</Th>
                    <Th>Period</Th>
                    <Th className="text-right">Datapoints</Th>
                    <Th className="text-right">Unavailable</Th>
                    <Th className="text-right">Ledger seq</Th>
                    <Th>Export</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {stored.map((d) => (
                    <tr key={d.id}>
                      <Td className="text-ink-900">
                        {FRAMEWORK_LABELS[d.framework] ?? d.framework}
                      </Td>
                      <Td className="whitespace-nowrap text-xs text-ink-500">
                        {formatDate(d.periodStart)} – {formatDate(d.periodEnd)}
                      </Td>
                      <Td className="text-right tabular-nums">{d.datapoints.length}</Td>
                      <Td className="text-right tabular-nums">
                        {d.dataQuality.unavailableDatapoints}
                      </Td>
                      <Td className="text-right tabular-nums text-ink-500">
                        {d.ledgerSeqTo ?? "—"}
                      </Td>
                      <Td>
                        <a
                          className="text-xs font-medium text-brand-700 underline underline-offset-2"
                          href={`${base}/esg-disclosures/${d.id}/export.csv`}
                        >
                          CSV
                        </a>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
