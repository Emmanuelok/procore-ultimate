/**
 * BIM & COORDINATION workspace (spec §1.4-1.5, §2.14-2.15, Domain L).
 * Routed at /projects/:projectId/bim.
 *
 * Six tabs, one model of the building:
 *   Models        the container register: upload, ingestion state, ISO 19650
 *                 CDE states with a separate authoriser, quality gate, and a
 *                 version-to-version diff
 *   Coordination  the issue register a coordination meeting runs on:
 *                 assignment, comments, RFI escalation, SLA
 *   Clash         tests over a federation, the persistent result register and
 *                 one-click conversion of a group into an issue
 *   4D / 5D       elements bound to programme tasks and budget lines
 *   Capture       reality capture overlays and scan-vs-model deviation
 *   Map           geofences and every geo-tagged record on the project
 */
import { useCallback, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Alert, Badge, PageHeader, Tabs } from "../../ui";
import { IconBim } from "../../ui/icons";
import { useResource } from "../../layouts/project/lib";
import CaptureTab from "./CaptureTab";
import ClashTab from "./ClashTab";
import CoordinationTab from "./CoordinationTab";
import LinksTab from "./LinksTab";
import MapTab from "./MapTab";
import ModelsTab from "./ModelsTab";
import type { BimSummary } from "./bimShared";

type TabKey = "models" | "coordination" | "clash" | "links" | "capture" | "map";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "models", label: "Models" },
  { value: "coordination", label: "Coordination" },
  { value: "clash", label: "Clash" },
  { value: "links", label: "4D / 5D" },
  { value: "capture", label: "Reality capture" },
  { value: "map", label: "Map" },
];

const isTabKey = (value: string | null): value is TabKey =>
  value !== null && TABS.some((t) => t.value === value);

export default function BimPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => {
    const requested = searchParams.get("tab");
    return isTabKey(requested) ? requested : "models";
  });

  const summary = useResource<BimSummary>(
    projectId ? `/api/v1/projects/${projectId}/bim/summary` : null,
  );

  const selectTab = useCallback(
    (next: TabKey) => {
      setTab(next);
      const params = new URLSearchParams(searchParams);
      params.set("tab", next);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  if (!projectId) {
    return (
      <Alert tone="danger" title="No project in the route">
        The BIM workspace is project-scoped: a model belongs to one project, and so does every
        clash raised against it.
      </Alert>
    );
  }

  const s = summary.data;

  return (
    <div>
      <PageHeader
        icon={IconBim}
        title="BIM & coordination"
        subtitle="Discipline models under ISO 19650 control, clashes tracked until they are resolved, elements bound to the programme and the budget, and what was actually built compared with what was drawn."
        meta={
          <span className="flex flex-wrap items-center gap-2">
            {s ? (
              <span>
                {s.models} model{s.models === 1 ? "" : "s"} · {s.publishedVersions} published
                container{s.publishedVersions === 1 ? "" : "s"} · {s.elements.toLocaleString()}{" "}
                element{s.elements === 1 ? "" : "s"} in the current versions
              </span>
            ) : summary.error ? (
              <span className="text-danger-fg">Summary unavailable: {summary.error}</span>
            ) : (
              <span>Reading the model register…</span>
            )}
            {(s?.failedVersions ?? 0) > 0 ? (
              <Badge tone="danger" size="sm" dot>
                {s?.failedVersions} failed ingestion{s?.failedVersions === 1 ? "" : "s"}
              </Badge>
            ) : null}
            {(s?.queuedVersions ?? 0) > 0 ? (
              <Badge tone="warning" size="sm" dot>
                {s?.queuedVersions} queued for extraction
              </Badge>
            ) : null}
            {(s?.overdueIssues ?? 0) > 0 ? (
              <Badge tone="danger" size="sm" dot>
                {s?.overdueIssues} overdue issue{s?.overdueIssues === 1 ? "" : "s"}
              </Badge>
            ) : null}
          </span>
        }
        tabs={
          <Tabs
            items={TABS.map((entry) => ({
              value: entry.value,
              label: entry.label,
              ...(entry.value === "coordination" && (s?.openIssues ?? 0) > 0
                ? { count: s?.openIssues, tone: (s?.overdueIssues ?? 0) > 0 ? ("danger" as const) : ("neutral" as const) }
                : {}),
              ...(entry.value === "clash" && (s?.openClashes ?? 0) > 0
                ? { count: s?.openClashes, tone: "warning" as const }
                : {}),
              ...(entry.value === "capture" && (s?.captures ?? 0) > 0 ? { count: s?.captures } : {}),
              ...(entry.value === "map" && (s?.activeGeofences ?? 0) > 0
                ? { count: s?.activeGeofences }
                : {}),
            }))}
            value={tab}
            onChange={selectTab}
          />
        }
      />

      {tab === "models" ? (
        <ModelsTab projectId={projectId} onChanged={summary.reload} />
      ) : tab === "coordination" ? (
        <CoordinationTab projectId={projectId} onChanged={summary.reload} />
      ) : tab === "clash" ? (
        <ClashTab projectId={projectId} onChanged={summary.reload} />
      ) : tab === "links" ? (
        <LinksTab projectId={projectId} summary={summary.data} />
      ) : tab === "capture" ? (
        <CaptureTab projectId={projectId} onChanged={summary.reload} />
      ) : (
        <MapTab projectId={projectId} onChanged={summary.reload} />
      )}
    </div>
  );
}
