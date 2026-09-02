/**
 * SUPPLY CHAIN, LOGISTICS & OFFSITE — workspace (spec Vol II Domain U
 * #913–947; Vol I §5.4 #719–730). Routed at /projects/:projectId/supply-chain.
 *
 * Seven tabs, one chain:
 *   Overview    what is late, what is at risk, what the sweeps found
 *   Map         who supplies whom, tier by tier, with risk on every node
 *   Long-lead   order-by dates from the programme, milestones, expediting
 *   Offsite     units in the factory, QA gates, verified-for-payment
 *   Logistics   gates, slot booking, arrivals, on-time %, transport carbon
 *   Traceability heat/batch → certificate → installed location
 *   Risk        the supplier risk engine's verdict per node, with its basis
 */
import { useCallback, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Alert, Badge, PageHeader, Tabs } from "../../ui";
import { IconProcurement } from "../../ui/icons";
import LogisticsTab from "./LogisticsTab";
import LongLeadTab from "./LongLeadTab";
import MapTab from "./MapTab";
import OffsiteTab from "./OffsiteTab";
import OverviewTab from "./OverviewTab";
import RiskTab from "./RiskTab";
import TraceabilityTab from "./TraceabilityTab";
import { isoDate, useLookups, useResource, type Summary } from "./supplychainShared";

type TabKey = "overview" | "map" | "long-lead" | "offsite" | "logistics" | "trace" | "risk";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "map", label: "Map" },
  { value: "long-lead", label: "Long-lead" },
  { value: "offsite", label: "Offsite" },
  { value: "logistics", label: "Logistics" },
  { value: "trace", label: "Traceability" },
  { value: "risk", label: "Supplier risk" },
];

const isTabKey = (value: string | null): value is TabKey => value !== null && TABS.some((t) => t.value === value);

export default function SupplyChainPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => {
    const requested = searchParams.get("tab");
    return isTabKey(requested) ? requested : "overview";
  });

  const summary = useResource<Summary>(projectId ? `/api/v1/projects/${projectId}/supply-chain/summary` : null);
  const lookups = useLookups(projectId ?? "");

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
        The supply chain workspace is project-scoped: a long-lead item is late against one programme, a delivery comes through one site's gate.
      </Alert>
    );
  }

  const s = summary.data;
  const late = (s?.longLead.late ?? 0) + (s?.longLead.atRisk ?? 0);
  const riskBad = (s?.map.byRiskLevel["critical"] ?? 0) + (s?.map.byRiskLevel["high"] ?? 0);
  const onChanged = summary.reload;

  return (
    <div>
      <PageHeader
        icon={IconProcurement}
        title="Supply chain, logistics & offsite"
        subtitle="Order-by dates the programme dictates, deliveries booked against the tasks they feed, factory progress verified by someone other than the factory, and every heat number traced to where it went."
        meta={
          <span className="flex flex-wrap items-center gap-2">
            {s ? (
              <span>
                {s.longLead.open} open long-lead item{s.longLead.open === 1 ? "" : "s"} · {s.deliveries.upcoming} upcoming deliver{s.deliveries.upcoming === 1 ? "y" : "ies"} · {s.offsite.inFactory} unit{s.offsite.inFactory === 1 ? "" : "s"} in the factory · {s.map.nodes} node{s.map.nodes === 1 ? "" : "s"} on the map · as of {isoDate(s.asOf)}
              </span>
            ) : summary.error ? (
              <span className="text-danger-fg">Summary unavailable: {summary.error}</span>
            ) : (
              <span>Reading the supply chain…</span>
            )}
            {late > 0 ? (
              <Badge tone="danger" size="sm" dot>
                {late} late or at risk
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
              ...(entry.value === "long-lead" && late > 0 ? { count: late, tone: "danger" as const } : {}),
              ...(entry.value === "offsite" && (s?.offsite.qaHold ?? 0) > 0 ? { count: s?.offsite.qaHold, tone: "danger" as const } : {}),
              ...(entry.value === "logistics" && (s?.deliveries.noShows ?? 0) > 0 ? { count: s?.deliveries.noShows, tone: "warning" as const } : {}),
              ...(entry.value === "trace" && (s?.traceability.installedWithoutCertificate ?? 0) > 0 ? { count: s?.traceability.installedWithoutCertificate, tone: "warning" as const } : {}),
              ...(entry.value === "risk" && riskBad > 0 ? { count: riskBad, tone: "danger" as const } : {}),
              ...(entry.value === "overview" && (s?.signals.open ?? 0) > 0 ? { count: s?.signals.open, tone: "warning" as const } : {}),
            }))}
            value={tab}
            onChange={selectTab}
          />
        }
      />

      {tab === "overview" ? (
        <OverviewTab projectId={projectId} summary={summary} onOpenTab={(t) => selectTab(t as TabKey)} />
      ) : tab === "map" ? (
        <MapTab projectId={projectId} lookups={lookups} onChanged={onChanged} />
      ) : tab === "long-lead" ? (
        <LongLeadTab projectId={projectId} lookups={lookups} onChanged={onChanged} />
      ) : tab === "offsite" ? (
        <OffsiteTab projectId={projectId} lookups={lookups} onChanged={onChanged} />
      ) : tab === "logistics" ? (
        <LogisticsTab projectId={projectId} lookups={lookups} onChanged={onChanged} />
      ) : tab === "trace" ? (
        <TraceabilityTab projectId={projectId} lookups={lookups} onChanged={onChanged} />
      ) : (
        <RiskTab projectId={projectId} onChanged={onChanged} />
      )}
    </div>
  );
}
