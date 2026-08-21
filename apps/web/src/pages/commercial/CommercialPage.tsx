/**
 * Commercial workspace (spec Vol II Domain B / module M7) — Bills of
 * Quantities, taking-off, interim valuations, payment certificates and the
 * variation register, under a persistent cost-position header (#184 seed).
 */
import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { ErrorAlert, PageHeader } from "../../ui";
import {
  money0,
  StatCard,
  TabBar,
  type BoqRow,
  type CommercialSummary,
  type ListResponse,
} from "./commercialShared";
import BoqTab from "./BoqTab";
import ValuationsTab from "./ValuationsTab";
import CertificatesTab from "./CertificatesTab";
import VariationsTab from "./VariationsTab";

const TABS = [
  { key: "boq", label: "Bills of Quantities" },
  { key: "valuations", label: "Valuations" },
  { key: "certificates", label: "Certificates" },
  { key: "variations", label: "Variations" },
];

export default function CommercialPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(searchParams.get("tab") ?? "boq");

  const [summary, setSummary] = useState<CommercialSummary | null>(null);
  const [boqs, setBoqs] = useState<BoqRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setError(null);
    try {
      const [sum, list] = await Promise.all([
        api.get<CommercialSummary>(`/api/v1/projects/${projectId}/commercial/summary`),
        api.get<ListResponse<BoqRow>>(`/api/v1/projects/${projectId}/boqs?pageSize=100`),
      ]);
      setSummary(sum);
      setBoqs(list?.items ?? []);
    } catch (err) {
      setBoqs((prev) => prev ?? []);
      setError(err instanceof Error ? err.message : "Failed to load the commercial position");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!projectId) return null;

  const currency = boqs?.[0]?.currency ?? "USD";

  function selectTab(key: string) {
    setTab(key);
    setSearchParams({ tab: key }, { replace: true });
  }

  return (
    <div>
      <PageHeader
        title="Commercial"
        subtitle="Measurement & valuation — the BQ as the contract's commercial spine"
      />

      <ErrorAlert message={error} />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="BoQ total" value={money0(summary?.boqTotal, currency)} />
        <StatCard label="Certified to date" value={money0(summary?.certifiedToDate, currency)} />
        <StatCard label="Retention held" value={money0(summary?.retentionHeld, currency)} />
        <StatCard
          label="Variations agreed"
          value={money0(summary?.variationsAgreed, currency)}
          hint={
            summary ? `${money0(summary.variationsPending, currency)} pending` : undefined
          }
        />
        <StatCard
          label="Forecast final"
          value={money0(summary?.forecastFinal, currency)}
          tone="emphasis"
        />
      </div>

      <TabBar tabs={TABS} active={tab} onSelect={selectTab} />

      {tab === "boq" ? <BoqTab projectId={projectId} boqs={boqs} onMutate={load} /> : null}
      {tab === "valuations" ? (
        <ValuationsTab projectId={projectId} boqs={boqs} onMutate={load} />
      ) : null}
      {tab === "certificates" ? <CertificatesTab projectId={projectId} boqs={boqs} /> : null}
      {tab === "variations" ? (
        <VariationsTab projectId={projectId} boqs={boqs} currency={currency} onMutate={load} />
      ) : null}
    </div>
  );
}
