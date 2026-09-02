/**
 * Commercial workspace (spec Vol II Domain B / module M7) — bills of
 * quantities with method-of-measurement validation, taking-off, remeasurement,
 * dayworks, interim valuations with typed sections, payment certificates,
 * the variation register, rate analysis and fluctuations, CVR/WIP with a
 * cash-flow S-curve, and the final account.
 *
 * The header is CURRENCY-AWARE: a project holding more than one currency
 * shows a position per currency and refuses to print a combined total, because
 * £1,000,000 + AED 4,700,000 is not a number.
 */
import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { Alert, Badge, ErrorAlert, PageHeader } from "../../ui";
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
import DayworksTab from "./DayworksTab";
import MeasureTab from "./MeasureTab";
import AnalysisTab from "./AnalysisTab";
import CvrTab from "./CvrTab";
import FinalAccountTab from "./FinalAccountTab";

const TABS = [
  { key: "boq", label: "Bills of Quantities" },
  { key: "measure", label: "Remeasure & PS" },
  { key: "dayworks", label: "Dayworks" },
  { key: "valuations", label: "Valuations" },
  { key: "certificates", label: "Certificates" },
  { key: "variations", label: "Variations" },
  { key: "analysis", label: "Rates & fluctuations" },
  { key: "cvr", label: "CVR & cash flow" },
  { key: "final", label: "Final account" },
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

  function selectTab(key: string) {
    setTab(key);
    setSearchParams({ tab: key }, { replace: true });
  }

  const positions = summary?.byCurrency ?? [];
  const multi = positions.length > 1;
  const primary = positions[0] ?? null;
  const displayCurrency = summary?.currency ?? primary?.currency ?? boqs?.[0]?.currency ?? "USD";

  return (
    <div>
      <PageHeader
        title="Commercial"
        subtitle="Measurement & valuation — the BQ as the contract's commercial spine"
        actions={
          multi ? (
            <div className="flex flex-wrap gap-1">
              {positions.map((p) => (
                <Badge key={p.currency} tone="violet">
                  {p.currency}
                </Badge>
              ))}
            </div>
          ) : null
        }
      />

      <ErrorAlert message={error} />

      {summary && summary.reasons.length > 0 ? (
        <Alert tone="info" className="mb-4">
          {summary.reasons.join(" ")}
        </Alert>
      ) : null}

      {multi ? (
        <div className="mb-5 space-y-3">
          {positions.map((p) => (
            <div
              key={p.currency}
              className="grid grid-cols-2 gap-3 rounded-lg bg-ink-50 p-3 sm:grid-cols-3 lg:grid-cols-5"
            >
              <StatCard
                label={`BoQ total · ${p.currency}`}
                value={money0(p.boqTotal, p.currency)}
                hint={`${p.boqCount} bill${p.boqCount === 1 ? "" : "s"}`}
              />
              <StatCard
                label="Certified to date"
                value={money0(p.certifiedToDate, p.currency)}
                hint={`${money0(p.paidToDate, p.currency)} paid`}
              />
              <StatCard label="Retention held" value={money0(p.retentionHeld, p.currency)} />
              <StatCard
                label="Variations agreed"
                value={money0(p.variationsAgreed, p.currency)}
                hint={`${money0(p.variationsPending, p.currency)} pending`}
              />
              <StatCard
                label="Forecast final"
                value={money0(p.forecastFinal, p.currency)}
                tone="emphasis"
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label="BoQ total" value={money0(summary?.boqTotal, displayCurrency)} />
          <StatCard
            label="Certified to date"
            value={money0(summary?.certifiedToDate, displayCurrency)}
            hint={
              summary?.paidToDate != null
                ? `${money0(summary.paidToDate, displayCurrency)} paid`
                : undefined
            }
          />
          <StatCard label="Retention held" value={money0(summary?.retentionHeld, displayCurrency)} />
          <StatCard
            label="Variations agreed"
            value={money0(summary?.variationsAgreed, displayCurrency)}
            hint={
              summary?.variationsPending != null
                ? `${money0(summary.variationsPending, displayCurrency)} pending`
                : undefined
            }
          />
          <StatCard
            label="Forecast final"
            value={money0(summary?.forecastFinal, displayCurrency)}
            tone="emphasis"
          />
        </div>
      )}

      <TabBar tabs={TABS} active={tab} onSelect={selectTab} />

      {tab === "boq" ? <BoqTab projectId={projectId} boqs={boqs} onMutate={load} /> : null}
      {tab === "measure" ? (
        <MeasureTab projectId={projectId} boqs={boqs} currency={displayCurrency} onMutate={load} />
      ) : null}
      {tab === "dayworks" ? (
        <DayworksTab projectId={projectId} currency={displayCurrency} onMutate={load} />
      ) : null}
      {tab === "valuations" ? (
        <ValuationsTab projectId={projectId} boqs={boqs} onMutate={load} />
      ) : null}
      {tab === "certificates" ? (
        <CertificatesTab projectId={projectId} boqs={boqs} onMutate={load} />
      ) : null}
      {tab === "variations" ? (
        <VariationsTab
          projectId={projectId}
          boqs={boqs}
          currency={displayCurrency}
          onMutate={load}
        />
      ) : null}
      {tab === "analysis" ? (
        <AnalysisTab projectId={projectId} boqs={boqs} currency={displayCurrency} />
      ) : null}
      {tab === "cvr" ? (
        <CvrTab projectId={projectId} currencies={positions.map((p) => p.currency)} />
      ) : null}
      {tab === "final" ? <FinalAccountTab projectId={projectId} onMutate={load} /> : null}
    </div>
  );
}
