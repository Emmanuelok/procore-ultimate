/**
 * Ledger anchoring & escrow workspace — module M1 (spec Vol II Domain S
 * #860-861, #864, #873-874; docs/security.md §8.2 gaps 2-3).
 *
 * The platform's integrity guarantee, and the screen an auditor lives on:
 *
 *   · Chain status — the current verdict with its specifics, the heartbeat
 *                    that bounds how long a truncation can hide, key custody,
 *                    and the caveats that decide what the verdict is worth;
 *   · Seals        — the register of signed commitments, each re-verifiable
 *                    against the live chain;
 *   · Anchors      — witnessing a seal outside this deployment, with each
 *                    provider's reach and each unavailability stated exactly;
 *   · Escrow       — handing a seal to a named third party, and checking one
 *                    back without collapsing three findings into one tick.
 *
 * Reads are open to every company member, assurance roles included — gating
 * the verdict behind owner/admin would put the record's custodian between the
 * auditor and the record. Mutations are owner/admin, and are therefore
 * disabled rather than hidden.
 */
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../../ui";
import { TabBar } from "../assurance/assuranceShared";
import AnchorsTab from "./AnchorsTab";
import ChainStatusTab from "./ChainStatusTab";
import EscrowTab from "./EscrowTab";
import SealsTab from "./SealsTab";

const TABS = [
  { key: "chain", label: "Chain status" },
  { key: "seals", label: "Seals" },
  { key: "anchors", label: "Anchors" },
  { key: "escrow", label: "Escrow" },
];

export default function LedgerPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(() => {
    const t = searchParams.get("tab");
    return t && TABS.some((x) => x.key === t) ? t : "chain";
  });

  function selectTab(key: string) {
    setTab(key);
    setSearchParams({ tab: key }, { replace: true });
  }

  return (
    <div>
      <PageHeader
        title="Ledger anchoring & escrow"
        subtitle="The hash chain proves nothing was edited. Seals prove nothing was deleted or rewritten, and escrow lets someone other than us say so."
      />

      <TabBar tabs={TABS} active={tab} onSelect={selectTab} />

      {tab === "chain" ? <ChainStatusTab /> : null}
      {tab === "seals" ? <SealsTab /> : null}
      {tab === "anchors" ? <AnchorsTab /> : null}
      {tab === "escrow" ? <EscrowTab /> : null}
    </div>
  );
}
