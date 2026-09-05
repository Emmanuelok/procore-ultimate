/**
 * The workflow workspace (Vol I §0.4 #79–#92).
 *
 *   · Inbox      — the steps waiting on ME, with approve / reject / delegate
 *                  and a comment, overdue first
 *   · Running    — every instance across the projects I can see, with the
 *                  activation graph (#91), cancel and reassign
 *   · Templates  — the designer: ordered and parallel steps, conditions bound
 *                  to the record's own fields (#82), role and group
 *                  assignment (#83), due dates and escalation (#85),
 *                  versioning (#89) and retroactive application (#90)
 *
 * The API had all of this and no web surface at all — the feature shipped as
 * an unreachable state machine. Nothing here invents state: an instance whose
 * step snapshot cannot be read renders as BLOCKED with the reason, never as
 * an empty, finished chain.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { WORKFLOW_CONDITION_OPS, WORKFLOW_STEP_TYPES } from "@constructos/shared";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useShellData } from "../../layouts/shell/shell-data";
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
  PageHeader,
  Select,
  Skeleton,
  Stat,
  Table,
  Td,
  Textarea,
  Th,
  Tabs,
} from "../../ui";
import { IconPlus, IconRefresh, IconWorkflow } from "../../ui/icons";
import { formatDate, formatDateTime } from "../format";
import {
  DECISION_TONE,
  WORKFLOW_STATUS_TONE,
  asList,
  errorMessage,
  humanize,
  num,
  type WorkflowGraph,
  type WorkflowInboxItem,
  type WorkflowInstance,
  type WorkflowStepDef,
  type WorkflowTemplate,
} from "./substrate";

type TabKey = "inbox" | "running" | "templates";

export default function WorkflowsPage() {
  const [tab, setTab] = useState<TabKey>("inbox");
  const { company } = useAuth();
  const isAdmin = company?.role === "owner" || company?.role === "admin";
  const [inboxCount, setInboxCount] = useState<number | null>(null);

  return (
    <div>
      <PageHeader
        title="Approvals"
        icon={IconWorkflow}
        subtitle="Everything waiting on your decision, every approval chain in flight, and the templates that shape them"
      />

      <div className="mb-4">
        <Tabs
          items={[
            { value: "inbox" as const, label: "My inbox", count: inboxCount ?? undefined },
            { value: "running" as const, label: "In flight" },
            { value: "templates" as const, label: "Templates" },
          ]}
          value={tab}
          onChange={setTab}
          aria-label="Workflow sections"
        />
      </div>

      {tab === "inbox" ? <InboxTab onCount={setInboxCount} /> : null}
      {tab === "running" ? <RunningTab isAdmin={isAdmin} /> : null}
      {tab === "templates" ? <TemplatesTab isAdmin={isAdmin} /> : null}
    </div>
  );
}

/* =============================== Inbox ================================= */

function InboxTab({ onCount }: { onCount: (n: number | null) => void }) {
  const [items, setItems] = useState<WorkflowInboxItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<WorkflowInboxItem | null>(null);
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [delegateTo, setDelegateTo] = useState("");
  const [members, setMembers] = useState<Array<{ id: string; name?: string | null }>>([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<unknown>("/api/v1/me/workflow-inbox?pageSize=100");
      const list = asList<WorkflowInboxItem>(res);
      setItems(list.items);
      onCount(list.total);
    } catch (err) {
      setItems([]);
      onCount(null);
      setError(errorMessage(err, "Failed to load your approval inbox"));
    }
  }, [onCount]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .get<{ items: Array<{ id: string; name?: string | null }> }>(
        "/api/v1/company/users?pageSize=200",
      )
      .then((res) => setMembers(res.items))
      .catch(() => setMembers([]));
  }, []);

  async function decide() {
    if (!acting) return;
    setBusy(true);
    try {
      await api.post(`/api/v1/workflow-steps/${acting.id}/decide`, {
        decision,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      toast.success(decision === "approved" ? "Approved" : "Rejected");
      setActing(null);
      setComment("");
      await load();
    } catch (err) {
      setError(errorMessage(err, "Failed to record the decision"));
    } finally {
      setBusy(false);
    }
  }

  async function delegate() {
    if (!acting || !delegateTo) return;
    setBusy(true);
    try {
      await api.post(`/api/v1/workflow-steps/${acting.id}/delegate`, { toUserId: delegateTo });
      toast.success("Delegated");
      setActing(null);
      setDelegateTo("");
      await load();
    } catch (err) {
      setError(errorMessage(err, "Failed to delegate the step"));
    } finally {
      setBusy(false);
    }
  }

  const overdue = (items ?? []).filter((i) => i.overdue).length;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Waiting on you" value={items === null ? "—" : num(items.length)} />
        <Stat
          label="Overdue"
          value={items === null ? "—" : num(overdue)}
          tone={overdue > 0 ? "danger" : "neutral"}
        />
        <Stat
          label="Next due"
          value={
            items === null
              ? "—"
              : (items.map((i) => i.dueDate).filter((d): d is string => Boolean(d)).sort()[0] ??
                "No due dates")
          }
        />
      </div>

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" leadingIcon={IconRefresh} onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      <ErrorAlert message={error} onRetry={() => void load()} />

      {items === null ? (
        <Skeleton className="h-40 w-full" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={IconWorkflow}
          title="Nothing waiting on you"
          hint="Approval steps assigned to you — or delegated to you — appear here the moment their group activates."
        />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Step</Th>
                <Th>Record</Th>
                <Th>Project</Th>
                <Th>Due</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className={item.overdue ? "bg-danger-subtle/30" : undefined}>
                  <Td>
                    <div className="font-medium text-content-strong">{item.name}</div>
                    <div className="text-2xs text-content-muted">
                      {humanize(item.type)}
                      {item.delegatedToId ? " · delegated to you" : ""}
                    </div>
                  </Td>
                  <Td>
                    <span className="text-content-default">
                      {humanize(item.instance.recordType)}
                    </span>
                    <span className="ml-1 font-mono text-2xs text-content-subtle">
                      {item.instance.recordId}
                    </span>
                  </Td>
                  <Td>{item.instance.projectName ?? item.instance.projectId}</Td>
                  <Td>
                    {item.dueDate ? (
                      <span className={item.overdue ? "font-medium text-danger-text" : undefined}>
                        {formatDate(item.dueDate)}
                        {item.overdue ? " · overdue" : ""}
                      </span>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td>
                    <Button
                      size="xs"
                      onClick={() => {
                        setActing(item);
                        setDecision("approved");
                        setComment("");
                      }}
                    >
                      Decide
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Modal
        open={acting !== null}
        onClose={() => setActing(null)}
        title={acting ? acting.name : ""}
      >
        {acting ? (
          <div className="space-y-3 p-4">
            <p className="text-xs text-content-muted">
              {humanize(acting.instance.recordType)}{" "}
              <span className="font-mono">{acting.instance.recordId}</span> on{" "}
              {acting.instance.projectName ?? acting.instance.projectId}
            </p>
            <Field label="Decision">
              <Select
                value={decision}
                onChange={(e) => setDecision(e.target.value as "approved" | "rejected")}
              >
                <option value="approved">Approve</option>
                <option value="rejected">Reject</option>
              </Select>
            </Field>
            <Field
              label="Comment"
              hint={decision === "rejected" ? "A rejection withdraws the rest of its group" : undefined}
            >
              <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
            </Field>
            <div className="flex justify-between gap-2 border-t border-border-subtle pt-3">
              <div className="flex items-end gap-2">
                <Field label="Delegate instead" className="w-56">
                  <Select
                    size="sm"
                    value={delegateTo}
                    onChange={(e) => setDelegateTo(e.target.value)}
                  >
                    <option value="">Select a member…</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name ?? m.id}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!delegateTo || busy}
                  onClick={() => void delegate()}
                >
                  Delegate
                </Button>
              </div>
              <Button loading={busy} onClick={() => void decide()}>
                {decision === "approved" ? "Approve" : "Reject"}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

/* ============================== Running ================================ */

function RunningTab({ isAdmin }: { isAdmin: boolean }) {
  const shell = useShellData();
  const projects = shell.projects ?? [];
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState("");
  const [items, setItems] = useState<WorkflowInstance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<WorkflowInstance | null>(null);

  useEffect(() => {
    if (!projectId && projects.length > 0) setProjectId(projects[0]!.id);
  }, [projects, projectId]);

  const load = useCallback(async () => {
    if (!projectId) {
      setItems([]);
      return;
    }
    setError(null);
    try {
      const params = new URLSearchParams({ pageSize: "100" });
      if (status) params.set("status", status);
      const res = await api.get<unknown>(
        `/api/v1/projects/${projectId}/workflows?${params.toString()}`,
      );
      setItems(asList<WorkflowInstance>(res).items);
    } catch (err) {
      setItems([]);
      setError(errorMessage(err, "Failed to load workflows for this project"));
    }
  }, [projectId, status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function cancel(instance: WorkflowInstance) {
    const reason = window.prompt("Why is this approval chain being cancelled?");
    if (reason === null) return;
    try {
      await api.post(`/api/v1/workflows/${instance.id}/cancel`, { reason: reason || undefined });
      toast.success("Workflow cancelled");
      await load();
    } catch (err) {
      setError(errorMessage(err, "Failed to cancel"));
    }
  }

  async function remind(instance: WorkflowInstance) {
    try {
      const res = await api.post<{ reminded: number }>(
        `/api/v1/workflows/${instance.id}/remind`,
        {},
      );
      toast.success(`${res.reminded} approver(s) reminded`);
    } catch (err) {
      setError(errorMessage(err, "Failed to send reminders"));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Project" className="w-64">
          <Select size="sm" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.length === 0 ? <option value="">No projects visible</option> : null}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status" className="w-44">
          <Select size="sm" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="running">Running</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="cancelled">Cancelled</option>
            <option value="blocked">Blocked</option>
          </Select>
        </Field>
        <Button variant="ghost" size="sm" leadingIcon={IconRefresh} onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      <ErrorAlert message={error} onRetry={() => void load()} />

      {projects.length === 0 ? (
        <EmptyState
          title="No projects visible"
          hint="Approval chains belong to a project. You are not a member of any."
        />
      ) : items === null ? (
        <Skeleton className="h-40 w-full" />
      ) : items.length === 0 ? (
        <EmptyState
          title="No approval chains"
          hint="A chain starts when a record enters review against a matching template."
        />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Record</Th>
                <Th>Status</Th>
                <Th>Position</Th>
                <Th>Started</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="cursor-pointer hover:bg-surface-raised">
                  <Td onClick={() => setSelected(i)}>
                    <span className="text-content-strong">{humanize(i.recordType)}</span>
                    <span className="ml-1 font-mono text-2xs text-content-subtle">{i.recordId}</span>
                  </Td>
                  <Td onClick={() => setSelected(i)}>
                    <Badge tone={WORKFLOW_STATUS_TONE[i.status] ?? "neutral"}>
                      {humanize(i.status)}
                    </Badge>
                    {i.blockedReason ? (
                      <div className="max-w-sm text-2xs text-warning-text">{i.blockedReason}</div>
                    ) : null}
                  </Td>
                  <Td onClick={() => setSelected(i)}>
                    Group {i.currentPosition + 1} · v{i.templateVersion}
                  </Td>
                  <Td onClick={() => setSelected(i)}>{formatDateTime(i.createdAt)}</Td>
                  <Td>
                    <div className="flex gap-1">
                      {i.status === "running" ? (
                        <Button size="xs" variant="secondary" onClick={() => void remind(i)}>
                          Remind
                        </Button>
                      ) : null}
                      {i.status === "running" && isAdmin ? (
                        <Button size="xs" variant="danger" onClick={() => void cancel(i)}>
                          Cancel
                        </Button>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <InstanceDrawer
        instance={selected}
        onClose={() => setSelected(null)}
        onChanged={() => void load()}
      />
    </div>
  );
}

function InstanceDrawer({
  instance,
  onClose,
  onChanged,
}: {
  instance: WorkflowInstance | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!instance) {
      setGraph(null);
      return;
    }
    setError(null);
    api
      .get<WorkflowGraph>(`/api/v1/workflows/${instance.id}/graph`)
      .then(setGraph)
      .catch((err) => {
        setGraph(null);
        setError(errorMessage(err, "Failed to load the workflow graph"));
      });
  }, [instance]);

  return (
    <Drawer
      open={instance !== null}
      onClose={onClose}
      size="lg"
      title={instance ? `${humanize(instance.recordType)} approval` : ""}
    >
      {instance ? (
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={WORKFLOW_STATUS_TONE[instance.status] ?? "neutral"}>
              {humanize(instance.status)}
            </Badge>
            <span className="font-mono text-2xs text-content-subtle">{instance.recordId}</span>
            <span className="text-2xs text-content-subtle">
              template v{instance.templateVersion}
            </span>
          </div>

          {instance.blockedReason ? (
            <Alert tone="warning" size="sm">
              {instance.blockedReason}
            </Alert>
          ) : null}

          <ErrorAlert message={error} />

          {graph?.unavailable ? (
            <Alert tone="danger" size="sm">
              {graph.unavailable}
            </Alert>
          ) : null}

          {graph && !graph.unavailable ? (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-content-subtle">
                Activation groups
              </h4>
              <div className="flex gap-2 overflow-x-auto pb-2">
                {graph.nodes.map((node) => (
                  <div
                    key={node.position}
                    className={`min-w-48 rounded border p-2 ${
                      node.state === "active"
                        ? "border-accent-border bg-accent-subtle"
                        : node.state === "rejected"
                          ? "border-danger-border bg-danger-subtle"
                          : "border-border-subtle"
                    }`}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-2xs uppercase tracking-wide text-content-subtle">
                        Group {node.position + 1}
                        {node.parallel ? " · parallel" : ""}
                      </span>
                      <Badge tone={node.state === "done" ? "success" : node.state === "rejected" ? "danger" : node.state === "active" ? "info" : "neutral"}>
                        {humanize(node.state)}
                      </Badge>
                    </div>
                    <div className="text-xs font-medium text-content-strong">{node.label}</div>
                    <ul className="mt-1 space-y-0.5">
                      {node.steps.length === 0 ? (
                        <li className="text-2xs text-content-subtle">Not yet activated</li>
                      ) : (
                        node.steps.map((s) => (
                          <li key={s.id} className="flex items-center gap-1 text-2xs">
                            <Badge tone={DECISION_TONE[s.decision] ?? "neutral"}>
                              {humanize(s.decision)}
                            </Badge>
                            <span className="truncate text-content-muted">
                              {s.delegatedToId ? "delegated" : (s.assigneeId ?? "unassigned")}
                            </span>
                          </li>
                        ))
                      )}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <StepList instanceId={instance.id} onChanged={onChanged} />
        </div>
      ) : null}
    </Drawer>
  );
}

function StepList({ instanceId, onChanged }: { instanceId: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<WorkflowInstance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<Array<{ id: string; name?: string | null }>>([]);
  const [reassigning, setReassigning] = useState<string | null>(null);
  const [target, setTarget] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      setDetail(await api.get<WorkflowInstance>(`/api/v1/workflows/${instanceId}`));
    } catch (err) {
      setDetail(null);
      setError(errorMessage(err, "Failed to load the steps"));
    }
  }, [instanceId]);

  useEffect(() => {
    void load();
    api
      .get<{ items: Array<{ id: string; name?: string | null }> }>(
        "/api/v1/company/users?pageSize=200",
      )
      .then((res) => setMembers(res.items))
      .catch(() => setMembers([]));
  }, [load]);

  async function reassign(stepId: string) {
    if (!target) return;
    try {
      await api.post(`/api/v1/workflow-steps/${stepId}/reassign`, { toUserId: target });
      toast.success("Step reassigned");
      setReassigning(null);
      setTarget("");
      await load();
      onChanged();
    } catch (err) {
      setError(errorMessage(err, "Failed to reassign"));
    }
  }

  if (error) return <ErrorAlert message={error} onRetry={() => void load()} />;
  if (!detail) return <Skeleton className="h-24 w-full" />;

  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-content-subtle">
        Steps
      </h4>
      <Table>
        <thead>
          <tr>
            <Th>Step</Th>
            <Th>Assignee</Th>
            <Th>Decision</Th>
            <Th>Due</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {(detail.steps ?? []).map((s) => (
            <tr key={s.id}>
              <Td>
                <div className="text-xs font-medium text-content-strong">{s.name}</div>
                <div className="text-2xs text-content-subtle">
                  Group {s.position + 1} · {humanize(s.assigneeKind ?? "user")}
                  {s.assigneeKey ? ` (${s.assigneeKey})` : ""}
                </div>
              </Td>
              <Td className="text-xs">
                {s.delegatedToId ? `${s.assigneeId ?? "—"} → ${s.delegatedToId}` : (s.assigneeId ?? "—")}
              </Td>
              <Td>
                <Badge tone={DECISION_TONE[s.decision] ?? "neutral"}>{humanize(s.decision)}</Badge>
                {s.comment ? (
                  <div className="max-w-xs truncate text-2xs text-content-muted">{s.comment}</div>
                ) : null}
              </Td>
              <Td className="text-xs">
                {s.dueDate ? formatDate(s.dueDate) : "—"}
                {s.escalatedAt ? (
                  <div className="text-2xs text-warning-text">
                    escalated {formatDate(s.escalatedAt)}
                  </div>
                ) : null}
              </Td>
              <Td>
                {s.decision === "pending" ? (
                  reassigning === s.id ? (
                    <div className="flex items-center gap-1">
                      <Select size="xs" value={target} onChange={(e) => setTarget(e.target.value)}>
                        <option value="">Member…</option>
                        {members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name ?? m.id}
                          </option>
                        ))}
                      </Select>
                      <Button size="xs" disabled={!target} onClick={() => void reassign(s.id)}>
                        Save
                      </Button>
                    </div>
                  ) : (
                    <Button size="xs" variant="ghost" onClick={() => setReassigning(s.id)}>
                      Reassign
                    </Button>
                  )
                ) : null}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

/* ============================= Templates =============================== */

interface DesignerStep extends WorkflowStepDef {
  assigneeText?: string;
}

function TemplatesTab({ isAdmin }: { isAdmin: boolean }) {
  const [items, setItems] = useState<WorkflowTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<WorkflowTemplate | null>(null);
  const [recordTypes, setRecordTypes] = useState<string[]>([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<unknown>("/api/v1/workflow-templates?pageSize=100");
      setItems(asList<WorkflowTemplate>(res).items);
    } catch (err) {
      setItems([]);
      setError(errorMessage(err, "Failed to load workflow templates"));
    }
  }, []);

  useEffect(() => {
    void load();
    api
      .get<{ recordTypes: string[] }>("/api/v1/workflow-templates/meta/context-fields")
      .then((res) => setRecordTypes(res.recordTypes))
      .catch(() => setRecordTypes([]));
  }, [load]);

  async function applyToRunning(tpl: WorkflowTemplate) {
    if (
      !window.confirm(
        `Migrate every running instance of "${tpl.name}" to version ${tpl.version} at its current position?`,
      )
    )
      return;
    try {
      const res = await api.post<{ migrated: number }>(
        `/api/v1/workflow-templates/${tpl.id}/apply-to-running`,
        {},
      );
      toast.success(`${res.migrated} running instance(s) migrated`);
      await load();
    } catch (err) {
      setError(errorMessage(err, "Failed to apply the template to running instances"));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-content-muted">
          A template is a versioned chain of approval steps for one record type. Editing bumps the
          version; running instances keep the version they started on until you migrate them (#89,
          #90).
        </p>
        {isAdmin ? (
          <Button
            size="sm"
            leadingIcon={IconPlus}
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            New template
          </Button>
        ) : null}
      </div>

      {!isAdmin ? (
        <Alert tone="info" size="sm">
          Templates are read-only for you — owner or admin role required to change them.
        </Alert>
      ) : null}

      <ErrorAlert message={error} onRetry={() => void load()} />

      {items === null ? (
        <Skeleton className="h-40 w-full" />
      ) : items.length === 0 ? (
        <EmptyState
          title="No workflow templates"
          hint="Without a template nothing enters review: records are approved by whatever their own module allows."
          action={
            isAdmin ? (
              <Button size="sm" onClick={() => setOpen(true)}>
                Design the first
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Record type</Th>
                <Th>Steps</Th>
                <Th>Version</Th>
                <Th>Active</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <Td className="font-medium text-content-strong">{t.name}</Td>
                  <Td>{humanize(t.recordType)}</Td>
                  <Td className="text-xs text-content-muted">
                    {t.steps.map((s) => `${s.name}${s.parallel ? " ∥" : ""}`).join(" → ")}
                  </Td>
                  <Td>v{t.version}</Td>
                  <Td>{t.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}</Td>
                  <Td>
                    {isAdmin ? (
                      <div className="flex gap-1">
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => {
                            setEditing(t);
                            setOpen(true);
                          }}
                        >
                          Edit
                        </Button>
                        <Button size="xs" variant="secondary" onClick={() => void applyToRunning(t)}>
                          Apply to running
                        </Button>
                      </div>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <TemplateDesigner
        open={open}
        template={editing}
        recordTypes={recordTypes}
        onClose={() => {
          setOpen(false);
          setEditing(null);
        }}
        onSaved={() => {
          setOpen(false);
          setEditing(null);
          void load();
        }}
      />
    </div>
  );
}

function emptyStep(): DesignerStep {
  return { name: "", type: "approval", assigneeText: "", quorum: "all" };
}

function TemplateDesigner({
  open,
  template,
  recordTypes,
  onClose,
  onSaved,
}: {
  open: boolean;
  template: WorkflowTemplate | null;
  recordTypes: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [recordType, setRecordType] = useState("rfi");
  const [steps, setSteps] = useState<DesignerStep[]>([emptyStep()]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (template) {
      setName(template.name);
      setRecordType(template.recordType);
      setSteps(
        template.steps.map((s) => ({ ...s, assigneeText: (s.assigneeIds ?? []).join(", ") })),
      );
    } else {
      setName("");
      setRecordType(recordTypes[0] ?? "rfi");
      setSteps([emptyStep()]);
    }
  }, [open, template, recordTypes]);

  const resolvable = useMemo(() => new Set(recordTypes), [recordTypes]);

  function update(index: number, patch: Partial<DesignerStep>) {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name,
        recordType,
        steps: steps.map((s) => {
          const ids = (s.assigneeText ?? "")
            .split(/[,\s]+/)
            .map((x) => x.trim())
            .filter(Boolean);
          return {
            name: s.name,
            type: s.type,
            ...(ids.length > 0 ? { assigneeIds: ids } : {}),
            ...(s.role ? { role: s.role } : {}),
            ...(s.groupId ? { groupId: s.groupId } : {}),
            ...(s.quorum ? { quorum: s.quorum } : {}),
            ...(s.parallel ? { parallel: true } : {}),
            ...(s.dueInDays !== undefined ? { dueInDays: s.dueInDays } : {}),
            ...(s.escalateAfterDays !== undefined
              ? { escalateAfterDays: s.escalateAfterDays }
              : {}),
            ...(s.escalateTo ? { escalateTo: s.escalateTo } : {}),
            ...(s.condition && s.condition.field
              ? { condition: s.condition }
              : {}),
          };
        }),
      };
      if (template) {
        await api.patch(`/api/v1/workflow-templates/${template.id}`, {
          name: payload.name,
          steps: payload.steps,
        });
        toast.success("Template saved — version bumped");
      } else {
        await api.post("/api/v1/workflow-templates", payload);
        toast.success("Template created");
      }
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Failed to save the template"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open={open} onClose={onClose} size="xl" title={template ? "Edit template" : "New workflow template"}>
      <form onSubmit={submit} className="space-y-4 p-4">
        <ErrorAlert message={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field
            label="Record type"
            hint={
              resolvable.has(recordType)
                ? "Conditions on this type are evaluated against the STORED record"
                : "The server cannot load this record type, so conditions fall back to the caller's context and unresolvable ones keep the step pending"
            }
          >
            <Input
              value={recordType}
              onChange={(e) => setRecordType(e.target.value)}
              list="wf-record-types"
              disabled={Boolean(template)}
              required
            />
            <datalist id="wf-record-types">
              {recordTypes.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </Field>
        </div>

        <div className="space-y-3">
          {steps.map((step, i) => (
            <Card key={i}>
              <CardBody className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-content-strong">Step {i + 1}</span>
                  <Button
                    size="xs"
                    variant="ghost"
                    type="button"
                    disabled={steps.length === 1}
                    onClick={() => setSteps((prev) => prev.filter((_, x) => x !== i))}
                  >
                    Remove
                  </Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <Field label="Name" required>
                    <Input
                      size="sm"
                      value={step.name}
                      onChange={(e) => update(i, { name: e.target.value })}
                      required
                    />
                  </Field>
                  <Field label="Type">
                    <Select
                      size="sm"
                      value={step.type}
                      onChange={(e) => update(i, { type: e.target.value })}
                    >
                      {WORKFLOW_STEP_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {humanize(t)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Quorum" hint="ANY settles on the first decision">
                    <Select
                      size="sm"
                      value={step.quorum ?? "all"}
                      onChange={(e) => update(i, { quorum: e.target.value as "any" | "all" })}
                    >
                      <option value="all">All of</option>
                      <option value="any">Any of</option>
                    </Select>
                  </Field>
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <Field label="Assignee user ids" hint="Comma separated">
                    <Input
                      size="sm"
                      value={step.assigneeText ?? ""}
                      onChange={(e) => update(i, { assigneeText: e.target.value })}
                    />
                  </Field>
                  <Field label="…or role key" hint="Resolved to the project's members at activation">
                    <Input
                      size="sm"
                      value={step.role ?? ""}
                      onChange={(e) => update(i, { role: e.target.value || undefined })}
                      placeholder="project_manager"
                    />
                  </Field>
                  <Field label="…or distribution group id">
                    <Input
                      size="sm"
                      value={step.groupId ?? ""}
                      onChange={(e) => update(i, { groupId: e.target.value || undefined })}
                    />
                  </Field>
                </div>
                <div className="grid gap-2 sm:grid-cols-4">
                  <Field label="Due in days">
                    <Input
                      size="sm"
                      type="number"
                      min={0}
                      value={step.dueInDays ?? ""}
                      onChange={(e) =>
                        update(i, {
                          dueInDays: e.target.value === "" ? undefined : Number(e.target.value),
                        })
                      }
                    />
                  </Field>
                  <Field label="Escalate after days">
                    <Input
                      size="sm"
                      type="number"
                      min={0}
                      value={step.escalateAfterDays ?? ""}
                      onChange={(e) =>
                        update(i, {
                          escalateAfterDays:
                            e.target.value === "" ? undefined : Number(e.target.value),
                        })
                      }
                    />
                  </Field>
                  <Field label="Escalate to" hint="user id or role:<key>">
                    <Input
                      size="sm"
                      value={step.escalateTo ?? ""}
                      onChange={(e) => update(i, { escalateTo: e.target.value || undefined })}
                    />
                  </Field>
                  <Field label="Runs in parallel with the step above">
                    <Select
                      size="sm"
                      value={step.parallel ? "yes" : "no"}
                      onChange={(e) => update(i, { parallel: e.target.value === "yes" })}
                    >
                      <option value="no">No — sequential</option>
                      <option value="yes">Yes — parallel</option>
                    </Select>
                  </Field>
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <Field label="Condition field" hint="Leave blank for an unconditional step">
                    <Input
                      size="sm"
                      value={step.condition?.field ?? ""}
                      onChange={(e) =>
                        update(i, {
                          condition: e.target.value
                            ? {
                                field: e.target.value,
                                op: step.condition?.op ?? "gt",
                                value: step.condition?.value,
                              }
                            : undefined,
                        })
                      }
                      placeholder="cost"
                    />
                  </Field>
                  <Field label="Operator">
                    <Select
                      size="sm"
                      disabled={!step.condition?.field}
                      value={step.condition?.op ?? "gt"}
                      onChange={(e) =>
                        update(i, {
                          condition: {
                            field: step.condition?.field ?? "",
                            op: e.target.value,
                            value: step.condition?.value,
                          },
                        })
                      }
                    >
                      {WORKFLOW_CONDITION_OPS.map((op) => (
                        <option key={op} value={op}>
                          {op}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Value">
                    <Input
                      size="sm"
                      disabled={!step.condition?.field}
                      value={
                        step.condition?.value === undefined || step.condition.value === null
                          ? ""
                          : String(step.condition.value)
                      }
                      onChange={(e) =>
                        update(i, {
                          condition: {
                            field: step.condition?.field ?? "",
                            op: step.condition?.op ?? "gt",
                            value:
                              e.target.value !== "" && !Number.isNaN(Number(e.target.value))
                                ? Number(e.target.value)
                                : e.target.value,
                          },
                        })
                      }
                    />
                  </Field>
                </div>
                {step.condition?.field ? (
                  <p className="text-2xs text-content-muted">
                    A condition the server cannot answer leaves this step PENDING — it is never
                    silently skipped.
                  </p>
                ) : null}
              </CardBody>
            </Card>
          ))}
          <Button
            size="sm"
            variant="secondary"
            type="button"
            leadingIcon={IconPlus}
            onClick={() => setSteps((prev) => [...prev, emptyStep()])}
          >
            Add step
          </Button>
        </div>

        <div className="flex justify-end gap-2 border-t border-border-subtle pt-3">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            {template ? "Save (bumps version)" : "Create template"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
