/**
 * Admin governance surfaces (Vol I §0.1 #27, §0.8 #45–#47, #78, #92).
 *
 *   · AuditTab      — the tenant's hash-chained ledger as a filterable trail
 *   · RetentionTab  — retention policies, what they WOULD act on, and what
 *                     the substrate honestly does not enforce
 *   · LegalHoldTab  — holds that block deletion, and their release history
 *   · ExportTab     — the company data bundle (#45) with an honest manifest
 *   · DelegationTab — bounded administration handed to a member (#27)
 *   · RecycleBinTab — soft-deleted projects, vendors and contacts (#78)
 *
 * Each tab owns its loading / error / empty state and never renders a figure
 * the API did not return as 0.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ADMIN_DELEGATION_CAPABILITIES, RETENTION_ACTIONS } from "@constructos/shared";
import { api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Drawer,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Stat,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { Pagination } from "../../ui/data";
import { IconDownload, IconPlus, IconRefresh, IconTrash } from "../../ui/icons";
import { formatDateTime } from "../format";
import {
  AUDIT_ACTION_TONE,
  EXPORT_DATASETS,
  asList,
  errorMessage,
  humanize,
  num,
  type AdminDelegation,
  type AuditEntry,
  type AuditFacets,
  type ExportJob,
  type LegalHold,
  type RecycledDirectoryRow,
  type RecycledProject,
  type RetentionPolicy,
  type RetentionPreviewRow,
} from "./substrate";

const PAGE_SIZE = 25;

export interface Option {
  id: string;
  name: string;
}

/* ============================== Audit ================================== */

export function AuditTab() {
  const [items, setItems] = useState<AuditEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [objectType, setObjectType] = useState("");
  const [action, setAction] = useState("");
  const [objectId, setObjectId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [facets, setFacets] = useState<AuditFacets | null>(null);
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (objectType) params.set("objectType", objectType);
      if (action) params.set("action", action);
      if (objectId.trim()) params.set("objectId", objectId.trim());
      const res = await api.get<unknown>(`/api/v1/company/audit?${params.toString()}`);
      const list = asList<AuditEntry>(res);
      setItems(list.items);
      setTotal(list.total);
    } catch (err) {
      setItems([]);
      setError(errorMessage(err, "Failed to load the audit trail"));
    }
  }, [page, objectType, action, objectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .get<AuditFacets>("/api/v1/company/audit/facets")
      .then(setFacets)
      .catch(() => setFacets(null));
  }, []);

  useEffect(() => {
    setPage(1);
  }, [objectType, action, objectId]);

  return (
    <div className="space-y-4">
      <Alert tone="info" size="sm">
        This is a reader over the hash-chained ledger, not a second trail. Every entry carries the
        hash that links it to the one before, so a gap or an edit is detectable.
      </Alert>

      <div className="flex flex-wrap items-end gap-2">
        <Field label="Object type" className="w-52">
          <Select value={objectType} onChange={(e) => setObjectType(e.target.value)} size="sm">
            <option value="">All types</option>
            {(facets?.objectTypes ?? []).map((t) => (
              <option key={t.value} value={t.value}>
                {humanize(t.value)} ({t.count})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Action" className="w-44">
          <Select value={action} onChange={(e) => setAction(e.target.value)} size="sm">
            <option value="">All actions</option>
            {(facets?.actions ?? []).map((a) => (
              <option key={a.value} value={a.value}>
                {humanize(a.value)} ({a.count})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Record id" className="w-64">
          <Input
            size="sm"
            value={objectId}
            placeholder="rfi_… / prj_…"
            onChange={(e) => setObjectId(e.target.value)}
          />
        </Field>
        <Button variant="ghost" size="sm" leadingIcon={IconRefresh} onClick={() => void load()}>
          Refresh
        </Button>
        <span className="ml-auto text-2xs text-content-subtle">{num(total)} entries</span>
      </div>

      <ErrorAlert message={error} onRetry={() => void load()} />

      {items === null ? (
        <Skeleton className="h-64 w-full" />
      ) : items.length === 0 ? (
        <EmptyState
          title="No entries match"
          hint="The ledger records consequential state changes. Narrow or clear the filters."
        />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Seq</Th>
                <Th>When</Th>
                <Th>Action</Th>
                <Th>Object</Th>
                <Th>Actor</Th>
                <Th>Payload</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr
                  key={e.entryHash}
                  className="cursor-pointer hover:bg-surface-raised"
                  onClick={() => setSelected(e)}
                >
                  <Td className="font-mono text-2xs">{e.seq}</Td>
                  <Td>{formatDateTime(e.at)}</Td>
                  <Td>
                    <Badge tone={AUDIT_ACTION_TONE[e.action] ?? "neutral"}>
                      {humanize(e.action)}
                    </Badge>
                  </Td>
                  <Td>
                    <span className="text-content-strong">{humanize(e.objectType)}</span>
                    <span className="ml-1 font-mono text-2xs text-content-subtle">
                      {e.objectId}
                    </span>
                  </Td>
                  <Td>{e.actorName ?? "—"}</Td>
                  <Td>
                    {e.payloadStored ? (
                      <Badge tone="info">Stored</Badge>
                    ) : (
                      <span
                        className="text-2xs text-content-subtle"
                        title="Payloads are stored only for high-value object types; the hash always is."
                      >
                        Not stored
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {total > PAGE_SIZE ? (
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={setPage}
          size="sm"
          itemNoun="entries"
        />
      ) : null}

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `Ledger entry #${selected.seq}` : ""}
        size="lg"
      >
        {selected ? (
          <div className="space-y-3 p-4 text-xs">
            <dl className="grid grid-cols-[9rem_1fr] gap-y-1">
              <dt className="text-content-subtle">When</dt>
              <dd>{formatDateTime(selected.at)}</dd>
              <dt className="text-content-subtle">Action</dt>
              <dd>{humanize(selected.action)}</dd>
              <dt className="text-content-subtle">Object</dt>
              <dd>
                {humanize(selected.objectType)} · <span className="font-mono">{selected.objectId}</span>
              </dd>
              <dt className="text-content-subtle">Actor</dt>
              <dd>
                {selected.actorName ?? "—"}
                {selected.actorEmail ? ` (${selected.actorEmail})` : ""}
              </dd>
              <dt className="text-content-subtle">Entry hash</dt>
              <dd className="break-all font-mono text-2xs">{selected.entryHash}</dd>
              <dt className="text-content-subtle">Previous hash</dt>
              <dd className="break-all font-mono text-2xs">{selected.prevHash ?? "— (genesis)"}</dd>
            </dl>
            <div>
              <h4 className="mb-1 font-semibold text-content-strong">Payload</h4>
              {selected.payloadStored ? (
                <pre className="max-h-80 overflow-auto rounded bg-surface-sunken p-2 text-2xs">
                  {JSON.stringify(selected.payload, null, 2)}
                </pre>
              ) : (
                <p className="text-content-muted">
                  Not stored for this object type. The payload hash{" "}
                  <span className="font-mono">{selected.payloadHash ?? "—"}</span> still proves what
                  was written.
                </p>
              )}
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}

/* ============================ Retention ================================ */

export function RetentionTab() {
  const [policies, setPolicies] = useState<RetentionPolicy[] | null>(null);
  const [preview, setPreview] = useState<RetentionPreviewRow[] | null>(null);
  const [holdCount, setHoldCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    objectType: "project",
    retainMonths: "84",
    action: "retain",
    basis: "",
  });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<unknown>("/api/v1/company/retention-policies");
      setPolicies(asList<RetentionPolicy>(res).items);
    } catch (err) {
      setPolicies([]);
      setError(errorMessage(err, "Failed to load retention policies"));
    }
  }, []);

  const loadPreview = useCallback(async () => {
    setPreviewError(null);
    try {
      const res = await api.get<{ items: RetentionPreviewRow[]; holds: number }>(
        "/api/v1/company/retention-policies/preview",
      );
      setPreview(res.items);
      setHoldCount(res.holds);
    } catch (err) {
      setPreview(null);
      setHoldCount(null);
      setPreviewError(errorMessage(err, "Failed to preview retention"));
    }
  }, []);

  useEffect(() => {
    void load();
    void loadPreview();
  }, [load, loadPreview]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put(`/api/v1/company/retention-policies/${form.objectType}`, {
        retainMonths: Number(form.retainMonths),
        action: form.action,
        basis: form.basis.trim() || null,
      });
      toast.success(`Retention policy saved for ${humanize(form.objectType)}`);
      setOpen(false);
      await load();
      await loadPreview();
    } catch (err) {
      setError(errorMessage(err, "Failed to save the policy"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-content-muted">
          A policy states how long a record type is kept and what happens then. The substrate
          enforces deletion refusal under a legal hold for the types it owns; for everything else a
          policy is recorded and reported, never silently executed.
        </p>
        <Button size="sm" leadingIcon={IconPlus} onClick={() => setOpen(true)}>
          Set policy
        </Button>
      </div>

      <ErrorAlert message={error} onRetry={() => void load()} />

      {policies === null ? (
        <Skeleton className="h-32 w-full" />
      ) : policies.length === 0 ? (
        <EmptyState
          title="No retention policies"
          hint="Nothing is being retired on a schedule. Set a policy per record type to state the retention period and its legal basis."
          action={
            <Button size="sm" onClick={() => setOpen(true)}>
              Set the first policy
            </Button>
          }
        />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Record type</Th>
                <Th>Retain</Th>
                <Th>Then</Th>
                <Th>Basis</Th>
                <Th>Active</Th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id}>
                  <Td className="font-medium">{humanize(p.objectType)}</Td>
                  <Td>{num(p.retainMonths)} months</Td>
                  <Td>
                    <Badge tone={p.action === "purge" ? "danger" : "neutral"}>
                      {humanize(p.action)}
                    </Badge>
                  </Td>
                  <Td className="max-w-md truncate text-content-muted">{p.basis ?? "—"}</Td>
                  <Td>{p.isActive ? <Badge tone="success">Active</Badge> : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Card>
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-content-strong">What the policies would act on</h3>
            <p className="mt-0.5 text-xs text-content-muted">
              Computed now, executed by nobody. {holdCount === null ? "" : `${num(holdCount)} active hold(s).`}
            </p>
          </div>
          <Button variant="ghost" size="sm" leadingIcon={IconRefresh} onClick={() => void loadPreview()}>
            Recompute
          </Button>
        </div>
        <CardBody>
          <ErrorAlert message={previewError} onRetry={() => void loadPreview()} />
          {preview === null ? (
            previewError ? null : (
              <Skeleton className="h-24 w-full" />
            )
          ) : preview.length === 0 ? (
            <p className="text-xs text-content-muted">
              No active policy to preview.
            </p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Record type</Th>
                  <Th>Due for action</Th>
                  <Th>Held back</Th>
                  <Th>Enforced here</Th>
                  <Th>Note</Th>
                </tr>
              </thead>
              <tbody>
                {preview.map((r) => (
                  <tr key={r.objectType}>
                    <Td className="font-medium">{humanize(r.objectType)}</Td>
                    <Td>{num(r.dueForAction)}</Td>
                    <Td>{num(r.heldBack)}</Td>
                    <Td>
                      {r.enforced ? (
                        <Badge tone="success">Yes</Badge>
                      ) : (
                        <Badge tone="warning">Reported only</Badge>
                      )}
                    </Td>
                    <Td className="max-w-lg text-xs text-content-muted">{r.note}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="Set a retention policy">
        <form onSubmit={submit} className="space-y-3 p-4">
          <Field label="Record type" hint="One policy per object type">
            <Input
              value={form.objectType}
              onChange={(e) => setForm({ ...form, objectType: e.target.value })}
              placeholder="project"
              required
            />
          </Field>
          <Field label="Retain for (months)">
            <Input
              type="number"
              min={1}
              max={1200}
              value={form.retainMonths}
              onChange={(e) => setForm({ ...form, retainMonths: e.target.value })}
              required
            />
          </Field>
          <Field label="Then">
            <Select value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
              {RETENTION_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {humanize(a)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Legal basis" hint="Which statute, contract or policy sets this period">
            <Textarea
              rows={3}
              value={form.basis}
              onChange={(e) => setForm({ ...form, basis: e.target.value })}
              placeholder="e.g. Limitation Act 1980 s.8 — 12 years for a deed"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Save policy
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/* ============================ Legal holds ============================== */

export function LegalHoldTab({ projects }: { projects: Option[] }) {
  const [items, setItems] = useState<LegalHold[] | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: "",
    reason: "",
    matter: "",
    projectId: "",
    objectType: "",
    objectId: "",
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = status ? `?status=${status}&pageSize=100` : "?pageSize=100";
      const res = await api.get<unknown>(`/api/v1/legal-holds${qs}`);
      setItems(asList<LegalHold>(res).items);
    } catch (err) {
      setItems([]);
      setError(errorMessage(err, "Failed to load legal holds"));
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/api/v1/legal-holds", {
        name: form.name,
        reason: form.reason,
        ...(form.matter ? { matter: form.matter } : {}),
        projectId: form.projectId || null,
        objectType: form.objectType || null,
        objectId: form.objectId || null,
      });
      toast.success("Legal hold placed");
      setOpen(false);
      setForm({ name: "", reason: "", matter: "", projectId: "", objectType: "", objectId: "" });
      await load();
    } catch (err) {
      setError(errorMessage(err, "Failed to place the hold"));
    } finally {
      setBusy(false);
    }
  }

  async function release(hold: LegalHold) {
    try {
      await api.post(`/api/v1/legal-holds/${hold.id}/release`, {});
      toast.success(`"${hold.name}" released`);
      await load();
    } catch (err) {
      setError(errorMessage(err, "Failed to release the hold"));
    }
  }

  const active = (items ?? []).filter((h) => h.status === "active").length;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Active holds" value={items === null ? "—" : num(active)} tone={active > 0 ? "warning" : "neutral"} />
        <Stat label="Recorded holds" value={items === null ? "—" : num(items.length)} />
        <Stat
          label="Effect"
          value={active > 0 ? "Deletion blocked" : "None"}
          hint="A hold refuses deletion of the records it covers"
        />
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Field label="Status" className="w-44">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} size="sm">
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="released">Released</option>
          </Select>
        </Field>
        <Button size="sm" leadingIcon={IconPlus} onClick={() => setOpen(true)}>
          Place a hold
        </Button>
      </div>

      <ErrorAlert message={error} onRetry={() => void load()} />

      {items === null ? (
        <Skeleton className="h-32 w-full" />
      ) : items.length === 0 ? (
        <EmptyState
          title="No legal holds"
          hint="A hold preserves evidence for a dispute or investigation: while it stands, the records it covers cannot be deleted."
        />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Scope</Th>
                <Th>Matter</Th>
                <Th>Status</Th>
                <Th>Placed</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {items.map((h) => (
                <tr key={h.id}>
                  <Td>
                    <div className="font-medium text-content-strong">{h.name}</div>
                    <div className="max-w-md truncate text-2xs text-content-muted">{h.reason}</div>
                  </Td>
                  <Td className="text-xs">
                    {h.objectType ? (
                      <>
                        {humanize(h.objectType)}
                        {h.objectId ? <span className="font-mono"> · {h.objectId}</span> : null}
                      </>
                    ) : h.projectId ? (
                      `Project ${projects.find((p) => p.id === h.projectId)?.name ?? h.projectId}`
                    ) : (
                      "Company-wide"
                    )}
                  </Td>
                  <Td>{h.matter ?? "—"}</Td>
                  <Td>
                    <Badge tone={h.status === "active" ? "warning" : "neutral"}>
                      {humanize(h.status)}
                    </Badge>
                  </Td>
                  <Td>{formatDateTime(h.createdAt)}</Td>
                  <Td>
                    {h.status === "active" ? (
                      <Button size="xs" variant="secondary" onClick={() => void release(h)}>
                        Release
                      </Button>
                    ) : (
                      <span className="text-2xs text-content-subtle">
                        {h.releasedAt ? formatDateTime(h.releasedAt) : "—"}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Place a legal hold">
        <form onSubmit={submit} className="space-y-3 p-4">
          <Field label="Name" required>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Adjudication — Package 4 groundworks"
              required
            />
          </Field>
          <Field label="Reason" required hint="Why evidence must be preserved">
            <Textarea
              rows={3}
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              required
            />
          </Field>
          <Field label="Matter reference">
            <Input value={form.matter} onChange={(e) => setForm({ ...form, matter: e.target.value })} />
          </Field>
          <Field label="Project" hint="Leave blank for a company-wide hold">
            <Select
              value={form.projectId}
              onChange={(e) => setForm({ ...form, projectId: e.target.value })}
            >
              <option value="">Company-wide</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Object type" hint="Optional — narrows the hold">
              <Input
                value={form.objectType}
                onChange={(e) => setForm({ ...form, objectType: e.target.value })}
                placeholder="project"
              />
            </Field>
            <Field label="Object id" hint="Needs an object type">
              <Input
                value={form.objectId}
                onChange={(e) => setForm({ ...form, objectId: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Place hold
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/* ============================== Exports ================================ */

export function ExportTab() {
  const [jobs, setJobs] = useState<ExportJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [datasets, setDatasets] = useState<string[]>([...EXPORT_DATASETS]);
  const [lastBundle, setLastBundle] = useState<{
    id: string;
    manifest: Record<string, unknown>;
    rowCount: number;
  } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<unknown>("/api/v1/company/exports?pageSize=50");
      setJobs(asList<ExportJob>(res).items);
    } catch (err) {
      setJobs([]);
      setError(errorMessage(err, "Failed to load the export register"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run() {
    if (datasets.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      const res = await api.post<{
        id: string;
        manifest: Record<string, unknown>;
        rowCount: number;
        data: Record<string, unknown[]>;
      }>("/api/v1/company/exports", { datasets });
      setLastBundle({ id: res.id, manifest: res.manifest, rowCount: res.rowCount });
      toast.success(`Export complete — ${res.rowCount} rows`);
      await load();
    } catch (err) {
      setError(errorMessage(err, "Export failed"));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <Alert tone="info" size="sm">
        The bundle is produced synchronously and bounded per dataset, so a truncation shows in the
        manifest instead of passing silently. The ledger records that the export happened, who ran
        it and what it contained.
      </Alert>

      <Card>
        <div className="border-b border-border-subtle px-4 py-3">
          <h3 className="text-sm font-semibold text-content-strong">Datasets</h3>
        </div>
        <CardBody className="space-y-3">
          <div className="grid gap-1 sm:grid-cols-3">
            {EXPORT_DATASETS.map((d) => (
              <label key={d} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={datasets.includes(d)}
                  onChange={() =>
                    setDatasets((prev) =>
                      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d],
                    )
                  }
                />
                <span className="text-content-default">{humanize(d)}</span>
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              leadingIcon={IconDownload}
              loading={running}
              disabled={datasets.length === 0}
              onClick={() => void run()}
            >
              Produce bundle
            </Button>
            <span className="text-2xs text-content-subtle">
              {datasets.length === 0 ? "Pick at least one dataset" : `${datasets.length} selected`}
            </span>
          </div>
          <ErrorAlert message={error} />
          {lastBundle ? (
            <div className="rounded border border-border-subtle p-3">
              <h4 className="mb-1 text-xs font-semibold text-content-strong">
                Manifest for {lastBundle.id} — {num(lastBundle.rowCount)} rows
              </h4>
              <ul className="grid gap-x-4 gap-y-0.5 text-2xs text-content-muted sm:grid-cols-3">
                {Object.entries(lastBundle.manifest).map(([k, v]) => (
                  <li key={k}>
                    {humanize(k)}: {typeof v === "number" ? num(v) : String(v)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {jobs === null ? (
        <Skeleton className="h-32 w-full" />
      ) : jobs.length === 0 ? (
        <EmptyState title="No exports yet" hint="Every bundle you produce is recorded here and in the ledger." />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Status</Th>
                <Th>Datasets</Th>
                <Th>Rows</Th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <Td>{formatDateTime(j.createdAt)}</Td>
                  <Td>
                    <Badge
                      tone={j.status === "complete" ? "success" : j.status === "failed" ? "danger" : "info"}
                    >
                      {humanize(j.status)}
                    </Badge>
                    {j.error ? (
                      <div className="max-w-md truncate text-2xs text-content-muted">{j.error}</div>
                    ) : null}
                  </Td>
                  <Td className="text-xs">{j.datasets.map(humanize).join(", ")}</Td>
                  <Td>{num(j.rowCount)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}

/* ============================ Delegation =============================== */

export function DelegationTab({
  users,
  projects,
}: {
  users: Array<{ id: string; name?: string | null; email?: string | null }>;
  projects: Option[];
}) {
  const [items, setItems] = useState<AdminDelegation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{
    userId: string;
    capabilities: string[];
    projectIds: string[];
    note: string;
    expiresAt: string;
  }>({ userId: "", capabilities: [], projectIds: [], note: "", expiresAt: "" });

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<unknown>("/api/v1/company/admin-delegations");
      setItems(asList<AdminDelegation>(res).items);
    } catch (err) {
      setItems([]);
      setError(errorMessage(err, "Failed to load delegations"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/api/v1/company/admin-delegations", {
        userId: form.userId,
        capabilities: form.capabilities,
        projectIds: form.projectIds,
        ...(form.note ? { note: form.note } : {}),
        ...(form.expiresAt ? { expiresAt: new Date(form.expiresAt).toISOString() } : {}),
      });
      toast.success("Administration delegated");
      setOpen(false);
      setForm({ userId: "", capabilities: [], projectIds: [], note: "", expiresAt: "" });
      await load();
    } catch (err) {
      setError(errorMessage(err, "Failed to delegate"));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(row: AdminDelegation) {
    try {
      await api.del(`/api/v1/company/admin-delegations/${row.id}`);
      toast.success("Delegation revoked");
      await load();
    } catch (err) {
      setError(errorMessage(err, "Failed to revoke"));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-content-muted">
          A delegation hands a member a bounded slice of administration — named capabilities over
          named projects, with an expiry — instead of a tenant-wide admin role. It never includes
          assurance roles: those are the segregation-of-duties boundary.
        </p>
        <Button size="sm" leadingIcon={IconPlus} onClick={() => setOpen(true)}>
          Delegate
        </Button>
      </div>

      <ErrorAlert message={error} onRetry={() => void load()} />

      {items === null ? (
        <Skeleton className="h-32 w-full" />
      ) : items.length === 0 ? (
        <EmptyState
          title="No delegated administration"
          hint="Every administrative act is performed by an owner or admin of the whole tenant."
        />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Member</Th>
                <Th>Capabilities</Th>
                <Th>Projects</Th>
                <Th>Expires</Th>
                <Th>State</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id}>
                  <Td>
                    <div className="font-medium text-content-strong">{d.userName ?? d.userId}</div>
                    <div className="text-2xs text-content-muted">{d.userEmail ?? ""}</div>
                  </Td>
                  <Td className="text-xs">
                    <div className="flex flex-wrap gap-1">
                      {d.capabilities.map((c) => (
                        <Badge key={c} tone="info">
                          {humanize(c)}
                        </Badge>
                      ))}
                    </div>
                  </Td>
                  <Td className="text-xs">
                    {d.projectIds.length === 0
                      ? "Every project"
                      : d.projectIds
                          .map((id) => projects.find((p) => p.id === id)?.name ?? id)
                          .join(", ")}
                  </Td>
                  <Td>{d.expiresAt ? formatDateTime(d.expiresAt) : "No expiry"}</Td>
                  <Td>
                    {d.revokedAt ? (
                      <Badge tone="neutral">Revoked</Badge>
                    ) : (
                      <Badge tone="success">Live</Badge>
                    )}
                  </Td>
                  <Td>
                    {d.revokedAt ? null : (
                      <Button size="xs" variant="secondary" onClick={() => void revoke(d)}>
                        Revoke
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Delegate administration">
        <form onSubmit={submit} className="space-y-3 p-4">
          <Field label="Member" required hint="You cannot delegate to yourself">
            <Select
              value={form.userId}
              onChange={(e) => setForm({ ...form, userId: e.target.value })}
              required
            >
              <option value="">Select a member…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name ?? u.email ?? u.id}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Capabilities" required>
            <div className="grid gap-1 sm:grid-cols-2">
              {ADMIN_DELEGATION_CAPABILITIES.map((c) => (
                <label key={c} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.capabilities.includes(c)}
                    onChange={() =>
                      setForm((f) => ({
                        ...f,
                        capabilities: f.capabilities.includes(c)
                          ? f.capabilities.filter((x) => x !== c)
                          : [...f.capabilities, c],
                      }))
                    }
                  />
                  <span>{humanize(c)}</span>
                </label>
              ))}
            </div>
          </Field>
          <Field label="Projects" hint="None selected = every project in the tenant">
            <div className="max-h-40 space-y-1 overflow-y-auto rounded border border-border-subtle p-2">
              {projects.length === 0 ? (
                <p className="text-2xs text-content-muted">No projects visible.</p>
              ) : (
                projects.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={form.projectIds.includes(p.id)}
                      onChange={() =>
                        setForm((f) => ({
                          ...f,
                          projectIds: f.projectIds.includes(p.id)
                            ? f.projectIds.filter((x) => x !== p.id)
                            : [...f.projectIds, p.id],
                        }))
                      }
                    />
                    <span>{p.name}</span>
                  </label>
                ))
              )}
            </div>
          </Field>
          <Field label="Expires">
            <Input
              type="date"
              value={form.expiresAt}
              onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
            />
          </Field>
          <Field label="Note">
            <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!form.userId || form.capabilities.length === 0}>
              Delegate
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/* ============================ Recycle bin ============================== */

export function RecycleBinTab({ isOwner }: { isOwner: boolean }) {
  const [projectsBin, setProjectsBin] = useState<RecycledProject[] | null>(null);
  const [directoryBin, setDirectoryBin] = useState<RecycledDirectoryRow[] | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setProjectError(null);
    try {
      const res = await api.get<unknown>("/api/v1/recycle-bin?pageSize=100");
      setProjectsBin(asList<RecycledProject>(res).items);
    } catch (err) {
      setProjectsBin([]);
      setProjectError(errorMessage(err, "Failed to load deleted projects"));
    }
  }, []);

  const loadDirectory = useCallback(async () => {
    setDirectoryError(null);
    try {
      const res = await api.get<unknown>("/api/v1/directory/recycle-bin");
      setDirectoryBin(asList<RecycledDirectoryRow>(res).items);
    } catch (err) {
      setDirectoryBin([]);
      setDirectoryError(errorMessage(err, "Failed to load deleted directory records"));
    }
  }, []);

  useEffect(() => {
    void loadProjects();
    void loadDirectory();
  }, [loadProjects, loadDirectory]);

  async function restoreProject(row: RecycledProject) {
    setBusyId(row.id);
    try {
      await api.post(`/api/v1/recycle-bin/projects/${row.id}/restore`, {});
      toast.success(`"${row.name}" restored`);
      await loadProjects();
    } catch (err) {
      setProjectError(errorMessage(err, "Failed to restore the project"));
    } finally {
      setBusyId(null);
    }
  }

  async function purgeProject(row: RecycledProject) {
    if (
      !window.confirm(
        `Purge "${row.name}" for good? This removes the project's substrate (memberships, locations, cost codes, links) and cannot be undone.`,
      )
    )
      return;
    setBusyId(row.id);
    try {
      const res = await api.del<{ removed: Record<string, number> }>(
        `/api/v1/recycle-bin/projects/${row.id}`,
      );
      const removed = Object.entries(res.removed ?? {})
        .map(([k, v]) => `${v} ${humanize(k).toLowerCase()}`)
        .join(", ");
      toast.success(`Purged — ${removed || "nothing left to remove"}`);
      await loadProjects();
    } catch (err) {
      setProjectError(errorMessage(err, "Failed to purge the project"));
    } finally {
      setBusyId(null);
    }
  }

  async function restoreDirectory(row: RecycledDirectoryRow) {
    setBusyId(row.id);
    try {
      const path = row.objectType === "vendor" ? "vendors" : "contacts";
      await api.post(`/api/v1/${path}/${row.id}/restore`, {});
      toast.success(`"${row.name}" restored`);
      await loadDirectory();
    } catch (err) {
      setDirectoryError(errorMessage(err, "Failed to restore"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <Alert tone="info" size="sm">
        Deleting a project, vendor or contact marks it deleted rather than destroying it: it
        vanishes from every list and gate, and can be restored intact. A purge is a separate,
        owner-only act.
      </Alert>

      <Card>
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <h3 className="text-sm font-semibold text-content-strong">Deleted projects</h3>
          <Button variant="ghost" size="sm" leadingIcon={IconRefresh} onClick={() => void loadProjects()}>
            Refresh
          </Button>
        </div>
        <CardBody>
          <ErrorAlert message={projectError} onRetry={() => void loadProjects()} />
          {projectsBin === null ? (
            <Skeleton className="h-20 w-full" />
          ) : projectsBin.length === 0 ? (
            <p className="text-xs text-content-muted">Nothing deleted.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Project</Th>
                  <Th>Stage</Th>
                  <Th>Deleted</Th>
                  <Th>By</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {projectsBin.map((row) => (
                  <tr key={row.id}>
                    <Td>
                      <span className="font-medium text-content-strong">{row.name}</span>
                      {row.number ? (
                        <span className="ml-1 text-2xs text-content-subtle">{row.number}</span>
                      ) : null}
                    </Td>
                    <Td>{humanize(row.stage)}</Td>
                    <Td>{formatDateTime(row.deletedAt)}</Td>
                    <Td>{row.deletedByName ?? row.deletedBy ?? "—"}</Td>
                    <Td>
                      <div className="flex gap-1">
                        <Button
                          size="xs"
                          variant="secondary"
                          loading={busyId === row.id}
                          onClick={() => void restoreProject(row)}
                        >
                          Restore
                        </Button>
                        {isOwner ? (
                          <Button
                            size="xs"
                            variant="danger"
                            leadingIcon={IconTrash}
                            loading={busyId === row.id}
                            onClick={() => void purgeProject(row)}
                          >
                            Purge
                          </Button>
                        ) : null}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Card>
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <h3 className="text-sm font-semibold text-content-strong">Deleted directory records</h3>
          <Button variant="ghost" size="sm" leadingIcon={IconRefresh} onClick={() => void loadDirectory()}>
            Refresh
          </Button>
        </div>
        <CardBody>
          <ErrorAlert message={directoryError} onRetry={() => void loadDirectory()} />
          {directoryBin === null ? (
            <Skeleton className="h-20 w-full" />
          ) : directoryBin.length === 0 ? (
            <p className="text-xs text-content-muted">Nothing deleted.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Type</Th>
                  <Th>Deleted</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {directoryBin.map((row) => (
                  <tr key={`${row.objectType}-${row.id}`}>
                    <Td className="font-medium text-content-strong">{row.name}</Td>
                    <Td>
                      <Badge tone="neutral">{humanize(row.objectType)}</Badge>
                    </Td>
                    <Td>{formatDateTime(row.deletedAt)}</Td>
                    <Td>
                      <Button
                        size="xs"
                        variant="secondary"
                        loading={busyId === row.id}
                        onClick={() => void restoreDirectory(row)}
                      >
                        Restore
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
