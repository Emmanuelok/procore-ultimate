/**
 * ESG & Carbon workspace — spec Vol II Domain I / module M18.
 *
 * Four registers that share one discipline: every number is traced to the
 * quantity, factor, movement or evidence record it came from.
 *   · Carbon    — EN 15978 life-cycle assessment with budgets (#491-501)
 *   · Waste     — movements by stream with diversion from landfill (#513-514)
 *   · Social value — tender promise reconciled against delivery (#527-540)
 *   · Factors   — the tenant carbon factor library behind all of it (#496-498)
 *
 * The factor library is company reference data rather than project data, so
 * it is loaded once here and shared with the carbon register that consumes it.
 */
import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { PageHeader } from "../../ui";
import CarbonTab from "./CarbonTab";
import FactorsTab from "./FactorsTab";
import SocialValueTab from "./SocialValueTab";
import WasteTab from "./WasteTab";
import { TabBar, type FactorRow, type ListResponse } from "./esgShared";

const TABS = [
  { key: "carbon", label: "Carbon" },
  { key: "waste", label: "Waste" },
  { key: "social", label: "Social value" },
  { key: "factors", label: "Factors" },
];

export default function EsgPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(() => {
    const t = searchParams.get("tab");
    return t && TABS.some((x) => x.key === t) ? t : "carbon";
  });

  const [factors, setFactors] = useState<FactorRow[] | null>(null);
  const [factorError, setFactorError] = useState<string | null>(null);

  const loadFactors = useCallback(async () => {
    setFactorError(null);
    try {
      const res = await api.get<ListResponse<FactorRow>>("/api/v1/carbon-factors?pageSize=200");
      setFactors(res.items);
    } catch (err) {
      setFactors((prev) => prev ?? []);
      setFactorError(err instanceof Error ? err.message : "Failed to load the carbon factor library");
    }
  }, []);

  useEffect(() => {
    void loadFactors();
  }, [loadFactors]);

  function selectTab(key: string) {
    setTab(key);
    setSearchParams({ tab: key }, { replace: true });
  }

  if (!projectId) return null;

  return (
    <div>
      <PageHeader
        title="ESG & Carbon"
        subtitle="Whole-life carbon to EN 15978, waste diversion, and social value reconciled tender promise against delivery"
      />

      <TabBar tabs={TABS} active={tab} onSelect={selectTab} />

      {tab === "carbon" ? (
        <CarbonTab
          projectId={projectId}
          factors={factors}
          onFactorsNeeded={() => void loadFactors()}
        />
      ) : null}
      {tab === "waste" ? <WasteTab projectId={projectId} /> : null}
      {tab === "social" ? <SocialValueTab projectId={projectId} /> : null}
      {tab === "factors" ? (
        <FactorsTab factors={factors} error={factorError} onReload={loadFactors} />
      ) : null}
    </div>
  );
}
