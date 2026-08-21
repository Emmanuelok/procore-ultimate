import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { PUNCH_STATUSES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
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
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
  statusTone,
} from "../../ui";
import { formatDate, formatDateTime, humanize } from "../format";
import {
  priorityTone,
  todayIso,
  useCompanyUsers,
  type ListResponse,
} from "../rfis/fieldShared";

interface PunchItem {
  id: string;
  number: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeId: string | null;
  verifierId: string | null;
  dueDate: string | null;
  locationId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface PunchAnalytics {
  byStatus: Record<string, number>;
  byAssignee: Array<{ assigneeId: string | null; count: number }>;
  overdue: number;
}

const PAGE_SIZE = 25;
const OPEN_STATUSES = ["open", "in_progress", "ready_for_review"];

/** Forward transitions mirroring the API's state machine. */
const TRANSITIONS: Record<string, Array<{ to: string; label: string }>> = {
  open: [{ to: "in_progress", label: "Start work" }],
  in_progress: [{ to: "ready_for_review", label: "Ready for review" }],
  ready_for_review: [
    { to: "closed", label: "Verify & close" },
    { to: "in_progress", label: "Send back" },
  ],
  closed: [],
  void: [],
};

interface CreateForm {
  title: string;
  description: string;
  priority: string;
  assigneeId: string;
  verifierId: string;
  dueDate: string;
}

const emptyForm: CreateForm = {
  title: "",
  description: "",
  priority: "medium",
  assigneeId: "",
  verifierId: "",
  dueDate: "",
};

export default function PunchPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const base = `/api/v1/projects/${projectId}/punch`;
  const { users, nameOf } = useCompanyUsers();

  const [items, setItems] = useState<PunchItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [search, setSearch] = useState("");
  const [analytics, setAnalytics] = useState<PunchAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [detail, setDetail] = useState<PunchItem | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [editAssignee, setEditAssignee] = useState("");
  const [editVerifier, setEditVerifier] = useState("");
  const [editPriority, setEditPriority] = useState("medium");
  const [editDue, setEditDue] = useState("");

  const load = useCallback(async () => {
    if (!projectId) return;
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (status) params.set("status", status);
      if (priority) params.set("priority", priority);
      if (search.trim()) params.set("search", search.trim());
      const [list, stats] = await Promise.all([
        api.get<ListResponse<PunchItem>>(`${base}?${params}`),
        api.get<PunchAnalytics>(`${base}/analytics`),
      ]);
      setItems(list.items);
      setTotal(list.total);
      setAnalytics(stats);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load punch items");
    }
  }, [base, projectId, page, status, priority, search]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const today = todayIso();
  const isOverdue = (p: PunchItem) =>
    OPEN_STATUSES.includes(p.status) && !!p.dueDate && p.dueDate < today;

  const openCount = analytics
    ? OPEN_STATUSES.reduce((sum, s) => sum + (analytics.byStatus[s] ?? 0), 0)
    : 0;

  function openDetail(item: PunchItem) {
    setDetail(item);
    setDetailError(null);
    setEditAssignee(item.assigneeId ?? "");
    setEditVerifier(item.verifierId ?? "");
    setEditPriority(item.priority);
    setEditDue(item.dueDate ?? "");
  }

  function set<K extends keyof CreateForm>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        title: form.title.trim(),
        priority: form.priority,
      };
      if (form.description.trim()) payload["description"] = form.description.trim();
      if (form.assigneeId) payload["assigneeId"] = form.assigneeId;
      if (form.verifierId) payload["verifierId"] = form.verifierId;
      if (form.dueDate) payload["dueDate"] = form.dueDate;
      await api.post(base, payload);
      setCreateOpen(false);
      setForm(emptyForm);
      await load();
    } catch (err) {
      setCreateError(
        err instanceof ApiClientError ? err.message : "Failed to create the punch item.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function onSaveDetail() {
    if (!detail) return;
    setBusy(true);
    setDetailError(null);
    try {
      const payload: Record<string, unknown> = {
        assigneeId: editAssignee || null,
        verifierId: editVerifier || null,
        priority: editPriority,
        dueDate: editDue || null,
      };
      const updated = await api.patch<PunchItem>(`${base}/${detail.id}`, payload);
      setDetail(updated);
      await load();
    } catch (err) {
      setDetailError(err instanceof ApiClientError ? err.message : "Failed to update the item");
    } finally {
      setBusy(false);
    }
  }

  async function onTransition(to: string) {
    if (!detail) return;
    setBusy(true);
    setDetailError(null);
    try {
      const updated = await api.post<PunchItem>(`${base}/${detail.id}/status`, { status: to });
      setDetail(updated);
      await load();
    } catch (err) {
      setDetailError(err instanceof ApiClientError ? err.message : "Transition failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Punch List"
        subtitle="Deficiencies with assignee completion and verifier sign-off"
        actions={<Button onClick={() => setCreateOpen(true)}>New punch item</Button>}
      />

      {analytics ? (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Open" value={openCount} />
          <StatCard
            label="Ready for review"
            value={analytics.byStatus["ready_for_review"] ?? 0}
          />
          <StatCard label="Overdue" value={analytics.overdue} danger={analytics.overdue > 0} />
          <StatCard label="Closed" value={analytics.byStatus["closed"] ?? 0} />
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-64">
          <Input
            placeholder="Search by title…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="w-44">
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {PUNCH_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-40">
          <Select
            value={priority}
            onChange={(e) => {
              setPriority(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All priorities</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </Select>
        </div>
      </div>

      <ErrorAlert message={error} />

      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title={
            status || priority || search ? "No punch items match your filters" : "No punch items yet"
          }
          hint={
            status || priority || search
              ? "Try clearing the filters."
              : "Capture the first deficiency from a site walk."
          }
          action={
            !status && !priority && !search ? (
              <Button onClick={() => setCreateOpen(true)}>Create the first punch item</Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>No.</Th>
                <Th>Title</Th>
                <Th>Priority</Th>
                <Th>Status</Th>
                <Th>Assignee</Th>
                <Th>Verifier</Th>
                <Th>Due</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {items.map((p) => (
                <tr
                  key={p.id}
                  className="cursor-pointer hover:bg-ink-50/60"
                  onClick={() => openDetail(p)}
                >
                  <Td className="whitespace-nowrap font-mono text-xs">
                    #{String(p.number).padStart(3, "0")}
                  </Td>
                  <Td>
                    <span className="font-medium text-brand-700">{p.title}</span>
                  </Td>
                  <Td>
                    <Badge tone={priorityTone(p.priority)}>{humanize(p.priority)}</Badge>
                  </Td>
                  <Td>
                    <Badge tone={statusTone(p.status)}>{humanize(p.status)}</Badge>
                  </Td>
                  <Td>{nameOf(p.assigneeId)}</Td>
                  <Td>{nameOf(p.verifierId)}</Td>
                  <Td
                    className={
                      isOverdue(p)
                        ? "whitespace-nowrap font-medium text-red-600"
                        : "whitespace-nowrap"
                    }
                  >
                    {formatDate(p.dueDate)}
                    {isOverdue(p) ? " ⚠" : ""}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
            <span>
              {total} item{total === 1 ? "" : "s"} · page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      <Modal open={createOpen} title="New punch item" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <Field label="Title">
            <Input
              required
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="Scratched glazing at unit 402 living room"
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="What is wrong and what does done look like…"
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Priority">
              <Select value={form.priority} onChange={(e) => set("priority", e.target.value)}>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </Select>
            </Field>
            <Field label="Due date">
              <Input
                type="date"
                value={form.dueDate}
                onChange={(e) => set("dueDate", e.target.value)}
              />
            </Field>
            <Field label="Assignee">
              <Select value={form.assigneeId} onChange={(e) => set("assigneeId", e.target.value)}>
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Verifier" hint="Signs off before the item can be closed.">
              <Select value={form.verifierId} onChange={(e) => set("verifierId", e.target.value)}>
                <option value="">None</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create punch item"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={detail !== null}
        title={detail ? `Punch #${String(detail.number).padStart(3, "0")}` : ""}
        onClose={() => setDetail(null)}
        wide
      >
        {detail ? (
          <div className="space-y-4">
            <ErrorAlert message={detailError} />
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={statusTone(detail.status)}>{humanize(detail.status)}</Badge>
              <Badge tone={priorityTone(detail.priority)}>{humanize(detail.priority)}</Badge>
              {isOverdue(detail) ? <Badge tone="red">Overdue</Badge> : null}
              <span className="text-xs text-ink-400">
                Created by {nameOf(detail.createdBy)} · {formatDateTime(detail.createdAt)}
              </span>
            </div>
            <div>
              <h3 className="text-base font-semibold text-ink-900">{detail.title}</h3>
              {detail.description ? (
                <p className="mt-1 whitespace-pre-wrap text-sm text-ink-700">
                  {detail.description}
                </p>
              ) : null}
            </div>

            {detail.status !== "closed" && detail.status !== "void" ? (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Assignee">
                    <Select value={editAssignee} onChange={(e) => setEditAssignee(e.target.value)}>
                      <option value="">Unassigned</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Verifier">
                    <Select value={editVerifier} onChange={(e) => setEditVerifier(e.target.value)}>
                      <option value="">None</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Priority">
                    <Select value={editPriority} onChange={(e) => setEditPriority(e.target.value)}>
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                    </Select>
                  </Field>
                  <Field label="Due date">
                    <Input type="date" value={editDue} onChange={(e) => setEditDue(e.target.value)} />
                  </Field>
                </div>
                <div className="flex justify-end">
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onSaveDetail()}>
                    {busy ? "Saving…" : "Save changes"}
                  </Button>
                </div>
              </>
            ) : (
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-ink-400">Assignee</dt>
                  <dd className="text-ink-800">{nameOf(detail.assigneeId)}</dd>
                </div>
                <div>
                  <dt className="text-ink-400">Verifier</dt>
                  <dd className="text-ink-800">{nameOf(detail.verifierId)}</dd>
                </div>
                <div>
                  <dt className="text-ink-400">Due date</dt>
                  <dd className="text-ink-800">{formatDate(detail.dueDate)}</dd>
                </div>
              </dl>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 pt-3">
              <div className="flex flex-wrap gap-2">
                {(TRANSITIONS[detail.status] ?? []).map((t) => (
                  <Button
                    key={t.to}
                    size="sm"
                    variant={t.to === "closed" ? "primary" : "secondary"}
                    disabled={busy}
                    onClick={() => void onTransition(t.to)}
                  >
                    {t.label}
                  </Button>
                ))}
              </div>
              {detail.status !== "closed" && detail.status !== "void" ? (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("Void this punch item? Admin only; cannot be undone.")) {
                      void onTransition("void");
                    }
                  }}
                >
                  Void
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function StatCard({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <Card>
      <CardBody className="py-3">
        <div className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</div>
        <div
          className={`mt-0.5 text-2xl font-semibold ${danger ? "text-red-600" : "text-ink-900"}`}
        >
          {value}
        </div>
      </CardBody>
    </Card>
  );
}
