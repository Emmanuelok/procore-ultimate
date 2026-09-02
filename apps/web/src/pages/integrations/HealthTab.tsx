/**
 * Deliveries & health — GET /integrations/webhooks/status, rendered so an
 * operator can tell at a glance whether events are flowing or piling up.
 *
 * The verdict at the top is computed from the queue depth and the emitter
 * counters and stated in a sentence, because "3 pending" means something
 * different when the drain interval is 15 s and the emitter has never failed
 * than it does when enqueue is throwing. Everything the verdict rests on is
 * shown underneath, including the tuning env values, so the judgement can be
 * checked rather than trusted.
 */
import { Badge, Button, Card, CardBody, Spinner, Table, Td, Th } from "../../ui";
import { formatDateTime } from "../format";
import {
  Caveat,
  DefRow,
  SharedCustodyNotice,
  StatTile,
  msDuration,
  num,
  plural,
  retryBudgetMs,
  type WebhookStatusResponse,
} from "./integrationsShared";

const QUEUE_ORDER = ["pending", "failed", "exhausted", "delivered", "skipped"] as const;

const QUEUE_META: Record<
  string,
  { label: string; bar: string; tone: "green" | "red" | "amber" | "blue" | "gray"; gist: string }
> = {
  pending: {
    label: "Pending",
    bar: "bg-brand-500",
    tone: "blue",
    gist: "Queued, not yet attempted (or waiting on a backoff window).",
  },
  failed: {
    label: "Failed",
    bar: "bg-amber-500",
    tone: "amber",
    gist: "Attempted and refused, with attempts left. The drain will try again.",
  },
  exhausted: {
    label: "Exhausted",
    bar: "bg-red-500",
    tone: "red",
    gist: "Used the whole attempt budget and was abandoned. Only a manual retry revives it.",
  },
  delivered: {
    label: "Delivered",
    bar: "bg-emerald-600",
    tone: "green",
    gist: "Accepted with a 2xx by the receiver.",
  },
  skipped: {
    label: "Skipped",
    bar: "bg-ink-300",
    tone: "gray",
    gist: "The endpoint was disabled or deleted when the delivery came due — never sent.",
  },
};

export default function HealthTab({
  status,
  statusError,
  onReload,
}: {
  status: WebhookStatusResponse | null;
  statusError: string | null;
  onReload: () => void;
}) {
  if (statusError && !status) {
    return (
      <Caveat tone="red">
        <span className="font-semibold">Delivery health could not be read.</span> {statusError}
        <div className="mt-2">
          <Button size="sm" variant="secondary" onClick={onReload}>
            Try again
          </Button>
        </div>
      </Caveat>
    );
  }
  if (!status) return <Spinner label="Reading delivery health…" />;

  const queue = status.queue ?? {};
  const counts = QUEUE_ORDER.map((k) => ({ key: k, n: Number(queue[k] ?? 0), ...QUEUE_META[k]! }));
  const total = counts.reduce((sum, c) => sum + c.n, 0);
  const pending = Number(queue["pending"] ?? 0);
  const failed = Number(queue["failed"] ?? 0);
  const exhausted = Number(queue["exhausted"] ?? 0);
  const delivered = Number(queue["delivered"] ?? 0);
  const emitter = status.emitter;
  const tuning = status.delivery;
  const timerRunning = tuning.dispatchIntervalMs > 0;

  /* The verdict: one sentence, derived, with its basis shown below. */
  const verdict = (() => {
    if (!timerRunning) {
      return {
        tone: "red" as const,
        headline: "The background drain is not running",
        body:
          "dispatchIntervalMs is 0, so nothing is attempted on a timer. Deliveries move only when " +
          "something drains them explicitly (a test ping, a manual retry). Anything queued is " +
          "sitting still.",
      };
    }
    if (emitter.enqueueFailures > 0) {
      return {
        tone: "red" as const,
        headline: `Enqueue has failed ${num(emitter.enqueueFailures)} ${plural(emitter.enqueueFailures, "time", "times")}`,
        body:
          "The emitter never propagates a failure into the business transaction that caused it — a " +
          "ledger append must not fail because a subscriber's bookkeeping did. The cost is that " +
          "those events were silently NOT queued for any endpoint, and there is no backfill. " +
          "The last error is shown below.",
      };
    }
    if (exhausted > 0) {
      return {
        tone: "amber" as const,
        headline: `${num(exhausted)} ${plural(exhausted, "delivery has", "deliveries have")} exhausted every attempt`,
        body:
          "These will never be retried on their own. Each one also counted against its endpoint's " +
          `consecutive-failure run — ${num(tuning.failureThreshold)} in a row auto-disables the ` +
          "endpoint. Fix the receiver, then retry them from the endpoint's delivery log.",
      };
    }
    if (pending + failed > 0) {
      return {
        tone: "amber" as const,
        headline: `${num(pending + failed)} ${plural(pending + failed, "delivery is", "deliveries are")} in flight`,
        body:
          `The drain runs every ${msDuration(tuning.dispatchIntervalMs)} and each delivery gets up ` +
          `to ${num(tuning.maxAttempts)} attempts with exponential backoff. This is normal traffic ` +
          "unless the number keeps climbing between refreshes.",
      };
    }
    if (total === 0) {
      return {
        tone: "gray" as const,
        headline: "Nothing has been queued yet",
        body:
          emitter.eventsSeen > 0
            ? `The emitter has seen ${num(emitter.eventsSeen)} ledger ${plural(emitter.eventsSeen, "event", "events")} ` +
              "but enqueued none of them — no active endpoint's subscription matched. That is a " +
              "configuration outcome, not a fault."
            : "No ledger event has reached the emitter in this process's lifetime. The counters " +
              "below are per-process and reset on restart.",
      };
    }
    return {
      tone: "green" as const,
      headline: "Events are flowing",
      body:
        `${num(delivered)} ${plural(delivered, "delivery", "deliveries")} accepted, nothing pending, ` +
        "nothing failed and nothing exhausted for this company.",
    };
  })();

  const verdictCls =
    verdict.tone === "green"
      ? "bg-emerald-50 ring-emerald-200 text-emerald-900"
      : verdict.tone === "amber"
        ? "bg-amber-50 ring-amber-200 text-amber-900"
        : verdict.tone === "red"
          ? "bg-red-50 ring-red-200 text-red-900"
          : "bg-ink-50 ring-ink-200 text-ink-800";

  const budget = retryBudgetMs(tuning);

  return (
    <div className="space-y-4">
      {statusError ? (
        <Caveat tone="amber">
          The last refresh failed ({statusError}) — the figures below are from the previous
          successful read.
        </Caveat>
      ) : null}

      {/* ------------------------------- verdict ------------------------------- */}
      <div className={`rounded-lg px-4 py-3 ring-1 ${verdictCls}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{verdict.headline}</h2>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed">{verdict.body}</p>
          </div>
          <Button size="sm" variant="secondary" onClick={onReload}>
            Refresh
          </Button>
        </div>
      </div>

      {/* -------------------------------- queue -------------------------------- */}
      <Card>
        <CardBody>
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-ink-900">Queue for this company</h3>
            <span className="text-xs text-ink-400">
              {num(total)} delivery {plural(total, "record", "records")} in total
            </span>
          </div>

          {total > 0 ? (
            <div className="mb-3">
              <div
                className="flex h-2.5 w-full overflow-hidden rounded-full bg-ink-100"
                role="img"
                aria-label={counts.map((c) => `${c.n} ${c.label}`).join(", ")}
              >
                {counts.map((c) =>
                  c.n > 0 ? (
                    <div
                      key={c.key}
                      className={c.bar}
                      style={{ width: `${(c.n / total) * 100}%` }}
                      title={`${num(c.n)} ${c.label}`}
                    />
                  ) : null,
                )}
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {counts.map((c) => (
              <StatTile
                key={c.key}
                label={c.label}
                value={num(c.n)}
                tone={c.n > 0 ? c.tone : "gray"}
                hint={c.gist}
              />
            ))}
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-ink-400">
            Counts are per delivery record, not per event: one ledger append fans out to one record
            per matching endpoint. Deleting an endpoint deletes its records, so these totals fall
            when an endpoint is removed.
          </p>
        </CardBody>
      </Card>

      {/* ------------------------------- emitter ------------------------------- */}
      <Card>
        <CardBody>
          <h3 className="mb-2 text-sm font-semibold text-ink-900">Emitter</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <StatTile
              label="Ledger events seen"
              value={num(emitter.eventsSeen)}
              hint="Appends offered to the emitter since this process started."
            />
            <StatTile
              label="Deliveries enqueued"
              value={num(emitter.deliveriesEnqueued)}
              tone="blue"
              hint="Rows written across all endpoints, including test pings."
            />
            <StatTile
              label="Enqueue failures"
              value={num(emitter.enqueueFailures)}
              tone={emitter.enqueueFailures > 0 ? "red" : "gray"}
              hint="Events swallowed rather than allowed to fail a ledger append."
            />
          </div>

          {emitter.lastEnqueueError ? (
            <div className="mt-3">
              <Caveat tone="red">
                <span className="font-semibold">Last enqueue error</span>
                {emitter.lastEnqueueErrorAt
                  ? ` (${formatDateTime(emitter.lastEnqueueErrorAt)})`
                  : ""}
                : <span className="font-mono">{emitter.lastEnqueueError}</span>
                <div className="mt-1">
                  Events affected by an enqueue failure were never written as deliveries and are not
                  recoverable from here — the ledger holds what happened, but no endpoint was told.
                </div>
              </Caveat>
            </div>
          ) : null}

          <Caveat tone="ink">
            <span className="font-semibold">These counters are per process and per restart.</span>{" "}
            The dispatcher is an in-process interval timer — the API reports its mode as
            &ldquo;{tuning.mode}&rdquo;. Two consequences worth knowing: deliveries stop moving
            while the API process is down, and if this deployment runs more than one API replica,
            each replica drains the same queue, so a receiver can legitimately see the same delivery
            id twice. That is why the contract is dedupe on the delivery header rather than
            at-most-once.
          </Caveat>
        </CardBody>
      </Card>

      {/* ------------------------------- tuning -------------------------------- */}
      <Card>
        <CardBody>
          <h3 className="mb-2 text-sm font-semibold text-ink-900">Delivery behaviour</h3>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <DefRow label="Attempts">
                {num(tuning.maxAttempts)} per delivery before it is marked exhausted
              </DefRow>
              <DefRow label="Backoff">
                {msDuration(tuning.backoffBaseMs)} doubling to a ceiling of{" "}
                {msDuration(tuning.backoffMaxMs)}, plus up to 20% deterministic jitter derived from
                the delivery id
              </DefRow>
              <DefRow label="Auto-disable">
                after {num(tuning.failureThreshold)} consecutive exhausted{" "}
                {plural(tuning.failureThreshold, "delivery", "deliveries")} on one endpoint
              </DefRow>
              <DefRow label="Request timeout">{msDuration(tuning.requestTimeoutMs)}</DefRow>
              <DefRow label="Drain interval">
                {timerRunning ? msDuration(tuning.dispatchIntervalMs) : "disabled"}
              </DefRow>
              <DefRow label="Stored response body">
                first {num(tuning.responseBodyLimit)} characters, then truncated
              </DefRow>
            </div>
            <div>
              <div className="rounded-md bg-ink-50 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                  Worst-case retry window
                </div>
                <div className="mt-1 text-2xl font-semibold tabular-nums text-ink-900">
                  ≈ {msDuration(budget)}
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
                  From first attempt to exhaustion, using this deployment's own numbers
                  ({num(tuning.maxAttempts)} attempts, backoff {msDuration(tuning.backoffBaseMs)}→
                  {msDuration(tuning.backoffMaxMs)} with jitter, {msDuration(tuning.requestTimeoutMs)}{" "}
                  timeout each).{" "}
                  <span className="text-ink-700">
                    A receiver's signature freshness window must cover this whole span
                  </span>{" "}
                  — the signed timestamp is fixed at enqueue and never moves, so a retry arriving at
                  the end of the budget carries a timestamp that old. Rejecting on a short freshness
                  window will drop legitimate retries; rely on delivery-id dedupe for replay
                  protection instead.
                </p>
              </div>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* --------------------------------- env --------------------------------- */}
      <Card>
        <CardBody>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">Tuning environment</h3>
          <p className="mb-2 text-xs text-ink-500">
            The values in force in this deployment, as the API reports them. Changing any of them
            requires an environment change and a restart — none is editable from here.
          </p>
          <Table>
            <thead className="bg-ink-50">
              <tr>
                <Th>Variable</Th>
                <Th>Value in force</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-50">
              {Object.entries(status.env).map(([key, value]) => (
                <tr key={key}>
                  <Td>
                    <span className="font-mono text-xs text-ink-800">{key}</span>
                  </Td>
                  <Td>
                    {key === "WEBHOOK_SIGNING_KEY" ? (
                      <span className="flex flex-wrap items-center gap-1.5 text-xs text-ink-600">
                        <span>{String(value)}</span>
                        <Badge tone={status.signing.keySource.sharedCustody ? "red" : "green"}>
                          in force: {status.signing.keySource.source}
                        </Badge>
                      </span>
                    ) : (
                      <span className="font-mono text-xs tabular-nums text-ink-700">
                        {String(value)}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardBody>
      </Card>

      <SharedCustodyNotice keySource={status.signing.keySource} />
    </div>
  );
}
