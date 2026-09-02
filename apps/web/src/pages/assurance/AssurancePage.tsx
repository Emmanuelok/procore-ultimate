/**
 * Project assurance workspace (spec Vol III M5; Vol II Domain A/S) —
 * signals, assertion-vs-evidence reconciliation, obligations, ledger
 * verification and Merkle evidence packs, in one tabbed surface, under the
 * owner-side summary a director actually looks for first.
 */
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { Badge, ErrorAlert, PageHeader, Spinner } from "../../ui";
import { StatCard, TabBar } from "./assuranceShared";
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
  { key: "packs", label: "Evidence packs" },
];

/** A figure the platform could not compute, with the reason it could not. */
interface Unknowable {
  value: null;
  reasons: string[];
}

type Measured<T> = T | Unknowable;

function isUnknowable(v: unknown): v is Unknowable {
  return Boolean(v) && typeof v === "object" && (v as Unknowable).value === null && Array.isArray((v as Unknowable).reasons);
}

interface AssuranceSummary {
  openSignals: number;
  criticalOpen: number;
  obligations: {
    open: number;
    breached: number;
    nextDeadline: { obligationId: string; deadline: string | null; daysAway: number; sourceClause: string } | null;
  };
  claimedVsVerified: Measured<{ value: number | null; basis: string; reconciliationId: string }>;
  evidenceSufficiency: Measured<{ value: number; basis: string }>;
  seal: Measured<{ sequence: number; sealedAt: string; ageHours: number | null; stale: boolean }>;
  chain: Measured<{ verdict: string; lastVerifiedSeq: number; verifiedAt: string; brokenAtSeq: number | null }>;
  integrityScore: Measured<{ value: number; band: string; computedAt: string; basis: string }>;
}

/**
 * Honest rendering: a value the API could not produce shows "not available"
 * with the reason on hover, never 0. A zero here would read as "nothing is
 * wrong", which is a different statement from "we could not tell".
 */
function Unknown({ reasons }: { reasons: string[] }) {
  return (
    <span className="text-base font-normal text-ink-400" title={reasons.join(" ")}>
      not available
    </span>
  );
}

function SummaryStrip({ projectId }: { projectId: string }) {
  const [summary, setSummary] = useState<AssuranceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<AssuranceSummary>(
          `/api/v1/projects/${projectId}/assurance/summary`,
        );
        if (!cancelled) setSummary(res);
      } catch (err) {
        if (!cancelled) {
          setSummary(null);
          setError(err instanceof Error ? err.message : "Failed to load the assurance summary");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (error) return <ErrorAlert message={error} />;
  if (!summary) return <Spinner />;

  const seal = summary.seal;
  const variance = summary.claimedVsVerified;
  const sufficiency = summary.evidenceSufficiency;
  const score = summary.integrityScore;

  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
      <StatCard
        label="Open signals"
        value={summary.openSignals}
        tone={summary.criticalOpen > 0 ? "red" : "default"}
      />
      <StatCard
        label="Claimed vs verified"
        value={
          isUnknowable(variance) ? (
            <Unknown reasons={variance.reasons} />
          ) : variance.value === null ? (
            <Unknown reasons={["the latest reconciliation produced no percentage variance"]} />
          ) : (
            <span title={variance.basis}>{variance.value.toFixed(1)}%</span>
          )
        }
        tone={!isUnknowable(variance) && (variance.value ?? 0) < -5 ? "red" : "default"}
      />
      <StatCard
        label="Evidence sufficiency"
        value={
          isUnknowable(sufficiency) ? (
            <Unknown reasons={sufficiency.reasons} />
          ) : (
            <span title={sufficiency.basis}>{(sufficiency.value * 100).toFixed(0)}%</span>
          )
        }
      />
      <StatCard
        label="Obligations"
        value={
          <span
            title={
              summary.obligations.nextDeadline
                ? `Next: ${summary.obligations.nextDeadline.sourceClause} in ${summary.obligations.nextDeadline.daysAway} day(s)`
                : "No dated obligation ahead"
            }
          >
            {summary.obligations.open}
            {summary.obligations.breached > 0 ? (
              <span className="ml-1 text-sm font-normal text-red-600">
                +{summary.obligations.breached} breached
              </span>
            ) : null}
          </span>
        }
        tone={summary.obligations.breached > 0 ? "red" : "default"}
      />
      <StatCard
        label="Chain seal"
        value={
          isUnknowable(seal) ? (
            <Unknown reasons={seal.reasons} />
          ) : (
            <span title={`Sealed ${seal.sealedAt}`}>
              #{seal.sequence}
              {seal.stale ? (
                <Badge tone="amber" className="ml-2">
                  stale
                </Badge>
              ) : null}
            </span>
          )
        }
        tone={!isUnknowable(seal) && seal.stale ? "amber" : "default"}
      />
      {!isUnknowable(score) ? (
        <div className="col-span-2 rounded-lg bg-white p-3 text-xs shadow-sm ring-1 ring-ink-100 sm:col-span-5">
          <span className="font-semibold text-ink-700">
            Integrity exposure {score.value.toFixed(1)} ({score.band})
          </span>{" "}
          <span className="text-ink-500">
            — {score.basis} 0–100, higher is worse. Computed {new Date(score.computedAt).toLocaleString()}.
          </span>
        </div>
      ) : null}
    </div>
  );
}

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
      <SummaryStrip projectId={projectId} />
      <TabBar tabs={TABS} active={tab} onSelect={selectTab} />
      {tab === "signals" ? <SignalsTab projectId={projectId} /> : null}
      {tab === "reconcile" ? <ReconcileTab projectId={projectId} /> : null}
      {tab === "obligations" ? <ObligationsTab projectId={projectId} /> : null}
      {tab === "ledger" ? <LedgerTab /> : null}
      {tab === "packs" ? <EvidencePackTab projectId={projectId} /> : null}
    </div>
  );
}
