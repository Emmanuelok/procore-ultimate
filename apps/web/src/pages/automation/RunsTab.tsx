/**
 * Run log: every evaluation of every rule, with the condition evaluations
 * (expected / actual / result per leaf) and per-action outcomes, and a retry
 * for failed, throttled or queued runs. `DryRunPanel` is shared with the
 * builder and the rule detail drawer because a dry run's result is the same
 * shape as a run's — the "why" must read the same everywhere.
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
  DescriptionList,
  Drawer,
  ErrorAlert,
  Field,
  Input,
  Select,
  StatusPill,
  type DescriptionItem,
} from "../../ui";
import { DataTable, Pagination, formatRelativeTime, type DataColumns } from "../../ui/data";
import { IconRefresh } from "../../ui/icons";
import {
  OUTCOME_TONE,
  RUN_STATUSES,
  RUN_STATUS_TONE,
  actionLabel,
  asList,
  errorMessage,
  errorStatus,
  formatDateTime,
  formatValue,
  humanize,
  msDuration,
  num,
  operatorLabel,
  type ConditionResult,
  type DryRunResult,
  type RunView,
  type Scope,
} from "./automationShared";

const PAGE_SIZE = 50;

export default function RunsTab({
  scope,
  isAdmin,
  ruleId,
  onClearRule,
  onChanged,
}: {
  scope: Scope;
  isAdmin: boolean;
  ruleId: string | null;
  onClearRule: () => void;
  onChanged: () => void;
}) {
  const [runs, setRuns] = useState<RunView[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [status, setStatus] = useState("");
  const [objectType, setObjectType] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (status) params.set("status", status);
      if (objectType.trim()) params.set("objectType", objectType.trim());
      if (ruleId) params.set("ruleId", ruleId);
      const res = await api.get<unknown>(`${scope.base}/runs?${params.toString()}`);
      const list = asList<RunView>(res);
      setRuns(list.items);
      setTotal(list.total);
      setForbidden(false);
    } catch (err) {
      setForbidden(errorStatus(err) === 403);
      setError(errorMessage(err, "Failed to load runs"));
      setRuns((prev) => prev ?? []);
    } finally {
      setLoading(false);
    }
  }, [scope.base, page, status, objectType, ruleId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [status, objectType, ruleId]);

  const columns = useMemo<DataColumns<RunView>>(
    () => [
      {
        id: "createdAt",
        header: "When",
        accessor: "createdAt",
        type: "datetime",
        width: 150,
        cell: ({ row }) => (
          <span title={formatDateTime(row.createdAt)} className="text-content-muted">
            {formatRelativeTime(row.createdAt)}
          </span>
        ),
      },
      { id: "ruleName", header: "Rule", accessor: "ruleName", type: "text", width: 240 },
      {
        id: "trigger",
        header: "Trigger",
        accessor: (row) => (row.triggerKind === "schedule" ? "scan" : `${row.action} ${row.objectType}`),
        type: "text",
        width: 160,
        cell: ({ row }) => (
          <span className="text-xs">
            <Badge tone={row.triggerKind === "schedule" ? "accent" : "info"} size="xs">
              {row.triggerKind === "schedule" ? "scan" : row.action}
            </Badge>{" "}
            <span className="text-content-muted">{row.objectType}</span>
          </span>
        ),
      },
      { id: "objectId", header: "Record", accessor: "objectId", type: "code", width: 220, mono: true },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 110,
        cell: ({ row }) => <StatusPill status={row.status} tone={RUN_STATUS_TONE[row.status]} size="xs" />,
      },
      {
        id: "outcome",
        header: "Outcome",
        accessor: (row) =>
          row.status === "skipped"
            ? (row.conditionResult?.reason ?? "conditions did not match")
            : row.actionResults.map((a) => `${actionLabel(a.type)}: ${a.outcome}`).join("; "),
        type: "text",
        width: 320,
        cell: ({ row }) =>
          row.status === "skipped" ? (
            <span className="text-2xs text-content-subtle">{row.conditionResult?.reason ?? row.error ?? "did not match"}</span>
          ) : row.actionResults.length === 0 ? (
            <span className="text-2xs text-content-subtle">{row.error ?? "—"}</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {row.actionResults.map((a) => (
                <Badge key={a.index} tone={OUTCOME_TONE[a.outcome]} size="xs">
                  {actionLabel(a.type)}
                </Badge>
              ))}
            </div>
          ),
      },
      { id: "depth", header: "Depth", accessor: "depth", type: "number", align: "right", width: 70 },
      { id: "attempts", header: "Attempts", accessor: "attempts", type: "number", align: "right", width: 90 },
    ],
    [],
  );

  const selected = runs?.find((r) => r.id === selectedId) ?? null;

  if (forbidden) {
    return <Alert tone="warning">The API refused the run log for your role ({error}).</Alert>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Status" className="w-44">
          <Select size="sm" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            {RUN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Record type" className="w-44">
          <Input size="sm" value={objectType} onChange={(e) => setObjectType(e.target.value)} placeholder="rfi, invoice…" />
        </Field>
        {ruleId ? (
          <Badge tone="info" size="sm" onRemove={onClearRule} removeLabel="Clear rule filter">
            Rule {ruleId}
          </Badge>
        ) : null}
        <Button size="sm" variant="secondary" leadingIcon={IconRefresh} onClick={() => void load()}>
          Refresh
        </Button>
        <span className="ml-auto text-2xs text-content-subtle">{num(total)} run{total === 1 ? "" : "s"}</span>
      </div>

      {error ? <ErrorAlert message={error} onRetry={() => void load()} /> : null}

      <DataTable<RunView>
        tableId={scope.isProject ? "automation-runs-project" : "automation-runs"}
        data={runs ?? []}
        columns={columns}
        loading={loading && !runs}
        height={520}
        stickyHeader
        onRowClick={({ row }) => setSelectedId(row.id)}
        rowTone={(row) => (row.status === "failed" ? "danger" : row.status === "throttled" ? "warning" : undefined)}
        empty={{
          title: "No runs yet",
          description: ruleId
            ? "This rule has not been evaluated. Activate it, or trigger its event, or run a cycle from the Engine tab."
            : "Runs appear here as active rules are evaluated against ledger events and schedule scans.",
        }}
        aria-label="Automation runs"
      />
      {total > PAGE_SIZE ? (
        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} size="sm" itemNoun="runs" />
      ) : null}

      <RunDetailDrawer
        run={selected}
        scope={scope}
        isAdmin={isAdmin}
        onClose={() => setSelectedId(null)}
        onChanged={() => {
          void load();
          onChanged();
        }}
      />
    </div>
  );
}

/* ============================ Shared panels ============================== */

export function ConditionTable({ result }: { result: ConditionResult }) {
  if (!result.evaluations) return <p className="text-xs text-content-muted">{result.reason}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-2xs uppercase text-content-subtle">
            <th className="py-1 pr-2">Field</th>
            <th className="py-1 pr-2">Operator</th>
            <th className="py-1 pr-2">Expected</th>
            <th className="py-1 pr-2">Actual</th>
            <th className="py-1">Result</th>
          </tr>
        </thead>
        <tbody>
          {result.evaluations.map((e, i) => (
            <tr key={i} className="border-t border-border-subtle">
              <td className="py-1 pr-2 font-mono">{e.field}</td>
              <td className="py-1 pr-2">{operatorLabel(e.op)}</td>
              <td className="py-1 pr-2 font-mono">{formatValue(e.expected)}</td>
              <td className="py-1 pr-2 font-mono">{formatValue(e.actual)}</td>
              <td className="py-1">
                <Badge tone={e.result ? "success" : "danger"} size="xs">
                  {e.result ? "true" : "false"}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-2xs text-content-subtle">{result.reason}</p>
    </div>
  );
}

export function DryRunPanel({ result }: { result: DryRunResult }) {
  return (
    <div className="space-y-3 rounded-md border border-border-subtle p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={result.matched ? "success" : "neutral"} size="sm" dot>
          {result.matched ? "Would fire" : "Would not fire"}
        </Badge>
        <span className="text-2xs text-content-subtle">
          record: {result.context.recordSource === "loaded" ? "loaded from the platform" : result.context.recordSource === "sample" ? "your sample" : "none"}
          {Object.keys(result.context.derived).length > 0 ? ` · derived: ${JSON.stringify(result.context.derived)}` : ""}
        </span>
      </div>
      {result.warnings.map((w) => (
        <Alert key={w} tone="warning" size="sm">
          {w}
        </Alert>
      ))}
      <div>
        <div className="text-label uppercase text-content-subtle">Conditions</div>
        <ConditionTable result={result.conditionResult} />
      </div>
      <div>
        <div className="text-label uppercase text-content-subtle">Planned actions</div>
        <ol className="mt-1 space-y-1 text-xs">
          {result.plannedActions.map((a) => (
            <li key={a.index} className="flex items-start gap-2">
              <Badge tone={a.wouldRun ? "info" : "neutral"} size="xs">
                {a.wouldRun ? "would run" : "skipped"}
              </Badge>
              <span>{a.description}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/* ================================ Detail ================================= */

function RunDetailDrawer({
  run,
  scope,
  isAdmin,
  onClose,
  onChanged,
}: {
  run: RunView | null;
  scope: Scope;
  isAdmin: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!run) return null;
  const retryable = ["failed", "throttled", "queued"].includes(run.status);
  const canRetry = isAdmin && !scope.isProject;

  async function retry() {
    if (!run) return;
    setBusy(true);
    try {
      const res = await api.post<RunView>(`/api/v1/automation/runs/${run.id}/retry`);
      toast.success(`Run re-executed: ${humanize(res.status)}`);
      onChanged();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, "Retry failed"));
    } finally {
      setBusy(false);
    }
  }

  const items: DescriptionItem[] = [
    { label: "Status", value: <StatusPill status={run.status} tone={RUN_STATUS_TONE[run.status]} size="xs" /> },
    { label: "Rule", value: run.ruleName, hint: run.ruleId },
    { label: "Trigger", value: run.triggerKind === "schedule" ? "Schedule scan" : `Ledger event: ${run.action}${run.eventSeq !== null ? ` (seq ${run.eventSeq})` : ""}` },
    { label: "Record", value: `${run.objectType} / ${run.objectId}`, copyValue: run.objectId },
    { label: "Project", value: run.projectId ?? "Company-level" },
    { label: "Actor", value: run.actorId ?? "System / schedule", hint: "Who caused the triggering event" },
    { label: "Queued", value: formatDateTime(run.queuedAt) },
    { label: "Started", value: formatDateTime(run.startedAt) },
    { label: "Finished", value: formatDateTime(run.finishedAt) },
    { label: "Attempts", value: String(run.attempts) },
    { label: "Chain depth", value: String(run.depth), hint: run.causedByRunId ? `Caused by run ${run.causedByRunId}` : "Fired directly by a user or system event" },
    { label: "Record snapshot", value: run.context?.recordKnown ? "Loaded" : "Not available (type outside the registry)", tone: run.context?.recordKnown ? undefined : "warning" },
  ];

  return (
    <Drawer
      open={run !== null}
      onClose={onClose}
      size="xl"
      title={`Run ${run.id}`}
      description={run.dryRun ? "Dry run — nothing was executed" : undefined}
      headerActions={
        retryable ? (
          <Button size="xs" loading={busy} disabled={!canRetry} title={canRetry ? undefined : "Retry is a company owner/admin action"} onClick={() => void retry()}>
            Retry
          </Button>
        ) : null
      }
    >
      <div className="space-y-4">
        {run.error ? (
          <Alert tone={run.status === "failed" ? "danger" : "warning"} size="sm" title={run.status === "failed" ? "Failure" : "Note"}>
            {run.error}
          </Alert>
        ) : null}
        <DescriptionList items={items} columns={2} size="sm" />

        <Card>
          <CardBody>
            <div className="text-label uppercase text-content-subtle">Condition evaluations</div>
            {run.conditionResult ? (
              <ConditionTable result={run.conditionResult} />
            ) : (
              <p className="text-xs text-content-subtle">Not evaluated yet — the run is still queued.</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className="text-label uppercase text-content-subtle">Action results</div>
            {run.actionResults.length === 0 ? (
              <p className="text-xs text-content-subtle">No actions executed.</p>
            ) : (
              <ul className="mt-1 space-y-2">
                {run.actionResults.map((a) => (
                  <li key={a.index} className="rounded-md border border-border-subtle p-2 text-xs">
                    <div className="flex items-center gap-2">
                      <Badge tone={OUTCOME_TONE[a.outcome]} size="xs">
                        {a.outcome}
                      </Badge>
                      <span className="font-medium">{actionLabel(a.type)}</span>
                      <span className="ml-auto text-content-subtle">{msDuration(a.durationMs)}</span>
                    </div>
                    {a.error ? <div className="mt-1 text-danger-fg">{a.error}</div> : null}
                    {Object.keys(a.detail).length > 0 ? (
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-2xs text-content-muted">{JSON.stringify(a.detail, null, 2)}</pre>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {run.context?.record ? (
          <Card>
            <CardBody>
              <div className="text-label uppercase text-content-subtle">Record as evaluated</div>
              <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-2xs text-content-muted">{JSON.stringify(run.context.record, null, 2)}</pre>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </Drawer>
  );
}
