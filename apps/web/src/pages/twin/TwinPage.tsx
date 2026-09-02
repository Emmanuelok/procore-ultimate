/**
 * DIGITAL TWIN workspace (spec Vol II Domain L #627-661).
 * Routed at /projects/:projectId/twin.
 *
 * Six tabs, one asset base:
 *   Assets      the register, its hierarchy, and its binding to geometry
 *   Sensors     channels, telemetry and the alert register
 *   Warranties  cover, expiry obligations and claims
 *   Milestones  ISO 19650 information delivery and its required containers
 *   Handover    O&M readiness and the validated COBie deliverable
 *   Performance measured behaviour against design intent
 */
import { useCallback, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Alert, Badge, PageHeader, Tabs } from "../../ui";
import { IconTwin } from "../../ui/icons";
import { useResource } from "../../layouts/project/lib";
import AssetsTab from "./AssetsTab";
import HandoverTab from "./HandoverTab";
import MilestonesTab from "./MilestonesTab";
import PerformanceTab from "./PerformanceTab";
import SensorsTab from "./SensorsTab";
import WarrantiesTab from "./WarrantiesTab";
import type { TwinSummary } from "./twinShared";

type TabKey = "assets" | "sensors" | "warranties" | "milestones" | "handover" | "performance";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "assets", label: "Assets" },
  { value: "sensors", label: "Sensors" },
  { value: "warranties", label: "Warranties" },
  { value: "milestones", label: "Delivery milestones" },
  { value: "handover", label: "Handover" },
  { value: "performance", label: "Performance" },
];

const isTabKey = (value: string | null): value is TabKey =>
  value !== null && TABS.some((t) => t.value === value);

export default function TwinPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => {
    const requested = searchParams.get("tab");
    return isTabKey(requested) ? requested : "assets";
  });

  const summary = useResource<TwinSummary>(
    projectId ? `/api/v1/projects/${projectId}/twin/summary` : null,
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
        The digital twin is project-scoped: an asset is installed in one building and handed over
        with it.
      </Alert>
    );
  }

  const s = summary.data;

  return (
    <div>
      <PageHeader
        icon={IconTwin}
        title="Digital twin"
        subtitle="The asset base built during construction, bound to model geometry, watched by its sensors, covered by warranties the platform tracks, and handed over as a COBie deliverable that has been validated rather than assumed."
        meta={
          <span className="flex flex-wrap items-center gap-2">
            {s ? (
              <span>
                {s.assetsTotal} asset{s.assetsTotal === 1 ? "" : "s"} · {s.sensorsTotal} sensor
                {s.sensorsTotal === 1 ? "" : "s"} · {s.warranties.active} active warrant
                {s.warranties.active === 1 ? "y" : "ies"} ·{" "}
                {s.geometryCoverage === null ? "no geometry coverage" : `${s.geometryCoverage}% bound to geometry`}
              </span>
            ) : summary.error ? (
              <span className="text-danger-fg">Summary unavailable: {summary.error}</span>
            ) : (
              <span>Reading the asset base…</span>
            )}
            {(s?.openAlerts ?? 0) > 0 ? (
              <Badge tone="danger" size="sm" dot>
                {s?.openAlerts} open alert{s?.openAlerts === 1 ? "" : "s"}
              </Badge>
            ) : null}
            {(s?.warranties.expiringWithin90Days ?? 0) > 0 ? (
              <Badge tone="warning" size="sm" dot>
                {s?.warranties.expiringWithin90Days} warranty/warranties expiring within 90 days
              </Badge>
            ) : null}
            {(s?.milestones.overdue ?? 0) > 0 ? (
              <Badge tone="danger" size="sm" dot>
                {s?.milestones.overdue} milestone{s?.milestones.overdue === 1 ? "" : "s"} overdue
              </Badge>
            ) : null}
          </span>
        }
        tabs={
          <Tabs
            items={TABS.map((entry) => ({
              value: entry.value,
              label: entry.label,
              ...(entry.value === "sensors" && (s?.openAlerts ?? 0) > 0
                ? { count: s?.openAlerts, tone: "danger" as const }
                : {}),
              ...(entry.value === "warranties" && (s?.openClaims ?? 0) > 0
                ? { count: s?.openClaims, tone: "warning" as const }
                : {}),
              ...(entry.value === "milestones" && (s?.milestones.overdue ?? 0) > 0
                ? { count: s?.milestones.overdue, tone: "danger" as const }
                : {}),
            }))}
            value={tab}
            onChange={selectTab}
          />
        }
      />

      {tab === "assets" ? (
        <AssetsTab projectId={projectId} onChanged={summary.reload} />
      ) : tab === "sensors" ? (
        <SensorsTab projectId={projectId} summary={s} onChanged={summary.reload} />
      ) : tab === "warranties" ? (
        <WarrantiesTab projectId={projectId} onChanged={summary.reload} />
      ) : tab === "milestones" ? (
        <MilestonesTab projectId={projectId} onChanged={summary.reload} />
      ) : tab === "handover" ? (
        <HandoverTab projectId={projectId} />
      ) : (
        <PerformanceTab projectId={projectId} />
      )}
    </div>
  );
}
