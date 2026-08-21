import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { PROJECT_STAGES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
} from "../../ui";
import { formatDate, formatMoney, humanize, locationLabel, stageTone } from "../format";

interface Project {
  id: string;
  name: string;
  number?: string | null;
  stage?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  startDate?: string | null;
  finishDate?: string | null;
  value?: string | number | null;
  currency?: string | null;
  description?: string | null;
}

interface Summary {
  rfisOpen?: number;
  submittalsOpen?: number;
  punchOpen?: number;
  sheets?: number;
  models?: number;
  assets?: number;
  signalsOpen?: number;
}

interface EditForm {
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

function toForm(p: Project): EditForm {
  return {
    name: p.name ?? "",
    number: p.number ?? "",
    stage: p.stage ?? "pre_construction",
    address: p.address ?? "",
    city: p.city ?? "",
    country: p.country ?? "",
    startDate: p.startDate ?? "",
    finishDate: p.finishDate ?? "",
    value: p.value === null || p.value === undefined ? "" : String(p.value),
    currency: p.currency ?? "USD",
    description: p.description ?? "",
  };
}

export default function ProjectOverviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setError(null);
    try {
      const p = await api.get<Project>(`/api/v1/projects/${projectId}`);
      setProject(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load project");
    }
    try {
      const s = await api.get<Summary>(`/api/v1/projects/${projectId}/summary`);
      setSummary(s);
    } catch {
      setSummary({});
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !project) return <ErrorAlert message={error} />;
  if (!project) return <Spinner />;

  const stats: Array<{ label: string; value: number; to: string }> = [
    { label: "Open RFIs", value: summary?.rfisOpen ?? 0, to: "rfis" },
    { label: "Open submittals", value: summary?.submittalsOpen ?? 0, to: "submittals" },
    { label: "Open punch items", value: summary?.punchOpen ?? 0, to: "punch" },
    { label: "Drawing sheets", value: summary?.sheets ?? 0, to: "drawings" },
    { label: "BIM models", value: summary?.models ?? 0, to: "bim" },
    { label: "Twin assets", value: summary?.assets ?? 0, to: "twin" },
    { label: "Open signals", value: summary?.signalsOpen ?? 0, to: "assurance" },
  ];

  const currentStageIdx = PROJECT_STAGES.indexOf(
    (project.stage ?? "") as (typeof PROJECT_STAGES)[number],
  );

  function openEdit() {
    if (project) {
      setForm(toForm(project));
      setEditError(null);
      setEditOpen(true);
    }
  }

  function set<K extends keyof EditForm>(key: K, value: string) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!form || !projectId) return;
    setEditError(null);
    setBusy(true);
    try {
      // The PATCH schema accepts string/number fields as optional (not nullable),
      // so omit blank fields instead of sending null.
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        stage: form.stage,
      };
      if (form.number.trim()) payload["number"] = form.number.trim();
      if (form.address.trim()) payload["address"] = form.address.trim();
      if (form.city.trim()) payload["city"] = form.city.trim();
      if (form.country.trim()) payload["country"] = form.country.trim();
      if (form.startDate) payload["startDate"] = form.startDate;
      if (form.finishDate) payload["finishDate"] = form.finishDate;
      if (form.value.trim()) payload["value"] = Number(form.value.trim());
      if (form.currency.trim()) payload["currency"] = form.currency.trim().toUpperCase();
      if (form.description.trim()) payload["description"] = form.description.trim();
      await api.patch(`/api/v1/projects/${projectId}`, payload);
      setEditOpen(false);
      await load();
    } catch (err) {
      setEditError(err instanceof ApiClientError ? err.message : "Failed to save changes.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Stage stepper */}
      <Card>
        <CardBody>
          <div className="flex flex-wrap items-center gap-y-2">
            {PROJECT_STAGES.map((s, i) => {
              const reached = currentStageIdx >= 0 && i <= currentStageIdx;
              const current = i === currentStageIdx;
              return (
                <div key={s} className="flex items-center">
                  {i > 0 ? (
                    <div
                      className={`mx-2 h-0.5 w-8 sm:w-12 ${
                        reached ? "bg-brand-500" : "bg-ink-200"
                      }`}
                    />
                  ) : null}
                  <div className="flex items-center gap-2">
                    <span
                      className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${
                        current
                          ? "bg-brand-600 text-white ring-4 ring-brand-100"
                          : reached
                            ? "bg-brand-100 text-brand-700"
                            : "bg-ink-100 text-ink-400"
                      }`}
                    >
                      {i + 1}
                    </span>
                    <span
                      className={`text-xs ${
                        current
                          ? "font-semibold text-ink-900"
                          : reached
                            ? "text-ink-600"
                            : "text-ink-400"
                      }`}
                    >
                      {humanize(s)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </CardBody>
      </Card>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        {stats.map((s) => (
          <Link key={s.label} to={s.to} className="group">
            <Card className="h-full transition-shadow group-hover:shadow-md">
              <CardBody className="p-3">
                <div className="text-2xl font-semibold text-ink-900 group-hover:text-brand-700">
                  {s.value}
                </div>
                <div className="mt-0.5 text-xs text-ink-500">{s.label}</div>
              </CardBody>
            </Card>
          </Link>
        ))}
      </div>

      {/* Details */}
      <Card>
        <CardBody>
          <div className="mb-4 flex items-start justify-between">
            <div>
              <h2 className="text-base font-semibold text-ink-900">Project details</h2>
              <div className="mt-1 flex items-center gap-2">
                <Badge tone={stageTone(project.stage)}>{humanize(project.stage)}</Badge>
                {project.number ? (
                  <span className="text-xs text-ink-400">#{project.number}</span>
                ) : null}
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={openEdit}>
              Edit
            </Button>
          </div>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">Address</dt>
              <dd className="mt-0.5 text-ink-800">{project.address ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">Location</dt>
              <dd className="mt-0.5 text-ink-800">
                {locationLabel(project.city, project.country)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">
                Contract value
              </dt>
              <dd className="mt-0.5 font-medium text-ink-900">
                {formatMoney(project.value, project.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">Start</dt>
              <dd className="mt-0.5 text-ink-800">{formatDate(project.startDate)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">Finish</dt>
              <dd className="mt-0.5 text-ink-800">{formatDate(project.finishDate)}</dd>
            </div>
          </dl>
          {project.description ? (
            <div className="mt-4 border-t border-ink-100 pt-3">
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">
                Description
              </dt>
              <p className="mt-1 whitespace-pre-wrap text-sm text-ink-700">
                {project.description}
              </p>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Modal open={editOpen} title="Edit project" onClose={() => setEditOpen(false)} wide>
        <ErrorAlert message={editError} />
        {form ? (
          <form onSubmit={onSave} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Project name">
                <Input required value={form.name} onChange={(e) => set("name", e.target.value)} />
              </Field>
              <Field label="Project number">
                <Input value={form.number} onChange={(e) => set("number", e.target.value)} />
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
                <Input value={form.address} onChange={(e) => set("address", e.target.value)} />
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
                />
              </Field>
              <Field label="Currency">
                <Input
                  maxLength={3}
                  value={form.currency}
                  onChange={(e) => set("currency", e.target.value)}
                />
              </Field>
            </div>
            <Field label="Description">
              <Textarea
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}
