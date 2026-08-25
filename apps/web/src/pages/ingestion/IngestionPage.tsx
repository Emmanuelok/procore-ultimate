/**
 * Ingestion & migration workspace — M6 (spec Vol III module map; Domain N;
 * ADR 0014 independent evidence streams).
 *
 * Everything that enters the platform from outside comes through here:
 *   · Runs       — staged batches: inspect, validate report, commit/discard
 *   · New import — the 4-step CSV migration wizard (upload → map → validate → commit)
 *   · Sources    — where data comes from (CSV, connectors, machine tokens)
 *   · API tokens — machine credentials for evidence-stream pushes
 *
 * Company scope: the dataset registry and sources are tenant-level; datasets
 * that land in project tables require a project on the run. The dataset
 * catalog (GET /ingestion/datasets) and the source list are loaded once here
 * and shared with every tab.
 */
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { ErrorAlert, PageHeader } from "../../ui";
import ImportWizard from "./ImportWizard";
import RunsTab from "./RunsTab";
import SourcesTab from "./SourcesTab";
import TokensTab from "./TokensTab";
import {
  TabBar,
  asList,
  type DatasetInfo,
  type ProjectPick,
  type SourceRow,
} from "./ingestionShared";

const TABS = [
  { key: "runs", label: "Runs" },
  { key: "import", label: "New import" },
  { key: "sources", label: "Sources" },
  { key: "tokens", label: "API tokens" },
];

export default function IngestionPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(() => {
    const t = searchParams.get("tab");
    return t && TABS.some((x) => x.key === t) ? t : "runs";
  });

  /* Shared reference data: dataset registry, sources, project picker list. */
  const [datasets, setDatasets] = useState<DatasetInfo[] | null>(null);
  const [datasetError, setDatasetError] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceRow[] | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectPick[] | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);

  const loadDatasets = useCallback(async () => {
    setDatasetError(null);
    try {
      const res = await api.get<unknown>("/api/v1/ingestion/datasets");
      // The catalog ships as { datasets, limits }; tolerate a bare array too.
      const obj = res && typeof res === "object" ? (res as Record<string, unknown>) : {};
      const list = Array.isArray(res)
        ? (res as DatasetInfo[])
        : Array.isArray(obj["datasets"])
          ? (obj["datasets"] as DatasetInfo[])
          : asList<DatasetInfo>(res).items;
      setDatasets(list);
    } catch (err) {
      setDatasets((prev) => prev ?? []);
      setDatasetError(
        err instanceof Error ? err.message : "Failed to load the dataset registry",
      );
    }
  }, []);

  const loadSources = useCallback(async () => {
    setSourceError(null);
    try {
      const res = await api.get<unknown>("/api/v1/ingestion/sources?page=1&pageSize=100");
      setSources(asList<SourceRow>(res).items);
    } catch (err) {
      setSources((prev) => prev ?? []);
      setSourceError(err instanceof Error ? err.message : "Failed to load ingestion sources");
    }
  }, []);

  const loadProjects = useCallback(async () => {
    setProjectError(null);
    try {
      const res = await api.get<unknown>("/api/v1/projects?page=1&pageSize=100");
      setProjects(asList<ProjectPick>(res).items);
    } catch (err) {
      setProjects((prev) => prev ?? []);
      setProjectError(err instanceof Error ? err.message : "Failed to load the project list");
    }
  }, []);

  useEffect(() => {
    void loadDatasets();
    void loadSources();
    void loadProjects();
  }, [loadDatasets, loadSources, loadProjects]);

  /* The wizard hands off to the runs tab after a commit/discard. */
  const [focusRunId, setFocusRunId] = useState<string | null>(null);

  function selectTab(key: string) {
    setTab(key);
    setSearchParams({ tab: key }, { replace: true });
  }

  return (
    <div>
      <PageHeader
        title="Ingestion & migration"
        subtitle="Every external record staged, validated against the dataset registry, and committed with file-hash provenance — nothing enters the platform silently"
      />

      <ErrorAlert message={datasetError ?? sourceError ?? projectError} />

      <TabBar tabs={TABS} active={tab} onSelect={selectTab} />

      {tab === "runs" ? (
        <RunsTab
          datasets={datasets}
          sources={sources}
          projects={projects}
          focusRunId={focusRunId}
          onFocusConsumed={() => setFocusRunId(null)}
        />
      ) : null}
      {tab === "import" ? (
        <ImportWizard
          datasets={datasets}
          sources={sources}
          projects={projects}
          onSourcesChanged={loadSources}
          onDone={(runId) => {
            setFocusRunId(runId);
            selectTab("runs");
          }}
        />
      ) : null}
      {tab === "sources" ? (
        <SourcesTab
          sources={sources}
          projects={projects}
          onReload={loadSources}
        />
      ) : null}
      {tab === "tokens" ? <TokensTab datasets={datasets} /> : null}
    </div>
  );
}
