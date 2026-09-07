/**
 * Environment tab — consent-limit monitoring, environmental incidents,
 * biodiversity net gain and the ISO 14001 evidence register (Domain I).
 *
 * The honesty rules this screen exists to hold:
 *  · a monitoring point with no limit MEASURES; it does not judge, and a
 *    reading against it is labelled a baseline observation rather than
 *    silently passing a compliance test it was never given;
 *  · a reportable incident shows the statutory clock and whether it was met,
 *    because the window — not the closure — is what a regulator prosecutes on;
 *  · biodiversity net gain with no baseline is unavailable with a reason,
 *    never 0%;
 *  · every panel loads, fails and empties on its own.
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
import { Meter, StatCard, type ListResponse } from "./esgShared";

/* ================================ Types ================================== */

interface PointRow {
  id: string;
  name: string;
  medium: string;
  parameter: string;
  unit: string;
  limitValue: number | null;
  limitDirection: string;
  limitBasis: string | null;
  frequency: string | null;
  activeBool: boolean;
  readingCount: number;
  lastReadingAt: string | null;
  exceedanceCount: number;
  hasLimit: boolean;
}

interface ReadingRow {
  id: string;
  readingAt: string;
  value: number;
  exceedanceBool: boolean;
  exceedanceBy: number | null;
  percentOfLimit: number | null;
  method: string | null;
  note: string | null;
}

interface IncidentRow {
  id: string;
  number: number;
  kind: string;
  severity: string;
  occurredAt: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  status: string;
  reportableBool: boolean;
  notified: boolean;
  regulator: string | null;
  regulatorNotifiedAt: string | null;
  rootCause: string | null;
  notificationOverdue: boolean;
}

interface HabitatRow {
  id: string;
  stage: string;
  habitatType: string;
  areaHectares: number;
  distinctiveness: number;
  condition: string;
  conditionScore: number;
  strategicSignificance: number;
  units: number;
}

interface NetGain {
  baselineUnits: number;
  postInterventionUnits: number;
  targetUnits: number | null;
  netChangeUnits: number;
  netGainPercent: number | null;
  meetsTarget: boolean | null;
  netLoss: boolean;
  basis: string;
}

interface BiodiversityResponse {
  items: HabitatRow[];
  total: number;
  byStage: { stage: string; habitats: number; units: number }[];
  netGain: NetGain | null;
}

interface EmsRecord {
  id: string;
  clause: string;
  requirement: string;
  status: string;
  evidenceIds: string[];
  fileIds: string[];
  note: string | null;
}

interface EmsResponse {
  items: EmsRecord[];
  total: number;
  coverage: { clause: string; record: EmsRecord | null; status: string }[];
  clauses: number;
  evidenced: number;
  nonconforming: number;
  coveragePercent: number | null;
}

interface EnvironmentSummary {
  monitoring: {
    points: number;
    pointsWithLimit: number;
    readings: number;
    exceedances: number;
    exceedancePercent: number | null;
    byMedium: { medium: string; points: number }[];
  };
  incidents: {
    total: number;
    open: number;
    reportable: number;
    notified: number;
    awaitingNotification: number;
    byKind: { kind: string; n: number }[];
  };
  biodiversity: (Partial<NetGain> & { habitats: number; unavailableReason?: string }) | null;
}

interface Reference {
  media: string[];
  limitDirections: string[];
  incidentKinds: string[];
  biodiversityStages: string[];
  habitatConditions: string[];
  iso14001Clauses: string[];
  regulatorNotificationHours: number;
}

/* =============================== Labels ================================== */

const MEDIUM_LABELS: Record<string, string> = {
  air: "Air",
  noise: "Noise",
  vibration: "Vibration",
  water: "Surface water",
  groundwater: "Groundwater",
  soil: "Soil",
  dust: "Dust",
  odour: "Odour",
  light: "Light",
};

const INCIDENT_STATUS_TONE: Record<string, "red" | "amber" | "blue" | "green"> = {
  open: "red",
  contained: "amber",
  remediated: "blue",
  closed: "green",
};

const EMS_TONE: Record<string, "red" | "amber" | "blue" | "green" | "gray"> = {
  not_started: "gray",
  in_progress: "amber",
  evidenced: "blue",
  verified: "green",
  nonconforming: "red",
};

const NEXT_STATUS: Record<string, string | null> = {
  open: "contained",
  contained: "remediated",
  remediated: "closed",
  closed: null,
};

const dash = (v: number | null | undefined): string =>
  v === null || v === undefined ? "—" : String(v);

type SubView = "monitoring" | "incidents" | "biodiversity" | "ems";

const SUB_VIEWS: { key: SubView; label: string }[] = [
  { key: "monitoring", label: "Monitoring" },
  { key: "incidents", label: "Incidents" },
  { key: "biodiversity", label: "Biodiversity" },
  { key: "ems", label: "ISO 14001" },
];

/* ================================ Shell ================================== */

export default function EnvironmentTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;
  const [reference, setReference] = useState<Reference | null>(null);
  const [summary, setSummary] = useState<EnvironmentSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [view, setView] = useState<SubView>("monitoring");

  const loadSummary = useCallback(async () => {
    setSummaryError(null);
    try {
      setSummary(await api.get<EnvironmentSummary>(`${base}/environment/summary`));
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : "Failed to load the summary");
    }
  }, [base]);

  useEffect(() => {
    void loadSummary();
    api
      .get<Reference>("/api/v1/esg/environment/reference")
      .then(setReference)
      .catch(() => setReference(null));
  }, [loadSummary]);

  const bio = summary?.biodiversity;

  return (
    <div className="space-y-5">
      <ErrorAlert message={summaryError} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          label="Monitoring points"
          value={summary ? summary.monitoring.points : "—"}
          hint={summary ? `${summary.monitoring.pointsWithLimit} carry a consent limit` : undefined}
          title="A point without a limit records a baseline observation; no compliance conclusion is drawn from it."
        />
        <StatCard label="Readings" value={summary ? summary.monitoring.readings : "—"} />
        <StatCard
          label="Exceedances"
          value={summary ? summary.monitoring.exceedances : "—"}
          tone={summary && summary.monitoring.exceedances > 0 ? "red" : undefined}
          hint={
            summary
              ? summary.monitoring.exceedancePercent === null
                ? "no readings yet"
                : `${summary.monitoring.exceedancePercent}% of readings`
              : undefined
          }
        />
        <StatCard
          label="Incidents open"
          value={summary ? summary.incidents.open : "—"}
          tone={summary && summary.incidents.open > 0 ? "amber" : undefined}
          hint={summary ? `${summary.incidents.total} recorded` : undefined}
        />
        <StatCard
          label="Awaiting notification"
          value={summary ? summary.incidents.awaitingNotification : "—"}
          tone={summary && summary.incidents.awaitingNotification > 0 ? "red" : undefined}
          hint={
            reference ? `statutory window ${reference.regulatorNotificationHours}h` : undefined
          }
          title="The statutory notification window runs from the incident, not from its closure. It is what a regulator prosecutes on."
        />
      </div>

      {bio ? (
        <Card>
          <CardHeader
            title="Biodiversity position"
            subtitle="Habitat units: area × distinctiveness × condition × strategic significance"
          />
          <CardBody>
            {bio.unavailableReason ? (
              <p className="text-sm text-ink-500">{bio.unavailableReason}</p>
            ) : (
              <div className="flex flex-wrap items-center gap-6">
                <div>
                  <div className="text-xs uppercase tracking-wide text-ink-400">Baseline</div>
                  <div className="text-xl font-semibold tabular-nums">
                    {dash(bio.baselineUnits)} units
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-ink-400">
                    Post-intervention
                  </div>
                  <div className="text-xl font-semibold tabular-nums">
                    {dash(bio.postInterventionUnits)} units
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-ink-400">Net gain</div>
                  <div
                    className={`text-xl font-semibold tabular-nums ${
                      bio.netLoss ? "text-red-700" : "text-emerald-700"
                    }`}
                  >
                    {bio.netGainPercent === null ? "—" : `${bio.netGainPercent}%`}
                  </div>
                </div>
                {bio.netLoss ? <Badge tone="red">Net habitat LOSS</Badge> : null}
                {bio.meetsTarget === true ? <Badge tone="green">Meets the test</Badge> : null}
                {bio.meetsTarget === false ? <Badge tone="amber">Below the test</Badge> : null}
                {bio.basis ? <p className="w-full text-xs text-ink-500">{bio.basis}</p> : null}
              </div>
            )}
          </CardBody>
        </Card>
      ) : null}

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

      {view === "monitoring" ? (
        <MonitoringPanel base={base} reference={reference} onChanged={loadSummary} />
      ) : null}
      {view === "incidents" ? (
        <IncidentPanel base={base} reference={reference} onChanged={loadSummary} />
      ) : null}
      {view === "biodiversity" ? (
        <BiodiversityPanel base={base} reference={reference} onChanged={loadSummary} />
      ) : null}
      {view === "ems" ? <EmsPanel base={base} reference={reference} /> : null}
    </div>
  );
}

/* ---------------------------- Monitoring --------------------------------- */

function MonitoringPanel({
  base,
  reference,
  onChanged,
}: {
  base: string;
  reference: Reference | null;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<PointRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<PointRow | null>(null);
  const [readings, setReadings] = useState<ReadingRow[] | null>(null);
  const [readingError, setReadingError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    medium: "dust",
    parameter: "",
    unit: "",
    limitValue: "",
    limitDirection: "max",
    limitBasis: "",
  });
  const [reading, setReading] = useState({ readingAt: "", value: "" });

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<PointRow>>(`${base}/monitoring-points?pageSize=200`);
      setRows(res.items);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load monitoring points");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const openPoint = useCallback(
    async (row: PointRow) => {
      setSelected(row);
      setReadings(null);
      setReadingError(null);
      try {
        const res = await api.get<{ items: ReadingRow[] }>(
          `${base}/monitoring-points/${row.id}/readings?pageSize=100`,
        );
        setReadings(res.items);
      } catch (err) {
        setReadings([]);
        setReadingError(err instanceof Error ? err.message : "Failed to load readings");
      }
    },
    [base],
  );

  async function createPoint() {
    setSaving(true);
    setError(null);
    try {
      await api.post(`${base}/monitoring-points`, {
        name: form.name,
        medium: form.medium,
        parameter: form.parameter,
        unit: form.unit,
        limitValue: form.limitValue === "" ? null : Number(form.limitValue),
        limitDirection: form.limitDirection,
        limitBasis: form.limitBasis || null,
      });
      setOpen(false);
      setForm({
        name: "",
        medium: "dust",
        parameter: "",
        unit: "",
        limitValue: "",
        limitDirection: "max",
        limitBasis: "",
      });
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the point");
    } finally {
      setSaving(false);
    }
  }

  async function addReading() {
    if (!selected) return;
    setSaving(true);
    setReadingError(null);
    try {
      await api.post(`${base}/monitoring-points/${selected.id}/readings`, {
        readingAt: reading.readingAt,
        value: Number(reading.value),
      });
      setReading({ readingAt: "", value: "" });
      await openPoint(selected);
      await load();
      onChanged();
    } catch (err) {
      setReadingError(err instanceof Error ? err.message : "Failed to record the reading");
    } finally {
      setSaving(false);
    }
  }

  const canCreate =
    form.name.trim() !== "" && form.parameter.trim() !== "" && form.unit.trim() !== "";
  const readingValue = Number(reading.value);
  const canAddReading = reading.readingAt !== "" && Number.isFinite(readingValue) && reading.value !== "";

  return (
    <Card>
      <CardHeader
        title="Consent-limit monitoring"
        subtitle="Points, their limits and the readings measured against them"
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            New point
          </Button>
        }
      />
      <CardBody>
        <ErrorAlert message={error} />
        {rows === null ? (
          <Spinner label="Loading monitoring points…" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No monitoring points"
            description="Add the points your environmental permit sets limits at — dust, noise, water — and record readings against them."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Point</Th>
                  <Th>Medium</Th>
                  <Th>Parameter</Th>
                  <Th className="text-right">Limit</Th>
                  <Th className="text-right">Readings</Th>
                  <Th className="text-right">Exceedances</Th>
                  <Th>Last reading</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className="cursor-pointer hover:bg-ink-50/60"
                    onClick={() => void openPoint(r)}
                  >
                    <Td className="font-medium text-ink-900">{r.name}</Td>
                    <Td className="text-ink-600">{MEDIUM_LABELS[r.medium] ?? humanize(r.medium)}</Td>
                    <Td className="text-ink-600">
                      {r.parameter} <span className="text-ink-400">({r.unit})</span>
                    </Td>
                    <Td className="whitespace-nowrap text-right tabular-nums">
                      {r.hasLimit ? (
                        <>
                          {r.limitDirection === "min" ? "≥ " : "≤ "}
                          {r.limitValue} {r.unit}
                        </>
                      ) : (
                        <span
                          className="text-ink-400"
                          title="No limit is recorded, so readings here are baseline observations and no compliance conclusion is drawn from them."
                        >
                          baseline only
                        </span>
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">{r.readingCount}</Td>
                    <Td className="text-right">
                      {r.exceedanceCount > 0 ? (
                        <Badge tone="red">{r.exceedanceCount}</Badge>
                      ) : (
                        <span className="tabular-nums text-ink-400">0</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-ink-500">
                      {r.lastReadingAt ? formatDate(r.lastReadingAt) : "—"}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </CardBody>

      <Modal open={open} onClose={() => setOpen(false)} title="New monitoring point">
        <div className="space-y-3">
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="MP-01 north boundary"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Medium">
              <Select
                value={form.medium}
                onChange={(e) => setForm({ ...form, medium: e.target.value })}
              >
                {(reference?.media ?? Object.keys(MEDIUM_LABELS)).map((m) => (
                  <option key={m} value={m}>
                    {MEDIUM_LABELS[m] ?? humanize(m)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Parameter">
              <Input
                value={form.parameter}
                onChange={(e) => setForm({ ...form, parameter: e.target.value })}
                placeholder="PM10"
              />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Unit">
              <Input
                value={form.unit}
                onChange={(e) => setForm({ ...form, unit: e.target.value })}
                placeholder="µg/m³"
              />
            </Field>
            <Field
              label="Limit"
              hint="Leave blank for a baseline point with no compliance test"
            >
              <Input
                type="number"
                value={form.limitValue}
                onChange={(e) => setForm({ ...form, limitValue: e.target.value })}
              />
            </Field>
            <Field label="Direction">
              <Select
                value={form.limitDirection}
                onChange={(e) => setForm({ ...form, limitDirection: e.target.value })}
              >
                <option value="max">Ceiling (≤)</option>
                <option value="min">Floor (≥)</option>
              </Select>
            </Field>
          </div>
          <Field label="Limit basis" hint="The permit condition or standard the limit comes from">
            <Input
              value={form.limitBasis}
              onChange={(e) => setForm({ ...form, limitBasis: e.target.value })}
              placeholder="Environmental permit condition 4.2"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void createPoint()} disabled={!canCreate || saving}>
              {saving ? "Saving…" : "Create point"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `${selected.name} — ${selected.parameter}` : ""}
        wide
      >
        {selected ? (
          <div className="space-y-4">
            <p className="text-sm text-ink-500">
              {selected.hasLimit
                ? `${selected.limitDirection === "min" ? "Floor" : "Ceiling"} of ${selected.limitValue} ${selected.unit}${
                    selected.limitBasis ? ` — ${selected.limitBasis}` : ""
                  }`
                : "No limit recorded: readings here are baseline observations."}
            </p>
            <div className="grid grid-cols-3 items-end gap-3 rounded-lg bg-ink-50 p-3">
              <Field label="Date">
                <Input
                  type="date"
                  value={reading.readingAt}
                  onChange={(e) => setReading({ ...reading, readingAt: e.target.value })}
                />
              </Field>
              <Field label={`Value (${selected.unit})`}>
                <Input
                  type="number"
                  value={reading.value}
                  onChange={(e) => setReading({ ...reading, value: e.target.value })}
                />
              </Field>
              <Button onClick={() => void addReading()} disabled={!canAddReading || saving}>
                Record
              </Button>
            </div>
            <ErrorAlert message={readingError} />
            {readings === null ? (
              <Spinner label="Loading readings…" />
            ) : readings.length === 0 ? (
              <EmptyState title="No readings" description="Record the first observation above." />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <thead>
                    <tr>
                      <Th>Date</Th>
                      <Th className="text-right">Value</Th>
                      <Th className="text-right">% of limit</Th>
                      <Th>Verdict</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {readings.map((r) => (
                      <tr key={r.id}>
                        <Td className="whitespace-nowrap text-xs text-ink-500">
                          {formatDate(r.readingAt)}
                        </Td>
                        <Td className="text-right tabular-nums">
                          {r.value} {selected.unit}
                        </Td>
                        <Td className="text-right tabular-nums">
                          {r.percentOfLimit === null ? (
                            <span className="text-ink-400">—</span>
                          ) : (
                            `${r.percentOfLimit}%`
                          )}
                        </Td>
                        <Td>
                          {!selected.hasLimit ? (
                            <span className="text-xs text-ink-400">baseline observation</span>
                          ) : r.exceedanceBool ? (
                            <Badge tone="red">
                              exceeded by {r.exceedanceBy} {selected.unit}
                            </Badge>
                          ) : (
                            <Badge tone="green">within limit</Badge>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </Card>
  );
}

/* ---------------------------- Incidents ---------------------------------- */

function IncidentPanel({
  base,
  reference,
  onChanged,
}: {
  base: string;
  reference: Reference | null;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<IncidentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<IncidentRow | null>(null);
  const [regulator, setRegulator] = useState("");
  const [rootCause, setRootCause] = useState("");
  const [form, setForm] = useState({
    kind: "spill",
    severity: "medium",
    occurredAt: "",
    description: "",
    quantity: "",
    unit: "",
    reportableToRegulator: false,
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<IncidentRow>>(
        `${base}/environmental-incidents?pageSize=200`,
      );
      setRows(res.items);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load incidents");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setSaving(true);
    setError(null);
    try {
      await api.post(`${base}/environmental-incidents`, {
        kind: form.kind,
        severity: form.severity,
        occurredAt: form.occurredAt,
        description: form.description,
        quantity: form.quantity === "" ? null : Number(form.quantity),
        unit: form.unit || null,
        reportableToRegulator: form.reportableToRegulator,
      });
      setOpen(false);
      setForm({
        kind: "spill",
        severity: "medium",
        occurredAt: "",
        description: "",
        quantity: "",
        unit: "",
        reportableToRegulator: false,
      });
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record the incident");
    } finally {
      setSaving(false);
    }
  }

  async function act(path: string, payload: Record<string, unknown>) {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`${base}/environmental-incidents/${selected.id}/${path}`, payload);
      setSelected(null);
      setRegulator("");
      setRootCause("");
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The action was refused");
    } finally {
      setSaving(false);
    }
  }

  const next = selected ? NEXT_STATUS[selected.status] : null;

  return (
    <Card>
      <CardHeader
        title="Environmental incidents"
        subtitle={
          reference
            ? `Spills, discharges and habitat damage — statutory notification window ${reference.regulatorNotificationHours} hours`
            : "Spills, discharges and habitat damage"
        }
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            Record incident
          </Button>
        }
      />
      <CardBody>
        <ErrorAlert message={error} />
        {rows === null ? (
          <Spinner label="Loading incidents…" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No environmental incidents"
            description="Nothing has been recorded on this project. A clean register only means something if incidents are actually being reported."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Ref</Th>
                  <Th>Kind</Th>
                  <Th>Occurred</Th>
                  <Th>Severity</Th>
                  <Th className="text-right">Quantity</Th>
                  <Th>Regulator</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className="cursor-pointer hover:bg-ink-50/60"
                    onClick={() => setSelected(r)}
                  >
                    <Td className="whitespace-nowrap font-medium tabular-nums text-ink-900">
                      EI-{r.number}
                    </Td>
                    <Td className="text-ink-600">{humanize(r.kind)}</Td>
                    <Td className="whitespace-nowrap text-xs text-ink-500">
                      {formatDate(r.occurredAt)}
                    </Td>
                    <Td>
                      <Badge
                        tone={
                          r.severity === "critical" || r.severity === "high"
                            ? "red"
                            : r.severity === "medium"
                              ? "amber"
                              : "gray"
                        }
                      >
                        {r.severity}
                      </Badge>
                    </Td>
                    <Td className="whitespace-nowrap text-right tabular-nums">
                      {r.quantity === null ? (
                        <span className="text-ink-400">—</span>
                      ) : (
                        `${r.quantity} ${r.unit ?? ""}`
                      )}
                    </Td>
                    <Td>
                      {!r.reportableBool ? (
                        <span className="text-xs text-ink-400">not reportable</span>
                      ) : r.notified ? (
                        <Badge tone="green">notified</Badge>
                      ) : r.notificationOverdue ? (
                        <Badge tone="red">overdue</Badge>
                      ) : (
                        <Badge tone="amber">due</Badge>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={INCIDENT_STATUS_TONE[r.status] ?? "gray"}>
                        {humanize(r.status)}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </CardBody>

      <Modal open={open} onClose={() => setOpen(false)} title="Record an environmental incident">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Kind">
              <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {(reference?.incidentKinds ?? ["spill", "discharge", "emission", "other"]).map(
                  (k) => (
                    <option key={k} value={k}>
                      {humanize(k)}
                    </option>
                  ),
                )}
              </Select>
            </Field>
            <Field label="Severity">
              <Select
                value={form.severity}
                onChange={(e) => setForm({ ...form, severity: e.target.value })}
              >
                {["low", "medium", "high", "critical"].map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Occurred on">
            <Input
              type="date"
              value={form.occurredAt}
              onChange={(e) => setForm({ ...form, occurredAt: e.target.value })}
            />
          </Field>
          <Field label="Description">
            <Textarea
              rows={3}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantity">
              <Input
                type="number"
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              />
            </Field>
            <Field label="Unit">
              <Input
                value={form.unit}
                onChange={(e) => setForm({ ...form, unit: e.target.value })}
                placeholder="litre"
              />
            </Field>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.reportableToRegulator}
              onChange={(e) => setForm({ ...form, reportableToRegulator: e.target.checked })}
              className="mt-0.5"
            />
            <span>
              Reportable to the regulator
              <span className="block text-xs text-ink-500">
                Opens a notification obligation with the statutory clock running from the incident.
              </span>
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void create()}
              disabled={saving || form.occurredAt === "" || form.description.trim() === ""}
            >
              {saving ? "Saving…" : "Record"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `EI-${selected.number} — ${humanize(selected.kind)}` : ""}
      >
        {selected ? (
          <div className="space-y-4">
            <p className="text-sm">{selected.description}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-ink-500">Occurred</dt>
              <dd>{formatDate(selected.occurredAt)}</dd>
              <dt className="text-ink-500">Status</dt>
              <dd>{humanize(selected.status)}</dd>
              <dt className="text-ink-500">Regulator</dt>
              <dd>
                {selected.regulatorNotifiedAt
                  ? `${selected.regulator ?? "notified"} — ${formatDate(selected.regulatorNotifiedAt)}`
                  : selected.reportableBool
                    ? "not yet notified"
                    : "not reportable"}
              </dd>
              <dt className="text-ink-500">Root cause</dt>
              <dd>{selected.rootCause ?? <span className="text-ink-400">—</span>}</dd>
            </dl>

            {selected.reportableBool && !selected.notified ? (
              <div className="space-y-2 rounded-lg bg-amber-50 p-3 ring-1 ring-amber-200">
                <Field label="Regulator notified">
                  <Input
                    value={regulator}
                    onChange={(e) => setRegulator(e.target.value)}
                    placeholder="Environment Agency"
                  />
                </Field>
                <Button
                  size="sm"
                  onClick={() => void act("notify", { regulator })}
                  disabled={regulator.trim() === "" || saving}
                >
                  Record notification
                </Button>
              </div>
            ) : null}

            {next ? (
              <div className="space-y-2">
                {next === "closed" ? (
                  <Field label="Root cause" hint="Required to close an environmental incident">
                    <Textarea
                      rows={2}
                      value={rootCause}
                      onChange={(e) => setRootCause(e.target.value)}
                    />
                  </Field>
                ) : null}
                <Button
                  size="sm"
                  onClick={() =>
                    void act("status", {
                      status: next,
                      ...(rootCause ? { rootCause } : {}),
                    })
                  }
                  disabled={
                    saving ||
                    (next === "closed" && rootCause.trim() === "" && !selected.rootCause)
                  }
                >
                  Mark {humanize(next)}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </Card>
  );
}

/* --------------------------- Biodiversity -------------------------------- */

function BiodiversityPanel({
  base,
  reference,
  onChanged,
}: {
  base: string;
  reference: Reference | null;
  onChanged: () => void;
}) {
  const [data, setData] = useState<BiodiversityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    stage: "baseline",
    habitatType: "",
    areaHectares: "",
    distinctiveness: "2",
    condition: "moderate",
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<BiodiversityResponse>(`${base}/biodiversity-units`));
    } catch (err) {
      setData({ items: [], total: 0, byStage: [], netGain: null });
      setError(err instanceof Error ? err.message : "Failed to load habitat units");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setSaving(true);
    setError(null);
    try {
      await api.post(`${base}/biodiversity-units`, {
        stage: form.stage,
        habitatType: form.habitatType,
        areaHectares: Number(form.areaHectares),
        distinctiveness: Number(form.distinctiveness),
        condition: form.condition,
      });
      setOpen(false);
      setForm({ ...form, habitatType: "", areaHectares: "" });
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record the habitat");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Biodiversity units"
        subtitle="area × distinctiveness × condition × strategic significance"
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            Add habitat
          </Button>
        }
      />
      <CardBody>
        <ErrorAlert message={error} />
        {data === null ? (
          <Spinner label="Loading habitat units…" />
        ) : data.items.length === 0 ? (
          <EmptyState
            title="No habitat records"
            description="Record the baseline survey first: net gain is measured against it, and without a baseline no gain figure can be stated at all."
          />
        ) : (
          <>
            {data.netGain ? (
              <div className="mb-4 rounded-lg bg-ink-50 p-3 text-sm">
                <div className="mb-2 flex flex-wrap items-center gap-3">
                  <span className="font-medium">
                    Net change {data.netGain.netChangeUnits} units
                  </span>
                  {data.netGain.netGainPercent === null ? (
                    <Badge tone="gray">gain not computable</Badge>
                  ) : data.netGain.netLoss ? (
                    <Badge tone="red">{data.netGain.netGainPercent}% — net loss</Badge>
                  ) : (
                    <Badge tone="green">{data.netGain.netGainPercent}%</Badge>
                  )}
                </div>
                <Meter
                  percent={Math.max(0, Math.min(100, data.netGain.netGainPercent ?? 0))}
                  tone={data.netGain.netLoss ? "red" : "green"}
                />
                <p className="mt-2 text-xs text-ink-500">{data.netGain.basis}</p>
              </div>
            ) : null}
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Stage</Th>
                    <Th>Habitat</Th>
                    <Th className="text-right">Area (ha)</Th>
                    <Th className="text-right">Distinctiveness</Th>
                    <Th>Condition</Th>
                    <Th className="text-right">Units</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {data.items.map((r) => (
                    <tr key={r.id}>
                      <Td className="text-ink-600">{humanize(r.stage)}</Td>
                      <Td className="text-ink-900">{r.habitatType}</Td>
                      <Td className="text-right tabular-nums">{r.areaHectares}</Td>
                      <Td className="text-right tabular-nums">{r.distinctiveness}</Td>
                      <Td className="text-ink-600">
                        {humanize(r.condition)} ({r.conditionScore})
                      </Td>
                      <Td className="text-right font-medium tabular-nums">{r.units}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </>
        )}
      </CardBody>

      <Modal open={open} onClose={() => setOpen(false)} title="Add a habitat record">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Stage">
              <Select
                value={form.stage}
                onChange={(e) => setForm({ ...form, stage: e.target.value })}
              >
                {(reference?.biodiversityStages ?? ["baseline", "post_intervention", "target"]).map(
                  (s) => (
                    <option key={s} value={s}>
                      {humanize(s)}
                    </option>
                  ),
                )}
              </Select>
            </Field>
            <Field label="Habitat type">
              <Input
                value={form.habitatType}
                onChange={(e) => setForm({ ...form, habitatType: e.target.value })}
                placeholder="Modified grassland"
              />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Area (ha)">
              <Input
                type="number"
                value={form.areaHectares}
                onChange={(e) => setForm({ ...form, areaHectares: e.target.value })}
              />
            </Field>
            <Field label="Distinctiveness">
              <Input
                type="number"
                value={form.distinctiveness}
                onChange={(e) => setForm({ ...form, distinctiveness: e.target.value })}
              />
            </Field>
            <Field label="Condition">
              <Select
                value={form.condition}
                onChange={(e) => setForm({ ...form, condition: e.target.value })}
              >
                {(reference?.habitatConditions ?? ["poor", "moderate", "good", "n_a"]).map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void create()}
              disabled={saving || form.habitatType.trim() === "" || form.areaHectares === ""}
            >
              {saving ? "Saving…" : "Add"}
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

/* ------------------------------- EMS ------------------------------------- */

function EmsPanel({ base, reference }: { base: string; reference: Reference | null }) {
  const [data, setData] = useState<EmsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ clause: "", requirement: "" });

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<EmsResponse>(`${base}/ems-records`));
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : "Failed to load the EMS register");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setSaving(true);
    setError(null);
    try {
      await api.post(`${base}/ems-records`, form);
      setOpen(false);
      setForm({ clause: "", requirement: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add the record");
    } finally {
      setSaving(false);
    }
  }

  const clauses = reference?.iso14001Clauses ?? [];
  const unused = clauses.filter((c) => !(data?.items ?? []).some((i) => i.clause === c));

  return (
    <Card>
      <CardHeader
        title="ISO 14001 evidence"
        subtitle="One row per clause — the gaps are as informative as the entries"
        actions={
          <Button size="sm" onClick={() => setOpen(true)} disabled={unused.length === 0}>
            Add clause
          </Button>
        }
      />
      <CardBody>
        <ErrorAlert message={error} />
        {data === null ? (
          error ? null : <Spinner label="Loading the EMS register…" />
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-4 text-sm">
              <span>
                <span className="font-semibold tabular-nums">{data.evidenced}</span> of{" "}
                <span className="tabular-nums">{data.clauses}</span> clauses evidenced
              </span>
              {data.coveragePercent !== null ? (
                <span className="w-40">
                  <Meter percent={data.coveragePercent} tone="brand" size="sm" />
                </span>
              ) : null}
              {data.nonconforming > 0 ? (
                <Badge tone="red">{data.nonconforming} nonconforming</Badge>
              ) : null}
            </div>
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Clause</Th>
                    <Th>Requirement</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Attached</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {data.coverage.map((c) => (
                    <tr key={c.clause}>
                      <Td className="whitespace-nowrap font-mono text-xs text-ink-600">
                        {c.clause}
                      </Td>
                      <Td className="text-ink-700">
                        {c.record?.requirement ?? (
                          <span className="text-ink-400">not documented on this project</span>
                        )}
                      </Td>
                      <Td>
                        <Badge tone={EMS_TONE[c.status] ?? "gray"}>{humanize(c.status)}</Badge>
                      </Td>
                      <Td className="text-right tabular-nums">
                        {c.record ? (
                          c.record.evidenceIds.length + c.record.fileIds.length
                        ) : (
                          <span className="text-ink-400">—</span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </>
        )}
      </CardBody>

      <Modal open={open} onClose={() => setOpen(false)} title="Document an ISO 14001 clause">
        <div className="space-y-3">
          <Field label="Clause">
            <Select
              value={form.clause}
              onChange={(e) => setForm({ ...form, clause: e.target.value })}
            >
              <option value="">Select a clause…</option>
              {unused.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Requirement">
            <Textarea
              rows={3}
              value={form.requirement}
              onChange={(e) => setForm({ ...form, requirement: e.target.value })}
              placeholder="Aspects and impacts register maintained and reviewed quarterly"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void create()}
              disabled={saving || form.clause === "" || form.requirement.trim() === ""}
            >
              {saving ? "Saving…" : "Add"}
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}
