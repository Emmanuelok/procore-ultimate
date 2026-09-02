/**
 * DESIGN MANAGEMENT & UPSTREAM CHANGE CONTROL — workspace (spec Vol I §1.5
 * #249–255; Vol II Domain T #886–912). Routed at /projects/:projectId/design.
 *
 * Seven tabs, one upstream record:
 *   Overview     what is late, what is unanswered, what the sweeps found
 *   Stages       the RIBA/AIA/ISO 19650 plan and its gates, with criteria
 *   Packages     the units that get issued, reviewed, approved and frozen
 *   Reviews      cycles, reviewers, consolidated codes and comments
 *   Issues       the discipline-routed register and the decision log
 *   Deliverables the consultant schedule, its slippage and the design team
 *   Change       design change notices, impact assessment and freezes
 *   Readiness    handover readiness and the information requirements
 */
import { useCallback, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Alert, Badge, PageHeader, Tabs } from "../../ui";
import { IconCompass } from "../../ui/icons";
import ChangeControlTab from "./ChangeControlTab";
import DeliverablesTab from "./DeliverablesTab";
import IssuesTab from "./IssuesTab";
import OverviewTab from "./OverviewTab";
import PackagesTab from "./PackagesTab";
import ReadinessTab from "./ReadinessTab";
import ReviewsTab from "./ReviewsTab";
import { isoDate, useLookups, useResource, type Summary } from "./designShared";

type TabKey = "overview" | "packages" | "reviews" | "issues" | "deliverables" | "change" | "readiness";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "packages", label: "Stages & packages" },
  { value: "reviews", label: "Reviews" },
  { value: "issues", label: "Issues & decisions" },
  { value: "deliverables", label: "Deliverables" },
  { value: "change", label: "Change control" },
  { value: "readiness", label: "Readiness" },
];

const isTabKey = (value: string | null): value is TabKey => value !== null && TABS.some((t) => t.value === value);

export default function DesignPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => {
    const requested = searchParams.get("tab");
    return isTabKey(requested) ? requested : "overview";
  });

  const summary = useResource<Summary>(projectId ? `/api/v1/projects/${projectId}/design/summary` : null);
  const lookups = useLookups(projectId ?? "");

  const selectTab = useCallback(
    (next: string) => {
      if (!isTabKey(next)) return;
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
        The design workspace is project-scoped: a package is frozen on one project, a deliverable is late against one
        programme.
      </Alert>
    );
  }

  const s = summary.data;
  const onChanged = () => {
    summary.reload();
    lookups.reload();
  };
  const deliverablesBad = (s?.deliverables.late ?? 0) + (s?.deliverables.atRisk ?? 0);

  return (
    <div>
      <PageHeader
        icon={IconCompass}
        title="Design management & upstream change control"
        subtitle="What we were told to build, when we knew it, who changed it after it was fixed — and what that change costs before it reaches the site."
        meta={
          <span className="flex flex-wrap items-center gap-2">
            {s ? (
              <span>
                {s.packages.total} package{s.packages.total === 1 ? "" : "s"} · {s.reviews.open} open review
                {s.reviews.open === 1 ? "" : "s"} · {s.issues.open} open issue{s.issues.open === 1 ? "" : "s"} ·{" "}
                {s.changeNotices.open} change notice{s.changeNotices.open === 1 ? "" : "s"} in flight · as of{" "}
                {isoDate(s.asOf)}
                {s.stages.current ? ` · current stage ${s.stages.current.label ?? s.stages.current.stageKey}` : ""}
              </span>
            ) : summary.error ? (
              <span className="text-danger-fg">Summary unavailable: {summary.error}</span>
            ) : (
              <span>Reading the design record…</span>
            )}
            {deliverablesBad > 0 ? (
              <Badge tone={s && s.deliverables.late > 0 ? "danger" : "warning"} size="sm" dot>
                {deliverablesBad} deliverable{deliverablesBad === 1 ? "" : "s"} late or at risk
              </Badge>
            ) : null}
            {(s?.changeNotices.postFreeze ?? 0) > 0 ? (
              <Badge tone="danger" size="sm" dot>
                {s?.changeNotices.postFreeze} post-freeze change{s?.changeNotices.postFreeze === 1 ? "" : "s"}
              </Badge>
            ) : null}
            {(s?.signals.open ?? 0) > 0 ? (
              <Badge tone="warning" size="sm" dot>
                {s?.signals.open} open signal{s?.signals.open === 1 ? "" : "s"}
              </Badge>
            ) : null}
          </span>
        }
        tabs={
          <Tabs
            items={TABS.map((entry) => ({
              value: entry.value,
              label: entry.label,
              ...(entry.value === "reviews" && (s?.reviews.overdue ?? 0) > 0
                ? { count: s?.reviews.overdue, tone: "danger" as const }
                : {}),
              ...(entry.value === "issues" && (s?.issues.criticalOpen ?? 0) > 0
                ? { count: s?.issues.criticalOpen, tone: "danger" as const }
                : {}),
              ...(entry.value === "deliverables" && deliverablesBad > 0
                ? { count: deliverablesBad, tone: s && s.deliverables.late > 0 ? ("danger" as const) : ("warning" as const) }
                : {}),
              ...(entry.value === "change" && (s?.changeNotices.open ?? 0) > 0
                ? { count: s?.changeNotices.open, tone: "info" as const }
                : {}),
              ...(entry.value === "readiness" && (s?.infoRequirements.overdue ?? 0) > 0
                ? { count: s?.infoRequirements.overdue, tone: "warning" as const }
                : {}),
              ...(entry.value === "overview" && (s?.signals.open ?? 0) > 0
                ? { count: s?.signals.open, tone: "warning" as const }
                : {}),
            }))}
            value={tab}
            onChange={selectTab}
          />
        }
      />

      {tab === "overview" ? (
        <OverviewTab projectId={projectId} summary={summary} onOpenTab={selectTab} />
      ) : tab === "packages" ? (
        <PackagesTab projectId={projectId} lookups={lookups} onChanged={onChanged} />
      ) : tab === "reviews" ? (
        <ReviewsTab projectId={projectId} lookups={lookups} onChanged={onChanged} />
      ) : tab === "issues" ? (
        <IssuesTab projectId={projectId} lookups={lookups} onChanged={onChanged} />
      ) : tab === "deliverables" ? (
        <DeliverablesTab projectId={projectId} lookups={lookups} onChanged={onChanged} />
      ) : tab === "change" ? (
        <ChangeControlTab projectId={projectId} lookups={lookups} onChanged={onChanged} />
      ) : (
        <ReadinessTab projectId={projectId} lookups={lookups} onChanged={onChanged} />
      )}
    </div>
  );
}
