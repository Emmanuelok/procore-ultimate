/**
 * DashboardPage — the portfolio view a delivery director opens first.
 *
 * ---------------------------------------------------------------------------
 * THE ONLY RULE THAT MATTERS HERE
 *
 * Every number on this page is read from a real endpoint and nothing is
 * invented. Where a metric has no source, the tile renders its empty state
 * WITH THE REASON — a missing value is never drawn as a zero, and a series we
 * cannot fully cover is never drawn as a flat line.
 *
 * Sources, all of them live:
 *   GET /api/v1/projects?page=1&pageSize=200   portfolio, stages, values, dates
 *   GET /api/v1/signals/stats                  signal totals by severity/disposition
 *   GET /api/v1/signals?page=1&pageSize=200    the open-signals panel + per-project health
 *   GET /api/v1/ledger?page=1&pageSize=100     the activity feed
 *   GET /api/v1/notifications/unread-count     unread counter (via the shell cache)
 *
 * Two things are deliberately NOT here because the API has no company-level
 * source for them, and guessing would be worse than omitting:
 *   • work progress — there is no portfolio progress endpoint. The table shows
 *     SCHEDULE ELAPSED, computed from each project's own start/finish dates and
 *     labelled as such.
 *   • cost performance (EAC, variance) — those live per project, behind
 *     /projects/:id/budget. A portfolio roll-up would require N requests and a
 *     currency policy the platform has not defined.
 * ---------------------------------------------------------------------------
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { PROJECT_STAGES } from "@constructos/shared";
import {
  ActivityFeed,
  Badge,
  BarChart,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  ChartCard,
  DataTable,
  EmptyState,
  PageHeader,
  SegmentedControl,
  Skeleton,
  Sparkline,
  Stat,
  formatCurrency,
  formatNumber,
  formatRelativeTime,
  formatStatusLabel,
  severityToTone,
  SEVERITY_LABEL,
  SEVERITY_RANK,
  SEVERITIES,
  asSeverity,
  type DataColumns,
  type Severity,
  type TimelineItem,
  type Tone,
} from "../ui";
import { cx } from "../ui/cx";
import {
  IconActivity,
  IconAssurance,
  IconBell,
  IconBudget,
  IconChartBar,
  IconEmpty,
  IconProject,
  IconRefresh,
  IconWarning,
  type IconComponent,
} from "../ui/icons";
import { api, ApiClientError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useShellData } from "../layouts/shell/shell-data";

/* ==========================================================================
   Wire shapes
========================================================================== */

interface ListResponse<T> {
  items: T[];
  total: number;
}

interface ProjectRow {
  id: string;
  name: string;
  number: string | null;
  stage: string | null;
  city: string | null;
  country: string | null;
  currency: string | null;
  value: number | string | null;
  startDate: string | null;
  finishDate: string | null;
  createdAt: string | null;
}

interface SignalRow {
  id: string;
  projectId: string | null;
  detector: string;
  severity: string;
  title: string;
  explanation: string;
  disposition: string;
  createdAt: string | null;
}

interface SignalStats {
  total: number;
  bySeverity: Record<string, number>;
  byDisposition: Record<string, number>;
}

interface LedgerRow {
  seq: number;
  actorId: string | null;
  action: string;
  objectType: string;
  objectId: string;
  at: string | null;
}

/** Dispositions the API itself treats as open. */
const OPEN_DISPOSITIONS = new Set(["new", "under_review", "confirmed", "escalated"]);

const PROJECT_PAGE = 200;
const SIGNAL_PAGE = 200;
const LEDGER_PAGE = 100;

/* ==========================================================================
   Loading model
========================================================================== */

type Async<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return "Request failed";
}

/* ==========================================================================
   Pure helpers — all of them refuse to invent a value
========================================================================== */

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Counts per day over the last `days` days, oldest first.
 *
 * `covered` is false when the fetched page cannot possibly contain the whole
 * window (the server returned a full page whose oldest row is newer than the
 * window start). Callers must not draw a series that is not covered — the
 * shape would be a lie about the earlier days.
 */
function dailyCounts(
  timestamps: ReadonlyArray<string | null>,
  days: number,
  fetched: number,
  pageSize: number,
): { series: number[]; covered: boolean } {
  const today = startOfDay(Date.now());
  const windowStart = today - (days - 1) * DAY_MS;
  const series = new Array<number>(days).fill(0);
  let oldest = Number.POSITIVE_INFINITY;

  for (const stamp of timestamps) {
    const time = parseTime(stamp);
    if (time === null) continue;
    oldest = Math.min(oldest, time);
    const day = startOfDay(time);
    if (day < windowStart || day > today) continue;
    const index = Math.round((day - windowStart) / DAY_MS);
    const current = series[index];
    if (current !== undefined) series[index] = current + 1;
  }

  const complete = fetched < pageSize;
  const covered = complete || (Number.isFinite(oldest) && oldest <= windowStart);
  return { series, covered };
}

/** Counts per calendar month over the last `months` months, oldest first. */
function monthlyCounts(
  timestamps: ReadonlyArray<string | null>,
  months: number,
  fetched: number,
  pageSize: number,
): { series: number[]; covered: boolean } {
  const now = new Date();
  const keys: string[] = [];
  for (let back = months - 1; back >= 0; back -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - back, 1);
    keys.push(`${date.getFullYear()}-${date.getMonth()}`);
  }
  const index = new Map(keys.map((key, position) => [key, position]));
  const series = new Array<number>(months).fill(0);
  let oldest = Number.POSITIVE_INFINITY;

  for (const stamp of timestamps) {
    const time = parseTime(stamp);
    if (time === null) continue;
    oldest = Math.min(oldest, time);
    const date = new Date(time);
    const position = index.get(`${date.getFullYear()}-${date.getMonth()}`);
    if (position === undefined) continue;
    const current = series[position];
    if (current !== undefined) series[position] = current + 1;
  }

  const windowStart = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1).getTime();
  const complete = fetched < pageSize;
  const covered = complete || (Number.isFinite(oldest) && oldest <= windowStart);
  return { series, covered };
}

/** Count in the last `days` days. Only meaningful when the page covers it. */
function countSince(timestamps: ReadonlyArray<string | null>, days: number): number {
  const cutoff = Date.now() - days * DAY_MS;
  let total = 0;
  for (const stamp of timestamps) {
    const time = parseTime(stamp);
    if (time !== null && time >= cutoff) total += 1;
  }
  return total;
}

const PROJECT_STAGE_LABEL: Readonly<Record<string, string>> = {
  bidding: "Bidding",
  pre_construction: "Pre-construction",
  course_of_construction: "In construction",
  warranty: "Warranty",
  closed: "Closed",
};

const PROJECT_STAGE_TONE: Readonly<Record<string, Tone>> = {
  bidding: "highlight",
  pre_construction: "info",
  course_of_construction: "success",
  warranty: "warning",
  closed: "neutral",
};

function stageLabel(stage: string | null | undefined): string {
  if (!stage) return "Unknown";
  return PROJECT_STAGE_LABEL[stage] ?? formatStatusLabel(stage);
}

function stageTone(stage: string | null | undefined): Tone {
  if (!stage) return "neutral";
  return PROJECT_STAGE_TONE[stage] ?? "neutral";
}

/** Calendar time elapsed between start and finish. Null when undatable. */
function elapsedPercent(start: string | null, finish: string | null): number | null {
  const from = parseTime(start);
  const to = parseTime(finish);
  if (from === null || to === null || to <= from) return null;
  const now = Date.now();
  return Math.max(0, Math.min(100, ((now - from) / (to - from)) * 100));
}

interface CurrencyGroup {
  currency: string;
  total: number;
  count: number;
}

function summariseValue(rows: readonly ProjectRow[]): {
  groups: CurrencyGroup[];
  withValue: number;
  withoutValue: number;
} {
  const map = new Map<string, CurrencyGroup>();
  let withoutValue = 0;

  for (const row of rows) {
    const amount = toNumberOrNull(row.value);
    if (amount === null) {
      withoutValue += 1;
      continue;
    }
    const currency = row.currency || "USD";
    const group = map.get(currency) ?? { currency, total: 0, count: 0 };
    group.total += amount;
    group.count += 1;
    map.set(currency, group);
  }

  const groups = [...map.values()].sort((a, b) => b.count - a.count || b.total - a.total);
  return { groups, withValue: rows.length - withoutValue, withoutValue };
}

/** Solid fill per tone, for the severity meter. */
const TONE_BAR: Readonly<Record<Tone, string>> = {
  neutral: "bg-neutral-solid",
  accent: "bg-accent",
  info: "bg-info-solid",
  success: "bg-success-solid",
  warning: "bg-warning-solid",
  danger: "bg-danger-solid",
  highlight: "bg-highlight-solid",
};

const ACTION_ICON: Readonly<Record<string, IconComponent>> = {
  create: IconProject,
  update: IconActivity,
  delete: IconEmpty,
  state_change: IconActivity,
  access: IconAssurance,
};

const ACTION_TONE: Readonly<Record<string, Tone>> = {
  create: "success",
  update: "info",
  delete: "danger",
  state_change: "highlight",
  access: "neutral",
};

/* ==========================================================================
   Data
========================================================================== */

interface DashboardData {
  projects: Async<ListResponse<ProjectRow>>;
  signals: Async<ListResponse<SignalRow>>;
  stats: Async<SignalStats>;
  ledger: Async<ListResponse<LedgerRow>>;
}

function useDashboardData(): DashboardData & { reload: () => void; reloading: boolean } {
  const { companyId } = useAuth();
  const [nonce, setNonce] = useState(0);
  const [reloading, setReloading] = useState(false);
  const [projects, setProjects] = useState<Async<ListResponse<ProjectRow>>>({ status: "loading" });
  const [signals, setSignals] = useState<Async<ListResponse<SignalRow>>>({ status: "loading" });
  const [stats, setStats] = useState<Async<SignalStats>>({ status: "loading" });
  const [ledger, setLedger] = useState<Async<ListResponse<LedgerRow>>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setReloading(true);

    const settle = <T,>(
      set: (value: Async<T>) => void,
      promise: Promise<T>,
    ): Promise<void> =>
      promise.then(
        (data) => {
          if (!cancelled) set({ status: "ready", data });
        },
        (error: unknown) => {
          if (!cancelled) set({ status: "error", message: errorMessage(error) });
        },
      );

    void Promise.all([
      settle(
        setProjects,
        api.get<ListResponse<ProjectRow>>(`/api/v1/projects?page=1&pageSize=${PROJECT_PAGE}`),
      ),
      settle(
        setSignals,
        api.get<ListResponse<SignalRow>>(`/api/v1/signals?page=1&pageSize=${SIGNAL_PAGE}`),
      ),
      settle(setStats, api.get<SignalStats>("/api/v1/signals/stats")),
      settle(
        setLedger,
        api.get<ListResponse<LedgerRow>>(`/api/v1/ledger?page=1&pageSize=${LEDGER_PAGE}`),
      ),
    ]).finally(() => {
      if (!cancelled) setReloading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [companyId, nonce]);

  const reload = useCallback(() => {
    setProjects({ status: "loading" });
    setSignals({ status: "loading" });
    setStats({ status: "loading" });
    setLedger({ status: "loading" });
    setNonce((value) => value + 1);
  }, []);

  return { projects, signals, stats, ledger, reload, reloading };
}

/* ==========================================================================
   Page
========================================================================== */

type ChartMode = "value" | "count";

export default function DashboardPage() {
  const { user, company } = useAuth();
  const { unreadNotifications } = useShellData();
  const navigate = useNavigate();
  const { projects, signals, stats, ledger, reload, reloading } = useDashboardData();
  const [chartMode, setChartMode] = useState<ChartMode>("value");

  const projectRows = projects.status === "ready" ? projects.data.items : [];
  const projectsTotal = projects.status === "ready" ? projects.data.total : 0;
  const projectsTruncated = projectsTotal > projectRows.length;

  const signalRows = signals.status === "ready" ? signals.data.items : [];
  const signalsFetchedTotal = signals.status === "ready" ? signals.data.total : 0;
  const signalsComplete = signals.status === "ready" && signalsFetchedTotal <= signalRows.length;

  const openSignalRows = useMemo(
    () => signalRows.filter((row) => OPEN_DISPOSITIONS.has(row.disposition)),
    [signalRows],
  );

  /* -- KPI: projects --------------------------------------------------- */
  const activeProjects = useMemo(
    () => projectRows.filter((row) => row.stage !== "closed").length,
    [projectRows],
  );

  const projectSeries = useMemo(
    () =>
      monthlyCounts(
        projectRows.map((row) => row.createdAt),
        12,
        projectRows.length,
        PROJECT_PAGE,
      ),
    [projectRows],
  );

  const addedLast30 = useMemo(
    () => countSince(projectRows.map((row) => row.createdAt), 30),
    [projectRows],
  );

  /* -- KPI: value ------------------------------------------------------ */
  const valueSummary = useMemo(() => summariseValue(projectRows), [projectRows]);
  const primaryCurrency = valueSummary.groups[0];

  /* -- KPI: signals ---------------------------------------------------- */
  const openSignalCount = useMemo(() => {
    if (stats.status !== "ready") return null;
    let open = 0;
    for (const [disposition, count] of Object.entries(stats.data.byDisposition ?? {})) {
      if (OPEN_DISPOSITIONS.has(disposition)) open += Number(count) || 0;
    }
    return open;
  }, [stats]);

  const signalSeries = useMemo(
    () =>
      dailyCounts(
        signalRows.map((row) => row.createdAt),
        14,
        signalRows.length,
        SIGNAL_PAGE,
      ),
    [signalRows],
  );

  /* -- KPI: activity --------------------------------------------------- */
  const ledgerRows = ledger.status === "ready" ? ledger.data.items : [];
  const ledgerTotal = ledger.status === "ready" ? ledger.data.total : 0;
  const activitySeries = useMemo(
    () =>
      dailyCounts(
        ledgerRows.map((row) => row.at),
        14,
        ledgerRows.length,
        LEDGER_PAGE,
      ),
    [ledgerRows],
  );

  /* -- chart ------------------------------------------------------------ */
  const stageData = useMemo(() => {
    const currency = primaryCurrency?.currency;
    return PROJECT_STAGES.map((stage) => {
      const rows = projectRows.filter((row) => row.stage === stage);
      let value: number | null = null;
      for (const row of rows) {
        if (currency && (row.currency || "USD") !== currency) continue;
        const amount = toNumberOrNull(row.value);
        if (amount === null) continue;
        value = (value ?? 0) + amount;
      }
      return {
        stage: PROJECT_STAGE_LABEL[stage] ?? formatStatusLabel(stage),
        count: rows.length,
        value,
      };
    }).filter((entry) => entry.count > 0);
  }, [projectRows, primaryCurrency]);

  const chartHasValues = stageData.some((entry) => entry.value !== null);

  /* -- table ------------------------------------------------------------ */
  const signalsByProject = useMemo(() => {
    const map = new Map<string, SignalRow[]>();
    for (const row of openSignalRows) {
      if (!row.projectId) continue;
      const bucket = map.get(row.projectId);
      if (bucket) bucket.push(row);
      else map.set(row.projectId, [row]);
    }
    return map;
  }, [openSignalRows]);

  const columns = useMemo<DataColumns<ProjectRow>>(
    () => [
      {
        id: "name",
        header: "Project",
        headerText: "Project",
        accessor: "name",
        width: 260,
        minWidth: 180,
        sticky: "start",
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate font-medium text-content">{row.name}</span>
            <span className="truncate text-meta text-content-subtle">
              {row.number ? `#${row.number}` : "No project number"}
            </span>
          </span>
        ),
      },
      {
        id: "stage",
        header: "Stage",
        headerText: "Stage",
        accessor: "stage",
        type: "enum",
        width: 156,
        options: PROJECT_STAGES.map((stage) => ({
          value: stage,
          text: PROJECT_STAGE_LABEL[stage] ?? stage,
          tone: stageTone(stage),
        })),
        cell: ({ row }) => (
          <Badge tone={stageTone(row.stage)} dot>
            {stageLabel(row.stage)}
          </Badge>
        ),
      },
      {
        id: "value",
        header: "Contract value",
        headerText: "Contract value",
        headerTooltip:
          "As recorded on the project. Projects are never converted between currencies.",
        accessor: (row) => toNumberOrNull(row.value),
        type: "number",
        align: "right",
        width: 150,
        mono: true,
        sortDescFirst: true,
        aggregate: "none",
        cell: ({ row }) => {
          const amount = toNumberOrNull(row.value);
          if (amount === null) {
            return (
              <span className="text-content-subtle" title="No contract value recorded">
                —
              </span>
            );
          }
          return (
            <span className="tabular-nums">
              {formatCurrency(amount, { currency: row.currency || "USD", compact: true })}
            </span>
          );
        },
      },
      {
        id: "elapsed",
        header: "Elapsed",
        headerText: "Elapsed",
        headerTooltip:
          "Calendar time between the project's start and finish dates. This is schedule elapsed, NOT work progress — ConstructOS has no portfolio-level progress source.",
        accessor: (row) => elapsedPercent(row.startDate, row.finishDate),
        type: "number",
        width: 168,
        align: "left",
        cell: ({ row }) => {
          const pct = elapsedPercent(row.startDate, row.finishDate);
          if (pct === null) {
            return (
              <span
                className="text-content-subtle"
                title="No start and finish dates on this project"
              >
                —
              </span>
            );
          }
          return (
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-surface-sunken"
              >
                <span
                  className={cx(
                    "block h-full rounded-full",
                    pct >= 100 ? "bg-success-solid" : "bg-accent",
                  )}
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="shrink-0 tabular-nums text-content-muted">{Math.round(pct)}%</span>
            </span>
          );
        },
      },
      {
        id: "health",
        header: "Health",
        headerText: "Health",
        headerTooltip:
          "Derived from open integrity signals raised against the project. It is not a schedule or cost score.",
        width: 150,
        sortable: false,
        cell: ({ row }) => {
          const open = signalsByProject.get(row.id) ?? [];
          if (open.length > 0) {
            const worst = open.reduce<Severity>((current, signal) => {
              const severity = asSeverity(signal.severity);
              return SEVERITY_RANK[severity] > SEVERITY_RANK[current] ? severity : current;
            }, "info");
            return (
              <Badge
                tone={severityToTone(worst)}
                dot
                title={`${open.length} open signal(s), worst severity ${SEVERITY_LABEL[worst]}`}
              >
                {open.length} open
              </Badge>
            );
          }
          if (signalsComplete) {
            return (
              <Badge tone="success" dot>
                Clear
              </Badge>
            );
          }
          return (
            <span
              className="text-content-subtle"
              title="Only the most recent signals were fetched, so this project cannot be confirmed clear."
            >
              —
            </span>
          );
        },
      },
    ],
    [signalsByProject, signalsComplete],
  );

  /* -- activity --------------------------------------------------------- */
  const activityItems = useMemo<TimelineItem[]>(
    () =>
      ledgerRows.slice(0, 24).map((row) => ({
        id: String(row.seq),
        title: (
          <span className="text-content">
            <span className="font-medium">{formatStatusLabel(row.action)}</span>{" "}
            <span className="text-content-muted">{formatStatusLabel(row.objectType)}</span>
          </span>
        ),
        description: <span className="font-mono text-2xs">{row.objectId}</span>,
        timestamp: row.at,
        icon: ACTION_ICON[row.action] ?? IconActivity,
        tone: ACTION_TONE[row.action] ?? "neutral",
      })),
    [ledgerRows],
  );

  const firstName = user?.name?.split(" ")[0] ?? "there";

  return (
    <div className="flex flex-col gap-section">
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        subtitle={
          company
            ? `${company.name} — portfolio, assurance and activity at a glance.`
            : "Portfolio, assurance and activity at a glance."
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={IconRefresh}
              loading={reloading}
              onClick={reload}
            >
              Refresh
            </Button>
            <Button size="sm" icon={IconProject} onClick={() => navigate("/projects")}>
              All projects
            </Button>
          </>
        }
      />

      {/* ---------------------------------------------------------------- KPIs */}
      <section aria-label="Portfolio indicators" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard>
          {projects.status === "loading" ? (
            <StatSkeleton />
          ) : projects.status === "error" ? (
            <StatUnavailable label="Active projects" reason={projects.message} />
          ) : (
            <Stat
              label="Active projects"
              value={formatNumber(activeProjects)}
              icon={IconProject}
              tone="accent"
              trend={addedLast30 > 0 ? "up" : "flat"}
              deltaLabel={`${addedLast30} added in 30 days`}
              hint={`${projectsTotal} in the portfolio`}
              {...seriesTile({
                series: projectSeries.series,
                covered: projectSeries.covered,
                tone: "accent",
                ariaLabel: "Projects created per month over the last 12 months",
                caption: "Projects created per month, last 12 months",
                uncoveredReason: `Trend unavailable — only the newest ${projectRows.length} of ${projectsTotal} projects were fetched.`,
                emptyReason: "No project created in the last 12 months.",
              })}
            />
          )}
        </KpiCard>

        <KpiCard>
          {projects.status === "loading" ? (
            <StatSkeleton />
          ) : projects.status === "error" ? (
            <StatUnavailable label="Portfolio value" reason={projects.message} />
          ) : primaryCurrency ? (
            <Stat
              label={`Portfolio value (${primaryCurrency.currency})`}
              value={formatCurrency(primaryCurrency.total, {
                currency: primaryCurrency.currency,
                compact: true,
              })}
              icon={IconBudget}
              tone="success"
              hint={`${primaryCurrency.count} of ${projectRows.length} projects`}
              footer={
                <span className="flex flex-col gap-0.5">
                  {valueSummary.withoutValue > 0 ? (
                    <span>
                      {valueSummary.withoutValue} project
                      {valueSummary.withoutValue === 1 ? "" : "s"} carry no contract value and are
                      excluded.
                    </span>
                  ) : null}
                  {valueSummary.groups.length > 1 ? (
                    <span>
                      {valueSummary.groups
                        .slice(1)
                        .map(
                          (group) =>
                            `${formatCurrency(group.total, { currency: group.currency, compact: true })} in ${group.currency}`,
                        )
                        .join(" · ")}{" "}
                      — never added across currencies.
                    </span>
                  ) : null}
                  {valueSummary.withoutValue === 0 && valueSummary.groups.length === 1
                    ? "Every project carries a contract value."
                    : null}
                </span>
              }
            />
          ) : (
            <StatUnavailable
              label="Portfolio value"
              reason={
                projectRows.length === 0
                  ? "There are no projects in this company yet."
                  : "No project in this portfolio has a contract value recorded."
              }
            />
          )}
        </KpiCard>

        <KpiCard>
          {stats.status === "loading" ? (
            <StatSkeleton />
          ) : stats.status === "error" || openSignalCount === null ? (
            <StatUnavailable
              label="Open signals"
              reason={stats.status === "error" ? stats.message : "The signal statistics endpoint returned no breakdown."}
            />
          ) : (
            <Stat
              label="Open signals"
              value={formatNumber(openSignalCount)}
              icon={IconAssurance}
              tone={openSignalCount > 0 ? "warning" : "success"}
              higherIsBetter={false}
              hint={`${stats.data.total} raised in total`}
              {...seriesTile({
                series: signalSeries.series,
                covered: signalSeries.covered,
                tone: "warning",
                ariaLabel: "Signals raised per day over the last 14 days",
                caption: "Signals raised per day, last 14 days",
                uncoveredReason: "Trend unavailable — only the newest 200 signals were fetched.",
                emptyReason: "No signal raised in the last 14 days.",
              })}
            />
          )}
        </KpiCard>

        <KpiCard>
          {ledger.status === "loading" ? (
            <StatSkeleton />
          ) : ledger.status === "error" ? (
            <StatUnavailable label="Recorded events" reason={ledger.message} />
          ) : (
            <Stat
              label="Ledger entries"
              value={formatNumber(ledgerTotal)}
              icon={IconActivity}
              tone="highlight"
              hint={
                unreadNotifications !== null && unreadNotifications > 0
                  ? `${unreadNotifications} unread notification${unreadNotifications === 1 ? "" : "s"}`
                  : "Append-only, hash-chained"
              }
              {...seriesTile({
                series: activitySeries.series,
                covered: activitySeries.covered,
                tone: "highlight",
                ariaLabel: "Ledger entries recorded per day over the last 14 days",
                caption: "Entries recorded per day, last 14 days",
                uncoveredReason: "Trend unavailable — only the newest 100 ledger entries were fetched.",
                emptyReason: "Nothing recorded in the last 14 days.",
              })}
            />
          )}
        </KpiCard>
      </section>

      {/* ------------------------------------------------------------- charts */}
      <div className="grid gap-section xl:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-section xl:col-span-2">
          <ChartCard
            title="Portfolio by stage"
            subtitle={
              primaryCurrency
                ? `Contract value in ${primaryCurrency.currency}, and project count`
                : "Project count by delivery stage"
            }
            icon={IconChartBar}
            loading={projects.status === "loading"}
            actions={
              <SegmentedControl<ChartMode>
                value={chartMode}
                onChange={setChartMode}
                aria-label="Chart measure"
                size="xs"
                options={[
                  { value: "value", label: "Value", disabled: !chartHasValues },
                  { value: "count", label: "Projects" },
                ]}
              />
            }
            footnote={
              chartMode === "value" && primaryCurrency
                ? `Only projects denominated in ${primaryCurrency.currency} are summed. ${valueSummary.withoutValue} project${valueSummary.withoutValue === 1 ? "" : "s"} without a recorded value are excluded.`
                : projectsTruncated
                  ? `Showing the newest ${projectRows.length} of ${projectsTotal} projects.`
                  : undefined
            }
          >
            <BarChart
              data={stageData}
              categoryKey="stage"
              series={
                chartMode === "value"
                  ? [{ key: "value", label: "Contract value", tone: "accent" }]
                  : [{ key: "count", label: "Projects", tone: "info" }]
              }
              valueFormat={chartMode === "value" ? "currency-compact" : "compact"}
              formatOptions={
                chartMode === "value" && primaryCurrency
                  ? { currency: primaryCurrency.currency }
                  : undefined
              }
              height={260}
              grid="y"
              ariaLabel="Portfolio by delivery stage"
              error={projects.status === "error" ? projects.message : null}
              empty={
                projects.status === "ready" &&
                (stageData.length === 0 || (chartMode === "value" && !chartHasValues))
              }
              emptyTitle={stageData.length === 0 ? "No projects" : "No contract values"}
              emptyMessage={
                stageData.length === 0
                  ? "This company has no projects yet, so there is nothing to break down by stage."
                  : "No project carries a contract value, so a value breakdown would be fabricated. Switch to Projects to see the count by stage."
              }
            />
          </ChartCard>

          <Card>
            <CardHeader
              title="Projects"
              subtitle={
                projectsTruncated
                  ? `Newest ${projectRows.length} of ${projectsTotal}`
                  : `${projectRows.length} project${projectRows.length === 1 ? "" : "s"}`
              }
              icon={IconProject}
              actions={
                <Button variant="ghost" size="xs" onClick={() => navigate("/projects")}>
                  Open Projects
                </Button>
              }
            />
            <CardBody flush>
              <DataTable<ProjectRow>
                data={projectRows}
                columns={columns}
                getRowId={(row) => row.id}
                tableId="dashboard.portfolio"
                loading={projects.status === "loading"}
                error={projects.status === "error" ? projects.message : null}
                onRetry={reload}
                rowHref={(row) => `/projects/${row.id}`}
                rowLabel={(row) => row.name}
                onRowClick={({ row }) => navigate(`/projects/${row.id}`)}
                stickyHeader
                flush
                paginated
                pageSize={10}
                searchable
                searchPlaceholder="Filter projects…"
                exportFileName="portfolio"
                savedViews={false}
                defaultSort={[{ id: "value", desc: true }]}
                empty={{
                  icon: IconProject,
                  title: "No projects yet",
                  description:
                    "Projects hold drawings, RFIs, submittals, budgets and the evidence behind them.",
                  action: (
                    <Button size="sm" onClick={() => navigate("/projects")}>
                      Go to Projects
                    </Button>
                  ),
                }}
                aria-label="Portfolio"
              />
            </CardBody>
          </Card>
        </div>

        {/* ------------------------------------------------------------ rail */}
        <div className="flex min-w-0 flex-col gap-section">
          <Card>
            <CardHeader
              title="Open signals"
              subtitle="Integrity detections awaiting a reviewer"
              icon={IconAssurance}
              actions={
                openSignalCount !== null && openSignalCount > 0 ? (
                  <Badge tone="warning">{openSignalCount}</Badge>
                ) : null
              }
            />
            <CardBody flush>
              <SignalsPanel
                state={signals}
                open={openSignalRows}
                openTotal={openSignalCount}
                complete={signalsComplete}
              />
            </CardBody>
            <CardFooter align="between">
              <span className="text-meta text-content-subtle">
                {signalsComplete ? "All signals loaded" : `Newest ${signalRows.length} loaded`}
              </span>
              <Button variant="ghost" size="xs" onClick={() => navigate("/assurance")}>
                Open Assurance
              </Button>
            </CardFooter>
          </Card>

          <Card>
            <CardHeader
              title="Activity"
              subtitle="Straight from the hash-chained ledger"
              icon={IconActivity}
            />
            <CardBody className="max-h-[24rem] overflow-y-auto overscroll-contain">
              {ledger.status === "loading" ? (
                <FeedSkeleton />
              ) : ledger.status === "error" ? (
                <EmptyState
                  size="sm"
                  tone="danger"
                  title="Activity could not be loaded"
                  hint={ledger.message}
                  action={
                    <Button size="xs" variant="secondary" onClick={reload}>
                      Try again
                    </Button>
                  }
                />
              ) : activityItems.length === 0 ? (
                <EmptyState
                  size="sm"
                  icon={IconActivity}
                  title="Nothing recorded yet"
                  hint="The ledger records every create, update and state change. It fills as the team works."
                />
              ) : (
                <ActivityFeed
                  items={activityItems}
                  timeFormat="relative"
                  compact
                  aria-label="Recent ledger activity"
                />
              )}
            </CardBody>
            <CardFooter align="between">
              <span className="text-meta text-content-subtle">
                {ledger.status === "ready" ? `${formatNumber(ledgerTotal)} entries in the chain` : ""}
              </span>
              <Button variant="ghost" size="xs" onClick={() => navigate("/ledger")}>
                Open Ledger
              </Button>
            </CardFooter>
          </Card>

          {stats.status === "ready" && stats.data.total > 0 ? (
            <Card>
              <CardHeader
                title="Signals by severity"
                subtitle={`${formatNumber(stats.data.total)} raised, all dispositions`}
                icon={IconWarning}
              />
              <CardBody>
                <SeverityBreakdown bySeverity={stats.data.bySeverity} total={stats.data.total} />
              </CardBody>
              <CardFooter muted>
                Counts cover every signal ever raised against this company. A severity with no
                signals is shown as zero because that is the recorded count, not a missing value.
              </CardFooter>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ==========================================================================
   Pieces
========================================================================== */

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function KpiCard({ children }: { children: ReactNode }) {
  return (
    <Card>
      <CardBody>{children}</CardBody>
    </Card>
  );
}

/**
 * The sparkline half of a KPI tile — and its refusal to mislead.
 *
 *   • the page we fetched cannot cover the window  → no plot, the caption says why
 *   • the window is covered but every value is 0   → no plot, the caption says so
 *     (all-zero readings would render as mid-height bars, reading as activity
 *     that did not happen)
 *   • otherwise                                    → plot the real series
 */
function seriesTile(options: {
  series: readonly number[];
  covered: boolean;
  tone: Tone;
  ariaLabel: string;
  caption: string;
  uncoveredReason: string;
  emptyReason: string;
}): { sparkline?: ReactNode; footer: ReactNode } {
  if (!options.covered) return { footer: options.uncoveredReason };
  if (options.series.every((value) => value === 0)) return { footer: options.emptyReason };
  return {
    sparkline: (
      <Sparkline
        data={[...options.series]}
        variant="bar"
        tone={options.tone}
        width={220}
        height={32}
        ariaLabel={options.ariaLabel}
        emptyMessage={options.emptyReason}
      />
    ),
    footer: options.caption,
  };
}

function StatSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <Skeleton className="h-3 w-24 rounded" />
      <Skeleton className="h-7 w-28 rounded-md" />
      <Skeleton className="h-8 w-full rounded" />
      <Skeleton className="h-3 w-32 rounded" />
    </div>
  );
}

/**
 * The tile for a metric we could not source. It states the reason and shows an
 * em-dash — it never shows a zero, which would be a claim about the business.
 */
function StatUnavailable({ label, reason }: { label: string; reason: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-label uppercase text-content-subtle">{label}</span>
      <span className="text-display-xs font-semibold leading-tight text-content-disabled">—</span>
      <span className="mt-1 text-meta text-content-subtle">Not available</span>
      <span className="mt-2 border-t border-border-subtle pt-2 text-meta text-content-subtle">
        {reason}
      </span>
    </div>
  );
}

function FeedSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} className="flex gap-2.5">
          <Skeleton className="size-6 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/3 rounded" />
            <Skeleton className="h-3 w-1/3 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SeverityBreakdown({
  bySeverity,
  total,
}: {
  bySeverity: Record<string, number>;
  total: number;
}) {
  const rows = [...SEVERITIES]
    .reverse()
    .map((severity) => ({ severity, count: Number(bySeverity[severity] ?? 0) }));
  const max = rows.reduce((peak, row) => Math.max(peak, row.count), 0);

  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map(({ severity, count }) => (
        <li key={severity} className="flex items-center gap-2.5">
          <span className="w-16 shrink-0 text-meta text-content-muted">
            {SEVERITY_LABEL[severity]}
          </span>
          <span
            aria-hidden="true"
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunken"
          >
            <span
              className={cx("block h-full rounded-full", TONE_BAR[severityToTone(severity)])}
              style={{ width: max > 0 ? `${(count / max) * 100}%` : "0%" }}
            />
          </span>
          <span className="w-14 shrink-0 text-right text-meta tabular-nums text-content">
            {formatNumber(count)}
            <span className="ml-1 text-content-subtle">
              {total > 0 ? `${Math.round((count / total) * 100)}%` : ""}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function SignalsPanel({
  state,
  open,
  openTotal,
  complete,
}: {
  state: Async<ListResponse<SignalRow>>;
  open: readonly SignalRow[];
  openTotal: number | null;
  complete: boolean;
}) {
  if (state.status === "loading") {
    return (
      <div className="p-card">
        <FeedSkeleton />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="p-card">
        <EmptyState
          size="sm"
          tone="danger"
          title="Signals could not be loaded"
          hint={state.message}
        />
      </div>
    );
  }

  if (open.length === 0) {
    /* The count and the list come from different endpoints. When the counter
       says there are open signals but none appear in the page we fetched, say
       exactly that rather than claiming the portfolio is clear. */
    if (openTotal !== null && openTotal > 0) {
      return (
        <div className="p-card">
          <EmptyState
            size="sm"
            tone="warning"
            icon={IconAssurance}
            title={`${openTotal} open signal${openTotal === 1 ? "" : "s"}, none in this page`}
            hint="Every open signal is older than the most recent 200 records loaded here. Open Assurance to review them."
          />
        </div>
      );
    }
    return (
      <div className="p-card">
        <EmptyState
          size="sm"
          tone="success"
          icon={IconAssurance}
          title="No open signals"
          hint={
            complete
              ? "Every signal raised against this company has been dispositioned."
              : "Nothing open in the most recent 200 signals."
          }
        />
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border-subtle">
      {open.slice(0, 6).map((signal) => (
        <li key={signal.id} className="px-card py-2.5">
          <div className="flex items-start gap-2.5">
            <Badge tone={severityToTone(signal.severity)} size="xs" dot>
              {SEVERITY_LABEL[asSeverity(signal.severity)]}
            </Badge>
            <div className="min-w-0 flex-1">
              <p className="truncate text-body font-medium text-content">{signal.title}</p>
              <p className="mt-0.5 line-clamp-2 text-meta text-content-subtle">
                {signal.explanation}
              </p>
              <p className="mt-1 flex items-center gap-1.5 text-meta text-content-subtle">
                <span className="font-mono text-2xs">{signal.detector}</span>
                <span aria-hidden="true">·</span>
                <span>{formatRelativeTime(signal.createdAt)}</span>
              </p>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
