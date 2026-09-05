/**
 * Project intelligence — the project-level view of the intelligence layer
 * (Vol I §6.1–6.3 #731–758; Vol II X #1010–1012). Health broken down by
 * dimension with its basis and the raw inputs, the trend and history of
 * snapshots, the attention feed for this project, and the agents' activity
 * and briefings.
 *
 * Every figure is the server's. An unrated dimension says why; a null
 * score is "—"; the inputs drawer shows exactly the numbers the score was
 * derived from, so nobody has to trust a number they cannot trace.
 */
import { useCallback, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiClientError } from "../../lib/api";
import { useResource } from "../../layouts/project/lib";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorAlert,
  LineChart,
  PageHeader,
  Skeleton,
  Stat,
  Table,
  Tabs,
  Td,
  Th,
  formatNumber,
  formatRelativeTime,
  formatStatusLabel,
} from "../../ui";
import { IconActivity, IconAi, IconHistory, IconInsight, IconTarget, IconWarning } from "../../ui/icons";
import { formatDateTime } from "../format";
import {
  ActivityPanel,
  AttentionDrawer,
  AttentionStatusFilter,
  AttentionTable,
  BriefingCard,
  DIMENSION_META,
  DimensionDrawer,
  DimensionList,
  LEVEL_META,
  LevelBadge,
  PanelSkeleton,
  READ_ONLY_HINT,
  RefreshButton,
  ScoreRing,
  TrendSparkline,
  attentionEmpty,
  errorMessage,
  statusHint,
  type ActivityResponse,
  type AttentionItem,
  type AttentionList,
  type AttentionStatus,
  type BriefingLatest,
  type BriefingView,
  type HealthDimension,
  type HealthHistory,
  type ProjectHealth,
} from "./intelShared";

type TabKey = "health" | "attention" | "history" | "agents";

function HealthHero({ health, loading, error, onRetry }: { health: ProjectHealth | null; loading: boolean; error: string | null; onRetry: () => void }) {
  if (loading) {
    return (
      <Card>
        <CardBody>
          <div className="flex gap-4">
            <Skeleton variant="circle" width={88} height={88} />
            <div className="flex-1">
              <Skeleton variant="text" width="30%" height={24} />
              <Skeleton className="mt-2" variant="text" lines={2} />
            </div>
          </div>
        </CardBody>
      </Card>
    );
  }
  if (error) {
    return (
      <Card>
        <CardBody>
          <ErrorAlert title="Health could not be read" message={error} onRetry={onRetry} />
        </CardBody>
      </Card>
    );
  }
  if (!health) return null;
  const rated = health.ratedDimensions ?? health.dimensions.filter((d) => d.score !== null).length;
  const weak = health.dimensions.filter((d) => d.score !== null && d.level !== "on_track");
  return (
    <Card accent={LEVEL_META[health.level].tone}>
      <CardBody>
        <div className="flex flex-wrap items-start gap-5">
          <ScoreRing score={health.score} level={health.level} size={88} thickness={7} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold text-content">{LEVEL_META[health.level].label}</h2>
              <LevelBadge level={health.level} />
              {health.levelChanged && health.previousLevel ? (
                <Badge tone="info" size="xs">
                  was {LEVEL_META[health.previousLevel].label.toLowerCase()}
                </Badge>
              ) : null}
            </div>
            <p className="mt-1.5 text-body leading-relaxed text-content-muted">{health.basis ?? "Weighted mean of the rated dimensions."}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-content-subtle">
              <span title={formatDateTime(health.computedAt)}>
                Computed {formatRelativeTime(health.computedAt)}
                {health.computedOnRead ? " (on this read)" : ""}
              </span>
              <span>
                {rated} of {health.dimensions.length} dimensions rated
              </span>
              <span className="flex items-center gap-2">
                Trend <TrendSparkline trend={health.trend} width={120} height={24} />
              </span>
            </div>
            {weak.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {weak.map((d) => (
                  <Badge key={d.key} tone={LEVEL_META[d.level].tone} size="xs" title={d.basis}>
                    {DIMENSION_META[d.key]?.label ?? formatStatusLabel(d.key)} {d.score}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function HistoryPanel({ history, loading, error, onRetry }: { history: HealthHistory | null; loading: boolean; error: string | null; onRetry: () => void }) {
  const chart = useMemo(
    () =>
      [...(history?.items ?? [])]
        .reverse()
        .map((i) => ({ at: i.computedAt, day: i.computedAt.slice(0, 16).replace("T", " "), score: i.score })),
    [history],
  );
  if (loading) return <PanelSkeleton rows={6} />;
  if (error) return <ErrorAlert message={error} onRetry={onRetry} />;
  const items = history?.items ?? [];
  if (items.length === 0) {
    return <EmptyState icon={IconHistory} title="No snapshots yet" hint="Every computation is kept for ninety days; the first one happens on the first read." />;
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <Card>
        <CardHeader title="Score over time" subtitle={`Every snapshot in the last ${history?.days ?? 30} days · gaps are unrated computations, not zeros`} />
        <CardBody>
          {chart.length < 2 ? (
            <p className="text-meta text-content-subtle">One snapshot so far — a line needs two.</p>
          ) : (
            <LineChart
              data={chart}
              categoryKey="day"
              height={240}
              series={[{ key: "score", label: "Health score", tone: "accent" }]}
              valueDomain={[0, 100]}
              references={[
                { y: 75, label: "On track ≥ 75", tone: "success" },
                { y: 50, label: "Watch ≥ 50", tone: "warning" },
              ]}
              ariaLabel="Project health score over time"
            />
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Snapshots" subtitle="Newest first" />
        <CardBody flush>
          <Table flush dense stickyHeader>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Level</Th>
                <Th numeric>Score</Th>
                <Th>Trigger</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <Td muted title={formatDateTime(i.computedAt)}>{formatRelativeTime(i.computedAt)}</Td>
                  <Td>
                    <LevelBadge level={i.level} size="xs" />
                  </Td>
                  <Td numeric>{i.score === null ? <span className="text-content-subtle">—</span> : i.score}</Td>
                  <Td muted>{formatStatusLabel(i.trigger)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardBody>
      </Card>
    </div>
  );
}

export default function IntelligencePage() {
  const { projectId = "" } = useParams<{ projectId: string }>();
  const base = `/api/v1/projects/${projectId}`;
  const [tab, setTab] = useState<TabKey>("health");
  const [attentionStatus, setAttentionStatus] = useState<AttentionStatus>("open");
  const [dimension, setDimension] = useState<HealthDimension | null>(null);
  const [selected, setSelected] = useState<AttentionItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [generating, setGenerating] = useState(false);

  const health = useResource<ProjectHealth>(`${base}/health`);
  // The open feed drives the counters whatever the table is showing; the
  // other two states are their own request, so a dismissal stays findable and
  // the reopen route is reachable.
  const openAttention = useResource<AttentionList>(`${base}/attention?limit=200&status=open`);
  const otherAttention = useResource<AttentionList>(
    attentionStatus === "open" ? null : `${base}/attention?limit=200&status=${attentionStatus}`,
  );
  const attention = attentionStatus === "open" ? openAttention : otherAttention;
  const reloadAttention = useCallback(() => {
    openAttention.reload();
    otherAttention.reload();
  }, [openAttention, otherAttention]);
  const history = useResource<HealthHistory>(`${base}/health/history?days=30`);
  const activity = useResource<ActivityResponse>(`${base}/intelligence/activity?limit=20`);
  const briefing = useResource<BriefingLatest>(`${base}/intelligence/briefing`);

  const recompute = useCallback(async () => {
    setRecomputing(true);
    try {
      const r = await api.post<ProjectHealth>(`${base}/health/recompute`, {});
      toast.success(
        r.levelChanged && r.previousLevel
          ? `Recomputed: ${LEVEL_META[r.previousLevel].label} → ${LEVEL_META[r.level].label}`
          : `Recomputed: ${LEVEL_META[r.level].label}${r.score !== null ? ` (${r.score}/100)` : ""}`,
      );
      health.reload();
      history.reload();
      reloadAttention();
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 403) toast.error("Recomputing needs standard access to intelligence on this project.");
      else toast.error(errorMessage(err, "The recompute failed."));
    } finally {
      setRecomputing(false);
    }
  }, [base, health, history, reloadAttention]);

  const generate = useCallback(async () => {
    setGenerating(true);
    try {
      const r = await api.post<{ briefing: BriefingView; reviewIds: string[]; dropped: { highlights: number; actions: number } }>(`${base}/intelligence/briefing`, {});
      toast.success(`Briefing written · ${r.briefing.highlights.length} highlight${r.briefing.highlights.length === 1 ? "" : "s"} · ${r.reviewIds.length} proposal${r.reviewIds.length === 1 ? "" : "s"} queued for review`);
      briefing.reload();
      activity.reload();
      setTab("agents");
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 503) toast.error("AI is not configured on this server, so no briefing can be written.");
      else if (err instanceof ApiClientError && err.status === 403) toast.error("Writing a briefing needs standard access to intelligence on this project.");
      else toast.error(errorMessage(err, "The briefing could not be written."));
    } finally {
      setGenerating(false);
    }
  }, [base, briefing, activity]);

  const dismiss = useCallback(
    async (item: AttentionItem, reason: string) => {
      setBusy(true);
      try {
        await api.post(`${base}/attention/${item.id}/dismiss`, reason ? { reason } : {});
        toast.success("Set aside — recorded on the ledger.");
        setSelected(null);
        reloadAttention();
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 403) toast.error("Dismissing needs standard access to intelligence on this project.");
        else toast.error(errorMessage(err, "Could not dismiss the item."));
      } finally {
        setBusy(false);
      }
    },
    [base, reloadAttention],
  );

  const reopen = useCallback(
    async (item: AttentionItem) => {
      setBusy(true);
      try {
        await api.post(`${base}/attention/${item.id}/reopen`, {});
        toast.success("Reopened.");
        setSelected(null);
        reloadAttention();
      } catch (err) {
        toast.error(errorMessage(err, "Could not reopen the item."));
      } finally {
        setBusy(false);
      }
    },
    [base, reloadAttention],
  );

  const h = health.data;
  const items = attention.data?.items ?? [];
  // the counters always describe the OPEN feed, whichever state the table shows
  const openItems = openAttention.data?.items ?? [];
  const critical = openItems.filter((i) => i.severity === "critical").length;
  const overdue = openItems.filter((i) => i.dueAt !== null && Date.parse(i.dueAt) < Date.now()).length;
  const aiEnabled = briefing.data?.aiEnabled ?? activity.data?.aiEnabled ?? false;
  const offTrackDims = h ? h.dimensions.filter((d) => d.level === "off_track").length : null;
  // The project attention route resolves the caller's level once for the whole
  // page; until it has answered we assume they may act, so the buttons do not
  // flicker for the people who can.
  const canAct = openAttention.data?.canAct ?? true;

  const tabs = useMemo(
    () => [
      { value: "health" as const, label: "Health", icon: IconTarget },
      { value: "attention" as const, label: "Attention", icon: IconWarning, count: openAttention.data?.total, tone: critical > 0 ? ("danger" as const) : undefined },
      { value: "history" as const, label: "History", icon: IconHistory, count: history.data?.items.length },
      { value: "agents" as const, label: "Agents", icon: IconActivity, count: activity.data?.pendingProposals || undefined },
    ],
    [openAttention.data, critical, history.data, activity.data],
  );

  return (
    <div className="flex flex-col gap-section">
      <PageHeader
        icon={IconInsight}
        title="Intelligence"
        subtitle="How healthy this project is and why, what needs a decision, and what the agents have found. Every score carries its basis and inputs."
        actions={
          <>
            {/* both writes need `standard` on intelligence for this project;
                the feed answers that once, so a read-only member is told why
                rather than handed a button that 403s. */}
            <RefreshButton
              onClick={() => void recompute()}
              loading={recomputing}
              label="Recompute health"
              disabled={!canAct}
              title={canAct ? undefined : READ_ONLY_HINT}
            />
            <Button
              size="sm"
              icon={IconAi}
              loading={generating}
              disabled={!aiEnabled || !canAct}
              title={!canAct ? READ_ONLY_HINT : aiEnabled ? undefined : "AI is not configured on this server"}
              onClick={() => void generate()}
            >
              Write project briefing
            </Button>
          </>
        }
      />

      <HealthHero health={h} loading={health.loading} error={health.error} onRetry={health.reload} />

      <section aria-label="Intelligence indicators" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Health score" value={h ? (h.score === null ? "—" : `${h.score}/100`) : "—"} tone={h ? LEVEL_META[h.level].tone : "neutral"} hint={h ? (h.score === null ? "unrated — no inputs held" : LEVEL_META[h.level].label) : undefined} loading={health.loading} />
        <Stat label="Dimensions off track" value={offTrackDims === null ? "—" : formatNumber(offTrackDims)} tone={offTrackDims ? "danger" : "neutral"} hint={h ? `${h.dimensions.filter((d) => d.level === "watch").length} on watch · ${h.dimensions.filter((d) => d.score === null).length} unrated` : undefined} loading={health.loading} />
        <Stat label="Open attention" value={openAttention.data ? formatNumber(openAttention.data.total) : "—"} tone={critical > 0 ? "danger" : "neutral"} hint={openAttention.data ? `${critical} critical · ${overdue} past a deadline` : openAttention.error ? "not available" : undefined} loading={openAttention.loading} />
        <Stat label="Agent proposals" value={activity.data ? formatNumber(activity.data.pendingProposals) : "—"} tone={activity.data?.pendingProposals ? "accent" : "neutral"} hint={activity.data ? (activity.data.aiEnabled ? "waiting for a person" : "AI not configured") : undefined} loading={activity.loading} />
      </section>

      <Tabs<TabKey> items={tabs} value={tab} onChange={setTab} aria-label="Intelligence sections" />

      {tab === "health" ? (
        <Card>
          <CardHeader title="Health by dimension" subtitle="Each score is derived from the module's own records. Click a dimension for the inputs behind it." />
          <CardBody flush>
            {health.loading ? <PanelSkeleton rows={8} /> : health.error ? <div className="p-3"><ErrorAlert message={health.error} onRetry={health.reload} /></div> : <DimensionList dimensions={h?.dimensions ?? []} onSelect={setDimension} />}
          </CardBody>
        </Card>
      ) : null}

      {tab === "attention" ? (
        <Card>
          <CardHeader
            title="What needs a decision on this project"
            subtitle={statusHint(attentionStatus)}
            actions={<AttentionStatusFilter value={attentionStatus} onChange={setAttentionStatus} />}
          />
          <CardBody flush>
            <AttentionTable
              items={items}
              loading={attention.loading}
              error={attention.error}
              onRetry={attention.reload}
              onSelect={setSelected}
              showProject={false}
              emptyTitle={attentionEmpty(attentionStatus, "project").title}
              emptyHint={attentionEmpty(attentionStatus, "project").hint}
              tableId={`project-attention-${projectId}-${attentionStatus}`}
            />
          </CardBody>
        </Card>
      ) : null}

      {tab === "history" ? <HistoryPanel history={history.data} loading={history.loading} error={history.error} onRetry={history.reload} /> : null}

      {tab === "agents" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <BriefingCard
            title="Project briefing"
            briefing={briefing.data?.briefing ?? null}
            reason={briefing.data?.reason ?? null}
            aiEnabled={aiEnabled}
            canGenerate
            onGenerate={() => void generate()}
            generating={generating}
            loading={briefing.loading}
            error={briefing.error}
            onRetry={briefing.reload}
            reviewHref={`/projects/${projectId}/ai`}
          />
          <ActivityPanel data={activity.data} loading={activity.loading} error={activity.error} onRetry={activity.reload} reviewHref={`/projects/${projectId}/ai`} />
        </div>
      ) : null}

      <DimensionDrawer dimension={dimension} onClose={() => setDimension(null)} />
      {/* the API answers canAct for this project once per page (read-only
          members get the explanation, not a button that 403s) */}
      <AttentionDrawer
        item={selected}
        onClose={() => setSelected(null)}
        canAct={selected?.canAct ?? attention.data?.canAct ?? false}
        onDismiss={dismiss}
        onReopen={reopen}
        busy={busy}
      />
    </div>
  );
}
