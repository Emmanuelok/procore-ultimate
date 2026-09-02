/**
 * Observations workspace — spec Vol I §4.2 #634–#646: the first-class field
 * finding. Typed, prioritised, assigned, pinned to a drawing, and converted
 * into a punch item, a safety incident or a change event with the link kept.
 * Routed at /projects/:projectId/observations; lives beside the punch pages
 * because the same people work both registers.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { OBSERVATION_STATUSES, OBSERVATION_TYPES } from "@constructos/shared";
import { api } from "../../lib/api";
import { Alert, Badge, Button, Card, CardBody, ErrorAlert, Field, Input, Modal, PageHeader, Select, Skeleton, Stat, Tabs, Textarea, statusTone } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconInspection } from "../../ui/icons";
import { formatDate, formatDateTime, humanize } from "../format";
import { AgeingPanel } from "../rfis/RfisPage";
import { DASH, daysLabel, errorMessage, priorityTone, qs, useCompanyUsers, useFieldResource, useLocations, type AgeingReport, type ListResponse } from "../rfis/fieldShared";

interface Observation {
  id: string;
  number: number;
  title: string;
  description: string | null;
  observationType: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  verifierId: string | null;
  vendorId: string | null;
  distribution: string[];
  dueDate: string | null;
  locationId: string | null;
  sheetId: string | null;
  pinX: number | null;
  pinY: number | null;
  photoIds: string[];
  convertedToType: string | null;
  convertedToId: string | null;
  convertedAt: string | null;
  readyForReviewBy: string | null;
  closedBy: string | null;
  closedAt: string | null;
  createdBy: string;
  createdAt: string;
  label: string;
  isOpen: boolean;
  daysOverdue: number;
  ageDays: number | null;
}

interface Detail extends Observation {
  links: Array<{ toType: string; toId: string; linkKind: string }>;
  permissions: { isAdmin: boolean; canStart: boolean; canReadyForReview: boolean; canClose: boolean; canVoid: boolean; canConvert: boolean; canEditVerifier: boolean };
}

interface Analytics {
  asOf: string;
  total: number;
  open: number;
  overdue: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  converted: Record<string, number>;
  avgDaysToClose: number | null;
  ageing: AgeingReport;
  basis: string;
}

type TabKey = "register" | "ageing";
const PAGE_SIZE = 25;

interface CreateForm {
  title: string;
  description: string;
  observationType: string;
  priority: string;
  assigneeId: string;
  verifierId: string;
  locationId: string;
  dueDate: string;
  sheetId: string;
  pinX: string;
  pinY: string;
}
const emptyForm: CreateForm = { title: "", description: "", observationType: "quality", priority: "medium", assigneeId: "", verifierId: "", locationId: "", dueDate: "", sheetId: "", pinX: "", pinY: "" };

export default function ObservationsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const base = `/api/v1/projects/${projectId}/observations`;
  const { users, nameOf } = useCompanyUsers();
  const locations = useLocations(projectId);
  const [tab, setTab] = useState<TabKey>(searchParams.get("tab") === "ageing" ? "ageing" : "register");
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [openOnly, setOpenOnly] = useState(true);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const list = useFieldResource<ListResponse<Observation>>(projectId ? `${base}${qs({ page, pageSize: PAGE_SIZE, status, type, open: openOnly && !status, search: debounced })}` : null, [version]);
  const analytics = useFieldResource<Analytics>(projectId ? `${base}/analytics` : null, [version]);
  const [detailId, setDetailId] = useState<string | null>(() => searchParams.get("item"));
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function switchTab(next: TabKey) {
    setTab(next);
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    setSearchParams(params, { replace: true });
  }
  function set<K extends keyof CreateForm>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setCreateError(null);
    try {
      const payload: Record<string, unknown> = { title: form.title.trim(), observationType: form.observationType, priority: form.priority };
      if (form.description.trim()) payload["description"] = form.description.trim();
      if (form.assigneeId) payload["assigneeId"] = form.assigneeId;
      if (form.verifierId) payload["verifierId"] = form.verifierId;
      if (form.locationId) payload["locationId"] = form.locationId;
      if (form.dueDate) payload["dueDate"] = form.dueDate;
      if (form.sheetId.trim() && form.pinX !== "" && form.pinY !== "") payload["pin"] = { sheetId: form.sheetId.trim(), x: Number(form.pinX), y: Number(form.pinY) };
      await api.post(base, payload);
      setCreateOpen(false);
      setForm(emptyForm);
      refresh();
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo<DataColumns<Observation>>(
    () => [
      { id: "number", header: "No.", accessor: "label", type: "code", width: 90, mono: true },
      { id: "title", header: "Title", accessor: "title", width: 300, cell: ({ row }) => <span className="font-medium text-brand-700">{row.title}</span> },
      { id: "type", header: "Type", accessor: (r) => humanize(r.observationType), width: 120, cell: ({ row }) => <Badge tone={row.observationType === "safety" ? "red" : "gray"} size="xs">{humanize(row.observationType)}</Badge> },
      { id: "priority", header: "Priority", accessor: "priority", width: 100, cell: ({ row }) => <Badge tone={priorityTone(row.priority)}>{humanize(row.priority)}</Badge> },
      { id: "status", header: "Status", accessor: "status", type: "status", width: 140, cell: ({ row }) => <span className="flex items-center gap-1"><Badge tone={statusTone(row.status)}>{humanize(row.status)}</Badge>{row.convertedToType ? <Badge tone="blue" size="xs">→ {humanize(row.convertedToType)}</Badge> : null}</span> },
      { id: "assignee", header: "Assignee", accessor: (r) => nameOf(r.assigneeId), width: 140 },
      { id: "location", header: "Location", accessor: (r) => locations.labelOf(r.locationId), width: 170 },
      { id: "due", header: "Due", accessor: "dueDate", type: "date", width: 150, cell: ({ row }) => <span className={row.daysOverdue > 0 ? "font-medium text-red-600" : ""}>{formatDate(row.dueDate)}{row.daysOverdue > 0 ? ` · ${daysLabel(row.daysOverdue)} late` : ""}</span> },
    ],
    [nameOf, locations],
  );

  const a = analytics.data;
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <PageHeader
        title="Observations"
        subtitle="Field findings — typed, assigned, pinned to a drawing and converted into the record that resolves them"
        icon={IconInspection}
        actions={<Button onClick={() => { setCreateOpen(true); setCreateError(null); }}>New observation</Button>}
        tabs={<Tabs items={[{ value: "register", label: "Register" }, { value: "ageing", label: "Ageing", ...(a && a.overdue > 0 ? { count: a.overdue, tone: "danger" as const } : {}) }]} value={tab} onChange={(v) => switchTab(v as TabKey)} />}
      />
      <Card className="mb-4">
        <CardBody className="py-3">
          {analytics.error ? <ErrorAlert message={analytics.error} /> : analytics.loading && !a ? <Skeleton height={56} /> : a ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-6">
              <Stat label="Open" value={a.open} size="sm" />
              <Stat label="Overdue" value={a.overdue} size="sm" tone={a.overdue > 0 ? "danger" : "neutral"} />
              <Stat label="Safety open" value={Object.entries(a.byType).length === 0 ? DASH : (a.byType["safety"] ?? 0)} size="sm" />
              <Stat label="Converted" value={Object.values(a.converted).reduce((s, n) => s + n, 0)} size="sm" hint={Object.entries(a.converted).map(([k, n]) => `${n} ${humanize(k)}`).join(", ") || "none yet"} />
              <Stat label="Avg days to close" value={a.avgDaysToClose === null ? DASH : `${a.avgDaysToClose}d`} size="sm" />
              <Stat label="Total" value={a.total} size="sm" hint={a.basis} />
            </div>
          ) : null}
        </CardBody>
      </Card>

      {tab === "register" ? (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="w-56"><Input placeholder="Search by title…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></div>
            <div className="w-40"><Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">{openOnly ? "Open statuses" : "All statuses"}</option>{OBSERVATION_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select></div>
            <div className="w-40"><Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}><option value="">All types</option>{OBSERVATION_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select></div>
            <Button variant={openOnly ? "primary" : "secondary"} size="sm" onClick={() => { setOpenOnly((v) => !v); setPage(1); }}>Open only</Button>
          </div>
          <DataTable<Observation>
            data={list.data?.items ?? []}
            columns={columns}
            getRowId={(r) => r.id}
            loading={list.loading && !list.data}
            error={list.error}
            onRetry={list.reload}
            toolbar={false}
            onRowClick={({ row }) => setDetailId(row.id)}
            rowTone={(r) => (r.daysOverdue > 0 ? "danger" : r.observationType === "safety" && r.isOpen ? "warning" : undefined)}
            empty={{ title: "No observations", description: status || type || debounced ? "Try clearing the filters." : "Record the first field finding.", action: <Button onClick={() => setCreateOpen(true)}>New observation</Button> }}
          />
          <div className="mt-3 flex items-center justify-between text-sm text-ink-500">
            <span>{total} observation{total === 1 ? "" : "s"} · page {page} of {totalPages}</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
              <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </>
      ) : (
        <AgeingPanel report={a ? { ...a.ageing, groupBy: "assignee", asOf: a.asOf, items: [] } : null} loading={analytics.loading} error={analytics.error} onRetry={analytics.reload} nameOf={nameOf} labelOf={(i) => `OBS-${String(i.number).padStart(3, "0")}`} />
      )}

      <Modal open={createOpen} title="New observation" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <Field label="Title"><Input required value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="Unprotected slab edge at L3 north" /></Field>
          <Field label="Description"><Textarea value={form.description} onChange={(e) => set("description", e.target.value)} /></Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Type"><Select value={form.observationType} onChange={(e) => set("observationType", e.target.value)}>{OBSERVATION_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select></Field>
            <Field label="Priority"><Select value={form.priority} onChange={(e) => set("priority", e.target.value)}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></Select></Field>
            <Field label="Due date"><Input type="date" value={form.dueDate} onChange={(e) => set("dueDate", e.target.value)} /></Field>
            <Field label="Assignee"><Select value={form.assigneeId} onChange={(e) => set("assigneeId", e.target.value)}><option value="">Unassigned</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
            <Field label="Verifier" hint="Must differ from the assignee."><Select value={form.verifierId} onChange={(e) => set("verifierId", e.target.value)}><option value="">None</option>{users.filter((u) => u.id !== form.assigneeId).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
            <Field label="Location"><Select value={form.locationId} onChange={(e) => set("locationId", e.target.value)}><option value="">No location</option>{locations.items.map((l) => <option key={l.id} value={l.id}>{locations.labelOf(l.id)}</option>)}</Select></Field>
            <Field label="Drawing sheet id" hint="Pin: sheet + x/y in 0..1"><Input value={form.sheetId} onChange={(e) => set("sheetId", e.target.value)} placeholder="sht_…" /></Field>
            <Field label="Pin x"><Input type="number" min="0" max="1" step="0.01" value={form.pinX} onChange={(e) => set("pinX", e.target.value)} /></Field>
            <Field label="Pin y"><Input type="number" min="0" max="1" step="0.01" value={form.pinY} onChange={(e) => set("pinY", e.target.value)} /></Field>
          </div>
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create observation"}</Button></div>
        </form>
      </Modal>

      <ObservationDetail base={base} projectId={projectId ?? ""} id={detailId} onClose={() => setDetailId(null)} onChanged={refresh} nameOf={nameOf} locationLabel={locations.labelOf} />
    </div>
  );
}

function ObservationDetail({ base, projectId, id, onClose, onChanged, nameOf, locationLabel }: {
  base: string;
  projectId: string;
  id: string | null;
  onClose: () => void;
  onChanged: () => void;
  nameOf: (id: string | null | undefined) => string;
  locationLabel: (id: string | null | undefined) => string;
}) {
  const [version, setVersion] = useState(0);
  const detail = useFieldResource<Detail>(id ? `${base}/${id}` : null, [version]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState("punch_item");
  const [result, setResult] = useState<{ type: string; id: string; label: string } | null>(null);
  const d = detail.data;
  useEffect(() => {
    setError(null);
    setResult(null);
  }, [id]);

  async function transition(status: string) {
    if (!d) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`${base}/${d.id}/status`, { status });
      setVersion((n) => n + 1);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function convert() {
    if (!d) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ target: { type: string; id: string; label: string } }>(`${base}/${d.id}/convert`, { target });
      setResult(res.target);
      setVersion((n) => n + 1);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const hrefFor = (type: string, targetId: string) =>
    type === "punch_item" ? `/projects/${projectId}/punch?item=${targetId}` : type === "safety_incident" || type === "incident" ? `/projects/${projectId}/safety?incident=${targetId}` : `/projects/${projectId}/changes?event=${targetId}`;

  return (
    <Modal open={id !== null} title={d ? `${d.label} · ${humanize(d.observationType)}` : "Observation"} onClose={onClose} wide>
      {detail.error ? <ErrorAlert message={detail.error} onRetry={detail.reload} /> : !d ? <Skeleton height={200} /> : (
        <div className="space-y-4">
          <ErrorAlert message={error} />
          {result ? <Alert tone="success" size="sm">Converted to {result.label}. <a className="font-medium underline" href={hrefFor(result.type, result.id)}>Open it</a>.</Alert> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(d.status)}>{humanize(d.status)}</Badge>
            <Badge tone={priorityTone(d.priority)}>{humanize(d.priority)}</Badge>
            {d.daysOverdue > 0 ? <Badge tone="red">{daysLabel(d.daysOverdue)} overdue</Badge> : null}
            {d.convertedToType ? <Badge tone="blue">Converted → {humanize(d.convertedToType)}</Badge> : null}
            <span className="text-xs text-ink-400">Raised by {nameOf(d.createdBy)} · {formatDateTime(d.createdAt)}</span>
          </div>
          <div>
            <h3 className="text-base font-semibold text-ink-900">{d.title}</h3>
            {d.description ? <p className="mt-1 whitespace-pre-wrap text-sm text-ink-700">{d.description}</p> : null}
          </div>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div><dt className="text-ink-400">Assignee</dt><dd className="text-ink-800">{nameOf(d.assigneeId)}</dd></div>
            <div><dt className="text-ink-400">Verifier</dt><dd className="text-ink-800">{nameOf(d.verifierId)}</dd></div>
            <div><dt className="text-ink-400">Due</dt><dd className="text-ink-800">{formatDate(d.dueDate)}</dd></div>
            <div><dt className="text-ink-400">Location</dt><dd className="text-ink-800">{locationLabel(d.locationId)}</dd></div>
            <div><dt className="text-ink-400">Drawing pin</dt><dd className="text-ink-800">{d.sheetId ? `${d.sheetId} @ ${d.pinX?.toFixed(2)}, ${d.pinY?.toFixed(2)}` : DASH}</dd></div>
            <div><dt className="text-ink-400">Photos</dt><dd className="text-ink-800">{d.photoIds.length}</dd></div>
            <div><dt className="text-ink-400">Closed</dt><dd className="text-ink-800">{d.closedBy ? `${nameOf(d.closedBy)} · ${formatDateTime(d.closedAt)}` : DASH}</dd></div>
          </dl>
          {d.links.length > 0 ? (
            <div className="text-sm">
              <span className="text-xs uppercase tracking-wide text-ink-400">Linked records</span>
              <ul className="mt-1">{d.links.map((l) => <li key={l.toId}><a className="text-brand-700 hover:underline" href={hrefFor(l.toType, l.toId)}>{humanize(l.toType)} {l.toId}</a> <span className="text-xs text-ink-400">({humanize(l.linkKind)})</span></li>)}</ul>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 pt-3">
            <div className="flex flex-wrap gap-2">
              {d.permissions.canStart ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void transition("in_progress")}>Start</Button> : null}
              {d.permissions.canReadyForReview ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void transition("ready_for_review")}>Ready for review</Button> : null}
              {d.permissions.canClose ? <Button size="sm" disabled={busy} onClick={() => void transition("closed")}>Verify & close</Button> : null}
              {d.permissions.canVoid ? <Button size="sm" variant="danger" disabled={busy} onClick={() => { if (window.confirm("Void this observation?")) void transition("void"); }}>Void</Button> : null}
            </div>
            {d.permissions.canConvert ? (
              <div className="flex items-center gap-2">
                <div className="w-40"><Select value={target} onChange={(e) => setTarget(e.target.value)}><option value="punch_item">Punch item</option><option value="incident">Safety incident</option><option value="change_event">Change event</option></Select></div>
                <Button size="sm" disabled={busy} onClick={() => void convert()}>Convert</Button>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </Modal>
  );
}
