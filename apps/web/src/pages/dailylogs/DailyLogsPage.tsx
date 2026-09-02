/**
 * Daily log workspace — spec Vol I §2.7.
 *
 *   Log         MY diary for the date (or a read-only view of someone else's,
 *               never passed off as mine — audit: DailyLogsPage.tsx:272),
 *               every section, weather with provenance, approve/export/
 *               carry-forward/reconcile
 *   Site day    every creator's submitted log for the date, consolidated
 *   Compliance  submitted-vs-expected business days per creator, missing days
 *   Templates   default rows applied on the first save of a day
 *
 * Saving sends ONLY the sections the user touched; the API merges by key, so
 * a section this page did not render (or did not edit) is never wiped
 * (audit: DailyLogsPage.tsx:281).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { Alert, Badge, Button, Card, CardBody, EmptyState, ErrorAlert, Field, Input, Modal, PageHeader, Select, Skeleton, Stat, Tabs, Textarea, statusTone } from "../../ui";
import { IconDailyLog } from "../../ui/icons";
import { formatDateTime, humanize } from "../format";
import { DASH, addDaysIso, errorMessage, fetchBlob, openBlob, qs, todayIso, useCompanyUsers, useFieldResource, useMe, type ListResponse } from "../rfis/fieldShared";

type EditRow = Record<string, string>;

interface ColDef {
  key: string;
  label: string;
  type: "text" | "number" | "int" | "select";
  required?: boolean;
  placeholder?: string;
  width?: string;
  options?: string[];
}

const SECTIONS: Array<{ key: string; title: string; cols: ColDef[] }> = [
  { key: "manpower", title: "Manpower", cols: [
    { key: "company", label: "Company", type: "text", required: true, placeholder: "Acme Concrete" },
    { key: "trade", label: "Trade", type: "text", width: "w-32", placeholder: "Formwork" },
    { key: "workers", label: "Workers", type: "int", width: "w-24" },
    { key: "hours", label: "Hours", type: "number", width: "w-24" },
  ] },
  { key: "equipment", title: "Equipment on site", cols: [
    { key: "name", label: "Equipment", type: "text", required: true, placeholder: "Tower crane TC-1" },
    { key: "hoursOperating", label: "Operating h", type: "number", width: "w-28" },
    { key: "hoursIdle", label: "Idle h", type: "number", width: "w-24" },
  ] },
  { key: "deliveries", title: "Deliveries", cols: [
    { key: "supplier", label: "Supplier", type: "text", required: true, placeholder: "Steel Co." },
    { key: "description", label: "Description", type: "text", required: true, placeholder: "12t rebar, grade 60" },
    { key: "trackingRef", label: "Ref", type: "text", width: "w-32", placeholder: "PO-1042" },
    { key: "time", label: "Time", type: "text", width: "w-20", placeholder: "09:30" },
  ] },
  { key: "visitors", title: "Visitors", cols: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "company", label: "Company", type: "text" },
    { key: "reason", label: "Reason", type: "text" },
    { key: "time", label: "Time", type: "text", width: "w-20" },
  ] },
  { key: "delays", title: "Delays", cols: [
    { key: "cause", label: "Cause", type: "text", required: true, placeholder: "Weather" },
    { key: "description", label: "Description", type: "text", required: true, placeholder: "High winds stopped crane picks" },
    { key: "hoursLost", label: "Hours lost", type: "number", width: "w-28" },
  ] },
  { key: "quantities", title: "Quantities installed", cols: [
    { key: "costCode", label: "Cost code", type: "text", width: "w-28" },
    { key: "description", label: "Description", type: "text", required: true },
    { key: "qty", label: "Qty", type: "number", width: "w-24" },
    { key: "unit", label: "Unit", type: "text", required: true, width: "w-20", placeholder: "m3" },
  ] },
  { key: "inspections", title: "Inspections", cols: [
    { key: "inspector", label: "Inspector", type: "text", required: true },
    { key: "agency", label: "Agency", type: "text" },
    { key: "subject", label: "Subject", type: "text", required: true },
    { key: "outcome", label: "Outcome", type: "select", width: "w-28", options: ["pass", "fail", "partial", "pending"] },
  ] },
  { key: "safetyViolations", title: "Safety violations", cols: [
    { key: "subject", label: "Subject", type: "text", required: true },
    { key: "description", label: "Description", type: "text" },
    { key: "issuedTo", label: "Issued to", type: "text", width: "w-40" },
  ] },
  { key: "incidents", title: "Incidents", cols: [
    { key: "title", label: "Title", type: "text", required: true },
    { key: "description", label: "Description", type: "text" },
    { key: "incidentId", label: "Incident ref", type: "text", width: "w-36", placeholder: "safety module id" },
  ] },
  { key: "waste", title: "Waste", cols: [
    { key: "material", label: "Material", type: "text", required: true },
    { key: "qty", label: "Qty", type: "number", width: "w-24" },
    { key: "unit", label: "Unit", type: "text", required: true, width: "w-20" },
    { key: "disposal", label: "Disposal", type: "text" },
  ] },
  { key: "calls", title: "Calls & correspondence", cols: [
    { key: "with", label: "With", type: "text", required: true },
    { key: "subject", label: "Subject", type: "text", required: true },
    { key: "summary", label: "Summary", type: "text" },
  ] },
];

const REQUIRED_NUMERICS = new Set(["workers", "hours", "hoursOperating", "hoursIdle", "qty"]);

interface DailyLog {
  id: string;
  logDate: string;
  status: string;
  weather: Record<string, unknown> | null;
  weatherSource: string | null;
  weatherProvider: string | null;
  weatherFetchedAt: string | null;
  sections: Record<string, unknown>;
  notes: string | null;
  aiDrafted: number;
  logKind: string;
  vendorId: string | null;
  templateId: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  distributedTo: string[];
  createdBy: string;
  approvedBy: string | null;
  updatedAt: string;
}

interface LogSummary {
  id: string;
  createdBy: string;
  status: string;
  logKind: string;
  vendorId: string | null;
  aiDrafted: number;
  updatedAt: string;
}

interface DateResponse {
  date: string;
  log: DailyLog | null;
  isMine: boolean;
  hasOwn: boolean;
  logs: LogSummary[];
}

interface Consolidated {
  date: string;
  logs: LogSummary[];
  submittedOrApproved: number;
  manpower: Array<{ company: string; workers: number; hours: number; sources: number }>;
  totalWorkers: number;
  totalHours: number;
  equipment: Array<{ name: string; hoursOperating: number; hoursIdle: number; sources: number }>;
  delays: Array<{ cause: string; description: string; hoursLost: number; reportedBy: string }>;
  totalHoursLost: number;
  deliveries: Array<{ supplier: string; description: string; reportedBy: string }>;
  visitors: Array<{ name: string; company: string; reportedBy: string }>;
  weather: Record<string, unknown> | null;
  draftCreators: string[];
  people: Record<string, string>;
}

interface Compliance {
  from: string;
  to: string;
  expectedDays: number;
  items: Array<{ createdBy: string; name: string | null; logKind: string; expected: number; submitted: number; missing: string[]; pct: number | null }>;
  basis: string;
}

interface Template {
  id: string;
  name: string;
  sections: Record<string, unknown>;
  isDefault: number;
  createdBy: string;
}

interface Reconciliation {
  date: string;
  logs: number;
  thresholdPct: number;
  variances: Array<{ key: string; loggedHours: number; timecardHours: number; varianceHours: number; variancePct: number | null; flagged: boolean }>;
  signalsRaised: number;
  reasons: string[];
  basis?: string;
}

type TabKey = "log" | "siteDay" | "compliance" | "templates";
const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "log", label: "Log" },
  { value: "siteDay", label: "Site day" },
  { value: "compliance", label: "Compliance" },
  { value: "templates", label: "Templates" },
];

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
    const rec: Record<string, unknown> = {};
    for (const c of cols) {
      const v = (row[c.key] ?? "").trim();
      if (v === "") {
        if ((c.type === "number" || c.type === "int") && REQUIRED_NUMERICS.has(c.key)) rec[c.key] = 0;
        continue;
      }
      if (c.type === "int") rec[c.key] = Math.max(0, Math.round(Number(v) || 0));
      else if (c.type === "number") rec[c.key] = Math.max(0, Number(v) || 0);
      else rec[c.key] = v;
    }
    out.push(rec);
  }
  return out;
}

function validateRows(rows: EditRow[], cols: ColDef[], title: string): string | null {
  for (const [i, row] of rows.entries()) {
    const hasAny = cols.some((c) => (row[c.key] ?? "").trim() !== "");
    if (!hasAny) continue;
    for (const c of cols) {
      if (c.required && (row[c.key] ?? "").trim() === "") return `${title} row ${i + 1}: ${c.label} is required`;
      if (c.type === "int" && row[c.key] && !Number.isInteger(Number(row[c.key]))) return `${title} row ${i + 1}: ${c.label} must be a whole number`;
    }
  }
  return null;
}

function SectionEditor({ title, cols, rows, setRows, disabled }: { title: string; cols: ColDef[]; rows: EditRow[]; setRows: (rows: EditRow[]) => void; disabled: boolean }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">{title}</h3>
        {!disabled ? <Button variant="ghost" size="sm" onClick={() => setRows([...rows, Object.fromEntries(cols.map((c) => [c.key, ""])) as EditRow])}>+ Add row</Button> : null}
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-ink-200 px-3 py-2 text-xs text-ink-400">Nothing recorded.</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              {cols.map((c) => (
                <div key={c.key} className={c.width ?? "min-w-40 flex-1"}>
                  {c.type === "select" ? (
                    <Select value={row[c.key] ?? ""} disabled={disabled} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, [c.key]: e.target.value } : r)))}>
                      <option value="">{c.label}</option>
                      {(c.options ?? []).map((o) => <option key={o} value={o}>{humanize(o)}</option>)}
                    </Select>
                  ) : (
                    <Input
                      type={c.type === "text" ? "text" : "number"}
                      min={c.type === "text" ? undefined : "0"}
                      step={c.type === "int" ? "1" : c.type === "number" ? "any" : undefined}
                      placeholder={c.placeholder ?? c.label}
                      value={row[c.key] ?? ""}
                      disabled={disabled}
                      onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, [c.key]: e.target.value } : r)))}
                    />
                  )}
                </div>
              ))}
              {!disabled ? <Button variant="ghost" size="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove row">✕</Button> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DailyLogsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const base = `/api/v1/projects/${projectId}/daily-logs`;
  const { nameOf } = useCompanyUsers();
  const me = useMe();
  const today = todayIso();

  const [tab, setTab] = useState<TabKey>(() => {
    const t = searchParams.get("tab");
    return TABS.some((x) => x.value === t) ? (t as TabKey) : "log";
  });
  const [date, setDate] = useState(() => {
    const d = searchParams.get("date");
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today ? d : today;
  });
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  /** null = mine (or a fresh own draft); a user id = view that creator's log read-only */
  const [viewCreator, setViewCreator] = useState<string | null>(null);
  const dateRes = useFieldResource<DateResponse>(projectId ? `${base}/${date}${qs({ createdBy: viewCreator })}` : null, [version]);

  const [rows, setRows] = useState<Record<string, EditRow[]>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState("");
  const [notesDirty, setNotesDirty] = useState(false);
  const [weather, setWeather] = useState({ tempC: "", conditions: "", windKph: "", precipitationMm: "" });
  const [weatherDirty, setWeatherDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);
  const [logKind, setLogKind] = useState("internal");
  const [vendorId, setVendorId] = useState("");
  const [kindDirty, setKindDirty] = useState(false);
  const vendors = useFieldResource<ListResponse<{ id: string; name: string }>>("/api/v1/vendors?pageSize=200");

  const log = dateRes.data?.log ?? null;
  const isMine = dateRes.data?.isMine ?? false;
  const hasOwn = dateRes.data?.hasOwn ?? false;
  const others = dateRes.data?.logs ?? [];

  useEffect(() => {
    const sections = log?.sections ?? {};
    const next: Record<string, EditRow[]> = {};
    for (const s of SECTIONS) next[s.key] = rowsFromSection(sections, s.key, s.cols);
    setRows(next);
    setDirty(new Set());
    setNotes(log?.notes ?? "");
    setNotesDirty(false);
    const w = (log?.weather ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
    setWeather({ tempC: str(w["tempC"]), conditions: typeof w["conditions"] === "string" ? w["conditions"] : "", windKph: str(w["windKph"]), precipitationMm: str(w["precipitationMm"]) });
    setWeatherDirty(false);
    setReconciliation(null);
    setLogKind(log?.logKind ?? "internal");
    setVendorId(log?.vendorId ?? "");
    setKindDirty(false);
  }, [log]);

  function switchTab(next: TabKey) {
    setTab(next);
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    setSearchParams(params, { replace: true });
  }
  function goDate(next: string) {
    setDate(next);
    setViewCreator(null);
    setSavedAt(null);
    const params = new URLSearchParams(searchParams);
    params.set("date", next);
    setSearchParams(params, { replace: true });
  }

  const status = log?.status ?? "none";
  const editable = viewCreator === null && (log === null || (isMine && status === "draft"));

  function setSectionRows(key: string, next: EditRow[]) {
    setRows((r) => ({ ...r, [key]: next }));
    setDirty((d) => new Set(d).add(key));
  }

  function buildPayload(): Record<string, unknown> | string {
    const sections: Record<string, unknown> = {};
    for (const s of SECTIONS) {
      if (!dirty.has(s.key)) continue;
      const problem = validateRows(rows[s.key] ?? [], s.cols, s.title);
      if (problem) return problem;
      sections[s.key] = rowsToSection(rows[s.key] ?? [], s.cols);
    }
    const payload: Record<string, unknown> = {};
    if (Object.keys(sections).length > 0) payload["sections"] = sections;
    if (notesDirty) payload["notes"] = notes.trim() !== "" ? notes : null;
    if (kindDirty) {
      if (logKind === "subcontractor" && vendorId === "") return "A subcontractor self-reported log must name its vendor.";
      payload["logKind"] = logKind;
      payload["vendorId"] = logKind === "subcontractor" ? vendorId : null;
    }
    if (weatherDirty) {
      const w: Record<string, unknown> = {};
      if (weather.tempC.trim() !== "") w["tempC"] = Number(weather.tempC);
      if (weather.conditions.trim() !== "") w["conditions"] = weather.conditions.trim();
      if (weather.windKph.trim() !== "") w["windKph"] = Math.max(0, Number(weather.windKph) || 0);
      if (weather.precipitationMm.trim() !== "") w["precipitationMm"] = Math.max(0, Number(weather.precipitationMm) || 0);
      payload["weather"] = Object.keys(w).length > 0 ? w : null;
    }
    return payload;
  }

  async function onSave(): Promise<boolean> {
    const payload = buildPayload();
    if (typeof payload === "string") {
      setError(payload);
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      await api.put<DailyLog>(`${base}/${date}`, payload);
      setSavedAt(new Date().toISOString());
      refresh();
      return true;
    } catch (err) {
      setError(errorMessage(err, "Failed to save the daily log"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function post(path: string, body?: unknown, okMessage?: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`${base}/${date}/${path}`, body);
      if (okMessage) setSavedAt(new Date().toISOString());
      refresh();
    } catch (err) {
      setError(errorMessage(err, "Action failed"));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit() {
    if (!(await onSave())) return;
    await post("submit", undefined, "submitted");
  }

  async function onExport() {
    setBusy(true);
    setError(null);
    try {
      const blob = await fetchBlob(`${base}/${date}/export${qs({ createdBy: log?.createdBy })}`);
      openBlob(blob);
    } catch (err) {
      setError(errorMessage(err, "Export failed"));
    } finally {
      setBusy(false);
    }
  }

  async function onReconcile(raise: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = raise
        ? await api.post<Reconciliation>(`${base}/${date}/reconcile`, { createdBy: log?.createdBy })
        : await api.get<Reconciliation>(`${base}/${date}/reconciliation${qs({ createdBy: log?.createdBy })}`);
      setReconciliation(res);
    } catch (err) {
      setError(errorMessage(err, "Reconciliation failed"));
    } finally {
      setBusy(false);
    }
  }

  const otherLogs = others.filter((l) => l.createdBy !== me.id);

  return (
    <div>
      <PageHeader
        title="Daily Logs"
        subtitle="Site diary — weather, manpower, equipment, deliveries, delays and everything else that happened on site"
        icon={IconDailyLog}
        tabs={<Tabs items={TABS} value={tab} onChange={switchTab} />}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => goDate(addDaysIso(date, -1))}>← Prev</Button>
            <div className="w-40"><Input type="date" value={date} max={today} onChange={(e) => { if (e.target.value && e.target.value <= today) goDate(e.target.value); }} /></div>
            <Button variant="secondary" size="sm" disabled={date >= today} onClick={() => goDate(addDaysIso(date, 1))}>Next →</Button>
            {date !== today ? <Button variant="ghost" size="sm" onClick={() => goDate(today)}>Today</Button> : null}
          </div>
        }
      />

      {tab === "log" ? (
        <div className="space-y-4">
          <ErrorAlert message={error ?? dateRes.error} onRetry={dateRes.error ? dateRes.reload : undefined} />
          {dateRes.loading && !dateRes.data ? <Skeleton height={80} /> : (
            <Card>
              <CardBody className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink-900">{date}</span>
                  {log === null ? <Badge tone="gray">Not started</Badge> : <Badge tone={statusTone(status)}>{humanize(status)}</Badge>}
                  {log?.logKind === "subcontractor" ? <Badge tone="blue">Subcontractor log</Badge> : null}
                  {log?.aiDrafted === 1 ? <Badge tone="violet">AI drafted</Badge> : null}
                  {log && !isMine ? <Badge tone="amber">Read-only — {nameOf(log.createdBy)}'s log</Badge> : null}
                  {log ? (
                    <span className="text-xs text-ink-400">
                      by {nameOf(log.createdBy)}{log.submittedAt ? ` · submitted ${formatDateTime(log.submittedAt)}` : ""}{log.approvedBy ? ` · approved by ${nameOf(log.approvedBy)} ${formatDateTime(log.approvedAt)}` : ""}
                    </span>
                  ) : null}
                  {savedAt ? <span className="text-xs text-emerald-600">Saved ✓</span> : null}
                  {editable ? (
                    <span className="flex items-center gap-1.5">
                      <span className="w-40">
                        <Select
                          value={logKind}
                          onChange={(e) => { setLogKind(e.target.value); setKindDirty(true); if (e.target.value !== "subcontractor") setVendorId(""); }}
                          aria-label="Log kind"
                        >
                          <option value="internal">Our own log</option>
                          <option value="subcontractor">Subcontractor self-reported</option>
                        </Select>
                      </span>
                      {logKind === "subcontractor" ? (
                        <span className="w-52">
                          <Select value={vendorId} onChange={(e) => { setVendorId(e.target.value); setKindDirty(true); }} aria-label="Reporting vendor">
                            <option value="">Choose the vendor…</option>
                            {(vendors.data?.items ?? []).map((v) => (
                              <option key={v.id} value={v.id}>{v.name}</option>
                            ))}
                          </Select>
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {editable ? (
                    <>
                      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onSave()}>{busy ? "Saving…" : "Save draft"}</Button>
                      <Button size="sm" disabled={busy} onClick={() => void onSubmit()}>Submit</Button>
                      {log === null ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void post("carry-forward")}>Carry forward</Button> : null}
                    </>
                  ) : null}
                  {log && !isMine && !hasOwn ? <Button size="sm" variant="secondary" onClick={() => setViewCreator(null)}>Start my own log for {date}</Button> : null}
                  {log && status === "submitted" && !isMine ? (
                    <Button size="sm" disabled={busy} onClick={() => void post("approve", { logId: log.id })} title="Requires admin access to daily logs">Approve</Button>
                  ) : null}
                  {log ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onExport()}>Export HTML</Button> : null}
                  {log && status !== "draft" ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onReconcile(false)}>Reconcile vs timecards</Button> : null}
                </div>
              </CardBody>
            </Card>
          )}

          {otherLogs.length > 0 || (viewCreator !== null) ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-ink-400">Logs for this date:</span>
              <button type="button" onClick={() => setViewCreator(null)} className={`rounded-full px-2.5 py-1 ring-1 ${viewCreator === null ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-ink-600 ring-ink-200 hover:bg-ink-50"}`}>Mine {hasOwn ? "" : "(not started)"}</button>
              {otherLogs.map((l) => (
                <button key={l.id} type="button" onClick={() => setViewCreator(l.createdBy)} className={`rounded-full px-2.5 py-1 ring-1 ${viewCreator === l.createdBy ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-ink-600 ring-ink-200 hover:bg-ink-50"}`}>
                  {nameOf(l.createdBy)} · {humanize(l.status)}{l.logKind === "subcontractor" ? " · sub" : ""}
                </button>
              ))}
            </div>
          ) : null}

          {reconciliation ? (
            <Card>
              <CardBody>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Logged manpower vs timecards</h3>
                  <div className="flex gap-2">
                    {reconciliation.variances.some((v) => v.flagged) ? <Button size="sm" disabled={busy} onClick={() => void onReconcile(true)}>Raise signals</Button> : null}
                    <Button size="sm" variant="ghost" onClick={() => setReconciliation(null)}>Close</Button>
                  </div>
                </div>
                {reconciliation.reasons.length > 0 ? <Alert tone="info" size="sm">{reconciliation.reasons.join(" ")}</Alert> : (
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-ink-400"><tr><th className="py-1.5">Company</th><th>Logged h</th><th>Timecard h</th><th>Variance</th><th></th></tr></thead>
                    <tbody className="divide-y divide-ink-100">
                      {reconciliation.variances.map((v) => (
                        <tr key={v.key}>
                          <td className="py-1.5 capitalize">{v.key}</td>
                          <td className="tabular-nums">{v.loggedHours}</td>
                          <td className="tabular-nums">{v.timecardHours}</td>
                          <td className="tabular-nums">{v.varianceHours > 0 ? "+" : ""}{v.varianceHours}{v.variancePct !== null ? ` (${v.variancePct}%)` : ""}</td>
                          <td>{v.flagged ? <Badge tone="red" size="xs">Over {reconciliation.thresholdPct}%</Badge> : <Badge tone="green" size="xs">Within tolerance</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {reconciliation.signalsRaised > 0 ? <p className="mt-2 text-xs text-emerald-700">{reconciliation.signalsRaised} integrity signal(s) raised.</p> : null}
                {reconciliation.basis ? <p className="mt-2 text-xs text-ink-400">{reconciliation.basis}</p> : null}
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardBody>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Weather</h3>
                <div className="flex items-center gap-2 text-xs text-ink-400">
                  {log?.weatherSource === "auto" ? <Badge tone="blue" size="xs">Auto · {log.weatherProvider}{log.weatherFetchedAt ? ` · ${formatDateTime(log.weatherFetchedAt)}` : ""}</Badge> : log?.weatherSource === "manual" ? <Badge tone="gray" size="xs">Manual</Badge> : <span>Not captured</span>}
                  {editable && log ? <Button variant="ghost" size="sm" disabled={busy} onClick={async () => { setBusy(true); setError(null); try { const r = await api.post<{ captured: boolean; reason: string | null }>(`${base}/${date}/weather`); if (!r.captured) setError(`Weather not captured: ${r.reason ?? "unknown reason"}`); refresh(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); } }}>Fetch weather</Button> : null}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label="Temperature (°C)"><Input type="number" step="any" value={weather.tempC} disabled={!editable} onChange={(e) => { setWeather((w) => ({ ...w, tempC: e.target.value })); setWeatherDirty(true); }} /></Field>
                <Field label="Conditions"><Input value={weather.conditions} disabled={!editable} placeholder="Overcast, light rain" onChange={(e) => { setWeather((w) => ({ ...w, conditions: e.target.value })); setWeatherDirty(true); }} /></Field>
                <Field label="Wind (km/h)"><Input type="number" min="0" step="any" value={weather.windKph} disabled={!editable} onChange={(e) => { setWeather((w) => ({ ...w, windKph: e.target.value })); setWeatherDirty(true); }} /></Field>
                <Field label="Precipitation (mm)"><Input type="number" min="0" step="any" value={weather.precipitationMm} disabled={!editable} onChange={(e) => { setWeather((w) => ({ ...w, precipitationMm: e.target.value })); setWeatherDirty(true); }} /></Field>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody className="space-y-5">
              {SECTIONS.map((s) => (
                <SectionEditor key={s.key} title={s.title} cols={s.cols} rows={rows[s.key] ?? []} setRows={(next) => setSectionRows(s.key, next)} disabled={!editable} />
              ))}
              <p className="text-xs text-ink-400">Only the sections you edit are sent on save; everything else on the record is left exactly as it was.</p>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Notes & observations</h3>
              <Textarea value={notes} disabled={!editable} placeholder="General observations, site conditions, instructions received…" onChange={(e) => { setNotes(e.target.value); setNotesDirty(true); }} />
            </CardBody>
          </Card>
        </div>
      ) : null}

      {tab === "siteDay" ? <SiteDayPanel base={base} date={date} version={version} nameOf={nameOf} /> : null}
      {tab === "compliance" ? <CompliancePanel base={base} date={date} version={version} onPick={(d) => { goDate(d); switchTab("log"); }} /> : null}
      {tab === "templates" ? <TemplatesPanel base={base} version={version} onChanged={refresh} nameOf={nameOf} /> : null}
    </div>
  );
}

function SiteDayPanel({ base, date, version, nameOf }: { base: string; date: string; version: number; nameOf: (id: string | null | undefined) => string }) {
  const day = useFieldResource<Consolidated>(`${base}/${date}/consolidated`, [version]);
  if (day.error) return <ErrorAlert message={day.error} onRetry={day.reload} />;
  if (day.loading && !day.data) return <Skeleton height={200} />;
  const d = day.data;
  if (!d) return null;
  const who = (id: string) => d.people[id] ?? nameOf(id);
  if (d.logs.length === 0) return <EmptyState title={`No logs for ${date}`} hint="Nobody has started a diary for this date." />;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Stat label="Logs" value={`${d.submittedOrApproved} / ${d.logs.length}`} size="sm" hint="submitted or approved" />
        <Stat label="Workers on site" value={d.totalWorkers} size="sm" />
        <Stat label="Labour hours" value={d.totalHours} size="sm" />
        <Stat label="Hours lost" value={d.totalHoursLost} size="sm" tone={d.totalHoursLost > 0 ? "warning" : "neutral"} />
        <Stat label="Still in draft" value={d.draftCreators.length} size="sm" hint={d.draftCreators.map(who).join(", ") || "none"} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card><CardBody>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Manpower by company</h3>
          {d.manpower.length === 0 ? <p className="text-sm text-ink-400">No manpower recorded in a submitted log.</p> : (
            <table className="w-full text-sm"><thead className="text-left text-xs uppercase tracking-wide text-ink-400"><tr><th className="py-1.5">Company</th><th>Workers</th><th>Hours</th><th>Reported by</th></tr></thead>
              <tbody className="divide-y divide-ink-100">{d.manpower.map((m) => <tr key={m.company}><td className="py-1.5">{m.company}</td><td className="tabular-nums">{m.workers}</td><td className="tabular-nums">{m.hours}</td><td className="text-xs text-ink-400">{m.sources} log{m.sources === 1 ? "" : "s"}</td></tr>)}</tbody></table>
          )}
        </CardBody></Card>
        <Card><CardBody>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Equipment</h3>
          {d.equipment.length === 0 ? <p className="text-sm text-ink-400">No equipment recorded.</p> : (
            <table className="w-full text-sm"><thead className="text-left text-xs uppercase tracking-wide text-ink-400"><tr><th className="py-1.5">Equipment</th><th>Operating h</th><th>Idle h</th></tr></thead>
              <tbody className="divide-y divide-ink-100">{d.equipment.map((e) => <tr key={e.name}><td className="py-1.5">{e.name}</td><td className="tabular-nums">{e.hoursOperating}</td><td className="tabular-nums">{e.hoursIdle}</td></tr>)}</tbody></table>
          )}
        </CardBody></Card>
        <Card><CardBody>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Delays</h3>
          {d.delays.length === 0 ? <p className="text-sm text-ink-400">No delays reported.</p> : (
            <ul className="divide-y divide-ink-100 text-sm">{d.delays.map((x, i) => <li key={i} className="py-1.5"><span className="font-medium">{x.cause}</span> — {x.description} <span className="text-xs text-ink-400">· {x.hoursLost}h · {who(x.reportedBy)}</span></li>)}</ul>
          )}
        </CardBody></Card>
        <Card><CardBody>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Deliveries & visitors</h3>
          {d.deliveries.length === 0 && d.visitors.length === 0 ? <p className="text-sm text-ink-400">Nothing recorded.</p> : (
            <ul className="divide-y divide-ink-100 text-sm">
              {d.deliveries.map((x, i) => <li key={`d${i}`} className="py-1.5"><Badge tone="gray" size="xs">Delivery</Badge> {x.supplier} — {x.description} <span className="text-xs text-ink-400">· {who(x.reportedBy)}</span></li>)}
              {d.visitors.map((x, i) => <li key={`v${i}`} className="py-1.5"><Badge tone="gray" size="xs">Visitor</Badge> {x.name}{x.company ? ` (${x.company})` : ""} <span className="text-xs text-ink-400">· {who(x.reportedBy)}</span></li>)}
            </ul>
          )}
        </CardBody></Card>
      </div>
      <p className="text-xs text-ink-400">Totals count submitted and approved logs only; drafts are listed but not added, because a draft is not yet a claim.</p>
    </div>
  );
}

function CompliancePanel({ base, date, version, onPick }: { base: string; date: string; version: number; onPick: (d: string) => void }) {
  const today = todayIso();
  const from = `${date.slice(0, 8)}01`;
  const nextMonth = addDaysIso(`${date.slice(0, 8)}28`, 4);
  const monthEnd = addDaysIso(`${nextMonth.slice(0, 8)}01`, -1);
  const to = monthEnd < today ? monthEnd : today;
  const compliance = useFieldResource<Compliance>(from <= to ? `${base}/compliance?from=${from}&to=${to}` : null, [version]);
  const missing = useFieldResource<{ days: string[] }>(from <= to ? `${base}/missing?from=${from}&to=${to}` : null, [version]);
  return (
    <div className="space-y-4">
      <ErrorAlert message={compliance.error ?? missing.error} />
      <Card><CardBody>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Business days without a submitted log — {from} to {to}</h3>
        {missing.loading && !missing.data ? <Skeleton height={40} /> : (missing.data?.days.length ?? 0) === 0 ? <p className="text-sm text-emerald-700">Every business day in the window has a submitted log.</p> : (
          <div className="flex flex-wrap gap-1">{missing.data?.days.map((d) => <button key={d} type="button" onClick={() => onPick(d)} className="rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200 hover:bg-amber-100">{d}</button>)}</div>
        )}
      </CardBody></Card>
      <Card><CardBody>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Per creator</h3>
        {compliance.loading && !compliance.data ? <Skeleton height={120} /> : !compliance.data || compliance.data.items.length === 0 ? <p className="text-sm text-ink-400">Nobody has logged in this window.</p> : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-ink-400"><tr><th className="py-1.5">Creator</th><th>Kind</th><th>Submitted</th><th>Expected</th><th>Rate</th><th>Missing</th></tr></thead>
            <tbody className="divide-y divide-ink-100">
              {compliance.data.items.map((r) => (
                <tr key={r.createdBy}>
                  <td className="py-1.5 font-medium text-ink-800">{r.name ?? r.createdBy}</td>
                  <td className="text-xs">{humanize(r.logKind)}</td>
                  <td className="tabular-nums">{r.submitted}</td>
                  <td className="tabular-nums">{r.expected}</td>
                  <td><Badge tone={r.pct === null ? "gray" : r.pct >= 90 ? "green" : r.pct >= 60 ? "amber" : "red"} size="xs">{r.pct === null ? DASH : `${r.pct}%`}</Badge></td>
                  <td className="text-xs text-ink-500">{r.missing.slice(0, 6).join(", ")}{r.missing.length > 6 ? ` +${r.missing.length - 6}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {compliance.data ? <p className="mt-2 text-xs text-ink-400">{compliance.data.basis}</p> : null}
      </CardBody></Card>
    </div>
  );
}

function TemplatesPanel({ base, version, onChanged, nameOf }: { base: string; version: number; onChanged: () => void; nameOf: (id: string | null | undefined) => string }) {
  const templates = useFieldResource<{ items: Template[] }>(`${base}/templates`, [version]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [isDefault, setIsDefault] = useState(true);
  const [manpower, setManpower] = useState<EditRow[]>([]);
  const [equipment, setEquipment] = useState<EditRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manpowerCols = useMemo(() => SECTIONS.find((s) => s.key === "manpower")!.cols, []);
  const equipmentCols = useMemo(() => SECTIONS.find((s) => s.key === "equipment")!.cols, []);

  async function onCreate() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`${base}/templates`, { name: name.trim(), isDefault, sections: { manpower: rowsToSection(manpower, manpowerCols), equipment: rowsToSection(equipment, equipmentCols) } });
      setOpen(false);
      setName("");
      setManpower([]);
      setEquipment([]);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function setDefault(id: string) {
    setBusy(true);
    try {
      await api.put(`${base}/templates/${id}`, { isDefault: true });
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    if (!window.confirm("Delete this template?")) return;
    setBusy(true);
    try {
      await api.del(`${base}/templates/${id}`);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const count = (t: Template, key: string) => (Array.isArray(t.sections[key]) ? (t.sections[key] as unknown[]).length : 0);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-500">A default template's rows are applied underneath the first save of every new day, so the crews and plant on site do not have to be retyped.</p>
        <Button onClick={() => setOpen(true)}>New template</Button>
      </div>
      <ErrorAlert message={error ?? templates.error} />
      {templates.loading && !templates.data ? <Skeleton height={100} /> : (templates.data?.items.length ?? 0) === 0 ? <EmptyState title="No templates yet" hint="Create one with the companies and plant you expect every day." action={<Button onClick={() => setOpen(true)}>New template</Button>} /> : (
        <ul className="space-y-2">
          {templates.data?.items.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-ink-200 px-3 py-2 text-sm">
              <span><span className="font-medium text-ink-800">{t.name}</span> {t.isDefault === 1 ? <Badge tone="green" size="xs">Default</Badge> : null} <span className="text-xs text-ink-400">· {count(t, "manpower")} crews · {count(t, "equipment")} plant · by {nameOf(t.createdBy)}</span></span>
              <span className="flex gap-1.5">
                {t.isDefault !== 1 ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void setDefault(t.id)}>Make default</Button> : null}
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(t.id)}>Delete</Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Modal open={open} title="New daily-log template" onClose={() => setOpen(false)} wide>
        <div className="space-y-4">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Standard crews" /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> Use as the project default</label>
          <SectionEditor title="Manpower rows" cols={manpowerCols} rows={manpower} setRows={setManpower} disabled={false} />
          <SectionEditor title="Equipment rows" cols={equipmentCols} rows={equipment} setRows={setEquipment} disabled={false} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={busy || name.trim() === ""} onClick={() => void onCreate()}>{busy ? "Saving…" : "Create template"}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
