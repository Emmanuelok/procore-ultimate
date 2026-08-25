/**
 * Ingestion runs — the register of every staged batch, committed or not.
 *
 * The drawer is the honest record of a run: counts, the capped validation
 * report, every staged row with its rejection reason verbatim, and the
 * retained file hash that ties committed records back to the exact bytes
 * they came from. Commit and discard both demand confirmation, and commit
 * states plainly that rejected rows are left behind, not smuggled in.
 */
import { useCallback, useEffect, useState } from "react";
import { INGESTION_RUN_STATUSES, STAGED_RECORD_STATUSES } from "@constructos/shared";
import { api } from "../../lib/api";
import {
  Badge,
  Button,
  EmptyState,
  ErrorAlert,
  Field,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDateTime, humanize } from "../format";
import {
  Caveat,
  CountStat,
  Drawer,
  PayloadCell,
  RECORD_STATUS_LABELS,
  ReportTable,
  RowSplitBar,
  RUN_STATUS_LABELS,
  asList,
  fmtInt,
  recordTone,
  runTone,
  shortSha,
  type DatasetInfo,
  type ProjectPick,
  type RecordRow,
  type RunRow,
  type SourceRow,
} from "./ingestionShared";

const PAGE_SIZE = 25;
const RECORDS_PAGE_SIZE = 50;

export default function RunsTab({
  datasets,
  sources,
  projects,
  focusRunId,
  onFocusConsumed,
}: {
  datasets: DatasetInfo[] | null;
  sources: SourceRow[] | null;
  projects: ProjectPick[] | null;
  focusRunId: string | null;
  onFocusConsumed: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [datasetFilter, setDatasetFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (datasetFilter) params.set("dataset", datasetFilter);
      if (statusFilter) params.set("status", statusFilter);
      const res = await api.get<unknown>(`/api/v1/ingestion/runs?${params}`);
      const { items, total: t } = asList<RunRow>(res);
      setRuns(items);
      setTotal(t);
    } catch (err) {
      setRuns((prev) => prev ?? []);
      setError(err instanceof Error ? err.message : "Failed to load ingestion runs");
    }
  }, [page, datasetFilter, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ------------------------------- drawer -------------------------------- */

  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunRow | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const [records, setRecords] = useState<RecordRow[] | null>(null);
  const [recordsTotal, setRecordsTotal] = useState(0);
  const [recordsPage, setRecordsPage] = useState(1);
  const [recordStatusFilter, setRecordStatusFilter] = useState("");
  const [recordsError, setRecordsError] = useState<string | null>(null);

  const loadRun = useCallback(async (runId: string) => {
    setRunLoading(true);
    setRunError(null);
    try {
      const res = await api.get<unknown>(`/api/v1/ingestion/runs/${runId}`);
      const obj = res && typeof res === "object" ? (res as Record<string, unknown>) : {};
      const r = (obj["run"] && typeof obj["run"] === "object" ? obj["run"] : res) as RunRow;
      setRun(r);
    } catch (err) {
      setRun(null);
      setRunError(err instanceof Error ? err.message : "Failed to load the run");
    } finally {
      setRunLoading(false);
    }
  }, []);

  const loadRecords = useCallback(
    async (runId: string) => {
      setRecordsError(null);
      try {
        const params = new URLSearchParams({
          page: String(recordsPage),
          pageSize: String(RECORDS_PAGE_SIZE),
        });
        if (recordStatusFilter) params.set("status", recordStatusFilter);
        const res = await api.get<unknown>(`/api/v1/ingestion/runs/${runId}/records?${params}`);
        const { items, total: t } = asList<RecordRow>(res);
        setRecords(items);
        setRecordsTotal(t);
      } catch (err) {
        setRecords((prev) => prev ?? []);
        setRecordsError(err instanceof Error ? err.message : "Failed to load staged records");
      }
    },
    [recordsPage, recordStatusFilter],
  );

  function openDrawer(runId: string) {
    setOpenRunId(runId);
    setRun(null);
    setRecords(null);
    setRecordsPage(1);
    setRecordStatusFilter("");
    void loadRun(runId);
  }

  useEffect(() => {
    if (openRunId) void loadRecords(openRunId);
  }, [openRunId, loadRecords]);

  /* The wizard can hand a freshly committed run to this tab. */
  useEffect(() => {
    if (focusRunId) {
      openDrawer(focusRunId);
      onFocusConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRunId]);

  function closeDrawer() {
    setOpenRunId(null);
    setRun(null);
    setRecords(null);
  }

  /* --------------------------- commit / discard --------------------------- */

  const [confirmCommit, setConfirmCommit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function onCommit() {
    if (!run) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.post<unknown>(`/api/v1/ingestion/runs/${run.id}/commit`);
      setConfirmCommit(false);
      await loadRun(run.id);
      await loadRecords(run.id);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Commit failed");
    } finally {
      setBusy(false);
    }
  }

  async function onDiscard() {
    if (!run) return;
    if (
      !window.confirm(
        `Discard run ${run.id}?\n\nAll staged rows are dropped and nothing is committed. ` +
          "The run stays in the register as discarded — it is not deleted.",
      )
    ) {
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await api.post<unknown>(`/api/v1/ingestion/runs/${run.id}/discard`);
      await loadRun(run.id);
      await loadRecords(run.id);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Discard failed");
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------- helpers ------------------------------- */

  const datasetLabel = (code: string) =>
    datasets?.find((d) => d.dataset === code)?.label ?? humanize(code);
  const sourceName = (id: string) => sources?.find((s) => s.id === id)?.name ?? id;
  const projectName = (id: string | null) =>
    id ? (projects?.find((p) => p.id === id)?.name ?? id) : "Company-wide";

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const recordsPages = Math.max(1, Math.ceil(recordsTotal / RECORDS_PAGE_SIZE));

  /* -------------------------------- render -------------------------------- */

  return (
    <div>
      <ErrorAlert message={error} />

      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Dataset">
            <Select
              value={datasetFilter}
              onChange={(e) => {
                setDatasetFilter(e.target.value);
                setPage(1);
              }}
              className="w-56"
            >
              <option value="">All datasets</option>
              {(datasets ?? []).map((d) => (
                <option key={d.dataset} value={d.dataset}>
                  {d.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="w-40"
            >
              <option value="">All statuses</option>
              {INGESTION_RUN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {RUN_STATUS_LABELS[s] ?? humanize(s)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {runs === null ? (
        <Spinner label="Loading runs…" />
      ) : runs.length === 0 ? (
        <EmptyState
          title="No ingestion runs yet"
          hint="Start a CSV import from the New import tab, or push records with an API token. Every batch lands here first, staged and inspectable, before anything is committed."
        />
      ) : (
        <>
          <Table>
            <thead className="bg-ink-50">
              <tr>
                <Th>Started</Th>
                <Th>Dataset</Th>
                <Th>File</Th>
                <Th>Status</Th>
                <Th className="text-right">Rows</Th>
                <Th className="text-right">Staged</Th>
                <Th className="text-right">Committed</Th>
                <Th className="text-right">Rejected</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-50">
              {runs.map((r) => (
                <tr key={r.id} className="cursor-pointer hover:bg-ink-50" onClick={() => openDrawer(r.id)}>
                  <Td className="whitespace-nowrap">{formatDateTime(r.createdAt)}</Td>
                  <Td>{datasetLabel(r.dataset)}</Td>
                  <Td>
                    <span className="block max-w-48 truncate" title={r.fileName ?? undefined}>
                      {r.fileName ?? <span className="text-ink-300">— (machine push)</span>}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={runTone(r.status)}>{RUN_STATUS_LABELS[r.status] ?? humanize(r.status)}</Badge>
                  </Td>
                  <Td className="text-right tabular-nums">{fmtInt(r.totalRows)}</Td>
                  <Td className="text-right tabular-nums">{fmtInt(r.stagedCount)}</Td>
                  <Td className="text-right tabular-nums text-emerald-700">{fmtInt(r.committedCount)}</Td>
                  <Td className={`text-right tabular-nums ${r.rejectedCount > 0 ? "text-red-700" : ""}`}>
                    {fmtInt(r.rejectedCount)}
                  </Td>
                  <Td>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        openDrawer(r.id);
                      }}
                    >
                      Inspect
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="mt-3 flex items-center justify-between text-xs text-ink-500">
            <span>
              {fmtInt(total)} run{total === 1 ? "" : "s"} · page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
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

      {/* ------------------------------ drawer ------------------------------ */}
      <Drawer
        open={openRunId !== null}
        title={
          run ? (
            <span className="flex items-center gap-2">
              {datasetLabel(run.dataset)}
              <Badge tone={runTone(run.status)}>{RUN_STATUS_LABELS[run.status] ?? humanize(run.status)}</Badge>
            </span>
          ) : (
            "Ingestion run"
          )
        }
        onClose={closeDrawer}
        wide
      >
        <ErrorAlert message={runError ?? actionError} />
        {runLoading && !run ? <Spinner label="Loading run…" /> : null}

        {run ? (
          <div className="space-y-5">
            {run.error ? (
              <Caveat tone="red">
                <span className="font-semibold">Run error:</span> {run.error}
              </Caveat>
            ) : null}

            {/* Provenance */}
            <div className="rounded-md bg-ink-50 p-3 text-xs text-ink-600">
              <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                <div>
                  <span className="font-medium text-ink-400">Run ID </span>
                  <span className="font-mono">{run.id}</span>
                </div>
                <div>
                  <span className="font-medium text-ink-400">Source </span>
                  {sourceName(run.sourceId)}
                </div>
                <div>
                  <span className="font-medium text-ink-400">Scope </span>
                  {projectName(run.projectId)}
                </div>
                <div>
                  <span className="font-medium text-ink-400">Started </span>
                  {formatDateTime(run.createdAt)}
                </div>
                <div>
                  <span className="font-medium text-ink-400">File </span>
                  {run.fileName ?? "— (no file: connector or machine push)"}
                </div>
                <div title={run.fileSha256 ?? undefined}>
                  <span className="font-medium text-ink-400">File SHA-256 </span>
                  <span className="font-mono">{shortSha(run.fileSha256)}</span>
                </div>
                {run.committedAt ? (
                  <div>
                    <span className="font-medium text-ink-400">Committed </span>
                    {formatDateTime(run.committedAt)}
                  </div>
                ) : null}
              </div>
              {run.fileSha256 ? (
                <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
                  The uploaded file is retained content-addressed under this hash. Every record
                  committed from this run carries provenance back to the run and to these exact
                  bytes — the import can always be audited against what was actually sent.
                </p>
              ) : null}
            </div>

            {/* Counts */}
            <div>
              <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
                <CountStat label="Total rows" value={run.totalRows} />
                <CountStat label="Staged" value={run.stagedCount} tone="blue" />
                <CountStat label="Committed" value={run.committedCount} tone="green" />
                <CountStat label="Rejected" value={run.rejectedCount} tone={run.rejectedCount > 0 ? "red" : "gray"} />
                <CountStat label="Skipped" value={run.skippedCount} tone="gray" />
              </div>
              <RowSplitBar run={run} />
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-2">
              {run.status === "validated" ? (
                <Button onClick={() => setConfirmCommit(true)} disabled={busy || run.stagedCount === 0}>
                  Commit {fmtInt(run.stagedCount)} rows…
                </Button>
              ) : null}
              {run.status === "staging" || run.status === "validated" ? (
                <Button variant="danger" onClick={() => void onDiscard()} disabled={busy}>
                  Discard run
                </Button>
              ) : null}
              {run.status === "staging" ? (
                <span className="text-xs text-ink-400">
                  Still staging — finish mapping and validation from the New import tab before
                  committing.
                </span>
              ) : null}
              {run.status === "validated" && run.stagedCount === 0 ? (
                <span className="text-xs text-red-700">
                  Validation left no clean rows — there is nothing to commit.
                </span>
              ) : null}
            </div>

            {run.status === "validated" && run.rejectedCount > 0 ? (
              <Caveat>
                {fmtInt(run.rejectedCount)} of {fmtInt(run.totalRows)} rows failed validation and
                will NOT be committed. They remain below with their reasons; fix the source data
                and import again, or commit only the clean rows.
              </Caveat>
            ) : null}

            {run.status === "committed" ? (
              <Caveat>
                Committed {formatDateTime(run.committedAt)}: {fmtInt(run.committedCount)} records
                created{run.rejectedCount > 0 ? `, ${fmtInt(run.rejectedCount)} rejected rows left behind` : ""}
                {run.skippedCount > 0 ? `, ${fmtInt(run.skippedCount)} skipped` : ""}. The commit was
                ledgered once with the retained file hash and these counts.
              </Caveat>
            ) : null}

            {/* Validation report */}
            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink-900">Validation report</h3>
              <ReportTable report={run.report ?? []} rejectedCount={run.rejectedCount} />
            </div>

            {/* Staged records */}
            <div>
              <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink-900">Staged records</h3>
                <Select
                  value={recordStatusFilter}
                  onChange={(e) => {
                    setRecordStatusFilter(e.target.value);
                    setRecordsPage(1);
                  }}
                  className="w-40"
                  aria-label="Record status filter"
                >
                  <option value="">All statuses</option>
                  {STAGED_RECORD_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {RECORD_STATUS_LABELS[s] ?? humanize(s)}
                    </option>
                  ))}
                </Select>
              </div>
              <ErrorAlert message={recordsError} />
              {records === null ? (
                <Spinner label="Loading records…" />
              ) : records.length === 0 ? (
                <p className="text-xs text-ink-400">
                  {recordStatusFilter
                    ? `No ${RECORD_STATUS_LABELS[recordStatusFilter]?.toLowerCase() ?? recordStatusFilter} records on this run.`
                    : "No staged records on this run — map columns first (New import tab), or the run was discarded before staging."}
                </p>
              ) : (
                <>
                  <div className="max-h-96 overflow-auto rounded-md ring-1 ring-ink-100">
                    <table className="min-w-full divide-y divide-ink-100 text-xs">
                      <thead className="sticky top-0 bg-ink-50">
                        <tr>
                          <th className="px-3 py-1.5 text-left font-semibold uppercase tracking-wide text-ink-500">#</th>
                          <th className="px-3 py-1.5 text-left font-semibold uppercase tracking-wide text-ink-500">Status</th>
                          <th className="px-3 py-1.5 text-left font-semibold uppercase tracking-wide text-ink-500">External ID</th>
                          <th className="px-3 py-1.5 text-left font-semibold uppercase tracking-wide text-ink-500">Payload</th>
                          <th className="px-3 py-1.5 text-left font-semibold uppercase tracking-wide text-ink-500">Reason / committed as</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-ink-50 bg-white">
                        {records.map((rec) => (
                          <tr key={rec.id}>
                            <td className="px-3 py-1.5 tabular-nums text-ink-800">{rec.rowNumber}</td>
                            <td className="px-3 py-1.5">
                              <Badge tone={recordTone(rec.status)}>
                                {RECORD_STATUS_LABELS[rec.status] ?? humanize(rec.status)}
                              </Badge>
                            </td>
                            <td className="px-3 py-1.5 font-mono text-[11px] text-ink-600">
                              {rec.externalId ?? "—"}
                            </td>
                            <td className="px-3 py-1.5">
                              <PayloadCell payload={rec.payload} />
                            </td>
                            <td className="px-3 py-1.5">
                              {rec.status === "rejected" || rec.status === "skipped" ? (
                                <span className={rec.status === "rejected" ? "text-red-700" : "text-ink-600"}>
                                  {rec.reason ?? "(no reason recorded)"}
                                </span>
                              ) : rec.committedRecordId ? (
                                <span className="font-mono text-[11px] text-emerald-700" title="ID of the real record created at commit">
                                  {rec.committedRecordId}
                                </span>
                              ) : (
                                <span className="text-ink-300">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs text-ink-500">
                    <span>
                      {fmtInt(recordsTotal)} record{recordsTotal === 1 ? "" : "s"} · page {recordsPage} of {recordsPages}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={recordsPage <= 1}
                        onClick={() => setRecordsPage((p) => p - 1)}
                      >
                        Previous
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={recordsPage >= recordsPages}
                        onClick={() => setRecordsPage((p) => p + 1)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        ) : null}
      </Drawer>

      {/* ------------------------- commit confirmation ------------------------ */}
      <Modal open={confirmCommit} title="Commit this run?" onClose={() => setConfirmCommit(false)}>
        {run ? (
          <div className="space-y-3 text-sm text-ink-700">
            <p>
              This creates <span className="font-semibold">{fmtInt(run.stagedCount)}</span> real{" "}
              {datasetLabel(run.dataset).toLowerCase()} records
              {run.projectId ? <> in {projectName(run.projectId)}</> : null}. The commit is
              transactional and ledgered once with the retained file hash and the final counts.
            </p>
            {run.rejectedCount > 0 ? (
              <Caveat>
                {fmtInt(run.rejectedCount)} rejected rows are NOT included. They stay on the run
                with their reasons.
              </Caveat>
            ) : null}
            <p className="text-xs text-ink-400">
              Committed records cannot be un-committed from here — they become ordinary records in
              their target module, each carrying provenance back to this run.
            </p>
            <ErrorAlert message={actionError} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirmCommit(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void onCommit()} disabled={busy}>
                {busy ? "Committing…" : `Commit ${fmtInt(run.stagedCount)} rows`}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
