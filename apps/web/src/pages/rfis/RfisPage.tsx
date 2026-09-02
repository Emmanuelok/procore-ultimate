/**
 * RFI workspace — spec Vol I §2.4.
 *
 *   Register        the numbered list with status/overdue/ball-in-court filters
 *   Ageing          open RFIs bucketed 0-7 / 8-14 / 15-30 / 30+ by holder (#322)
 *   Ball in court   who is holding what, how long, how many overdue (#321)
 *   Inbound         paste a parsed email to file it as a draft RFI (#324)
 *
 * Every figure in the KPI row states its basis (the API's `cycleTimeBasis`);
 * a cycle time with no answered RFIs is "—", never 0.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { RFI_STATUSES } from "@constructos/shared";
import { api } from "../../lib/api";
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
  PageHeader,
  Select,
  Skeleton,
  Stat,
  Tabs,
  Textarea,
  statusTone,
} from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconRfi } from "../../ui/icons";
import { formatDate, humanize } from "../format";
import {
  AGEING_BUCKETS,
  DASH,
  bucketTone,
  daysLabel,
  errorMessage,
  impactTone,
  qs,
  rfiLabel,
  todayIso,
  useCompanyUsers,
  useFieldResource,
  type AgeingReport,
  type ListResponse,
} from "./fieldShared";

interface RfiItem {
  id: string;
  number: number;
  subject: string;
  status: string;
  assigneeId: string | null;
  ballInCourtId: string | null;
  dueDate: string | null;
  costImpact: string;
  scheduleImpact: string;
  isPrivate: number;
  source: string;
  createdAt: string;
  daysOverdue: number;
  ageDays: number | null;
}

interface RfiAnalytics {
  open: number;
  overdue: number;
  avgResponseDays: number | null;
  medianResponseDays: number | null;
  cycleTimeBasis: string;
  answeredCount: number;
  byStatus: Record<string, number>;
  ballInCourt: Array<{ userId: string; open: number; overdue: number; avgDaysInCourt: number | null; oldestDays: number }>;
  impacts: { costYes: number; scheduleYes: number; tbd: number };
}

type TabKey = "register" | "ageing" | "court" | "inbound";
const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "register", label: "Register" },
  { value: "ageing", label: "Ageing" },
  { value: "court", label: "Ball in court" },
  { value: "inbound", label: "Inbound email" },
];
const PAGE_SIZE = 25;

interface CreateForm {
  subject: string;
  question: string;
  proposedSolution: string;
  assigneeId: string;
  dueDate: string;
  distribution: string[];
  isPrivate: boolean;
  relatedRfiIds: string[];
}
const emptyForm: CreateForm = { subject: "", question: "", proposedSolution: "", assigneeId: "", dueDate: "", distribution: [], isPrivate: false, relatedRfiIds: [] };

export default function RfisPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const base = `/api/v1/projects/${projectId}/rfis`;
  const { users, nameOf } = useCompanyUsers();

  const [tab, setTab] = useState<TabKey>(() => {
    const t = searchParams.get("tab");
    return TABS.some((x) => x.value === t) ? (t as TabKey) : "register";
  });
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [holder, setHolder] = useState("");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const list = useFieldResource<ListResponse<RfiItem>>(
    projectId ? `${base}${qs({ page, pageSize: PAGE_SIZE, status, overdue: overdueOnly, ballInCourtId: holder, search: debounced })}` : null,
    [version],
  );
  const analytics = useFieldResource<RfiAnalytics>(projectId ? `${base}/analytics` : null, [version]);
  const [ageingGroup, setAgeingGroup] = useState<"ballInCourt" | "assignee">("ballInCourt");
  const ageing = useFieldResource<AgeingReport>(projectId && tab === "ageing" ? `${base}/ageing?groupBy=${ageingGroup}` : null, [version]);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const allRfis = useFieldResource<ListResponse<{ id: string; number: number; subject: string }>>(createOpen && projectId ? `${base}?pageSize=200` : null);

  function switchTab(next: TabKey) {
    setTab(next);
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
      const payload: Record<string, unknown> = { subject: form.subject.trim(), question: form.question.trim(), isPrivate: form.isPrivate };
      if (form.proposedSolution.trim()) payload["proposedSolution"] = form.proposedSolution.trim();
      if (form.assigneeId) payload["assigneeId"] = form.assigneeId;
      if (form.dueDate) payload["dueDate"] = form.dueDate;
      if (form.distribution.length > 0) payload["distribution"] = form.distribution;
      if (form.relatedRfiIds.length > 0) payload["relatedRfiIds"] = form.relatedRfiIds;
      const created = await api.post<RfiItem>(base, payload);
      setCreateOpen(false);
      setForm(emptyForm);
      navigate(`/projects/${projectId}/rfis/${created.id}`);
    } catch (err) {
      setCreateError(errorMessage(err, "Failed to create the RFI."));
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo<DataColumns<RfiItem>>(
    () => [
      { id: "number", header: "No.", accessor: (r) => rfiLabel(r.number), type: "code", width: 96, mono: true },
      {
        id: "subject",
        header: "Subject",
        accessor: "subject",
        width: 320,
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-1.5">
            <Link to={`/projects/${projectId}/rfis/${row.id}`} className="truncate font-medium text-brand-700 hover:text-brand-800">
              {row.subject}
            </Link>
            {row.isPrivate === 1 ? <Badge tone="gray" size="xs">Private</Badge> : null}
            {row.source === "email" ? <Badge tone="blue" size="xs">Email</Badge> : null}
          </span>
        ),
      },
      { id: "status", header: "Status", accessor: "status", type: "status", width: 120, cell: ({ row }) => <Badge tone={statusTone(row.status)}>{humanize(row.status)}</Badge> },
      { id: "bic", header: "Ball in court", accessor: (r) => nameOf(r.ballInCourtId), width: 170 },
      {
        id: "due",
        header: "Due",
        accessor: "dueDate",
        type: "date",
        width: 130,
        cell: ({ row }) => (
          <span className={row.daysOverdue > 0 ? "font-medium text-red-600" : ""}>
            {formatDate(row.dueDate)}
            {row.daysOverdue > 0 ? ` · ${daysLabel(row.daysOverdue)} late` : ""}
          </span>
        ),
      },
      { id: "age", header: "Age", accessor: (r) => r.ageDays, type: "number", width: 80, cell: ({ row }) => <span className="tabular-nums">{row.ageDays === null ? DASH : `${row.ageDays}d`}</span> },
      { id: "cost", header: "Cost", accessor: "costImpact", width: 80, cell: ({ row }) => <Badge tone={impactTone(row.costImpact)}>{row.costImpact.toUpperCase()}</Badge> },
      { id: "schedule", header: "Schedule", accessor: "scheduleImpact", width: 90, cell: ({ row }) => <Badge tone={impactTone(row.scheduleImpact)}>{row.scheduleImpact.toUpperCase()}</Badge> },
    ],
    [projectId, nameOf],
  );

  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const a = analytics.data;

  return (
    <div>
      <PageHeader
        title="RFIs"
        subtitle="Requests for information — question, response approval and impact tracking"
        icon={IconRfi}
        actions={<Button onClick={() => setCreateOpen(true)}>New RFI</Button>}
        tabs={<Tabs items={TABS.map((t) => ({ value: t.value, label: t.label, ...(t.value === "ageing" && a && a.overdue > 0 ? { count: a.overdue, tone: "danger" as const } : {}) }))} value={tab} onChange={switchTab} />}
      />

      <Card className="mb-4">
        <CardBody className="py-3">
          {analytics.error ? (
            <ErrorAlert message={analytics.error} />
          ) : analytics.loading && !a ? (
            <Skeleton height={56} />
          ) : a ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              <Stat label="Open" value={a.open} size="sm" />
              <Stat label="Overdue" value={a.overdue} size="sm" tone={a.overdue > 0 ? "danger" : "neutral"} />
              <Stat label="Avg response" value={a.avgResponseDays === null ? DASH : `${a.avgResponseDays}d`} size="sm" hint={a.cycleTimeBasis} />
              <Stat label="Median response" value={a.medianResponseDays === null ? DASH : `${a.medianResponseDays}d`} size="sm" hint={`${a.answeredCount} answered`} />
              <Stat label="Cost / schedule impact" value={`${a.impacts.costYes} / ${a.impacts.scheduleYes}`} size="sm" hint={`${a.impacts.tbd} still TBD`} />
            </div>
          ) : null}
        </CardBody>
      </Card>

      {tab === "register" ? (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="w-64">
              <Input placeholder="Search by subject…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
            </div>
            <div className="w-40">
              <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
                <option value="">All statuses</option>
                {RFI_STATUSES.map((s) => (
                  <option key={s} value={s}>{humanize(s)}</option>
                ))}
              </Select>
            </div>
            <div className="w-48">
              <Select value={holder} onChange={(e) => { setHolder(e.target.value); setPage(1); }}>
                <option value="">Any ball in court</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </Select>
            </div>
            <Button variant={overdueOnly ? "primary" : "secondary"} size="sm" onClick={() => { setOverdueOnly((v) => !v); setPage(1); }}>
              Overdue only
            </Button>
          </div>
          <DataTable<RfiItem>
            data={list.data?.items ?? []}
            columns={columns}
            getRowId={(r) => r.id}
            loading={list.loading && !list.data}
            error={list.error}
            onRetry={list.reload}
            toolbar={false}
            rowHref={(r) => `/projects/${projectId}/rfis/${r.id}`}
            rowTone={(r) => (r.daysOverdue > 0 ? "danger" : undefined)}
            empty={{ title: status || debounced || overdueOnly || holder ? "No RFIs match your filters" : "No RFIs yet", description: status || debounced || overdueOnly || holder ? "Try clearing the filters." : "Raise the first request for information on this project.", action: <Button onClick={() => setCreateOpen(true)}>New RFI</Button> }}
          />
          <div className="mt-3 flex items-center justify-between text-sm text-ink-500">
            <span>{total} RFI{total === 1 ? "" : "s"} · page {page} of {totalPages}</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
              <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </>
      ) : null}

      {tab === "ageing" ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-ink-500">Group by</span>
            <div className="w-44">
              <Select value={ageingGroup} onChange={(e) => setAgeingGroup(e.target.value as "ballInCourt" | "assignee")}>
                <option value="ballInCourt">Ball in court</option>
                <option value="assignee">Assignee</option>
              </Select>
            </div>
            <Button variant="ghost" size="sm" onClick={refresh}>Refresh</Button>
          </div>
          <AgeingPanel report={ageing.data} loading={ageing.loading} error={ageing.error} onRetry={ageing.reload} nameOf={nameOf} labelOf={(i) => `${rfiLabel(i.number)} ${i.subject ?? ""}`} hrefOf={(i) => `/projects/${projectId}/rfis/${i.id}`} />
        </div>
      ) : null}

      {tab === "court" ? (
        <Card>
          <CardBody>
            {analytics.error ? <ErrorAlert message={analytics.error} /> : null}
            {a && a.ballInCourt.length === 0 ? (
              <EmptyState title="Nobody is holding an open RFI" hint="Every open RFI has a ball-in-court holder once it is issued." />
            ) : a ? (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-ink-400">
                  <tr><th className="py-1.5">Holder</th><th>Open</th><th>Overdue</th><th>Avg days in court</th><th>Oldest</th></tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {a.ballInCourt.map((b) => (
                    <tr key={b.userId} className="hover:bg-ink-50/60">
                      <td className="py-2 font-medium text-ink-800">
                        <button type="button" className="text-brand-700 hover:underline" onClick={() => { setHolder(b.userId); setPage(1); switchTab("register"); }}>{nameOf(b.userId)}</button>
                      </td>
                      <td className="tabular-nums">{b.open}</td>
                      <td className={`tabular-nums ${b.overdue > 0 ? "font-medium text-red-600" : ""}`}>{b.overdue}</td>
                      <td className="tabular-nums">{b.avgDaysInCourt === null ? DASH : `${b.avgDaysInCourt}d`}</td>
                      <td className="tabular-nums">{daysLabel(b.oldestDays)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Skeleton height={120} />
            )}
            <p className="mt-3 text-xs text-ink-400">Days in court are measured from issue (or creation for legacy records) to today.</p>
          </CardBody>
        </Card>
      ) : null}

      {tab === "inbound" ? <InboundPanel base={base} onDone={(id) => navigate(`/projects/${projectId}/rfis/${id}`)} /> : null}

      <Modal open={createOpen} title="New RFI" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <Field label="Subject">
            <Input required value={form.subject} onChange={(e) => set("subject", e.target.value)} placeholder="Clarify slab edge detail at grid C-4" />
          </Field>
          <Field label="Question" hint="Locked once the RFI is issued — a changed question means a new RFI.">
            <Textarea required value={form.question} onChange={(e) => set("question", e.target.value)} placeholder="Describe the information you need…" />
          </Field>
          <Field label="Proposed solution" hint="Optional — suggest an answer to speed up review.">
            <Textarea value={form.proposedSolution} onChange={(e) => set("proposedSolution", e.target.value)} />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Assignee (ball in court)">
              <Select value={form.assigneeId} onChange={(e) => set("assigneeId", e.target.value)}>
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Response due" hint="Defaults to 7 days after issue if left blank.">
              <Input type="date" value={form.dueDate} onChange={(e) => set("dueDate", e.target.value)} />
            </Field>
            <Field label="Distribution" hint="Notified on issue and on the official answer.">
              <select multiple className="h-28 w-full rounded-md border border-ink-200 bg-white px-2 py-1 text-sm" value={form.distribution} onChange={(e) => set("distribution", Array.from(e.target.selectedOptions).map((o) => o.value))}>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </Field>
            <Field label="References prior RFIs" hint="Optional — link the RFIs this one builds on.">
              <select multiple className="h-28 w-full rounded-md border border-ink-200 bg-white px-2 py-1 text-sm" value={form.relatedRfiIds} onChange={(e) => set("relatedRfiIds", Array.from(e.target.selectedOptions).map((o) => o.value))}>
                {(allRfis.data?.items ?? []).map((r) => (
                  <option key={r.id} value={r.id}>{rfiLabel(r.number)} {r.subject}</option>
                ))}
              </select>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" checked={form.isPrivate} onChange={(e) => set("isPrivate", e.target.checked)} />
            Private draft — visible only to me, the assignee, the distribution and admins until issued
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create RFI"}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/** Shared ageing panel: buckets by group plus the open items. Used by RFIs and punch. */
export function AgeingPanel({
  report,
  loading,
  error,
  onRetry,
  nameOf,
  labelOf,
  hrefOf,
}: {
  report: AgeingReport | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  nameOf: (id: string | null | undefined) => string;
  labelOf: (item: AgeingReport["items"][number]) => string;
  hrefOf?: (item: AgeingReport["items"][number]) => string;
}) {
  if (error) return <ErrorAlert message={error} onRetry={onRetry} />;
  if (loading && !report) return <Skeleton height={200} />;
  if (!report) return null;
  const groupName = (key: string) => (key === "unassigned" || key.startsWith("no ") || key === "low" || key === "medium" || key === "high" ? humanize(key) : nameOf(key) === "Unknown user" ? key : nameOf(key));
  if (report.total === 0) return <EmptyState title="Nothing open to age" hint={`As of ${report.asOf} there are no open records in this register.`} />;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {AGEING_BUCKETS.map((b) => (
          <Card key={b}>
            <CardBody className="py-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-ink-400">{b} days</span>
                <Badge tone={bucketTone(b)} size="xs">{b}</Badge>
              </div>
              <div className="mt-0.5 text-2xl font-semibold text-ink-900">{report.buckets[b] ?? 0}</div>
            </CardBody>
          </Card>
        ))}
      </div>
      <Card>
        <CardBody>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">By {humanize(report.groupBy)}</h3>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-ink-400">
              <tr><th className="py-1.5">Group</th><th>Total</th>{AGEING_BUCKETS.map((b) => <th key={b}>{b}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {report.groups.map((g) => (
                <tr key={g.key}>
                  <td className="py-2 font-medium text-ink-800">{groupName(g.key)}</td>
                  <td className="tabular-nums">{g.total}</td>
                  {AGEING_BUCKETS.map((b) => (
                    <td key={b} className={`tabular-nums ${b === "30+" && (g.buckets[b] ?? 0) > 0 ? "font-medium text-red-600" : ""}`}>{g.buckets[b] ?? 0}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-400">{report.basis ?? `Age in calendar days as of ${report.asOf}.`}</p>
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Oldest first</h3>
          <ul className="divide-y divide-ink-100 text-sm">
            {[...report.items].sort((x, y) => y.ageDays - x.ageDays).slice(0, 50).map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate">
                  {hrefOf ? <Link to={hrefOf(i)} className="text-brand-700 hover:underline">{labelOf(i)}</Link> : labelOf(i)}
                  <span className="ml-2 text-xs text-ink-400">{groupName(i.group)}</span>
                </span>
                <span className="shrink-0 tabular-nums">
                  <Badge tone={bucketTone(i.ageDays <= 7 ? "0-7" : i.ageDays <= 14 ? "8-14" : i.ageDays <= 30 ? "15-30" : "30+")} size="xs">{i.ageDays}d</Badge>
                  {i.daysOverdue > 0 ? <span className="ml-2 text-xs font-medium text-red-600">{daysLabel(i.daysOverdue)} late</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}

function InboundPanel({ base, onDone }: { base: string; onDone: (rfiId: string) => void }) {
  const [from, setFrom] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ action: string; rfiId: string } | null>(null);
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ action: string; rfiId: string }>(`${base}/inbound`, { email: { from, subject, text, receivedAt: new Date().toISOString() } });
      setResult(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardBody>
        <h3 className="mb-1 text-sm font-semibold text-ink-900">File an email as an RFI</h3>
        <p className="mb-3 text-xs text-ink-500">
          The mail transport posts parsed messages here automatically; this form lets you file one by hand. A subject carrying an existing reference (e.g. "RE: RFI-012 …") becomes a draft response on that RFI instead of a new record.
        </p>
        <ErrorAlert message={error} />
        {result ? (
          <div className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
            {result.action === "draft_response" ? "Filed as a draft response." : "Created a draft RFI."}{" "}
            <button type="button" className="font-medium underline" onClick={() => onDone(result.rfiId)}>Open it</button>
          </div>
        ) : null}
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="From"><Input required value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Jane Doe <jane@example.com>" /></Field>
            <Field label="Subject"><Input required value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Fwd: Rebar spacing at B2" /></Field>
          </div>
          <Field label="Body"><Textarea required value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the message text…" /></Field>
          <div className="flex justify-end"><Button type="submit" disabled={busy}>{busy ? "Filing…" : "File"}</Button></div>
        </form>
      </CardBody>
    </Card>
  );
}
