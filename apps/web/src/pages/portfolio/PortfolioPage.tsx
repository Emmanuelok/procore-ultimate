/**
 * PORTFOLIO COMMAND (company scope) — spec Vol I §7 (#776–#789), Vol II
 * Domain G (#423–#434), Domain Z (#1053–#1056).
 *
 * The question this page answers is the owner's, not the project manager's:
 * what has been authorised, what has been committed against it, what is left,
 * which schemes matter most, and what can still be bought without going
 * outside an agreement.
 *
 *   Overview        portfolio roll-up by currency, the stage-gate pipeline
 *                   across projects, and the controls that have tripped
 *   Money           funding sources → appropriations → allocations, with
 *                   virements and the carry-forward chain
 *   Affordability   the envelope demand is measured against, and the
 *                   capital/revenue split
 *   Prioritisation  the MCDA model, the scores under it and the ranking,
 *                   with the influence each criterion actually carries
 *   Frameworks      agreements, lots, appointed suppliers, mini-competitions
 *   Term contracts  schedules of rates and what has been called off them
 *
 * Money is bucketed by currency everywhere and never summed across; a figure
 * the API returned as null renders "—" with its reason, never 0.
 */
import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge, PageHeader, Stat, Tabs } from "../../ui";
import { IconProcurement } from "../../ui/icons";
import AffordabilityTab from "./AffordabilityTab";
import FrameworksTab from "./FrameworksTab";
import MoneyTab from "./MoneyTab";
import OverviewTab from "./OverviewTab";
import PrioritisationTab from "./PrioritisationTab";
import TermContractsTab from "./TermContractsTab";
import {
  num,
  useResource,
  type OverviewResponse,
} from "./portfolioShared";

type TabKey = "overview" | "money" | "affordability" | "prioritisation" | "frameworks" | "term";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "money", label: "Money authority" },
  { value: "affordability", label: "Affordability" },
  { value: "prioritisation", label: "Prioritisation" },
  { value: "frameworks", label: "Frameworks" },
  { value: "term", label: "Term contracts" },
];

const isTabKey = (value: string | null): value is TabKey =>
  value !== null && TABS.some((t) => t.value === value);

export default function PortfolioPage() {
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

  const overview = useResource<OverviewResponse>("/api/v1/portfolio/overview");
  const o = overview.data;

  const openSignals = o ? o.signals.reduce((sum, s) => sum + s.count, 0) : null;
  const criticalSignals = o
    ? o.signals
        .filter((s) => s.severity === "critical" || s.severity === "high")
        .reduce((sum, s) => sum + s.count, 0)
    : 0;

  const tabItems = TABS.map((t) => {
    if (t.value === "affordability" && o) {
      const breached = o.affordability.lines.filter((l) => l.breached).length;
      if (breached > 0) return { ...t, count: breached, tone: "danger" as const };
    }
    if (t.value === "money" && o && o.appropriations.overcommitted + o.fundingSources.overdrawn > 0) {
      return {
        ...t,
        count: o.appropriations.overcommitted + o.fundingSources.overdrawn,
        tone: "danger" as const,
      };
    }
    if (t.value === "frameworks" && o) {
      const flagged = o.frameworks.breached + o.frameworks.expiringWithin90Days;
      if (flagged > 0) return { ...t, count: flagged, tone: "warning" as const };
    }
    return t;
  });

  return (
    <div>
      <PageHeader
        icon={IconProcurement}
        title="Portfolio"
        subtitle="What has been authorised, what it has been committed to, and what can still be bought — by currency, never summed across"
        meta={
          o ? (
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral" size="xs">
                {num(o.projects.live)} live project{o.projects.live === 1 ? "" : "s"}
              </Badge>
              {o.projects.sandbox > 0 ? (
                <Badge tone="info" size="xs">
                  {num(o.projects.sandbox)} sandbox excluded
                </Badge>
              ) : null}
              {criticalSignals > 0 ? (
                <Badge tone="danger" size="xs" dot>
                  {num(criticalSignals)} high-severity control breach
                  {criticalSignals === 1 ? "" : "es"}
                </Badge>
              ) : null}
            </span>
          ) : null
        }
        tabs={<Tabs items={tabItems} value={tab} onChange={selectTab} />}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Projects"
          value={o ? num(o.projects.live) : "—"}
          hint={o ? `${num(o.pipeline.projectsWithoutGates)} without stage gates` : undefined}
          loading={overview.loading}
        />
        <Stat
          label="Funding sources"
          value={o ? num(o.fundingSources.total) : "—"}
          tone={o && o.fundingSources.overdrawn > 0 ? "danger" : undefined}
          hint={o ? `${num(o.fundingSources.overdrawn)} over-allocated` : undefined}
          loading={overview.loading}
        />
        <Stat
          label="Appropriations"
          value={o ? num(o.appropriations.total) : "—"}
          tone={o && o.appropriations.overcommitted > 0 ? "danger" : undefined}
          hint={o ? `${num(o.appropriations.overcommitted)} overcommitted` : undefined}
          loading={overview.loading}
        />
        <Stat
          label="Gates overdue"
          value={o ? num(o.pipeline.gatesOverdue) : "—"}
          tone={o && o.pipeline.gatesOverdue > 0 ? "warning" : undefined}
          hint="Undecided past their planned date"
          loading={overview.loading}
        />
        <Stat
          label="Live frameworks"
          value={o ? num(o.frameworks.live) : "—"}
          tone={o && o.frameworks.breached > 0 ? "danger" : undefined}
          hint={
            o
              ? `${num(o.frameworks.breached)} over ceiling · ${num(o.frameworks.expiringWithin90Days)} expiring`
              : undefined
          }
          loading={overview.loading}
        />
        <Stat
          label="Open control breaches"
          value={openSignals === null ? "—" : num(openSignals)}
          tone={openSignals !== null && openSignals > 0 ? "danger" : undefined}
          hint="Signals raised by the portfolio sweeps"
          loading={overview.loading}
        />
      </div>

      {tab === "overview" ? <OverviewTab overview={overview} /> : null}
      {tab === "money" ? <MoneyTab onChanged={overview.reload} /> : null}
      {tab === "affordability" ? <AffordabilityTab onChanged={overview.reload} /> : null}
      {tab === "prioritisation" ? <PrioritisationTab /> : null}
      {tab === "frameworks" ? <FrameworksTab onChanged={overview.reload} /> : null}
      {tab === "term" ? <TermContractsTab onChanged={overview.reload} /> : null}
    </div>
  );
}
