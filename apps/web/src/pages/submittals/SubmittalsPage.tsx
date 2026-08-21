import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { SUBMITTAL_STATUSES, SUBMITTAL_TYPES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
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
  Th,
  statusTone,
} from "../../ui";
import { formatDate, humanize } from "../format";
import {
  addDaysIso,
  submittalLabel,
  todayIso,
  useCompanyUsers,
  type ListResponse,
} from "../rfis/fieldShared";

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
}

const PAGE_SIZE = 25;
const ACTIVE_STATUSES = ["draft", "open", "in_review"];

interface CreateForm {
  title: string;
  specSection: string;
  submittalType: string;
  requiredOnSite: string;
  leadTimeDays: string;
}

const emptyForm: CreateForm = {
  title: "",
  specSection: "",
  submittalType: "shop_drawing",
  requiredOnSite: "",
  leadTimeDays: "",
};

export default function SubmittalsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const base = `/api/v1/projects/${projectId}/submittals`;
  const { nameOf } = useCompanyUsers();

  const [items, setItems] = useState<SubmittalItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
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
      if (type) params.set("type", type);
      if (search.trim()) params.set("search", search.trim());
      const res = await api.get<ListResponse<SubmittalItem>>(`${base}?${params}`);
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load submittals");
    }
  }, [base, projectId, page, status, type, search]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const today = todayIso();
  const atRiskCutoff = addDaysIso(today, 7);

  /** none | at_risk (submit-by within 7 days) | late (submit-by passed) */
  function submitByRisk(s: SubmittalItem): "none" | "at_risk" | "late" {
    if (!s.submitByDate || !ACTIVE_STATUSES.includes(s.status)) return "none";
    if (s.submitByDate < today) return "late";
    if (s.submitByDate < atRiskCutoff) return "at_risk";
    return "none";
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
        submittalType: form.submittalType,
      };
      if (form.specSection.trim()) payload["specSection"] = form.specSection.trim();
      if (form.requiredOnSite) payload["requiredOnSite"] = form.requiredOnSite;
      if (form.leadTimeDays !== "") payload["leadTimeDays"] = Number(form.leadTimeDays);
      const created = await api.post<SubmittalItem>(base, payload);
      setCreateOpen(false);
      setForm(emptyForm);
      navigate(`/projects/${projectId}/submittals/${created.id}`);
    } catch (err) {
      setCreateError(
        err instanceof ApiClientError ? err.message : "Failed to create the submittal.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Submittals"
        subtitle="Register of shop drawings, product data and samples with review routing"
        actions={<Button onClick={() => setCreateOpen(true)}>New submittal</Button>}
      />

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
            {SUBMITTAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-44">
          <Select
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All types</option>
            {SUBMITTAL_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <ErrorAlert message={error} />

      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title={status || type || search ? "No submittals match your filters" : "No submittals yet"}
          hint={
            status || type || search
              ? "Try clearing the filters."
              : "Build the register by logging the first submittal."
          }
          action={
            !status && !type && !search ? (
              <Button onClick={() => setCreateOpen(true)}>Create the first submittal</Button>
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
                <Th>Spec section</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>Ball in court</Th>
                <Th>Required on site</Th>
                <Th>Submit by</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {items.map((s) => {
                const risk = submitByRisk(s);
                return (
                  <tr key={s.id} className="hover:bg-ink-50/60">
                    <Td className="whitespace-nowrap font-mono text-xs">
                      {submittalLabel(s.number, s.revision)}
                    </Td>
                    <Td>
                      <Link
                        to={`/projects/${projectId}/submittals/${s.id}`}
                        className="font-medium text-brand-700 hover:text-brand-800"
                      >
                        {s.title}
                      </Link>
                    </Td>
                    <Td className="whitespace-nowrap">{s.specSection ?? "—"}</Td>
                    <Td className="whitespace-nowrap">{humanize(s.submittalType)}</Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge tone={statusTone(s.status)}>{humanize(s.status)}</Badge>
                        {s.responseCode ? (
                          <Badge tone={statusTone(s.responseCode)}>
                            {humanize(s.responseCode)}
                          </Badge>
                        ) : null}
                      </div>
                    </Td>
                    <Td>{nameOf(s.ballInCourtId)}</Td>
                    <Td className="whitespace-nowrap">{formatDate(s.requiredOnSite)}</Td>
                    <Td
                      className={
                        risk === "late"
                          ? "whitespace-nowrap font-medium text-red-600"
                          : risk === "at_risk"
                            ? "whitespace-nowrap font-medium text-amber-600"
                            : "whitespace-nowrap"
                      }
                    >
                      {formatDate(s.submitByDate)}
                      {risk === "late" ? " ⚠" : risk === "at_risk" ? " ⏳" : ""}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>

          <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
            <span>
              {total} submittal{total === 1 ? "" : "s"} · page {page} of {totalPages}
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

      <Modal open={createOpen} title="New submittal" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <Field label="Title">
            <Input
              required
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="Structural steel shop drawings — Level 2"
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Spec section">
              <Input
                value={form.specSection}
                onChange={(e) => set("specSection", e.target.value)}
                placeholder="05 12 00"
              />
            </Field>
            <Field label="Type">
              <Select
                value={form.submittalType}
                onChange={(e) => set("submittalType", e.target.value)}
              >
                {SUBMITTAL_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {humanize(t)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Required on site">
              <Input
                type="date"
                value={form.requiredOnSite}
                onChange={(e) => set("requiredOnSite", e.target.value)}
              />
            </Field>
            <Field
              label="Lead time (days)"
              hint="Submit-by is back-computed from required-on-site minus lead time and review allowance."
            >
              <Input
                type="number"
                min="0"
                value={form.leadTimeDays}
                onChange={(e) => set("leadTimeDays", e.target.value)}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create submittal"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
