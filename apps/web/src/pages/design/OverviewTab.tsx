/**
 * OVERVIEW — the decisions first: what is late, what is unanswered, what the
 * design is churning on, and every signal this module raised. Every number is
 * the API's, with its basis; nothing is fabricated when the inputs are absent.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Alert, Badge, Button, Card, CardBody, EmptyState, Stat } from "../../ui";
import { IconRefresh, IconZap } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  CurrencyRail,
  DETECTOR_LABEL,
  EM_DASH,
  FigureCell,
  LoadError,
  READINESS_TONE,
  ReasonList,
  RefusalNotice,
  SEVERITY_TONE,
  SectionHeading,
  dateTime,
  isoDate,
  labelize,
  num,
  pct,
  useAction,
  useResource,
  type Analytics,
  type HealthInputs,
  type Loadable,
  type Summary,
} from "./designShared";

interface SweepResult {
  deliverables: { assessed: number; signalsRaised: number; obligationsOpened: number };
  reviews: { checked: number; overdue: number; signalsRaised: number };
  issues: { checked: number; stale: number; signalsRaised: number };
  infoRequirements: { checked: number; overdue: number; obligationsOpened: number; signalsRaised: number };
  changeFrequency: { flagged: number; signalsRaised: number };
  professionalIndemnity: { consultants: number; inadequate: number; signalsRaised: number };
  readiness: { level: string; score: number | null; snapshotWritten: boolean };
}

export default function OverviewTab({
  projectId,
  summary,
  onOpenTab,
}: {
  projectId: string;
  summary: Loadable<Summary>;
  onOpenTab: (tab: string) => void;
}) {
  const base = `/api/v1/projects/${projectId}/design`;
  const analytics = useResource<Analytics>(`${base}/analytics`);
  const health = useResource<HealthInputs>(`${base}/health-inputs`);
  const action = useAction();
  const [lastSweep, setLastSweep] = useState<string | null>(null);

  async function runSweeps() {
    const r = await action.run("sweeps", () => api.post<SweepResult>(`${base}/sweeps/run`, {}));
    if (!r) return;
    const raised =
      r.deliverables.signalsRaised +
      r.reviews.signalsRaised +
      r.issues.signalsRaised +
      r.infoRequirements.signalsRaised +
      r.changeFrequency.signalsRaised +
      r.professionalIndemnity.signalsRaised;
    setLastSweep(
      `Assessed ${r.deliverables.assessed} deliverable(s), checked ${r.reviews.checked} review cycle(s) and ${r.issues.checked} issue(s), tested ${r.professionalIndemnity.consultants} consultant PI policy/policies; ${raised} new signal(s), ${r.deliverables.obligationsOpened + r.infoRequirements.obligationsOpened} obligation(s) opened. Readiness is ${labelize(r.readiness.level).toLowerCase()}.`,
    );
    toast.success(raised > 0 ? `${raised} new signal${raised === 1 ? "" : "s"} raised` : "Sweeps ran; nothing new");
    summary.reload();
    analytics.reload();
    health.reload();
  }

  const s = summary.data;
  const a = analytics.data;

  return (
    <div className="space-y-4">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
      {summary.error ? (
        <LoadError message={summary.error} onRetry={summary.reload} title="The summary could not be loaded" />
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Card>
          <CardBody>
            <Stat
              label="Deliverables late / at risk"
              value={s ? `${s.deliverables.late} / ${s.deliverables.atRisk}` : EM_DASH}
              tone={s && s.deliverables.late > 0 ? "danger" : s && s.deliverables.atRisk > 0 ? "warning" : "neutral"}
              hint={s ? `${s.deliverables.total} on the schedule · ${s.deliverables.issued} issued` : undefined}
              loading={summary.loading && !s}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Issued on time"
              value={
                s ? (
                  <FigureCell
                    value={s.deliverables.onTimePercent.value}
                    reasons={s.deliverables.onTimePercent.reasons}
                    render={(v) => pct(v)}
                  />
                ) : (
                  EM_DASH
                )
              }
              hint={s ? "Against the planned issue date on each row" : undefined}
              tone={s && s.deliverables.onTimePercent.value !== null && s.deliverables.onTimePercent.value < 80 ? "warning" : "neutral"}
              loading={summary.loading && !s}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Reviews open / overdue"
              value={s ? `${s.reviews.open} / ${s.reviews.overdue}` : EM_DASH}
              tone={s && s.reviews.overdue > 0 ? "danger" : "neutral"}
              hint={s ? `${s.comments.open} comment${s.comments.open === 1 ? "" : "s"} still open` : undefined}
              loading={summary.loading && !s}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Issues open"
              value={s ? num(s.issues.open) : EM_DASH}
              tone={s && s.issues.criticalOpen > 0 ? "danger" : "neutral"}
              hint={s ? `${s.issues.criticalOpen} critical or high` : undefined}
              loading={summary.loading && !s}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Change notices in flight"
              value={s ? num(s.changeNotices.open) : EM_DASH}
              tone={s && s.changeNotices.postFreeze > 0 ? "danger" : "neutral"}
              hint={s ? `${s.changeNotices.postFreeze} raised after a freeze · ${s.freezes.active} freeze(s) in force` : undefined}
              loading={summary.loading && !s}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Handover readiness"
              value={
                s ? (
                  <span className="inline-flex items-center gap-2">
                    <FigureCell
                      value={s.readiness.score}
                      reasons={s.readiness.computedAt ? ["The score has no scored dimension yet."] : ["Readiness has not been computed for this project yet."]}
                      render={(v) => num(v, 1)}
                    />
                    <Badge tone={READINESS_TONE[s.readiness.level] ?? "neutral"} size="xs" dot>
                      {labelize(s.readiness.level)}
                    </Badge>
                  </span>
                ) : (
                  EM_DASH
                )
              }
              hint={
                s?.readiness.computedAt
                  ? `${Math.round(s.readiness.confidence * 100)}% of the weighting had inputs · ${dateTime(s.readiness.computedAt)}`
                  : "Not computed yet"
              }
              loading={summary.loading && !s}
            />
          </CardBody>
        </Card>
      </div>

      {s && s.readiness.blockers.length > 0 ? (
        <Alert tone="warning" title="What is holding the design back from construction">
          <ReasonList reasons={s.readiness.blockers} />
          <button
            type="button"
            className="mt-2 text-meta font-medium text-accent-fg underline underline-offset-2"
            onClick={() => onOpenTab("readiness")}
          >
            Open the readiness assessment
          </button>
        </Alert>
      ) : null}

      <CurrencyRail
        map={s?.changeNotices.costByCurrency}
        label="Design change exposure"
        note={s?.changeNotices.currencyNote}
      />

      <Card>
        <CardBody>
          <SectionHeading
            title="Sweeps"
            hint="The same code the scheduler runs hourly: deliverable slippage, overdue reviews, stale issues, overdue information requirements, design churn and professional-indemnity adequacy. Running it twice on the same facts raises nothing the second time."
            actions={
              <Button size="sm" variant="secondary" leadingIcon={IconRefresh} loading={action.busy === "sweeps"} onClick={() => void runSweeps()}>
                Run every sweep
              </Button>
            }
          />
          {lastSweep ? <p className="text-meta text-content-muted">{lastSweep}</p> : null}
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardBody>
            <SectionHeading
              title="Open design signals"
              hint="Raised by this module's detectors, deduplicated per condition."
            />
            {summary.error ? null : (s?.signals.items ?? []).length === 0 ? (
              <EmptyState
                icon={IconZap}
                title="No design signal has been raised"
                description="Signals appear when a deliverable goes late, a review cycle passes its due date, a change lands after a freeze, an issue goes stale, a package churns or a consultant's professional indemnity falls short."
              />
            ) : (
              <ul className="divide-y divide-border-subtle">
                {(s?.signals.items ?? []).slice(0, 8).map((signal) => (
                  <li key={signal.id} className="py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={SEVERITY_TONE[signal.severity] ?? "neutral"} size="xs" dot>
                        {labelize(signal.severity)}
                      </Badge>
                      <span className="text-meta font-medium text-content">{signal.title}</span>
                      <Badge tone="neutral" size="xs">
                        {DETECTOR_LABEL[signal.detector] ?? labelize(signal.detector)}
                      </Badge>
                      <span className="text-2xs text-content-subtle">{dateTime(signal.createdAt)}</span>
                    </div>
                    <p className="mt-1 text-meta text-content-muted">{signal.explanation}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <SectionHeading title="Design churn by package" hint="Change notices submitted per 30 days, per package (#906)." />
            {analytics.error ? (
              <LoadError message={analytics.error} onRetry={analytics.reload} />
            ) : (a?.changeFrequency ?? []).length === 0 ? (
              <EmptyState
                icon={IconZap}
                title="No package has taken a change notice in the window"
                description="Churn is measured over the last 90 days of submitted change notices."
              />
            ) : (
              <ul className="divide-y divide-border-subtle">
                {(a?.changeFrequency ?? []).slice(0, 8).map((entry) => (
                  <li key={entry.packageId} className="py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-meta text-content">{entry.reference ?? entry.packageId}</span>
                      <Badge tone={entry.exceedsThreshold ? "danger" : "neutral"} size="xs" dot>
                        {num(entry.ratePerMonth, 1)} / 30 days
                      </Badge>
                      {entry.postFreeze > 0 ? (
                        <Badge tone="danger" size="xs">
                          {entry.postFreeze} post-freeze
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-2xs text-content-muted">{entry.basis}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardBody>
          <SectionHeading
            title="Review performance"
            hint="Turnaround from issue to close, and the rework multiple — how many issues a package needed before it was accepted (#900)."
          />
          {analytics.error ? (
            <LoadError message={analytics.error} onRetry={analytics.reload} />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat
                  label="Average turnaround"
                  value={<FigureCell value={a?.reviewCycles.averageTurnaroundDays} reasons={a?.reviewCycles.reasons ?? []} render={(v) => `${num(v, 1)} d`} />}
                  hint={a ? `${a.reviewCycles.cyclesClosed} closed · ${a.reviewCycles.cyclesOpen} open` : undefined}
                  loading={analytics.loading && !a}
                />
                <Stat
                  label="Closed on time"
                  value={<FigureCell value={a?.reviewCycles.onTimePercent} reasons={a?.reviewCycles.reasons ?? []} render={(v) => pct(v)} />}
                  hint={a ? `${a.reviewCycles.onTimeCount} on time · ${a.reviewCycles.lateCount} late` : undefined}
                  loading={analytics.loading && !a}
                />
                <Stat
                  label="Rework multiple"
                  value={<FigureCell value={a?.reviewCycles.reworkMultiple} reasons={a?.reviewCycles.reasons ?? []} render={(v) => num(v, 1)} />}
                  hint={a ? `${a.reviewCycles.packagesAccepted} package(s) reached an accepted code` : undefined}
                  loading={analytics.loading && !a}
                />
                <Stat
                  label="Cycles overdue now"
                  value={a ? num(a.reviewCycles.cyclesOverdue) : EM_DASH}
                  tone={a && a.reviewCycles.cyclesOverdue > 0 ? "danger" : "neutral"}
                  loading={analytics.loading && !a}
                />
              </div>
              {a && a.reviewCycles.reasons.length > 0 ? <ReasonList reasons={a.reviewCycles.reasons} className="mt-3" /> : null}
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <SectionHeading title="Health inputs" hint="What this module contributes to the project health score." />
          {health.error ? (
            <LoadError message={health.error} onRetry={health.reload} />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
                {Object.entries(health.data?.metrics ?? {}).map(([key, value]) => (
                  <div key={key} className="min-w-0">
                    <div className="truncate text-2xs uppercase tracking-wide text-content-subtle">{labelize(key.replace(/^design/, ""))}</div>
                    <div className="text-meta tabular-nums text-content">
                      {value === null ? <span className="italic text-content-subtle">not available</span> : num(value, 1)}
                    </div>
                  </div>
                ))}
              </div>
              {(health.data?.reasons ?? []).length > 0 ? <ReasonList reasons={health.data?.reasons ?? []} className="mt-3" /> : null}
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
