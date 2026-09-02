/**
 * Engine tab (company owner/admin): the ledger hook's health counters, the
 * effective limits, the two scheduler jobs, and a manual cycle so an operator
 * never has to wait for the interval to see a rule fire.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { Alert, Button, Card, CardBody, CardHeader, DescriptionList, ErrorAlert, Stat, StatusPill, type DescriptionItem } from "../../ui";
import { IconPlay, IconRefresh } from "../../ui/icons";
import { errorMessage, formatDateTime, msDuration, num, type CycleResult, type StatusView } from "./automationShared";

export default function EngineTab({ onCycle }: { onCycle: () => void }) {
  const [status, setStatus] = useState<StatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"cycle" | "drain" | null>(null);
  const [last, setLast] = useState<CycleResult | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setStatus(await api.get<StatusView>("/api/v1/automation/status"));
    } catch (err) {
      setError(errorMessage(err, "Failed to read the engine status"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function cycle(kind: "cycle" | "drain") {
    setBusy(kind);
    try {
      const res = await api.post<CycleResult>("/api/v1/automation/run", kind === "drain" ? { scan: false, force: false } : { force: true });
      setLast(res);
      toast.success(
        kind === "drain"
          ? `Drained ${num(res.drain?.executed)} queued run(s)`
          : `Scanned ${num(res.scan?.rulesScanned)} schedule rule(s), executed ${num((res.scan?.executed ?? 0) + (res.drain?.executed ?? 0))} run(s)`,
      );
      onCycle();
      void load();
    } catch (err) {
      toast.error(errorMessage(err, "Cycle failed"));
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorAlert message={error} onRetry={() => void load()} />;
  if (!status) return <div className="text-xs text-content-subtle">Reading engine status…</div>;

  const h = status.engine;
  const options: DescriptionItem[] = [
    { label: "Actions per minute per company", value: String(status.options.maxActionsPerMinute), hint: "AUTOMATION_MAX_ACTIONS_PER_MINUTE — runs over budget are deferred, never dropped" },
    { label: "Max chain depth", value: String(status.options.maxChainDepth), hint: "AUTOMATION_MAX_CHAIN_DEPTH — a rule may never trigger itself; other rules chain this deep" },
    { label: "Max deferrals", value: String(status.options.maxAttempts), hint: "After this many rate-limit deferrals a run is marked throttled for an operator" },
    { label: "Drain batch", value: String(status.options.drainBatch) },
    { label: "Webhook timeout", value: msDuration(status.options.requestTimeoutMs) },
    {
      label: "Webhook signing key",
      value: status.options.webhookSigning,
      tone: status.options.webhookSigning === "AUTH_SECRET_FALLBACK" ? "warning" : "success",
      hint:
        status.options.webhookSigning === "AUTH_SECRET_FALLBACK"
          ? "Falling back to AUTH_SECRET: anyone holding the JWT secret can forge a rule webhook signature. Set AUTOMATION_WEBHOOK_SECRET."
          : "Dedicated secret in force.",
    },
  ];

  return (
    <div className="space-y-4">
      {!status.scheduler.enabled ? (
        <Alert tone="warning" size="sm" title="The platform scheduler is disabled in this process">
          Queued runs and schedule scans only execute when a cycle is run manually below (or from the platform scheduler page).
        </Alert>
      ) : null}
      {h.lastError ? (
        <Alert tone="danger" size="sm" title={`Last engine error${h.lastErrorAt ? ` · ${formatDateTime(h.lastErrorAt)}` : ""}`}>
          {h.lastError}
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Ledger events seen" value={num(h.eventsSeen)} hint={`${num(h.eventsMatched)} matched at least one rule`} />
        <Stat label="Runs enqueued" value={num(h.runsEnqueued)} hint={`${num(h.runsExecuted)} executed since boot`} />
        <Stat label="Runs failed" value={num(h.runsFailed)} tone={h.runsFailed > 0 ? "danger" : "neutral"} hint={`${num(h.runsThrottled)} throttled`} />
        <Stat label="Hook failures" value={num(h.hookFailures)} tone={h.hookFailures > 0 ? "danger" : "neutral"} hint="A failing hook never fails the business write" />
      </div>

      <Card>
        <CardHeader
          title="Scheduler jobs"
          subtitle="automation.drain executes queued runs every minute; automation.schedules scans schedule rules every five"
          actions={
            <div className="flex gap-1">
              <Button size="xs" variant="secondary" leadingIcon={IconRefresh} onClick={() => void load()}>
                Refresh
              </Button>
              <Button size="xs" variant="secondary" loading={busy === "drain"} onClick={() => void cycle("drain")}>
                Drain now
              </Button>
              <Button size="xs" leadingIcon={IconPlay} loading={busy === "cycle"} onClick={() => void cycle("cycle")}>
                Run full cycle
              </Button>
            </div>
          }
        />
        <CardBody>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-2xs uppercase text-content-subtle">
                <th className="py-1 pr-2">Job</th>
                <th className="py-1 pr-2">State</th>
                <th className="py-1 pr-2">Last run</th>
                <th className="py-1 pr-2">Duration</th>
                <th className="py-1 pr-2">Runs / failures</th>
                <th className="py-1">Next due</th>
              </tr>
            </thead>
            <tbody>
              {status.jobs.map((j) => (
                <tr key={j.name} className="border-t border-border-subtle align-top">
                  <td className="py-1.5 pr-2">
                    <div className="font-mono">{j.name}</div>
                    <div className="text-2xs text-content-subtle">{j.description}</div>
                    {j.lastError ? <div className="text-2xs text-danger-fg">{j.lastError}</div> : null}
                  </td>
                  <td className="py-1.5 pr-2">
                    <StatusPill status={j.state} size="xs" />
                  </td>
                  <td className="py-1.5 pr-2">{formatDateTime(j.lastFinishedAt ?? j.lastStartedAt)}</td>
                  <td className="py-1.5 pr-2">{msDuration(j.lastDurationMs)}</td>
                  <td className="py-1.5 pr-2 tabular-nums">
                    {num(j.runCount)} / {num(j.failureCount)}
                  </td>
                  <td className="py-1.5">{j.nextDueAt ? formatDateTime(j.nextDueAt) : "manual only"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>

      {last ? (
        <Card>
          <CardHeader title={`Last manual cycle · ${formatDateTime(last.at)}`} />
          <CardBody className="grid gap-3 sm:grid-cols-2">
            <div className="text-xs">
              <div className="text-label uppercase text-content-subtle">Schedule scan</div>
              {last.scan ? (
                <div className="mt-1 text-content-muted">
                  {num(last.scan.rulesScanned)} rule(s) scanned · {num(last.scan.candidates)} candidate record(s) · {num(last.scan.matched)} matched ·{" "}
                  {num(last.scan.deduped)} inside cooldown · {num(last.scan.executed)} executed
                </div>
              ) : (
                <div className="mt-1 text-content-subtle">Skipped</div>
              )}
            </div>
            <div className="text-xs">
              <div className="text-label uppercase text-content-subtle">Drain</div>
              {last.drain ? (
                <div className="mt-1 text-content-muted">
                  {num(last.drain.executed)} executed · {num(last.drain.succeeded)} succeeded · {num(last.drain.failed)} failed · {num(last.drain.skipped)} skipped ·{" "}
                  {num(last.drain.deferred)} deferred · {num(last.drain.throttled)} throttled
                </div>
              ) : (
                <div className="mt-1 text-content-subtle">Skipped</div>
              )}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Limits in force" subtitle="From the environment; change them there, not here" />
        <CardBody>
          <DescriptionList items={options} columns={2} size="sm" />
        </CardBody>
      </Card>
    </div>
  );
}
