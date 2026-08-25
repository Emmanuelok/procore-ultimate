/**
 * Benchmarks workspace — spec Vol II Domain V (#821-858) / module M11:
 * independent, anonymized cross-company benchmarking.
 *
 *   · Catalogue  — the code-resident metric registry and its access model;
 *   · Snapshots  — per-project frozen metric figures, computed from real
 *                  platform records, contributed only by explicit choice;
 *   · Distributions — the anonymized pool, one cell at a time, with n
 *                  always disclosed and suppression explained, not hidden;
 *   · Compare    — the project's snapshot placed on the distribution its
 *                  company has earned access to.
 *
 * The project selection is held here so switching between Snapshots and
 * Compare keeps the same project in hand.
 */
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { EmptyState, ErrorAlert, Field, PageHeader, Select, Spinner } from "../../ui";
import { TabBar, projectLabel, useMetrics, useProjects } from "./benchmarksShared";
import CatalogueTab from "./CatalogueTab";
import CompareTab from "./CompareTab";
import DistributionsTab from "./DistributionsTab";
import SnapshotsTab from "./SnapshotsTab";

const TABS = [
  { key: "catalogue", label: "Metric catalogue" },
  { key: "snapshots", label: "Project snapshots" },
  { key: "distributions", label: "Distributions" },
  { key: "compare", label: "Compare" },
];

export default function BenchmarksPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(() => {
    const t = searchParams.get("tab");
    return t && TABS.some((x) => x.key === t) ? t : "catalogue";
  });
  const [projectId, setProjectId] = useState("");

  const registry = useMetrics();
  const { projects, error: projectsError, reload: reloadProjects } = useProjects();

  function selectTab(key: string) {
    setTab(key);
    setSearchParams({ tab: key }, { replace: true });
  }

  const needsProject = tab === "snapshots" || tab === "compare";

  return (
    <div>
      <PageHeader
        title="Benchmarks"
        subtitle="Anonymized cross-company performance benchmarking — contribute to access, sample sizes always disclosed, small cells suppressed"
      />

      {/* the catalogue tab renders its own retryable LoadError for this */}
      <ErrorAlert message={tab === "catalogue" ? null : registry.error} />

      <TabBar tabs={TABS} active={tab} onSelect={selectTab} />

      {needsProject ? (
        <div className="mb-4">
          <ErrorAlert message={projectsError} />
          {projects === null ? (
            <Spinner label="Loading projects…" />
          ) : projects.length === 0 ? (
            <EmptyState
              title="No projects in this company"
              hint="Snapshots and comparisons are per-project. Create a project first, then come back to benchmark it."
            />
          ) : (
            <div className="max-w-md">
              <Field label="Project">
                <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">Select a project…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {projectLabel(p)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
        </div>
      ) : null}

      {tab === "catalogue" ? (
        <CatalogueTab
          metrics={registry.metrics}
          minSampleN={registry.minSampleN}
          accessModel={registry.accessModel}
          error={registry.error}
          onReload={registry.reload}
        />
      ) : null}

      {tab === "snapshots" ? (
        projectId ? (
          <SnapshotsTab
            projectId={projectId}
            metrics={registry.metrics}
            minSampleN={registry.minSampleN}
          />
        ) : projects && projects.length > 0 ? (
          <EmptyState
            title="Pick a project"
            hint="Snapshots freeze a metric's value and inputs for one project at one moment."
          />
        ) : null
      ) : null}

      {tab === "distributions" ? <DistributionsTab metrics={registry.metrics} /> : null}

      {tab === "compare" ? (
        projectId ? (
          <CompareTab projectId={projectId} metrics={registry.metrics} />
        ) : projects && projects.length > 0 ? (
          <EmptyState
            title="Pick a project"
            hint="Compare places a project's latest snapshot on the distribution this company can access."
          />
        ) : null
      ) : null}
    </div>
  );
}
