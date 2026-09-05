/**
 * Delay & disruption forensics workspace — spec Vol II Domain D / M9
 * (#265-320 foundation subset): delay event register with TIA, as-planned
 * vs as-built + windows analysis, and the claims workspace.
 */
import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { PageHeader } from "../../ui";
import { TabBar } from "./forensicsShared";
import DelayEventsTab from "./DelayEventsTab";
import AnalysisTab from "./AnalysisTab";
import ClaimsTab from "./ClaimsTab";
import MethodsTab from "./MethodsTab";
import QuantumTab from "./QuantumTab";

const TABS = [
  { key: "events", label: "Delay Events" },
  { key: "analysis", label: "Analysis" },
  { key: "methods", label: "Method Suite" },
  { key: "quantum", label: "Quantum & Disruption" },
  { key: "claims", label: "Claims" },
];

export default function ForensicsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(() => {
    const t = searchParams.get("tab");
    return TABS.some((x) => x.key === t) ? (t as string) : "events";
  });

  /*
   * A deep link may name a record as well as a tab (company search emits
   * ?tab=events&id=… ). Switching tab by hand drops the id so the drawer does
   * not follow the reader around.
   */
  const focusId = searchParams.get("id");

  function selectTab(key: string) {
    setTab(key);
    setSearchParams({ tab: key }, { replace: true });
  }

  if (!projectId) return null;

  return (
    <div>
      <PageHeader
        title="Delay & Disruption Forensics"
        subtitle="Delay events, the AACE method suite, concurrency and float doctrine, quantum and disruption, and the claims workspace"
      />
      <TabBar tabs={TABS} active={tab} onSelect={selectTab} />
      {tab === "events" ? <DelayEventsTab projectId={projectId} focusId={focusId} /> : null}
      {tab === "analysis" ? <AnalysisTab projectId={projectId} /> : null}
      {tab === "methods" ? <MethodsTab projectId={projectId} /> : null}
      {tab === "quantum" ? <QuantumTab projectId={projectId} /> : null}
      {tab === "claims" ? <ClaimsTab projectId={projectId} focusId={focusId} /> : null}
    </div>
  );
}
