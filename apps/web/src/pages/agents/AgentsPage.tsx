/**
 * AI agents console (company scope) — Vol I §6.4 #759–#775, Vol II X
 * #995–#1027.
 *
 *   Fleet       every agent, what it reads and produces, its tenant policy,
 *               and a way to run it
 *   Queue       the human-in-the-loop review queue, with the proposal itself
 *               behind every row
 *   Activity    runs (metadata in the list, content behind the run's own
 *               project gate) and applied actions with rollback
 *   Operations  schedules, today's spend against the ceiling, and the
 *               adversarial / bias / model-validation reports
 *
 * Every panel fails alone and every number the API did not return renders "—"
 * with the reason, never 0.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { Alert, ErrorAlert, PageHeader, Stat, Tabs } from "../../ui";
import { IconAi } from "../../ui/icons";
import ActivityTab from "./ActivityTab";
import FleetTab from "./FleetTab";
import OperationsTab from "./OperationsTab";
import QueueTab from "./QueueTab";
import {
  asList,
  errorMessage,
  num,
  useIsCompanyAdmin,
  type AgentDescriptor,
  type AgentListResponse,
} from "./agentsShared";

type TabKey = "fleet" | "queue" | "activity" | "operations";

interface Project {
  id: string;
  name: string;
}

export default function AgentsPage() {
  const isAdmin = useIsCompanyAdmin();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabs: Array<{ value: TabKey; label: string }> = [
    { value: "fleet", label: "Fleet" },
    { value: "queue", label: "Review queue" },
    { value: "activity", label: "Runs & actions" },
    { value: "operations", label: "Schedules, spend & governance" },
  ];
  const [tab, setTab] = useState<TabKey>(() => {
    const t = searchParams.get("tab");
    return t && tabs.some((x) => x.value === t) ? (t as TabKey) : "fleet";
  });
  const selectTab = useCallback(
    (key: TabKey) => {
      setTab(key);
      setSearchParams({ tab: key }, { replace: true });
    },
    [setSearchParams],
  );

  /* ------------------------------ fleet ------------------------------ */

  const [agents, setAgents] = useState<AgentDescriptor[] | null>(null);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [fleetError, setFleetError] = useState<string | null>(null);
  const [fleetLoading, setFleetLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const loadFleet = useCallback(async () => {
    setFleetLoading(true);
    setFleetError(null);
    try {
      const res = await api.get<AgentListResponse>("/api/v1/agents");
      setAgents(res.items);
      setAiEnabled(res.aiEnabled);
    } catch (err) {
      setAgents(null);
      setFleetError(errorMessage(err, "Failed to load the agent fleet"));
    } finally {
      setFleetLoading(false);
    }
  }, []);

  /* ---------------------------- projects ----------------------------- */

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<unknown>("/api/v1/projects?pageSize=200")
      .then((res) => setProjects(asList<Project>(res).items))
      .catch((err: unknown) => setProjectsError(errorMessage(err, "Project list unavailable")));
  }, []);

  useEffect(() => {
    void loadFleet();
  }, [loadFleet]);

  const changed = useCallback(() => {
    setNonce((n) => n + 1);
    void loadFleet();
  }, [loadFleet]);

  /* ------------------------------ stats ------------------------------ */

  const stats = useMemo(() => {
    if (!agents) return null;
    const runnable = agents.filter((a) => a.runnable);
    return {
      total: agents.length,
      runnable: runnable.length,
      enabled: agents.filter((a) => a.enabled).length,
      pending: agents.reduce((acc, a) => acc + a.pendingProposals, 0),
      runs: agents.reduce((acc, a) => acc + a.runCount, 0),
      autoApply: agents.filter((a) => a.authorisation !== "propose_only").length,
    };
  }, [agents]);

  return (
    <div>
      <PageHeader
        title="AI agents"
        icon={IconAi}
        subtitle="A fleet of cited agents that propose and never decide: every consequential output waits for a person, is ledgered, and can be rolled back"
      />

      {!aiEnabled ? (
        <Alert tone="warning" title="AI is not configured" className="mb-3">
          <code className="font-mono text-xs">ANTHROPIC_API_KEY</code> is not set on the API. No
          agent can run, and every AI endpoint answers 503 rather than pretending. The queue, the
          audit trail, the policies and the governance reports on this page all still work.
        </Alert>
      ) : null}

      <ErrorAlert message={fleetError} />
      {projectsError ? (
        <p className="mb-2 text-xs text-ink-500">
          {projectsError} — the project picker will be empty.
        </p>
      ) : null}

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Agents" value={stats ? num(stats.total) : "—"} icon={IconAi} />
        <Stat
          label="Runnable here"
          value={stats ? num(stats.runnable) : "—"}
          hint="the rest are served by their own endpoints"
        />
        <Stat label="Enabled" value={stats ? num(stats.enabled) : "—"} />
        <Stat
          label="Awaiting a human"
          value={stats ? num(stats.pending) : "—"}
          tone={stats && stats.pending > 0 ? "warning" : "neutral"}
        />
        <Stat label="Runs recorded" value={stats ? num(stats.runs) : "—"} />
        <Stat
          label="Allowed to auto-apply"
          value={stats ? num(stats.autoApply) : "—"}
          tone={stats && stats.autoApply > 0 ? "warning" : "neutral"}
          hint="low-consequence targets only"
        />
      </div>

      <Tabs items={tabs} value={tab} onChange={selectTab} aria-label="AI agent console" />

      <div className="mt-4">
        {tab === "fleet" ? (
          <FleetTab
            agents={agents}
            aiEnabled={aiEnabled}
            loading={fleetLoading}
            error={null}
            isAdmin={isAdmin}
            projects={projects}
            onChanged={changed}
          />
        ) : null}
        {tab === "queue" ? <QueueTab onChanged={changed} nonce={nonce} /> : null}
        {tab === "activity" ? <ActivityTab agents={agents} onChanged={changed} /> : null}
        {tab === "operations" ? (
          <OperationsTab agents={agents} projects={projects} isAdmin={isAdmin} onChanged={changed} />
        ) : null}
      </div>
    </div>
  );
}
