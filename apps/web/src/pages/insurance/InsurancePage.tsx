/**
 * Insurance & Bonds workspace — spec Vol II Domain P / module M17 (#771-797).
 *
 * Six registers over one idea: cover is only worth what it is worth on the day
 * something goes wrong, and three dates decide that.
 *
 *   · Radar        — everything running out, ordered by urgency (#777-780, #794)
 *   · Policies     — the programme, its periods and its notification rules (#771-779)
 *   · Certificates — evidence of other people's cover, and who verified it (#780-781)
 *   · Bonds        — security, its reductions, and the demand deadline (#790-794)
 *   · Claims       — the notification clock that runs from AWARENESS (#783-789)
 *   · Lines & requirements — the bonding line and therefore headroom (#796), what
 *                    the contract demands, the renewal pipeline (#775) and the
 *                    loss ratio the renewal turns on (#782)
 *   · Programme    — the same picture across the estate, company-level (#795-796)
 *
 * The page is project-scoped and renders at /projects/:projectId/insurance. The
 * Programme tab is the exception: it reads the company-level endpoints, because
 * a master programme policy and a surety's exposure are not project facts.
 */
import { useCallback, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { PageHeader } from "../../ui";
import BondsTab from "./BondsTab";
import CertificatesTab from "./CertificatesTab";
import ClaimsTab from "./ClaimsTab";
import PoliciesTab from "./PoliciesTab";
import ProgrammeControlTab from "./ProgrammeControlTab";
import ProgrammeTab from "./ProgrammeTab";
import RadarTab from "./RadarTab";
import { TabBar, type FocusRequest } from "./insuranceShared";

const TABS = [
  { key: "radar", label: "Radar" },
  { key: "policies", label: "Policies" },
  { key: "certificates", label: "Certificates" },
  { key: "bonds", label: "Bonds" },
  { key: "claims", label: "Claims" },
  { key: "control", label: "Lines & requirements" },
  { key: "programme", label: "Programme" },
];

export type InsuranceTabKey =
  | "radar"
  | "policies"
  | "certificates"
  | "bonds"
  | "claims"
  | "control"
  | "programme";

export default function InsurancePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<string>(() => {
    const t = searchParams.get("tab");
    return t && TABS.some((x) => x.key === t) ? t : "radar";
  });

  /** Set when the radar sends the reader to the register that owns a record. */
  const [focus, setFocus] = useState<{ tab: string; request: FocusRequest } | null>(null);

  const selectTab = useCallback(
    (key: string) => {
      setTab(key);
      setFocus(null);
      setSearchParams({ tab: key }, { replace: true });
    },
    [setSearchParams],
  );

  const openRecord = useCallback(
    (target: InsuranceTabKey, opts?: { recordId?: string; vendorId?: string }) => {
      setTab(target);
      setSearchParams({ tab: target }, { replace: true });
      setFocus({
        tab: target,
        request: {
          recordId: opts?.recordId ?? null,
          vendorId: opts?.vendorId ?? null,
          nonce: Date.now(),
        },
      });
    },
    [setSearchParams],
  );

  const focusFor = (key: string): FocusRequest | null =>
    focus && focus.tab === key ? focus.request : null;

  if (!projectId) return null;

  return (
    <div>
      <PageHeader
        title="Insurance & Bonds"
        subtitle="Cover, evidence of other people's cover, bonds and the claim-notification clock — with the three deadlines whose breach is fatal kept in front of you"
      />

      <TabBar tabs={TABS} active={tab} onSelect={selectTab} />

      {tab === "radar" ? <RadarTab projectId={projectId} onOpen={openRecord} /> : null}
      {tab === "policies" ? (
        <PoliciesTab projectId={projectId} focus={focusFor("policies")} />
      ) : null}
      {tab === "certificates" ? (
        <CertificatesTab projectId={projectId} focus={focusFor("certificates")} />
      ) : null}
      {tab === "bonds" ? <BondsTab projectId={projectId} focus={focusFor("bonds")} /> : null}
      {tab === "claims" ? <ClaimsTab projectId={projectId} focus={focusFor("claims")} /> : null}
      {tab === "control" ? <ProgrammeControlTab projectId={projectId} /> : null}
      {tab === "programme" ? <ProgrammeTab /> : null}
    </div>
  );
}
