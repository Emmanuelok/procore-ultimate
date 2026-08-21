import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { RFI_STATUSES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  impactTone,
  rfiLabel,
  todayIso,
  useCompanyUsers,
  type ListResponse,
} from "./fieldShared";
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
import { formatDate, humanize } from "../format";

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
  createdAt: string;
}

interface RfiAnalytics {
  open: number;
  overdue: number;
  avgResponseDays: number | null;
  byStatus: Record<string, number>;
}

const PAGE_SIZE = 25;

interface CreateForm {
  subject: string;
  question: string;
  proposedSolution: string;
  assigneeId: string;
  dueDate: string;
}

const emptyForm: CreateForm = {
  subject: "",
  question: "",
  proposedSolution: "",
  assigneeId: "",
  dueDate: "",
};

export default function RfisPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const base = `/api/v1/projects/${projectId}/rfis`;
  const { users, nameOf } = useCompanyUsers();

  const [items, setItems] = useState<RfiItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [analytics, setAnalytics] = useState<RfiAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (status) params.set("status", status);
      if (overdueOnly) params.set("overdue", "true");
      if (search.trim()) params.set("search", search.trim());
      const [list, stats] = await Promise.all([
        api.get<ListResponse<RfiItem>>(`${base}?${params}`),
        api.get<RfiAnalytics>(`${base}/analytics`),
      ]);
      setItems(list.items);
      setTotal(list.total);
      setAnalytics(stats);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load RFIs");
    }
  }, [base, projectId, page, status, overdueOnly, search]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const today = todayIso();
  const isOverdue = (r: RfiItem) => r.status === "open" && !!r.dueDate && r.dueDate < today;

  function set<K extends keyof CreateForm>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        subject: form.subject.trim(),
        question: form.question.trim(),
      };
      if (form.proposedSolution.trim()) payload["proposedSolution"] = form.proposedSolution.trim();
      if (form.assigneeId) payload["assigneeId"] = form.assigneeId;
      if (form.dueDate) payload["dueDate"] = form.dueDate;
      const created = await api.post<RfiItem>(base, payload);
      setCreateOpen(false);
      setForm(emptyForm);
      navigate(`/projects/${projectId}/rfis/${created.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Failed to create the RFI.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="RFIs"
        subtitle="Requests for information — question, response and impact tracking"
        actions={<Button onClick={() => setCreateOpen(true)}>New RFI</Button>}
      />

      {analytics ? (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card>
            <CardBody className="py-3">
              <div className="text-xs font-medium uppercase tracking-wide text-ink-400">Open</div>
              <div className="mt-0.5 text-2xl font-semibold text-ink-900">{analytics.open}</div>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="py-3">
              <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                Overdue
              </div>
              <div
                className={`mt-0.5 text-2xl font-semibold ${analytics.overdue > 0 ? "text-red-600" : "text-ink-900"}`}
              >
                {analytics.overdue}
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="py-3">
              <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                Avg response
              </div>
              <div className="mt-0.5 text-2xl font-semibold text-ink-900">
                {analytics.avgResponseDays !== null ? `${analytics.avgResponseDays}d` : "—"}
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="py-3">
              <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                Answered
              </div>
              <div className="mt-0.5 text-2xl font-semibold text-ink-900">
                {analytics.byStatus["answered"] ?? 0}
              </div>
            </CardBody>
          </Card>
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-64">
          <Input
            placeholder="Search by subject…"
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
            {RFI_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
        </div>
        <Button
          variant={overdueOnly ? "primary" : "secondary"}
          size="sm"
          onClick={() => {
            setOverdueOnly((v) => !v);
            setPage(1);
          }}
        >
          Overdue only
        </Button>
      </div>

      <ErrorAlert message={error} />

      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title={status || search || overdueOnly ? "No RFIs match your filters" : "No RFIs yet"}
          hint={
            status || search || overdueOnly
              ? "Try clearing the filters."
              : "Raise the first request for information on this project."
          }
          action={
            !status && !search && !overdueOnly ? (
              <Button onClick={() => setCreateOpen(true)}>Create the first RFI</Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>No.</Th>
                <Th>Subject</Th>
                <Th>Status</Th>
                <Th>Ball in court</Th>
                <Th>Due</Th>
                <Th>Cost</Th>
                <Th>Schedule</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {items.map((r) => (
                <tr key={r.id} className="hover:bg-ink-50/60">
                  <Td className="whitespace-nowrap font-mono text-xs">{rfiLabel(r.number)}</Td>
                  <Td>
                    <Link
                      to={`/projects/${projectId}/rfis/${r.id}`}
                      className="font-medium text-brand-700 hover:text-brand-800"
                    >
                      {r.subject}
                    </Link>
                  </Td>
                  <Td>
                    <Badge tone={statusTone(r.status)}>{humanize(r.status)}</Badge>
                  </Td>
                  <Td>{nameOf(r.ballInCourtId)}</Td>
                  <Td
                    className={
                      isOverdue(r) ? "whitespace-nowrap font-medium text-red-600" : "whitespace-nowrap"
                    }
                  >
                    {formatDate(r.dueDate)}
                    {isOverdue(r) ? " ⚠" : ""}
                  </Td>
                  <Td>
                    <Badge tone={impactTone(r.costImpact)}>{r.costImpact.toUpperCase()}</Badge>
                  </Td>
                  <Td>
                    <Badge tone={impactTone(r.scheduleImpact)}>
                      {r.scheduleImpact.toUpperCase()}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
            <span>
              {total} RFI{total === 1 ? "" : "s"} · page {page} of {totalPages}
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

      <Modal open={createOpen} title="New RFI" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <Field label="Subject">
            <Input
              required
              value={form.subject}
              onChange={(e) => set("subject", e.target.value)}
              placeholder="Clarify slab edge detail at grid C-4"
            />
          </Field>
          <Field label="Question">
            <Textarea
              required
              value={form.question}
              onChange={(e) => set("question", e.target.value)}
              placeholder="Describe the information you need…"
            />
          </Field>
          <Field label="Proposed solution" hint="Optional — suggest an answer to speed up review.">
            <Textarea
              value={form.proposedSolution}
              onChange={(e) => set("proposedSolution", e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
            <Field label="Response due" hint="Defaults to 7 days after issue if left blank.">
              <Input
                type="date"
                value={form.dueDate}
                onChange={(e) => set("dueDate", e.target.value)}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create RFI"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
