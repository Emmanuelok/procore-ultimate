/**
 * The 4-step CSV migration wizard: upload → map columns → validate → commit.
 *
 * Honesty rules of the wizard:
 *   · The mapping step is driven entirely by the code-resident dataset
 *     registry (GET /ingestion/datasets) — no field can be invented here.
 *   · The validation report is shown as returned: staged vs rejected counts
 *     and per-row reasons. Rejected rows are never smuggled into a commit.
 *   · The commit step names what will be created, where, and shows the
 *     retained file hash that every committed record traces back to.
 */
import { useMemo, useState, type ChangeEvent } from "react";
import { api } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  ErrorAlert,
  Field,
  Input,
  Select,
  Spinner,
} from "../../ui";
import { formatBytes, formatDateTime } from "../format";
import {
  Caveat,
  CountStat,
  ReportTable,
  RowSplitBar,
  fmtInt,
  guessColumnMap,
  normalizeCreateRunResponse,
  shortSha,
  type CreateRunResult,
  type DatasetInfo,
  type ProjectPick,
  type RunRow,
  type SourceRow,
} from "./ingestionShared";

const STEPS = [
  { n: 1, label: "Upload CSV" },
  { n: 2, label: "Map columns" },
  { n: 3, label: "Validate" },
  { n: 4, label: "Commit" },
];

function Stepper({ step }: { step: number }) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      {STEPS.map((s, i) => (
        <div key={s.n} className="flex items-center gap-2">
          <div
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
              s.n === step
                ? "bg-brand-600 text-white"
                : s.n < step
                  ? "bg-brand-100 text-brand-800"
                  : "bg-ink-100 text-ink-500"
            }`}
          >
            <span className="tabular-nums">{s.n < step ? "✓" : s.n}</span>
            {s.label}
          </div>
          {i < STEPS.length - 1 ? <span className="text-ink-300">→</span> : null}
        </div>
      ))}
    </div>
  );
}

function extractRun(res: unknown): RunRow | null {
  if (!res || typeof res !== "object") return null;
  const obj = res as Record<string, unknown>;
  const candidate = obj["run"] && typeof obj["run"] === "object" ? obj["run"] : res;
  return candidate && typeof candidate === "object" && "id" in (candidate as object)
    ? (candidate as RunRow)
    : null;
}

export default function ImportWizard({
  datasets,
  sources,
  projects,
  onSourcesChanged,
  onDone,
}: {
  datasets: DatasetInfo[] | null;
  sources: SourceRow[] | null;
  projects: ProjectPick[] | null;
  onSourcesChanged: () => Promise<void>;
  onDone: (runId: string) => void;
}) {
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* ------------------------------ step 1 state ----------------------------- */

  const csvSources = useMemo(
    () => (sources ?? []).filter((s) => s.kind === "csv" && s.isActive === 1),
    [sources],
  );
  const [sourceId, setSourceId] = useState("");
  const [datasetCode, setDatasetCode] = useState("");
  const [projectId, setProjectId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [newSourceName, setNewSourceName] = useState("");

  const dataset = useMemo(
    () => (datasets ?? []).find((d) => d.dataset === datasetCode) ?? null,
    [datasets, datasetCode],
  );

  const effectiveSourceId = sourceId || (csvSources.length === 1 ? csvSources[0]!.id : "");

  async function onQuickCreateSource() {
    const name = newSourceName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<SourceRow>("/api/v1/ingestion/sources", { name, kind: "csv" });
      await onSourcesChanged();
      if (res && typeof res === "object" && "id" in res) setSourceId(res.id);
      setNewSourceName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the source");
    } finally {
      setBusy(false);
    }
  }

  function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    setFile(e.target.files?.[0] ?? null);
  }

  /* -------------------------- created run + mapping ------------------------ */

  const [created, setCreated] = useState<CreateRunResult | null>(null);
  const [run, setRun] = useState<RunRow | null>(null);
  const [columnMap, setColumnMap] = useState<Record<string, string>>({});
  const [mapped, setMapped] = useState(false);

  const uploadReady =
    Boolean(effectiveSourceId) &&
    Boolean(dataset) &&
    Boolean(file) &&
    (!dataset?.requiresProject || Boolean(projectId));

  async function onUpload() {
    if (!uploadReady || !file || !dataset) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("sourceId", effectiveSourceId);
      form.append("dataset", dataset.dataset);
      if (projectId) form.append("projectId", projectId);
      const res = await api.upload<unknown>("/api/v1/ingestion/runs", form);
      const norm = normalizeCreateRunResponse(res);
      if (!norm) {
        setError("The server accepted the upload but returned an unrecognised response shape.");
        return;
      }
      setCreated(norm);
      setRun(norm.run);
      setColumnMap(guessColumnMap(dataset.fields, norm.columns));
      setMapped(false);
      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- step 2 -------------------------------- */

  const missingRequired = useMemo(() => {
    if (!dataset) return [];
    return dataset.fields.filter((f) => f.required && !columnMap[f.key]);
  }, [dataset, columnMap]);

  async function onMap() {
    if (!run || missingRequired.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(columnMap)) if (v) cleaned[k] = v;
      const res = await api.post<unknown>(`/api/v1/ingestion/runs/${run.id}/map`, {
        columnMap: cleaned,
      });
      const next = extractRun(res);
      if (next) setRun(next);
      setMapped(true);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mapping failed");
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- step 3 -------------------------------- */

  const [validated, setValidated] = useState<RunRow | null>(null);

  async function onValidate() {
    if (!run) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<unknown>(`/api/v1/ingestion/runs/${run.id}/validate`);
      const next = extractRun(res);
      if (next) {
        setRun(next);
        setValidated(next);
      } else {
        // fall back to re-reading the run so the report is never invisible
        const detail = await api.get<unknown>(`/api/v1/ingestion/runs/${run.id}`);
        const r = extractRun(detail);
        if (r) {
          setRun(r);
          setValidated(r);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Validation failed");
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- step 4 -------------------------------- */

  const [committed, setCommitted] = useState<RunRow | null>(null);

  async function onCommit() {
    if (!run) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<unknown>(`/api/v1/ingestion/runs/${run.id}/commit`);
      const next = extractRun(res);
      if (next) {
        setRun(next);
        setCommitted(next);
      } else {
        const detail = await api.get<unknown>(`/api/v1/ingestion/runs/${run.id}`);
        const r = extractRun(detail);
        if (r) {
          setRun(r);
          setCommitted(r);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Commit failed");
    } finally {
      setBusy(false);
    }
  }

  async function onDiscard() {
    if (!run) return;
    if (!window.confirm("Abandon this import? All staged rows are dropped; the run is kept as discarded.")) return;
    setBusy(true);
    setError(null);
    try {
      await api.post<unknown>(`/api/v1/ingestion/runs/${run.id}/discard`);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Discard failed");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep(1);
    setError(null);
    setFile(null);
    setCreated(null);
    setRun(null);
    setColumnMap({});
    setMapped(false);
    setValidated(null);
    setCommitted(null);
  }

  /* -------------------------------- render --------------------------------- */

  if (datasets === null || sources === null) {
    return <Spinner label="Loading the dataset registry…" />;
  }

  return (
    <div className="max-w-4xl">
      <Stepper step={step} />
      <ErrorAlert message={error} />

      {/* ================================ STEP 1 ============================== */}
      {step === 1 ? (
        <Card>
          <CardBody className="space-y-4">
            <p className="text-sm text-ink-600">
              Upload a CSV batch. Nothing is committed here: the file is stored content-addressed
              (its SHA-256 becomes the batch's provenance anchor), rows are staged, and you review
              every validation finding before anything real is created.
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Source" hint="Where this file comes from. Sources are managed on the Sources tab.">
                {csvSources.length > 0 ? (
                  <Select value={effectiveSourceId} onChange={(e) => setSourceId(e.target.value)}>
                    <option value="">Select a CSV source…</option>
                    {csvSources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <div className="flex gap-2">
                    <Input
                      value={newSourceName}
                      onChange={(e) => setNewSourceName(e.target.value)}
                      placeholder="Name a CSV source, e.g. Legacy ERP export"
                    />
                    <Button
                      variant="secondary"
                      onClick={() => void onQuickCreateSource()}
                      disabled={busy || !newSourceName.trim()}
                    >
                      Create
                    </Button>
                  </div>
                )}
              </Field>

              <Field label="Dataset" hint="The registry decides which fields exist and what validation applies.">
                <Select
                  value={datasetCode}
                  onChange={(e) => {
                    setDatasetCode(e.target.value);
                    setProjectId("");
                  }}
                >
                  <option value="">Select a dataset…</option>
                  {datasets.map((d) => (
                    <option key={d.dataset} value={d.dataset}>
                      {d.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {dataset ? (
              <div className="rounded-md bg-ink-50 p-3 text-xs text-ink-600">
                <span className="font-medium text-ink-400">Committed rows land in: </span>
                {dataset.target}
              </div>
            ) : null}

            {dataset?.requiresProject ? (
              <Field
                label="Project (required for this dataset)"
                hint="This dataset commits into project-scoped records, so the run must carry a project."
              >
                <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">Select a project…</option>
                  {(projects ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.number ? `${p.number} — ${p.name}` : p.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}

            <Field label="CSV file" hint="Comma-separated with a header row. Quoted fields, escaped quotes and CRLF are handled; up to 20,000 data rows per run.">
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={onPickFile}
                className="block w-full text-sm text-ink-700 file:mr-3 file:rounded-md file:border-0 file:bg-brand-600 file:px-3.5 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-brand-700"
              />
            </Field>
            {file ? (
              <p className="text-xs text-ink-500">
                {file.name} · {formatBytes(file.size)}
              </p>
            ) : null}

            <div className="flex justify-end">
              <Button onClick={() => void onUpload()} disabled={!uploadReady || busy}>
                {busy ? "Uploading…" : "Upload & stage"}
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* ================================ STEP 2 ============================== */}
      {step === 2 && created && dataset && run ? (
        <div className="space-y-4">
          <Card>
            <CardBody className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-ink-600">
                  <span className="font-medium text-ink-900">{run.fileName ?? file?.name}</span> —{" "}
                  {fmtInt(run.totalRows)} data rows detected, file hash{" "}
                  <span className="font-mono" title={run.fileSha256 ?? undefined}>
                    {shortSha(run.fileSha256)}
                  </span>
                  .
                </p>
                <Badge tone="amber">Staging</Badge>
              </div>

              {created.columns.length === 0 ? (
                <Caveat>
                  The server did not return detected header columns for this run, so auto-mapping
                  is unavailable. You can still type nothing here — go back and re-upload, or check
                  the file has a header row.
                </Caveat>
              ) : null}

              <div>
                <h3 className="mb-2 text-sm font-semibold text-ink-900">
                  Map CSV columns to {dataset.label} fields
                </h3>
                <p className="mb-3 text-xs text-ink-500">
                  Target: {dataset.target}. Only fields in the registry can be mapped — anything
                  else in the file is ignored. Re-mapping later replaces all previously staged rows
                  for this run.
                </p>
                <div className="overflow-x-auto rounded-md ring-1 ring-ink-100">
                  <table className="min-w-full divide-y divide-ink-100 text-sm">
                    <thead className="bg-ink-50">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-500">Field</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-500">Type</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-500">CSV column</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-50 bg-white">
                      {dataset.fields.map((f) => (
                        <tr key={f.key}>
                          <td className="px-3 py-2">
                            <div className="font-medium text-ink-900">
                              {f.label}
                              {f.required ? <span className="ml-1 text-red-600" title="Required">*</span> : null}
                            </div>
                            <div className="font-mono text-[11px] text-ink-400">{f.key}</div>
                            {f.description ? (
                              <div className="mt-0.5 max-w-md text-[11px] text-ink-400">{f.description}</div>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 align-top text-xs text-ink-600">
                            {f.type}
                            {f.enumValues ? (
                              <div className="mt-0.5 max-w-52 text-[11px] text-ink-400">
                                {f.enumValues.join(" · ")}
                              </div>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 align-top">
                            <Select
                              value={columnMap[f.key] ?? ""}
                              onChange={(e) =>
                                setColumnMap((m) => ({ ...m, [f.key]: e.target.value }))
                              }
                              className="w-56"
                            >
                              <option value="">— not mapped —</option>
                              {created.columns.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </Select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {missingRequired.length > 0 ? (
                  <p className="mt-2 text-xs text-red-700">
                    Required fields not yet mapped: {missingRequired.map((f) => f.label).join(", ")}
                  </p>
                ) : null}
              </div>

              {created.preview.length > 0 ? (
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-ink-900">
                    First {created.preview.length} raw rows
                  </h3>
                  <div className="overflow-x-auto rounded-md ring-1 ring-ink-100">
                    <table className="min-w-full divide-y divide-ink-100 text-xs">
                      <thead className="bg-ink-50">
                        <tr>
                          {created.columns.map((c) => (
                            <th key={c} className="whitespace-nowrap px-3 py-1.5 text-left font-semibold text-ink-500">
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-ink-50 bg-white">
                        {created.preview.map((row, i) => (
                          <tr key={i}>
                            {created.columns.map((_, j) => (
                              <td key={j} className="max-w-52 truncate px-3 py-1.5 text-ink-700" title={row[j] ?? ""}>
                                {row[j] ?? ""}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              <div className="flex justify-between">
                <Button variant="ghost" onClick={() => void onDiscard()} disabled={busy}>
                  Abandon import
                </Button>
                <Button onClick={() => void onMap()} disabled={busy || missingRequired.length > 0}>
                  {busy ? "Staging rows…" : mapped ? "Re-map & re-stage rows" : "Apply mapping & stage rows"}
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      ) : null}

      {/* ================================ STEP 3 ============================== */}
      {step === 3 && run && dataset ? (
        <Card>
          <CardBody className="space-y-4">
            <p className="text-sm text-ink-600">
              Every staged row is checked against the {dataset.label.toLowerCase()} registry:
              required fields, types, enum membership, cross-field rules and duplicate
              source-system IDs — both within this run and against records already committed.
            </p>

            {validated === null ? (
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-400">
                  {fmtInt(run.stagedCount || run.totalRows)} rows staged and waiting for validation.
                </span>
                <Button onClick={() => void onValidate()} disabled={busy}>
                  {busy ? "Validating…" : "Run validation"}
                </Button>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <CountStat label="Total rows" value={validated.totalRows} />
                  <CountStat label="Clean (staged)" value={validated.stagedCount} tone="blue" />
                  <CountStat
                    label="Rejected"
                    value={validated.rejectedCount}
                    tone={validated.rejectedCount > 0 ? "red" : "gray"}
                  />
                  <CountStat label="Skipped" value={validated.skippedCount} tone="gray" />
                </div>

                {validated.rejectedCount > 0 ? (
                  <Caveat>
                    {fmtInt(validated.rejectedCount)} rows failed validation. The run is still{" "}
                    <span className="font-semibold">validated</span> — but commit takes ONLY the{" "}
                    {fmtInt(validated.stagedCount)} clean rows. Rejected rows stay on the run with
                    their reasons; fix the source file and run a fresh import to bring them in.
                  </Caveat>
                ) : (
                  <p className="text-xs text-emerald-700">
                    All {fmtInt(validated.stagedCount)} rows passed validation.
                  </p>
                )}

                <div>
                  <h3 className="mb-2 text-sm font-semibold text-ink-900">Validation report</h3>
                  <ReportTable report={validated.report ?? []} rejectedCount={validated.rejectedCount} />
                </div>

                <div className="flex justify-between">
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={() => setStep(2)} disabled={busy}>
                      Back to mapping
                    </Button>
                    <Button variant="ghost" onClick={() => void onDiscard()} disabled={busy}>
                      Abandon import
                    </Button>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={() => void onValidate()} disabled={busy}>
                      Re-validate
                    </Button>
                    <Button
                      onClick={() => setStep(4)}
                      disabled={busy || validated.status !== "validated" || validated.stagedCount === 0}
                    >
                      Continue to commit
                    </Button>
                  </div>
                </div>
                {validated.stagedCount === 0 ? (
                  <p className="text-xs text-red-700">
                    No clean rows survived validation — there is nothing to commit. Fix the source
                    data and start again, or abandon the import.
                  </p>
                ) : null}
              </>
            )}
          </CardBody>
        </Card>
      ) : null}

      {/* ================================ STEP 4 ============================== */}
      {step === 4 && run && dataset ? (
        <Card>
          <CardBody className="space-y-4">
            {committed === null ? (
              <>
                <p className="text-sm text-ink-600">
                  Commit creates <span className="font-semibold">{fmtInt(run.stagedCount)}</span>{" "}
                  real records in: <span className="font-medium">{dataset.target}</span>. The commit
                  is transactional, each staged row keeps a forward link to the record it became,
                  and one ledger entry records the file hash and the counts.
                </p>
                {run.rejectedCount > 0 ? (
                  <Caveat>
                    {fmtInt(run.rejectedCount)} rejected rows are NOT part of this commit.
                  </Caveat>
                ) : null}
                <div className="flex justify-between">
                  <Button variant="secondary" onClick={() => setStep(3)} disabled={busy}>
                    Back
                  </Button>
                  <Button onClick={() => void onCommit()} disabled={busy}>
                    {busy ? "Committing…" : `Commit ${fmtInt(run.stagedCount)} rows`}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Badge tone="green">Committed</Badge>
                  <span className="text-sm text-ink-600">{formatDateTime(committed.committedAt)}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <CountStat label="Committed" value={committed.committedCount} tone="green" />
                  <CountStat
                    label="Rejected (left behind)"
                    value={committed.rejectedCount}
                    tone={committed.rejectedCount > 0 ? "red" : "gray"}
                  />
                  <CountStat label="Skipped" value={committed.skippedCount} tone="gray" />
                  <CountStat label="Total rows" value={committed.totalRows} />
                </div>
                <RowSplitBar run={committed} />
                <div className="rounded-md bg-ink-50 p-3 text-xs leading-relaxed text-ink-600">
                  <span className="font-medium text-ink-900">Provenance retained: </span>
                  the uploaded file is stored content-addressed under SHA-256{" "}
                  <span className="font-mono" title={committed.fileSha256 ?? undefined}>
                    {committed.fileSha256 ?? "—"}
                  </span>
                  . Every committed record links back to this run, and the commit was appended to
                  the ledger once with this hash and the final counts. The import can always be
                  audited against the exact bytes that were sent.
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={reset}>
                    Start another import
                  </Button>
                  <Button onClick={() => onDone(committed.id)}>View run in the register</Button>
                </div>
              </>
            )}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
