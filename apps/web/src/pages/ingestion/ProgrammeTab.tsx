/**
 * Programme import (#349-350) and saved mapping templates.
 *
 * WHY IT IS ITS OWN TAB. A CSV needs a mapping step because its columns are
 * whatever the author typed. An XER or an MSP XML carries its own field names,
 * so the mapping is known before the file arrives and the operator's job is
 * only to confirm what was read and what was NOT. That is what this screen
 * shows: the activities, the logic, and the caveats — calendars, resources,
 * baselines — in full, because a programme whose dates quietly disagree with
 * the source is worse than one the reader knows to check.
 */
import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { api } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDateTime } from "../format";
import {
  Caveat,
  asList,
  type DatasetInfo,
  type ProjectPick,
  type RunRow,
  type SourceRow,
} from "./ingestionShared";

interface ProgrammeResult {
  run: RunRow;
  parser: string;
  programmeName: string | null;
  earliestDate: string | null;
  activities: number;
  danglingLinks: number;
  caveats: string[];
  preview: {
    taskCode: string;
    name: string;
    durationDays: number;
    predecessors: string;
    wbsCode: string | null;
  }[];
  next: string;
}

interface TemplateRow {
  id: string;
  name: string;
  dataset: string;
  sourceId: string | null;
  columnMap: Record<string, string>;
  useCount: number;
  createdAt: string;
}

function fmtInt(n: number): string {
  return new Intl.NumberFormat().format(n);
}

export default function ProgrammeTab({
  datasets,
  sources,
  projects,
  onDone,
}: {
  datasets: DatasetInfo[] | null;
  sources: SourceRow[] | null;
  projects: ProjectPick[] | null;
  onDone: (runId: string) => void;
}) {
  const csvSources = (sources ?? []).filter((s) => s.kind === "csv" && s.isActive === 1);
  const [sourceId, setSourceId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProgrammeResult | null>(null);
  const [stage, setStage] = useState<"idle" | "validated" | "committed">("idle");
  const [outcome, setOutcome] = useState<string | null>(null);

  const [templates, setTemplates] = useState<TemplateRow[] | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);

  const effectiveSourceId = sourceId || (csvSources.length === 1 ? csvSources[0]!.id : "");
  const ready = Boolean(effectiveSourceId) && Boolean(projectId) && Boolean(file);

  const loadTemplates = useCallback(async () => {
    setTemplateError(null);
    try {
      const res = await api.get<unknown>("/api/v1/ingestion/mapping-templates?page=1&pageSize=50");
      setTemplates(asList<TemplateRow>(res).items);
    } catch (err) {
      setTemplates([]);
      setTemplateError(err instanceof Error ? err.message : "Failed to load mapping templates");
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    setFile(e.target.files?.[0] ?? null);
    setResult(null);
    setStage("idle");
    setOutcome(null);
  }

  async function onUpload() {
    if (!ready || !file) return;
    setBusy(true);
    setError(null);
    try {
      // Fields before the file: @fastify/multipart only exposes a field once
      // its bytes have been parsed, so a large upload with the file first can
      // reach the handler before its own metadata does.
      const form = new FormData();
      form.append("sourceId", effectiveSourceId);
      form.append("projectId", projectId);
      form.append("file", file);
      const res = await api.upload<ProgrammeResult>("/api/v1/ingestion/runs/programme", form);
      setResult(res);
      setStage("idle");
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : "The programme upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function onValidate() {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ run: RunRow; rejected?: number }>(
        `/api/v1/ingestion/runs/${result.run.id}/validate`,
      );
      setResult({ ...result, run: res.run });
      setStage("validated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Validation failed");
    } finally {
      setBusy(false);
    }
  }

  async function onCommit() {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{
        run: RunRow;
        committed: number;
        schedule?: { recomputed: boolean; reason?: string; projectFinishDate?: string; dependencies?: number };
      }>(`/api/v1/ingestion/runs/${result.run.id}/commit`);
      setResult({ ...result, run: res.run });
      setStage("committed");
      setOutcome(
        res.schedule?.recomputed
          ? `${fmtInt(res.committed)} activities committed and the programme recomputed — ${
              res.schedule.dependencies ?? 0
            } logic links, finish ${res.schedule.projectFinishDate ?? "not computed"}.`
          : `${fmtInt(res.committed)} activities committed. The CPM was NOT recomputed: ${
              res.schedule?.reason ?? "no active schedule was found"
            }.`,
      );
      onDone(result.run.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Commit failed");
    } finally {
      setBusy(false);
    }
  }

  const scheduleDataset = (datasets ?? []).find((d) => d.dataset === "schedule_tasks");

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-ink-900">Import a contractor programme</h2>
            <p className="text-xs text-ink-400">
              Primavera P6 <span className="font-mono">.xer</span> or Microsoft Project XML. A{" "}
              <span className="font-mono">.mpp</span> cannot be read — export it as XML from
              Microsoft Project first.
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Source">
              <Select value={effectiveSourceId} onChange={(e) => setSourceId(e.target.value)}>
                <option value="">Select a source…</option>
                {csvSources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Project">
              <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">Select a project…</option>
                {(projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.number ? `${p.number} — ${p.name}` : p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Programme file">
              <input
                type="file"
                accept=".xer,.xml,text/xml,application/xml,text/plain"
                onChange={onPickFile}
                className="block w-full text-sm text-ink-700 file:mr-3 file:rounded-md file:border-0 file:bg-brand-600 file:px-3.5 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-brand-700"
              />
            </Field>
          </div>

          {scheduleDataset ? (
            <div className="rounded-md bg-ink-50 p-3 text-xs text-ink-600">
              <span className="font-medium text-ink-400">Committed activities land in: </span>
              {scheduleDataset.target}
            </div>
          ) : null}

          <div className="flex justify-end">
            <Button onClick={() => void onUpload()} disabled={!ready || busy}>
              {busy && !result ? "Reading…" : "Upload & stage"}
            </Button>
          </div>

          <ErrorAlert message={error} />
        </CardBody>
      </Card>

      {result ? (
        <Card>
          <CardBody className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-ink-900">
                  {result.programmeName ?? "Programme"}{" "}
                  <Badge tone="blue">{result.parser === "p6_xer" ? "P6 XER" : "MS Project XML"}</Badge>
                </h3>
                <p className="text-xs text-ink-400">
                  {fmtInt(result.activities)} activities
                  {result.earliestDate ? ` · earliest date ${result.earliestDate}` : ""}
                  {result.danglingLinks > 0
                    ? ` · ${fmtInt(result.danglingLinks)} link(s) pointed outside the file`
                    : ""}
                </p>
              </div>
              <Badge tone={stage === "committed" ? "green" : "amber"}>{result.run.status}</Badge>
            </div>

            {result.caveats.map((c) => (
              <Caveat key={c}>{c}</Caveat>
            ))}

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-400">
                First activities read
              </p>
              <Table>
                <thead>
                  <tr>
                    <Th>Code</Th>
                    <Th>Name</Th>
                    <Th>WBS</Th>
                    <Th className="text-right">Days</Th>
                    <Th>Predecessors</Th>
                  </tr>
                </thead>
                <tbody>
                  {result.preview.map((t) => (
                    <tr key={t.taskCode}>
                      <Td className="font-mono text-xs">{t.taskCode}</Td>
                      <Td>{t.name}</Td>
                      <Td>{t.wbsCode ?? <span className="text-ink-300">—</span>}</Td>
                      <Td className="text-right tabular-nums">{t.durationDays}</Td>
                      <Td className="font-mono text-xs">
                        {t.predecessors || <span className="text-ink-300">— (start activity)</span>}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>

            {outcome ? <Caveat>{outcome}</Caveat> : <p className="text-xs text-ink-500">{result.next}</p>}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => void onValidate()}
                disabled={busy || stage === "committed"}
              >
                Validate
              </Button>
              <Button
                onClick={() => void onCommit()}
                disabled={busy || stage !== "validated"}
                title={stage !== "validated" ? "Validate the staged activities first" : undefined}
              >
                Commit {fmtInt(result.run.stagedCount)} activities
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardBody className="space-y-3">
          <div>
            <h2 className="text-base font-semibold text-ink-900">Saved mapping templates</h2>
            <p className="text-xs text-ink-400">
              The mapping step is the slow part of every migration and it is identical every month.
              A saved map makes the second import of the same export a two-click operation — and
              makes it auditable, because two runs claiming the same source can be shown to have
              read its columns the same way. Adopt one on the New import tab.
            </p>
          </div>
          <ErrorAlert message={templateError} />
          {templates === null ? (
            <Spinner label="Loading templates…" />
          ) : templates.length === 0 ? (
            <EmptyState
              title="No saved mappings yet"
              hint="Save a column map after your next CSV import and it becomes reusable here."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Dataset</Th>
                  <Th className="text-right">Fields</Th>
                  <Th className="text-right">Runs adopted</Th>
                  <Th>Created</Th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id}>
                    <Td>{t.name}</Td>
                    <Td>
                      <Badge tone="gray">{t.dataset}</Badge>
                    </Td>
                    <Td className="text-right tabular-nums">
                      {Object.keys(t.columnMap).length}
                    </Td>
                    <Td className="text-right tabular-nums">{t.useCount}</Td>
                    <Td className="whitespace-nowrap">{formatDateTime(t.createdAt)}</Td>
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
