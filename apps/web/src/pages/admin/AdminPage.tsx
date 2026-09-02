import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ASSURANCE_ROLES, PERMISSION_LEVELS, TOOLS } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
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
} from "../../ui";
import { formatDateTime, humanize } from "../format";

interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiClientError || err instanceof Error ? err.message : fallback;
}

function LockIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      className="h-3.5 w-3.5 text-ink-400"
      aria-label="Built-in template"
    >
      <path d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1.5 1.5 0 0 0-1.5 1.5v5A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 12 6h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z" />
    </svg>
  );
}

function SectionCard({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-ink-100 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs text-ink-400">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex gap-2">{actions}</div> : null}
      </div>
      <div className="p-4">{children}</div>
    </Card>
  );
}

/* --------------------------- Permission templates --------------------------- */

interface Template {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  tools?: Record<string, string> | null;
  isBuiltin?: boolean;
}

interface TemplateForm {
  key: string;
  name: string;
  description: string;
  tools: Record<string, string>;
}

function defaultTools(): Record<string, string> {
  return Object.fromEntries(TOOLS.map((t) => [t, "none"]));
}

function TemplatesSection() {
  const [items, setItems] = useState<Template[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [form, setForm] = useState<TemplateForm>({
    key: "",
    name: "",
    description: "",
    tools: defaultTools(),
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<ListResponse<Template>>(
        "/api/v1/permission-templates?page=1&pageSize=100",
      );
      setItems(res.items);
    } catch (err) {
      setItems([]);
      setError(errMsg(err, "Failed to load permission templates"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setForm({ key: "", name: "", description: "", tools: defaultTools() });
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(t: Template) {
    setEditing(t);
    setForm({
      key: t.key,
      name: t.name,
      description: t.description ?? "",
      tools: { ...defaultTools(), ...(t.tools ?? {}) },
    });
    setFormError(null);
    setModalOpen(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const payload = {
        key: form.key.trim() || form.name.trim().toLowerCase().replace(/\s+/g, "_"),
        name: form.name.trim(),
        description: form.description.trim(),
        tools: form.tools,
      };
      if (editing) {
        await api.patch(`/api/v1/permission-templates/${editing.id}`, {
          name: payload.name,
          description: payload.description,
          tools: payload.tools,
        });
      } else {
        await api.post("/api/v1/permission-templates", payload);
      }
      setModalOpen(false);
      await load();
    } catch (err) {
      setFormError(errMsg(err, "Failed to save template"));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(t: Template) {
    if (!window.confirm(`Delete template "${t.name}"?`)) return;
    try {
      await api.del(`/api/v1/permission-templates/${t.id}`);
      await load();
    } catch (err) {
      setError(errMsg(err, "Failed to delete template"));
    }
  }

  return (
    <SectionCard
      title="Permission templates"
      subtitle="Per-tool access levels applied to project members"
      actions={
        <Button size="sm" onClick={openCreate}>
          New template
        </Button>
      }
    >
      <ErrorAlert message={error} />
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title="No templates" hint="Built-in templates are seeded per company." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Key</Th>
              <Th>Description</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {items.map((t) => (
              <tr key={t.key} className="hover:bg-ink-50/60">
                <Td>
                  <span className="flex items-center gap-1.5 font-medium">
                    {t.name}
                    {t.isBuiltin ? <LockIcon /> : null}
                  </span>
                </Td>
                <Td>
                  <code className="text-xs text-ink-500">{t.key}</code>
                </Td>
                <Td className="max-w-md truncate">{t.description ?? "—"}</Td>
                <Td className="text-right">
                  {t.isBuiltin ? (
                    <span className="text-xs text-ink-300">Built-in</span>
                  ) : (
                    <span className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(t)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => onDelete(t)}>
                        Delete
                      </Button>
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal
        open={modalOpen}
        title={editing ? "Edit template" : "New permission template"}
        onClose={() => setModalOpen(false)}
        wide
      >
        <ErrorAlert message={formError} />
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name">
              <Input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Key" hint="Lowercase identifier; derived from name if blank.">
              <Input
                value={form.key}
                disabled={!!editing}
                onChange={(e) => setForm({ ...form, key: e.target.value })}
                placeholder="site_supervisor"
              />
            </Field>
          </div>
          <Field label="Description">
            <Input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </Field>
          <div>
            <div className="mb-2 text-xs font-medium text-ink-600">Tool access levels</div>
            <div className="grid max-h-72 grid-cols-1 gap-x-6 gap-y-2 overflow-y-auto rounded-md bg-ink-50 p-3 sm:grid-cols-2 lg:grid-cols-3">
              {TOOLS.map((tool) => (
                <label key={tool} className="flex items-center justify-between gap-2">
                  <span className="text-xs text-ink-700">{humanize(tool)}</span>
                  <select
                    className="rounded border-0 bg-white px-2 py-1 text-xs text-ink-800 ring-1 ring-inset ring-ink-200 focus:ring-2 focus:ring-brand-500"
                    value={form.tools[tool] ?? "none"}
                    onChange={(e) =>
                      setForm({ ...form, tools: { ...form.tools, [tool]: e.target.value } })
                    }
                  >
                    {PERMISSION_LEVELS.map((lvl) => (
                      <option key={lvl} value={lvl}>
                        {humanize(lvl)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : editing ? "Save changes" : "Create template"}
            </Button>
          </div>
        </form>
      </Modal>
    </SectionCard>
  );
}

/* ---------------------------- Project memberships --------------------------- */

interface ProjectOption {
  id: string;
  name: string;
  number?: string | null;
}

interface Membership {
  id: string;
  userId: string;
  userName?: string | null;
  userEmail?: string | null;
  templateKey?: string | null;
}

interface CompanyUser {
  /** users.id — the API's /company/users rows key users by `id` */
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
}

function MembershipsSection({
  projects,
  users,
  templates,
}: {
  projects: ProjectOption[];
  users: CompanyUser[];
  templates: Template[];
}) {
  const [projectId, setProjectId] = useState("");
  const [items, setItems] = useState<Membership[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ userId: "", templateKey: "" });
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (pid: string) => {
    if (!pid) {
      setItems(null);
      return;
    }
    setItems(null);
    setError(null);
    try {
      const res = await api.get<ListResponse<Membership>>(
        `/api/v1/projects/${pid}/memberships?page=1&pageSize=100`,
      );
      setItems(res.items);
    } catch (err) {
      setItems([]);
      setError(errMsg(err, "Failed to load memberships"));
    }
  }, []);

  useEffect(() => {
    void load(projectId);
  }, [projectId, load]);

  const userLabel = (id: string, fallbackName?: string | null, fallbackEmail?: string | null) => {
    const u = users.find((x) => x.id === id);
    return fallbackName ?? u?.name ?? fallbackEmail ?? u?.email ?? id;
  };

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    if (!projectId) return;
    setFormError(null);
    setBusy(true);
    try {
      await api.post(`/api/v1/projects/${projectId}/memberships`, {
        userId: form.userId,
        templateKey: form.templateKey,
      });
      setAddOpen(false);
      setForm({ userId: "", templateKey: "" });
      await load(projectId);
    } catch (err) {
      setFormError(errMsg(err, "Failed to add member"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title="Project memberships"
      subtitle="Who is on each project and with which permission template"
      actions={
        <Button size="sm" disabled={!projectId} onClick={() => setAddOpen(true)}>
          Add member
        </Button>
      }
    >
      <div className="mb-3 w-80">
        <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">Select a project…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.number ? `${p.number} — ` : ""}
              {p.name}
            </option>
          ))}
        </Select>
      </div>
      <ErrorAlert message={error} />
      {!projectId ? (
        <p className="py-4 text-center text-xs text-ink-400">
          Pick a project to view its members.
        </p>
      ) : items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title="No members on this project" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>User</Th>
              <Th>Email</Th>
              <Th>Template</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {items.map((m) => (
              <tr key={m.id} className="hover:bg-ink-50/60">
                <Td className="font-medium">{userLabel(m.userId, m.userName, m.userEmail)}</Td>
                <Td>{m.userEmail ?? users.find((u) => u.id === m.userId)?.email ?? "—"}</Td>
                <Td>
                  <Badge tone="blue">
                    {templates.find((t) => t.key === m.templateKey)?.name ??
                      humanize(m.templateKey ?? "—")}
                  </Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal open={addOpen} title="Add project member" onClose={() => setAddOpen(false)}>
        <ErrorAlert message={formError} />
        <form onSubmit={onAdd} className="space-y-4">
          <Field label="User">
            <Select
              required
              value={form.userId}
              onChange={(e) => setForm({ ...form, userId: e.target.value })}
            >
              <option value="">Select user…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name ?? u.email ?? u.id}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Permission template">
            <Select
              required
              value={form.templateKey}
              onChange={(e) => setForm({ ...form, templateKey: e.target.value })}
            >
              <option value="">Select template…</option>
              {templates.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !form.userId || !form.templateKey}>
              {busy ? "Adding…" : "Add member"}
            </Button>
          </div>
        </form>
      </Modal>
    </SectionCard>
  );
}

/* ----------------------------- Assurance grants ----------------------------- */

interface AssuranceGrant {
  id: string;
  userId: string;
  userName?: string | null;
  userEmail?: string | null;
  role: string;
  projectId?: string | null;
  expiresAt?: string | null;
}

function GrantsSection({
  projects,
  users,
}: {
  projects: ProjectOption[];
  users: CompanyUser[];
}) {
  const [items, setItems] = useState<AssuranceGrant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grantOpen, setGrantOpen] = useState(false);
  const [form, setForm] = useState({ userId: "", role: "integrity_reviewer", projectId: "", expiresAt: "" });
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<ListResponse<AssuranceGrant>>(
        "/api/v1/assurance-grants?page=1&pageSize=100",
      );
      setItems(res.items);
    } catch (err) {
      setItems([]);
      setError(errMsg(err, "Failed to load assurance grants"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onGrant(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { userId: form.userId, role: form.role };
      if (form.projectId) payload["projectId"] = form.projectId;
      if (form.expiresAt) payload["expiresAt"] = new Date(form.expiresAt).toISOString();
      await api.post("/api/v1/assurance-grants", payload);
      setGrantOpen(false);
      setForm({ userId: "", role: "integrity_reviewer", projectId: "", expiresAt: "" });
      await load();
    } catch (err) {
      setFormError(errMsg(err, "Failed to create grant"));
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(g: AssuranceGrant) {
    if (!window.confirm("Revoke this assurance grant?")) return;
    try {
      await api.del(`/api/v1/assurance-grants/${g.id}`);
      await load();
    } catch (err) {
      setError(errMsg(err, "Failed to revoke grant"));
    }
  }

  return (
    <SectionCard
      title="Assurance grants"
      subtitle="Segregated read-only roles for reviewers, auditors and regulators"
      actions={
        <Button size="sm" onClick={() => setGrantOpen(true)}>
          Grant access
        </Button>
      }
    >
      <ErrorAlert message={error} />
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No assurance grants"
          hint="Grant an independent reviewer, auditor or regulator scoped access."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>User</Th>
              <Th>Role</Th>
              <Th>Scope</Th>
              <Th>Expires</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {items.map((g) => (
              <tr key={g.id} className="hover:bg-ink-50/60">
                <Td className="font-medium">
                  {g.userName ??
                    g.userEmail ??
                    users.find((u) => u.id === g.userId)?.name ??
                    g.userId}
                </Td>
                <Td>
                  <Badge tone="violet">{humanize(g.role)}</Badge>
                </Td>
                <Td>
                  {g.projectId
                    ? projects.find((p) => p.id === g.projectId)?.name ?? g.projectId
                    : "All projects"}
                </Td>
                <Td>{g.expiresAt ? formatDateTime(g.expiresAt) : "Never"}</Td>
                <Td className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => onRevoke(g)}>
                    Revoke
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal open={grantOpen} title="Grant assurance access" onClose={() => setGrantOpen(false)}>
        <ErrorAlert message={formError} />
        <form onSubmit={onGrant} className="space-y-4">
          <Field label="User">
            <Select
              required
              value={form.userId}
              onChange={(e) => setForm({ ...form, userId: e.target.value })}
            >
              <option value="">Select user…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name ?? u.email ?? u.id}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Assurance role">
            <Select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              {ASSURANCE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {humanize(r)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Project scope" hint="Leave blank for company-wide access.">
            <Select
              value={form.projectId}
              onChange={(e) => setForm({ ...form, projectId: e.target.value })}
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Expires" hint="Optional — leave blank for a standing grant.">
            <Input
              type="datetime-local"
              value={form.expiresAt}
              onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setGrantOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !form.userId}>
              {busy ? "Granting…" : "Grant access"}
            </Button>
          </div>
        </form>
      </Modal>
    </SectionCard>
  );
}

/* ------------------------------- Auth events -------------------------------- */

interface AuthEvent {
  id: string;
  userId?: string | null;
  email?: string | null;
  kind?: string | null;
  ip?: string | null;
  userName?: string | null;
  /** event timestamp — the API column is `at` */
  at?: string | null;
}

function AuthEventsSection({ users }: { users: CompanyUser[] }) {
  const [items, setItems] = useState<AuthEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<ListResponse<AuthEvent>>("/api/v1/company/auth-events?page=1&pageSize=50")
      .then((res) => setItems(res.items))
      .catch((err: Error) => {
        setItems([]);
        setError(err.message);
      });
  }, []);

  return (
    <SectionCard title="Auth events" subtitle="Recent sign-ins and security events">
      <ErrorAlert message={error} />
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title="No auth events recorded" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>User</Th>
              <Th>Event</Th>
              <Th>IP</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {items.map((e) => (
              <tr key={e.id} className="hover:bg-ink-50/60">
                <Td className="whitespace-nowrap text-xs">{formatDateTime(e.at)}</Td>
                <Td className="text-xs">
                  {e.email ??
                    users.find((u) => u.id === e.userId)?.email ??
                    e.userId ??
                    "—"}
                </Td>
                <Td>
                  <Badge tone="gray">{humanize(e.kind ?? "event")}</Badge>
                </Td>
                <Td className="font-mono text-xs">{e.ip ?? "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </SectionCard>
  );
}

/* ----------------------------------- Page ----------------------------------- */

export default function AdminPage() {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [users, setUsers] = useState<CompanyUser[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);

  useEffect(() => {
    api
      .get<ListResponse<ProjectOption>>("/api/v1/projects?page=1&pageSize=100")
      .then((res) => setProjects(res.items))
      .catch(() => setProjects([]));
    api
      .get<ListResponse<CompanyUser>>("/api/v1/company/users?page=1&pageSize=100")
      .then((res) => setUsers(res.items))
      .catch(() => setUsers([]));
    api
      .get<ListResponse<Template>>("/api/v1/permission-templates?page=1&pageSize=100")
      .then((res) => setTemplates(res.items))
      .catch(() => setTemplates([]));
  }, []);

  return (
    <div>
      <PageHeader
        title="Admin"
        subtitle="Permissions, memberships, assurance access and security"
      />
      <div className="space-y-6">
        <TemplatesSection />
        <MembershipsSection projects={projects} users={users} templates={templates} />
        <GrantsSection projects={projects} users={users} />
        <AuthEventsSection users={users} />
      </div>
    </div>
  );
}
