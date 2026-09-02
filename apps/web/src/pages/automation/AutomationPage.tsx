/**
 * Automation workspace — the rules engine (Vol I #79–92 workflow automation,
 * #85–86 escalation; Vol II X #1005–1009 automation hooks).
 *
 *   · Rules      — trigger + conditions + actions, with lifecycle and a builder
 *   · Templates  — the code-resident library, instantiated into the tenant
 *   · Runs       — every evaluation: what the conditions came to, what each
 *                  action did, what went wrong; retry from here
 *   · Engine     — (owner/admin, company scope) the hook's health, the two
 *                  scheduler jobs, and a manual cycle
 *
 * One component serves both scopes — see `useScope()` in automationShared.
 * Every panel fails alone: the summary strip, each tab and each drawer carry
 * their own loading / error / empty states, and a figure the API did not
 * return renders "—" with the reason, never 0.
 */
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { Alert, Button, PageHeader, Stat, Tabs } from "../../ui";
import { IconPlus, IconZap } from "../../ui/icons";
import EngineTab from "./EngineTab";
import RuleBuilder from "./RuleBuilder";
import RulesTab from "./RulesTab";
import RunsTab from "./RunsTab";
import TemplatesTab from "./TemplatesTab";
import {
  errorMessage,
  errorStatus,
  num,
  useIsCompanyAdmin,
  useScope,
  type Catalogue,
  type RuleView,
  type SummaryView,
  type TemplateView,
} from "./automationShared";

type TabKey = "rules" | "templates" | "runs" | "engine";

export default function AutomationPage() {
  const scope = useScope();
  const isAdmin = useIsCompanyAdmin();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabs: Array<{ value: TabKey; label: string }> = [
    { value: "rules", label: "Rules" },
    { value: "templates", label: "Templates" },
    { value: "runs", label: "Runs" },
    ...(isAdmin && !scope.isProject ? [{ value: "engine" as const, label: "Engine" }] : []),
  ];
  const [tab, setTab] = useState<TabKey>(() => {
    const t = searchParams.get("tab");
    return t && tabs.some((x) => x.value === t) ? (t as TabKey) : "rules";
  });
  const selectTab = useCallback(
    (key: TabKey, extra: Record<string, string> = {}) => {
      setTab(key);
      setSearchParams({ tab: key, ...extra }, { replace: true });
    },
    [setSearchParams],
  );

  /* ---------------------------- reference data ---------------------------- */

  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const loadCatalogue = useCallback(async () => {
    setCatalogueError(null);
    try {
      setCatalogue(await api.get<Catalogue>("/api/v1/automation/catalogue"));
    } catch (err) {
      setCatalogueError(errorMessage(err, "Failed to load the builder catalogue"));
    }
  }, []);

  const [summary, setSummary] = useState<SummaryView | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryForbidden, setSummaryForbidden] = useState(false);
  const loadSummary = useCallback(async () => {
    setSummaryError(null);
    setSummaryLoading(true);
    try {
      setSummary(await api.get<SummaryView>(`${scope.base}/summary`));
      setSummaryForbidden(false);
    } catch (err) {
      setSummaryForbidden(errorStatus(err) === 403);
      setSummaryError(errorMessage(err, "Failed to load the automation summary"));
    } finally {
      setSummaryLoading(false);
    }
  }, [scope.base]);

  useEffect(() => {
    void loadCatalogue();
    void loadSummary();
  }, [loadCatalogue, loadSummary]);

  /* ------------------------------ builder ---------------------------------- */

  const [builder, setBuilder] = useState<{ open: boolean; rule: RuleView | null; template: TemplateView | null }>({
    open: false,
    rule: null,
    template: null,
  });
  const [rulesNonce, setRulesNonce] = useState(0);
  const [runsRuleId, setRunsRuleId] = useState<string | null>(() => searchParams.get("ruleId"));

  const openBuilder = (rule: RuleView | null, template: TemplateView | null = null) =>
    setBuilder({ open: true, rule, template });

  const changed = useCallback(() => {
    setRulesNonce((n) => n + 1);
    void loadSummary();
  }, [loadSummary]);

  const showRuns = (ruleId: string | null) => {
    setRunsRuleId(ruleId);
    selectTab("runs", ruleId ? { ruleId } : {});
  };

  const canCreate = isAdmin || scope.isProject;

  return (
    <div>
      <PageHeader
        title="Automation"
        icon={IconZap}
        subtitle={
          scope.isProject
            ? "Rules that react to this project's ledger events and deadlines — plus the company-wide rules that cover it"
            : "Rules that react to ledger events and deadlines across the company: notify, escalate, record obligations, raise signals, call webhooks, queue agents"
        }
        actions={
          <Button
            leadingIcon={IconPlus}
            onClick={() => openBuilder(null)}
            disabled={!canCreate}
            title={canCreate ? undefined : "Owner or admin role required to create company rules"}
          >
            New rule
          </Button>
        }
      />

      {!isAdmin && !scope.isProject ? (
        <Alert tone="warning" size="sm" className="mb-4">
          You are not an owner or admin of this company. Company-wide rules and the engine are read-only for you;
          project rules are governed by your automation tool level on each project.
        </Alert>
      ) : null}

      <SummaryStrip
        summary={summary}
        loading={summaryLoading}
        error={summaryForbidden ? null : summaryError}
        forbidden={summaryForbidden}
        onRetry={() => void loadSummary()}
      />

      <div className="mb-4">
        <Tabs items={tabs} value={tab} onChange={(v) => selectTab(v)} aria-label="Automation sections" />
      </div>

      {tab === "rules" ? (
        <RulesTab
          scope={scope}
          isAdmin={isAdmin}
          catalogue={catalogue}
          nonce={rulesNonce}
          onEdit={(rule) => openBuilder(rule)}
          onCreate={() => openBuilder(null)}
          onBrowseTemplates={() => selectTab("templates")}
          onShowRuns={(ruleId) => showRuns(ruleId)}
          onChanged={changed}
        />
      ) : null}

      {tab === "templates" ? (
        <TemplatesTab
          scope={scope}
          isAdmin={isAdmin}
          onInstantiated={() => {
            changed();
            selectTab("rules");
          }}
        />
      ) : null}

      {tab === "runs" ? (
        <RunsTab scope={scope} isAdmin={isAdmin} ruleId={runsRuleId} onClearRule={() => showRuns(null)} onChanged={changed} />
      ) : null}

      {tab === "engine" ? <EngineTab onCycle={changed} /> : null}

      <RuleBuilder
        open={builder.open}
        rule={builder.rule}
        template={builder.template}
        scope={scope}
        isAdmin={isAdmin}
        catalogue={catalogue}
        catalogueError={catalogueError}
        onRetryCatalogue={() => void loadCatalogue()}
        onClose={() => setBuilder({ open: false, rule: null, template: null })}
        onSaved={() => {
          setBuilder({ open: false, rule: null, template: null });
          changed();
        }}
      />
    </div>
  );
}

function SummaryStrip({
  summary,
  loading,
  error,
  forbidden,
  onRetry,
}: {
  summary: SummaryView | null;
  loading: boolean;
  error: string | null;
  forbidden: boolean;
  onRetry: () => void;
}) {
  if (forbidden) {
    return (
      <Alert tone="info" size="sm" className="mb-4">
        The summary for this scope is not available to your role, so no figures are shown rather than zeros.
      </Alert>
    );
  }
  if (error) {
    return (
      <Alert
        tone="danger"
        size="sm"
        className="mb-4"
        actions={
          <Button size="xs" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        }
      >
        {error}
      </Alert>
    );
  }
  const rules = summary?.rulesByStatus ?? null;
  const runs = summary?.runs24h ?? null;
  const active = rules?.["active"];
  const drafts = rules ? (rules["draft"] ?? 0) + (rules["paused"] ?? 0) : null;
  const succeeded = runs?.["succeeded"];
  const failed = runs ? (runs["failed"] ?? 0) + (runs["throttled"] ?? 0) : null;
  return (
    <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Stat label="Active rules" value={num(active)} loading={loading && !summary} tone={active ? "success" : "neutral"} hint="Firing on events or schedules" />
      <Stat label="Draft or paused" value={num(drafts)} loading={loading && !summary} hint="Not firing" />
      <Stat label="Runs succeeded (24h)" value={num(succeeded)} loading={loading && !summary} hint={runs ? `${num(runs["skipped"])} evaluated without matching` : undefined} />
      <Stat
        label="Runs failed or throttled (24h)"
        value={num(failed)}
        loading={loading && !summary}
        tone={failed ? "danger" : "neutral"}
        hint={failed ? "Open the Runs tab to retry" : "Nothing needs attention"}
      />
      <Stat
        label="Queued now"
        value={num(summary?.queued)}
        loading={loading && !summary}
        tone={summary && summary.queued > 0 ? "info" : "neutral"}
        hint={summary ? `${num(summary.actions24h)} actions executed in 24h` : undefined}
      />
    </div>
  );
}
