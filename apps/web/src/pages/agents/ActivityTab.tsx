/**
 * Runs and actions — the transparency surface (Vol I #774, Vol II X #1021,
 * #1023, #1026).
 *
 * The runs table carries METADATA only. Prompts and model output live behind
 * the per-run detail route, which is gated by the run's own project: a list
 * that shipped 20,000 characters of drawing OCR per row to anyone in the
 * company was both a data leak and a megabyte of payload for five columns.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Drawer,
  ErrorAlert,
  Field,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { DataTable, Pagination, type DataColumns } from "../../ui/data";
import { IconActivity, IconUndo } from "../../ui/icons";
import {
  ACTION_STATUS_TONE,
  asList,
  errorMessage,
  errorStatus,
  formatDateTime,
  humanize,
  num,
  pct,
  RUN_STATUS_TONE,
  type AgentAction,
  type AgentDescriptor,
  type RunDetail,
  type RunSummary,
} from "./agentsShared";

const PAGE_SIZE = 50;

export default function ActivityTab({
  agents,
  onChanged,
}: {
  agents: AgentDescriptor[] | null;
  onChanged: () => void;
}) {
  const [view, setView] = useState<"runs" | "actions">("runs");
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Button size="sm" variant={view === "runs" ? "primary" : "secondary"} onClick={() => setView("runs")}>
          Runs
        </Button>
        <Button size="sm" variant={view === "actions" ? "primary" : "secondary"} onClick={() => setView("actions")}>
          Applied actions
        </Button>
      </div>
      {view === "runs" ? <RunsPanel agents={agents} /> : <ActionsPanel onChanged={onChanged} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Runs                                                                */
/* ------------------------------------------------------------------ */

function RunsPanel({ agents }: { agents: AgentDescriptor[] | null }) {
  const [rows, setRows] = useState<RunSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (kind) params.set("agentKind", kind);
      if (status) params.set("status", status);
      const res = await api.get<unknown>(`/api/v1/agents/runs?${params.toString()}`);
      const list = asList<RunSummary>(res);
      setRows(list.items);
      setTotal(list.total);
    } catch (err) {
      setError(errorMessage(err, "Failed to load runs"));
      setRows((prev) => prev ?? []);
    } finally {
      setLoading(false);
    }
  }, [page, kind, status]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setPage(1);
  }, [kind, status]);

  const columns = useMemo<DataColumns<RunSummary>>(
    () => [
      {
        id: "createdAt",
        header: "When",
        accessor: "createdAt",
        width: 160,
        cell: ({ row }) => <span className="text-ink-600">{formatDateTime(row.createdAt)}</span>,
      },
      { id: "agentKind", header: "Agent", accessor: "agentKind", width: 200 },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        width: 110,
        cell: ({ row }) => (
          <Badge tone={RUN_STATUS_TONE[row.status] ?? "neutral"}>{humanize(row.status)}</Badge>
        ),
      },
      {
        id: "source",
        header: "Asked by",
        accessor: "source",
        width: 110,
        cell: ({ row }) => <span className="text-xs">{humanize(row.source ?? null)}</span>,
      },
      {
        id: "evidence",
        header: "Evidence",
        accessor: "evidenceScore",
        width: 100,
        cell: ({ row }) => <span className="tabular-nums">{pct(row.evidenceScore ?? null)}</span>,
      },
      {
        id: "grounding",
        header: "Cited / supplied",
        width: 130,
        cell: ({ row }) => (
          <span className="tabular-nums text-xs">
            {num(row.citationCount)} / {num(row.inputRefCount)}
            {row.droppedCitations ? (
              <Badge tone="danger" className="ml-1">
                {row.droppedCitations} dropped
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: "tokens",
        header: "Tokens in/out",
        width: 130,
        cell: ({ row }) => (
          <span className="tabular-nums text-xs">
            {num(row.inputTokens)} / {num(row.outputTokens)}
          </span>
        ),
      },
      {
        id: "latency",
        header: "Latency",
        accessor: "latencyMs",
        width: 100,
        cell: ({ row }) => (
          <span className="tabular-nums text-xs">
            {row.latencyMs === null ? "—" : `${num(row.latencyMs)} ms`}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Agent" className="w-56">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All agents</option>
            {(agents ?? []).map((a) => (
              <option key={a.kind} value={a.kind}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status" className="w-40">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All outcomes</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="refused">Refused</option>
          </Select>
        </Field>
      </div>
      <ErrorAlert message={error} />
      <DataTable<RunSummary>
        tableId="agent-runs"
        data={rows ?? []}
        columns={columns}
        loading={loading && !rows}
        height={520}
        stickyHeader
        onRowClick={({ row }) => setOpenId(row.id)}
        rowTone={(row) => (row.status === "failed" ? "danger" : row.status === "refused" ? "warning" : undefined)}
        empty={{
          title: "No AI runs recorded",
          description:
            "Every model invocation is recorded here — succeeded, failed or refused — with the records it was given.",
        }}
        aria-label="AI runs"
      />
      {total > PAGE_SIZE ? (
        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} size="sm" itemNoun="runs" />
      ) : null}
      <RunDetailDrawer runId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

export function RunDetailDrawer({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    if (!runId) return;
    setLoading(true);
    api
      .get<RunDetail>(`/api/v1/ai/runs/${runId}`)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          errorStatus(err) === 403
            ? "This run belongs to a project you do not have AI access to."
            : errorMessage(err, "Failed to load the run"),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  return (
    <Drawer
      open={runId !== null}
      onClose={onClose}
      size="xl"
      icon={IconActivity}
      title={detail ? detail.run.agentKind : "Run"}
      description={runId ?? undefined}
    >
      {loading && !detail ? <Spinner /> : null}
      <ErrorAlert message={error} />
      {detail ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Badge tone={RUN_STATUS_TONE[detail.run.status] ?? "neutral"}>
              {humanize(detail.run.status)}
            </Badge>
            <Badge tone="neutral">{detail.run.model}</Badge>
            {detail.provenance ? (
              <>
                <Badge tone="neutral">prompt {detail.provenance.promptVersion}</Badge>
                <Badge tone="neutral">evidence {pct(detail.provenance.evidenceScore)}</Badge>
                {detail.provenance.droppedCitations > 0 ? (
                  <Badge tone="danger">
                    {detail.provenance.droppedCitations} invented citation(s) dropped
                  </Badge>
                ) : null}
              </>
            ) : null}
          </div>

          {detail.run.error ? (
            <Alert tone="danger" title="This run did not succeed">
              {detail.run.error}
            </Alert>
          ) : null}

          <Card>
            <CardBody className="space-y-1 text-xs">
              <div className="text-sm font-semibold text-ink-900">Records supplied to the model</div>
              {detail.run.inputRefs.length === 0 ? (
                <p className="text-ink-500">None recorded.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {detail.run.inputRefs.map((r, i) => (
                    <span
                      key={`${r.type}:${r.id}:${i}`}
                      className="rounded-full bg-ink-100 px-2 py-0.5 font-mono text-[11px] text-ink-700"
                    >
                      {r.type} · {r.id.slice(-8)}
                    </span>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody className="space-y-1">
              <div className="text-sm font-semibold text-ink-900">Prompt</div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-ink-50 p-2 text-[11px] text-ink-700">
                {detail.run.prompt ?? "(not recorded)"}
              </pre>
            </CardBody>
          </Card>

          <Card>
            <CardBody className="space-y-1">
              <div className="text-sm font-semibold text-ink-900">Model output</div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-ink-50 p-2 text-[11px] text-ink-700">
                {detail.run.output ?? "(none)"}
              </pre>
            </CardBody>
          </Card>

          {detail.reviews.length > 0 ? (
            <Card>
              <CardBody>
                <div className="mb-1 text-sm font-semibold text-ink-900">Proposals from this run</div>
                <Table>
                  <thead>
                    <tr>
                      <Th>Target</Th>
                      <Th>Status</Th>
                      <Th>Summary</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.reviews.map((r) => (
                      <tr key={r.id}>
                        <Td className="text-xs">{humanize(r.targetType)}</Td>
                        <Td className="text-xs">{humanize(r.status)}</Td>
                        <Td className="text-xs">{r.summary}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </CardBody>
            </Card>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function ActionsPanel({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<AgentAction[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<AgentAction | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (status) params.set("status", status);
      const res = await api.get<unknown>(`/api/v1/agents/actions?${params.toString()}`);
      const list = asList<AgentAction>(res);
      setRows(list.items);
      setTotal(list.total);
    } catch (err) {
      setError(errorMessage(err, "Failed to load agent actions"));
      setRows((prev) => prev ?? []);
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function rollback() {
    if (!selected) return;
    setBusy(true);
    try {
      await api.post(`/api/v1/agents/actions/${selected.id}/rollback`, { reason });
      toast.success("Change rolled back and the record restored");
      setSelected(null);
      setReason("");
      onChanged();
      await load();
    } catch (err) {
      setError(errorMessage(err, "Rollback failed"));
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo<DataColumns<AgentAction>>(
    () => [
      {
        id: "appliedAt",
        header: "Applied",
        accessor: "appliedAt",
        width: 160,
        cell: ({ row }) => <span className="text-ink-600">{formatDateTime(row.appliedAt)}</span>,
      },
      { id: "agentKind", header: "Agent", accessor: "agentKind", width: 180 },
      {
        id: "actionType",
        header: "Action",
        accessor: "actionType",
        width: 160,
        cell: ({ row }) => humanize(row.actionType),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        width: 130,
        cell: ({ row }) => (
          <Badge tone={ACTION_STATUS_TONE[row.status] ?? "neutral"}>{humanize(row.status)}</Badge>
        ),
      },
      {
        id: "authorisation",
        header: "Authorised by",
        accessor: "authorisation",
        width: 150,
        cell: ({ row }) => humanize(row.authorisation),
      },
      { id: "summary", header: "Summary", accessor: "summary", width: 320 },
    ],
    [],
  );

  return (
    <div className="space-y-2">
      <Field label="Status" className="w-48">
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All actions</option>
          <option value="applied">Applied</option>
          <option value="rolled_back">Rolled back</option>
          <option value="not_reversible">Not reversible</option>
        </Select>
      </Field>
      <ErrorAlert message={error} />
      <DataTable<AgentAction>
        tableId="agent-actions"
        data={rows ?? []}
        columns={columns}
        loading={loading && !rows}
        height={520}
        stickyHeader
        onRowClick={({ row }) => {
          setSelected(row);
          setReason("");
        }}
        empty={{
          title: "No agent has changed a record yet",
          description:
            "Every applied proposal is recorded here with the before-image that makes it reversible.",
        }}
        aria-label="Agent actions"
      />
      {total > PAGE_SIZE ? (
        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} size="sm" itemNoun="actions" />
      ) : null}

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        size="lg"
        icon={IconUndo}
        title={selected ? humanize(selected.actionType) : "Action"}
        description={selected?.summary ?? undefined}
      >
        {selected ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Badge tone={ACTION_STATUS_TONE[selected.status] ?? "neutral"}>
                {humanize(selected.status)}
              </Badge>
              <Badge tone="neutral">{selected.agentKind}</Badge>
              <Badge tone="neutral">confidence {pct(selected.confidence)}</Badge>
            </div>

            <Card>
              <CardBody>
                <div className="mb-1 text-sm font-semibold text-ink-900">Before / after</div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <div>
                    <div className="text-xs text-ink-400">Before</div>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-ink-50 p-2 text-[11px]">
                      {JSON.stringify(selected.beforeImage, null, 2) ?? "null"}
                    </pre>
                  </div>
                  <div>
                    <div className="text-xs text-ink-400">After</div>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-ink-50 p-2 text-[11px]">
                      {JSON.stringify(selected.afterImage, null, 2) ?? "null"}
                    </pre>
                  </div>
                </div>
              </CardBody>
            </Card>

            {selected.reversible === 0 ? (
              <Alert tone="info" title="Nothing to roll back">
                {selected.irreversibleReason ?? "This action changed no operational record."}
              </Alert>
            ) : selected.status === "rolled_back" ? (
              <Alert tone="warning" title="Already rolled back">
                {formatDateTime(selected.rolledBackAt)}
                {selected.rollbackReason ? ` — ${selected.rollbackReason}` : ""}
              </Alert>
            ) : (
              <div className="space-y-2">
                <Field label="Reason" hint="Written to the ledger with the reversal.">
                  <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
                <Button variant="danger" leadingIcon={IconUndo} loading={busy} onClick={() => void rollback()}>
                  Roll back and restore the before-image
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
