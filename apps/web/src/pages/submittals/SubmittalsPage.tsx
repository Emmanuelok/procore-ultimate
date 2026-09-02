/**
 * Submittal workspace — spec Vol I §2.5.
 *
 *   Register    the numbered register with status/type/spec/closeout filters
 *   At risk     submit-by inside the project's window or already passed (#339)
 *   Closeout    O&M / warranty / certificate submittals, segregated (#348)
 *   Analytics   reviewer workload and turnaround, turnaround by type,
 *               resubmission rate by spec section (#347)
 *   Schedule    generate register rows from spec sections with back-computed
 *               submit-by dates (#337–#338)
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { SUBMITTAL_TYPES } from "@constructos/shared";
import { api } from "../../lib/api";
import { Badge, Button, Card, CardBody, EmptyState, ErrorAlert, Field, Input, Modal, PageHeader, Select, Skeleton, Stat, Tabs, Textarea, statusTone } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconSubmittal } from "../../ui/icons";
import { formatDate, humanize } from "../format";
import { DASH, errorMessage, qs, riskTone, submittalLabel, useCompanyUsers, useFieldResource, type ListResponse } from "../rfis/fieldShared";

interface SubmittalItem {
  id: string;
  number: number;
  revision: number;
  title: string;
  specSection: string | null;
  submittalType: string;
  status: string;
  ballInCourtId: string | null;
  requiredOnSite: string | null;
  submitByDate: string | null;
  responseCode: string | null;
  isCloseout: number;
  risk: string;
  label: string;
  daysToSubmitBy: number | null;
  daysInCourt: number | null;
}

interface Analytics {
  asOf: string;
  byStatus: Record<string, number>;
  overdue: number;
  atRisk: number;
  inCourtAgeing: { total: number; buckets: Record<string, number>; groups: Array<{ key: string; total: number; buckets: Record<string, number> }> };
  reviewers: Array<{ reviewerId: string; responded: number; avgDays: number | null; medianDays: number | null; inCourt: number; oldestInCourtDays: number | null; overdueInCourt: number }>;
  turnaroundByType: Array<{ submittalType: string; responded: number; avgDays: number }>;
  resubmissionBySpecSection: Array<{ specSection: string; submittals: number; revisions: number; rate: number }>;
  closeout: { total: number; approved: number; outstanding: number };
  stranded: number;
  basis: string;
}

const STATUSES = ["draft", "open", "in_review", "responded", "closed", "void", "superseded"] as const;
type TabKey = "register" | "atRisk" | "closeout" | "analytics" | "schedule";
const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "register", label: "Register" },
  { value: "atRisk", label: "At risk" },
  { value: "closeout", label: "Closeout" },
  { value: "analytics", label: "Analytics" },
  { value: "schedule", label: "Schedule generator" },
];
const PAGE_SIZE = 25;

interface CreateForm {
  title: string;
  specSection: string;
  submittalType: string;
  requiredOnSite: string;
  leadTimeDays: string;
  ballInCourtId: string;
  distribution: string[];
}
const emptyForm: CreateForm = { title: "", specSection: "", submittalType: "shop_drawing", requiredOnSite: "", leadTimeDays: "", ballInCourtId: "", distribution: [] };

export default function SubmittalsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const base = `/api/v1/projects/${projectId}/submittals`;
  const { users, nameOf } = useCompanyUsers();

  const [tab, setTab] = useState<TabKey>(() => {
    const t = searchParams.get("tab");
    return TABS.some((x) => x.value === t) ? (t as TabKey) : "register";
  });
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const listPath = useMemo(() => {
    if (!projectId) return null;
    const common = { page, pageSize: PAGE_SIZE, search: debounced };
    if (tab === "atRisk") return `${base}${qs({ ...common, atRisk: true })}`;
    if (tab === "closeout") return `${base}${qs({ ...common, closeout: true, status, type })}`;
    if (tab === "register") return `${base}${qs({ ...common, status, type })}`;
    return null;
  }, [projectId, base, tab, page, debounced, status, type]);
  const list = useFieldResource<ListResponse<SubmittalItem>>(listPath, [version]);
  const analytics = useFieldResource<Analytics>(projectId ? `${base}/analytics` : null, [version]);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function switchTab(next: TabKey) {
    setTab(next);
    setPage(1);
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    setSearchParams(params, { replace: true });
  }
  function set<K extends keyof CreateForm>(key: K, value: CreateForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { title: form.title.trim(), submittalType: form.submittalType };
      if (form.specSection.trim()) payload["specSection"] = form.specSection.trim();
      if (form.requiredOnSite) payload["requiredOnSite"] = form.requiredOnSite;
      if (form.leadTimeDays !== "") payload["leadTimeDays"] = Number(form.leadTimeDays);
      if (form.ballInCourtId) payload["ballInCourtId"] = form.ballInCourtId;
      if (form.distribution.length > 0) payload["distribution"] = form.distribution;
      const created = await api.post<SubmittalItem>(base, payload);
      setCreateOpen(false);
      setForm(emptyForm);
      navigate(`/projects/${projectId}/submittals/${created.id}`);
    } catch (err) {
      setCreateError(errorMessage(err, "Failed to create the submittal."));
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo<DataColumns<SubmittalItem>>(
    () => [
      { id: "number", header: "No.", accessor: (r) => submittalLabel(r.number, r.revision), type: "code", width: 90, mono: true },
      {
        id: "title",
        header: "Title",
        accessor: "title",
        width: 300,
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-1.5">
            <Link to={`/projects/${projectId}/submittals/${row.id}`} className="truncate font-medium text-brand-700 hover:text-brand-800">{row.title}</Link>
            {row.isCloseout === 1 ? <Badge tone="violet" size="xs">Closeout</Badge> : null}
          </span>
        ),
      },
      { id: "spec", header: "Spec", accessor: (r) => r.specSection ?? DASH, width: 100, mono: true },
      { id: "type", header: "Type", accessor: (r) => humanize(r.submittalType), width: 120 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 200,
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-1">
            <Badge tone={statusTone(row.status)}>{humanize(row.status)}</Badge>
            {row.responseCode ? <Badge tone={statusTone(row.responseCode)} size="xs">{humanize(row.responseCode)}</Badge> : null}
          </span>
        ),
      },
      { id: "bic", header: "Ball in court", accessor: (r) => nameOf(r.ballInCourtId), width: 160, cell: ({ row }) => <span>{nameOf(row.ballInCourtId)}{row.daysInCourt !== null ? <span className="ml-1 text-xs text-ink-400">{row.daysInCourt}d</span> : null}</span> },
      { id: "ros", header: "Required on site", accessor: "requiredOnSite", type: "date", width: 130, cell: ({ row }) => formatDate(row.requiredOnSite) },
      {
        id: "submitBy",
        header: "Submit by",
        accessor: "submitByDate",
        type: "date",
        width: 170,
        cell: ({ row }) => (
          <span className={row.risk === "late" || row.risk === "required_on_site_passed" ? "font-medium text-red-600" : row.risk === "at_risk" ? "font-medium text-amber-600" : ""}>
            {formatDate(row.submitByDate)}
            {row.risk !== "none" ? <Badge tone={riskTone(row.risk)} size="xs" className="ml-1">{humanize(row.risk)}</Badge> : null}
          </span>
        ),
      },
    ],
    [projectId, nameOf],
  );

  const a = analytics.data;
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = Boolean(status || type || debounced);

  return (
    <div>
      <PageHeader
        title="Submittals"
        subtitle="Register of shop drawings, product data and samples with review routing"
        icon={IconSubmittal}
        actions={<Button onClick={() => setCreateOpen(true)}>New submittal</Button>}
        tabs={<Tabs items={TABS.map((t) => ({ value: t.value, label: t.label, ...(t.value === "atRisk" && a && a.atRisk + a.overdue > 0 ? { count: a.atRisk + a.overdue, tone: "warning" as const } : {}) }))} value={tab} onChange={switchTab} />}
      />

      <Card className="mb-4">
        <CardBody className="py-3">
          {analytics.error ? <ErrorAlert message={analytics.error} /> : analytics.loading && !a ? <Skeleton height={56} /> : a ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-6">
              <Stat label="In review" value={a.byStatus["in_review"] ?? 0} size="sm" />
              <Stat label="Late" value={a.overdue} size="sm" tone={a.overdue > 0 ? "danger" : "neutral"} hint="submit-by passed" />
              <Stat label="At risk" value={a.atRisk} size="sm" tone={a.atRisk > 0 ? "warning" : "neutral"} />
              <Stat label="Responded" value={a.byStatus["responded"] ?? 0} size="sm" />
              <Stat label="Closeout outstanding" value={`${a.closeout.outstanding} / ${a.closeout.total}`} size="sm" />
              <Stat label="Stranded chains" value={a.stranded} size="sm" tone={a.stranded > 0 ? "danger" : "neutral"} hint={a.stranded > 0 ? "open the record and recompute" : "none"} />
            </div>
          ) : null}
        </CardBody>
      </Card>

      {tab === "register" || tab === "atRisk" || tab === "closeout" ? (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="w-64"><Input placeholder="Search by title…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></div>
            {tab !== "atRisk" ? (
              <>
                <div className="w-40">
                  <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
                    <option value="">All statuses</option>
                    {STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
                  </Select>
                </div>
                <div className="w-40">
                  <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
                    <option value="">All types</option>
                    {SUBMITTAL_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
                  </Select>
                </div>
              </>
            ) : (
              <span className="text-xs text-ink-500">Active submittals whose submit-by date is inside the project's at-risk window or has passed. {a ? a.basis : ""}</span>
            )}
          </div>
          <DataTable<SubmittalItem>
            data={list.data?.items ?? []}
            columns={columns}
            getRowId={(r) => r.id}
            loading={list.loading && !list.data}
            error={list.error}
            onRetry={list.reload}
            toolbar={false}
            rowHref={(r) => `/projects/${projectId}/submittals/${r.id}`}
            rowTone={(r) => (r.risk === "late" || r.risk === "required_on_site_passed" ? "danger" : r.risk === "at_risk" ? "warning" : undefined)}
            empty={{ title: tab === "atRisk" ? "Nothing at risk" : tab === "closeout" ? "No closeout submittals yet" : filtered ? "No submittals match your filters" : "No submittals yet", description: tab === "atRisk" ? "Every active submittal is outside the at-risk window." : tab === "closeout" ? "O&M manuals, warranties and certificates appear here." : filtered ? "Try clearing the filters." : "Build the register by logging the first submittal or generating it from spec sections.", action: tab === "register" ? <Button onClick={() => setCreateOpen(true)}>New submittal</Button> : undefined }}
          />
          <div className="mt-3 flex items-center justify-between text-sm text-ink-500">
            <span>{total} submittal{total === 1 ? "" : "s"} · page {page} of {totalPages}</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
              <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </>
      ) : null}

      {tab === "analytics" ? (
        analytics.error ? <ErrorAlert message={analytics.error} /> : !a ? <Skeleton height={240} /> : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardBody>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Reviewer workload and turnaround</h3>
                {a.reviewers.length === 0 ? <p className="text-sm text-ink-400">No review steps have been activated yet.</p> : (
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-ink-400"><tr><th className="py-1.5">Reviewer</th><th>In court</th><th>Overdue</th><th>Oldest</th><th>Responded</th><th>Avg</th><th>Median</th></tr></thead>
                    <tbody className="divide-y divide-ink-100">
                      {a.reviewers.map((r) => (
                        <tr key={r.reviewerId}>
                          <td className="py-2 font-medium text-ink-800">{nameOf(r.reviewerId)}</td>
                          <td className="tabular-nums">{r.inCourt}</td>
                          <td className={`tabular-nums ${r.overdueInCourt > 0 ? "font-medium text-red-600" : ""}`}>{r.overdueInCourt}</td>
                          <td className="tabular-nums">{r.oldestInCourtDays === null ? DASH : `${r.oldestInCourtDays}d`}</td>
                          <td className="tabular-nums">{r.responded}</td>
                          <td className="tabular-nums">{r.avgDays === null ? DASH : `${r.avgDays}d`}</td>
                          <td className="tabular-nums">{r.medianDays === null ? DASH : `${r.medianDays}d`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="mt-2 text-xs text-ink-400">{a.basis}</p>
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Turnaround by type</h3>
                {a.turnaroundByType.length === 0 ? <p className="text-sm text-ink-400">No responded steps yet.</p> : (
                  <ul className="divide-y divide-ink-100 text-sm">
                    {a.turnaroundByType.map((t) => (
                      <li key={t.submittalType} className="flex items-center justify-between py-1.5"><span>{humanize(t.submittalType)}</span><span className="tabular-nums">{t.avgDays}d avg · {t.responded} step{t.responded === 1 ? "" : "s"}</span></li>
                    ))}
                  </ul>
                )}
                <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-ink-500">Resubmission rate by spec section</h3>
                {a.resubmissionBySpecSection.length === 0 ? <p className="text-sm text-ink-400">No submittals yet.</p> : (
                  <ul className="divide-y divide-ink-100 text-sm">
                    {a.resubmissionBySpecSection.slice(0, 12).map((s) => (
                      <li key={s.specSection} className="flex items-center justify-between py-1.5">
                        <span className="font-mono text-xs">{s.specSection}</span>
                        <span className="tabular-nums">{s.revisions} rev / {s.submittals} sub · <Badge tone={s.rate >= 0.5 ? "red" : s.rate > 0 ? "amber" : "gray"} size="xs">{Math.round(s.rate * 100)}%</Badge></span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
            <Card className="lg:col-span-2">
              <CardBody>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">In-court ageing (in review)</h3>
                {a.inCourtAgeing.total === 0 ? <p className="text-sm text-ink-400">Nothing is in review.</p> : (
                  <div className="flex flex-wrap gap-3">
                    {Object.entries(a.inCourtAgeing.buckets).map(([b, n]) => (
                      <div key={b} className="rounded-md border border-ink-200 px-3 py-2 text-sm"><span className="text-ink-500">{b} days</span> <span className="ml-2 font-semibold tabular-nums">{n}</span></div>
                    ))}
                    {a.inCourtAgeing.groups.map((g) => (
                      <div key={g.key} className="rounded-md bg-ink-50 px-3 py-2 text-sm"><span className="text-ink-700">{nameOf(g.key)}</span> <span className="ml-2 tabular-nums">{g.total}</span></div>
                    ))}
                  </div>
                )}
              </CardBody>
            </Card>
          </div>
        )
      ) : null}

      {tab === "schedule" ? <SchedulePanel base={base} onCreated={() => { refresh(); switchTab("register"); }} /> : null}

      <Modal open={createOpen} title="New submittal" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <Field label="Title"><Input required value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="Structural steel shop drawings — Level 2" /></Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Spec section"><Input value={form.specSection} onChange={(e) => set("specSection", e.target.value)} placeholder="05 12 00" /></Field>
            <Field label="Type" hint="O&M, warranty and certificate types are segregated into the closeout package.">
              <Select value={form.submittalType} onChange={(e) => set("submittalType", e.target.value)}>
                {SUBMITTAL_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
              </Select>
            </Field>
            <Field label="Required on site"><Input type="date" value={form.requiredOnSite} onChange={(e) => set("requiredOnSite", e.target.value)} /></Field>
            <Field label="Lead time (days)" hint="Submit-by = required-on-site − lead time − the project's review allowance."><Input type="number" min="0" value={form.leadTimeDays} onChange={(e) => set("leadTimeDays", e.target.value)} /></Field>
            <Field label="Ball in court">
              <Select value={form.ballInCourtId} onChange={(e) => set("ballInCourtId", e.target.value)}>
                <option value="">Nobody yet</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </Select>
            </Field>
            <Field label="Distribution" hint="Notified on the final response and on close.">
              <select multiple className="h-24 w-full rounded-md border border-ink-200 bg-white px-2 py-1 text-sm" value={form.distribution} onChange={(e) => set("distribution", Array.from(e.target.selectedOptions).map((o) => o.value))}>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create submittal"}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

interface ScheduleRow {
  specSection: string;
  title: string;
  submittalType: string;
  requiredOnSite: string | null;
  leadTimeDays: number | null;
  submitByDate: string | null;
  isCloseout: boolean;
  reason: string | null;
}

function SchedulePanel({ base, onCreated }: { base: string; onCreated: () => void }) {
  const [raw, setRaw] = useState("");
  const [preview, setPreview] = useState<ScheduleRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function parseRows(): Array<Record<string, unknown>> {
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [specSection, title, submittalType, requiredOnSite, leadTimeDays] = line.split(/\t|\s*\|\s*/).map((c) => c?.trim() ?? "");
        const row: Record<string, unknown> = { specSection, title: title || specSection };
        if (submittalType && (SUBMITTAL_TYPES as readonly string[]).includes(submittalType)) row["submittalType"] = submittalType;
        if (requiredOnSite && /^\d{4}-\d{2}-\d{2}$/.test(requiredOnSite)) row["requiredOnSite"] = requiredOnSite;
        if (leadTimeDays && /^\d+$/.test(leadTimeDays)) row["leadTimeDays"] = Number(leadTimeDays);
        return row;
      });
  }

  async function run(create: boolean) {
    setBusy(true);
    setError(null);
    try {
      const items = parseRows();
      if (items.length === 0) throw new Error("Add at least one line: spec section | title | type | required-on-site | lead days");
      const res = await api.post<{ preview: boolean; items: ScheduleRow[] }>(`${base}/schedule`, { items, create });
      if (create) onCreated();
      else setPreview(res.items);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardBody>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">Generate the register from spec sections</h3>
          <p className="mb-3 text-xs text-ink-500">One line per submittal: <code>spec section | title | type | required-on-site (YYYY-MM-DD) | lead days</code>. Rows without a site date get no submit-by date and say why — the date is never invented.</p>
          <ErrorAlert message={error} />
          <Textarea rows={10} value={raw} onChange={(e) => setRaw(e.target.value)} placeholder={"08 44 13 | Curtain wall shop drawings | shop_drawing | 2026-12-01 | 30\n01 78 23 | O&M manuals | o_and_m | 2027-03-01\n09 91 00 | Paint samples | sample"} />
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => void run(false)}>Preview</Button>
            <Button disabled={busy || !preview} onClick={() => { if (window.confirm(`Create ${preview?.length ?? 0} submittals?`)) void run(true); }}>Create {preview ? preview.length : ""}</Button>
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Preview</h3>
          {!preview ? <EmptyState title="No preview yet" hint="Paste spec sections on the left and press Preview." size="sm" /> : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-ink-400"><tr><th className="py-1.5">Spec</th><th>Title</th><th>Type</th><th>Submit by</th></tr></thead>
              <tbody className="divide-y divide-ink-100">
                {preview.map((r, i) => (
                  <tr key={i}>
                    <td className="py-1.5 font-mono text-xs">{r.specSection}</td>
                    <td>{r.title}{r.isCloseout ? <Badge tone="violet" size="xs" className="ml-1">Closeout</Badge> : null}</td>
                    <td>{humanize(r.submittalType)}</td>
                    <td>{r.submitByDate ? formatDate(r.submitByDate) : <span className="text-xs text-amber-700">{r.reason}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {preview ? <p className="mt-2 text-xs text-ink-400">{preview.filter((p) => p.submitByDate).length} of {preview.length} rows carry a submit-by date.</p> : null}
        </CardBody>
      </Card>
    </div>
  );
}
