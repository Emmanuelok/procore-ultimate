/**
 * COMMERCIAL STRUCTURES (project scope) — spec Vol II Domain Z #1053–#1066.
 * Routed at /projects/:projectId/portfolio.
 *
 * These are the four instruments a project is actually delivered through when
 * it is not a simple lump sum:
 *
 *   Call-offs    what has been bought off a framework or a term contract,
 *                with the route it travelled and the ceiling it consumed
 *   Ventures     the JV or consortium delivering it — partner shares, capital
 *                calls, distributions and deed governance
 *   Target cost  the pain/gain position, its bands, its caps and the alliance
 *                split, with the arithmetic printed next to the number
 *   Open book    defined cost tested against the Schedule of Cost Components,
 *                the disallowed cost register and the audit-rights log
 *
 * Every money figure carries its currency and none is summed across.
 */
import { useCallback, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Badge, PageHeader, Stat, Tabs } from "../../ui";
import { IconContract } from "../../ui/icons";
import CallOffsTab from "./CallOffsTab";
import OpenBookTab from "./OpenBookTab";
import TargetCostTab from "./TargetCostTab";
import VenturesTab from "./VenturesTab";
import { num, pct, useResource, type ProjectPortfolioSummary } from "./portfolioShared";

type TabKey = "calloffs" | "ventures" | "target" | "openbook";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "calloffs", label: "Call-offs" },
  { value: "ventures", label: "Joint ventures" },
  { value: "target", label: "Target cost" },
  { value: "openbook", label: "Open book" },
];

const isTabKey = (value: string | null): value is TabKey =>
  value !== null && TABS.some((t) => t.value === value);

export default function ProjectPortfolioPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => {
    const t = searchParams.get("tab");
    return isTabKey(t) ? t : "calloffs";
  });

  const selectTab = useCallback(
    (key: TabKey) => {
      setTab(key);
      setSearchParams({ tab: key }, { replace: true });
    },
    [setSearchParams],
  );

  const summary = useResource<ProjectPortfolioSummary>(
    projectId ? `/api/v1/projects/${projectId}/portfolio/summary` : null,
  );
  const s = summary.data;

  if (!projectId) return null;

  const tabItems = TABS.map((t) => {
    if (t.value === "ventures" && s && s.ventures.overdueContributions > 0) {
      return { ...t, count: s.ventures.overdueContributions, tone: "danger" as const };
    }
    if (t.value === "openbook" && s) {
      const flagged = s.disallowed.unresolved + s.openBook.overduePlanned + s.auditRights.obstructed;
      if (flagged > 0) return { ...t, count: flagged, tone: "warning" as const };
    }
    return t;
  });

  return (
    <div>
      <PageHeader
        icon={IconContract}
        title="Commercial structures"
        subtitle="Call-offs, joint ventures, target cost and open-book verification — the instruments this project is delivered through"
        meta={
          s ? (
            <span className="flex flex-wrap items-center gap-2">
              {s.funding.byCurrency.length > 1 ? (
                <Badge tone="warning" size="xs">
                  Funded in {s.funding.byCurrency.length} currencies — never combined
                </Badge>
              ) : null}
              {s.targetCost.worstTarget ? (
                <Badge
                  tone={(s.targetCost.worstVariancePercent ?? 0) > 0 ? "danger" : "success"}
                  size="xs"
                  dot
                >
                  {s.targetCost.worstTarget.name}: {pct(s.targetCost.worstVariancePercent)} vs target
                </Badge>
              ) : null}
            </span>
          ) : null
        }
        tabs={<Tabs items={tabItems} value={tab} onChange={selectTab} />}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Live call-offs"
          value={s ? num(s.callOffs.live) : "—"}
          hint={s ? `${num(s.callOffs.total)} in total` : undefined}
          loading={summary.loading}
        />
        <Stat
          label="Funding allocations"
          value={s ? num(s.funding.allocations) : "—"}
          hint={s ? `${num(s.funding.approved)} approved` : undefined}
          loading={summary.loading}
        />
        <Stat
          label="Ventures"
          value={s ? num(s.ventures.active) : "—"}
          tone={s && s.ventures.overdueContributions > 0 ? "danger" : undefined}
          hint={s ? `${num(s.ventures.overdueContributions)} overdue contribution(s)` : undefined}
          loading={summary.loading}
        />
        <Stat
          label="Target cost variance"
          value={s ? pct(s.targetCost.worstVariancePercent) : "—"}
          tone={s && (s.targetCost.worstVariancePercent ?? 0) > 0 ? "danger" : undefined}
          higherIsBetter={false}
          hint={s && s.targetCost.active === 0 ? "No active model" : "Worst live model"}
          loading={summary.loading}
        />
        <Stat
          label="Verifications"
          value={s ? num(s.openBook.verifications) : "—"}
          tone={s && s.openBook.overduePlanned > 0 ? "warning" : undefined}
          hint={s ? `${num(s.openBook.overduePlanned)} planned and not started` : undefined}
          loading={summary.loading}
        />
        <Stat
          label="Disallowed unresolved"
          value={s ? num(s.disallowed.unresolved) : "—"}
          tone={s && s.disallowed.unresolved > 0 ? "danger" : undefined}
          hint={s ? `${num(s.disallowed.withoutGround)} cite no clause` : undefined}
          loading={summary.loading}
        />
      </div>

      {tab === "calloffs" ? <CallOffsTab projectId={projectId} onChanged={summary.reload} /> : null}
      {tab === "ventures" ? <VenturesTab projectId={projectId} onChanged={summary.reload} /> : null}
      {tab === "target" ? <TargetCostTab projectId={projectId} onChanged={summary.reload} /> : null}
      {tab === "openbook" ? <OpenBookTab projectId={projectId} onChanged={summary.reload} /> : null}
    </div>
  );
}
