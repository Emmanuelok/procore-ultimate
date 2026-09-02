/**
 * Schedules, spend and the governance reports.
 *
 *   Schedules  — monitors on a clock, drained by the `ai.agent-schedules`
 *                platform job. A scheduled run has no human actor.
 *   Spend      — today's usage against each agent's daily ceiling (#1022),
 *                with the cost stated as an estimate and its basis printed.
 *   Reports    — adversarial (#1024), bias (#1025) and model validation
 *                (#1027). All three are computed from stored rows, so they
 *                work with no API key and are reproducible.
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
  Table,
  Td,
  Th,
} from "../../ui";
import { IconCalendar, IconPlay, IconRefresh } from "../../ui/icons";
import {
  errorMessage,
  errorStatus,
  formatDateTime,
  humanize,
  intervalLabel,
  micros,
  num,
  pct,
  SCHEDULE_INTERVALS,
  type AgentDescriptor,
  type AgentReport,
  type AgentSchedule,
  type UsageResponse,
} from "./agentsShared";

interface Project {
  id: string;
  name: string;
}

export default function OperationsTab({
  agents,
  projects,
  isAdmin,
  onChanged,
}: {
  agents: AgentDescriptor[] | null;
  projects: Project[];
  isAdmin: boolean;
  onChanged: () => void;
}) {
  return (
    <div className="space-y-4">
      <SchedulesPanel agents={agents} projects={projects} isAdmin={isAdmin} onChanged={onChanged} />
      <UsagePanel />
      <ReportsPanel isAdmin={isAdmin} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Schedules                                                           */
/* ------------------------------------------------------------------ */

function SchedulesPanel({
  agents,
  projects,
  isAdmin,
  onChanged,
}: {
  agents: AgentDescriptor[] | null;
  projects: Project[];
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<AgentSchedule[] | null>(null);
  const [jobs, setJobs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ agentKind: "", projectId: "", everyMinutes: 1440, name: "" });

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ items: AgentSchedule[]; jobs: string[] }>("/api/v1/agents/schedules");
      setRows(res.items);
      setJobs(res.jobs ?? []);
    } catch (err) {
      setRows([]);
      setError(errorMessage(err, "Failed to load schedules"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const schedulable = (agents ?? []).filter((a) => a.schedulable && a.runnable);

  async function create() {
    setBusy("create");
    setError(null);
    try {
      await api.post("/api/v1/agents/schedules", {
        agentKind: form.agentKind,
        projectId: form.projectId || null,
        everyMinutes: form.everyMinutes,
        name: form.name || undefined,
        params: {},
        enabled: true,
      });
      toast.success("Schedule created");
      setCreating(false);
      setForm({ agentKind: "", projectId: "", everyMinutes: 1440, name: "" });
      await load();
      onChanged();
    } catch (err) {
      setError(errorMessage(err, "Failed to create the schedule"));
    } finally {
      setBusy(null);
    }
  }

  async function act(id: string, action: "run" | "toggle" | "delete", row?: AgentSchedule) {
    setBusy(id);
    setError(null);
    try {
      if (action === "run") {
        const res = await api.post<{ status: string; detail: string }>(
          `/api/v1/agents/schedules/${id}/run`,
          {},
        );
        toast.message(humanize(res.status), { description: res.detail });
      } else if (action === "toggle") {
        await api.patch(`/api/v1/agents/schedules/${id}`, { enabled: row?.enabled !== 1 });
      } else {
        await api.del(`/api/v1/agents/schedules/${id}`);
      }
      await load();
      onChanged();
    } catch (err) {
      setError(errorMessage(err, "The schedule action failed"));
    } finally {
      setBusy(null);
    }
  }

  async function tick() {
    setBusy("tick");
    try {
      const res = await api.post<{ ran: number }>("/api/v1/agents/tick", {});
      toast.success(`${res.ran} schedule(s) ran`);
      await load();
      onChanged();
    } catch (err) {
      setError(
        errorStatus(err) === 403
          ? "Running a cycle by hand is an owner/admin action."
          : errorMessage(err, "The cycle failed"),
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-ink-900">Scheduled monitors</div>
            <p className="text-xs text-ink-500">
              Drained by the platform jobs {jobs.join(", ") || "ai.agent-schedules"}. A scheduled run
              has no human actor: it is ledgered as the system.
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" leadingIcon={IconRefresh} loading={busy === "tick"} onClick={() => void tick()}>
              Run a cycle now
            </Button>
            <Button size="sm" leadingIcon={IconCalendar} onClick={() => setCreating(true)}>
              New schedule
            </Button>
          </div>
        </div>

        <ErrorAlert message={error} />

        {rows === null ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No agent is on a clock"
            hint="A monitor that only runs when someone opens a page is not a monitor. Schedule the obligation, risk, integrity or anomaly monitors here."
            icon={IconCalendar}
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Agent</Th>
                  <Th>Scope</Th>
                  <Th>Interval</Th>
                  <Th>Last run</Th>
                  <Th>Next</Th>
                  <Th>Outcome</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <Td className="text-xs">
                      <div className="font-medium">{s.name ?? humanize(s.agentKind)}</div>
                      <div className="font-mono text-[11px] text-ink-400">{s.agentKind}</div>
                    </Td>
                    <Td className="text-xs">
                      {s.projectId
                        ? (projects.find((p) => p.id === s.projectId)?.name ?? s.projectId)
                        : "Company-wide"}
                    </Td>
                    <Td className="text-xs">{intervalLabel(s.everyMinutes)}</Td>
                    <Td className="text-xs">{formatDateTime(s.lastRunAt)}</Td>
                    <Td className="text-xs">{s.enabled === 1 ? formatDateTime(s.nextRunAt) : "paused"}</Td>
                    <Td className="text-xs">
                      {s.lastStatus ? (
                        <Badge
                          tone={
                            s.lastStatus === "done"
                              ? "success"
                              : s.lastStatus === "failed"
                                ? "danger"
                                : "neutral"
                          }
                        >
                          {humanize(s.lastStatus)}
                        </Badge>
                      ) : (
                        "—"
                      )}
                      {s.lastError ? (
                        <div className="mt-0.5 text-[11px] text-danger-600">{s.lastError}</div>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap">
                      <span className="flex gap-1">
                        <Button
                          size="xs"
                          variant="secondary"
                          leadingIcon={IconPlay}
                          loading={busy === s.id}
                          onClick={() => void act(s.id, "run")}
                        >
                          Run
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => void act(s.id, "toggle", s)}>
                          {s.enabled === 1 ? "Pause" : "Resume"}
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => void act(s.id, "delete")}>
                          Delete
                        </Button>
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}

        <Drawer
          open={creating}
          onClose={() => setCreating(false)}
          size="md"
          title="New agent schedule"
          icon={IconCalendar}
        >
          <div className="space-y-3">
            <Field label="Agent" hint="Only monitors can be scheduled.">
              <Select
                value={form.agentKind}
                onChange={(e) => setForm((f) => ({ ...f, agentKind: e.target.value }))}
              >
                <option value="">Choose an agent…</option>
                {schedulable.map((a) => (
                  <option key={a.kind} value={a.kind}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Project" hint="Company-wide schedules are an owner/admin action.">
              <Select
                value={form.projectId}
                onChange={(e) => setForm((f) => ({ ...f, projectId: e.target.value }))}
              >
                <option value="">Company-wide</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="How often">
              <Select
                value={String(form.everyMinutes)}
                onChange={(e) => setForm((f) => ({ ...f, everyMinutes: Number(e.target.value) }))}
              >
                {SCHEDULE_INTERVALS.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Name (optional)">
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </Field>
            {!isAdmin && !form.projectId ? (
              <Alert tone="warning" title="Company-wide schedules need an admin">
                Choose a project, or ask an owner/admin to create this schedule.
              </Alert>
            ) : null}
            <Button loading={busy === "create"} disabled={!form.agentKind} onClick={() => void create()}>
              Create schedule
            </Button>
          </div>
        </Drawer>
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Usage                                                               */
/* ------------------------------------------------------------------ */

function UsagePanel() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<UsageResponse>("/api/v1/ai/usage")
      .then(setData)
      .catch((err: unknown) => setError(errorMessage(err, "Failed to load usage")));
  }, []);

  const active = (data?.agents ?? []).filter((a) => a.runs > 0);

  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="text-sm font-semibold text-ink-900">Spend today ({data?.date ?? "—"})</div>
        <ErrorAlert message={error} />
        {data ? (
          <>
            <p className="text-xs text-ink-500">{data.costBasis}</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat label="Runs" value={num(data.totals.runs)} />
              <Stat label="Failures" value={num(data.totals.failures)} />
              <Stat label="Input tokens" value={num(data.totals.inputTokens)} />
              <Stat label="Output tokens" value={num(data.totals.outputTokens)} />
              <Stat label="Estimated cost" value={micros(data.totals.estimatedCostMicros)} />
            </div>
            {active.length === 0 ? (
              <p className="text-xs text-ink-500">No agent has run today.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Agent</Th>
                    <Th>Runs / ceiling</Th>
                    <Th>Input tokens / ceiling</Th>
                    <Th>Estimated cost</Th>
                    <Th>Within budget</Th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((a) => (
                    <tr key={a.agentKind}>
                      <Td className="text-xs">{humanize(a.agentKind)}</Td>
                      <Td className="tabular-nums text-xs">
                        {num(a.runs)} / {a.limits.maxRunsPerDay === null ? "∞" : num(a.limits.maxRunsPerDay)}
                      </Td>
                      <Td className="tabular-nums text-xs">
                        {num(a.inputTokens)} /{" "}
                        {a.limits.maxInputTokensPerDay === null ? "∞" : num(a.limits.maxInputTokensPerDay)}
                      </Td>
                      <Td className="tabular-nums text-xs">{micros(a.costMicros)}</Td>
                      <Td>
                        <Badge tone={a.withinBudget ? "success" : "danger"}>
                          {a.withinBudget ? "yes" : "ceiling reached"}
                        </Badge>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        ) : (
          <Spinner />
        )}
      </CardBody>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-ink-100 p-2">
      <div className="text-[11px] text-ink-400">{label}</div>
      <div className="tabular-nums text-sm font-semibold text-ink-900">{value}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Reports                                                             */
/* ------------------------------------------------------------------ */

function ReportsPanel({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<AgentReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<AgentReport | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ items: AgentReport[] }>("/api/v1/agents/reports");
      setRows(res.items);
    } catch (err) {
      setRows([]);
      setError(errorMessage(err, "Failed to load reports"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function generate(kind: string) {
    setBusy(kind);
    setError(null);
    try {
      const res = await api.post<AgentReport>(`/api/v1/agents/reports/${kind}?days=30`, {});
      toast.success(res.summary ?? "Report generated");
      setOpen(res);
      await load();
    } catch (err) {
      setError(
        errorStatus(err) === 403
          ? "Generating a governance report is an owner/admin action."
          : errorMessage(err, "Failed to generate the report"),
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-ink-900">Governance reports</div>
            <p className="text-xs text-ink-500">
              Adversarial testing of the guard layer, bias assessment over vendor- and
              worker-affecting output, and model validation. All computed from stored rows — they
              work with no API key.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {["adversarial", "bias", "validation"].map((kind) => (
              <Button
                key={kind}
                size="sm"
                variant="secondary"
                loading={busy === kind}
                disabled={!isAdmin}
                title={isAdmin ? undefined : "Owner or admin only"}
                onClick={() => void generate(kind)}
              >
                Run {kind}
              </Button>
            ))}
          </div>
        </div>

        <ErrorAlert message={error} />

        {rows === null ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No report generated yet"
            hint="Generate an adversarial report first: it proves the platform's own guards still hold."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Kind</Th>
                <Th>Title</Th>
                <Th>Finding</Th>
                <Th>Generated</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="cursor-pointer hover:bg-ink-50/60" onClick={() => setOpen(r)}>
                  <Td className="text-xs">
                    <Badge tone="neutral">{humanize(r.kind)}</Badge>
                  </Td>
                  <Td className="text-xs">{r.title}</Td>
                  <Td className="text-xs">{r.summary ?? "—"}</Td>
                  <Td className="text-xs">{formatDateTime(r.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        <Drawer open={open !== null} onClose={() => setOpen(null)} size="xl" title={open?.title ?? "Report"}>
          {open ? <ReportBody report={open} /> : null}
        </Drawer>
      </CardBody>
    </Card>
  );
}

function ReportBody({ report }: { report: AgentReport }) {
  const data = report.data as Record<string, unknown>;
  if (report.kind === "adversarial") {
    const cases = Array.isArray(data["cases"]) ? (data["cases"] as Array<Record<string, unknown>>) : [];
    return (
      <div className="space-y-3">
        <Alert tone={data["failed"] === 0 ? "success" : "danger"} title={report.summary ?? ""}>
          Each case runs the actual guard function that is supposed to catch it, not a description of
          one.
        </Alert>
        <Table>
          <thead>
            <tr>
              <Th>Family</Th>
              <Th>What goes wrong</Th>
              <Th>Expected</Th>
              <Th>Observed</Th>
              <Th>Held</Th>
            </tr>
          </thead>
          <tbody>
            {cases.map((c, i) => (
              <tr key={i}>
                <Td className="text-xs">{humanize(String(c["family"]))}</Td>
                <Td className="text-xs">{String(c["description"])}</Td>
                <Td className="text-xs">{String(c["expectation"])}</Td>
                <Td className="text-xs">{String(c["observed"])}</Td>
                <Td>
                  <Badge tone={c["held"] ? "success" : "danger"}>{c["held"] ? "yes" : "NO"}</Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    );
  }

  if (report.kind === "bias") {
    const groups = Array.isArray(data["groups"]) ? (data["groups"] as Array<Record<string, unknown>>) : [];
    return (
      <div className="space-y-3">
        <Alert tone="info" title="Verdict">
          {String(data["verdict"] ?? "")}
        </Alert>
        <p className="text-xs text-ink-500">
          {num(data["observations"] as number)} observation(s),{" "}
          {num(data["unattributed"] as number)} of which name no subject and are excluded from every
          rate.
        </p>
        {groups.length === 0 ? (
          <p className="text-xs text-ink-500">No subject received an agent output in this window.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Subject</Th>
                <Th>Outputs</Th>
                <Th>Adverse</Th>
                <Th>Adverse rate</Th>
                <Th>Why not</Th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g, i) => (
                <tr key={i}>
                  <Td className="font-mono text-xs">{String(g["subjectId"])}</Td>
                  <Td className="tabular-nums text-xs">{num(g["observations"] as number)}</Td>
                  <Td className="tabular-nums text-xs">{num(g["adverse"] as number)}</Td>
                  <Td className="tabular-nums text-xs">{pct(g["adverseRate"] as number | null)}</Td>
                  <Td className="text-xs text-ink-500">{(g["reason"] as string) ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    );
  }

  const agents = Array.isArray(data["agents"]) ? (data["agents"] as Array<Record<string, unknown>>) : [];
  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-500">{report.summary}</p>
      <Table>
        <thead>
          <tr>
            <Th>Agent</Th>
            <Th>Runs</Th>
            <Th>Success</Th>
            <Th>Fabrication</Th>
            <Th>Evidence</Th>
            <Th>Human agreement</Th>
            <Th>Prompt versions</Th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a, i) => (
            <tr key={i}>
              <Td className="text-xs">{humanize(String(a["agentKind"]))}</Td>
              <Td className="tabular-nums text-xs">{num(a["runs"] as number)}</Td>
              <Td className="tabular-nums text-xs">{pct(a["successRate"] as number | null)}</Td>
              <Td className="tabular-nums text-xs">{pct(a["fabricationRate"] as number | null)}</Td>
              <Td className="tabular-nums text-xs">{pct(a["meanEvidenceScore"] as number | null)}</Td>
              <Td className="tabular-nums text-xs">{pct(a["humanAgreementRate"] as number | null)}</Td>
              <Td className="font-mono text-[11px]">
                {(a["promptVersions"] as string[] | undefined)?.join(", ") || "—"}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="text-xs text-ink-500">
        A rate is withheld — shown as "—" — until there are at least{" "}
        {num(data["minimumForRate"] as number)} observations. The reason is on each row in the API
        response.
      </p>
    </div>
  );
}
