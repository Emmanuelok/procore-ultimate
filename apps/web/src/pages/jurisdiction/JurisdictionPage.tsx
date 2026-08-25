/**
 * Multi-jurisdiction workspace — spec Vol II Domain K / module M19.
 *
 * Four registers that share one discipline: every figure is dated, attributed
 * and honest about what it does not know.
 *   · Currency splits — multi-currency contract sums with FX exposure against
 *     today's market (#593-595)
 *   · FX rates        — the dated, sourced rate register and converter that
 *     reports HOW each rate was arrived at (#597-598)
 *   · Permits         — the permit register tied to the schedule tasks it can
 *     lawfully block (#601-609)
 *   · Local content   — local spend / headcount / ICV floors and the readings
 *     measured against them (#612-615)
 */
import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { PageHeader } from "../../ui";
import CurrencyTab from "./CurrencyTab";
import FxRatesTab from "./FxRatesTab";
import LocalContentTab from "./LocalContentTab";
import PermitsTab from "./PermitsTab";
import { TabBar } from "./jurisdictionShared";

const TABS = [
  { key: "currency", label: "Currency splits" },
  { key: "fx", label: "FX rates" },
  { key: "permits", label: "Permits" },
  { key: "local", label: "Local content" },
];

export default function JurisdictionPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(() => {
    const t = searchParams.get("tab");
    return t && TABS.some((x) => x.key === t) ? t : "currency";
  });

  function selectTab(key: string) {
    setTab(key);
    setSearchParams({ tab: key }, { replace: true });
  }

  if (!projectId) return null;

  return (
    <div>
      <PageHeader
        title="Jurisdiction"
        subtitle="Multi-currency exposure, the FX rate register, permits against the schedule, and local content undertakings"
      />

      <TabBar tabs={TABS} active={tab} onSelect={selectTab} />

      {tab === "currency" ? <CurrencyTab projectId={projectId} /> : null}
      {tab === "fx" ? <FxRatesTab projectId={projectId} /> : null}
      {tab === "permits" ? <PermitsTab projectId={projectId} /> : null}
      {tab === "local" ? <LocalContentTab projectId={projectId} /> : null}
    </div>
  );
}
