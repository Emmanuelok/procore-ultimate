/**
 * SITE OPERATIONS & REALITY CAPTURE — workspace (spec Vol II Z #1067–1084,
 * X #995–1003; Vol I §2.15 #471–478). Routed at /projects/:projectId/site.
 *
 * Eight tabs, one site:
 *   Overview   who is on it, what is live, what the sweeps found
 *   Access     inductions → passes → gate feed → register → musters
 *   Permits    permits to work, confined-space entries, zones, lone working
 *   Weather    the archive, the contract baseline, exceptional weather, and
 *              the environmental / seismic / tidal event log
 *   Capture    drone flights, scans, scan-vs-model deviations, 360° tours
 *   Survey     control points and setting out, checked by a second person
 *   Ground     investigations against the baseline, services, strikes
 *   Progress   claimed versus observed, as Assertion + Evidence + Reconciliation
 *   Plan       an equirectangular plan of the site's own points — no tiles
 */
import { useCallback, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Alert, Badge, PageHeader, Tabs } from "../../ui";
import { IconSite } from "../../ui/icons";
import AccessTab from "./AccessTab";
import CaptureTab from "./CaptureTab";
import GroundTab from "./GroundTab";
import OverviewTab from "./OverviewTab";
import PermitsTab from "./PermitsTab";
import PlanTab from "./PlanTab";
import ProgressTab from "./ProgressTab";
import SurveyTab from "./SurveyTab";
import WeatherTab from "./WeatherTab";
import { dateTime, num, useResource, useSiteLookups, type Summary } from "./siteShared";

type TabKey = "overview" | "access" | "permits" | "weather" | "capture" | "survey" | "ground" | "progress" | "plan";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "access", label: "Access" },
  { value: "permits", label: "Permits" },
  { value: "weather", label: "Weather" },
  { value: "capture", label: "Reality capture" },
  { value: "survey", label: "Survey" },
  { value: "ground", label: "Ground" },
  { value: "progress", label: "Progress" },
  { value: "plan", label: "Plan" },
];

const isTabKey = (value: string | null): value is TabKey => value !== null && TABS.some((t) => t.value === value);

export default function SitePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => {
    const requested = searchParams.get("tab");
    return isTabKey(requested) ? requested : "overview";
  });

  const summary = useResource<Summary>(projectId ? `/api/v1/projects/${projectId}/site/summary` : null);
  const lookups = useSiteLookups(projectId ?? "");

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
        Site operations are project-scoped: a permit is issued on one site, a muster counts the people inside one boundary.
      </Alert>
    );
  }

  const s = summary.data;
  const lifeSafety = (s?.entries.overdue ?? 0) + (s?.loneWorkers.escalated ?? 0);
  const onChanged = summary.reload;

  return (
    <div>
      <PageHeader
        icon={IconSite}
        title="Site operations & reality capture"
        subtitle="Who is on the site, what they are allowed to do, what the sky and the ground did to it, what it actually looks like — and whether the progress being claimed is the progress that is there."
        meta={
          <span className="flex flex-wrap items-center gap-2">
            {s ? (
              <span>
                {s.register.reasons.length > 0 && s.register.headcount === 0
                  ? "Headcount unavailable — no gate feed"
                  : `${num(s.register.headcount)} on site`}{" "}
                · {num(s.permits.active)} permit{s.permits.active === 1 ? "" : "s"} active · {num(s.entries.inside)} in a permitted space ·{" "}
                {num(s.loneWorkers.active)} lone worker{s.loneWorkers.active === 1 ? "" : "s"} · as at {dateTime(s.asOf)}
              </span>
            ) : summary.error ? (
              <span className="text-danger-fg">Summary unavailable: {summary.error}</span>
            ) : (
              <span>Reading the site…</span>
            )}
            {lifeSafety > 0 ? (
              <Badge tone="danger" size="sm" dot>
                {lifeSafety} life-safety alert{lifeSafety === 1 ? "" : "s"}
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
              ...(entry.value === "overview" && (s?.signals.open ?? 0) > 0 ? { count: s?.signals.open, tone: "warning" as const } : {}),
              ...(entry.value === "permits" && lifeSafety > 0 ? { count: lifeSafety, tone: "danger" as const } : {}),
              ...(entry.value === "access" && (s?.register.overstays ?? 0) > 0 ? { count: s?.register.overstays, tone: "warning" as const } : {}),
              ...(entry.value === "ground" && (s?.ground.openFindings ?? 0) > 0 ? { count: s?.ground.openFindings, tone: "warning" as const } : {}),
              ...(entry.value === "capture" && (s?.capture.deviationsOutOfTolerance ?? 0) > 0
                ? { count: s?.capture.deviationsOutOfTolerance, tone: "danger" as const }
                : {}),
              ...(entry.value === "survey" && (s?.settingOut.awaitingCheck ?? 0) > 0 ? { count: s?.settingOut.awaitingCheck, tone: "info" as const } : {}),
              ...(entry.value === "progress" && (s?.progress.overclaims ?? 0) > 0 ? { count: s?.progress.overclaims, tone: "danger" as const } : {}),
            }))}
            value={tab}
            onChange={selectTab}
          />
        }
      />

      {tab === "overview" ? (
        <OverviewTab projectId={projectId} summary={summary} onOpenTab={selectTab} />
      ) : tab === "access" ? (
        <AccessTab projectId={projectId} lookups={lookups} onChanged={onChanged} />
      ) : tab === "permits" ? (
        <PermitsTab projectId={projectId} lookups={lookups} onChanged={onChanged} />
      ) : tab === "weather" ? (
        <WeatherTab projectId={projectId} onChanged={onChanged} />
      ) : tab === "capture" ? (
        <CaptureTab projectId={projectId} lookups={lookups} onChanged={onChanged} />
      ) : tab === "survey" ? (
        <SurveyTab projectId={projectId} lookups={lookups} onChanged={onChanged} />
      ) : tab === "ground" ? (
        <GroundTab projectId={projectId} lookups={lookups} onChanged={onChanged} />
      ) : tab === "plan" ? (
        <PlanTab projectId={projectId} />
      ) : (
        <ProgressTab projectId={projectId} lookups={lookups} onChanged={onChanged} />
      )}
    </div>
  );
}
