import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  ErrorAlert,
  Field,
  Input,
  PageHeader,
  Spinner,
  Textarea,
  statusTone,
} from "../../ui";
import { humanize } from "../format";
import { addDaysIso, todayIso, useCompanyUsers } from "../rfis/fieldShared";

type EditRow = Record<string, string>;

interface ColDef {
  key: string;
  label: string;
  type: "text" | "number";
  required?: boolean;
  placeholder?: string;
  width?: string;
}

const MANPOWER_COLS: ColDef[] = [
  { key: "company", label: "Company", type: "text", required: true, placeholder: "Acme Concrete" },
  { key: "workers", label: "Workers", type: "number", width: "w-24" },
  { key: "hours", label: "Hours", type: "number", width: "w-24" },
];
const EQUIPMENT_COLS: ColDef[] = [
  { key: "name", label: "Equipment", type: "text", required: true, placeholder: "Tower crane TC-1" },
  { key: "hoursOperating", label: "Operating h", type: "number", width: "w-28" },
  { key: "hoursIdle", label: "Idle h", type: "number", width: "w-24" },
];
const DELIVERY_COLS: ColDef[] = [
  { key: "supplier", label: "Supplier", type: "text", required: true, placeholder: "Steel Co." },
  {
    key: "description",
    label: "Description",
    type: "text",
    required: true,
    placeholder: "12t rebar, grade 60",
  },
  { key: "trackingRef", label: "Ref", type: "text", width: "w-32", placeholder: "PO-1042" },
];
const DELAY_COLS: ColDef[] = [
  { key: "cause", label: "Cause", type: "text", required: true, placeholder: "Weather" },
  {
    key: "description",
    label: "Description",
    type: "text",
    required: true,
    placeholder: "High winds stopped crane picks",
  },
  { key: "hoursLost", label: "Hours lost", type: "number", width: "w-28" },
];

interface DailyLog {
  id: string;
  logDate: string;
  status: string;
  weather: Record<string, unknown> | null;
  sections: Record<string, unknown>;
  notes: string | null;
  aiDrafted: number;
  createdBy: string;
  approvedBy: string | null;
  updatedAt: string;
  others?: number;
}

function rowsFromSection(sections: Record<string, unknown>, key: string, cols: ColDef[]): EditRow[] {
  const raw = sections[key];
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const rec = (entry ?? {}) as Record<string, unknown>;
    const row: EditRow = {};
    for (const c of cols) {
      const v = rec[c.key];
      row[c.key] = v === null || v === undefined ? "" : String(v);
    }
    return row;
  });
}

function rowsToSection(rows: EditRow[], cols: ColDef[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const hasAny = cols.some((c) => (row[c.key] ?? "").trim() !== "");
    if (!hasAny) continue;
    const missingRequired = cols.some((c) => c.required && (row[c.key] ?? "").trim() === "");
    if (missingRequired) continue;
    const rec: Record<string, unknown> = {};
    for (const c of cols) {
      const v = (row[c.key] ?? "").trim();
      if (v === "") {
        if (c.type === "number" && (c.key === "workers" || c.key === "hours" || c.key === "hoursOperating" || c.key === "hoursIdle")) {
          rec[c.key] = 0; // required numerics default to zero
        }
        continue;
      }
      rec[c.key] = c.type === "number" ? Math.max(0, Number(v) || 0) : v;
    }
    out.push(rec);
  }
  return out;
}

function SectionEditor({
  title,
  cols,
  rows,
  setRows,
  disabled,
}: {
  title: string;
  cols: ColDef[];
  rows: EditRow[];
  setRows: (rows: EditRow[]) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">{title}</h3>
        {!disabled ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setRows([...rows, Object.fromEntries(cols.map((c) => [c.key, ""])) as EditRow])
            }
          >
            + Add row
          </Button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-ink-200 px-3 py-2 text-xs text-ink-400">
          Nothing recorded.
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              {cols.map((c) => (
                <div key={c.key} className={c.width ?? "min-w-40 flex-1"}>
                  <Input
                    type={c.type}
                    min={c.type === "number" ? "0" : undefined}
                    step={c.type === "number" ? "any" : undefined}
                    placeholder={c.placeholder ?? c.label}
                    value={row[c.key] ?? ""}
                    disabled={disabled}
                    onChange={(e) =>
                      setRows(rows.map((r, j) => (j === i ? { ...r, [c.key]: e.target.value } : r)))
                    }
                  />
                </div>
              ))}
              {!disabled ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                  aria-label="Remove row"
                >
                  ✕
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DailyLogsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const base = `/api/v1/projects/${projectId}/daily-logs`;
  const { nameOf } = useCompanyUsers();
  const today = todayIso();

  const [date, setDate] = useState(today);
  const [log, setLog] = useState<DailyLog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const [missing, setMissing] = useState<string[]>([]);

  // Editor state
  const [manpower, setManpower] = useState<EditRow[]>([]);
  const [equipment, setEquipment] = useState<EditRow[]>([]);
  const [deliveries, setDeliveries] = useState<EditRow[]>([]);
  const [delays, setDelays] = useState<EditRow[]>([]);
  const [notes, setNotes] = useState("");
  const [temp, setTemp] = useState("");
  const [conditions, setConditions] = useState("");
  const [wind, setWind] = useState("");
  const [precip, setPrecip] = useState("");

  const hydrate = useCallback((l: DailyLog | null) => {
    setLog(l);
    const sections = l?.sections ?? {};
    setManpower(rowsFromSection(sections, "manpower", MANPOWER_COLS));
    setEquipment(rowsFromSection(sections, "equipment", EQUIPMENT_COLS));
    setDeliveries(rowsFromSection(sections, "deliveries", DELIVERY_COLS));
    setDelays(rowsFromSection(sections, "delays", DELAY_COLS));
    setNotes(l?.notes ?? "");
    const w = (l?.weather ?? {}) as Record<string, unknown>;
    setTemp(w["tempC"] !== undefined && w["tempC"] !== null ? String(w["tempC"]) : "");
    setConditions(typeof w["conditions"] === "string" ? w["conditions"] : "");
    setWind(w["windKph"] !== undefined && w["windKph"] !== null ? String(w["windKph"]) : "");
    setPrecip(
      w["precipitationMm"] !== undefined && w["precipitationMm"] !== null
        ? String(w["precipitationMm"])
        : "",
    );
  }, []);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    setSavedAt(null);
    try {
      const res = await api.get<DailyLog>(`${base}/${date}`);
      hydrate(res);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) {
        hydrate(null);
      } else {
        hydrate(null);
        setError(err instanceof Error ? err.message : "Failed to load the daily log");
      }
    } finally {
      setLoading(false);
    }
  }, [base, projectId, date, hydrate]);

  useEffect(() => {
    void load();
  }, [load]);

  // Missing business days for the month of the selected date (capped at today).
  useEffect(() => {
    if (!projectId) return;
    const from = `${date.slice(0, 8)}01`;
    const nextMonth = addDaysIso(`${date.slice(0, 8)}28`, 4);
    const monthEnd = addDaysIso(`${nextMonth.slice(0, 8)}01`, -1);
    const to = monthEnd < today ? monthEnd : today;
    if (from > to) {
      setMissing([]);
      return;
    }
    api
      .get<{ days: string[] }>(`${base}/missing?from=${from}&to=${to}`)
      .then((res) => setMissing(res.days))
      .catch(() => setMissing([]));
  }, [base, projectId, date, today, savedAt]);

  const status = log?.status ?? "none";
  const editable = log === null || status === "draft";

  function buildPayload() {
    const weather: Record<string, unknown> = {};
    if (temp.trim() !== "") weather["tempC"] = Number(temp);
    if (conditions.trim() !== "") weather["conditions"] = conditions.trim();
    if (wind.trim() !== "") weather["windKph"] = Math.max(0, Number(wind) || 0);
    if (precip.trim() !== "") weather["precipitationMm"] = Math.max(0, Number(precip) || 0);
    return {
      sections: {
        manpower: rowsToSection(manpower, MANPOWER_COLS),
        equipment: rowsToSection(equipment, EQUIPMENT_COLS),
        deliveries: rowsToSection(deliveries, DELIVERY_COLS),
        delays: rowsToSection(delays, DELAY_COLS),
      },
      weather: Object.keys(weather).length > 0 ? weather : null,
      notes: notes.trim() !== "" ? notes : null,
    };
  }

  async function onSave(): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await api.put<DailyLog>(`${base}/${date}`, buildPayload());
      hydrate(res);
      setSavedAt(new Date().toISOString());
      return true;
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to save the daily log");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit() {
    const saved = await onSave();
    if (!saved) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<DailyLog>(`${base}/${date}/submit`);
      hydrate(res);
      setSavedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to submit the daily log");
    } finally {
      setBusy(false);
    }
  }

  async function onApprove() {
    if (!log) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<DailyLog>(`${base}/${date}/approve`, {
        createdBy: log.createdBy,
      });
      hydrate(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to approve the daily log");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Daily Logs"
        subtitle="Site diary — weather, manpower, equipment, deliveries and delays"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setDate(addDaysIso(date, -1))}>
              ← Prev
            </Button>
            <div className="w-40">
              <Input
                type="date"
                value={date}
                max={today}
                onChange={(e) => {
                  if (e.target.value) setDate(e.target.value);
                }}
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={date >= today}
              onClick={() => setDate(addDaysIso(date, 1))}
            >
              Next →
            </Button>
            {date !== today ? (
              <Button variant="ghost" size="sm" onClick={() => setDate(today)}>
                Today
              </Button>
            ) : null}
          </div>
        }
      />

      {missing.length > 0 ? (
        <div className="mb-4 rounded-md bg-amber-50 px-3 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200">
          <span className="font-medium">
            {missing.length} business day{missing.length === 1 ? "" : "s"} this month without a
            submitted log:
          </span>{" "}
          <span className="inline-flex flex-wrap gap-1 align-middle">
            {missing.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDate(d)}
                className={`rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-amber-300 hover:bg-amber-100 ${
                  d === date ? "bg-amber-200" : "bg-white/70"
                }`}
              >
                {d.slice(8)}
              </button>
            ))}
          </span>
        </div>
      ) : null}

      <ErrorAlert message={error} />

      {loading ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <Card>
            <CardBody className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-ink-900">{date}</span>
                {log === null ? (
                  <Badge tone="gray">Not started</Badge>
                ) : (
                  <Badge tone={statusTone(status)}>{humanize(status)}</Badge>
                )}
                {log?.aiDrafted === 1 ? <Badge tone="violet">AI drafted</Badge> : null}
                {log ? (
                  <span className="text-xs text-ink-400">
                    by {nameOf(log.createdBy)}
                    {log.approvedBy ? ` · approved by ${nameOf(log.approvedBy)}` : ""}
                    {log.others && log.others > 0
                      ? ` · ${log.others} other log${log.others === 1 ? "" : "s"} for this date`
                      : ""}
                  </span>
                ) : null}
                {savedAt ? <span className="text-xs text-emerald-600">Saved ✓</span> : null}
              </div>
              <div className="flex items-center gap-2">
                {editable ? (
                  <>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onSave()}>
                      {busy ? "Saving…" : "Save draft"}
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => void onSubmit()}>
                      Submit
                    </Button>
                  </>
                ) : null}
                {status === "submitted" ? (
                  <Button size="sm" disabled={busy} onClick={() => void onApprove()}>
                    Approve
                  </Button>
                ) : null}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Weather
              </h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label="Temperature (°C)">
                  <Input
                    type="number"
                    step="any"
                    value={temp}
                    disabled={!editable}
                    onChange={(e) => setTemp(e.target.value)}
                  />
                </Field>
                <Field label="Conditions">
                  <Input
                    value={conditions}
                    disabled={!editable}
                    placeholder="Overcast, light rain"
                    onChange={(e) => setConditions(e.target.value)}
                  />
                </Field>
                <Field label="Wind (km/h)">
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    value={wind}
                    disabled={!editable}
                    onChange={(e) => setWind(e.target.value)}
                  />
                </Field>
                <Field label="Precipitation (mm)">
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    value={precip}
                    disabled={!editable}
                    onChange={(e) => setPrecip(e.target.value)}
                  />
                </Field>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody className="space-y-5">
              <SectionEditor
                title="Manpower"
                cols={MANPOWER_COLS}
                rows={manpower}
                setRows={setManpower}
                disabled={!editable}
              />
              <SectionEditor
                title="Equipment on site"
                cols={EQUIPMENT_COLS}
                rows={equipment}
                setRows={setEquipment}
                disabled={!editable}
              />
              <SectionEditor
                title="Deliveries"
                cols={DELIVERY_COLS}
                rows={deliveries}
                setRows={setDeliveries}
                disabled={!editable}
              />
              <SectionEditor
                title="Delays"
                cols={DELAY_COLS}
                rows={delays}
                setRows={setDelays}
                disabled={!editable}
              />
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Notes & observations
              </h3>
              <Textarea
                value={notes}
                disabled={!editable}
                placeholder="General observations, site conditions, instructions received…"
                onChange={(e) => setNotes(e.target.value)}
              />
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}
