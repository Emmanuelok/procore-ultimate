/**
 * Rules register: filters, the grid, and a detail drawer with lifecycle
 * controls and a dry-run panel against a real record.
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
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Select,
  StatusPill,
  Textarea,
  useConfirm,
  type DescriptionItem,
} from "../../ui";
import { DataTable, formatRelativeTime, type DataColumns } from "../../ui/data";
import { IconPlay, IconRefresh, IconSearch, IconZap } from "../../ui/icons";
import {
  RULE_STATUSES,
  RULE_STATUS_TONE,
  actionLabel,
  asList,
  countLeaves,
  describeAction,
  describeCondition,
  describeTrigger,
  errorMessage,
  errorStatus,
  formatDateTime,
  humanize,
  num,
  type Catalogue,
  type DryRunResult,
  type RuleView,
  type RunView,
  type Scope,
} from "./automationShared";
import { DryRunPanel } from "./RunsTab";

export default function RulesTab({
  scope,
  isAdmin,
  catalogue,
  nonce,
  onEdit,
  onCreate,
  onBrowseTemplates,
  onShowRuns,
  onChanged,
}: {
  scope: Scope;
  isAdmin: boolean;
  catalogue: Catalogue | null;
  nonce: number;
  onEdit: (rule: RuleView) => void;
  onCreate: () => void;
  onBrowseTemplates: () => void;
  onShowRuns: (ruleId: string) => void;
  onChanged: () => void;
}) {
  const [rules, setRules] = useState<RuleView[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [triggerKind, setTriggerKind] = useState<string>("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: "1", pageSize: "200" });
      if (status) params.set("status", status);
      if (triggerKind) params.set("triggerKind", triggerKind);
      if (search.trim()) params.set("search", search.trim());
      const res = await api.get<unknown>(`${scope.base}/rules?${params.toString()}`);
      const list = asList<RuleView>(res);
      setRules(list.items);
      setTotal(list.total);
      setForbidden(false);
    } catch (err) {
      setForbidden(errorStatus(err) === 403);
      setError(errorMessage(err, "Failed to load rules"));
      setRules((prev) => prev ?? []);
    } finally {
      setLoading(false);
    }
  }, [scope.base, status, triggerKind, search]);

  useEffect(() => {
    void load();
  }, [load, nonce]);

  const columns = useMemo<DataColumns<RuleView>>(
    () => [
      {
        id: "name",
        header: "Rule",
        accessor: "name",
        type: "text",
        width: 280,
        sticky: "start",
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="truncate font-medium text-content">{row.name}</div>
            {row.templateKey ? <div className="truncate text-2xs text-content-subtle">from template {row.templateKey}</div> : null}
          </div>
        ),
      },
      {
        id: "scope",
        header: "Scope",
        accessor: "scope",
        type: "text",
        width: 100,
        cell: ({ row }) => (
          <Badge tone={row.scope === "project" ? "info" : "neutral"} size="xs">
            {row.scope === "project" ? "Project" : "Company"}
          </Badge>
        ),
      },
      {
        id: "trigger",
        header: "Trigger",
        accessor: (row) => describeTrigger(row.trigger),
        type: "text",
        width: 300,
      },
      {
        id: "conditions",
        header: "Conditions",
        accessor: (row) => countLeaves(row.conditions),
        type: "number",
        align: "right",
        width: 110,
        cell: ({ row }) => {
          const n = countLeaves(row.conditions);
          return n === 0 ? <span className="text-content-subtle">none</span> : <span className="tabular-nums">{n}</span>;
        },
      },
      {
        id: "actions",
        header: "Actions",
        accessor: (row) => row.actions.map((a) => actionLabel(a.type)).join(", "),
        type: "text",
        width: 260,
        truncate: false,
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.actions.map((a, i) => (
              <Badge key={`${a.type}-${i}`} tone="neutral" size="xs">
                {actionLabel(a.type)}
              </Badge>
            ))}
          </div>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 110,
        cell: ({ row }) => <StatusPill status={row.status} tone={RULE_STATUS_TONE[row.status]} size="xs" />,
      },
      { id: "immediate", header: "Mode", accessor: (row) => (row.immediate ? "Immediate" : "Queued"), type: "text", width: 100 },
      { id: "runCount", header: "Runs", accessor: "runCount", type: "number", align: "right", width: 80 },
      {
        id: "failureCount",
        header: "Failures",
        accessor: "failureCount",
        type: "number",
        align: "right",
        width: 90,
        cell: ({ row }) => (
          <span className={row.failureCount > 0 ? "font-medium tabular-nums text-danger-fg" : "tabular-nums text-content-subtle"}>
            {row.failureCount}
          </span>
        ),
      },
      {
        id: "lastRunAt",
        header: "Last run",
        accessor: "lastRunAt",
        type: "datetime",
        width: 140,
        cell: ({ row }) => <span className="text-content-muted">{row.lastRunAt ? formatRelativeTime(row.lastRunAt) : "never"}</span>,
      },
      { id: "priority", header: "Priority", accessor: "priority", type: "number", align: "right", width: 90 },
    ],
    [],
  );

  const selected = rules?.find((r) => r.id === selectedId) ?? null;

  if (forbidden) {
    return (
      <Alert tone="warning">
        The API refused this list for your role ({error}). At project scope you need at least read access to the
        automation tool on this project.
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Search" className="w-56">
          <Input leading={IconSearch} placeholder="Rule name…" value={search} onChange={(e) => setSearch(e.target.value)} size="sm" />
        </Field>
        <Field label="Status" className="w-40">
          <Select size="sm" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Live (not archived)</option>
            {RULE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Trigger" className="w-40">
          <Select size="sm" value={triggerKind} onChange={(e) => setTriggerKind(e.target.value)}>
            <option value="">Any</option>
            <option value="event">Ledger event</option>
            <option value="schedule">Schedule scan</option>
          </Select>
        </Field>
        <Button size="sm" variant="secondary" leadingIcon={IconRefresh} onClick={() => void load()}>
          Refresh
        </Button>
        <span className="ml-auto text-2xs text-content-subtle">{num(total)} rule{total === 1 ? "" : "s"}</span>
      </div>

      {error && !forbidden ? <ErrorAlert message={error} onRetry={() => void load()} /> : null}

      {!loading && rules && rules.length === 0 && !error ? (
        <EmptyState
          icon={IconZap}
          title={search || status || triggerKind ? "No rules match these filters" : "No automation rules yet"}
          hint={
            search || status || triggerKind
              ? "Clear the filters to see every rule in this scope."
              : "Start from a template — overdue RFIs, expired insurance on a submitted invoice, critical signals, time bars — or build a rule from scratch."
          }
          action={
            <Button onClick={onBrowseTemplates} variant="secondary">
              Browse templates
            </Button>
          }
          secondaryAction={
            <Button onClick={onCreate} disabled={!isAdmin && !scope.isProject}>
              New rule
            </Button>
          }
        />
      ) : (
        <DataTable<RuleView>
          tableId={scope.isProject ? "automation-rules-project" : "automation-rules"}
          data={rules ?? []}
          columns={columns}
          loading={loading && !rules}
          height={520}
          stickyHeader
          onRowClick={({ row }) => setSelectedId(row.id)}
          defaultSort={[{ id: "priority", desc: false }]}
          rowTone={(row) => (row.failureCount > 0 && row.status === "active" ? "warning" : undefined)}
          empty={{ title: "No rules", description: "Nothing matches the current filters." }}
          aria-label="Automation rules"
        />
      )}

      <RuleDetailDrawer
        rule={selected}
        scope={scope}
        isAdmin={isAdmin}
        catalogue={catalogue}
        onClose={() => setSelectedId(null)}
        onEdit={(rule) => {
          setSelectedId(null);
          onEdit(rule);
        }}
        onShowRuns={(id) => {
          setSelectedId(null);
          onShowRuns(id);
        }}
        onChanged={() => {
          void load();
          onChanged();
        }}
      />
    </div>
  );
}

/* ============================== Detail ================================== */

function RuleDetailDrawer({
  rule,
  scope,
  isAdmin,
  catalogue,
  onClose,
  onEdit,
  onShowRuns,
  onChanged,
}: {
  rule: RuleView | null;
  scope: Scope;
  isAdmin: boolean;
  catalogue: Catalogue | null;
  onClose: () => void;
  onEdit: (rule: RuleView) => void;
  onShowRuns: (ruleId: string) => void;
  onChanged: () => void;
}) {
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [recent, setRecent] = useState<RunView[] | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [testObjectId, setTestObjectId] = useState("");
  const [testSample, setTestSample] = useState("");
  const [testResult, setTestResult] = useState<DryRunResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    setRecent(null);
    setRecentError(null);
    setTestResult(null);
    setTestError(null);
    setTestObjectId("");
    setTestSample("");
    if (!rule) return;
    let cancelled = false;
    api
      .get<{ rule: RuleView; recentRuns: RunView[] }>(`${scope.base}/rules/${rule.id}`)
      .then((res) => {
        if (!cancelled) setRecent(res.recentRuns);
      })
      .catch((err: unknown) => {
        if (!cancelled) setRecentError(errorMessage(err, "Failed to load recent runs"));
      });
    return () => {
      cancelled = true;
    };
  }, [rule, scope.base]);

  if (!rule) return null;

  /**
   * Company-wide rules are only editable at company scope by owners/admins;
   * project rules through the project route (tool level) or by owners/admins.
   * Every mutation goes through the current scope's base, so the API — not
   * the page — is what decides.
   */
  const editable = rule.scope === "company" ? isAdmin && !scope.isProject : scope.isProject || isAdmin;
  const mutationBase = scope.base;

  async function transition(kind: "activate" | "pause" | "archive") {
    if (!rule) return;
    if (kind === "archive") {
      const ok = await confirm({
        title: `Archive "${rule.name}"?`,
        description: "An archived rule stops firing and cannot be edited or reactivated. Its run history is kept.",
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(kind);
    try {
      if (kind === "archive") await api.del(`${mutationBase}/rules/${rule.id}`);
      else await api.post(`${mutationBase}/rules/${rule.id}/${kind}`);
      toast.success(kind === "archive" ? "Rule archived" : kind === "activate" ? "Rule activated" : "Rule paused");
      onChanged();
      if (kind === "archive") onClose();
    } catch (err) {
      toast.error(errorMessage(err, `Failed to ${kind} the rule`));
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    if (!rule) return;
    setTestError(null);
    setTestResult(null);
    let record: Record<string, unknown> | undefined;
    if (testSample.trim()) {
      try {
        const parsed = JSON.parse(testSample) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Sample must be a JSON object");
        record = parsed as Record<string, unknown>;
      } catch (err) {
        setTestError(errorMessage(err, "Sample is not valid JSON"));
        return;
      }
    }
    setBusy("test");
    try {
      const res = await api.post<DryRunResult>(`${scope.base}/rules/${rule.id}/test`, {
        ...(testObjectId.trim() ? { objectId: testObjectId.trim() } : {}),
        ...(record ? { record } : {}),
      });
      setTestResult(res);
    } catch (err) {
      setTestError(errorMessage(err, "Dry run failed"));
    } finally {
      setBusy(null);
    }
  }

  const entry = catalogue?.objectTypes.find((o) => o.objectType === rule.triggerObjectType);
  const items: DescriptionItem[] = [
    { label: "Status", value: <StatusPill status={rule.status} tone={RULE_STATUS_TONE[rule.status]} size="xs" /> },
    { label: "Scope", value: rule.scope === "project" ? `Project ${rule.projectId}` : "Company-wide" },
    { label: "Trigger", value: describeTrigger(rule.trigger), span: 2 },
    {
      label: "Record type",
      value: entry ? `${entry.label} (${rule.triggerObjectType})` : rule.triggerObjectType === "*" ? "Any" : `${rule.triggerObjectType} — not in the snapshot registry, event-only context`,
      span: 2,
    },
    { label: "Mode", value: rule.immediate ? "Immediate — executes on the ledger hook" : "Queued — executed by the drain job (every minute)" },
    { label: "Priority", value: String(rule.priority), hint: "Lower runs first when several rules match one event" },
    { label: "Runs", value: num(rule.runCount) },
    { label: "Failures", value: num(rule.failureCount), tone: rule.failureCount > 0 ? "danger" : undefined },
    { label: "Last run", value: formatDateTime(rule.lastRunAt) },
    { label: "Last scan", value: rule.triggerKind === "schedule" ? formatDateTime(rule.lastScanAt) : "—", hint: rule.triggerKind === "schedule" ? undefined : "Event rules do not scan" },
    { label: "Created", value: formatDateTime(rule.createdAt) },
    { label: "Updated", value: formatDateTime(rule.updatedAt) },
  ];

  return (
    <Drawer
      open={rule !== null}
      onClose={onClose}
      size="xl"
      title={rule.name}
      description={rule.description ?? undefined}
      headerActions={
        <div className="flex flex-wrap gap-1">
          <Button size="xs" variant="secondary" onClick={() => onShowRuns(rule.id)}>
            View runs
          </Button>
          <Button size="xs" variant="secondary" onClick={() => onEdit(rule)} disabled={!editable || rule.status === "archived"}>
            Edit
          </Button>
          {rule.status === "active" ? (
            <Button size="xs" variant="secondary" loading={busy === "pause"} disabled={!editable} onClick={() => void transition("pause")}>
              Pause
            </Button>
          ) : rule.status !== "archived" ? (
            <Button size="xs" loading={busy === "activate"} disabled={!editable} onClick={() => void transition("activate")}>
              Activate
            </Button>
          ) : null}
          {rule.status !== "archived" ? (
            <Button size="xs" variant="danger" loading={busy === "archive"} disabled={!editable} onClick={() => void transition("archive")}>
              Archive
            </Button>
          ) : null}
        </div>
      }
    >
      {dialog}
      <div className="space-y-4">
        {!editable ? (
          <Alert tone="info" size="sm">
            {rule.scope === "company"
              ? "Company-wide rules are managed by company owners and admins from the company Automation page."
              : "Editing this project rule needs admin access to the automation tool on the project."}
          </Alert>
        ) : null}
        {rule.lastError ? (
          <Alert tone="danger" size="sm" title="Last failure">
            {rule.lastError}
          </Alert>
        ) : null}

        <DescriptionList items={items} columns={2} size="sm" />

        <Card>
          <CardBody>
            <div className="text-label uppercase text-content-subtle">Conditions</div>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-content">{describeCondition(rule.conditions).join("\n")}</pre>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className="text-label uppercase text-content-subtle">Actions, in order</div>
            <ol className="mt-1 space-y-1 text-sm">
              {rule.actions.map((a, i) => (
                <li key={i} className="flex items-start gap-2">
                  <Badge tone="neutral" size="xs">
                    {i + 1}
                  </Badge>
                  <span>
                    <span className="font-medium">{actionLabel(a.type)}</span>
                    <span className="text-content-muted"> — {describeAction(a)}</span>
                  </span>
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="space-y-3">
            <div>
              <div className="text-label uppercase text-content-subtle">Dry run</div>
              <p className="mt-0.5 text-2xs text-content-subtle">
                Evaluate the conditions against a real record of type <span className="font-mono">{rule.triggerObjectType}</span> by id,
                or against a sample JSON object. Nothing is executed and nothing is ledgered.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Record id" hint={scope.isProject ? "Must belong to this project" : undefined}>
                <Input size="sm" value={testObjectId} onChange={(e) => setTestObjectId(e.target.value)} placeholder={`${rule.triggerObjectType}_…`} className="font-mono" />
              </Field>
              <Field label="Sample record (JSON)" hint="Used when no record id is given">
                <Textarea rows={3} value={testSample} onChange={(e) => setTestSample(e.target.value)} placeholder='{"status":"open","dueDate":"2026-01-01"}' className="font-mono text-xs" />
              </Field>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" leadingIcon={IconPlay} loading={busy === "test"} onClick={() => void runTest()}>
                Run dry run
              </Button>
              {testError ? <span className="text-xs text-danger-fg">{testError}</span> : null}
            </div>
            {testResult ? <DryRunPanel result={testResult} /> : null}
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className="mb-1 flex items-center justify-between">
              <div className="text-label uppercase text-content-subtle">Recent runs</div>
              <Button size="xs" variant="ghost" onClick={() => onShowRuns(rule.id)}>
                Open the run log
              </Button>
            </div>
            {recentError ? <ErrorAlert message={recentError} /> : null}
            {recent === null && !recentError ? <div className="text-xs text-content-subtle">Loading…</div> : null}
            {recent && recent.length === 0 ? <div className="text-xs text-content-subtle">This rule has not run yet.</div> : null}
            {recent && recent.length > 0 ? (
              <ul className="divide-y divide-border-subtle text-xs">
                {recent.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 py-1.5">
                    <StatusPill status={r.status} size="xs" />
                    <span className="font-mono text-content-muted">
                      {r.objectType}/{r.objectId}
                    </span>
                    <span className="ml-auto text-content-subtle">{formatRelativeTime(r.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </CardBody>
        </Card>
      </div>
    </Drawer>
  );
}
