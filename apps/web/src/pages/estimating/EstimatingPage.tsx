/**
 * ESTIMATING & TAKEOFF — spec Vol I §1.2 (#184–208), routed at
 * /projects/:projectId/estimating.
 *
 * One idea runs through every tab: an estimate is only worth what its
 * build-up is worth, so every number on screen sits next to where the
 * quantity was measured, where the rate came from and how old that rate is.
 *
 *   Overview     the live estimate, the money by currency, and what the
 *                sweeps have found wrong
 *   Estimates    the register and the workspace: grid, markups, versions,
 *                comparison, conversion to budget, proposals
 *   Takeoff      layers, the scale calculator, and every measurement with the
 *                geometry and calibration it was taken at
 *   Quotes       subcontract quotes, levelled on scope rather than on totals
 *   Proposals    what was sent to the client, frozen
 *   Library      the company rate catalogue, assemblies, crews, rates
 */
import { useCallback, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Badge, PageHeader, Stat, Tabs } from "../../ui";
import { IconRuler } from "../../ui/icons";
import EstimatesTab from "./EstimatesTab";
import LibraryTab from "./LibraryTab";
import OverviewTab from "./OverviewTab";
import ProposalsTab from "./ProposalsTab";
import QuotesTab from "./QuotesTab";
import TakeoffTab from "./TakeoffTab";
import { count, money0, useSummary } from "./estimatingShared";

type TabKey = "overview" | "estimates" | "takeoff" | "quotes" | "proposals" | "library";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "estimates", label: "Estimates" },
  { value: "takeoff", label: "Takeoff" },
  { value: "quotes", label: "Sub-quotes" },
  { value: "proposals", label: "Proposals" },
  { value: "library", label: "Rate library" },
];

const isTabKey = (value: string | null): value is TabKey =>
  value !== null && TABS.some((t) => t.value === value);

export default function EstimatingPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => {
    const t = searchParams.get("tab");
    return isTabKey(t) ? t : "overview";
  });

  const selectTab = useCallback(
    (key: TabKey) => {
      setTab(key);
      setSearchParams({ tab: key }, { replace: true });
    },
    [setSearchParams],
  );

  const summary = useSummary(projectId ?? "");
  const s = summary.data;

  if (!projectId) return null;

  const single = s && s.byCurrency.length === 1 ? s.byCurrency[0] : undefined;

  const tabItems = TABS.map((t) => {
    if (t.value === "takeoff" && s && s.takeoff.unpriced > 0) {
      return { ...t, count: s.takeoff.unpriced, tone: "warning" as const };
    }
    if (t.value === "quotes" && s && (s.subQuotes.byStatus["expired"] ?? 0) > 0) {
      return { ...t, count: s.subQuotes.byStatus["expired"] ?? 0, tone: "danger" as const };
    }
    if (t.value === "overview" && s && s.openSignals.total > 0) {
      return { ...t, count: s.openSignals.total, tone: "danger" as const };
    }
    return t;
  });

  return (
    <div>
      <PageHeader
        icon={IconRuler}
        title="Estimating & Takeoff"
        subtitle="Measured quantities, built-up rates and the version history behind every number — from the first sketch to the budget the project is measured against"
        meta={
          s ? (
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={s.estimates.live > 0 ? "info" : "warning"} size="xs">
                {s.estimates.live > 0
                  ? `${s.estimates.live} live estimate${s.estimates.live === 1 ? "" : "s"}`
                  : "No live estimate"}
              </Badge>
              {s.latestEstimate ? (
                <span className="text-2xs text-content-subtle">
                  Latest: {s.latestEstimate.reference} rev {s.latestEstimate.version} ·{" "}
                  {money0(s.latestEstimate.total, s.latestEstimate.currency)}
                </span>
              ) : (
                <span className="text-2xs text-content-subtle">
                  Nothing has been priced on this project yet.
                </span>
              )}
            </span>
          ) : null
        }
        tabs={<Tabs items={tabItems} value={tab} onChange={selectTab} />}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Live estimates"
          value={s ? count(s.estimates.live) : "—"}
          hint={s ? `${count(s.estimates.total)} including superseded` : undefined}
          loading={summary.loading}
        />
        <Stat
          label={single ? `Priced (${single.currency})` : "Priced value"}
          value={
            s
              ? single
                ? money0(single.total, single.currency)
                : s.byCurrency.length === 0
                  ? "—"
                  : `${s.byCurrency.length} currencies`
              : "—"
          }
          hint={
            s && s.byCurrency.length > 1
              ? "Never summed across currencies — see the Overview tab"
              : s && s.byCurrency.length === 0
                ? "No priced estimate yet"
                : undefined
          }
          loading={summary.loading}
        />
        <Stat
          label="Approved, unconverted"
          value={s ? count(s.estimates.approvedUnconverted) : "—"}
          tone={s && s.estimates.approvedUnconverted > 0 ? "warning" : undefined}
          hint="Signed off but not yet a budget"
          loading={summary.loading}
        />
        <Stat
          label="Takeoff unpriced"
          value={s ? count(s.takeoff.unpriced) : "—"}
          tone={s && s.takeoff.unpriced > 0 ? "warning" : undefined}
          hint={s ? `${count(s.takeoff.total)} measurements on file` : undefined}
          loading={summary.loading}
        />
        <Stat
          label="Stale-rate lines"
          value={s ? count(s.staleRateLines) : "—"}
          tone={s && s.staleRateLines > 0 ? "warning" : undefined}
          hint={s ? `Rates older than ${s.staleThresholdDays} days` : undefined}
          loading={summary.loading}
        />
        <Stat
          label="Open findings"
          value={s ? count(s.openSignals.total) : "—"}
          tone={s && s.openSignals.total > 0 ? "danger" : undefined}
          hint="Raised by the estimating sweeps"
          loading={summary.loading}
        />
      </div>

      {tab === "overview" ? (
        <OverviewTab projectId={projectId} summary={summary} onChanged={summary.reload} />
      ) : null}
      {tab === "estimates" ? <EstimatesTab projectId={projectId} onChanged={summary.reload} /> : null}
      {tab === "takeoff" ? <TakeoffTab projectId={projectId} onChanged={summary.reload} /> : null}
      {tab === "quotes" ? <QuotesTab projectId={projectId} onChanged={summary.reload} /> : null}
      {tab === "proposals" ? <ProposalsTab projectId={projectId} onChanged={summary.reload} /> : null}
      {tab === "library" ? <LibraryTab projectId={projectId} /> : null}
    </div>
  );
}
