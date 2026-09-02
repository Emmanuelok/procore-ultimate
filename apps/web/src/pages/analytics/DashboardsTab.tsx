/**
 * Dashboards — prebuilt role dashboards and the widget grid (#741-742, #749).
 *
 * A dashboard's data comes from ONE call to GET /dashboards/:id/data, which
 * executes every widget server-side under the caller's own project reach. The
 * response is honest per widget: a widget whose report was deleted, whose
 * definition no longer resolves or whose project is out of reach carries its
 * own error, and the rest of the grid still renders. Widgets beyond the
 * server's cap are reported as `skipped`, never silently dropped.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Spinner,
} from "../../ui";
import { formatDateTime } from "../format";
import {
  AUDIENCE_LABELS,
  Caveat,
  Donut,
  HBars,
  LineChart,
  ResultTable,
  errorMessage,
  fmtNum,
  toSeries,
  type DashboardDataResponse,
  type DashboardRow,
  type ExecutionResult,
  type ListResponse,
  type MetricResult,
  type SeedResponse,
  type WidgetResult,
} from "./analyticsShared";

const SPAN_CLASS: Record<number, string> = {
  1: "lg:col-span-1",
  2: "lg:col-span-2",
  3: "lg:col-span-3",
  4: "lg:col-span-4",
};

function isExecutionResult(data: ExecutionResult | MetricResult): data is ExecutionResult {
  return "columns" in data && "rows" in data;
}

/* ------------------------------ widget bodies ----------------------------- */

function StatBody({ data }: { data: ExecutionResult | MetricResult }) {
  if (!isExecutionResult(data)) {
    return (
      <div>
        <div className="text-3xl font-semibold tabular-nums text-ink-900">{fmtNum(data.value, 0)}</div>
        <div className="mt-0.5 text-xs text-ink-400">{data.label}</div>
      </div>
    );
  }
  const numCol = data.columns.find((c) => c.type === "number");
  const value = numCol && data.rows.length > 0 ? Number(data.rows[0]![numCol.key]) : null;
  return (
    <div>
      <div className="text-3xl font-semibold tabular-nums text-ink-900">
        {value !== null && Number.isFinite(value) ? fmtNum(value) : fmtNum(data.rowCount, 0)}
      </div>
      <div className="mt-0.5 text-xs text-ink-400">
        {numCol && data.rows.length > 0 ? numCol.label : "rows returned"}
      </div>
    </div>
  );
}

function WidgetBody({ widget }: { widget: WidgetResult }) {
  if (widget.error) {
    return (
      <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 ring-1 ring-red-100">
        This widget could not run: {widget.error}
      </div>
    );
  }
  if (widget.data === null) {
    return <p className="py-4 text-center text-xs text-ink-400">No data returned.</p>;
  }

  if (widget.kind === "stat") return <StatBody data={widget.data} />;

  if (!isExecutionResult(widget.data)) {
    // a chart widget bound to a scalar metric still gets an honest rendering
    return <StatBody data={widget.data} />;
  }
  const result = widget.data;

  const truncationNote = result.truncated ? (
    <p className="mt-2 text-[11px] text-amber-700">
      Truncated — more rows matched than the widget's {fmtNum(result.limitRows, 0)}-row cap.
    </p>
  ) : null;

  if (result.rowCount === 0) {
    return <p className="py-4 text-center text-xs text-ink-400">No rows in scope.</p>;
  }

  if (widget.kind === "table") {
    return (
      <div>
        <ResultTable result={result} maxRows={8} />
        {truncationNote}
      </div>
    );
  }

  const series = toSeries(result);
  if (!series) {
    // no numeric column — a chart would be a lie; show the rows instead
    return (
      <div>
        <p className="mb-2 text-[11px] text-ink-400">
          No numeric column to chart — showing the rows.
        </p>
        <ResultTable result={result} maxRows={8} />
        {truncationNote}
      </div>
    );
  }

  const aria = `${widget.title}: ${series.valueName} by ${series.labelName}`;
  return (
    <div>
      {widget.kind === "bar" ? <HBars series={series} ariaLabel={aria} /> : null}
      {widget.kind === "line" ? <LineChart series={series} ariaLabel={aria} /> : null}
      {widget.kind === "donut" ? <Donut series={series} ariaLabel={aria} /> : null}
      {truncationNote}
    </div>
  );
}

/* ------------------------------ dashboard view ---------------------------- */

function DashboardView({
  dashboard,
  projectId,
  onBack,
}: {
  dashboard: DashboardRow;
  projectId: string;
  onBack: () => void;
}) {
  const [data, setData] = useState<DashboardDataResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<DashboardDataResponse>(
        `/api/v1/analytics/dashboards/${dashboard.id}/data`,
      );
      setData(res);
    } catch (err) {
      setData(null);
      setError(errorMessage(err, "Failed to execute the dashboard"));
    } finally {
      setLoading(false);
    }
  }, [dashboard.id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={onBack}>
            ← Back to dashboards
          </Button>
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-ink-900">
              {dashboard.name}
              {dashboard.audience ? (
                <Badge tone="violet">{AUDIENCE_LABELS[dashboard.audience] ?? dashboard.audience}</Badge>
              ) : null}
            </h2>
            <p className="text-xs text-ink-400">
              {dashboard.projectId
                ? dashboard.projectId === projectId
                  ? "scoped to this project"
                  : `scoped to project ${dashboard.projectId}`
                : "company-wide across the projects you can open"}
              {data ? ` · executed ${formatDateTime(data.executedAt)}` : ""}
            </p>
          </div>
        </div>
        <Button variant="secondary" onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      <ErrorAlert message={error} />

      {data === null && !error ? <Spinner label="Executing every widget…" /> : null}

      {data ? (
        <div className="space-y-3">
          {data.skipped > 0 ? (
            <Caveat>
              {data.skipped} {data.skipped === 1 ? "widget was" : "widgets were"} beyond the
              server's per-dashboard cap and did not execute.
            </Caveat>
          ) : null}
          {data.widgets.length === 0 ? (
            <EmptyState title="This dashboard has no widgets" />
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
              {data.widgets.map((w) => (
                <Card key={w.widgetId} className={SPAN_CLASS[w.span] ?? "lg:col-span-2"}>
                  <CardBody>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="text-xs font-medium uppercase tracking-wide text-ink-400">
                        {w.title}
                      </p>
                      <span className="text-[10px] uppercase tracking-wide text-ink-300">
                        {w.kind}
                      </span>
                    </div>
                    <WidgetBody widget={w} />
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ================================== Tab ================================== */

export default function DashboardsTab({ projectId }: { projectId: string }) {
  const [dashboards, setDashboards] = useState<DashboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seedBusy, setSeedBusy] = useState(false);
  const [seedNote, setSeedNote] = useState<string | null>(null);
  const [open, setOpen] = useState<DashboardRow | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<DashboardRow>>(
        `/api/v1/analytics/dashboards?projectId=${encodeURIComponent(projectId)}&pageSize=100`,
      );
      setDashboards(res.items);
    } catch (err) {
      setDashboards((prev) => prev ?? []);
      setError(errorMessage(err, "Failed to load dashboards"));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onSeed() {
    setSeedBusy(true);
    setSeedNote(null);
    setError(null);
    try {
      const res = await api.post<SeedResponse>("/api/v1/analytics/dashboards/seed-defaults", {
        projectId,
      });
      const parts: string[] = [];
      if (res.created.length > 0) parts.push(`created ${res.created.join(", ")}`);
      if (res.adopted.length > 0) parts.push(`adopted existing ${res.adopted.join(", ")}`);
      if (res.createdReports.length > 0) {
        parts.push(`seeded ${res.createdReports.length} backing report definitions`);
      }
      setSeedNote(
        parts.length > 0 ? `Role dashboards ${parts.join("; ")}.` : "Nothing to seed — the defaults already exist.",
      );
      await load();
    } catch (err) {
      setError(errorMessage(err, "Failed to seed the default dashboards"));
    } finally {
      setSeedBusy(false);
    }
  }

  if (open) {
    return <DashboardView dashboard={open} projectId={projectId} onBack={() => setOpen(null)} />;
  }

  if (dashboards === null) return <Spinner label="Loading dashboards…" />;

  return (
    <div>
      <ErrorAlert message={error} />
      {seedNote ? (
        <div className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-100">
          {seedNote}
        </div>
      ) : null}

      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="max-w-2xl text-xs text-ink-400">
          Dashboards for this project, plus the company-wide ones, which are marked as such.
          (A company-wide dashboard created through the API used to be invisible in every screen
          the app has.) Every widget executes under your own project reach, and seeded reports are
          ordinary shared definitions — open, edit or copy them from the Reports tab.
        </p>
        <Button onClick={() => void onSeed()} disabled={seedBusy}>
          {seedBusy ? "Seeding…" : "Seed role dashboards"}
        </Button>
      </div>

      {dashboards.length === 0 ? (
        <EmptyState
          title="No dashboards for this project yet"
          hint="Seed the prebuilt role dashboards — Project delivery, Commercial and Assurance — each backed by real, editable report definitions."
          action={
            <Button onClick={() => void onSeed()} disabled={seedBusy}>
              {seedBusy ? "Seeding…" : "Seed role dashboards"}
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {dashboards.map((d) => (
            <button key={d.id} type="button" className="text-left" onClick={() => setOpen(d)}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardBody>
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium text-ink-900">{d.name}</p>
                    <div className="flex shrink-0 gap-1">
                      {d.projectId === null ? (
                        <Badge tone="gray" title="Runs across every project you can open">
                          Company-wide
                        </Badge>
                      ) : null}
                      {d.isDefault === 1 ? <Badge tone="blue">Prebuilt</Badge> : null}
                    </div>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-ink-400">
                    {d.audience ? (
                      <Badge tone="violet">{AUDIENCE_LABELS[d.audience] ?? d.audience}</Badge>
                    ) : null}
                    <span>
                      {d.widgets.length} {d.widgets.length === 1 ? "widget" : "widgets"}
                    </span>
                  </div>
                </CardBody>
              </Card>
            </button>
          ))}
        </div>
      )}

    </div>
  );
}
