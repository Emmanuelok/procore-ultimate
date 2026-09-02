/**
 * Platform Pulse — the first thing a signed-in person sees (WP-SHELL routes
 * `/` here). Spec Vol I §6.1–6.3 (#731–758), §7 (#776–789); Vol II X #1017.
 *
 * One request (`GET /api/v1/pulse`) carries the hero verdict, the ranked
 * attention feed, every project's health with its trend, and what changed
 * since yesterday — read from a cached snapshot the scheduler refreshes, so
 * it is fast. The trend, briefing and agent activity panels each load on
 * their own and fail on their own.
 *
 * Honesty: nothing here is derived client-side from partial pages. The
 * portfolio counts are the server's; a project with no computed health is
 * "unrated", never scored; money on an attention item is shown in its own
 * currency and never summed.
 */
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiClientError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
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
  type Tone,
} from "../../ui";
import { cx } from "../../ui/cx";
import { toneClass } from "../../ui/tokens";
import {
  IconActivity,
  IconAi,
  IconArrowRight,
  IconInsight,
  IconProject,
  IconTrendUp,
  IconWarning,
} from "../../ui/icons";
import { formatDate, formatDateTime } from "../format";
import {
  ActivityPanel,
  AttentionDrawer,
  AttentionTable,
  BriefingCard,
  LEVEL_META,
  LEVEL_ORDER,
  LevelBadge,
  PanelSkeleton,
  RefreshButton,
  ScoreRing,
  TrendSparkline,
  dimensionLabel,
  errorMessage,
  type ActivityResponse,
  type AttentionItem,
  type BriefingLatest,
  type BriefingView,
  type HealthLevel,
  type ProjectHealth,
  type PulseResponse,
} from "../intelligence/intelShared";

type TabKey = "attention" | "portfolio" | "briefing" | "trend" | "activity";

interface PulseHistory {
  items: Array<{
    generatedAt: string;
    byHealth: Record<HealthLevel, number>;
    projects: number;
    openAttention: number;
    attentionBySeverity: Record<string, number>;
  }>;
  days: number;
}

interface BriefingList {
  items: BriefingView[];
  reason: string | null;
}

const STAGE_LABEL: Record<string, string> = {
  bidding: "Bidding",
  pre_construction: "Pre-construction",
  course_of_construction: "In construction",
  warranty: "Warranty",
  closed: "Closed",
};

function stageLabel(stage: string | null | undefined): string {
  if (!stage) return "Stage unknown";
  return STAGE_LABEL[stage] ?? formatStatusLabel(stage);
}

/* ==========================================================================
   The verdict — one sentence a director can act on
========================================================================== */

function verdictFor(p: PulseResponse): { headline: string; tone: Tone; detail: string } {
  const h = p.portfolio.byHealth;
  const critical = p.attentionBySeverity["critical"] ?? 0;
  const high = p.attentionBySeverity["high"] ?? 0;
  const detail =
    p.portfolio.projects === 0
      ? "Create a project and the platform will start scoring it the moment records arrive."
      : `${h.off_track} off track · ${h.watch} on watch · ${h.on_track} on track · ${h.unrated} unrated · ${formatNumber(p.openAttention)} open attention item${p.openAttention === 1 ? "" : "s"} (${critical} critical, ${high} high)`;
  if (p.portfolio.projects === 0) return { headline: "No projects yet", tone: "neutral", detail };
  if (h.off_track > 0) {
    return { headline: `${h.off_track} project${h.off_track === 1 ? " is" : "s are"} off track`, tone: "danger", detail };
  }
  if (critical > 0) {
    return { headline: `${critical} critical item${critical === 1 ? "" : "s"} need${critical === 1 ? "s" : ""} a decision today`, tone: "danger", detail };
  }
  if (h.watch > 0) return { headline: `${h.watch} project${h.watch === 1 ? "" : "s"} on watch`, tone: "warning", detail };
  if (h.on_track > 0) return { headline: "The portfolio is on track", tone: "success", detail };
  return { headline: "Nothing rated yet", tone: "neutral", detail: `${detail}. Health is unrated until a project holds a schedule, budget, register or field record.` };
}

function HeroVerdict({ pulse, loading, error, onRetry, onOpenProject }: { pulse: PulseResponse | null; loading: boolean; error: string | null; onRetry: () => void; onOpenProject: (id: string) => void }) {
  if (loading) {
    return (
      <Card>
        <CardBody>
          <Skeleton variant="text" width="40%" height={28} />
          <Skeleton className="mt-3" variant="text" lines={2} />
        </CardBody>
      </Card>
    );
  }
  if (error) {
    return (
      <Card>
        <CardBody>
          <ErrorAlert title="The Pulse could not be read" message={error} onRetry={onRetry} />
        </CardBody>
      </Card>
    );
  }
  if (!pulse) return null;
  const v = verdictFor(pulse);
  const ch = pulse.changes;
  const accent: Record<Tone, string> = {
    neutral: "border-l-neutral-solid",
    accent: "border-l-accent",
    info: "border-l-info-solid",
    success: "border-l-success-solid",
    warning: "border-l-warning-solid",
    danger: "border-l-danger-solid",
    highlight: "border-l-highlight-solid",
  };
  return (
    <Card className={cx("border-l-4", accent[v.tone])}>
      <CardBody>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-2xs font-semibold uppercase tracking-wide text-content-subtle">Verdict</div>
            <h2 className="mt-1 text-2xl font-semibold leading-tight text-content">{v.headline}</h2>
            <p className="mt-1.5 text-body text-content-muted">{v.detail}</p>
            {pulse.computedOnRead ? (
              <p className="mt-1 text-2xs text-content-subtle">This snapshot was built on this read — the first for the company. The scheduler keeps it fresh from here.</p>
            ) : null}
          </div>
          <div className="flex shrink-0 gap-3">
            {LEVEL_ORDER.map((level) => (
              <div key={level} className="min-w-16 text-center">
                <div className={cx("text-xl font-semibold tabular-nums", toneClass(LEVEL_META[level].tone, "text"))}>{pulse.portfolio.byHealth[level]}</div>
                <div className="text-2xs text-content-subtle">{LEVEL_META[level].short}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-4 border-t border-border pt-3">
          <div className="text-2xs font-semibold uppercase tracking-wide text-content-subtle">
            Since {ch.since ? `${formatRelativeTime(ch.since)} (${formatDateTime(ch.since)})` : "yesterday"}
          </div>
          {!ch.since ? (
            <p className="mt-1 text-meta text-content-subtle">No earlier snapshot to compare against yet — the comparison starts once the Pulse has a day of history.</p>
          ) : (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Badge tone={ch.newAttention > 0 ? "warning" : "neutral"} dot>
                {ch.newAttention} new attention
              </Badge>
              <Badge tone={ch.resolvedAttention > 0 ? "success" : "neutral"} dot>
                {ch.resolvedAttention} resolved
              </Badge>
              <Badge tone="neutral">
                open {ch.openAttentionFrom ?? "—"} → {ch.openAttentionTo}
              </Badge>
              {ch.levelChanges.length === 0 ? (
                <span className="text-meta text-content-subtle">No project changed level.</span>
              ) : (
                ch.levelChanges.map((c) => (
                  <button
                    key={c.projectId}
                    type="button"
                    onClick={() => onOpenProject(c.projectId)}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-meta hover:bg-surface-hover"
                    title={`${c.scoreFrom ?? "—"} → ${c.scoreTo ?? "—"}`}
                  >
                    <span className="font-medium text-content">{c.projectName ?? c.projectId}</span>
                    <LevelBadge level={c.from} size="xs" />
                    <IconArrowRight className="size-3 text-content-subtle" />
                    <LevelBadge level={c.to} size="xs" />
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

/* ==========================================================================
   Portfolio grid
========================================================================== */

function PortfolioGrid({ scores, onOpen }: { scores: ProjectHealth[]; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<HealthLevel | "all">("all");
  const sorted = useMemo(() => {
    const rank = (l: HealthLevel) => LEVEL_ORDER.indexOf(l);
    return [...scores]
      .filter((s) => filter === "all" || s.level === filter)
      .sort((a, b) => rank(a.level) - rank(b.level) || (a.score ?? 101) - (b.score ?? 101) || (a.projectName ?? "").localeCompare(b.projectName ?? ""));
  }, [scores, filter]);
  if (scores.length === 0) {
    return <EmptyState icon={IconProject} title="No projects in the portfolio" hint="Health is scored per project; there is nothing to score yet." />;
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {(["all", ...LEVEL_ORDER] as const).map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => setFilter(l)}
            className={cx(
              "rounded-md px-2.5 py-1 text-meta font-medium ring-1 ring-border transition",
              filter === l ? "bg-surface-selected text-content" : "bg-surface text-content-muted hover:bg-surface-hover",
            )}
          >
            {l === "all" ? `All (${scores.length})` : `${LEVEL_META[l].label} (${scores.filter((s) => s.level === l).length})`}
          </button>
        ))}
      </div>
      {sorted.length === 0 ? (
        <EmptyState size="sm" title={`No project is ${LEVEL_META[filter as HealthLevel]?.label.toLowerCase() ?? filter}`} bordered />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {sorted.map((s) => {
            const weak = s.dimensions.filter((d) => d.score !== null && d.level !== "on_track").sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
            const unrated = s.dimensions.filter((d) => d.score === null).length;
            return (
              <li key={s.projectId}>
                <Card interactive accent={LEVEL_META[s.level].tone} className="h-full" onClick={() => onOpen(s.projectId)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onOpen(s.projectId); }}>
                  <CardBody className="flex h-full flex-col gap-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-body font-semibold text-content">{s.projectName ?? s.projectId}</div>
                        <div className="text-2xs text-content-subtle">{stageLabel(s.stage)}</div>
                        <div className="mt-1.5">
                          <LevelBadge level={s.level} size="xs" />
                        </div>
                      </div>
                      <ScoreRing score={s.score} level={s.level} size={56} />
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <TrendSparkline trend={s.trend} width={110} height={26} />
                      <span className="text-2xs text-content-subtle" title={formatDateTime(s.computedAt)}>
                        {s.score === null ? "not scored" : `computed ${formatRelativeTime(s.computedAt)}`}
                      </span>
                    </div>
                    <div className="mt-auto">
                      {weak.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {weak.slice(0, 4).map((d) => (
                            <Badge key={d.key} tone={LEVEL_META[d.level].tone} size="xs" title={d.basis}>
                              {dimensionLabel(d.key)} {d.score}
                            </Badge>
                          ))}
                          {weak.length > 4 ? <Badge tone="neutral" size="xs">+{weak.length - 4}</Badge> : null}
                        </div>
                      ) : (
                        <p className="text-2xs text-content-subtle">
                          {s.score === null ? (s.basis ?? "No dimension holds enough records to score.") : `Every rated dimension is on track · ${unrated} unrated`}
                        </p>
                      )}
                    </div>
                  </CardBody>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ==========================================================================
   Trend
========================================================================== */

function TrendPanel({ history, loading, error, onRetry }: { history: PulseHistory | null; loading: boolean; error: string | null; onRetry: () => void }) {
  const data = useMemo(
    () =>
      (history?.items ?? []).map((i) => ({
        day: i.generatedAt.slice(0, 10),
        off_track: i.byHealth.off_track,
        watch: i.byHealth.watch,
        on_track: i.byHealth.on_track,
        unrated: i.byHealth.unrated,
        attention: i.openAttention,
        critical: i.attentionBySeverity["critical"] ?? 0,
      })),
    [history],
  );
  if (loading) return <PanelSkeleton rows={6} />;
  if (error) return <ErrorAlert message={error} onRetry={onRetry} />;
  if (data.length < 2) {
    return (
      <EmptyState
        icon={IconTrendUp}
        title="Not enough history for a trend"
        hint={`The trend needs at least two days of Pulse snapshots; there ${data.length === 1 ? "is one" : "are none"} so far. The scheduler takes one every refresh and keeps thirty days.`}
      />
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Projects by health" subtitle={`Last ${history?.days ?? 30} days, one point per day`} />
        <CardBody>
          <LineChart
            data={data}
            categoryKey="day"
            labelFormat="dayShort"
            height={240}
            curve="step"
            series={[
              { key: "off_track", label: "Off track", tone: "danger" },
              { key: "watch", label: "On watch", tone: "warning" },
              { key: "on_track", label: "On track", tone: "success" },
              { key: "unrated", label: "Unrated", tone: "neutral", dashed: true },
            ]}
            valueDomain={[0, "auto"]}
            ariaLabel="Projects by health level over time"
          />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Open attention" subtitle="All open items, and the critical ones" />
        <CardBody>
          <LineChart
            data={data}
            categoryKey="day"
            labelFormat="dayShort"
            height={240}
            series={[
              { key: "attention", label: "Open", tone: "accent" },
              { key: "critical", label: "Critical", tone: "danger" },
            ]}
            valueDomain={[0, "auto"]}
            ariaLabel="Open attention items over time"
          />
        </CardBody>
      </Card>
    </div>
  );
}

/* ==========================================================================
   Page
========================================================================== */

export default function PulsePage() {
  const navigate = useNavigate();
  const { user, company } = useAuth();
  const isAdmin = company?.role === "owner" || company?.role === "admin";
  const [tab, setTab] = useState<TabKey>("attention");
  const [selected, setSelected] = useState<AttentionItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [generating, setGenerating] = useState(false);

  const pulse = useResource<PulseResponse>("/api/v1/pulse?attentionLimit=100");
  const history = useResource<PulseHistory>("/api/v1/pulse/history?days=30");
  const activity = useResource<ActivityResponse>("/api/v1/pulse/activity?limit=20");
  const briefing = useResource<BriefingLatest>("/api/v1/pulse/briefing");
  const briefings = useResource<BriefingList>("/api/v1/pulse/briefings?limit=10");

  const reloadAll = useCallback(() => {
    pulse.reload();
    history.reload();
    activity.reload();
    briefing.reload();
    briefings.reload();
  }, [pulse, history, activity, briefing, briefings]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (isAdmin) {
        const r = await api.post<{ projects: number; recomputed: number; levelChanges: number; attention: { open: number } }>("/api/v1/pulse/refresh", {});
        toast.success(`Recomputed ${r.projects} project${r.projects === 1 ? "" : "s"} · ${r.levelChanges} level change${r.levelChanges === 1 ? "" : "s"} · ${r.attention.open} open attention`);
      }
      reloadAll();
    } catch (err) {
      toast.error(errorMessage(err, "The refresh failed."));
    } finally {
      setRefreshing(false);
    }
  }, [isAdmin, reloadAll]);

  const generate = useCallback(async () => {
    setGenerating(true);
    try {
      const r = await api.post<{ briefing: BriefingView; reviewIds: string[]; dropped: { highlights: number; actions: number } }>("/api/v1/pulse/briefing", {});
      toast.success(
        `Briefing written · ${r.briefing.highlights.length} highlight${r.briefing.highlights.length === 1 ? "" : "s"} · ${r.reviewIds.length} proposal${r.reviewIds.length === 1 ? "" : "s"} queued for review` +
          (r.dropped.highlights + r.dropped.actions > 0 ? ` · ${r.dropped.highlights + r.dropped.actions} uncited claim${r.dropped.highlights + r.dropped.actions === 1 ? "" : "s"} discarded` : ""),
      );
      briefing.reload();
      briefings.reload();
      activity.reload();
      pulse.reload();
      setTab("briefing");
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 503) toast.error("AI is not configured on this server, so no briefing can be written.");
      else toast.error(errorMessage(err, "The briefing could not be written."));
    } finally {
      setGenerating(false);
    }
  }, [briefing, briefings, activity, pulse]);

  const dismiss = useCallback(
    async (item: AttentionItem, reason: string) => {
      setBusy(true);
      try {
        await api.post(`/api/v1/attention/${item.id}/dismiss`, reason ? { reason } : {});
        toast.success("Set aside — recorded on the ledger.");
        setSelected(null);
        pulse.reload();
      } catch (err) {
        toast.error(errorMessage(err, "Could not dismiss the item."));
      } finally {
        setBusy(false);
      }
    },
    [pulse],
  );

  const reopen = useCallback(
    async (item: AttentionItem) => {
      setBusy(true);
      try {
        await api.post(`/api/v1/attention/${item.id}/reopen`, {});
        toast.success("Reopened.");
        setSelected(null);
        pulse.reload();
      } catch (err) {
        toast.error(errorMessage(err, "Could not reopen the item."));
      } finally {
        setBusy(false);
      }
    },
    [pulse],
  );

  const data = pulse.data;
  const sev = data?.attentionBySeverity ?? {};
  const firstName = user?.name?.split(" ")[0] ?? "there";
  const aiEnabled = briefing.data?.aiEnabled ?? activity.data?.aiEnabled ?? false;

  const tabs = useMemo(
    () => [
      { value: "attention" as const, label: "Attention", icon: IconWarning, count: data?.openAttention, tone: (sev["critical"] ?? 0) > 0 ? ("danger" as const) : undefined },
      { value: "portfolio" as const, label: "Portfolio", icon: IconProject, count: data?.portfolio.projects },
      { value: "briefing" as const, label: "Briefing", icon: IconAi },
      { value: "trend" as const, label: "Trend", icon: IconTrendUp },
      { value: "activity" as const, label: "Agents", icon: IconActivity, count: activity.data?.pendingProposals || undefined },
    ],
    [data, sev, activity.data],
  );

  return (
    <div className="flex flex-col gap-section">
      <PageHeader
        icon={IconInsight}
        title="Platform Pulse"
        subtitle={`Good to see you, ${firstName}. ${company ? `${company.name}: ` : ""}what needs a decision, how every project is doing, and what changed since yesterday.`}
        meta={
          data ? (
            <span className="text-meta text-content-subtle" title={formatDateTime(data.generatedAt)}>
              Snapshot {formatRelativeTime(data.generatedAt)} · refreshed every 15 minutes and on every ledger event
            </span>
          ) : null
        }
        actions={
          <>
            <RefreshButton onClick={() => void refresh()} loading={refreshing} label={isAdmin ? "Recompute now" : "Refresh"} />
            {isAdmin ? (
              <Button size="sm" icon={IconAi} loading={generating} disabled={!aiEnabled} title={aiEnabled ? undefined : "AI is not configured on this server"} onClick={() => void generate()}>
                Write today's briefing
              </Button>
            ) : null}
          </>
        }
      />

      <HeroVerdict pulse={data} loading={pulse.loading} error={pulse.error} onRetry={pulse.reload} onOpenProject={(id) => navigate(`/projects/${id}/intelligence`)} />

      <section aria-label="Pulse indicators" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Open attention"
          value={data ? formatNumber(data.openAttention) : "—"}
          icon={IconWarning}
          tone={(sev["critical"] ?? 0) > 0 ? "danger" : (sev["high"] ?? 0) > 0 ? "warning" : "neutral"}
          hint={data ? `${sev["critical"] ?? 0} critical · ${sev["high"] ?? 0} high · ${sev["medium"] ?? 0} medium` : pulse.error ? "not available" : "loading"}
          loading={pulse.loading}
        />
        <Stat
          label="Off track"
          value={data ? formatNumber(data.portfolio.byHealth.off_track) : "—"}
          tone="danger"
          hint={data ? `of ${data.portfolio.projects} project${data.portfolio.projects === 1 ? "" : "s"}` : undefined}
          loading={pulse.loading}
        />
        <Stat
          label="On watch"
          value={data ? formatNumber(data.portfolio.byHealth.watch) : "—"}
          tone="warning"
          hint={data ? `${data.portfolio.byHealth.on_track} on track` : undefined}
          loading={pulse.loading}
        />
        <Stat
          label="Unrated"
          value={data ? formatNumber(data.portfolio.byHealth.unrated) : "—"}
          tone="neutral"
          hint="no inputs held — never scored as zero"
          loading={pulse.loading}
        />
      </section>

      <Tabs<TabKey> items={tabs} value={tab} onChange={setTab} aria-label="Pulse sections" />

      {tab === "attention" ? (
        <Card>
          <CardHeader
            title="What needs a decision"
            subtitle="Ranked by severity × urgency × money. Click a row for the basis, the record, and to set it aside with a reason."
          />
          <CardBody flush>
            <AttentionTable
              items={data?.attention ?? []}
              loading={pulse.loading}
              error={pulse.error}
              onRetry={pulse.reload}
              onSelect={setSelected}
              showProject
              tableId="pulse-attention"
            />
            {data && data.openAttention > data.attention.length ? (
              <p className="border-t border-border px-4 py-2 text-meta text-content-subtle">
                Showing the top {data.attention.length} of {data.openAttention} open items. Open a project's intelligence tab for its full list.
              </p>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {tab === "portfolio" ? (
        pulse.loading ? (
          <PanelSkeleton rows={6} />
        ) : pulse.error ? (
          <ErrorAlert message={pulse.error} onRetry={pulse.reload} />
        ) : (
          <PortfolioGrid scores={data?.scores ?? []} onOpen={(id) => navigate(`/projects/${id}/intelligence`)} />
        )
      ) : null}

      {tab === "briefing" ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <BriefingCard
            briefing={briefing.data?.briefing ?? null}
            reason={briefing.data?.reason ?? null}
            aiEnabled={aiEnabled}
            canGenerate={isAdmin}
            onGenerate={() => void generate()}
            generating={generating}
            loading={briefing.loading}
            error={briefing.error}
            onRetry={briefing.reload}
            reviewHref="/agents"
          />
          <Card>
            <CardHeader title="Earlier briefings" subtitle="Company-wide, newest first" />
            <CardBody flush>
              {briefings.loading ? (
                <PanelSkeleton />
              ) : briefings.error ? (
                <div className="p-3">
                  <ErrorAlert message={briefings.error} onRetry={briefings.reload} />
                </div>
              ) : (briefings.data?.items.length ?? 0) === 0 ? (
                <p className="p-4 text-meta text-content-subtle">{briefings.data?.reason === "restricted_scope" ? "Not shown for a partial view of the portfolio." : "None yet."}</p>
              ) : (
                <Table flush dense>
                  <thead>
                    <tr>
                      <Th>When</Th>
                      <Th>Headline</Th>
                      <Th numeric>Proposals</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {briefings.data!.items.map((b) => (
                      <tr key={b.id}>
                        <Td muted title={formatDateTime(b.generatedAt)}>{formatDate(b.generatedAt)}</Td>
                        <Td truncate title={b.headline}>{b.headline}</Td>
                        <Td numeric>{b.proposals.length}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>
        </div>
      ) : null}

      {tab === "trend" ? <TrendPanel history={history.data} loading={history.loading} error={history.error} onRetry={history.reload} /> : null}

      {tab === "activity" ? <ActivityPanel data={activity.data} loading={activity.loading} error={activity.error} onRetry={activity.reload} reviewHref="/agents" /> : null}

      <AttentionDrawer item={selected} onClose={() => setSelected(null)} canAct onDismiss={dismiss} onReopen={reopen} busy={busy} />
    </div>
  );
}
