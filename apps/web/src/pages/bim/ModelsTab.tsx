/**
 * Models tab — the container register (spec #231-236, #639-640, #638).
 *
 * Every row says where its container actually is: which version is current,
 * whether extraction succeeded (and why not), what the quality gate found,
 * and who authorised publication. Large uploads are queued rather than parsed
 * in the request, so the row shows "queued" and the ingestion job picks it up.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { DRAWING_DISCIPLINES, MODEL_FORMATS } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  Drawer,
  DrawerBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, formatBytes, humanize } from "../format";
import {
  CDE_NEXT_STATES,
  CdeBadge,
  ProcessingChip,
  SUITABILITY_BY_STATE,
  SuitabilityChip,
  type BimModel,
  type FederationGroup,
  type ListResponse,
  type ModelVersion,
  type VersionDiffResponse,
} from "./bimShared";

export default function ModelsTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const [models, setModels] = useState<BimModel[] | null>(null);
  const [modelTotal, setModelTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", discipline: "other", format: "ifc" });
  const [createError, setCreateError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadTarget, setUploadTarget] = useState<BimModel | null>(null);
  const [uploadingModelId, setUploadingModelId] = useState<string | null>(null);

  const [stateTarget, setStateTarget] = useState<BimModel | null>(null);
  const [stateForm, setStateForm] = useState({ cdeState: "", suitability: "", note: "", override: "" });
  const [stateError, setStateError] = useState<string | null>(null);

  const [detail, setDetail] = useState<BimModel | null>(null);
  const [versions, setVersions] = useState<ModelVersion[] | null>(null);
  const [diff, setDiff] = useState<VersionDiffResponse | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ pageSize: "100" });
      if (search.trim()) params.set("search", search.trim());
      const res = await api.get<ListResponse<BimModel>>(
        `/api/v1/projects/${projectId}/bim/models?${params}`,
      );
      setModels(res.items);
      setModelTotal(res.total);
    } catch (err) {
      setModels([]);
      setError(err instanceof Error ? err.message : "Failed to load models");
    }
  }, [projectId, search]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

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
      await load();
      onChanged();
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
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const created = await api.upload<ModelVersion & { queued: boolean; locationsCreated: number }>(
        `/api/v1/projects/${projectId}/bim/models/${target.id}/versions`,
        form,
      );
      if (created.queued) {
        toast.success(
          `v${created.version} stored (${formatBytes(created.sizeBytes ?? null)}). Extraction is queued — the register updates when it finishes.`,
        );
      } else if (created.processing === "failed") {
        toast.error(`v${created.version} could not be parsed: ${created.processingError ?? "unknown reason"}`);
      } else {
        toast.success(
          `v${created.version} extracted: ${created.elementCount.toLocaleString()} elements${
            created.locationsCreated > 0 ? `, ${created.locationsCreated} locations created` : ""
          }.`,
        );
      }
      await load();
      onChanged();
    } catch (err) {
      setError(
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
      note: "",
      override: "",
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
      const payload: Record<string, unknown> = {
        cdeState: stateForm.cdeState,
        suitability: stateForm.suitability,
      };
      if (stateForm.note.trim()) payload["note"] = stateForm.note.trim();
      if (stateForm.override.trim()) payload["overrideQualityReason"] = stateForm.override.trim();
      await api.patch(`/api/v1/bim/versions/${version.id}/state`, payload);
      setStateTarget(null);
      toast.success(`Container moved to ${stateForm.cdeState} / ${stateForm.suitability}.`);
      await load();
      onChanged();
    } catch (err) {
      setStateError(err instanceof ApiClientError ? err.message : "State transition failed.");
    } finally {
      setBusy(false);
    }
  }

  async function openDetail(model: BimModel) {
    setDetail(model);
    setVersions(null);
    setDiff(null);
    setDiffError(null);
    try {
      const res = await api.get<{ versions: ModelVersion[] }>(`/api/v1/bim/models/${model.id}`);
      setVersions(res.versions);
    } catch (err) {
      setVersions([]);
      setDiffError(err instanceof Error ? err.message : "Failed to load versions");
    }
  }

  async function loadDiff(versionId: string) {
    setDiff(null);
    setDiffError(null);
    try {
      setDiff(await api.get<VersionDiffResponse>(`/api/v1/bim/versions/${versionId}/diff`));
    } catch (err) {
      setDiffError(err instanceof Error ? err.message : "Comparison failed");
    }
  }

  async function reprocess(versionId: string) {
    setBusy(true);
    try {
      const res = await api.post<{ processing: string; elementCount: number; processingError: string | null }>(
        `/api/v1/bim/versions/${versionId}/process`,
      );
      if (res.processing === "ready") toast.success(`Extraction complete: ${res.elementCount} elements.`);
      else toast.error(res.processingError ?? "Extraction failed.");
      await load();
      if (detail) await openDetail(detail);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "Could not re-run extraction.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteModel(model: BimModel) {
    if (!window.confirm(`Delete "${model.name}" and every version, element and stored file?`)) return;
    setBusy(true);
    try {
      await api.del(`/api/v1/bim/models/${model.id}`);
      toast.success("Model deleted.");
      setDetail(null);
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink-900">
          Discipline models
          {models !== null && modelTotal > models.length ? (
            <span className="ml-2 text-xs font-normal text-ink-500">
              showing {models.length} of {modelTotal} — search to narrow the list
            </span>
          ) : null}
        </h2>
        <div className="flex items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models…"
            className="max-w-xs"
          />
          <Button onClick={() => setCreateOpen(true)}>New model</Button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".ifc,.ifczip,.ifcxml,.gltf,.glb,.nwd,.nwc,.nwf,.rvt,.dwg,.zip"
        onChange={(e) => void onFileChosen(e.target.files)}
      />

      <ErrorAlert message={error} />

      {models === null ? (
        <Spinner label="Loading models…" />
      ) : models.length === 0 ? (
        <EmptyState
          title="No models yet"
          hint="Register a discipline model, then upload an IFC to extract its elements, property sets and spatial structure."
          action={<Button onClick={() => setCreateOpen(true)}>Register a model</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Model</Th>
              <Th>Discipline</Th>
              <Th>Format</Th>
              <Th>Current</Th>
              <Th>CDE state</Th>
              <Th>Suitability</Th>
              <Th className="text-right">Elements</Th>
              <Th>Ingestion</Th>
              <Th>Quality</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {models.map((m) => {
              const v = m.currentVersion;
              const latest = m.latestVersion;
              const pending = latest && latest.id !== m.currentVersionId ? latest : null;
              const nextStates = v ? (CDE_NEXT_STATES[v.cdeState] ?? []) : [];
              const quality = v?.qualityReport ?? null;
              return (
                <tr key={m.id} className="hover:bg-ink-50/60">
                  <Td>
                    <button
                      type="button"
                      onClick={() => void openDetail(m)}
                      className="font-medium text-brand-700 hover:text-brand-800"
                    >
                      {m.name}
                    </button>
                    <div className="text-[11px] text-ink-400">
                      {m.versionCount ?? 0} version{(m.versionCount ?? 0) === 1 ? "" : "s"}
                    </div>
                  </Td>
                  <Td>{humanize(m.discipline)}</Td>
                  <Td>
                    <Badge tone={m.format === "ifc" ? "info" : "neutral"}>
                      {m.format.toUpperCase()}
                    </Badge>
                  </Td>
                  <Td>
                    {v ? `v${v.version}` : "—"}
                    {pending ? (
                      <div className="text-[11px] text-amber-700">v{pending.version} processing</div>
                    ) : null}
                  </Td>
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
                    <ProcessingChip
                      processing={pending?.processing ?? v?.processing}
                      error={pending?.processingError ?? v?.processingError}
                    />
                  </Td>
                  <Td>
                    {!quality ? (
                      <span className="text-ink-300">—</span>
                    ) : quality.passed ? (
                      <Badge tone="success" size="sm">
                        passed
                      </Badge>
                    ) : (
                      <Badge tone="danger" size="sm">
                        {quality.findings.filter((f) => f.severity === "blocking").length} blocking
                      </Badge>
                    )}
                  </Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <Link
                        to={`/projects/${projectId}/bim/${m.id}`}
                        className="rounded-md border border-ink-200 px-2 py-1 text-xs font-medium text-ink-700 hover:bg-ink-50"
                      >
                        Viewer
                      </Link>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={uploadingModelId === m.id}
                        onClick={() => startUpload(m)}
                      >
                        {uploadingModelId === m.id ? "Uploading…" : "Upload"}
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

      <FederationPanel projectId={projectId} models={models ?? []} />

      {/* ------------------------------ create ------------------------------ */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Register a model">
        <form onSubmit={onCreateModel} className="space-y-3">
          <ErrorAlert message={createError} />
          <Field label="Name">
            <Input
              value={createForm.name}
              onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
              required
              placeholder="Architecture — Tower A"
            />
          </Field>
          <Field label="Discipline">
            <Select
              value={createForm.discipline}
              onChange={(e) => setCreateForm({ ...createForm, discipline: e.target.value })}
            >
              {DRAWING_DISCIPLINES.map((d) => (
                <option key={d} value={d}>
                  {humanize(d)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Format" hint="IFC containers are parsed for elements, psets and spatial structure. Other formats are stored and streamed to the viewer.">
            <Select
              value={createForm.format}
              onChange={(e) => setCreateForm({ ...createForm, format: e.target.value })}
            >
              {MODEL_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f.toUpperCase()}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Create
            </Button>
          </div>
        </form>
      </Modal>

      {/* ------------------------------- state ------------------------------ */}
      <Modal
        open={stateTarget !== null}
        onClose={() => setStateTarget(null)}
        title={`ISO 19650 transition — ${stateTarget?.name ?? ""}`}
      >
        <form onSubmit={onStateSubmit} className="space-y-3">
          <ErrorAlert message={stateError} />
          <p className="text-xs text-ink-500">
            Publication is an authorisation, not an edit: it requires bim admin, a different person
            from whoever uploaded the container, a successful extraction, and a passing quality gate
            (or a recorded override).
          </p>
          <Field label="New state">
            <Select
              value={stateForm.cdeState}
              onChange={(e) =>
                setStateForm({
                  ...stateForm,
                  cdeState: e.target.value,
                  suitability: SUITABILITY_BY_STATE[e.target.value]?.[0] ?? "",
                })
              }
            >
              {(CDE_NEXT_STATES[stateTarget?.currentVersion?.cdeState ?? "wip"] ?? []).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Suitability">
            <Select
              value={stateForm.suitability}
              onChange={(e) => setStateForm({ ...stateForm, suitability: e.target.value })}
            >
              {(SUITABILITY_BY_STATE[stateForm.cdeState] ?? []).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Note" hint="Recorded on the version and in the ledger.">
            <Input
              value={stateForm.note}
              onChange={(e) => setStateForm({ ...stateForm, note: e.target.value })}
              placeholder="Checked against the BEP"
            />
          </Field>
          {stateForm.cdeState === "published" &&
          stateTarget?.currentVersion?.qualityReport &&
          !stateTarget.currentVersion.qualityReport.passed ? (
            <Field
              label="Quality gate override reason"
              hint="This container failed the quality gate. Publishing it anyway needs a reason, which is stored on the version."
            >
              <Textarea
                rows={2}
                value={stateForm.override}
                onChange={(e) => setStateForm({ ...stateForm, override: e.target.value })}
              />
            </Field>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setStateTarget(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Apply
            </Button>
          </div>
        </form>
      </Modal>

      {/* ------------------------------ detail ------------------------------ */}
      <Drawer
        open={detail !== null}
        onOpenChange={(open) => !open && setDetail(null)}
        title={detail?.name ?? "Model"}
        description="Version history, ingestion outcome and version comparison"
        size="lg"
      >
        <DrawerBody>
          <ErrorAlert message={diffError} />
          {versions === null ? (
            <Spinner label="Loading versions…" />
          ) : versions.length === 0 ? (
            <EmptyState title="No versions" hint="Upload a container to create the first version." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Version</Th>
                  <Th>State</Th>
                  <Th className="text-right">Elements</Th>
                  <Th>Ingestion</Th>
                  <Th>Authorised</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {versions.map((v) => (
                  <tr key={v.id}>
                    <Td>
                      v{v.version}
                      <div className="text-[11px] text-ink-400">{formatDate(v.createdAt)}</div>
                    </Td>
                    <Td>
                      <CdeBadge state={v.cdeState} /> <SuitabilityChip code={v.suitability} />
                    </Td>
                    <Td className="text-right tabular-nums">{v.elementCount.toLocaleString()}</Td>
                    <Td>
                      <ProcessingChip processing={v.processing} error={v.processingError} />
                      {v.processingError ? (
                        <div className="max-w-[220px] truncate text-[11px] text-red-600" title={v.processingError}>
                          {v.processingError}
                        </div>
                      ) : null}
                    </Td>
                    <Td className="text-xs text-ink-500">
                      {v.authorisedAt ? formatDate(v.authorisedAt) : "—"}
                    </Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="secondary" onClick={() => void loadDiff(v.id)}>
                          Compare
                        </Button>
                        {v.processing !== "ready" ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => void reprocess(v.id)}
                          >
                            Re-run
                          </Button>
                        ) : null}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}

          {detail?.currentVersion?.qualityReport ? (
            <Card className="mt-4">
              <CardBody>
                <h3 className="mb-2 text-sm font-semibold text-ink-900">
                  Model quality gate — v{detail.currentVersion.version}
                </h3>
                {detail.currentVersion.qualityReport.findings.length === 0 ? (
                  <p className="text-xs text-emerald-700">No findings.</p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {detail.currentVersion.qualityReport.findings.map((f) => (
                      <li key={f.check} className="flex items-start gap-2">
                        <Badge
                          size="sm"
                          tone={
                            f.severity === "blocking"
                              ? "danger"
                              : f.severity === "warning"
                                ? "warning"
                                : "neutral"
                          }
                        >
                          {f.count}
                        </Badge>
                        <span>
                          <span className="font-medium text-ink-800">{humanize(f.check)}</span> —{" "}
                          <span className="text-ink-500">{f.detail}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {detail.currentVersion.qualityReport.notes.map((note) => (
                  <p key={note} className="mt-2 text-[11px] text-ink-400">
                    {note}
                  </p>
                ))}
              </CardBody>
            </Card>
          ) : null}

          {diff ? (
            <Card className="mt-4">
              <CardBody>
                <h3 className="mb-2 text-sm font-semibold text-ink-900">
                  Version comparison{" "}
                  {diff.baseVersion !== undefined
                    ? `v${diff.baseVersion} → v${diff.targetVersion}`
                    : ""}
                </h3>
                {!diff.diff ? (
                  <p className="text-xs text-ink-500">{diff.reason}</p>
                ) : (
                  <div>
                    <div className="mb-2 flex gap-4 text-xs">
                      <span className="text-emerald-700">+{diff.diff.addedCount} added</span>
                      <span className="text-red-700">−{diff.diff.removedCount} removed</span>
                      <span className="text-amber-700">{diff.diff.modifiedCount} modified</span>
                      <span className="text-ink-500">{diff.diff.unchangedCount} unchanged</span>
                    </div>
                    <Table>
                      <thead>
                        <tr>
                          <Th>IFC type</Th>
                          <Th className="text-right">Added</Th>
                          <Th className="text-right">Removed</Th>
                          <Th className="text-right">Modified</Th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-ink-100">
                        {Object.entries(diff.diff.byType).map(([type, delta]) => (
                          <tr key={type}>
                            <Td className="font-mono text-[11px]">{type}</Td>
                            <Td className="text-right tabular-nums">{delta.added}</Td>
                            <Td className="text-right tabular-nums">{delta.removed}</Td>
                            <Td className="text-right tabular-nums">{delta.modified}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                    {(diff.affectedIssues ?? []).length > 0 ? (
                      <div className="mt-3 rounded-md bg-amber-50 p-2 text-xs text-amber-900">
                        <p className="font-medium">
                          {diff.affectedIssues!.length} open coordination issue(s) reference elements
                          this version changed or removed:
                        </p>
                        <ul className="mt-1 list-disc pl-4">
                          {diff.affectedIssues!.slice(0, 8).map((i) => (
                            <li key={i.id}>
                              #{i.number} {i.title} —{" "}
                              {i.removedElements.length > 0
                                ? `${i.removedElements.length} removed`
                                : `${i.modifiedElements.length} modified`}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                )}
              </CardBody>
            </Card>
          ) : null}

          {detail ? (
            <div className="mt-4 flex justify-end">
              <Button variant="danger" disabled={busy} onClick={() => void deleteModel(detail)}>
                Delete model
              </Button>
            </div>
          ) : null}
        </DrawerBody>
      </Drawer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Federations                                                         */
/* ------------------------------------------------------------------ */

function FederationPanel({ projectId, models }: { projectId: string; models: BimModel[] }) {
  const [groups, setGroups] = useState<FederationGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [pick, setPick] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ items: FederationGroup[] }>(
        `/api/v1/projects/${projectId}/bim/federations`,
      );
      setGroups(res.items);
    } catch (err) {
      setGroups([]);
      setError(err instanceof Error ? err.message : "Failed to load federations");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const versionOptions = models
    .filter((m) => m.currentVersionId && m.currentVersion)
    .map((m) => ({
      value: m.currentVersionId as string,
      label: `${m.name} · v${m.currentVersion?.version}`,
    }));

  async function createGroup(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await api.post(`/api/v1/projects/${projectId}/bim/federations`, { name: name.trim() });
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to create the federation.");
    }
  }

  async function addMember(groupId: string) {
    const modelVersionId = pick[groupId];
    if (!modelVersionId) return;
    try {
      await api.post(`/api/v1/projects/${projectId}/bim/federations/${groupId}/members`, {
        modelVersionId,
      });
      setPick((p) => ({ ...p, [groupId]: "" }));
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to add the member.");
    }
  }

  async function removeMember(groupId: string, memberId: string) {
    try {
      await api.del(`/api/v1/projects/${projectId}/bim/federations/${groupId}/members/${memberId}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to remove the member.");
    }
  }

  async function removeGroup(groupId: string) {
    if (!window.confirm("Delete this federation?")) return;
    try {
      await api.del(`/api/v1/projects/${projectId}/bim/federations/${groupId}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to delete the federation.");
    }
  }

  return (
    <Card className="mt-6">
      <CardBody>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-900">Federations</h2>
          <span className="text-xs text-ink-400">
            Named sets of container versions viewed and clash-tested together
          </span>
        </div>
        <ErrorAlert message={error} />
        <form onSubmit={createGroup} className="mb-4 flex gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full building"
            className="max-w-xs"
          />
          <Button type="submit" variant="secondary">
            Add federation
          </Button>
        </form>
        {groups === null ? (
          <Spinner label="Loading federations…" />
        ) : groups.length === 0 ? (
          <p className="text-xs text-ink-500">
            No federations yet. A clash test runs over one federation, so create one and add the
            discipline versions that must be coordinated.
          </p>
        ) : (
          <div className="space-y-3">
            {groups.map((g) => (
              <div key={g.id} className="rounded-md border border-ink-100 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-ink-900">{g.name}</span>
                  <Button size="sm" variant="ghost" onClick={() => void removeGroup(g.id)}>
                    Delete
                  </Button>
                </div>
                {g.members.length === 0 ? (
                  <p className="text-xs text-ink-400">No members.</p>
                ) : (
                  <ul className="mb-2 space-y-1 text-xs">
                    {g.members.map((m) => (
                      <li key={m.id} className="flex items-center justify-between">
                        <span>
                          {m.modelName} · v{m.version} · {humanize(m.discipline)} ·{" "}
                          {(m.elementCount ?? 0).toLocaleString()} elements
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void removeMember(g.id, m.id)}
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex gap-2">
                  <Select
                    value={pick[g.id] ?? ""}
                    onChange={(e) => setPick((p) => ({ ...p, [g.id]: e.target.value }))}
                    className="max-w-xs"
                  >
                    <option value="">Add a model version…</option>
                    {versionOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                  <Button size="sm" variant="secondary" onClick={() => void addMember(g.id)}>
                    Add
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
