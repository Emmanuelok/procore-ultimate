/**
 * Punch list workspace — spec Vol I §2.8.
 *
 *   Register   numbered items with status/priority/vendor/trade/location filters
 *   Walk       room-walk mode: open items grouped by the location tree with
 *              quick-add from a template (#401–#402)
 *   Ageing     open items bucketed by age, grouped by assignee/vendor/trade/priority (#411)
 *   Templates  the trade/type/title library bulk and walk creation draws on (#399)
 *
 * Transitions are driven by the API's `permissions` block, so the assignee
 * never sees a "Verify & close" button they cannot press (#408: two hands on
 * every closure).
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { PUNCH_STATUSES } from "@constructos/shared";
import { api } from "../../lib/api";
import { Alert, Badge, Button, Card, CardBody, EmptyState, ErrorAlert, Field, Input, Modal, PageHeader, Select, Skeleton, Stat, Tabs, Textarea, statusTone } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconPunch } from "../../ui/icons";
import { formatDate, formatDateTime, humanize } from "../format";
import { AgeingPanel } from "../rfis/RfisPage";
import { DASH, daysLabel, errorMessage, fetchBlob, priorityTone, qs, saveBlob, useCompanyUsers, useFieldResource, useLocations, type AgeingReport, type ListResponse } from "../rfis/fieldShared";

interface PunchItem {
  id: string;
  number: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  itemType: string | null;
  trade: string | null;
  assigneeId: string | null;
  verifierId: string | null;
  vendorId: string | null;
  locationId: string | null;
  dueDate: string | null;
  beforePhotoIds: string[];
  afterPhotoIds: string[];
  distribution: string[];
  readyForReviewBy: string | null;
  readyForReviewAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  observationId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  label: string;
  isOpen: boolean;
  daysOverdue: number;
  ageDays: number | null;
}

interface PunchDetail extends PunchItem {
  permissions: { isAdmin: boolean; canStart: boolean; canReadyForReview: boolean; canClose: boolean; canVoid: boolean; canEditVerifier: boolean; canEditAssignee: boolean; reasons: Record<string, string | null> };
  settings: { requireAfterPhoto: boolean; requireVerifier: boolean };
}

interface Analytics {
  asOf: string;
  byStatus: Record<string, number>;
  byAssignee: Array<{ assigneeId: string; count: number }>;
  byVendor: Array<{ vendorId: string | null; count: number }>;
  byTrade: Array<{ trade: string | null; count: number }>;
  overdue: number;
  completion: { total: number; open: number; closed: number; void: number; completionPct: number | null; avgDaysToClose: number | null; overdue: number; basis: string };
}

interface WalkGroup {
  locationId: string | null;
  name: string;
  pathLabel: string;
  counts: Record<string, number>;
  items: PunchItem[];
}

interface Template {
  id: string;
  projectId: string | null;
  trade: string | null;
  itemType: string | null;
  title: string;
  description: string | null;
  priority: string;
  defaultVerifierId: string | null;
  defaultDueDays: number | null;
}

interface Vendor {
  id: string;
  name: string;
}

type TabKey = "register" | "walk" | "ageing" | "templates";
const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "register", label: "Register" },
  { value: "walk", label: "Walk" },
  { value: "ageing", label: "Ageing" },
  { value: "templates", label: "Templates" },
];
const PAGE_SIZE = 25;

interface CreateForm {
  title: string;
  description: string;
  priority: string;
  trade: string;
  itemType: string;
  assigneeId: string;
  verifierId: string;
  vendorId: string;
  locationId: string;
  dueDate: string;
}
const emptyForm: CreateForm = { title: "", description: "", priority: "medium", trade: "", itemType: "", assigneeId: "", verifierId: "", vendorId: "", locationId: "", dueDate: "" };

export default function PunchPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const base = `/api/v1/projects/${projectId}/punch`;
  const { users, nameOf } = useCompanyUsers();
  const locations = useLocations(projectId);
  const vendors = useFieldResource<ListResponse<Vendor>>("/api/v1/vendors?pageSize=200");
  const vendorName = useCallback((id: string | null | undefined) => (id ? (vendors.data?.items.find((v) => v.id === id)?.name ?? id) : DASH), [vendors.data]);

  const [tab, setTab] = useState<TabKey>(() => {
    const t = searchParams.get("tab");
    return TABS.some((x) => x.value === t) ? (t as TabKey) : "register";
  });
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const list = useFieldResource<ListResponse<PunchItem>>(projectId && tab === "register" ? `${base}${qs({ page, pageSize: PAGE_SIZE, status, priority, vendorId, overdue: overdueOnly, search: debounced })}` : null, [version]);
  const analytics = useFieldResource<Analytics>(projectId ? `${base}/analytics` : null, [version]);
  const [ageingGroup, setAgeingGroup] = useState<"assignee" | "vendor" | "trade" | "priority">("assignee");
  const ageing = useFieldResource<AgeingReport>(projectId && tab === "ageing" ? `${base}/ageing?groupBy=${ageingGroup}` : null, [version]);
  const walk = useFieldResource<{ asOf: string; total: number; groups: WalkGroup[] }>(projectId && tab === "walk" ? `${base}/by-location?open=true` : null, [version]);
  const templates = useFieldResource<{ items: Template[] }>(projectId ? `${base}/templates` : null, [version]);

  const [createOpen, setCreateOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [bulkTitles, setBulkTitles] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(() => searchParams.get("item"));

  function switchTab(next: TabKey) {
    setTab(next);
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    setSearchParams(params, { replace: true });
  }
  function set<K extends keyof CreateForm>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  function payloadFrom(f: CreateForm): Record<string, unknown> {
    const p: Record<string, unknown> = { title: f.title.trim(), priority: f.priority };
    if (f.description.trim()) p["description"] = f.description.trim();
    if (f.trade.trim()) p["trade"] = f.trade.trim();
    if (f.itemType.trim()) p["itemType"] = f.itemType.trim();
    if (f.assigneeId) p["assigneeId"] = f.assigneeId;
    if (f.verifierId) p["verifierId"] = f.verifierId;
    if (f.vendorId) p["vendorId"] = f.vendorId;
    if (f.locationId) p["locationId"] = f.locationId;
    if (f.dueDate) p["dueDate"] = f.dueDate;
    return p;
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      if (bulkOpen) {
        const titles = bulkTitles.split("\n").map((t) => t.trim()).filter(Boolean);
        if (titles.length === 0) throw new Error("Add one title per line.");
        const { title: _ignored, ...defaults } = payloadFrom(form);
        await api.post(`${base}/bulk`, { defaults, items: titles.map((title) => ({ title })) });
      } else {
        await api.post(base, payloadFrom(form));
      }
      setCreateOpen(false);
      setBulkOpen(false);
      setForm(emptyForm);
      setBulkTitles("");
      refresh();
    } catch (err) {
      setCreateError(errorMessage(err, "Failed to create."));
    } finally {
      setBusy(false);
    }
  }

  async function onExport(groupBy: "vendor" | "trade" | "location") {
    try {
      const blob = await fetchBlob(`${base}/export.csv?groupBy=${groupBy}`);
      saveBlob(blob, `punch-list-by-${groupBy}.csv`);
    } catch (err) {
      setCreateError(errorMessage(err));
    }
  }

  const columns = useMemo<DataColumns<PunchItem>>(
    () => [
      { id: "number", header: "No.", accessor: (r) => `#${String(r.number).padStart(3, "0")}`, type: "code", width: 80, mono: true },
      { id: "title", header: "Title", accessor: "title", width: 300, cell: ({ row }) => <span className="font-medium text-brand-700">{row.title}</span> },
      { id: "priority", header: "Priority", accessor: "priority", width: 100, cell: ({ row }) => <Badge tone={priorityTone(row.priority)}>{humanize(row.priority)}</Badge> },
      { id: "status", header: "Status", accessor: "status", type: "status", width: 140, cell: ({ row }) => <Badge tone={statusTone(row.status)}>{humanize(row.status)}</Badge> },
      { id: "trade", header: "Trade", accessor: (r) => r.trade ?? DASH, width: 120 },
      { id: "vendor", header: "Vendor", accessor: (r) => vendorName(r.vendorId), width: 150 },
      { id: "location", header: "Location", accessor: (r) => locations.labelOf(r.locationId), width: 180 },
      { id: "assignee", header: "Assignee", accessor: (r) => nameOf(r.assigneeId), width: 140 },
      { id: "verifier", header: "Verifier", accessor: (r) => nameOf(r.verifierId), width: 140 },
      { id: "due", header: "Due", accessor: "dueDate", type: "date", width: 150, cell: ({ row }) => <span className={row.daysOverdue > 0 ? "font-medium text-red-600" : ""}>{formatDate(row.dueDate)}{row.daysOverdue > 0 ? ` · ${daysLabel(row.daysOverdue)} late` : ""}</span> },
    ],
    [nameOf, vendorName, locations],
  );

  const a = analytics.data;
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = Boolean(status || priority || vendorId || overdueOnly || debounced);

  return (
    <div>
      <PageHeader
        title="Punch List"
        subtitle="Deficiencies with assignee completion and a separate verifier sign-off"
        icon={IconPunch}
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => { setBulkOpen(true); setCreateOpen(true); setCreateError(null); }}>Bulk add</Button>
            <Button onClick={() => { setBulkOpen(false); setCreateOpen(true); setCreateError(null); }}>New punch item</Button>
          </div>
        }
        tabs={<Tabs items={TABS.map((t) => ({ value: t.value, label: t.label, ...(t.value === "ageing" && a && a.overdue > 0 ? { count: a.overdue, tone: "danger" as const } : {}) }))} value={tab} onChange={switchTab} />}
      />

      <Card className="mb-4">
        <CardBody className="py-3">
          {analytics.error ? <ErrorAlert message={analytics.error} /> : analytics.loading && !a ? <Skeleton height={56} /> : a ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-6">
              <Stat label="Open" value={a.completion.open} size="sm" />
              <Stat label="Ready for review" value={a.byStatus["ready_for_review"] ?? 0} size="sm" />
              <Stat label="Overdue" value={a.overdue} size="sm" tone={a.overdue > 0 ? "danger" : "neutral"} />
              <Stat label="Closed" value={a.completion.closed} size="sm" />
              <Stat label="Completion" value={a.completion.completionPct === null ? DASH : `${a.completion.completionPct}%`} size="sm" hint={a.completion.basis} />
              <Stat label="Avg days to close" value={a.completion.avgDaysToClose === null ? DASH : `${a.completion.avgDaysToClose}d`} size="sm" />
            </div>
          ) : null}
        </CardBody>
      </Card>

      {tab === "register" ? (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="w-56"><Input placeholder="Search by title…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></div>
            <div className="w-40">
              <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
                <option value="">All statuses</option>
                {PUNCH_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
              </Select>
            </div>
            <div className="w-36">
              <Select value={priority} onChange={(e) => { setPriority(e.target.value); setPage(1); }}>
                <option value="">All priorities</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
              </Select>
            </div>
            <div className="w-44">
              <Select value={vendorId} onChange={(e) => { setVendorId(e.target.value); setPage(1); }}>
                <option value="">All vendors</option>
                {(vendors.data?.items ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </Select>
            </div>
            <Button variant={overdueOnly ? "primary" : "secondary"} size="sm" onClick={() => { setOverdueOnly((v) => !v); setPage(1); }}>Overdue only</Button>
            <span className="ml-auto flex gap-1 text-xs text-ink-500">
              Export CSV:
              <button type="button" className="text-brand-700 hover:underline" onClick={() => void onExport("vendor")}>by vendor</button> ·
              <button type="button" className="text-brand-700 hover:underline" onClick={() => void onExport("trade")}>by trade</button> ·
              <button type="button" className="text-brand-700 hover:underline" onClick={() => void onExport("location")}>by location</button>
            </span>
          </div>
          <ErrorAlert message={createError && !createOpen ? createError : null} />
          <DataTable<PunchItem>
            data={list.data?.items ?? []}
            columns={columns}
            getRowId={(r) => r.id}
            loading={list.loading && !list.data}
            error={list.error}
            onRetry={list.reload}
            toolbar={false}
            onRowClick={({ row }) => setDetailId(row.id)}
            rowTone={(r) => (r.daysOverdue > 0 ? "danger" : r.status === "ready_for_review" ? "info" : undefined)}
            empty={{ title: filtered ? "No punch items match your filters" : "No punch items yet", description: filtered ? "Try clearing the filters." : "Capture the first deficiency from a site walk, or bulk-add a list.", action: !filtered ? <Button onClick={() => { setBulkOpen(false); setCreateOpen(true); }}>New punch item</Button> : undefined }}
          />
          <div className="mt-3 flex items-center justify-between text-sm text-ink-500">
            <span>{total} item{total === 1 ? "" : "s"} · page {page} of {totalPages}</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
              <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </>
      ) : null}

      {tab === "walk" ? (
        <WalkPanel base={base} walk={walk} templates={templates.data?.items ?? []} locations={locations.items} users={users} nameOf={nameOf} onOpen={setDetailId} onChanged={refresh} />
      ) : null}

      {tab === "ageing" ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-ink-500">Group by</span>
            <div className="w-40">
              <Select value={ageingGroup} onChange={(e) => setAgeingGroup(e.target.value as typeof ageingGroup)}>
                <option value="assignee">Assignee</option><option value="vendor">Vendor</option><option value="trade">Trade</option><option value="priority">Priority</option>
              </Select>
            </div>
          </div>
          <AgeingPanel report={ageing.data} loading={ageing.loading} error={ageing.error} onRetry={ageing.reload} nameOf={nameOf} labelOf={(i) => `#${String(i.number).padStart(3, "0")} ${i.title ?? ""}`} />
        </div>
      ) : null}

      {tab === "templates" ? <TemplatesPanel base={base} templates={templates} users={users} nameOf={nameOf} onChanged={refresh} /> : null}

      <Modal open={createOpen} title={bulkOpen ? "Bulk add punch items" : "New punch item"} onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          {bulkOpen ? (
            <Field label="Titles — one per line (up to 200)" hint="The fields below apply to every item.">
              <Textarea required rows={6} value={bulkTitles} onChange={(e) => setBulkTitles(e.target.value)} placeholder={"Missing socket cover — Room 301\nLoose conduit above ceiling grid\nLabel DB-3"} />
            </Field>
          ) : (
            <>
              <Field label="Title"><Input required value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="Scratched glazing at unit 402 living room" /></Field>
              <Field label="Description"><Textarea value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="What is wrong and what does done look like…" /></Field>
            </>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Priority"><Select value={form.priority} onChange={(e) => set("priority", e.target.value)}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></Select></Field>
            <Field label="Trade"><Input value={form.trade} onChange={(e) => set("trade", e.target.value)} placeholder="Electrical" /></Field>
            <Field label="Type"><Input value={form.itemType} onChange={(e) => set("itemType", e.target.value)} placeholder="deficiency" /></Field>
            <Field label="Due date"><Input type="date" value={form.dueDate} onChange={(e) => set("dueDate", e.target.value)} /></Field>
            <Field label="Location">
              <Select value={form.locationId} onChange={(e) => set("locationId", e.target.value)}>
                <option value="">No location</option>
                {locations.items.map((l) => <option key={l.id} value={l.id}>{locations.labelOf(l.id)}</option>)}
              </Select>
            </Field>
            <Field label="Vendor">
              <Select value={form.vendorId} onChange={(e) => set("vendorId", e.target.value)}>
                <option value="">No vendor</option>
                {(vendors.data?.items ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </Select>
            </Field>
            <Field label="Assignee">
              <Select value={form.assigneeId} onChange={(e) => set("assigneeId", e.target.value)}>
                <option value="">Unassigned</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </Select>
            </Field>
            <Field label="Verifier" hint="Must differ from the assignee; signs off before the item can be closed.">
              <Select value={form.verifierId} onChange={(e) => set("verifierId", e.target.value)}>
                <option value="">None</option>
                {users.filter((u) => u.id !== form.assigneeId).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </Select>
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Creating…" : bulkOpen ? "Create items" : "Create punch item"}</Button>
          </div>
        </form>
      </Modal>

      <PunchDetailModal base={base} itemId={detailId} onClose={() => setDetailId(null)} onChanged={refresh} users={users} nameOf={nameOf} vendorName={vendorName} locationLabel={locations.labelOf} />
    </div>
  );
}

function WalkPanel({ base, walk, templates, locations, users, nameOf, onOpen, onChanged }: {
  base: string;
  walk: { data: { asOf: string; total: number; groups: WalkGroup[] } | null; loading: boolean; error: string | null; reload: () => void };
  templates: Template[];
  locations: Array<{ id: string; name: string; parentId: string | null; path: string }>;
  users: Array<{ id: string; name: string }>;
  nameOf: (id: string | null | undefined) => string;
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const [templateId, setTemplateId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function quickAdd() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`${base}/from-template`, { templateId, locationId: locationId || null, assigneeId: assigneeId || null });
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="py-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Quick-add from template" className="min-w-56 flex-1">
              <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">Choose a template…</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.trade ? `${t.trade} · ` : ""}{t.title}</option>)}
              </Select>
            </Field>
            <Field label="Location" className="min-w-48 flex-1">
              <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">No location</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </Field>
            <Field label="Assignee" className="min-w-40">
              <Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                <option value="">Unassigned</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </Select>
            </Field>
            <Button disabled={busy || !templateId} onClick={() => void quickAdd()}>{busy ? "Adding…" : "Add here"}</Button>
          </div>
          <ErrorAlert message={error} className="mt-2" />
          {templates.length === 0 ? <p className="mt-2 text-xs text-ink-400">No templates yet — create some on the Templates tab to make walk-mode capture one tap.</p> : null}
        </CardBody>
      </Card>
      {walk.error ? <ErrorAlert message={walk.error} onRetry={walk.reload} /> : walk.loading && !walk.data ? <Skeleton height={200} /> : !walk.data || walk.data.groups.length === 0 ? (
        <EmptyState title="Nothing open on the walk" hint="Every punch item is closed or void." />
      ) : (
        <div className="space-y-3">
          {walk.data.groups.map((g) => (
            <Card key={g.locationId ?? "none"}>
              <CardBody className="py-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-ink-900">{g.pathLabel}</h3>
                  <span className="flex gap-1 text-xs">
                    {(["open", "in_progress", "ready_for_review"] as const).map((k) => (g.counts[k] ?? 0) > 0 ? <Badge key={k} tone={statusTone(k)} size="xs">{g.counts[k]} {humanize(k)}</Badge> : null)}
                  </span>
                </div>
                <ul className="divide-y divide-ink-100 text-sm">
                  {g.items.map((i) => (
                    <li key={i.id} className="flex cursor-pointer items-center justify-between gap-3 py-1.5 hover:bg-ink-50/60" onClick={() => onOpen(i.id)}>
                      <span className="min-w-0 truncate"><span className="font-mono text-xs text-ink-400">#{String(i.number).padStart(3, "0")}</span> {i.title} <span className="text-xs text-ink-400">· {nameOf(i.assigneeId)}</span></span>
                      <span className="flex shrink-0 gap-1"><Badge tone={priorityTone(i.priority)} size="xs">{humanize(i.priority)}</Badge>{i.daysOverdue > 0 ? <Badge tone="red" size="xs">{daysLabel(i.daysOverdue)} late</Badge> : null}</span>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ))}
          <p className="text-xs text-ink-400">Open items only, in location-tree order; unlocated items last. As of {walk.data.asOf}.</p>
        </div>
      )}
    </div>
  );
}

function TemplatesPanel({ base, templates, users, nameOf, onChanged }: {
  base: string;
  templates: { data: { items: Template[] } | null; loading: boolean; error: string | null; reload: () => void };
  users: Array<{ id: string; name: string }>;
  nameOf: (id: string | null | undefined) => string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: "", trade: "", itemType: "", description: "", priority: "medium", defaultVerifierId: "", defaultDueDays: "", scope: "project" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`${base}/templates`, {
        title: form.title.trim(),
        trade: form.trade.trim() || null,
        itemType: form.itemType.trim() || null,
        description: form.description.trim() || null,
        priority: form.priority,
        defaultVerifierId: form.defaultVerifierId || null,
        defaultDueDays: form.defaultDueDays === "" ? null : Number(form.defaultDueDays),
        scope: form.scope,
      });
      setOpen(false);
      setForm({ title: "", trade: "", itemType: "", description: "", priority: "medium", defaultVerifierId: "", defaultDueDays: "", scope: "project" });
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function retire(id: string) {
    if (!window.confirm("Retire this template?")) return;
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
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-500">Templates carry the trade, type, title, priority, default verifier and due offset; bulk and walk-mode creation draw on them.</p>
        <Button onClick={() => setOpen(true)}>New template</Button>
      </div>
      <ErrorAlert message={error ?? templates.error} />
      {templates.loading && !templates.data ? <Skeleton height={100} /> : (templates.data?.items.length ?? 0) === 0 ? <EmptyState title="No templates yet" hint="Add the recurring deficiencies for each trade." action={<Button onClick={() => setOpen(true)}>New template</Button>} /> : (
        <ul className="space-y-2">
          {templates.data?.items.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-ink-200 px-3 py-2 text-sm">
              <span><span className="font-medium text-ink-800">{t.title}</span> <span className="text-xs text-ink-400">· {t.trade ?? "any trade"} · {humanize(t.priority)}{t.defaultVerifierId ? ` · verifier ${nameOf(t.defaultVerifierId)}` : ""}{t.defaultDueDays !== null ? ` · due +${t.defaultDueDays}d` : ""}</span> {t.projectId === null ? <Badge tone="violet" size="xs">Company-wide</Badge> : null}</span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void retire(t.id)}>Retire</Button>
            </li>
          ))}
        </ul>
      )}
      <Modal open={open} title="New punch template" onClose={() => setOpen(false)} wide>
        <form onSubmit={onCreate} className="space-y-4">
          <Field label="Title"><Input required value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="Seal fire-stopping penetrations" /></Field>
          <Field label="Description"><Textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Trade"><Input value={form.trade} onChange={(e) => setForm((f) => ({ ...f, trade: e.target.value }))} /></Field>
            <Field label="Type"><Input value={form.itemType} onChange={(e) => setForm((f) => ({ ...f, itemType: e.target.value }))} /></Field>
            <Field label="Priority"><Select value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></Select></Field>
            <Field label="Default verifier"><Select value={form.defaultVerifierId} onChange={(e) => setForm((f) => ({ ...f, defaultVerifierId: e.target.value }))}><option value="">None</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
            <Field label="Due in (days)"><Input type="number" min="0" value={form.defaultDueDays} onChange={(e) => setForm((f) => ({ ...f, defaultDueDays: e.target.value }))} /></Field>
            <Field label="Scope" hint="Company-wide needs a company admin."><Select value={form.scope} onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))}><option value="project">This project</option><option value="company">Company-wide</option></Select></Field>
          </div>
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Create template"}</Button></div>
        </form>
      </Modal>
    </div>
  );
}

const TRANSITIONS: Array<{ to: string; label: string; key: "canStart" | "canReadyForReview" | "canClose"; primary?: boolean }> = [
  { to: "in_progress", label: "Start work", key: "canStart" },
  { to: "ready_for_review", label: "Ready for review", key: "canReadyForReview" },
  { to: "closed", label: "Verify & close", key: "canClose", primary: true },
];

export function PunchDetailModal({ base, itemId, onClose, onChanged, users, nameOf, vendorName, locationLabel }: {
  base: string;
  itemId: string | null;
  onClose: () => void;
  onChanged: () => void;
  users: Array<{ id: string; name: string }>;
  nameOf: (id: string | null | undefined) => string;
  vendorName: (id: string | null | undefined) => string;
  locationLabel: (id: string | null | undefined) => string;
}) {
  const [version, setVersion] = useState(0);
  const detail = useFieldResource<PunchDetail>(itemId ? `${base}/${itemId}` : null, [version]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState({ assigneeId: "", verifierId: "", priority: "medium", dueDate: "", afterPhotoIds: "" });
  const d = detail.data;
  useEffect(() => {
    if (d) setEdit({ assigneeId: d.assigneeId ?? "", verifierId: d.verifierId ?? "", priority: d.priority, dueDate: d.dueDate ?? "", afterPhotoIds: d.afterPhotoIds.join(", ") });
    setError(null);
  }, [d]);

  async function save() {
    if (!d) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`${base}/${d.id}`, { assigneeId: edit.assigneeId || null, verifierId: edit.verifierId || null, priority: edit.priority, dueDate: edit.dueDate || null, afterPhotoIds: edit.afterPhotoIds.split(",").map((s) => s.trim()).filter(Boolean) });
      setVersion((n) => n + 1);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function transition(to: string) {
    if (!d) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`${base}/${d.id}/status`, { status: to });
      setVersion((n) => n + 1);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const open = d ? d.status !== "closed" && d.status !== "void" : false;
  return (
    <Modal open={itemId !== null} title={d ? `Punch #${String(d.number).padStart(3, "0")}` : "Punch item"} onClose={onClose} wide>
      {detail.error ? <ErrorAlert message={detail.error} onRetry={detail.reload} /> : !d ? <Skeleton height={200} /> : (
        <div className="space-y-4">
          <ErrorAlert message={error} />
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(d.status)}>{humanize(d.status)}</Badge>
            <Badge tone={priorityTone(d.priority)}>{humanize(d.priority)}</Badge>
            {d.daysOverdue > 0 ? <Badge tone="red">{daysLabel(d.daysOverdue)} overdue</Badge> : null}
            {d.observationId ? <Badge tone="blue">From observation</Badge> : null}
            <span className="text-xs text-ink-400">Created by {nameOf(d.createdBy)} · {formatDateTime(d.createdAt)}</span>
          </div>
          <div>
            <h3 className="text-base font-semibold text-ink-900">{d.title}</h3>
            {d.description ? <p className="mt-1 whitespace-pre-wrap text-sm text-ink-700">{d.description}</p> : null}
            <p className="mt-1 text-xs text-ink-500">{d.trade ?? "no trade"} · {vendorName(d.vendorId)} · {locationLabel(d.locationId)}</p>
          </div>
          {d.readyForReviewBy ? <Alert tone="info" size="sm">Marked ready for review by {nameOf(d.readyForReviewBy)} {d.readyForReviewAt ? formatDateTime(d.readyForReviewAt) : ""}. The person who marked it ready cannot also verify it.</Alert> : null}
          {d.closedBy ? <Alert tone="success" size="sm">Verified and closed by {nameOf(d.closedBy)} {d.closedAt ? formatDateTime(d.closedAt) : ""}.</Alert> : null}

          {open ? (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Assignee">
                  <Select value={edit.assigneeId} disabled={!d.permissions.canEditAssignee} onChange={(e) => setEdit((x) => ({ ...x, assigneeId: e.target.value }))}>
                    <option value="">Unassigned</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </Select>
                </Field>
                <Field label="Verifier" hint={!d.permissions.canEditVerifier ? "Locked while the item is ready for review" : "Must differ from the assignee"}>
                  <Select value={edit.verifierId} disabled={!d.permissions.canEditVerifier} onChange={(e) => setEdit((x) => ({ ...x, verifierId: e.target.value }))}>
                    <option value="">None</option>
                    {users.filter((u) => u.id !== edit.assigneeId).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </Select>
                </Field>
                <Field label="Priority"><Select value={edit.priority} onChange={(e) => setEdit((x) => ({ ...x, priority: e.target.value }))}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></Select></Field>
                <Field label="Due date"><Input type="date" value={edit.dueDate} onChange={(e) => setEdit((x) => ({ ...x, dueDate: e.target.value }))} /></Field>
                <Field label="After photo ids" hint={d.settings.requireAfterPhoto ? "Required before review/closure on this project." : "Comma-separated photo ids from the Photos tool."} className="sm:col-span-2">
                  <Input value={edit.afterPhotoIds} onChange={(e) => setEdit((x) => ({ ...x, afterPhotoIds: e.target.value }))} placeholder="pho_…" />
                </Field>
              </div>
              <div className="flex justify-end"><Button variant="secondary" size="sm" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save changes"}</Button></div>
            </>
          ) : (
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div><dt className="text-ink-400">Assignee</dt><dd className="text-ink-800">{nameOf(d.assigneeId)}</dd></div>
              <div><dt className="text-ink-400">Verifier</dt><dd className="text-ink-800">{nameOf(d.verifierId)}</dd></div>
              <div><dt className="text-ink-400">Due date</dt><dd className="text-ink-800">{formatDate(d.dueDate)}</dd></div>
              <div><dt className="text-ink-400">Photos</dt><dd className="text-ink-800">{d.beforePhotoIds.length} before · {d.afterPhotoIds.length} after</dd></div>
            </dl>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 pt-3">
            <div className="flex flex-wrap gap-2">
              {TRANSITIONS.filter((t) => d.permissions[t.key]).map((t) => (
                <Button key={t.to} size="sm" variant={t.primary ? "primary" : "secondary"} disabled={busy} onClick={() => void transition(t.to)}>{t.label}</Button>
              ))}
              {d.status === "ready_for_review" ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void transition("in_progress")}>Send back</Button> : null}
              {open && !d.permissions.canClose && d.permissions.reasons["closed"] ? <span className="self-center text-xs text-ink-400">{d.permissions.reasons["closed"]}</span> : null}
            </div>
            {d.permissions.canVoid ? (
              <Button size="sm" variant="danger" disabled={busy} onClick={() => { if (window.confirm("Void this punch item? Admin only; cannot be undone.")) void transition("void"); }}>Void</Button>
            ) : null}
          </div>
        </div>
      )}
    </Modal>
  );
}
