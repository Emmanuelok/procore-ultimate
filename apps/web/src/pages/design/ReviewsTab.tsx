/**
 * REVIEWS — issue for comment, reviewers, consolidated status codes and the
 * comment ledger (#249, #897–#900).
 *
 * The code on a cycle is never typed: it is the worst code any reviewer
 * returned, and the drawer shows the basis the engine used. A comment is
 * answered by someone other than its author and closed only by its author.
 */
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  DESIGN_COMMENT_CATEGORIES,
  DESIGN_DISCIPLINES,
  DESIGN_ISSUE_PRIORITIES,
  DESIGN_REVIEW_CODES,
  DESIGN_REVIEW_STATUSES,
} from "@constructos/shared";
import { Alert, Badge, Button, Card, CardBody, Checkbox, Drawer, EmptyState, Field, Input, Select, Skeleton, Textarea } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconPlus, IconSend } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  CODE_MEANING,
  CODE_TONE,
  COMMENT_STATUS_TONE,
  EM_DASH,
  KeyValue,
  LoadError,
  PRIORITY_TONE,
  REVIEW_STATUS_TONE,
  ReasonList,
  RefusalNotice,
  SectionHeading,
  dateTime,
  isoDate,
  labelize,
  num,
  optionList,
  useAction,
  useResource,
  type ListResponse,
  type Lookups,
  type ReviewDetail,
  type ReviewRow,
} from "./designShared";

export default function ReviewsTab({
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
  const [code, setCode] = useState("");
  const query = new URLSearchParams({ pageSize: "500" });
  if (status) query.set("status", status);
  if (code) query.set("code", code);
  const reviews = useResource<ListResponse<ReviewRow>>(`${base}/reviews?${query.toString()}`);
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useResource<ReviewDetail>(openId ? `${base}/reviews/${openId}` : null);
  const action = useAction();

  function changed() {
    reviews.reload();
    detail.reload();
    onChanged();
  }

  const packageRef = useMemo(
    () => new Map(lookups.packages.map((p) => [p.id, `${p.reference} ${p.name}`])),
    [lookups.packages],
  );

  const columns = useMemo<DataColumns<ReviewRow>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "code", sticky: "start", width: 90, mono: true },
      { id: "title", header: "Cycle", accessor: "title", type: "text", width: 230 },
      {
        id: "package",
        header: "Package",
        accessor: (row) => packageRef.get(row.packageId) ?? row.packageId,
        type: "text",
        width: 220,
        groupable: true,
      },
      { id: "cycleNumber", header: "Cycle #", accessor: "cycleNumber", type: "number", width: 80 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 130,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={REVIEW_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "consolidatedCode",
        header: "Code",
        accessor: (row) => row.consolidatedCode ?? "",
        type: "status",
        width: 90,
        cell: ({ row }) =>
          row.consolidatedCode ? (
            <span title={row.consolidationBasis ?? undefined}>
              <Badge tone={CODE_TONE[row.consolidatedCode] ?? "neutral"} size="xs">
                {row.consolidatedCode}
              </Badge>
            </span>
          ) : (
            <span className="italic text-content-subtle">not consolidated</span>
          ),
      },
      {
        id: "returned",
        header: "Returned",
        accessor: (row) => row.returnedCount,
        type: "number",
        width: 100,
        cell: ({ row }) => `${row.returnedCount} / ${row.reviewerCount}`,
      },
      {
        id: "openComments",
        header: "Open comments",
        accessor: "openCommentCount",
        type: "number",
        width: 130,
        cell: ({ row }) => (row.openCommentCount > 0 ? <span className="text-warning-fg">{row.openCommentCount}</span> : "0"),
      },
      { id: "issuedAt", header: "Issued", accessor: (row) => row.issuedAt ?? "", type: "date", width: 130, cell: ({ row }) => isoDate(row.issuedAt) },
      {
        id: "dueAt",
        header: "Due",
        accessor: (row) => row.dueAt ?? "",
        type: "date",
        width: 130,
        cell: ({ row }) => (row.dueAt ? isoDate(row.dueAt) : <span className="italic text-content-subtle">no date</span>),
      },
      {
        id: "turnaroundDays",
        header: "Turnaround",
        accessor: (row) => row.turnaroundDays,
        type: "number",
        width: 110,
        cell: ({ row }) => (row.turnaroundDays === null ? <span className="italic text-content-subtle">open</span> : `${num(row.turnaroundDays, 1)} d`),
      },
    ],
    [packageRef],
  );

  const now = Date.now();

  return (
    <div className="space-y-4">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
      <Card>
        <CardBody>
          <SectionHeading
            title="Review cycles"
            hint="Status codes follow the ISO 19650 tradition: A accepted, B accepted with comments, C revise and resubmit, D rejected. The cycle's code is the worst any reviewer returned — never an average, never typed by hand."
            actions={
              <>
                <Select size="sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
                  <option value="">All statuses</option>
                  {DESIGN_REVIEW_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {labelize(s)}
                    </option>
                  ))}
                </Select>
                <Select size="sm" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Code filter">
                  <option value="">All codes</option>
                  {DESIGN_REVIEW_CODES.map((c) => (
                    <option key={c} value={c}>
                      {c} — {CODE_MEANING[c]}
                    </option>
                  ))}
                </Select>
                <Button size="sm" leadingIcon={IconPlus} onClick={() => setCreateOpen(true)} disabled={lookups.packages.length === 0}>
                  Issue for comment
                </Button>
              </>
            }
          />
          {lookups.packages.length === 0 ? (
            <Alert tone="info" title="Register a design package first">
              A review cycle is one issue of a package. Nothing can be issued for comment until a package exists.
            </Alert>
          ) : null}
          {reviews.error ? <LoadError message={reviews.error} onRetry={reviews.reload} /> : null}
          <DataTable<ReviewRow>
            tableId="design-reviews"
            data={reviews.data?.items ?? []}
            columns={columns}
            getRowId={(row) => row.id}
            loading={reviews.loading && !reviews.data}
            height={520}
            stickyHeader
            filterRow
            exportFileName="design-reviews"
            searchPlaceholder="Search by reference or title…"
            defaultSort={[{ id: "issuedAt", desc: true }]}
            onRowClick={({ row }) => setOpenId(row.id)}
            rowTone={(row) =>
              row.status !== "closed" && row.dueAt && Date.parse(row.dueAt) < now
                ? "danger"
                : row.consolidatedCode === "D"
                  ? "danger"
                  : row.consolidatedCode === "C"
                    ? "warning"
                    : undefined
            }
            empty={{
              title: "No review cycle",
              description: "Issue a package for comment and appoint the reviewers who must return a status code.",
            }}
          />
        </CardBody>
      </Card>

      <ReviewForm
        base={base}
        open={createOpen}
        lookups={lookups}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          changed();
        }}
      />
      <ReviewDrawer base={base} reviewId={openId} detail={detail} lookups={lookups} onClose={() => setOpenId(null)} onChanged={changed} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ReviewForm({
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
  const [packageId, setPackageId] = useState("");
  const [title, setTitle] = useState("");
  const [revision, setRevision] = useState("");
  const [dueAt, setDueAt] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { packageId, title: title.trim() };
    if (revision.trim()) payload["revision"] = revision.trim();
    if (dueAt) payload["dueAt"] = `${dueAt}T00:00:00.000Z`;
    const r = await action.run("create", () => api.post<ReviewRow>(`${base}/reviews`, payload));
    if (r) {
      toast.success(`${r.reference} issued for comment (cycle ${r.cycleNumber})`);
      setTitle("");
      onCreated();
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Issue a package for comment" description="A package may have one open cycle at a time; a resubmission after a C or D is opened from the closed cycle." size="md">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        <Field label="Package" required>
          <Select value={packageId} onChange={(e) => setPackageId(e.target.value)} required>
            {optionList(lookups.packages, (p) => `${p.reference} — ${p.name}`, "— choose a package —").map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="Stage 4 issue for comment" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Revision">
            <Input value={revision} onChange={(e) => setRevision(e.target.value)} maxLength={20} placeholder="P02" />
          </Field>
          <Field label="Comments due by">
            <Input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </Field>
        </div>
        <ReasonList reasons={lookups.notes} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={action.busy === "create"} disabled={!packageId || !title.trim()}>
            Issue
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */

function ReviewDrawer({
  base,
  reviewId,
  detail,
  lookups,
  onClose,
  onChanged,
}: {
  base: string;
  reviewId: string | null;
  detail: ReturnType<typeof useResource<ReviewDetail>>;
  lookups: Lookups;
  onClose: () => void;
  onChanged: () => void;
}) {
  const action = useAction();
  const [reviewerUserId, setReviewerUserId] = useState("");
  const [reviewerName, setReviewerName] = useState("");
  const [reviewerDiscipline, setReviewerDiscipline] = useState("multi_discipline");
  const [reviewerRequired, setReviewerRequired] = useState(true);
  const [returnCode, setReturnCode] = useState("A");
  const [returnSummary, setReturnSummary] = useState("");
  const [commentBody, setCommentBody] = useState("");
  const [commentCategory, setCommentCategory] = useState("other");
  const [commentPriority, setCommentPriority] = useState("medium");
  const [commentSheetId, setCommentSheetId] = useState("");

  const row = detail.data;

  async function addReviewer(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = { discipline: reviewerDiscipline, isRequired: reviewerRequired };
    if (reviewerUserId) payload["userId"] = reviewerUserId;
    if (reviewerName.trim()) payload["displayName"] = reviewerName.trim();
    const r = await action.run("reviewer", () => api.post(`${base}/reviews/${reviewId}/reviewers`, payload));
    if (r) {
      toast.success("Reviewer appointed");
      setReviewerUserId("");
      setReviewerName("");
      onChanged();
    }
  }

  async function returnCodeFor(participantId: string) {
    const r = await action.run(`return-${participantId}`, () =>
      api.post(`${base}/reviews/${reviewId}/reviewers/${participantId}/return`, {
        code: returnCode,
        ...(returnSummary.trim() ? { summary: returnSummary.trim() } : {}),
      }),
    );
    if (r) {
      toast.success(`Returned code ${returnCode}`);
      setReturnSummary("");
      onChanged();
    }
  }

  async function decline(participantId: string) {
    const reason = window.prompt("Why are you declining this review?");
    if (!reason) return;
    const r = await action.run(`decline-${participantId}`, () =>
      api.post(`${base}/reviews/${reviewId}/reviewers/${participantId}/decline`, { reason }),
    );
    if (r) onChanged();
  }

  async function addComment(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      body: commentBody.trim(),
      category: commentCategory,
      priority: commentPriority,
    };
    if (commentSheetId) payload["drawingSheetId"] = commentSheetId;
    const r = await action.run("comment", () => api.post(`${base}/reviews/${reviewId}/comments`, payload));
    if (r) {
      toast.success("Comment raised");
      setCommentBody("");
      onChanged();
    }
  }

  async function respond(commentId: string) {
    const response = window.prompt("Your response to this comment:");
    if (!response) return;
    const r = await action.run(`respond-${commentId}`, () => api.post(`${base}/comments/${commentId}/respond`, { response }));
    if (r) onChanged();
  }

  async function closeComment(commentId: string, status: "closed" | "withdrawn") {
    const r = await action.run(`close-${commentId}`, () => api.post(`${base}/comments/${commentId}/close`, { status }));
    if (r) onChanged();
  }

  async function escalate(commentId: string) {
    const r = await action.run(`escalate-${commentId}`, () => api.post(`${base}/comments/${commentId}/escalate`, {}));
    if (r) {
      toast.success("Escalated to the design issue register");
      onChanged();
    }
  }

  async function closeCycle(force: boolean) {
    const r = await action.run("close", () => api.post<{ consolidatedCode: string | null }>(`${base}/reviews/${reviewId}/close`, { force }));
    if (r) {
      toast.success(r.consolidatedCode ? `Cycle closed with code ${r.consolidatedCode}` : "Cycle closed");
      onChanged();
    }
  }

  const open = row ? row.status !== "closed" && row.status !== "cancelled" : false;

  return (
    <Drawer
      open={reviewId !== null}
      onClose={onClose}
      size="lg"
      title={row ? `${row.reference} — ${row.title}` : "Review cycle"}
      description={row ? `Cycle ${row.cycleNumber}${row.revision ? ` · revision ${row.revision}` : ""}` : undefined}
    >
      <div className="space-y-4">
        {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
        {detail.error ? <LoadError message={detail.error} onRetry={detail.reload} /> : null}
        {detail.loading && !row ? <Skeleton className="h-40 w-full" /> : null}
        {row ? (
          <>
            <KeyValue
              items={[
                { label: "Status", value: <Badge tone={REVIEW_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>{labelize(row.status)}</Badge> },
                { label: "Package", value: row.package ? `${row.package.reference} — ${row.package.name}` : EM_DASH },
                { label: "Issued", value: dateTime(row.issuedAt) },
                { label: "Due", value: row.dueAt ? dateTime(row.dueAt) : "no date set" },
                { label: "Closed", value: row.closedAt ? dateTime(row.closedAt) : EM_DASH },
                { label: "Turnaround", value: row.turnaroundDays === null ? EM_DASH : `${num(row.turnaroundDays, 1)} days` },
              ]}
            />

            <div className="rounded-lg border border-border-subtle bg-surface-sunken p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-2xs uppercase tracking-wide text-content-subtle">Consolidated code</span>
                {row.consolidation.code ? (
                  <Badge tone={CODE_TONE[row.consolidation.code] ?? "neutral"} size="sm">
                    {row.consolidation.code} — {row.codeMeaning[row.consolidation.code]}
                  </Badge>
                ) : (
                  <span className="text-meta italic text-content-subtle">not yet consolidated</span>
                )}
              </div>
              <p className="mt-1 text-2xs text-content-muted">{row.consolidation.basis}</p>
              {row.consolidation.outstanding.length > 0 ? (
                <p className="mt-1 text-2xs text-warning-fg">
                  Outstanding required reviewers: {row.consolidation.outstanding.join(", ")}
                </p>
              ) : null}
              {open ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="xs" loading={action.busy === "close"} onClick={() => void closeCycle(false)} disabled={!row.canClose.canClose}>
                    Close and consolidate
                  </Button>
                  {!row.canClose.canClose ? (
                    <Button size="xs" variant="ghost" onClick={() => void closeCycle(true)}>
                      Close anyway, recording who did not return
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {!row.canClose.canClose && open ? <ReasonList reasons={row.canClose.blockers} className="mt-2" /> : null}
            </div>

            <div>
              <SectionHeading title="Reviewers" hint="A review code is a professional opinion: only the named reviewer may return it." />
              {row.participants.length === 0 ? (
                <p className="text-2xs italic text-content-subtle">No reviewer has been appointed yet.</p>
              ) : (
                <ul className="divide-y divide-border-subtle">
                  {row.participants.map((participant) => (
                    <li key={participant.id} className="py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-meta text-content">
                          {participant.displayName ?? lookups.users.find((u) => u.id === participant.userId)?.name ?? participant.userId ?? "External reviewer"}
                        </span>
                        <Badge tone="neutral" size="xs">
                          {labelize(participant.discipline)}
                        </Badge>
                        {participant.isRequired === 1 ? (
                          <Badge tone="info" size="xs">
                            required
                          </Badge>
                        ) : null}
                        {participant.returnedCode ? (
                          <Badge tone={CODE_TONE[participant.returnedCode] ?? "neutral"} size="xs">
                            {participant.returnedCode}
                          </Badge>
                        ) : (
                          <Badge tone={participant.status === "declined" ? "neutral" : "warning"} size="xs" dot>
                            {labelize(participant.status)}
                          </Badge>
                        )}
                        {open && participant.status !== "returned" && participant.status !== "declined" ? (
                          <>
                            <Button size="xs" variant="secondary" loading={action.busy === `return-${participant.id}`} onClick={() => void returnCodeFor(participant.id)}>
                              Return {returnCode}
                            </Button>
                            <Button size="xs" variant="ghost" loading={action.busy === `decline-${participant.id}`} onClick={() => void decline(participant.id)}>
                              Decline
                            </Button>
                          </>
                        ) : null}
                      </div>
                      {participant.summary ? <p className="mt-1 text-2xs text-content-muted">{participant.summary}</p> : null}
                      {participant.declineReason ? <p className="mt-1 text-2xs text-content-muted">Declined: {participant.declineReason}</p> : null}
                    </li>
                  ))}
                </ul>
              )}

              {open ? (
                <>
                  <div className="mt-3 grid gap-2 rounded-lg border border-border-subtle p-3 sm:grid-cols-3">
                    <Field label="Code to return">
                      <Select value={returnCode} onChange={(e) => setReturnCode(e.target.value)}>
                        {DESIGN_REVIEW_CODES.map((c) => (
                          <option key={c} value={c}>
                            {c} — {CODE_MEANING[c]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Summary of your review" className="sm:col-span-2">
                      <Input value={returnSummary} onChange={(e) => setReturnSummary(e.target.value)} placeholder="What the code is based on" />
                    </Field>
                  </div>
                  <form onSubmit={(e) => void addReviewer(e)} className="mt-3 grid gap-2 rounded-lg border border-border-subtle p-3 sm:grid-cols-4">
                    <Field label="Appoint a user">
                      <Select value={reviewerUserId} onChange={(e) => setReviewerUserId(e.target.value)}>
                        {optionList(lookups.users, (u) => u.name || u.email).map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="…or name an external reviewer">
                      <Input value={reviewerName} onChange={(e) => setReviewerName(e.target.value)} placeholder="Fire engineer (consultant)" />
                    </Field>
                    <Field label="Discipline">
                      <Select value={reviewerDiscipline} onChange={(e) => setReviewerDiscipline(e.target.value)}>
                        {DESIGN_DISCIPLINES.map((d) => (
                          <option key={d} value={d}>
                            {labelize(d)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <div className="flex items-end gap-2">
                      <Checkbox label="Required" checked={reviewerRequired} onChange={(e) => setReviewerRequired(e.target.checked)} />
                      <Button type="submit" size="sm" loading={action.busy === "reviewer"} disabled={!reviewerUserId && !reviewerName.trim()}>
                        Appoint
                      </Button>
                    </div>
                  </form>
                </>
              ) : null}
            </div>

            <div>
              <SectionHeading
                title={`Comments (${row.comments.length})`}
                hint="The person who raised a comment cannot answer it, and only they can close it once it has been answered."
              />
              {row.comments.length === 0 ? (
                <EmptyState icon={IconSend} title="No comment on this cycle" description="Comments can be raised individually or attached to a reviewer's returned code." />
              ) : (
                <ul className="divide-y divide-border-subtle">
                  {row.comments.map((comment) => (
                    <li key={comment.id} className="py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-2xs text-content-subtle">#{comment.sequence}</span>
                        <Badge tone={COMMENT_STATUS_TONE[comment.status] ?? "neutral"} size="xs" dot>
                          {labelize(comment.status)}
                        </Badge>
                        <Badge tone={PRIORITY_TONE[comment.priority] ?? "neutral"} size="xs">
                          {labelize(comment.priority)}
                        </Badge>
                        <Badge tone="neutral" size="xs">
                          {labelize(comment.category)}
                        </Badge>
                        {comment.code ? (
                          <Badge tone={CODE_TONE[comment.code] ?? "neutral"} size="xs">
                            {comment.code}
                          </Badge>
                        ) : null}
                        {comment.drawingSheetId ? (
                          <span className="text-2xs text-content-subtle">
                            {lookups.sheets.find((s) => s.id === comment.drawingSheetId)?.number ?? "sheet"}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-meta text-content">{comment.body}</p>
                      {comment.response ? (
                        <p className="mt-1 rounded bg-surface-sunken px-2 py-1 text-meta text-content-muted">
                          Response: {comment.response}
                        </p>
                      ) : null}
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {comment.status === "open" ? (
                          <Button size="xs" variant="secondary" loading={action.busy === `respond-${comment.id}`} onClick={() => void respond(comment.id)}>
                            Respond
                          </Button>
                        ) : null}
                        {comment.status === "responded" ? (
                          <Button size="xs" variant="secondary" loading={action.busy === `close-${comment.id}`} onClick={() => void closeComment(comment.id, "closed")}>
                            Accept and close
                          </Button>
                        ) : null}
                        {comment.status === "open" ? (
                          <Button size="xs" variant="ghost" onClick={() => void closeComment(comment.id, "withdrawn")}>
                            Withdraw
                          </Button>
                        ) : null}
                        {!comment.issueId && comment.status !== "closed" ? (
                          <Button size="xs" variant="ghost" loading={action.busy === `escalate-${comment.id}`} onClick={() => void escalate(comment.id)}>
                            Escalate to an issue
                          </Button>
                        ) : null}
                        {comment.issueId ? <Badge tone="info" size="xs">escalated</Badge> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {open ? (
                <form onSubmit={(e) => void addComment(e)} className="mt-3 space-y-2 rounded-lg border border-border-subtle p-3">
                  <Field label="Raise a comment">
                    <Textarea rows={2} value={commentBody} onChange={(e) => setCommentBody(e.target.value)} placeholder="What is wrong, and where" />
                  </Field>
                  <div className="grid gap-2 sm:grid-cols-4">
                    <Field label="Category">
                      <Select value={commentCategory} onChange={(e) => setCommentCategory(e.target.value)}>
                        {DESIGN_COMMENT_CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {labelize(c)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Priority">
                      <Select value={commentPriority} onChange={(e) => setCommentPriority(e.target.value)}>
                        {DESIGN_ISSUE_PRIORITIES.map((p) => (
                          <option key={p} value={p}>
                            {labelize(p)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Drawing sheet" className="sm:col-span-2">
                      <Select value={commentSheetId} onChange={(e) => setCommentSheetId(e.target.value)}>
                        {optionList(lookups.sheets, (s) => `${s.number} — ${s.title}`).map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <Button type="submit" size="sm" loading={action.busy === "comment"} disabled={!commentBody.trim()}>
                    Raise comment
                  </Button>
                </form>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </Drawer>
  );
}
