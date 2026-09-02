/**
 * OVERVIEW — the decisions first: what is late, what is at risk, which
 * deliveries clash with the programme, which suppliers the engine flagged,
 * and the open supply signals. Every number is the API's, with its basis.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Alert, Badge, Button, Card, CardBody, EmptyState, Skeleton, Stat } from "../../ui";
import { IconRefresh, IconZap } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  CurrencyRail,
  DETECTOR_LABEL,
  EM_DASH,
  FigureCell,
  LoadError,
  ReasonList,
  RefusalNotice,
  SectionHeading,
  SEVERITY_TONE,
  dateTime,
  isoDate,
  labelize,
  num,
  pct,
  useAction,
  useResource,
  type HealthInputs,
  type JitResponse,
  type Loadable,
  type Summary,
} from "./supplychainShared";

export default function OverviewTab({ projectId, summary, onOpenTab }: { projectId: string; summary: Loadable<Summary>; onOpenTab: (tab: string) => void }) {
  const base = `/api/v1/projects/${projectId}/supply-chain`;
  const jit = useResource<JitResponse>(`${base}/jit/conflicts`);
  const health = useResource<HealthInputs>(`${base}/health-inputs`);
  const action = useAction();
  const [lastSweep, setLastSweep] = useState<string | null>(null);

  async function runSweeps() {
    const r = await action.run("sweeps", async () => {
      const [ll, j, risk] = await Promise.all([
        api.post<{ assessed: number; signalsRaised: number }>(`${base}/long-lead/recompute`, {}),
        api.post<{ conflicts: number; signalsRaised: number }>(`${base}/jit/run`, {}),
        api.post<{ nodes: number; signalsRaised: number; snapshotsWritten: number }>(`${base}/risk/run`, {}),
      ]);
      return { ll, j, risk };
    });
    if (!r) return;
    const raised = r.ll.signalsRaised + r.j.signalsRaised + r.risk.signalsRaised;
    setLastSweep(`Assessed ${r.ll.assessed} long-lead item(s), ${r.j.conflicts} JIT conflict(s), ${r.risk.nodes} node(s); ${raised} new signal(s), ${r.risk.snapshotsWritten} risk verdict(s) changed.`);
    toast.success(raised > 0 ? `${raised} new signal${raised === 1 ? "" : "s"} raised` : "Sweeps ran; nothing new");
    summary.reload();
    jit.reload();
    health.reload();
  }

  const s = summary.data;

  return (
    <div className="space-y-4">
      {action.refusal ? <RefusalNotice refusal={action.refusal} onDismiss={action.clear} /> : null}
      {summary.error ? <LoadError message={summary.error} onRetry={summary.reload} title="The summary could not be loaded" /> : null}
      {s?.truncated && s.truncated.length > 0 ? (
        <Alert tone="warning" title="These figures are a lower bound">
          <ReasonList reasons={s.truncated} />
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Card>
          <CardBody>
            <Stat
              label="Long-lead late / at risk"
              value={s ? `${s.longLead.late} / ${s.longLead.atRisk}` : EM_DASH}
              tone={s && s.longLead.late > 0 ? "danger" : s && s.longLead.atRisk > 0 ? "warning" : "neutral"}
              hint={s ? `${s.longLead.open} open · ${s.longLead.orderByWithin14Days} to order within 14 days` : undefined}
              loading={summary.loading && !s}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat label="Expediting backlog" value={s ? num(s.longLead.expeditingBacklog) : EM_DASH} tone={s && s.longLead.expeditingBacklog > 0 ? "warning" : "neutral"} hint="Ordered, not arrived, not chased in 14 days" loading={summary.loading && !s} />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="On-time delivery"
              value={s ? <FigureCell value={s.deliveries.onTimePercent.value} reasons={s.deliveries.onTimePercent.reasons} render={(v) => pct(v)} /> : EM_DASH}
              hint={s ? `${s.deliveries.completed} completed · ${s.deliveries.noShows} no-show${s.deliveries.noShows === 1 ? "" : "s"} · ${s.deliveries.withIssues} with damage/shortage` : undefined}
              tone={s && s.deliveries.onTimePercent.value !== null && s.deliveries.onTimePercent.value < 80 ? "warning" : "neutral"}
              loading={summary.loading && !s}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat label="Units in the factory" value={s ? num(s.offsite.inFactory) : EM_DASH} tone={s && s.offsite.qaHold > 0 ? "danger" : "neutral"} hint={s ? `${s.offsite.qaHold} on QA hold · ${s.offsite.units} unit${s.offsite.units === 1 ? "" : "s"} in all` : undefined} loading={summary.loading && !s} />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Trace chain complete"
              value={s ? <FigureCell value={s.traceability.completenessPercent} reasons={s.traceability.reasons} render={(v) => pct(v)} /> : EM_DASH}
              hint={s ? `${s.traceability.installedWithoutCertificate} installed without a certificate` : undefined}
              tone={s && s.traceability.installedWithoutCertificate > 0 ? "warning" : "neutral"}
              loading={summary.loading && !s}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat
              label="Supplier risk"
              value={s ? `${s.map.byRiskLevel["critical"] ?? 0} / ${s.map.byRiskLevel["high"] ?? 0}` : EM_DASH}
              hint={s ? (s.map.lastRiskRunAt ? `critical / high · run ${dateTime(s.map.lastRiskRunAt)}` : `${s.map.nodes} node${s.map.nodes === 1 ? "" : "s"}; the engine has not run`) : undefined}
              tone={s && (s.map.byRiskLevel["critical"] ?? 0) > 0 ? "danger" : "neutral"}
              loading={summary.loading && !s}
            />
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardBody>
            <SectionHeading
              title="Open supply signals"
              hint="What the sweeps found and nobody has dispositioned yet. Signals are raised once per condition and never duplicated."
              actions={
                <Button size="sm" variant="secondary" leadingIcon={IconZap} loading={action.busy === "sweeps"} onClick={() => void runSweeps()}>
                  Run sweeps now
                </Button>
              }
            />
            {lastSweep ? <p className="mb-2 text-meta text-content-muted">{lastSweep}</p> : null}
            {!s && summary.loading ? (
              <Skeleton height={120} />
            ) : !s ? null : s.signals.items.length === 0 ? (
              <EmptyState size="sm" title="No open supply signals" hint="Late items, JIT conflicts, failed QA gates, no-shows and supplier risk flags land here." />
            ) : (
              <ul className="divide-y divide-border">
                {s.signals.items.slice(0, 12).map((sig) => (
                  <li key={sig.id} className="flex items-start gap-3 py-2">
                    <Badge tone={SEVERITY_TONE[sig.severity] ?? "neutral"} size="xs" dot>
                      {sig.severity}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-meta font-medium text-content">{sig.title}</div>
                      <div className="line-clamp-2 text-2xs text-content-muted">{sig.explanation}</div>
                    </div>
                    <span className="shrink-0 text-2xs text-content-subtle">{DETECTOR_LABEL[sig.detector] ?? labelize(sig.detector)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <SectionHeading
              title="Just-in-time conflicts"
              hint={jit.data?.method ?? "Deliveries, open items and units tested against the start of the task they feed."}
              actions={
                <Button size="sm" variant="ghost" leadingIcon={IconRefresh} onClick={jit.reload}>
                  Refresh
                </Button>
              }
            />
            {jit.error ? (
              <LoadError message={jit.error} onRetry={jit.reload} />
            ) : jit.loading && !jit.data ? (
              <Skeleton height={120} />
            ) : !jit.data || jit.data.items.length === 0 ? (
              <EmptyState size="sm" title="No conflicts" hint="Every booked delivery and forecast lands before the task it feeds starts." />
            ) : (
              <ul className="divide-y divide-border">
                {jit.data.items.slice(0, 12).map((c) => (
                  <li key={c.key} className="flex items-start gap-3 py-2">
                    <Badge tone={SEVERITY_TONE[c.severity] ?? "neutral"} size="xs" dot>
                      {c.severity}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-meta font-medium text-content">{c.title}</div>
                      <div className="line-clamp-2 text-2xs text-content-muted">{c.explanation}</div>
                    </div>
                    <span className="shrink-0 text-2xs text-content-subtle">{labelize(c.kind)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardBody>
            <SectionHeading title="Expediting backlog" hint="Ordered and not chased in the last 14 days. Silence from a supplier is the earliest signal of a slip." actions={<Button size="sm" variant="ghost" onClick={() => onOpenTab("long-lead")}>Open the register</Button>} />
            {!s ? null : s.longLead.expeditingBacklogItems.length === 0 ? (
              <EmptyState size="sm" title="Nothing unchased" hint="Every ordered item has been expedited inside the last 14 days, or nothing is on order." />
            ) : (
              <ul className="divide-y divide-border">
                {s.longLead.expeditingBacklogItems.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3 py-2 text-meta">
                    <span className="min-w-0 truncate">
                      <span className="font-mono">{i.reference}</span> {i.name}
                    </span>
                    <span className="shrink-0 text-2xs text-content-muted">{i.lastExpeditedAt ? `last chased ${isoDate(i.lastExpeditedAt)}` : "never chased"}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <SectionHeading title="Health inputs" hint="What this module feeds the project health score. Null means the platform holds nothing to score, and says why." />
            {health.error ? (
              <LoadError message={health.error} onRetry={health.reload} />
            ) : health.loading && !health.data ? (
              <Skeleton height={120} />
            ) : health.data ? (
              <>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-meta sm:grid-cols-3">
                  {Object.entries(health.data.metrics).map(([k, v]) => (
                    <div key={k} className="flex items-baseline justify-between gap-2 border-b border-border py-1">
                      <dt className="truncate text-2xs text-content-muted">{labelize(k)}</dt>
                      <dd className="tabular-nums text-content">{v === null ? <span className="italic text-content-subtle">n/a</span> : k.toLowerCase().includes("percent") ? pct(v) : num(v)}</dd>
                    </div>
                  ))}
                </dl>
                <ReasonList reasons={health.data.reasons} className="mt-2" />
              </>
            ) : null}
          </CardBody>
        </Card>
      </div>

      {s ? <CurrencyRail map={s.longLead.valueByCurrency} label="Open order value" note={s.longLead.currencyNote} /> : null}
    </div>
  );
}
