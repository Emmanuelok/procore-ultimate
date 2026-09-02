/**
 * DRAWINGS — module M? (spec Vol I §2.1), routed at /projects/:projectId/drawings.
 *
 *   Sheets   the register: every sheet, its current revision and diff verdict.
 *   Sets     uploads and their processing, with a per-set QA report.
 *   Review   sheet naming queue — confirm, merge into, or discard (#258).
 *   Links    automatic callouts a person should look at (#263).
 *   Issues   distributions with acknowledgement (#280–#281).
 *   Log      the drawing log report, exportable (#281).
 *   Access   segregation by discipline / area / sheet (#265, #282).
 *
 * The summary row above the tabs comes from one cheap endpoint; every tab
 * loads its own data and fails alone.
 */
import { useCallback, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { PageHeader, Stat, Tabs } from "../../ui";
import { IconDrawing } from "../../ui/icons";
import { useResource } from "../../layouts/project/lib";
import type { DrawingsSummary } from "./drawingsShared";
import SheetsTab from "./SheetsTab";
import SetsTab from "./SetsTab";
import ReviewTab from "./ReviewTab";
import LinksTab from "./LinksTab";
import IssuesTab from "./IssuesTab";
import LogTab from "./LogTab";
import AccessTab from "./AccessTab";

type TabKey = "sheets" | "sets" | "review" | "links" | "issues" | "log" | "access";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "sheets", label: "Sheets" },
  { value: "sets", label: "Sets" },
  { value: "review", label: "Review queue" },
  { value: "links", label: "Callout links" },
  { value: "issues", label: "Issues" },
  { value: "log", label: "Drawing log" },
  { value: "access", label: "Access" },
];

const isTabKey = (v: string | null): v is TabKey => v !== null && TABS.some((t) => t.value === v);

export default function DrawingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => (isTabKey(searchParams.get("tab")) ? (searchParams.get("tab") as TabKey) : "sheets"));
  const [version, setVersion] = useState(0);
  const summary = useResource<DrawingsSummary>(projectId ? `/api/v1/projects/${projectId}/drawings/summary?_v=${version}` : null);

  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  const selectTab = useCallback(
    (next: TabKey) => {
      setTab(next);
      const params = new URLSearchParams(searchParams);
      params.set("tab", next);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  if (!projectId) return null;

  const s = summary.data;
  const processing = s ? (s.sets["pending"] ?? 0) + (s.sets["processing"] ?? 0) : null;
  const tabItems = TABS.map((t) => ({
    value: t.value,
    label: t.label,
    ...(t.value === "review" && s && s.needsReview > 0 ? { count: s.needsReview, tone: "warning" as const } : {}),
    ...(t.value === "links" && s && s.unresolvedCallouts > 0 ? { count: s.unresolvedCallouts, tone: "warning" as const } : {}),
    ...(t.value === "issues" && s && s.unacknowledgedRecipients > 0 ? { count: s.unacknowledgedRecipients, tone: "info" as const } : {}),
  }));

  return (
    <div>
      <PageHeader
        icon={IconDrawing}
        title="Drawings"
        subtitle="Sets split into sheets and revisions, with the register's review queue, callout links, distributions and segregation."
        tabs={<Tabs items={tabItems} value={tab} onChange={selectTab} />}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Sheets" value={s ? s.sheets.toLocaleString() : "—"} loading={summary.loading} hint={s?.segregated ? "Only the sheets you may see are counted." : undefined} />
        <Stat label="Need naming review" value={s ? s.needsReview.toLocaleString() : "—"} tone={s && s.needsReview > 0 ? "warning" : undefined} loading={summary.loading} />
        <Stat label="Sets processing" value={processing === null ? "—" : processing.toLocaleString()} loading={summary.loading} hint={s && (s.sets["failed"] ?? 0) > 0 ? `${s.sets["failed"]} failed` : undefined} tone={s && (s.sets["failed"] ?? 0) > 0 ? "danger" : undefined} />
        <Stat label="Unresolved callouts" value={s ? s.unresolvedCallouts.toLocaleString() : "—"} tone={s && s.unresolvedCallouts > 0 ? "warning" : undefined} loading={summary.loading} hint="Callouts to sheets that do not exist in this project." />
        <Stat label="Issues" value={s ? ((s.issues["issued"] ?? 0) + (s.issues["draft"] ?? 0)).toLocaleString() : "—"} loading={summary.loading} hint={s ? `${s.issues["draft"] ?? 0} draft · ${s.issues["issued"] ?? 0} issued` : undefined} />
        <Stat label="Awaiting acknowledgement" value={s ? s.unacknowledgedRecipients.toLocaleString() : "—"} tone={s && s.unacknowledgedRecipients > 0 ? "info" : undefined} loading={summary.loading} />
      </div>
      {summary.error ? <p className="mb-3 text-xs text-red-600">Summary unavailable: {summary.error}</p> : null}

      {tab === "sheets" ? (
        <SheetsTab projectId={projectId} version={version} byDiscipline={s?.byDiscipline ?? {}} onChanged={refresh} />
      ) : tab === "sets" ? (
        <SetsTab projectId={projectId} version={version} onChanged={refresh} />
      ) : tab === "review" ? (
        <ReviewTab projectId={projectId} version={version} onChanged={refresh} />
      ) : tab === "links" ? (
        <LinksTab projectId={projectId} version={version} onChanged={refresh} />
      ) : tab === "issues" ? (
        <IssuesTab projectId={projectId} version={version} onChanged={refresh} />
      ) : tab === "log" ? (
        <LogTab projectId={projectId} version={version} />
      ) : (
        <AccessTab projectId={projectId} version={version} onChanged={refresh} />
      )}
    </div>
  );
}
