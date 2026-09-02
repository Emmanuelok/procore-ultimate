/**
 * Land, resettlement & community workspace — spec Vol III Tier 4 / module
 * M16, Vol II Domain J (#547-592 subset). The category of work Procore has
 * no concept of, and frequently the largest single source of delay on
 * internationally financed infrastructure.
 *
 * Five views under one header: the RAP dashboard a lender's E&S supervision
 * mission reads first, then the four registers it is computed from — land
 * parcels, the affected-household census, grievance redress, and the
 * stakeholder and engagement log. Compliance frame: IFC Performance
 * Standard 5 / World Bank ESS5.
 */
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { Badge, ErrorAlert, PageHeader, Spinner } from "../../ui";
import { formatDate } from "../format";
import CommunityTab from "./CommunityTab";
import GrievancesTab from "./GrievancesTab";
import ParcelsTab from "./ParcelsTab";
import PapsTab from "./PapsTab";
import RapTab from "./RapTab";
import {
  type GrievanceAnalytics,
  type RapProgress,
  type ScheduleRisk,
} from "./landShared";

type TabKey = "rap" | "parcels" | "households" | "grievances" | "community";

const TABS: { key: TabKey; label: string; hint: string }[] = [
  { key: "rap", label: "RAP dashboard", hint: "#558, #568, #591" },
  { key: "parcels", label: "Land parcels", hint: "#547-554" },
  { key: "households", label: "Affected households", hint: "#555-568" },
  { key: "grievances", label: "Grievances", hint: "#569-574" },
  { key: "community", label: "Stakeholders", hint: "#575-584" },
];

export default function LandPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const base = `/api/v1/projects/${projectId}`;

  const [tab, setTab] = useState<TabKey>("rap");
  const [rap, setRap] = useState<RapProgress | null>(null);
  const [risk, setRisk] = useState<ScheduleRisk | null>(null);
  const [grm, setGrm] = useState<GrievanceAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focusParcelId, setFocusParcelId] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    if (!projectId) return;
    setError(null);
    try {
      const [r, sr, g] = await Promise.all([
        api.get<RapProgress>(`${base}/land/rap-progress`),
        api.get<ScheduleRisk>(`${base}/land/schedule-risk?days=90`),
        api.get<GrievanceAnalytics>(`${base}/grievances/analytics`),
      ]);
      setRap(r);
      setRisk(sr);
      setGrm(g);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the land workspace");
    } finally {
      setLoading(false);
    }
  }, [base, projectId]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const openParcel = useCallback((parcelId: string) => {
    setFocusParcelId(parcelId);
    setTab("parcels");
  }, []);

  const clearFocus = useCallback(() => setFocusParcelId(null), []);

  if (!projectId) return null;

  const imminent = risk
    ? risk.items.filter((i) => i.daysUntilStart <= risk.signalHorizonDays).length
    : 0;
  const overdue = grm?.openOverdue ?? 0;

  return (
    <div>
      <PageHeader
        title="Land, Resettlement & Community"
        subtitle="Parcel acquisition, the affected-household census and entitlement matrix, grievance redress and stakeholder engagement — IFC Performance Standard 5 / World Bank ESS5"
        actions={
          loading ? null : rap?.cutOffDate ? (
            <span title="Households censused after the cut-off date are encroachment, not project-affected persons (#564)">
              <Badge tone="blue">Cut-off {formatDate(rap.cutOffDate)}</Badge>
            </span>
          ) : (
            <span title="Until a cut-off date is declared, the entitlement population can be inflated after the fact (#564)">
              <Badge tone="amber">No cut-off declared</Badge>
            </span>
          )
        }
      />

      <ErrorAlert message={error} />

      {loading ? (
        <Spinner label="Loading the land workspace…" />
      ) : (
        <>
          {/* Only surfaced when something is actually wrong — an always-on
              banner stops being read within a week. */}
          {imminent > 0 || overdue > 0 ? (
            <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-red-50 px-4 py-2.5 text-sm ring-1 ring-red-200">
              <span className="font-semibold text-red-800">Needs attention</span>
              {imminent > 0 ? (
                <span className="text-red-700">
                  <span className="font-semibold tabular-nums">{imminent}</span> works package
                  {imminent === 1 ? "" : "s"} about to start on unacquired land{" "}
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 font-medium underline underline-offset-2 hover:bg-red-100"
                    onClick={() => setTab("rap")}
                  >
                    Review
                  </button>
                </span>
              ) : null}
              {overdue > 0 ? (
                <span className="text-red-700">
                  <span className="font-semibold tabular-nums">{overdue}</span> grievance
                  {overdue === 1 ? "" : "s"} past the published SLA{" "}
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 font-medium underline underline-offset-2 hover:bg-red-100"
                    onClick={() => setTab("grievances")}
                  >
                    Review
                  </button>
                </span>
              ) : null}
            </div>
          ) : null}

          <div className="mb-4 flex flex-wrap gap-1 border-b border-ink-100">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                  tab === t.key
                    ? "border-brand-600 text-brand-700"
                    : "border-transparent text-ink-500 hover:border-ink-200 hover:text-ink-800"
                }`}
              >
                {t.label}
                <span className="ml-1.5 text-[11px] font-normal text-ink-300">{t.hint}</span>
              </button>
            ))}
          </div>

          {tab === "rap" ? <RapTab rap={rap} risk={risk} onOpenParcel={openParcel} /> : null}
          {tab === "parcels" ? (
            <ParcelsTab
              projectId={projectId}
              focusParcelId={focusParcelId}
              onFocusHandled={clearFocus}
              onChanged={() => void loadOverview()}
            />
          ) : null}
          {tab === "households" ? (
            <PapsTab projectId={projectId} onChanged={() => void loadOverview()} />
          ) : null}
          {tab === "grievances" ? (
            <GrievancesTab projectId={projectId} onChanged={() => void loadOverview()} />
          ) : null}
          {tab === "community" ? <CommunityTab projectId={projectId} /> : null}
        </>
      )}
    </div>
  );
}
