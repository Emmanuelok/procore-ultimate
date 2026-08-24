/**
 * Governance workspace — spec Vol III Domain G / M12 (#394-421 subset):
 * five-case business cases with a discounted options appraisal under
 * optimism bias, OGC/IPA-style stage gates with RAG delivery confidence and
 * conditions tracked to closure, and the benefits realisation register.
 */
import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { PageHeader } from "../../ui";
import { TabBar } from "./governanceShared";
import BusinessCasesTab from "./BusinessCasesTab";
import StageGatesTab from "./StageGatesTab";
import BenefitsTab from "./BenefitsTab";

const TABS = [
  { key: "business-case", label: "Business case" },
  { key: "stage-gates", label: "Stage gates" },
  { key: "benefits", label: "Benefits" },
];

export default function GovernancePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(searchParams.get("tab") ?? "business-case");

  if (!projectId) return null;

  function selectTab(key: string) {
    setTab(key);
    setSearchParams({ tab: key }, { replace: true });
  }

  return (
    <div>
      <PageHeader
        title="Governance"
        subtitle="Business cases, gateway assurance and benefits realisation — the owner's capital programme discipline"
      />

      <TabBar tabs={TABS} active={tab} onSelect={selectTab} />

      {tab === "business-case" ? <BusinessCasesTab projectId={projectId} /> : null}
      {tab === "stage-gates" ? <StageGatesTab projectId={projectId} /> : null}
      {tab === "benefits" ? <BenefitsTab projectId={projectId} /> : null}
    </div>
  );
}
