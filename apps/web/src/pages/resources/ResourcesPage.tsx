/**
 * RESOURCE PLANNING & PRODUCTIVITY — spec Vol I §5.1–5.2 (#676–699), routed at
 * /projects/:projectId/resources.
 *
 * One question runs through every tab: is there enough of the right people and
 * plant, in the right week, and did the hours we bought buy any progress?
 *
 *   Overview      the verdict — the next shortfall, the double bookings, the
 *                 productivity factor, and what the sweeps have found
 *   Plan          the demand plan, derived from the programme, against the
 *                 supply the project has said it can field; the histogram and
 *                 the levelling suggestions
 *   Calendar      who is booked on what, and every clash
 *   Productivity  earned hours against actual by week, trade and crew; the
 *                 measured mile; hours at completion
 *   Skills        the certification matrix and who is booked without a ticket
 */
import { useCallback, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Badge, PageHeader, Stat, Tabs } from "../../ui";
import { IconUsers } from "../../ui/icons";
import CalendarTab from "./CalendarTab";
import OverviewTab from "./OverviewTab";
import PlanTab from "./PlanTab";
import ProductivityTab from "./ProductivityTab";
import SkillsTab from "./SkillsTab";
import { count, factor, hours, shortDate, useSummary } from "./resourcesShared";

type TabKey = "overview" | "plan" | "calendar" | "productivity" | "skills";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "plan", label: "Demand & supply" },
  { value: "calendar", label: "Calendar" },
  { value: "productivity", label: "Productivity" },
  { value: "skills", label: "Skills & tickets" },
];

const isTabKey = (value: string | null): value is TabKey =>
  value !== null && TABS.some((t) => t.value === value);

export default function ResourcesPage() {
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

  const tabItems = TABS.map((t) => {
    if (t.value === "plan" && s && (s.coverage.overWeeks ?? 0) > 0) {
      return { ...t, count: s.coverage.overWeeks ?? 0, tone: "danger" as const };
    }
    if (t.value === "calendar" && s && s.bookings.conflicts > 0) {
      return { ...t, count: s.bookings.conflicts, tone: "danger" as const };
    }
    if (t.value === "skills" && s && s.certifications.expired > 0) {
      return { ...t, count: s.certifications.expired, tone: "danger" as const };
    }
    if (t.value === "overview" && s && s.openSignals.total > 0) {
      return { ...t, count: s.openSignals.total, tone: "warning" as const };
    }
    return t;
  });

  const pf = s?.productivity.totals.productivityFactor ?? null;

  return (
    <div>
      <PageHeader
        icon={IconUsers}
        title="Resource planning & productivity"
        subtitle="What the programme needs, what the project can field, who is booked where, and whether the hours bought any progress"
        meta={
          s ? (
            <span className="flex flex-wrap items-center gap-2">
              {s.plan ? (
                <Badge tone="info" size="xs">
                  {s.plan.reference} · {s.plan.name}
                </Badge>
              ) : (
                <Badge tone="warning" size="xs">
                  No active resource plan
                </Badge>
              )}
              <span className="text-2xs text-content-subtle">
                {s.plan
                  ? `${count(s.plan.demandRowCount)} demand rows · derived ${
                      s.plan.derivedAt ? "from the programme" : "by hand"
                    }`
                  : "Create a plan and derive it from the schedule to see the histogram."}
              </span>
            </span>
          ) : null
        }
        tabs={<Tabs items={tabItems} value={tab} onChange={selectTab} />}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Weeks short"
          value={s ? count(s.coverage.overWeeks) : "—"}
          tone={s && (s.coverage.overWeeks ?? 0) > 0 ? "danger" : undefined}
          hint={
            s
              ? s.coverage.overWeeks === null
                ? "No active plan — unknown, not zero"
                : `Next quarter · ${count(s.coverage.unknownSupplyWeeks)} with no supply recorded`
              : undefined
          }
          loading={summary.loading}
        />
        <Stat
          label="Worst shortfall"
          value={s?.coverage.worstShortfall ? hours(s.coverage.worstShortfall.shortfallHours) : "—"}
          tone={s?.coverage.worstShortfall ? "danger" : undefined}
          hint={
            s?.coverage.worstShortfall
              ? `${s.coverage.worstShortfall.resourceTypeName} · week of ${shortDate(
                  s.coverage.worstShortfall.weekStart,
                )}`
              : "Nothing short in the next quarter"
          }
          loading={summary.loading}
        />
        <Stat
          label="Peak demand"
          value={s ? hours(s.coverage.peakDemandHours) : "—"}
          hint={
            s?.coverage.peakWeekStart
              ? `Week of ${shortDate(s.coverage.peakWeekStart)}`
              : "No demand in the window"
          }
          loading={summary.loading}
        />
        <Stat
          label="Double bookings"
          value={s ? count(s.bookings.conflicts) : "—"}
          tone={s && s.bookings.conflicts > 0 ? "danger" : undefined}
          hint={s ? `${count(s.bookings.active)} live bookings` : undefined}
          loading={summary.loading}
        />
        <Stat
          label="Productivity factor"
          value={factor(pf)}
          tone={pf === null ? undefined : pf < 0.8 ? "danger" : pf < 1 ? "warning" : "success"}
          hint={
            s
              ? pf === null
                ? "Not derivable from the hours on file"
                : `${hours(s.productivity.totals.earnedHours)} earned of ${hours(
                    s.productivity.totals.actualHours,
                  )}`
              : undefined
          }
          loading={summary.loading}
        />
        <Stat
          label="Tickets expired"
          value={s ? count(s.certifications.expired) : "—"}
          tone={s && s.certifications.expired > 0 ? "danger" : undefined}
          hint={
            s
              ? `${count(s.certifications.expiring)} expiring · ${count(
                  s.certifications.unverified,
                )} unverified`
              : undefined
          }
          loading={summary.loading}
        />
      </div>

      {tab === "overview" ? (
        <OverviewTab projectId={projectId} summary={summary} onChanged={summary.reload} />
      ) : null}
      {tab === "plan" ? <PlanTab projectId={projectId} onChanged={summary.reload} /> : null}
      {tab === "calendar" ? <CalendarTab projectId={projectId} onChanged={summary.reload} /> : null}
      {tab === "productivity" ? (
        <ProductivityTab projectId={projectId} onChanged={summary.reload} />
      ) : null}
      {tab === "skills" ? <SkillsTab projectId={projectId} onChanged={summary.reload} /> : null}
    </div>
  );
}
