/**
 * BIM model registry — ISO 19650 CDE container states, version uploads,
 * federation groups and coordination issues (spec §1.4 #231-247, Domain L
 * #639-640).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { DRAWING_DISCIPLINES, MODEL_FORMATS } from "@constructos/shared";
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
import { formatDate, humanize } from "../format";
import {
  CDE_NEXT_STATES,
  CdeBadge,
  ISSUE_NEXT_STATUSES,
  ProcessingChip,
  SUITABILITY_BY_STATE,
  SuitabilityChip,
  type BimModel,
  type CoordinationIssue,
  type FederationGroup,
  type ListResponse,
} from "./bimShared";

export default function BimPage() {
  const { projectId } = useParams<{ projectId: string }>();

  /* ------------------------------- models ------------------------------- */
  const [models, setModels] = useState<BimModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", discipline: "other", format: "ifc" });
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadTarget, setUploadTarget] = useState<BimModel | null>(null);
  const [uploadingModelId, setUploadingModelId] = useState<string | null>(null);

  const [stateTarget, setStateTarget] = useState<BimModel | null>(null);
  const [stateForm, setStateForm] = useState({ cdeState: "", suitability: "" });
  const [stateError, setStateError] = useState<string | null>(null);

  const loadModels = useCallback(async () => {
    if (!projectId) return;
    setModelsError(null);
    try {
      const res = await api.get<ListResponse<BimModel>>(
        `/api/v1/projects/${projectId}/bim/models?pageSize=100`,
      );
      setModels(res.items);
    } catch (err) {
      setModels([]);
      setModelsError(err instanceof Error ? err.message : "Failed to load models");
    }
  }, [projectId]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  async function onCreateModel(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      await api.post(`/api/v1/projects/${projectId}/bim/models`, {
        name: createForm.name.trim(),
        discipline: createForm.discipline,
        format: createForm.format,
      });
      setCreateOpen(false);
      setCreateForm({ name: "", discipline: "other", format: "ifc" });
      await loadModels();
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Failed to create the model.");
    } finally {
      setBusy(false);
    }
  }

  function startUpload(model: BimModel) {
    setUploadTarget(model);
    fileInputRef.current?.click();
  }

  async function onFileChosen(files: FileList | null) {
    const file = files?.[0];
    const target = uploadTarget;
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file || !target) return;
    setUploadingModelId(target.id);
    setModelsError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      await api.upload(`/api/v1/bim/models/${target.id}/versions`, form);
      await loadModels();
    } catch (err) {
      setModelsError(
        err instanceof ApiClientError
          ? `Upload failed: ${err.message}`
          : "Upload failed — check the file and try again.",
      );
    } finally {
      setUploadingModelId(null);
      setUploadTarget(null);
    }
  }

  function openStateModal(model: BimModel) {
    const current = model.currentVersion?.cdeState ?? "wip";
    const nextStates = CDE_NEXT_STATES[current] ?? [];
    const first = nextStates[0] ?? "";
    setStateForm({
      cdeState: first,
      suitability: first ? (SUITABILITY_BY_STATE[first]?.[0] ?? "") : "",
    });
    setStateError(null);
    setStateTarget(model);
  }

  async function onStateSubmit(e: FormEvent) {
    e.preventDefault();
    const version = stateTarget?.currentVersion;
    if (!version) return;
    setStateError(null);
    setBusy(true);
    try {
      await api.patch(`/api/v1/bim/versions/${version.id}/state`, {
        cdeState: stateForm.cdeState,
        suitability: stateForm.suitability,
      });
      setStateTarget(null);
      await loadModels();
    } catch (err) {
      setStateError(err instanceof ApiClientError ? err.message : "State transition failed.");
    } finally {
      setBusy(false);
    }
  }

  /* ----------------------------- federations ----------------------------- */
  const [federations, setFederations] = useState<FederationGroup[] | null>(null);
  const [fedError, setFedError] = useState<string | null>(null);
  const [fedName, setFedName] = useState("");
  const [memberPick, setMemberPick] = useState<Record<string, string>>({});

  const loadFederations = useCallback(async () => {
    if (!projectId) return;
    setFedError(null);
    try {
      const res = await api.get<{ items: FederationGroup[] }>(
        `/api/v1/projects/${projectId}/bim/federations`,
      );
      setFederations(res.items);
    } catch (err) {
      setFederations([]);
      setFedError(err instanceof Error ? err.message : "Failed to load federations");
    }
  }, [projectId]);

  useEffect(() => {
    void loadFederations();
  }, [loadFederations]);

  async function onCreateFederation(e: FormEvent) {
    e.preventDefault();
    if (!fedName.trim()) return;
    setFedError(null);
    try {
      await api.post(`/api/v1/projects/${projectId}/bim/federations`, { name: fedName.trim() });
      setFedName("");
      await loadFederations();
    } catch (err) {
      setFedError(err instanceof ApiClientError ? err.message : "Failed to create the federation.");
    }
  }

  async function onAddMember(groupId: string) {
    const modelVersionId = memberPick[groupId];
    if (!modelVersionId) return;
    setFedError(null);
    try {
      await api.post(`/api/v1/projects/${projectId}/bim/federations/${groupId}/members`, {
        modelVersionId,
      });
      setMemberPick((m) => ({ ...m, [groupId]: "" }));
      await loadFederations();
    } catch (err) {
      setFedError(err instanceof ApiClientError ? err.message : "Failed to add the member.");
    }
  }

  const versionOptions = (models ?? [])
    .filter((m) => m.currentVersionId && m.currentVersion)
    .map((m) => ({
      value: m.currentVersionId as string,
      label: `${m.name} · v${m.currentVersion?.version}`,
    }));

  /* -------------------------------- issues ------------------------------- */
  const [issues, setIssues] = useState<CoordinationIssue[] | null>(null);
  const [issuesTotal, setIssuesTotal] = useState(0);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueForm, setIssueForm] = useState({ title: "", description: "", discipline: "" });
  const [issueError, setIssueError] = useState<string | null>(null);

  const loadIssues = useCallback(async () => {
    if (!projectId) return;
    setIssuesError(null);
    try {
      const res = await api.get<ListResponse<CoordinationIssue>>(
        `/api/v1/projects/${projectId}/bim/issues?pageSize=50`,
      );
      setIssues(res.items);
      setIssuesTotal(res.total);
    } catch (err) {
      setIssues([]);
      setIssuesError(err instanceof Error ? err.message : "Failed to load coordination issues");
    }
  }, [projectId]);

  useEffect(() => {
    void loadIssues();
  }, [loadIssues]);

  async function onCreateIssue(e: FormEvent) {
    e.preventDefault();
    setIssueError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { title: issueForm.title.trim() };
      if (issueForm.description.trim()) payload["description"] = issueForm.description.trim();
      if (issueForm.discipline) payload["discipline"] = issueForm.discipline;
      await api.post(`/api/v1/projects/${projectId}/bim/issues`, payload);
      setIssueOpen(false);
      setIssueForm({ title: "", description: "", discipline: "" });
      await loadIssues();
    } catch (err) {
      setIssueError(err instanceof ApiClientError ? err.message : "Failed to create the issue.");
    } finally {
      setBusy(false);
    }
  }

  async function onIssueStatus(issue: CoordinationIssue, status: string) {
    if (!status || status === issue.status) return;
    setIssuesError(null);
    try {
      await api.patch(`/api/v1/bim/issues/${issue.id}`, { status });
      await loadIssues();
    } catch (err) {
      setIssuesError(err instanceof ApiClientError ? err.message : "Status change failed.");
    }
  }

  /* -------------------------------- render ------------------------------- */

  return (
    <div>
      <PageHeader
        title="BIM Models"
        subtitle="Model registry with ISO 19650 CDE container states, federation and coordination"
        actions={<Button onClick={() => setCreateOpen(true)}>New model</Button>}
      />

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".ifc,.gltf,.glb,.nwd,.rvt"
        onChange={(e) => void onFileChosen(e.target.files)}
      />

      <ErrorAlert message={modelsError} />

      {models === null ? (
        <Spinner label="Loading models…" />
      ) : models.length === 0 ? (
        <EmptyState
          title="No models yet"
          hint="Register a discipline model, then upload an IFC file to extract elements and open the 3D viewer."
          action={<Button onClick={() => setCreateOpen(true)}>Register a model</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Model</Th>
              <Th>Discipline</Th>
              <Th>Format</Th>
              <Th>Version</Th>
              <Th>CDE state</Th>
              <Th>Suitability</Th>
              <Th className="text-right">Elements</Th>
              <Th>Processing</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {models.map((m) => {
              const v = m.currentVersion;
              const nextStates = v ? (CDE_NEXT_STATES[v.cdeState] ?? []) : [];
              return (
                <tr key={m.id} className="hover:bg-ink-50/60">
                  <Td>
                    <Link
                      to={`/projects/${projectId}/bim/${m.id}`}
                      className="font-medium text-brand-700 hover:text-brand-800"
                    >
                      {m.name}
                    </Link>
                  </Td>
                  <Td>{humanize(m.discipline)}</Td>
                  <Td>
                    <Badge tone={m.format === "ifc" ? "blue" : "gray"}>
                      {m.format.toUpperCase()}
                    </Badge>
                  </Td>
                  <Td>{v ? `v${v.version}` : "—"}</Td>
                  <Td>
                    <CdeBadge state={v?.cdeState} />
                  </Td>
                  <Td>
                    <SuitabilityChip code={v?.suitability} />
                  </Td>
                  <Td className="text-right tabular-nums">
                    {v ? v.elementCount.toLocaleString() : "—"}
                  </Td>
                  <Td>
                    <ProcessingChip processing={v?.processing} />
                  </Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={uploadingModelId === m.id}
                        onClick={() => startUpload(m)}
                      >
                        {uploadingModelId === m.id ? "Uploading…" : "Upload version"}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!v || nextStates.length === 0}
                        onClick={() => openStateModal(m)}
                        title={
                          !v
                            ? "Upload a version first"
                            : nextStates.length === 0
                              ? "Archived — no further transitions"
                              : "ISO 19650 state transition"
                        }
                      >
                        State
                      </Button>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <div className="mt-6 grid grid-cols-1 gap-5 xl:grid-cols-2">
        {/* -------------------------- Federations -------------------------- */}
        <Card>
          <CardBody>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink-900">Federation groups</h2>
              <span className="text-xs text-ink-400">
                Named sets of model versions viewed together
              </span>
            </div>
            <ErrorAlert message={fedError} />
            <form onSubmit={onCreateFederation} className="mb-4 flex gap-2">
              <Input
                placeholder="e.g. Full building coordination set"
                value={fedName}
                onChange={(e) => setFedName(e.target.value)}
              />
              <Button type="submit" variant="secondary" disabled={!fedName.trim()}>
                Create
              </Button>
            </form>
            {federations === null ? (
              <Spinner />
            ) : federations.length === 0 ? (
              <p className="py-4 text-center text-xs text-ink-400">
                No federation groups yet — create one to combine discipline models.
              </p>
            ) : (
              <div className="space-y-3">
                {federations.map((g) => (
                  <div key={g.id} className="rounded-md border border-ink-100 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-sm font-medium text-ink-900">{g.name}</span>
                      <span className="text-xs text-ink-400">
                        {g.members.length} member{g.members.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    {g.members.length > 0 && (
                      <ul className="mb-2 space-y-1">
                        {g.members.map((mem) => (
                          <li key={mem.id} className="flex items-center gap-2 text-xs text-ink-600">
                            <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
                            {mem.modelName} · v{mem.version}
                            <span className="text-ink-400">({humanize(mem.discipline)})</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="flex gap-2">
                      <Select
                        value={memberPick[g.id] ?? ""}
                        onChange={(e) => setMemberPick((m) => ({ ...m, [g.id]: e.target.value }))}
                        className="text-xs"
                      >
                        <option value="">Add model version…</option>
                        {versionOptions.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!memberPick[g.id]}
                        onClick={() => void onAddMember(g.id)}
                      >
                        Add
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        {/* ---------------------------- Issues ----------------------------- */}
        <Card>
          <CardBody>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink-900">
                Coordination issues{" "}
                <span className="font-normal text-ink-400">({issuesTotal})</span>
              </h2>
              <Button size="sm" variant="secondary" onClick={() => setIssueOpen(true)}>
                New issue
              </Button>
            </div>
            <ErrorAlert message={issuesError} />
            {issues === null ? (
              <Spinner />
            ) : issues.length === 0 ? (
              <p className="py-4 text-center text-xs text-ink-400">
                No coordination issues. Raise clashes from the model viewer or create one here.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-ink-100 text-sm">
                  <thead>
                    <tr>
                      <Th>#</Th>
                      <Th>Title</Th>
                      <Th>Discipline</Th>
                      <Th>Elements</Th>
                      <Th>Status</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {issues.map((issue) => {
                      const next = ISSUE_NEXT_STATUSES[issue.status] ?? [];
                      return (
                        <tr key={issue.id}>
                          <Td className="tabular-nums text-ink-400">{issue.number}</Td>
                          <Td>
                            <div className="font-medium text-ink-900">{issue.title}</div>
                            {issue.description ? (
                              <div className="max-w-xs truncate text-xs text-ink-400">
                                {issue.description}
                              </div>
                            ) : null}
                          </Td>
                          <Td>{issue.discipline ? humanize(issue.discipline) : "—"}</Td>
                          <Td className="tabular-nums">
                            {issue.elementGlobalIds?.length || "—"}
                          </Td>
                          <Td>
                            <div className="flex items-center gap-2">
                              <Badge tone={statusTone(issue.status)}>
                                {humanize(issue.status)}
                              </Badge>
                              {next.length > 0 && (
                                <Select
                                  className="w-28 py-1 text-xs"
                                  value=""
                                  onChange={(e) => void onIssueStatus(issue, e.target.value)}
                                >
                                  <option value="">Move to…</option>
                                  {next.map((s) => (
                                    <option key={s} value={s}>
                                      {humanize(s)}
                                    </option>
                                  ))}
                                </Select>
                              )}
                            </div>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {/* --------------------------- Create model --------------------------- */}
      <Modal open={createOpen} title="Register model" onClose={() => setCreateOpen(false)}>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreateModel} className="space-y-4">
          <Field label="Model name">
            <Input
              required
              value={createForm.name}
              onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Architectural model — Tower A"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Discipline">
              <Select
                value={createForm.discipline}
                onChange={(e) => setCreateForm((f) => ({ ...f, discipline: e.target.value }))}
              >
                {DRAWING_DISCIPLINES.map((d) => (
                  <option key={d} value={d}>
                    {humanize(d)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Format" hint="IFC uploads get element extraction + 3D viewing.">
              <Select
                value={createForm.format}
                onChange={(e) => setCreateForm((f) => ({ ...f, format: e.target.value }))}
              >
                {MODEL_FORMATS.map((fmt) => (
                  <option key={fmt} value={fmt}>
                    {fmt.toUpperCase()}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !createForm.name.trim()}>
              {busy ? "Creating…" : "Register model"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ------------------------- CDE state change ------------------------- */}
      <Modal
        open={stateTarget !== null}
        title={`CDE state — ${stateTarget?.name ?? ""} v${stateTarget?.currentVersion?.version ?? ""}`}
        onClose={() => setStateTarget(null)}
      >
        <ErrorAlert message={stateError} />
        <form onSubmit={onStateSubmit} className="space-y-4">
          <div className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-600">
            Current state: <CdeBadge state={stateTarget?.currentVersion?.cdeState} />{" "}
            <SuitabilityChip code={stateTarget?.currentVersion?.suitability} />
            <span className="mt-1 block text-ink-400">
              ISO 19650 flow: WIP → Shared → Published → Archived. Re-sharing with a new
              suitability code is allowed from Shared.
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="New CDE state">
              <Select
                value={stateForm.cdeState}
                onChange={(e) => {
                  const next = e.target.value;
                  setStateForm({
                    cdeState: next,
                    suitability: SUITABILITY_BY_STATE[next]?.[0] ?? "",
                  });
                }}
              >
                {(CDE_NEXT_STATES[stateTarget?.currentVersion?.cdeState ?? "wip"] ?? []).map(
                  (s) => (
                    <option key={s} value={s}>
                      {humanize(s)}
                    </option>
                  ),
                )}
              </Select>
            </Field>
            <Field label="Suitability code">
              <Select
                value={stateForm.suitability}
                onChange={(e) => setStateForm((f) => ({ ...f, suitability: e.target.value }))}
              >
                {(SUITABILITY_BY_STATE[stateForm.cdeState] ?? []).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setStateTarget(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !stateForm.cdeState || !stateForm.suitability}>
              {busy ? "Applying…" : "Apply transition"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* --------------------------- Create issue --------------------------- */}
      <Modal open={issueOpen} title="New coordination issue" onClose={() => setIssueOpen(false)}>
        <ErrorAlert message={issueError} />
        <form onSubmit={onCreateIssue} className="space-y-4">
          <Field label="Title">
            <Input
              required
              value={issueForm.title}
              onChange={(e) => setIssueForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="Duct clashes with primary steel at L3 grid C-4"
            />
          </Field>
          <Field label="Discipline">
            <Select
              value={issueForm.discipline}
              onChange={(e) => setIssueForm((f) => ({ ...f, discipline: e.target.value }))}
            >
              <option value="">—</option>
              {DRAWING_DISCIPLINES.map((d) => (
                <option key={d} value={d}>
                  {humanize(d)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Description">
            <Textarea
              value={issueForm.description}
              onChange={(e) => setIssueForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="What clashes, where, and the proposed resolution…"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setIssueOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !issueForm.title.trim()}>
              {busy ? "Creating…" : "Create issue"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
