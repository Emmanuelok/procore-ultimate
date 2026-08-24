/**
 * Workforce rights & welfare workspace — spec Vol II Domain M / module M17
 * (#667-699): the verified worker register, ghost-worker elimination against
 * site access (#669), wage verification (#677), modern-slavery indicator
 * scoring at subcontractor level (#694), welfare and accommodation inspection
 * (#683-688) and the subcontractor labour audit programme (#697-699).
 *
 * The header is the lender-facing worker welfare KPI line (#700): people on
 * the register, unresolved rights indicators, money paid without attendance,
 * and the worst-exposed employer — the four numbers a DFI asks for first.
 */
import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { Badge, ErrorAlert, PageHeader } from "../../ui";
import AuditsTab from "./AuditsTab";
import IndicatorsTab from "./IndicatorsTab";
import RegisterTab from "./RegisterTab";
import ReconcileTab from "./ReconcileTab";
import VendorRiskTab from "./VendorRiskTab";
import WelfareTab from "./WelfareTab";
import {
  Stat,
  TabBar,
  addDays,
  bandTone,
  fmtMoney,
  isoToday,
  label,
  useVendors,
  type ListResponse,
  type ReconSummary,
  type RiskFlagRow,
  type VendorRiskResponse,
  type WorkerRow,
} from "./workforceShared";

const TABS = [
  { key: "register", label: "Worker register" },
  { key: "reconcile", label: "Payroll reconciliation" },
  { key: "indicators", label: "Rights indicators" },
  { key: "vendors", label: "Subcontractor risk" },
  { key: "welfare", label: "Welfare" },
  { key: "audits", label: "Labour audits" },
];

interface Kpis {
  workers: number;
  openIndicators: number;
  ghosts: number;
  valueAtRisk: number;
  currency: string;
  worstVendor: { name: string; score: number; band: string } | null;
}

export default function WorkforcePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(searchParams.get("tab") ?? "register");
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { vendors, error: vendorError } = useVendors();

  const load = useCallback(async () => {
    if (!projectId) return;
    const base = `/api/v1/projects/${projectId}`;
    setError(null);
    try {
      const to = isoToday();
      const from = addDays(to, -30);
      const [workerList, flagList, recon, risk] = await Promise.all([
        api.get<ListResponse<WorkerRow>>(`${base}/workers?pageSize=1`),
        api.get<ListResponse<RiskFlagRow>>(`${base}/labour-risk-flags?open=true&pageSize=1`),
        api.get<ReconSummary>(`${base}/workforce/reconciliations?from=${from}&to=${to}`),
        api.get<VendorRiskResponse>(`${base}/workforce/vendor-risk`),
      ]);
      const worst = risk.items[0];
      setKpis({
        workers: workerList.total,
        openIndicators: flagList.total,
        ghosts: recon.ghosts,
        valueAtRisk: recon.totals.valueAtRisk,
        currency: recon.rows[0]?.currency ?? "USD",
        worstVendor:
          worst && worst.score > 0
            ? { name: worst.vendorName, score: worst.score, band: worst.band }
            : null,
      });
    } catch (err) {
      setKpis(null);
      setError(err instanceof Error ? err.message : "Failed to load the workforce position");
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

  return (
    <div>
      <PageHeader
        title="Workforce rights & welfare"
        subtitle="Labour as people with rights — verified identity, wages paid for work actually done, and welfare that is inspected rather than asserted"
      />

      <ErrorAlert message={error ?? vendorError} />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Workers on register" value={kpis ? kpis.workers : "—"} />
        <Stat
          label="Open rights indicators"
          value={kpis ? kpis.openIndicators : "—"}
          tone={kpis && kpis.openIndicators > 0 ? "red" : kpis ? "green" : undefined}
          hint="Unresolved (#671-675)"
        />
        <Stat
          label="Ghost workers, 30 days"
          value={kpis ? kpis.ghosts : "—"}
          tone={kpis && kpis.ghosts > 0 ? "red" : kpis ? "green" : undefined}
          hint="Paid with no site access"
        />
        <Stat
          label="Value at risk, 30 days"
          value={kpis ? fmtMoney(kpis.valueAtRisk, kpis.currency) : "—"}
          tone={kpis && kpis.valueAtRisk > 0 ? "red" : undefined}
          emphasized
          hint="Pay with no attendance behind it"
        />
        <div className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-ink-100">
          {kpis?.worstVendor ? (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-xl font-bold tabular-nums text-ink-900">
                  {kpis.worstVendor.score}
                </span>
                <Badge tone={bandTone(kpis.worstVendor.band)}>{label(kpis.worstVendor.band)}</Badge>
              </div>
              <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-ink-400">
                Worst-exposed employer
              </div>
              <div className="mt-0.5 truncate text-xs text-ink-500" title={kpis.worstVendor.name}>
                {kpis.worstVendor.name}
              </div>
            </>
          ) : (
            <>
              <div className="text-xl font-bold text-ink-300">—</div>
              <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-ink-400">
                Worst-exposed employer
              </div>
              <div className="mt-0.5 text-xs text-ink-400">
                {kpis ? "No exposure scored yet" : "Loading…"}
              </div>
            </>
          )}
        </div>
      </div>

      <TabBar tabs={TABS} active={tab} onSelect={selectTab} />

      {tab === "register" ? (
        <RegisterTab projectId={projectId} vendors={vendors} onMutate={load} />
      ) : null}
      {tab === "reconcile" ? <ReconcileTab projectId={projectId} onMutate={load} /> : null}
      {tab === "indicators" ? (
        <IndicatorsTab projectId={projectId} vendors={vendors} onMutate={load} />
      ) : null}
      {tab === "vendors" ? <VendorRiskTab projectId={projectId} /> : null}
      {tab === "welfare" ? (
        <WelfareTab projectId={projectId} vendors={vendors} onMutate={load} />
      ) : null}
      {tab === "audits" ? (
        <AuditsTab projectId={projectId} vendors={vendors} onMutate={load} />
      ) : null}
    </div>
  );
}
