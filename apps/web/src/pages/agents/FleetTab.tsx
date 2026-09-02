/**
 * The fleet grid: every agent the platform has, what it reads, what it
 * produces, whether a tenant has switched it on, and what it is authorised to
 * do without a human (Vol II X #1022).
 *
 * Two things this grid refuses to pretend:
 *   · a LEGACY agent (RFI evaluation, submittal review, …) is not runnable
 *     from here — it is served by its own route, and the card says which;
 *   · an agent's authorisation is shown as the tenant's effective policy with
 *     its source, so "propose only" is visibly a default rather than a
 *     decision nobody made.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
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
  Select,
  Spinner,
  Textarea,
} from "../../ui";
import { IconAi, IconPlay, IconSettings } from "../../ui/icons";
import {
  CATEGORY_TONE,
  errorMessage,
  errorStatus,
  formatDateTime,
  humanize,
  num,
  pct,
  type AgentDescriptor,
  type AgentRunResult,
  type PolicyResponse,
} from "./agentsShared";

interface Project {
  id: string;
  name: string;
}

export default function FleetTab({
  agents,
  aiEnabled,
  loading,
  error,
  isAdmin,
  projects,
  onChanged,
}: {
  agents: AgentDescriptor[] | null;
  aiEnabled: boolean;
  loading: boolean;
  error: string | null;
  isAdmin: boolean;
  projects: Project[];
  onChanged: () => void;
}) {
  const [category, setCategory] = useState("");
  const [policyKind, setPolicyKind] = useState<string | null>(null);
  const [runKind, setRunKind] = useState<AgentDescriptor | null>(null);

  const shown = (agents ?? []).filter((a) => !category || a.category === category);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Category" className="w-48">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            <option value="monitor">Monitors</option>
            <option value="drafter">Drafters</option>
            <option value="analyst">Analysts</option>
            <option value="reviewer">Reviewers</option>
            <option value="assistant">Assistants</option>
          </Select>
        </Field>
        <div className="text-xs text-ink-500">
          {shown.length} of {agents?.length ?? 0} agents
        </div>
      </div>

      <ErrorAlert message={error} />
      {!aiEnabled ? (
        <Alert tone="warning" title="AI is not configured">
          <code className="font-mono text-xs">ANTHROPIC_API_KEY</code> is not set on the API, so no
          agent can run. Everything else on this page — policies, the queue, the audit trail and the
          governance reports — keeps working.
        </Alert>
      ) : null}

      {loading && !agents ? <Spinner /> : null}
      {agents && shown.length === 0 ? (
        <EmptyState title="No agent matches this filter" icon={IconAi} />
      ) : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((a) => (
          <Card key={a.kind} className={a.enabled ? undefined : "opacity-70"}>
            <CardBody className="space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-ink-900">{a.name}</div>
                  <div className="font-mono text-[11px] text-ink-400">{a.kind}</div>
                </div>
                <Badge tone={CATEGORY_TONE[a.category] ?? "neutral"}>{humanize(a.category)}</Badge>
              </div>
              <p className="text-xs text-ink-600">{a.description}</p>

              <div className="flex flex-wrap gap-1.5">
                <Badge tone={a.enabled ? "success" : "danger"}>
                  {a.enabled ? "Enabled" : "Disabled"}
                </Badge>
                <Badge tone={a.authorisation === "propose_only" ? "neutral" : "warning"}>
                  {humanize(a.authorisation)}
                </Badge>
                {a.consequential ? <Badge tone="warning">Consequential</Badge> : null}
                {a.schedulable ? <Badge tone="info">Schedulable</Badge> : null}
                {!a.runnable ? <Badge tone="neutral">Own endpoint</Badge> : null}
              </div>

              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-ink-600">
                <div>
                  <dt className="text-ink-400">Reads</dt>
                  <dd>{a.inputs.join(", ") || "—"}</dd>
                </div>
                <div>
                  <dt className="text-ink-400">Produces</dt>
                  <dd>{a.outputs.join(", ") || "—"}</dd>
                </div>
                <div>
                  <dt className="text-ink-400">Runs</dt>
                  <dd className="tabular-nums">{num(a.runCount)}</dd>
                </div>
                <div>
                  <dt className="text-ink-400">Last run</dt>
                  <dd>{formatDateTime(a.lastRunAt)}</dd>
                </div>
                <div>
                  <dt className="text-ink-400">Pending proposals</dt>
                  <dd className="tabular-nums">{num(a.pendingProposals)}</dd>
                </div>
                <div>
                  <dt className="text-ink-400">Policy source</dt>
                  <dd>{humanize(a.policySource)}</dd>
                </div>
              </dl>

              {!a.runnable ? (
                <p className="rounded bg-ink-50 px-2 py-1 font-mono text-[11px] text-ink-500">
                  {a.route}
                </p>
              ) : null}

              <div className="flex gap-2 pt-1">
                <Button
                  size="xs"
                  leadingIcon={IconPlay}
                  disabled={!a.runnable || !a.enabled || !aiEnabled}
                  title={
                    !a.runnable
                      ? `Served by ${a.route}`
                      : !a.enabled
                        ? "Disabled by policy"
                        : !aiEnabled
                          ? "AI is not configured"
                          : undefined
                  }
                  onClick={() => setRunKind(a)}
                >
                  Run
                </Button>
                <Button size="xs" variant="secondary" leadingIcon={IconSettings} onClick={() => setPolicyKind(a.kind)}>
                  Policy
                </Button>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      <PolicyDrawer
        kind={policyKind}
        isAdmin={isAdmin}
        onClose={() => setPolicyKind(null)}
        onSaved={onChanged}
      />
      <RunDrawer
        agent={runKind}
        projects={projects}
        onClose={() => setRunKind(null)}
        onRan={onChanged}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Policy                                                              */
/* ------------------------------------------------------------------ */

function PolicyDrawer({
  kind,
  isAdmin,
  onClose,
  onSaved,
}: {
  kind: string | null;
  isAdmin: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    enabled: true,
    authorisation: "propose_only",
    autoApplyMinConfidence: "",
    minConfidence: "",
    maxRunsPerDay: "",
    maxInputTokensPerDay: "",
    notes: "",
  });

  const load = useCallback(async () => {
    if (!kind) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<PolicyResponse>(`/api/v1/agents/${kind}/policy`);
      setData(res);
      setForm({
        enabled: res.policy.enabled,
        authorisation: res.policy.authorisation,
        autoApplyMinConfidence:
          res.policy.autoApplyMinConfidence === null ? "" : String(res.policy.autoApplyMinConfidence),
        minConfidence: res.policy.minConfidence === null ? "" : String(res.policy.minConfidence),
        maxRunsPerDay: res.policy.maxRunsPerDay === null ? "" : String(res.policy.maxRunsPerDay),
        maxInputTokensPerDay:
          res.policy.maxInputTokensPerDay === null ? "" : String(res.policy.maxInputTokensPerDay),
        notes: res.policy.notes ?? "",
      });
    } catch (err) {
      setData(null);
      setError(errorMessage(err, "Failed to load the policy"));
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const numOrNull = (v: string): number | null => (v.trim() === "" ? null : Number(v));

  async function save() {
    if (!kind) return;
    setSaving(true);
    setError(null);
    try {
      await api.put(`/api/v1/agents/${kind}/policy`, {
        enabled: form.enabled,
        authorisation: form.authorisation,
        autoApplyMinConfidence: numOrNull(form.autoApplyMinConfidence),
        minConfidence: numOrNull(form.minConfidence),
        maxRunsPerDay: numOrNull(form.maxRunsPerDay),
        maxInputTokensPerDay: numOrNull(form.maxInputTokensPerDay),
        notes: form.notes.trim() === "" ? null : form.notes,
      });
      toast.success("Policy saved and ledgered");
      onSaved();
      await load();
    } catch (err) {
      setError(
        errorStatus(err) === 403
          ? "Only a company owner or admin can change an agent policy."
          : errorMessage(err, "Failed to save the policy"),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer open={kind !== null} onClose={onClose} size="md" title={`Policy — ${kind ?? ""}`} icon={IconSettings}>
      {loading && !data ? <Spinner /> : null}
      <ErrorAlert message={error} />
      {data ? (
        <div className="space-y-3">
          <Alert tone={data.verdict.allowed ? "info" : "danger"} title="Today">
            {data.verdict.reason}. {num(data.usedToday.runs)} run(s),{" "}
            {num(data.usedToday.inputTokens)} input tokens, {num(data.usedToday.failures)} failure(s).
          </Alert>

          <Field label="Enabled" hint="Disabling refuses the agent before any model call is made.">
            <Select
              value={form.enabled ? "yes" : "no"}
              disabled={!isAdmin}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.value === "yes" }))}
            >
              <option value="yes">Enabled</option>
              <option value="no">Disabled</option>
            </Select>
          </Field>

          <Field
            label="Authorisation"
            hint="Auto-apply is permitted only for low-consequence targets, whatever this is set to."
          >
            <Select
              value={form.authorisation}
              disabled={!isAdmin}
              onChange={(e) => setForm((f) => ({ ...f, authorisation: e.target.value }))}
            >
              <option value="propose_only">Propose only — a human approves everything</option>
              <option value="auto_apply_below_threshold">Auto-apply at or above a confidence</option>
              <option value="auto_apply">Auto-apply (low-consequence targets only)</option>
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Auto-apply confidence" hint="0–1; blank never auto-applies.">
              <Input
                value={form.autoApplyMinConfidence}
                disabled={!isAdmin}
                onChange={(e) => setForm((f) => ({ ...f, autoApplyMinConfidence: e.target.value }))}
                placeholder="e.g. 0.9"
              />
            </Field>
            <Field label="Minimum confidence to queue" hint="Below this, a proposal is recorded but not queued.">
              <Input
                value={form.minConfidence}
                disabled={!isAdmin}
                onChange={(e) => setForm((f) => ({ ...f, minConfidence: e.target.value }))}
                placeholder="blank = queue everything"
              />
            </Field>
            <Field label="Max runs per day">
              <Input
                value={form.maxRunsPerDay}
                disabled={!isAdmin}
                onChange={(e) => setForm((f) => ({ ...f, maxRunsPerDay: e.target.value }))}
                placeholder="blank = unlimited"
              />
            </Field>
            <Field label="Max input tokens per day">
              <Input
                value={form.maxInputTokensPerDay}
                disabled={!isAdmin}
                onChange={(e) => setForm((f) => ({ ...f, maxInputTokensPerDay: e.target.value }))}
                placeholder="blank = unlimited"
              />
            </Field>
          </div>

          <Field label="Notes">
            <Textarea
              rows={2}
              value={form.notes}
              disabled={!isAdmin}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </Field>

          <div className="text-xs text-ink-500">
            Effective policy source: {humanize(data.policy.source)}
            {data.policy.updatedAt ? ` · last changed ${formatDateTime(data.policy.updatedAt)}` : ""}
          </div>

          <Button loading={saving} disabled={!isAdmin} onClick={() => void save()}>
            {isAdmin ? "Save policy" : "Owner or admin only"}
          </Button>
        </div>
      ) : null}
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

function RunDrawer({
  agent,
  projects,
  onClose,
  onRan,
}: {
  agent: AgentDescriptor | null;
  projects: Project[];
  onClose: () => void;
  onRan: () => void;
}) {
  const [projectId, setProjectId] = useState("");
  const [params, setParams] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AgentRunResult | null>(null);

  useEffect(() => {
    setResult(null);
    setError(null);
    setParams("{}");
    setProjectId("");
  }, [agent]);

  async function run() {
    if (!agent) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = params.trim() === "" ? {} : (JSON.parse(params) as Record<string, unknown>);
    } catch {
      setError("Parameters must be a JSON object, e.g. {\"contractEventId\": \"cev_…\"}");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<AgentRunResult>(`/api/v1/agents/${agent.kind}/run`, {
        ...(projectId ? { projectId } : {}),
        params: parsed,
      });
      setResult(res);
      if (res.skipped) toast.message("Nothing to analyse", { description: res.summary });
      else toast.success(`${res.queued} proposal(s) queued for review`);
      onRan();
    } catch (err) {
      setError(errorMessage(err, "The agent run failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={agent !== null}
      onClose={onClose}
      size="md"
      icon={IconPlay}
      title={agent ? `Run ${agent.name}` : "Run agent"}
      description={agent?.description}
    >
      {agent ? (
        <div className="space-y-3">
          <Field
            label="Project"
            hint={
              agent.scope === "project"
                ? "This agent reads project records, so a project is required."
                : "Leave blank to run company-wide (owner/admin)."
            }
          >
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">{agent.scope === "project" ? "Choose a project…" : "Company-wide"}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Parameters (JSON)"
            hint="Optional. Most agents pick the most recent relevant record when nothing is named."
          >
            <Textarea rows={4} value={params} onChange={(e) => setParams(e.target.value)} />
          </Field>

          <ErrorAlert message={error} />

          <Button
            loading={busy}
            disabled={agent.scope === "project" && !projectId}
            onClick={() => void run()}
          >
            Run now
          </Button>

          {result ? (
            <Card>
              <CardBody className="space-y-1 text-xs text-ink-700">
                <div className="text-sm font-semibold text-ink-900">
                  {result.skipped ? "Skipped — the model was not called" : "Run complete"}
                </div>
                <p>{result.summary}</p>
                {!result.skipped ? (
                  <ul className="mt-1 space-y-0.5">
                    <li>Proposals: {num(result.proposals)} ({num(result.queued)} queued, {num(result.filtered)} filtered by policy)</li>
                    <li>Signals raised: {num(result.signals)}</li>
                    <li>Auto-applied: {num(result.actions)}</li>
                    <li>Evidence score: {pct(result.evidenceScore)}</li>
                    <li>Recorded confidence: {pct(result.confidence)}</li>
                    <li>Citations dropped as invented: {num(result.droppedCitations)}</li>
                  </ul>
                ) : null}
              </CardBody>
            </Card>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}
