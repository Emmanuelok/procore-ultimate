/**
 * ISSUES & DECISIONS — the discipline-routed issue register (#250, #901–#903)
 * and the decision log (#251–#252, #904–#905).
 *
 * Ball-in-court is answered by DISCIPLINE first, which is what survives a
 * change of assignee. A decision is proposed by one person and taken by
 * another, and a superseded decision keeps its place in the log.
 */
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  DCN_AUTHORISATION_LEVELS,
  DESIGN_DECISION_STATUSES,
  DESIGN_DISCIPLINES,
  DESIGN_ISSUE_PRIORITIES,
  DESIGN_ISSUE_STATUSES,
  DESIGN_ISSUE_TYPES,
} from "@constructos/shared";
import { Badge, Button, Card, CardBody, Drawer, EmptyState, Field, Input, Select, Skeleton, Textarea } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconIssue, IconPlus } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  AUTHORISATION_TONE,
  DECISION_STATUS_TONE,
  EM_DASH,
  ISSUE_STATUS_TONE,
  KeyValue,
  LoadError,
  PRIORITY_TONE,
  ReasonList,
  RefusalNotice,
  SectionHeading,
  dateTime,
  isoDate,
  labelize,
  money,
  num,
  optionList,
  useAction,
  useResource,
  type DecisionRow,
  type DisciplineBallInCourt,
  type IssueRow,
  type ListResponse,
  type Lookups,
} from "./designShared";

export default function IssuesTab({
  projectId,
  lookups,
  onChanged,
}: {
  projectId: string;
  lookups: Lookups;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}/design`;
  const [status, setStatus] = useState("");
  const [discipline, setDiscipline] = useState("");
  const [priority, setPriority] = useState("");
  const query = new URLSearchParams({ pageSize: "500" });
  if (status) query.set("status", status);
  if (discipline) query.set("discipline", discipline);
  if (priority) query.set("priority", priority);
  const issues = useResource<ListResponse<IssueRow>>(`${base}/issues?${query.toString()}`);
  const ballInCourt = useResource<{ items: DisciplineBallInCourt[]; total: number; reasons: string[] }>(
    `${base}/issues-by-discipline`,
  );
  const decisions = useResource<ListResponse<DecisionRow>>(`${base}/decisions?pageSize=500`);
  const [createOpen, setCreateOpen] = useState(false);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [openIssueId, setOpenIssueId] = useState<string | null>(null);
  const [openDecisionId, setOpenDecisionId] = useState<string | null>(null);
  const issueDetail = useResource<IssueRow & { decisions: DecisionRow[] }>(openIssueId ? `${base}/issues/${openIssueId}` : null);
  const decisionDetail = useResource<DecisionRow & { supersedes: DecisionRow | null; supersededBy: DecisionRow[] }>(
    openDecisionId ? `${base}/decisions/${openDecisionId}` : null,
  );
  const action = useAction();

  function changed() {
    issues.reload();
    ballInCourt.reload();
    decisions.reload();
    issueDetail.reload();
    decisionDetail.reload();
    onChanged();
  }

  const userName = useMemo(() => new Map(lookups.users.map((u) => [u.id, u.name || u.email])), [lookups.users]);

  const issueColumns = useMemo<DataColumns<IssueRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "code", sticky: "start", width: 90, mono: true },
      { id: "title", header: "Issue", accessor: "title", type: "text", width: 260 },
      {
        id: "issueType",
        header: "Type",
        accessor: "issueType",
        type: "text",
        width: 130,
        groupable: true,
        cell: ({ row }) => labelize(row.issueType),
      },
      {
        id: "discipline",
        header: "Routed to",
        accessor: "discipline",
        type: "text",
        width: 150,
        groupable: true,
        cell: ({ row }) => labelize(row.discipline),
      },
      {
        id: "priority",
        header: "Priority",
        accessor: "priority",
        type: "status",
        width: 100,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={PRIORITY_TONE[row.priority] ?? "neutral"} size="xs" dot>
            {labelize(row.priority)}
          </Badge>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 120,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={ISSUE_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "assignee",
        header: "Assignee",
        accessor: (row) => (row.assignedToUserId ? userName.get(row.assignedToUserId) ?? row.assignedToUserId : ""),
        type: "text",
        width: 160,
      },
      {
        id: "dueDate",
        header: "Due",
        accessor: (row) => row.dueDate ?? "",
        type: "date",
        width: 120,
        cell: ({ row }) => (row.dueDate ? isoDate(row.dueDate) : <span className="italic text-content-subtle">no date</span>),
      },
      { id: "raisedAt", header: "Raised", accessor: (row) => row.raisedAt, type: "date", width: 120, cell: ({ row }) => isoDate(row.raisedAt) },
    ],
    [userName],
  );

  const decisionColumns = useMemo<DataColumns<DecisionRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "code", sticky: "start", width: 90, mono: true },
      { id: "title", header: "Decision", accessor: "title", type: "text", width: 260 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 120,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={DECISION_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "discipline",
        header: "Discipline",
        accessor: "discipline",
        type: "text",
        width: 150,
        groupable: true,
        cell: ({ row }) => labelize(row.discipline),
      },
      {
        id: "authorisationLevel",
        header: "Authority",
        accessor: (row) => row.authorisationLevel ?? "",
        type: "status",
        width: 140,
        cell: ({ row }) =>
          row.authorisationLevel ? (
            <Badge tone={AUTHORISATION_TONE[row.authorisationLevel] ?? "neutral"} size="xs">
              {labelize(row.authorisationLevel)}
            </Badge>
          ) : (
            <span className="italic text-content-subtle">not taken</span>
          ),
      },
      {
        id: "costImpact",
        header: "Cost impact",
        accessor: (row) => row.costImpact,
        type: "number",
        width: 130,
        cell: ({ row }) => (row.costImpact === null ? <span className="italic text-content-subtle">not assessed</span> : money(row.costImpact, row.currency)),
      },
      {
        id: "timeImpactDays",
        header: "Time (d)",
        accessor: (row) => row.timeImpactDays,
        type: "number",
        width: 100,
        signColor: true,
      },
      {
        id: "decidedAt",
        header: "Decided",
        accessor: (row) => row.decidedAt ?? "",
        type: "date",
        width: 130,
        cell: ({ row }) => (row.decidedAt ? isoDate(row.decidedAt) : <span className="italic text-content-subtle">open</span>),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}

      <Card>
        <CardBody>
          <SectionHeading
            title="Ball in court, by discipline"
            hint="An issue is owned by a discipline first and a person second — that is what makes 'who is holding the coordination' answerable when the assignee changes."
          />
          {ballInCourt.error ? <LoadError message={ballInCourt.error} onRetry={ballInCourt.reload} /> : null}
          {(ballInCourt.data?.items ?? []).length === 0 ? (
            <EmptyState icon={IconIssue} title="No design issue has been raised" description="Issues arrive from review comments, coordination clashes and gaps in the brief." />
          ) : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
              {(ballInCourt.data?.items ?? []).map((entry) => (
                <button
                  key={entry.discipline}
                  type="button"
                  onClick={() => setDiscipline(entry.discipline)}
                  className="rounded-lg border border-border-subtle bg-surface-raised p-3 text-left hover:bg-surface-hover"
                >
                  <div className="truncate text-2xs uppercase tracking-wide text-content-subtle">{labelize(entry.discipline)}</div>
                  <div className="text-display-xs font-semibold tabular-nums text-content">{entry.open}</div>
                  <div className="text-2xs text-content-muted">
                    {entry.critical > 0 ? <span className="text-danger-fg">{entry.critical} critical/high · </span> : null}
                    {entry.overdue > 0 ? <span className="text-warning-fg">{entry.overdue} overdue · </span> : null}
                    {entry.oldestDays === null ? "none open" : `oldest ${entry.oldestDays} d`}
                  </div>
                </button>
              ))}
            </div>
          )}
          <ReasonList reasons={ballInCourt.data?.reasons ?? []} className="mt-2" />
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <SectionHeading
            title="Design issue register"
            hint="Resolution and closure are different acts by different people: whoever resolved an issue cannot be the one who closes it."
            actions={
              <>
                <Select size="sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
                  <option value="">All statuses</option>
                  {DESIGN_ISSUE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {labelize(s)}
                    </option>
                  ))}
                </Select>
                <Select size="sm" value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority filter">
                  <option value="">All priorities</option>
                  {DESIGN_ISSUE_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {labelize(p)}
                    </option>
                  ))}
                </Select>
                <Select size="sm" value={discipline} onChange={(e) => setDiscipline(e.target.value)} aria-label="Discipline filter">
                  <option value="">All disciplines</option>
                  {DESIGN_DISCIPLINES.map((d) => (
                    <option key={d} value={d}>
                      {labelize(d)}
                    </option>
                  ))}
                </Select>
                <Button size="sm" leadingIcon={IconPlus} onClick={() => setCreateOpen(true)}>
                  Raise an issue
                </Button>
              </>
            }
          />
          {issues.error ? <LoadError message={issues.error} onRetry={issues.reload} /> : null}
          <DataTable<IssueRow>
            tableId="design-issues"
            data={issues.data?.items ?? []}
            columns={issueColumns}
            getRowId={(row) => row.id}
            loading={issues.loading && !issues.data}
            height={440}
            stickyHeader
            filterRow
            exportFileName="design-issues"
            searchPlaceholder="Search by reference or title…"
            defaultSort={[{ id: "dueDate", desc: false }]}
            onRowClick={({ row }) => setOpenIssueId(row.id)}
            rowTone={(row) => (row.priority === "critical" && row.status !== "closed" ? "danger" : undefined)}
            empty={{ title: "No design issue", description: "Raise one directly, or escalate a review comment the designer could not resolve." }}
          />
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <SectionHeading
            title="Decision log"
            hint="The question, the options considered, the choice and the rationale — with the authority under which it was taken. A decision is taken by someone other than whoever proposed it."
            actions={
              <Button size="sm" leadingIcon={IconPlus} onClick={() => setDecisionOpen(true)}>
                Propose a decision
              </Button>
            }
          />
          {decisions.error ? <LoadError message={decisions.error} onRetry={decisions.reload} /> : null}
          <DataTable<DecisionRow>
            tableId="design-decisions"
            data={decisions.data?.items ?? []}
            columns={decisionColumns}
            getRowId={(row) => row.id}
            loading={decisions.loading && !decisions.data}
            height={380}
            stickyHeader
            filterRow
            exportFileName="design-decisions"
            searchPlaceholder="Search by reference or title…"
            defaultSort={[{ id: "reference", desc: true }]}
            onRowClick={({ row }) => setOpenDecisionId(row.id)}
            empty={{ title: "No decision has been logged", description: "The decision log is what answers 'why is it like this?' two years later." }}
          />
        </CardBody>
      </Card>

      <IssueForm
        base={base}
        open={createOpen}
        lookups={lookups}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          changed();
        }}
      />
      <DecisionForm
        base={base}
        open={decisionOpen}
        lookups={lookups}
        onClose={() => setDecisionOpen(false)}
        onCreated={() => {
          setDecisionOpen(false);
          changed();
        }}
      />
      <IssueDrawer base={base} issueId={openIssueId} detail={issueDetail} lookups={lookups} onClose={() => setOpenIssueId(null)} onChanged={changed} />
      <DecisionDrawer base={base} decisionId={openDecisionId} detail={decisionDetail} onClose={() => setOpenDecisionId(null)} onChanged={changed} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function IssueForm({
  base,
  open,
  lookups,
  onClose,
  onCreated,
}: {
  base: string;
  open: boolean;
  lookups: Lookups;
  onClose: () => void;
  onCreated: () => void;
}) {
  const action = useAction();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [issueType, setIssueType] = useState("coordination");
  const [priority, setPriority] = useState("medium");
  const [discipline, setDiscipline] = useState("multi_discipline");
  const [packageId, setPackageId] = useState("");
  const [assignedToUserId, setAssignedToUserId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [sheetId, setSheetId] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { title: title.trim(), issueType, priority, discipline };
    if (description.trim()) payload["description"] = description.trim();
    if (packageId) payload["packageId"] = packageId;
    if (assignedToUserId) payload["assignedToUserId"] = assignedToUserId;
    if (dueDate) payload["dueDate"] = dueDate;
    if (sheetId) payload["drawingSheetId"] = sheetId;
    const r = await action.run("create", () => api.post<IssueRow>(`${base}/issues`, payload));
    if (r) {
      toast.success(`${r.reference} raised`);
      setTitle("");
      setDescription("");
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Raise a design issue" description="Route it to the discipline that owns the answer; the assignee can change without losing that." size="md">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </Field>
        <Field label="Description">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Type">
            <Select value={issueType} onChange={(e) => setIssueType(e.target.value)}>
              {DESIGN_ISSUE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {labelize(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
              {DESIGN_ISSUE_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {labelize(p)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Routed to discipline">
            <Select value={discipline} onChange={(e) => setDiscipline(e.target.value)}>
              {DESIGN_DISCIPLINES.map((d) => (
                <option key={d} value={d}>
                  {labelize(d)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Package">
            <Select value={packageId} onChange={(e) => setPackageId(e.target.value)}>
              {optionList(lookups.packages, (p) => `${p.reference} — ${p.name}`).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Assign to">
            <Select value={assignedToUserId} onChange={(e) => setAssignedToUserId(e.target.value)}>
              {optionList(lookups.users, (u) => u.name || u.email).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due date">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Drawing sheet" className="sm:col-span-2">
            <Select value={sheetId} onChange={(e) => setSheetId(e.target.value)}>
              {optionList(lookups.sheets, (s) => `${s.number} — ${s.title}`).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <ReasonList reasons={lookups.notes} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"} disabled={!title.trim()}>
            Raise
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */

function IssueDrawer({
  base,
  issueId,
  detail,
  lookups,
  onClose,
  onChanged,
}: {
  base: string;
  issueId: string | null;
  detail: ReturnType<typeof useResource<IssueRow & { decisions: DecisionRow[] }>>;
  lookups: Lookups;
  onClose: () => void;
  onChanged: () => void;
}) {
  const action = useAction();
  const [assignee, setAssignee] = useState("");
  const [assignDiscipline, setAssignDiscipline] = useState("");
  const row = detail.data;

  async function assign() {
    const payload: Record<string, unknown> = {};
    if (assignee) payload["assignedToUserId"] = assignee;
    if (assignDiscipline) payload["discipline"] = assignDiscipline;
    const r = await action.run("assign", () => api.post(`${base}/issues/${issueId}/assign`, payload));
    if (r) {
      toast.success("Routed");
      onChanged();
    }
  }

  async function resolve() {
    const resolution = window.prompt("How was it resolved?");
    if (!resolution) return;
    const r = await action.run("resolve", () => api.post(`${base}/issues/${issueId}/resolve`, { resolution }));
    if (r) onChanged();
  }

  async function close() {
    const r = await action.run("close", () => api.post(`${base}/issues/${issueId}/close`, {}));
    if (r) onChanged();
  }

  async function reopen() {
    const reason = window.prompt("Why is it being reopened?");
    if (!reason) return;
    const r = await action.run("reopen", () => api.post(`${base}/issues/${issueId}/reopen`, { reason }));
    if (r) onChanged();
  }

  async function voidIssue() {
    const reason = window.prompt("Why is it void?");
    if (!reason) return;
    const r = await action.run("void", () => api.post(`${base}/issues/${issueId}/void`, { reason }));
    if (r) onChanged();
  }

  return (
    <Drawer open={issueId !== null} onClose={onClose} size="md" title={row ? `${row.reference} — ${row.title}` : "Design issue"}>
      <div className="space-y-4">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
        {detail.loading && !row ? <Skeleton className="h-40 w-full" /> : null}
        {row ? (
          <>
            <KeyValue
              items={[
                { label: "Status", value: <Badge tone={ISSUE_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>{labelize(row.status)}</Badge> },
                { label: "Priority", value: <Badge tone={PRIORITY_TONE[row.priority] ?? "neutral"} size="xs" dot>{labelize(row.priority)}</Badge> },
                { label: "Type", value: labelize(row.issueType) },
                { label: "Routed to", value: labelize(row.discipline) },
                { label: "Assignee", value: row.assignedToUserId ? lookups.users.find((u) => u.id === row.assignedToUserId)?.name ?? row.assignedToUserId : EM_DASH },
                { label: "Due", value: isoDate(row.dueDate) },
                { label: "Raised", value: dateTime(row.raisedAt) },
                { label: "Resolved", value: row.resolvedAt ? dateTime(row.resolvedAt) : EM_DASH },
              ]}
            />
            {row.description ? <p className="text-meta text-content-muted">{row.description}</p> : null}
            {row.resolution ? (
              <p className="rounded bg-surface-sunken px-2 py-1.5 text-meta text-content-muted">Resolution: {row.resolution}</p>
            ) : null}
            {row.affectedDisciplines.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {row.affectedDisciplines.map((d) => (
                  <Badge key={d} tone="neutral" size="xs">
                    {labelize(d)}
                  </Badge>
                ))}
              </div>
            ) : null}

            {row.status !== "closed" && row.status !== "void" ? (
              <div className="space-y-2 rounded-lg border border-border-subtle p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Assign to">
                    <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                      {optionList(lookups.users, (u) => u.name || u.email).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Re-route to discipline">
                    <Select value={assignDiscipline} onChange={(e) => setAssignDiscipline(e.target.value)}>
                      <option value="">— keep {labelize(row.discipline)} —</option>
                      {DESIGN_DISCIPLINES.map((d) => (
                        <option key={d} value={d}>
                          {labelize(d)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" loading={action.busy === "assign"} onClick={() => void assign()} disabled={!assignee && !assignDiscipline}>
                    Route
                  </Button>
                  {row.status !== "resolved" ? (
                    <Button size="sm" variant="secondary" loading={action.busy === "resolve"} onClick={() => void resolve()}>
                      Record a resolution
                    </Button>
                  ) : (
                    <Button size="sm" loading={action.busy === "close"} onClick={() => void close()}>
                      Verify and close
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" loading={action.busy === "void"} onClick={() => void voidIssue()}>
                    Void
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="sm" variant="secondary" loading={action.busy === "reopen"} onClick={() => void reopen()} disabled={row.status === "void"}>
                Reopen
              </Button>
            )}

            {row.decisions && row.decisions.length > 0 ? (
              <div>
                <SectionHeading title="Decisions taken on this issue" />
                <ul className="divide-y divide-border-subtle">
                  {row.decisions.map((decision) => (
                    <li key={decision.id} className="py-1.5">
                      <div className="text-meta text-content">
                        {decision.reference} — {decision.title}
                      </div>
                      <div className="text-2xs text-content-subtle">
                        {labelize(decision.status)}
                        {decision.decision ? ` · ${decision.decision}` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */

function DecisionForm({
  base,
  open,
  lookups,
  onClose,
  onCreated,
}: {
  base: string;
  open: boolean;
  lookups: Lookups;
  onClose: () => void;
  onCreated: () => void;
}) {
  const action = useAction();
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [background, setBackground] = useState("");
  const [discipline, setDiscipline] = useState("multi_discipline");
  const [packageId, setPackageId] = useState("");
  const [optionsText, setOptionsText] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const options = optionsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((label, index) => ({ key: `opt${index + 1}`, label }));
    const payload: Record<string, unknown> = { title: title.trim(), question: question.trim(), discipline, options };
    if (background.trim()) payload["background"] = background.trim();
    if (packageId) payload["packageId"] = packageId;
    const r = await action.run("create", () => api.post<DecisionRow>(`${base}/decisions`, payload));
    if (r) {
      toast.success(`${r.reference} proposed`);
      setTitle("");
      setQuestion("");
      setOptionsText("");
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Propose a design decision" description="Record the question and the options before the choice — a decision log written after the fact is a rationalisation." size="md">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </Field>
        <Field label="Question" required>
          <Textarea rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} required />
        </Field>
        <Field label="Background">
          <Textarea rows={2} value={background} onChange={(e) => setBackground(e.target.value)} />
        </Field>
        <Field label="Options (one per line)">
          <Textarea rows={3} value={optionsText} onChange={(e) => setOptionsText(e.target.value)} placeholder={"Unitised curtain walling\nStick-built curtain walling"} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Discipline">
            <Select value={discipline} onChange={(e) => setDiscipline(e.target.value)}>
              {DESIGN_DISCIPLINES.map((d) => (
                <option key={d} value={d}>
                  {labelize(d)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Package">
            <Select value={packageId} onChange={(e) => setPackageId(e.target.value)}>
              {optionList(lookups.packages, (p) => `${p.reference} — ${p.name}`).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"} disabled={!title.trim() || !question.trim()}>
            Propose
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */

function DecisionDrawer({
  base,
  decisionId,
  detail,
  onClose,
  onChanged,
}: {
  base: string;
  decisionId: string | null;
  detail: ReturnType<typeof useResource<DecisionRow & { supersedes: DecisionRow | null; supersededBy: DecisionRow[] }>>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const action = useAction();
  const [chosen, setChosen] = useState("");
  const [decision, setDecision] = useState("");
  const [rationale, setRationale] = useState("");
  const [level, setLevel] = useState("design_lead");
  const [costImpact, setCostImpact] = useState("");
  const [timeImpactDays, setTimeImpactDays] = useState("");
  const row = detail.data;

  async function decide(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { decision: decision.trim(), rationale: rationale.trim(), authorisationLevel: level };
    if (chosen) payload["chosenOptionKey"] = chosen;
    if (costImpact.trim()) payload["costImpact"] = Number(costImpact);
    if (timeImpactDays.trim()) payload["timeImpactDays"] = Number(timeImpactDays);
    const r = await action.run("decide", () => api.post(`${base}/decisions/${decisionId}/decide`, payload));
    if (r) {
      toast.success("Decision taken");
      setDecision("");
      setRationale("");
      onChanged();
    }
  }

  async function reverse() {
    const reason = window.prompt("Why is the decision being reversed?");
    if (!reason) return;
    const r = await action.run("reverse", () => api.post(`${base}/decisions/${decisionId}/reverse`, { reason }));
    if (r) onChanged();
  }

  return (
    <Drawer open={decisionId !== null} onClose={onClose} size="md" title={row ? `${row.reference} — ${row.title}` : "Design decision"}>
      <div className="space-y-4">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
        {detail.loading && !row ? <Skeleton className="h-40 w-full" /> : null}
        {row ? (
          <>
            <KeyValue
              items={[
                { label: "Status", value: <Badge tone={DECISION_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>{labelize(row.status)}</Badge> },
                { label: "Discipline", value: labelize(row.discipline) },
                { label: "Authority", value: row.authorisationLevel ? labelize(row.authorisationLevel) : EM_DASH },
                { label: "Decided", value: row.decidedAt ? dateTime(row.decidedAt) : EM_DASH },
                { label: "Cost impact", value: row.costImpact === null ? "not assessed" : money(row.costImpact, row.currency) },
                { label: "Time impact", value: row.timeImpactDays === null ? "not assessed" : `${num(row.timeImpactDays)} d` },
              ]}
            />
            <div>
              <div className="text-2xs uppercase tracking-wide text-content-subtle">Question</div>
              <p className="text-meta text-content">{row.question}</p>
            </div>
            {row.background ? <p className="text-meta text-content-muted">{row.background}</p> : null}
            {row.options.length > 0 ? (
              <div>
                <div className="text-2xs uppercase tracking-wide text-content-subtle">Options considered</div>
                <ul className="mt-1 space-y-1">
                  {row.options.map((option) => (
                    <li key={option.key} className="flex items-center gap-2 text-meta">
                      <span className={row.chosenOptionKey === option.key ? "font-semibold text-content" : "text-content-muted"}>{option.label}</span>
                      {row.chosenOptionKey === option.key ? (
                        <Badge tone="success" size="xs">
                          chosen
                        </Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {row.decision ? (
              <div className="rounded bg-surface-sunken px-2 py-1.5">
                <div className="text-meta font-medium text-content">{row.decision}</div>
                {row.rationale ? <p className="mt-0.5 text-meta text-content-muted">{row.rationale}</p> : null}
              </div>
            ) : null}
            {row.supersedes ? (
              <p className="text-2xs text-content-muted">
                Supersedes {row.supersedes.reference} — {row.supersedes.title}
              </p>
            ) : null}
            {row.supersededBy.length > 0 ? (
              <p className="text-2xs text-content-muted">
                Superseded by {row.supersededBy.map((d) => d.reference).join(", ")}
              </p>
            ) : null}

            {row.status === "proposed" ? (
              <form onSubmit={(e) => void decide(e)} className="space-y-2 rounded-lg border border-border-subtle p-3">
                <Field label="Decision" required>
                  <Textarea rows={2} value={decision} onChange={(e) => setDecision(e.target.value)} required />
                </Field>
                <Field label="Rationale" required>
                  <Textarea rows={2} value={rationale} onChange={(e) => setRationale(e.target.value)} required />
                </Field>
                <div className="grid gap-2 sm:grid-cols-4">
                  <Field label="Chosen option">
                    <Select value={chosen} onChange={(e) => setChosen(e.target.value)}>
                      <option value="">— none recorded —</option>
                      {row.options.map((option) => (
                        <option key={option.key} value={option.key}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Authority">
                    <Select value={level} onChange={(e) => setLevel(e.target.value)}>
                      {DCN_AUTHORISATION_LEVELS.map((l) => (
                        <option key={l} value={l}>
                          {labelize(l)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Cost impact">
                    <Input type="number" value={costImpact} onChange={(e) => setCostImpact(e.target.value)} />
                  </Field>
                  <Field label="Time impact (days)">
                    <Input type="number" value={timeImpactDays} onChange={(e) => setTimeImpactDays(e.target.value)} />
                  </Field>
                </div>
                <Button type="submit" size="sm" loading={action.busy === "decide"} disabled={!decision.trim() || !rationale.trim()}>
                  Take the decision
                </Button>
              </form>
            ) : null}
            {row.status === "decided" ? (
              <Button size="sm" variant="ghost" loading={action.busy === "reverse"} onClick={() => void reverse()}>
                Reverse this decision
              </Button>
            ) : null}
            {row.reversedReason ? <p className="text-2xs text-danger-fg">Reversed: {row.reversedReason}</p> : null}
          </>
        ) : null}
      </div>
    </Drawer>
  );
}
