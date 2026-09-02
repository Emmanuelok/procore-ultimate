/**
 * Coordination tab — the issue register (spec #240-245, #466, #469-470).
 *
 * The lifecycle is reachable here, which it was not before: an issue can be
 * assigned to a named person with a due date, discussed in a thread,
 * escalated into an RFI when the answer has to come from the design team, and
 * verified by someone other than whoever resolved it.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { DRAWING_DISCIPLINES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  Drawer,
  DrawerBody,
  DrawerFooter,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, formatDateTime, humanize } from "../format";
import {
  downloadText,
  ISSUE_NEXT_STATUSES,
  issueStatusTone,
  type CompanyUser,
  type CoordinationIssue,
  type IssueDetail,
  type ListResponse,
} from "./bimShared";

type Filter = "all" | "open" | "assigned" | "resolved" | "overdue";

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "assigned", label: "Assigned" },
  { value: "resolved", label: "Resolved" },
  { value: "overdue", label: "Overdue" },
];

export default function CoordinationTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const [issues, setIssues] = useState<CoordinationIssue[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<CompanyUser[]>([]);
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    title: "",
    description: "",
    discipline: "",
    assigneeId: "",
    dueDate: "",
  });
  const [createError, setCreateError] = useState<string | null>(null);

  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [escalateForm, setEscalateForm] = useState({ subject: "", question: "", assigneeId: "" });

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "25" });
      if (filter === "overdue") params.set("overdue", "1");
      else if (filter !== "all") params.set("status", filter);
      if (search.trim()) params.set("search", search.trim());
      const res = await api.get<ListResponse<CoordinationIssue>>(
        `/api/v1/projects/${projectId}/bim/issues?${params}`,
      );
      setIssues(res.items);
      setTotal(res.total);
    } catch (err) {
      setIssues([]);
      setError(err instanceof Error ? err.message : "Failed to load coordination issues");
    }
  }, [projectId, page, filter, search]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  useEffect(() => {
    api
      .get<ListResponse<CompanyUser>>("/api/v1/company/users?pageSize=200")
      .then((res) => setUsers(res.items))
      .catch(() => setUsers([]));
  }, []);

  async function openDetail(issue: CoordinationIssue) {
    setDetail(null);
    setDetailError(null);
    setComment("");
    try {
      setDetail(await api.get<IssueDetail>(`/api/v1/bim/issues/${issue.id}`));
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "Failed to load the issue");
    }
  }

  async function refreshDetail(id: string) {
    try {
      setDetail(await api.get<IssueDetail>(`/api/v1/bim/issues/${id}`));
    } catch {
      /* the register below is still accurate */
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { title: createForm.title.trim() };
      if (createForm.description.trim()) payload["description"] = createForm.description.trim();
      if (createForm.discipline) payload["discipline"] = createForm.discipline;
      if (createForm.assigneeId) payload["assigneeId"] = createForm.assigneeId;
      if (createForm.dueDate) payload["dueDate"] = createForm.dueDate;
      await api.post(`/api/v1/projects/${projectId}/bim/issues`, payload);
      setCreateOpen(false);
      setCreateForm({ title: "", description: "", discipline: "", assigneeId: "", dueDate: "" });
      await load();
      onChanged();
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Failed to create the issue.");
    } finally {
      setBusy(false);
    }
  }

  async function patchIssue(id: string, patch: Record<string, unknown>, message: string) {
    setBusy(true);
    try {
      await api.patch(`/api/v1/bim/issues/${id}`, patch);
      toast.success(message);
      await load();
      await refreshDetail(id);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "The change was refused.");
    } finally {
      setBusy(false);
    }
  }

  async function postComment(id: string) {
    if (!comment.trim()) return;
    setBusy(true);
    try {
      await api.post(`/api/v1/bim/issues/${id}/comments`, { body: comment.trim() });
      setComment("");
      await refreshDetail(id);
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "Comment failed.");
    } finally {
      setBusy(false);
    }
  }

  async function escalate(e: FormEvent) {
    e.preventDefault();
    if (!detail) return;
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {};
      if (escalateForm.subject.trim()) payload["subject"] = escalateForm.subject.trim();
      if (escalateForm.question.trim()) payload["question"] = escalateForm.question.trim();
      if (escalateForm.assigneeId) payload["assigneeId"] = escalateForm.assigneeId;
      const res = await api.post<{ number: number }>(
        `/api/v1/bim/issues/${detail.id}/escalate`,
        payload,
      );
      toast.success(`RFI #${res.number} raised from this issue.`);
      setEscalateOpen(false);
      setEscalateForm({ subject: "", question: "", assigneeId: "" });
      await refreshDetail(detail.id);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "Escalation failed.");
    } finally {
      setBusy(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / 25));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl<Filter>
          options={FILTERS}
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setPage(1);
          }}
          aria-label="Issue filter"
        />
        <div className="flex items-center gap-2">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search issues…"
            className="max-w-xs"
          />
          <Button
            variant="secondary"
            onClick={() =>
              void downloadText(
                `/api/v1/projects/${projectId}/bim/issues/export.csv`,
                "coordination-issues.csv",
              ).catch(() => toast.error("Export failed."))
            }
          >
            Export CSV
          </Button>
          <Button onClick={() => setCreateOpen(true)}>New issue</Button>
        </div>
      </div>

      <ErrorAlert message={error} />

      {issues === null ? (
        <Spinner label="Loading issues…" />
      ) : issues.length === 0 ? (
        <EmptyState
          title="No coordination issues"
          hint="Raise one here, from the model viewer with an element attached, or from a group of clashes."
          action={<Button onClick={() => setCreateOpen(true)}>Raise an issue</Button>}
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th className="w-16">#</Th>
                <Th>Title</Th>
                <Th>Status</Th>
                <Th>Discipline</Th>
                <Th>Assignee</Th>
                <Th>Due</Th>
                <Th>Source</Th>
                <Th className="text-right">Elements</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {issues.map((i) => (
                <tr
                  key={i.id}
                  className="cursor-pointer hover:bg-ink-50/60"
                  onClick={() => void openDetail(i)}
                >
                  <Td className="tabular-nums">{i.number}</Td>
                  <Td>
                    <span className="font-medium text-ink-900">{i.title}</span>
                    {i.rfiId ? (
                      <Badge tone="info" size="sm" className="ml-2">
                        RFI raised
                      </Badge>
                    ) : null}
                  </Td>
                  <Td>
                    <Badge tone={issueStatusTone(i.status)} size="sm">
                      {i.status}
                    </Badge>
                  </Td>
                  <Td>{i.discipline ? humanize(i.discipline) : "—"}</Td>
                  <Td>{i.assigneeName ?? (i.assigneeId ? i.assigneeId : "—")}</Td>
                  <Td className={i.overdue ? "text-red-600" : undefined}>
                    {i.dueDate ? formatDate(i.dueDate) : "—"}
                  </Td>
                  <Td>{humanize(i.source ?? "manual")}</Td>
                  <Td className="text-right tabular-nums">{i.elementGlobalIds.length}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="mt-3 flex items-center justify-between text-xs text-ink-500">
            <span>
              {total} issue{total === 1 ? "" : "s"} · page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      {/* ------------------------------ create ------------------------------ */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Raise a coordination issue">
        <form onSubmit={onCreate} className="space-y-3">
          <ErrorAlert message={createError} />
          <Field label="Title">
            <Input
              value={createForm.title}
              onChange={(e) => setCreateForm({ ...createForm, title: e.target.value })}
              required
            />
          </Field>
          <Field label="Description">
            <Textarea
              rows={3}
              value={createForm.description}
              onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Discipline">
              <Select
                value={createForm.discipline}
                onChange={(e) => setCreateForm({ ...createForm, discipline: e.target.value })}
              >
                <option value="">—</option>
                {DRAWING_DISCIPLINES.map((d) => (
                  <option key={d} value={d}>
                    {humanize(d)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Due date">
              <Input
                type="date"
                value={createForm.dueDate}
                onChange={(e) => setCreateForm({ ...createForm, dueDate: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Assignee" hint="Assigning on creation moves the issue straight to assigned and notifies them.">
            <Select
              value={createForm.assigneeId}
              onChange={(e) => setCreateForm({ ...createForm, assigneeId: e.target.value })}
            >
              <option value="">Unassigned</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Raise issue
            </Button>
          </div>
        </form>
      </Modal>

      {/* ------------------------------ detail ------------------------------ */}
      <Drawer
        open={detail !== null || detailError !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDetail(null);
            setDetailError(null);
          }
        }}
        title={detail ? `#${detail.number} ${detail.title}` : "Coordination issue"}
        description={detail ? `Raised ${formatDateTime(detail.createdAt)} by ${detail.createdByName ?? "—"}` : undefined}
        size="lg"
      >
        <DrawerBody>
          <ErrorAlert message={detailError} />
          {detail === null ? (
            <Spinner label="Loading issue…" />
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={issueStatusTone(detail.status)}>{detail.status}</Badge>
                {detail.overdue ? <Badge tone="danger">overdue</Badge> : null}
                {detail.discipline ? <Badge tone="neutral">{humanize(detail.discipline)}</Badge> : null}
                {detail.rfi ? (
                  <Badge tone="info">
                    RFI #{detail.rfi.number} · {detail.rfi.status}
                  </Badge>
                ) : null}
              </div>

              {detail.description ? (
                <p className="whitespace-pre-wrap text-sm text-ink-700">{detail.description}</p>
              ) : null}

              <Card>
                <CardBody className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Assignee">
                      <Select
                        value={detail.assigneeId ?? ""}
                        onChange={(e) =>
                          void patchIssue(
                            detail.id,
                            e.target.value
                              ? { assigneeId: e.target.value, status: detail.status === "open" ? "assigned" : undefined }
                              : { assigneeId: null },
                            e.target.value ? "Issue assigned." : "Assignee cleared.",
                          )
                        }
                      >
                        <option value="">Unassigned</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Due date">
                      <Input
                        type="date"
                        value={detail.dueDate ?? ""}
                        onChange={(e) =>
                          void patchIssue(
                            detail.id,
                            { dueDate: e.target.value || null },
                            "Due date updated.",
                          )
                        }
                      />
                    </Field>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(detail.nextStatuses ?? ISSUE_NEXT_STATUSES[detail.status] ?? []).map((next) => (
                      <Button
                        key={next}
                        size="sm"
                        variant={next === "void" ? "danger" : "secondary"}
                        disabled={busy}
                        onClick={() => void patchIssue(detail.id, { status: next }, `Issue ${next}.`)}
                      >
                        Move to {next}
                      </Button>
                    ))}
                    {!detail.rfiId ? (
                      <Button size="sm" disabled={busy} onClick={() => setEscalateOpen(true)}>
                        Escalate to RFI
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        void downloadText(
                          `/api/v1/bim/issues/${detail.id}/bcf.json`,
                          `coordination-issue-${detail.number}.bcf.json`,
                        ).catch(() => toast.error("Export failed."))
                      }
                    >
                      BCF payload
                    </Button>
                  </div>
                </CardBody>
              </Card>

              {detail.elementGlobalIds.length > 0 ? (
                <div>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
                    Elements ({detail.elementGlobalIds.length})
                  </h3>
                  <div className="flex flex-wrap gap-1">
                    {detail.elementGlobalIds.slice(0, 40).map((g) => (
                      <span
                        key={g}
                        className="rounded border border-ink-200 bg-ink-50 px-1.5 py-0.5 font-mono text-[11px] text-ink-600"
                      >
                        {g}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                  Discussion
                </h3>
                {detail.comments.length === 0 ? (
                  <p className="text-xs text-ink-400">No comments yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {detail.comments.map((c) => (
                      <li key={c.id} className="rounded-md bg-ink-50 p-2">
                        <div className="mb-0.5 flex items-center justify-between text-[11px] text-ink-500">
                          <span className="font-medium text-ink-700">{c.authorName ?? c.authorId}</span>
                          <span>{formatDateTime(c.createdAt)}</span>
                        </div>
                        <p className="whitespace-pre-wrap text-sm text-ink-700">{c.body}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </DrawerBody>
        {detail ? (
          <DrawerFooter>
            <div className="flex w-full gap-2">
              <Input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Add a comment…"
              />
              <Button disabled={busy || !comment.trim()} onClick={() => void postComment(detail.id)}>
                Comment
              </Button>
            </div>
          </DrawerFooter>
        ) : null}
      </Drawer>

      {/* ----------------------------- escalate ----------------------------- */}
      <Modal
        open={escalateOpen}
        onClose={() => setEscalateOpen(false)}
        title="Escalate to an RFI"
      >
        <form onSubmit={escalate} className="space-y-3">
          <p className="text-xs text-ink-500">
            The RFI is created in draft with this issue&rsquo;s title, description and element ids,
            and both records are linked. The issue stays open until the answer lands.
          </p>
          <Field label="Subject" hint="Defaults to the issue title.">
            <Input
              value={escalateForm.subject}
              onChange={(e) => setEscalateForm({ ...escalateForm, subject: e.target.value })}
            />
          </Field>
          <Field label="Question" hint="Defaults to the issue description plus the element ids.">
            <Textarea
              rows={3}
              value={escalateForm.question}
              onChange={(e) => setEscalateForm({ ...escalateForm, question: e.target.value })}
            />
          </Field>
          <Field label="Assign the RFI to">
            <Select
              value={escalateForm.assigneeId}
              onChange={(e) => setEscalateForm({ ...escalateForm, assigneeId: e.target.value })}
            >
              <option value="">Same as the issue</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setEscalateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Raise RFI
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
