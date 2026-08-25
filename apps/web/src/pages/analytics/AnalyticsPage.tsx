/**
 * Analytics workspace — cross-tool reporting & dashboards, spec Vol I
 * §6.1-6.2 (#731-751).
 *
 *   · Reports    — the builder over the whitelisted dataset registry, live
 *     preview against the real executor, paged runs with honest truncation,
 *     CSV export and recorded (not dispatched) schedules
 *   · Dashboards — prebuilt role dashboards seeded from real definitions,
 *     executed widget-by-widget under the caller's own project reach
 *
 * The dataset registry is company reference data, so it is loaded once here
 * and shared with the report builder that is driven by it.
 */
import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { PageHeader } from "../../ui";
import DashboardsTab from "./DashboardsTab";
import ReportsTab from "./ReportsTab";
import { TabBar, errorMessage, type DatasetsResponse } from "./analyticsShared";

const TABS = [
  { key: "reports", label: "Reports" },
  { key: "dashboards", label: "Dashboards" },
];

export default function AnalyticsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(() => {
    const t = searchParams.get("tab");
    return t && TABS.some((x) => x.key === t) ? t : "reports";
  });

  const [catalog, setCatalog] = useState<DatasetsResponse | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setCatalogError(null);
    try {
      const res = await api.get<DatasetsResponse>("/api/v1/analytics/datasets");
      setCatalog(res);
    } catch (err) {
      setCatalogError(errorMessage(err, "Failed to load the dataset registry"));
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  function selectTab(key: string) {
    setTab(key);
    setSearchParams({ tab: key }, { replace: true });
  }

  if (!projectId) return null;

  return (
    <div>
      <PageHeader
        title="Analytics"
        subtitle="Custom reports over the registered datasets, with live preview, honest truncation, CSV export and role dashboards"
      />

      <TabBar tabs={TABS} active={tab} onSelect={selectTab} />

      {tab === "reports" ? (
        <ReportsTab
          projectId={projectId}
          catalog={catalog}
          catalogError={catalogError}
          onReloadCatalog={() => void loadCatalog()}
        />
      ) : null}
      {tab === "dashboards" ? <DashboardsTab projectId={projectId} /> : null}
    </div>
  );
}
