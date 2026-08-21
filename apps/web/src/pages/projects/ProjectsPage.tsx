import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { PROJECT_STAGES } from "@constructos/shared";
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
  Textarea,
  Th,
} from "../../ui";
import { formatDate, formatMoney, humanize, locationLabel, stageTone } from "../format";

interface ProjectItem {
  id: string;
  name: string;
  number?: string | null;
  stage?: string | null;
  city?: string | null;
  country?: string | null;
  value?: string | number | null;
  currency?: string | null;
  startDate?: string | null;
  finishDate?: string | null;
}

interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

const PAGE_SIZE = 25;

interface CreateForm {
  name: string;
  number: string;
  stage: string;
  address: string;
  city: string;
  country: string;
  startDate: string;
  finishDate: string;
  value: string;
  currency: string;
  description: string;
}

const emptyForm: CreateForm = {
  name: "",
  number: "",
  stage: "pre_construction",
  address: "",
  city: "",
  country: "",
  startDate: "",
  finishDate: "",
  value: "",
  currency: "USD",
  description: "",
};

export default function ProjectsPage() {
  const [items, setItems] = useState<ProjectItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (search.trim()) params.set("search", search.trim());
      if (stage) params.set("stage", stage);
      const res = await api.get<ListResponse<ProjectItem>>(`/api/v1/projects?${params}`);
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load projects");
    }
  }, [page, search, stage]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function set<K extends keyof CreateForm>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { name: form.name.trim() };
      if (form.number.trim()) payload["number"] = form.number.trim();
      if (form.stage) payload["stage"] = form.stage;
      if (form.address.trim()) payload["address"] = form.address.trim();
      if (form.city.trim()) payload["city"] = form.city.trim();
      if (form.country.trim()) payload["country"] = form.country.trim();
      if (form.startDate) payload["startDate"] = form.startDate;
      if (form.finishDate) payload["finishDate"] = form.finishDate;
      if (form.value.trim()) payload["value"] = form.value.trim();
      if (form.currency.trim()) payload["currency"] = form.currency.trim().toUpperCase();
      if (form.description.trim()) payload["description"] = form.description.trim();
      await api.post("/api/v1/projects", payload);
      setCreateOpen(false);
      setForm(emptyForm);
      await load();
    } catch (err) {
      setCreateError(
        err instanceof ApiClientError ? err.message : "Failed to create the project.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle={`${total} project${total === 1 ? "" : "s"} in this company`}
        actions={<Button onClick={() => setCreateOpen(true)}>New project</Button>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-64">
          <Input
            placeholder="Search by name or number…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="w-56">
          <Select
            value={stage}
            onChange={(e) => {
              setStage(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All stages</option>
            {PROJECT_STAGES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
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
          title={search || stage ? "No projects match your filters" : "No projects yet"}
          hint={
            search || stage
              ? "Try a different search term or stage."
              : "Create your first project to start managing delivery and assurance."
          }
          action={
            !search && !stage ? (
              <Button onClick={() => setCreateOpen(true)}>Create your first project</Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Number</Th>
                <Th>Stage</Th>
                <Th>Location</Th>
                <Th>Start</Th>
                <Th>Finish</Th>
                <Th className="text-right">Value</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {items.map((p) => (
                <tr key={p.id} className="hover:bg-ink-50/60">
                  <Td>
                    <Link
                      to={`/projects/${p.id}`}
                      className="font-medium text-brand-700 hover:text-brand-800"
                    >
                      {p.name}
                    </Link>
                  </Td>
                  <Td>{p.number ?? "—"}</Td>
                  <Td>
                    <Badge tone={stageTone(p.stage)}>{humanize(p.stage)}</Badge>
                  </Td>
                  <Td>{locationLabel(p.city, p.country)}</Td>
                  <Td>{formatDate(p.startDate)}</Td>
                  <Td>{formatDate(p.finishDate)}</Td>
                  <Td className="text-right font-medium">{formatMoney(p.value, p.currency)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
            <span>
              Page {page} of {totalPages}
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

      <Modal open={createOpen} title="New project" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Project name">
              <Input
                required
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Riverside Medical Centre"
              />
            </Field>
            <Field label="Project number" hint="Optional — auto-assigned if left blank.">
              <Input
                value={form.number}
                onChange={(e) => set("number", e.target.value)}
                placeholder="24-018"
              />
            </Field>
            <Field label="Stage">
              <Select value={form.stage} onChange={(e) => set("stage", e.target.value)}>
                {PROJECT_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Address">
              <Input
                value={form.address}
                onChange={(e) => set("address", e.target.value)}
                placeholder="100 River Road"
              />
            </Field>
            <Field label="City">
              <Input value={form.city} onChange={(e) => set("city", e.target.value)} />
            </Field>
            <Field label="Country">
              <Input value={form.country} onChange={(e) => set("country", e.target.value)} />
            </Field>
            <Field label="Start date">
              <Input
                type="date"
                value={form.startDate}
                onChange={(e) => set("startDate", e.target.value)}
              />
            </Field>
            <Field label="Finish date">
              <Input
                type="date"
                value={form.finishDate}
                onChange={(e) => set("finishDate", e.target.value)}
              />
            </Field>
            <Field label="Contract value">
              <Input
                type="number"
                min="0"
                step="any"
                value={form.value}
                onChange={(e) => set("value", e.target.value)}
                placeholder="12500000"
              />
            </Field>
            <Field label="Currency">
              <Input
                maxLength={3}
                value={form.currency}
                onChange={(e) => set("currency", e.target.value)}
                placeholder="USD"
              />
            </Field>
          </div>
          <Field label="Description">
            <Textarea
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Scope, delivery method, key milestones…"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create project"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
