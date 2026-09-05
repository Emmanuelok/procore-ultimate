/**
 * SITE OVERVIEW — what is live on the site right now, what the sweeps found,
 * and what the platform cannot tell you (with the reason).
 */
import { toast } from "sonner";
import { Badge, Button, Card, CardBody, EmptyState } from "../../ui";
import { DataTable, type DataColumns } from "../../ui/data";
import { IconSite, IconZap } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  DETECTOR_LABEL,
  EM_DASH,
  FigureCell,
  LoadError,
  ReasonList,
  RefusalNotice,
  SEVERITY_TONE,
  SectionHeading,
  dateTime,
  labelize,
  num,
  useAction,
  useResource,
  type HealthInputs,
  type Loadable,
  type ListResponse,
  type SignalRow,
  type Summary,
} from "./siteShared";

const METRIC_LABEL: Record<string, string> = {
  siteHeadcount: "People on site",
  siteOverstays: "Overstays on the register",
  sitePermitsActive: "Permits active",
  sitePermitsExpiredOpen: "Permits lapsed while open",
  siteConfinedSpaceOverdue: "Overdue out of a permitted space",
  siteLoneWorkerEscalated: "Lone-worker escalations",
  sitePassesWithoutInduction: "Passes beyond valid inductions",
  siteOpenGroundFindings: "Open ground findings",
  siteUtilityStrikes: "Utility strikes",
  siteEnvironmentalExceedances: "Environmental exceedances",
  siteProgressOverclaims: "Progress overclaims",
  siteWorstProgressVariance: "Worst progress variance (pp)",
  siteScanDeviationsOutOfTolerance: "Scan reports out of tolerance",
  siteExceptionalWeatherDays: "Exceptional weather days",
  siteSettingOutAwaitingCheck: "Setting out awaiting a check",
  siteOpenSignals: "Open site signals",
};

export default function OverviewTab({
  projectId,
  summary,
  onOpenTab,
}: {
  projectId: string;
  summary: Loadable<Summary>;
  onOpenTab: (tab: string) => void;
}) {
  const health = useResource<HealthInputs>(`/api/v1/projects/${projectId}/site/health-inputs`);
  const signals = useResource<ListResponse<SignalRow>>(`/api/v1/projects/${projectId}/site/signals?pageSize=50`);
  const action = useAction();
  const s = summary.data;

  async function runSweeps() {
    const r = await action.run("sweeps", () =>
      api.post<{ ranAt: string; permits: { expired: number }; loneWorkers: { escalated: number } }>(
        `/api/v1/projects/${projectId}/site/sweeps/run`,
        {},
      ),
    );
    if (r) {
      toast.success("Site sweeps run");
      summary.reload();
      signals.reload();
      health.reload();
    }
  }

  const signalColumns: DataColumns<SignalRow> = [
    {
      id: "severity",
      header: "Severity",
      accessor: "severity",
      type: "status",
      width: 110,
      groupable: true,
      cell: ({ row }) => (
        <Badge tone={SEVERITY_TONE[row.severity] ?? "neutral"} size="xs" dot>
          {labelize(row.severity)}
        </Badge>
      ),
    },
    {
      id: "detector",
      header: "Detector",
      accessor: (row) => DETECTOR_LABEL[row.detector] ?? row.detector,
      type: "text",
      width: 220,
      groupable: true,
    },
    { id: "title", header: "Finding", accessor: "title", type: "text", width: 380 },
    { id: "explanation", header: "Because", accessor: "explanation", type: "text", width: 520 },
    { id: "disposition", header: "Disposition", accessor: "disposition", type: "status", width: 130, groupable: true },
    { id: "createdAt", header: "Raised", accessor: "createdAt", type: "datetime", width: 170, cell: ({ row }) => dateTime(row.createdAt) },
  ];

  return (
    <div className="space-y-4">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
      {summary.error ? <LoadError message={summary.error} onRetry={summary.reload} title="The site summary could not be loaded" /> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <CardBody>
            <div className="text-label uppercase text-content-subtle">On site now</div>
            <div className="text-display-xs font-semibold tabular-nums text-content">
              {s ? (s.register.reasons.length > 0 && s.register.headcount === 0 ? EM_DASH : num(s.register.headcount)) : EM_DASH}
            </div>
            <ReasonList reasons={s?.register.reasons ?? []} className="mt-1.5" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-label uppercase text-content-subtle">Permits active</div>
            <div className="text-display-xs font-semibold tabular-nums text-content">{s ? num(s.permits.active) : EM_DASH}</div>
            <div className="mt-1 text-2xs text-content-muted">
              {s ? `${num(s.permits.open)} open · ${num(s.permits.expired)} lapsed` : "…"}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-label uppercase text-content-subtle">In a permitted space</div>
            <div className={`text-display-xs font-semibold tabular-nums ${(s?.entries.overdue ?? 0) > 0 ? "text-danger-fg" : "text-content"}`}>
              {s ? num(s.entries.inside) : EM_DASH}
            </div>
            <div className="mt-1 text-2xs text-content-muted">{s ? `${num(s.entries.overdue)} overdue out` : "…"}</div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-label uppercase text-content-subtle">Lone workers</div>
            <div className={`text-display-xs font-semibold tabular-nums ${(s?.loneWorkers.escalated ?? 0) > 0 ? "text-danger-fg" : "text-content"}`}>
              {s ? num(s.loneWorkers.active) : EM_DASH}
            </div>
            <div className="mt-1 text-2xs text-content-muted">
              {s ? `${num(s.loneWorkers.overdue)} overdue · ${num(s.loneWorkers.escalated)} escalated` : "…"}
            </div>
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card>
          <CardBody className="space-y-2">
            <SectionHeading title="Access" hint="Credentials in force and what stands behind them." />
            <dl className="space-y-1.5 text-meta">
              <Row label="Active passes" value={s ? num(s.access.activePasses) : EM_DASH} />
              <Row label="Valid inductions" value={s ? num(s.access.validInductions) : EM_DASH} />
              <Row label="Passes expiring within 30 days" value={s ? num(s.access.expiringPasses) : EM_DASH} />
              <Row label="Overstays on the register" value={s ? num(s.register.overstays) : EM_DASH} />
              <Row label="Refused reads in the window" value={s ? num(s.register.refusedEvents) : EM_DASH} />
            </dl>
            <Button size="xs" variant="ghost" onClick={() => onOpenTab("access")}>
              Open the register
            </Button>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="space-y-2">
            <SectionHeading title="Ground, utilities and capture" hint="What is under the site and what has been measured on it." />
            <dl className="space-y-1.5 text-meta">
              <Row label="Open ground findings" value={s ? num(s.ground.openFindings) : EM_DASH} />
              <Row label="Utility strikes" value={s ? `${num(s.ground.strikes)} (${num(s.ground.nearMisses)} near miss)` : EM_DASH} />
              <Row label="Scans" value={s ? num(s.capture.scans) : EM_DASH} />
              <Row label="Deviation reports out of tolerance" value={s ? num(s.capture.deviationsOutOfTolerance) : EM_DASH} />
              <Row label="Setting out awaiting a check" value={s ? num(s.settingOut.awaitingCheck) : EM_DASH} />
            </dl>
            <Button size="xs" variant="ghost" onClick={() => onOpenTab("ground")}>
              Open ground &amp; utilities
            </Button>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="space-y-2">
            <SectionHeading title="Weather and progress" hint="Entitlement the archive supports, and claims the site has tested." />
            <dl className="space-y-1.5 text-meta">
              <Row label="Weather observations held" value={s ? num(s.weather.observations) : EM_DASH} />
              <Row label="Last observation" value={s?.weather.lastObservedOn ?? EM_DASH} />
              <Row
                label="Exceptional days (latest analysis)"
                value={
                  <FigureCell
                    value={s?.weather.lastExceptionalDays ?? null}
                    reasons={["No exceptional-weather analysis has been run for this project yet."]}
                    render={(v) => num(v, 2)}
                  />
                }
              />
              <Row label="Progress observations" value={s ? num(s.progress.observations) : EM_DASH} />
              <Row
                label="Worst overclaim"
                value={
                  <FigureCell
                    value={s?.progress.worstVariance.value ?? null}
                    reasons={s?.progress.worstVariance.reasons ?? []}
                    render={(v) => `${num(v, 1)} pp`}
                  />
                }
              />
            </dl>
            <Button size="xs" variant="ghost" onClick={() => onOpenTab("progress")}>
              Open progress
            </Button>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardBody>
          <SectionHeading
            title="Open site signals"
            hint="Raised by the sweeps and the engines. Each one names the record it is about and why it was raised."
            actions={
              <Button size="sm" variant="secondary" icon={IconZap} loading={action.busy === "sweeps"} onClick={() => void runSweeps()}>
                Run the sweeps now
              </Button>
            }
          />
          {signals.error ? (
            <LoadError message={signals.error} onRetry={signals.reload} title="Signals could not be loaded" />
          ) : (signals.data?.items.length ?? 0) === 0 && !signals.loading ? (
            <EmptyState
              icon={IconSite}
              title="No site signals"
              description="Nothing on this site has tripped a detector. The sweeps run on a schedule; the button above runs them now."
            />
          ) : (
            <DataTable
              data={signals.data?.items ?? []}
              columns={signalColumns}
              getRowId={(row) => row.id}
              loading={signals.loading && !signals.data}
              height={360}
              stickyHeader
              exportFileName="site-signals"
              rowTone={(row) => (row.severity === "critical" || row.severity === "high" ? "danger" : undefined)}
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <SectionHeading
            title="What this site tells the intelligence layer"
            hint="These are the exact figures the project health score reads. A metric the platform cannot derive is shown as not available with the reason — never as a zero."
          />
          {health.error ? (
            <LoadError message={health.error} onRetry={health.reload} title="Health inputs could not be loaded" />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {Object.entries(health.data?.metrics ?? {}).map(([key, value]) => (
                  <div key={key} className="rounded-md border border-border-subtle bg-surface-sunken px-3 py-2">
                    <div className="text-2xs uppercase tracking-wide text-content-subtle">{METRIC_LABEL[key] ?? key}</div>
                    <div className="text-body font-semibold text-content">
                      <FigureCell value={value} reasons={health.data?.reasons ?? []} render={(v) => num(v, Number.isInteger(v) ? 0 : 1)} />
                    </div>
                  </div>
                ))}
              </div>
              <ReasonList reasons={health.data?.reasons ?? []} className="mt-3" />
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-content-muted">{label}</dt>
      <dd className="tabular-nums font-medium text-content">{value}</dd>
    </div>
  );
}
