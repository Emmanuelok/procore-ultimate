/**
 * Project assurance workspace (spec Vol III M5; Vol II Domain A/S) —
 * signals, assertion-vs-evidence reconciliation, obligations, ledger
 * verification and Merkle evidence packs, in one tabbed surface.
 */
import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { PageHeader } from "../../ui";
import { TabBar } from "./assuranceShared";
import SignalsTab from "./SignalsTab";
import ReconcileTab from "./ReconcileTab";
import ObligationsTab from "./ObligationsTab";
import LedgerTab from "./LedgerTab";
import EvidencePackTab from "./EvidencePackTab";

const TABS = [
  { key: "signals", label: "Signals" },
  { key: "reconcile", label: "Reconcile" },
  { key: "obligations", label: "Obligations" },
  { key: "ledger", label: "Ledger" },
  { key: "packs", label: "Evidence pack" },
];

export default function AssurancePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(searchParams.get("tab") ?? "signals");

  if (!projectId) return null;

  function selectTab(key: string) {
    setTab(key);
    setSearchParams({ tab: key }, { replace: true });
  }

  return (
    <div>
      <PageHeader
        title="Assurance"
        subtitle="Evidence-first integrity layer — every claim tested, every mutation chained"
      />
      <TabBar tabs={TABS} active={tab} onSelect={selectTab} />
      {tab === "signals" ? <SignalsTab projectId={projectId} /> : null}
      {tab === "reconcile" ? <ReconcileTab projectId={projectId} /> : null}
      {tab === "obligations" ? <ObligationsTab projectId={projectId} /> : null}
      {tab === "ledger" ? <LedgerTab /> : null}
      {tab === "packs" ? <EvidencePackTab projectId={projectId} /> : null}
    </div>
  );
}
