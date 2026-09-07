import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { ledgerEntries, webhookDeliveries, webhookEndpoints } from "@constructos/db";
import { sha256Hex } from "@constructos/ledger";
import type { WebhookDeliveryStatus } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import type { LedgerEvent } from "../../lib/ledger.js";
import { newId } from "../../lib/ids.js";
import { eventKind, matchesEventKind } from "./events.js";
import {
  ALT_SECRET_VERSION_HEADER,
  ALT_SIGNATURE_HEADER,
  ATTEMPT_HEADER,
  COMPANY_HEADER,
  DELIVERY_HEADER,
  ENDPOINT_HEADER,
  EVENT_HEADER,
  SECRET_VERSION_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  canonicalBody,
  deriveEndpointSecret,
  signPayload,
  type SigningKey,
  type WebhookEnvelope,
} from "./signing.js";
import { checkWebhookUrl, type SsrfPolicy } from "./ssrf.js";

/* ------------------------------------------------------------------ */
/* Injectable transport                                                */
/* ------------------------------------------------------------------ */

export interface WebhookHttpResponse {
  status: number;
  body: string;
}

/**
 * The dispatcher never calls `fetch` directly. Everything it does — success,
 * a 500 followed by a success, retry exhaustion, a connection that throws —
 * is driven through this one interface, so the whole delivery state machine is
 * exercised in tests without a socket, deterministically and in milliseconds.
 */
export interface WebhookHttpClient {
  post(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<WebhookHttpResponse>;
}

/** The production transport: global fetch, bounded by a timeout, body capped. */
export function createFetchWebhookClient(
  timeoutMs: number,
  bodyLimit: number,
): WebhookHttpClient {
  return {
    async post(url, body, headers) {
      const res = await fetch(url, {
        method: "POST",
        body,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      let text = "";
      try {
        text = (await res.text()).slice(0, bodyLimit);
      } catch {
        text = "";
      }
      return { status: res.status, body: text };
    },
  };
}

export interface RecordedCall {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/**
 * Test transport: a scripted responder plus a call log. `respond` may return a
 * response or throw, so transport-level failure is as testable as a 500.
 */
export function createRecordingWebhookClient(
  respond: (call: RecordedCall, index: number) => WebhookHttpResponse | Promise<WebhookHttpResponse>,
): WebhookHttpClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async post(url, body, headers) {
      const call = { url, body, headers };
      calls.push(call);
      return respond(call, calls.length - 1);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export interface DispatcherOptions {
  /** total attempts per delivery before it is `exhausted` */
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** consecutive exhausted deliveries before the endpoint auto-disables */
  failureThreshold: number;
  /** stored response bodies are truncated to this many characters */
  responseBodyLimit: number;
  batchSize: number;
  requestTimeoutMs: number;
  /** background drain interval; 0 disables the timer */
  intervalMs: number;
  /** kick a drain immediately after an enqueue (off in tests for determinism) */
  autoKick: boolean;
  /** how long a claimed delivery is reserved for the claiming process */
  leaseMs: number;
  /** how many endpoints are attempted concurrently in one drain */
  endpointConcurrency: number;
  /** consecutive TRANSPORT errors on one endpoint before its breaker opens */
  circuitErrorThreshold: number;
  /** how long an open breaker stays open */
  circuitOpenMs: number;
  /** delivered/skipped rows are pruned after this many days */
  retentionDays: number;
  /** exhausted rows are kept longer — they are the evidence of an outage */
  retentionExhaustedDays: number;
  now: () => Date;
}

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function defaultDispatcherOptions(
  env: NodeJS.ProcessEnv = process.env,
  isTest = false,
): DispatcherOptions {
  return {
    maxAttempts: Math.max(1, intFromEnv(env, "WEBHOOK_MAX_ATTEMPTS", 6)),
    backoffBaseMs: intFromEnv(env, "WEBHOOK_BACKOFF_BASE_MS", 2_000),
    backoffMaxMs: intFromEnv(env, "WEBHOOK_BACKOFF_MAX_MS", 300_000),
    failureThreshold: Math.max(1, intFromEnv(env, "WEBHOOK_FAILURE_THRESHOLD", 5)),
    responseBodyLimit: intFromEnv(env, "WEBHOOK_RESPONSE_BODY_LIMIT", 2_048),
    batchSize: Math.max(1, intFromEnv(env, "WEBHOOK_BATCH_SIZE", 50)),
    requestTimeoutMs: intFromEnv(env, "WEBHOOK_TIMEOUT_MS", 10_000),
    // The drain runs on this process's own timer. There is no cron, no queue
    // broker and no external scheduler to forget to deploy — see the class
    // comment for why that choice, and what it costs.
    intervalMs: isTest ? 0 : intFromEnv(env, "WEBHOOK_DISPATCH_INTERVAL_MS", 15_000),
    autoKick: !isTest,
    leaseMs: Math.max(1_000, intFromEnv(env, "WEBHOOK_LEASE_MS", 60_000)),
    endpointConcurrency: Math.max(1, intFromEnv(env, "WEBHOOK_ENDPOINT_CONCURRENCY", 8)),
    circuitErrorThreshold: Math.max(1, intFromEnv(env, "WEBHOOK_CIRCUIT_ERRORS", 3)),
    circuitOpenMs: Math.max(1_000, intFromEnv(env, "WEBHOOK_CIRCUIT_OPEN_MS", 300_000)),
    retentionDays: Math.max(1, intFromEnv(env, "WEBHOOK_RETENTION_DAYS", 30)),
    retentionExhaustedDays: Math.max(1, intFromEnv(env, "WEBHOOK_RETENTION_EXHAUSTED_DAYS", 90)),
    now: () => new Date(),
  };
}

/**
 * Exponential backoff with deterministic per-delivery jitter.
 *
 * `base * 2^(attempt-1)`, capped, plus up to 20% spread derived from a hash of
 * (deliveryId, attempt). Deterministic means a test can assert the exact
 * schedule; derived-from-the-delivery means a thousand deliveries failing at
 * the same instant do not retry in lockstep.
 */
export function backoffMs(
  opts: Pick<DispatcherOptions, "backoffBaseMs" | "backoffMaxMs">,
  deliveryId: string,
  attempt: number,
): number {
  const raw = opts.backoffBaseMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(raw, opts.backoffMaxMs);
  const spread = Math.floor(capped * 0.2);
  if (spread === 0) return capped;
  const digest = sha256Hex(`${deliveryId}:${attempt}`);
  return capped + (parseInt(digest.slice(0, 8), 16) % spread);
}

/* ------------------------------------------------------------------ */
/* Dispatcher                                                          */
/* ------------------------------------------------------------------ */

export interface DispatchSummary {
  attempted: number;
  delivered: number;
  failed: number;
  exhausted: number;
  skipped: number;
  /** deliveries left unattempted because their endpoint's breaker is open */
  circuitDeferred: number;
  /** distinct endpoints attempted in this drain */
  endpoints: number;
}

export interface EmitHealth {
  /** enqueue attempts that threw — recorded here rather than propagated */
  enqueueFailures: number;
  lastEnqueueError: string | null;
  lastEnqueueErrorAt: string | null;
  eventsSeen: number;
  deliveriesEnqueued: number;
}

type EndpointRow = typeof webhookEndpoints.$inferSelect;
type DeliveryRow = typeof webhookDeliveries.$inferSelect;

/** What one attempt did, and whether it tripped the endpoint's breaker. */
interface AttemptResult {
  outcome: "delivered" | "failed" | "exhausted" | "skipped";
  /** ISO instant the breaker reopens, or null when it is closed */
  breakerOpenUntil: string | null;
}

/**
 * `db.execute` hands back either `{ rows }` (postgres-js) or a bare array
 * (PGlite) depending on the driver. One narrowing in one place beats the same
 * cast at every call site.
 */
function readRows<T>(result: unknown): T[] {
  const wrapped = (result as { rows?: T[] } | undefined)?.rows;
  if (Array.isArray(wrapped)) return wrapped;
  return Array.isArray(result) ? (result as T[]) : [];
}

export interface DispatcherLogger {
  error: (obj: unknown, msg?: string) => void;
}

/**
 * Vol I §0.7 #121 — the webhook delivery engine.
 *
 * WHY AN IN-PROCESS TIMER, NOT A SCHEDULER
 * The brief allowed either a bounded interval or opportunistic dispatch on
 * read. This is the interval, for one reason: a webhook whose delivery depends
 * on somebody reading a page is not a webhook. Opportunistic-on-read would
 * mean an endpoint receives its retries only while an operator happens to have
 * the deliveries screen open, which is exactly backwards — the operators most
 * in need of retries are the ones who are not watching. An unref'd
 * `setInterval` owned by the process needs no cron entry, no queue broker and
 * no separate worker deployment to be forgotten, and it stops cleanly with the
 * app. What it costs, honestly: with N API replicas the drain runs N times,
 * and the guard against double delivery is per-process, so a receiver can see
 * the same delivery id twice. That is why every delivery carries a stable id
 * and the documented contract is DEDUPE ON x-constructos-delivery. Moving to a
 * single leased worker or a `SELECT … FOR UPDATE SKIP LOCKED` claim is the
 * upgrade path, and neither changes the wire format.
 */
export class WebhookDispatcher {
  private http: WebhookHttpClient;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private readonly health: EmitHealth = {
    enqueueFailures: 0,
    lastEnqueueError: null,
    lastEnqueueErrorAt: null,
    eventsSeen: 0,
    deliveriesEnqueued: 0,
  };

  /**
   * Egress policy. A delivery is re-checked against it immediately before the
   * request goes out, which is the DNS-rebinding guard: an endpoint whose host
   * resolved publicly at configuration time and privately at send time is
   * refused and disabled rather than delivered to.
   */
  private ssrf: SsrfPolicy | null = null;
  /** Identifies this process in a delivery lease. */
  private readonly owner = `disp_${newId("own").slice(-12)}`;

  constructor(
    private readonly db: Db,
    private readonly signingKey: SigningKey,
    public options: DispatcherOptions,
    private readonly logger: DispatcherLogger = { error: () => {} },
    http?: WebhookHttpClient,
  ) {
    this.http =
      http ?? createFetchWebhookClient(options.requestTimeoutMs, options.responseBodyLimit);
  }

  /** Install the egress policy. Null disables the send-time re-check. */
  setSsrfPolicy(policy: SsrfPolicy | null): void {
    this.ssrf = policy;
  }

  /**
   * Tell the dispatcher which tenants are developer sandboxes (#123), so the
   * envelope can say so. Synchronous by design: the emit path runs inside the
   * ledger append hook and may not add a query per event, so the module keeps a
   * small cached set and answers from it.
   */
  private sandboxCheck: ((companyId: string) => boolean) | null = null;

  setSandboxCheck(check: ((companyId: string) => boolean) | null): void {
    this.sandboxCheck = check;
  }

  leaseOwner(): string {
    return this.owner;
  }

  /** Swap the transport — the seam every dispatcher test drives. */
  setHttpClient(client: WebhookHttpClient): void {
    this.http = client;
  }

  configure(partial: Partial<DispatcherOptions>): void {
    this.options = { ...this.options, ...partial };
  }

  getHealth(): EmitHealth {
    return { ...this.health };
  }

  keySource() {
    return {
      source: this.signingKey.source,
      sharedCustody: this.signingKey.sharedCustody,
      note: this.signingKey.note,
    };
  }

  secretFor(endpointId: string, version = 1): string {
    return deriveEndpointSecret(this.signingKey, endpointId, version);
  }

  /**
   * Which secret versions are live for an endpoint right now.
   *
   * `primary` is the version whose signature goes in the standard header — the
   * one every existing receiver already holds. `alt` is present only inside a
   * rotation grace window and carries the newly issued secret, so a receiver
   * can adopt the new secret before the window closes without dropping a
   * single delivery. Once the window has passed, the new version becomes the
   * primary and the alternate disappears.
   */
  liveSecretVersions(
    endpoint: Pick<
      EndpointRow,
      "secretVersion" | "previousSecretVersion" | "secretGraceUntil"
    >,
    now: Date,
  ): { primary: number; alt: number | null } {
    const grace = endpoint.secretGraceUntil ? Date.parse(endpoint.secretGraceUntil) : NaN;
    const inGrace =
      endpoint.previousSecretVersion !== null &&
      Number.isFinite(grace) &&
      grace > now.getTime();
    if (!inGrace) return { primary: endpoint.secretVersion, alt: null };
    return { primary: endpoint.previousSecretVersion!, alt: endpoint.secretVersion };
  }

  /* ---------------------------------------------------------------- */
  /* Enqueue — called from the ledger append hook                      */
  /* ---------------------------------------------------------------- */

  /**
   * Fan a committed ledger entry out to every matching active endpoint.
   *
   * NEVER THROWS. `appendLedger` guarantees callers that a ledger write does
   * not fail a business transaction, and a webhook subscriber's bookkeeping is
   * not permitted to weaken that guarantee. A failure is recorded on the
   * dispatcher's health counters and logged; it is not propagated.
   */
  async emit(event: LedgerEvent): Promise<number> {
    this.health.eventsSeen += 1;
    try {
      const kind = eventKind(event.objectType, event.action);
      // Tenant isolation is enforced in the WHERE clause, not by a later
      // filter: the only endpoints ever considered are this company's.
      const endpoints = await this.db
        .select()
        .from(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.companyId, event.companyId),
            eq(webhookEndpoints.isActive, 1),
          ),
        );
      const targets = endpoints.filter(
        (e) =>
          matchesEventKind(e.eventKinds ?? [], kind) &&
          (e.projectId === null || e.projectId === event.projectId),
      );
      if (targets.length === 0) return 0;

      const rows = targets.map((endpoint) =>
        this.buildDelivery(endpoint, kind, event.at, event.projectId, String(event.seq), {
          action: event.action,
          objectType: event.objectType,
          objectId: event.objectId,
          actorId: event.actorId,
          ledgerSeq: event.seq,
          payloadHash: event.payloadHash,
          entryHash: event.entryHash,
        }),
      );
      await this.db.insert(webhookDeliveries).values(rows);
      this.health.deliveriesEnqueued += rows.length;
      if (this.options.autoKick) void this.dispatchDue().catch(() => {});
      return rows.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.health.enqueueFailures += 1;
      this.health.lastEnqueueError = message;
      this.health.lastEnqueueErrorAt = this.options.now().toISOString();
      this.logger.error(
        { err: message, companyId: event.companyId, objectType: event.objectType },
        "webhook enqueue failed; the ledger append was unaffected",
      );
      return 0;
    }
  }

  /** A synthetic ping, so an operator can prove an endpoint before trusting it. */
  async enqueueTest(endpoint: EndpointRow, requestedBy: string): Promise<string> {
    const at = this.options.now().toISOString();
    const row = this.buildDelivery(endpoint, "ping", at, endpoint.projectId, null, {
      message:
        "Synthetic ping from ConstructOS. If you can verify this signature you can verify every " +
        "real delivery: same headers, same string-to-sign.",
      requestedBy,
    });
    await this.db.insert(webhookDeliveries).values(row);
    this.health.deliveriesEnqueued += 1;
    return row.id;
  }

  private buildDelivery(
    endpoint: EndpointRow,
    kind: string,
    occurredAt: string,
    projectId: string | null,
    ledgerEntryId: string | null,
    data: Record<string, unknown>,
  ): typeof webhookDeliveries.$inferInsert {
    const id = newId("whd");
    const envelope: WebhookEnvelope = {
      id,
      type: kind,
      companyId: endpoint.companyId,
      projectId,
      occurredAt,
      endpointId: endpoint.id,
      ...(this.sandboxCheck?.(endpoint.companyId) ? { sandbox: true } : {}),
      data,
    };
    const body = canonicalBody(envelope);
    const versions = this.liveSecretVersions(endpoint, this.options.now());
    const ts = signedTimestamp(envelope);
    const signature = signPayload(this.secretFor(endpoint.id, versions.primary), ts, id, body);
    const signatureNext =
      versions.alt === null
        ? null
        : signPayload(this.secretFor(endpoint.id, versions.alt), ts, id, body);
    return {
      id,
      companyId: endpoint.companyId,
      endpointId: endpoint.id,
      ledgerEntryId,
      eventKind: kind,
      payload: envelope as unknown as Record<string, unknown>,
      signature,
      signatureNext,
      secretVersion: versions.primary,
      status: "pending" satisfies WebhookDeliveryStatus,
      attempts: 0,
      nextAttemptAt: this.options.now().toISOString(),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Drain                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Claim the next batch of due deliveries for THIS process.
   *
   * WHAT WAS WRONG. Every API replica ran its own drain over the same table
   * with no claim at all, so N replicas delivered every event N times and the
   * class comment admitted it while deployment.md called replicas safe. The
   * `draining` flag was per-process and therefore no defence.
   *
   * WHAT IS TRUE NOW. A row is CLAIMED with a lease before it is attempted, in
   * one statement whose inner select takes `FOR UPDATE SKIP LOCKED`: two
   * drains running at the same instant partition the queue between them
   * instead of duplicating it. A lease expires, so a process that dies mid
   * attempt does not strand its rows — the next drain reclaims them once
   * `leaseMs` has passed. The at-least-once contract is unchanged (a crash
   * between the POST and the status write still re-delivers), which is why
   * `x-constructos-delivery` remains the dedupe key.
   */
  private async claimDue(now: Date, limit: number): Promise<DeliveryRow[]> {
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + this.options.leaseMs).toISOString();
    const claimed = await this.db.execute(
      sql`update webhook_deliveries
            set lease_until = ${leaseUntil}, lease_owner = ${this.owner}
          where id in (
            select id from webhook_deliveries
             where status in ('pending', 'failed')
               and (next_attempt_at is null or next_attempt_at <= ${nowIso})
               and (lease_until is null or lease_until <= ${nowIso})
             order by created_at asc, id asc
             limit ${limit}
             for update skip locked
          )
          returning id`,
    );
    const ids = readRows<{ id: string }>(claimed)
      .map((r) => r.id)
      .filter((id): id is string => typeof id === "string");
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(webhookDeliveries)
      .where(inArray(webhookDeliveries.id, ids))
      .orderBy(asc(webhookDeliveries.createdAt), asc(webhookDeliveries.id));
    return rows;
  }

  /** Is this endpoint's breaker open right now? */
  private circuitOpen(endpoint: EndpointRow, now: Date): boolean {
    if (!endpoint.circuitOpenUntil) return false;
    const until = Date.parse(endpoint.circuitOpenUntil);
    return Number.isFinite(until) && until > now.getTime();
  }

  /** Hand a claimed delivery back to the queue, due when the breaker closes. */
  private async deferDelivery(delivery: DeliveryRow, dueAt: string): Promise<void> {
    await this.db
      .update(webhookDeliveries)
      .set({ leaseUntil: null, leaseOwner: null, nextAttemptAt: dueAt })
      .where(eq(webhookDeliveries.id, delivery.id));
  }

  /**
   * Attempt every delivery that is due.
   *
   * WHAT WAS WRONG. The drain took the 50 oldest rows ACROSS ALL TENANTS and
   * attempted them one after another with a 10 s timeout each. One unreachable
   * receiver with fifty queued deliveries consumed the whole cycle — up to
   * ~500 seconds — while every other tenant's events sat pending, and the
   * `draining` flag turned the next ticks into no-ops.
   *
   * WHAT IS TRUE NOW. Claimed rows are grouped BY ENDPOINT. Endpoints are
   * attempted concurrently under a bounded pool, and the deliveries inside one
   * endpoint's queue stay strictly ordered, so ordering per subscriber is
   * preserved while a dead subscriber can no longer block a live one. An
   * endpoint whose breaker is open is skipped entirely for the cycle and its
   * rows are handed back with a due time, so its budget is not spent on
   * connections that are known to fail.
   */
  async dispatchDue(): Promise<DispatchSummary> {
    const summary: DispatchSummary = {
      attempted: 0,
      delivered: 0,
      failed: 0,
      exhausted: 0,
      skipped: 0,
      circuitDeferred: 0,
      endpoints: 0,
    };
    if (this.draining) return summary;
    this.draining = true;
    try {
      const now = this.options.now();
      const claimed = await this.claimDue(now, this.options.batchSize);
      if (claimed.length === 0) return summary;

      const endpointIds = [...new Set(claimed.map((d) => d.endpointId))];
      const endpointRows = await this.db
        .select()
        .from(webhookEndpoints)
        .where(inArray(webhookEndpoints.id, endpointIds));
      const byEndpoint = new Map(endpointRows.map((e) => [e.id, e]));

      const queues = new Map<string, DeliveryRow[]>();
      for (const delivery of claimed) {
        const queue = queues.get(delivery.endpointId) ?? [];
        queue.push(delivery);
        queues.set(delivery.endpointId, queue);
      }
      const entries = [...queues.entries()];
      summary.endpoints = entries.length;

      let cursor = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= entries.length) return;
          const [endpointId, queue] = entries[index]!;
          const endpoint = byEndpoint.get(endpointId);
          if (endpoint && this.circuitOpen(endpoint, now)) {
            for (const delivery of queue) {
              await this.deferDelivery(delivery, endpoint.circuitOpenUntil!);
              summary.circuitDeferred += 1;
            }
            continue;
          }
          let breakerTripped: string | null = null;
          for (const delivery of queue) {
            if (breakerTripped) {
              await this.deferDelivery(delivery, breakerTripped);
              summary.circuitDeferred += 1;
              continue;
            }
            const result = await this.attempt(delivery);
            summary.attempted += 1;
            summary[result.outcome] += 1;
            breakerTripped = result.breakerOpenUntil;
          }
        }
      };
      const workers = Math.min(this.options.endpointConcurrency, entries.length);
      await Promise.all(Array.from({ length: workers }, () => worker()));
      return summary;
    } finally {
      this.draining = false;
    }
  }

  /** Attempt one delivery by id, whatever its schedule. Used by test-ping and retry. */
  async dispatchOne(deliveryId: string): Promise<DeliveryRow | null> {
    const [row] = await this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1);
    if (!row) return null;
    await this.attempt(row);
    const [after] = await this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1);
    return after ?? null;
  }

  private truncate(body: string): string {
    const limit = this.options.responseBodyLimit;
    if (body.length <= limit) return body;
    return `${body.slice(0, limit)}…[truncated ${body.length - limit} chars]`;
  }

  /**
   * One delivery attempt. Returns the outcome and, when the endpoint's circuit
   * breaker tripped on this attempt, the instant it reopens — the drain uses
   * that to stop spending the cycle on an endpoint that has just proved it is
   * unreachable.
   */
  private async attempt(delivery: DeliveryRow): Promise<AttemptResult> {
    const [endpoint] = await this.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, delivery.endpointId))
      .limit(1);
    const now = this.options.now();
    const nowIso = now.toISOString();
    const release = { leaseUntil: null, leaseOwner: null } as const;

    if (!endpoint || endpoint.isActive !== 1) {
      await this.db
        .update(webhookDeliveries)
        .set({
          ...release,
          status: "skipped" satisfies WebhookDeliveryStatus,
          error: endpoint
            ? `Endpoint is disabled (${endpoint.disabledReason ?? "deactivated"}) — not delivered.`
            : "Endpoint no longer exists — not delivered.",
          nextAttemptAt: null,
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      return { outcome: "skipped", breakerOpenUntil: null };
    }

    /*
     * EGRESS RE-CHECK — the DNS-rebinding guard. The URL passed the guard when
     * it was configured; a name can answer differently now. Re-checking here
     * means the platform never POSTs into its own network on the strength of a
     * check made minutes or months ago. A refusal DISABLES the endpoint: a
     * target that resolves inside the perimeter is a configuration to fix, not
     * a transient failure to retry.
     */
    if (this.ssrf) {
      const verdict = await checkWebhookUrl(endpoint.url, this.ssrf);
      if (!verdict.ok) {
        const reason =
          `Egress refused at send time: ${verdict.reason}. The endpoint has been disabled; ` +
          "correct the URL and re-enable it.";
        await this.db
          .update(webhookDeliveries)
          .set({
            ...release,
            status: "skipped" satisfies WebhookDeliveryStatus,
            error: reason,
            nextAttemptAt: null,
          })
          .where(eq(webhookDeliveries.id, delivery.id));
        await this.db
          .update(webhookEndpoints)
          .set({
            isActive: 0,
            disabledReason: reason,
            lastStatus: "blocked",
            updatedAt: nowIso,
          })
          .where(eq(webhookEndpoints.id, endpoint.id));
        return { outcome: "skipped", breakerOpenUntil: null };
      }
      if (verdict.addresses.length > 0 && verdict.addresses[0] !== endpoint.verifiedHost) {
        await this.db
          .update(webhookEndpoints)
          .set({ verifiedHost: verdict.addresses[0]!, updatedAt: nowIso })
          .where(eq(webhookEndpoints.id, endpoint.id));
      }
    }

    const attempt = delivery.attempts + 1;
    const envelope = delivery.payload as unknown as WebhookEnvelope;
    const body = canonicalBody(envelope);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "ConstructOS-Webhooks/1",
      [EVENT_HEADER]: delivery.eventKind,
      [DELIVERY_HEADER]: delivery.id,
      [ENDPOINT_HEADER]: endpoint.id,
      [COMPANY_HEADER]: endpoint.companyId,
      [TIMESTAMP_HEADER]: String(signedTimestamp(envelope)),
      [ATTEMPT_HEADER]: String(attempt),
      [SECRET_VERSION_HEADER]: String(delivery.secretVersion),
      // Re-signed from the stored envelope every attempt; because the signed
      // timestamp comes from the envelope, this is byte-identical to the
      // signature persisted at enqueue. Retries are therefore replays of the
      // same signed message, which is what makes delivery-id dedupe exact.
      [SIGNATURE_HEADER]: delivery.signature,
    };
    if (delivery.signatureNext) {
      // Rotation grace window: the alternate header carries the newly issued
      // secret, so a receiver adopts it without dropping a delivery.
      headers[ALT_SIGNATURE_HEADER] = delivery.signatureNext;
      headers[ALT_SECRET_VERSION_HEADER] = String(endpoint.secretVersion);
    }

    let status = 0;
    let responseBody = "";
    let transportError: string | null = null;
    try {
      const res = await this.http.post(endpoint.url, body, headers);
      status = res.status;
      responseBody = this.truncate(res.body ?? "");
    } catch (err) {
      transportError = err instanceof Error ? err.message : String(err);
    }

    const ok = transportError === null && status >= 200 && status < 300;

    if (ok) {
      await this.db
        .update(webhookDeliveries)
        .set({
          ...release,
          status: "delivered" satisfies WebhookDeliveryStatus,
          attempts: attempt,
          responseStatus: status,
          responseBody,
          error: null,
          nextAttemptAt: null,
          deliveredAt: nowIso,
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      // A success clears the consecutive-failure run AND the breaker: both are
      // about a sustained outage, not a lifetime error count.
      await this.db
        .update(webhookEndpoints)
        .set({
          failureCount: 0,
          consecutiveErrors: 0,
          circuitOpenUntil: null,
          lastDeliveryAt: nowIso,
          lastStatus: "delivered",
          updatedAt: nowIso,
        })
        .where(eq(webhookEndpoints.id, endpoint.id));
      return { outcome: "delivered", breakerOpenUntil: null };
    }

    const exhausted = attempt >= this.options.maxAttempts;
    const errorText =
      transportError !== null
        ? `transport error: ${transportError}`
        : `receiver responded ${status}`;
    await this.db
      .update(webhookDeliveries)
      .set({
        ...release,
        status: (exhausted ? "exhausted" : "failed") satisfies WebhookDeliveryStatus,
        attempts: attempt,
        responseStatus: transportError === null ? status : null,
        responseBody: transportError === null ? responseBody : null,
        error: errorText,
        nextAttemptAt: exhausted
          ? null
          : new Date(
              now.getTime() + backoffMs(this.options, delivery.id, attempt),
            ).toISOString(),
      })
      .where(eq(webhookDeliveries.id, delivery.id));

    /*
     * CIRCUIT BREAKER. Only TRANSPORT errors count: a receiver answering 500 is
     * alive, and its own retry budget is the right instrument. A run of
     * connection failures is different — the host is gone, and continuing to
     * dial it spends the drain's budget on nothing while other tenants wait.
     */
    const consecutiveErrors = transportError === null ? 0 : endpoint.consecutiveErrors + 1;
    const breakerOpenUntil =
      transportError !== null && consecutiveErrors >= this.options.circuitErrorThreshold
        ? new Date(now.getTime() + this.options.circuitOpenMs).toISOString()
        : null;

    if (!exhausted) {
      await this.db
        .update(webhookEndpoints)
        .set({
          consecutiveErrors,
          ...(breakerOpenUntil ? { circuitOpenUntil: breakerOpenUntil } : {}),
          lastDeliveryAt: nowIso,
          lastStatus: "failed",
          updatedAt: nowIso,
        })
        .where(eq(webhookEndpoints.id, endpoint.id));
      return { outcome: "failed", breakerOpenUntil };
    }

    // Exhaustion — and only exhaustion — counts against the endpoint. One
    // flaky attempt is noise; a delivery that used its whole retry budget is
    // evidence the receiver is gone.
    const failureCount = endpoint.failureCount + 1;
    const disable = failureCount >= this.options.failureThreshold;
    await this.db
      .update(webhookEndpoints)
      .set({
        failureCount,
        consecutiveErrors,
        ...(breakerOpenUntil ? { circuitOpenUntil: breakerOpenUntil } : {}),
        lastDeliveryAt: nowIso,
        lastStatus: "exhausted",
        updatedAt: nowIso,
        ...(disable
          ? {
              isActive: 0,
              disabledReason:
                `Auto-disabled after ${failureCount} consecutive deliveries exhausted their ` +
                `${this.options.maxAttempts} attempts (last: ${errorText}). Fix the receiver, ` +
                "then re-enable this endpoint with PATCH .../webhooks/:endpointId {active:true}. " +
                "Events emitted while an endpoint is disabled are not queued for it.",
            }
          : {}),
      })
      .where(eq(webhookEndpoints.id, endpoint.id));
    return { outcome: "exhausted", breakerOpenUntil };
  }

  /* ---------------------------------------------------------------- */
  /* Background drain                                                  */
  /* ---------------------------------------------------------------- */

  start(): void {
    if (this.timer || this.options.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.dispatchDue().catch((err: unknown) => {
        this.logger.error({ err: String(err) }, "webhook drain failed");
      });
    }, this.options.intervalMs);
    // Never hold the process (or a test worker) open on account of webhooks.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Depth of the queue for one tenant, for the status route. */
  async queueDepth(companyId: string): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ status: webhookDeliveries.status, n: sql<number>`count(*)` })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.companyId, companyId))
      .groupBy(webhookDeliveries.status);
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = Number(r.n ?? 0);
    return out;
  }

  /**
   * Delivery lag for one tenant: how long the oldest undelivered event has
   * been waiting. A queue depth alone cannot distinguish "fifty events arrived
   * this second" from "one event has been stuck for six hours", and only the
   * second is an incident.
   */
  async queueLag(companyId: string): Promise<{
    oldestPendingAt: string | null;
    oldestPendingAgeMs: number | null;
    dueNow: number;
  }> {
    const nowMs = this.options.now().getTime();
    const [oldest] = await this.db
      .select({ createdAt: webhookDeliveries.createdAt })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.companyId, companyId),
          inArray(webhookDeliveries.status, ["pending", "failed"]),
        ),
      )
      .orderBy(asc(webhookDeliveries.createdAt))
      .limit(1);
    const [due] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.companyId, companyId),
          inArray(webhookDeliveries.status, ["pending", "failed"]),
          or(
            isNull(webhookDeliveries.nextAttemptAt),
            lte(webhookDeliveries.nextAttemptAt, new Date(nowMs).toISOString()),
          ),
        ),
      );
    const at = oldest?.createdAt ?? null;
    const parsed = at ? Date.parse(at) : NaN;
    return {
      oldestPendingAt: at,
      oldestPendingAgeMs: Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : null,
      dueNow: Number(due?.n ?? 0),
    };
  }

  /**
   * RETENTION. The delivery log used to grow for ever: a busy tenant emits a
   * row per endpoint per ledger entry, and nothing ever removed one. Settled
   * rows are pruned on a schedule — delivered and skipped at `retentionDays`,
   * exhausted kept longer because an exhausted row is the evidence of an
   * outage somebody will ask about. Pending and failed rows are never pruned:
   * they are still owed to a receiver.
   */
  async prune(now: Date = this.options.now()): Promise<{ deleted: number; before: string }> {
    const settledBefore = new Date(
      now.getTime() - this.options.retentionDays * 86_400_000,
    ).toISOString();
    const exhaustedBefore = new Date(
      now.getTime() - this.options.retentionExhaustedDays * 86_400_000,
    ).toISOString();
    const result = await this.db.execute(
      sql`delete from webhook_deliveries
           where (status in ('delivered', 'skipped') and created_at < ${settledBefore})
              or (status = 'exhausted' and created_at < ${exhaustedBefore})
        returning id`,
    );
    return { deleted: readRows<{ id: string }>(result).length, before: settledBefore };
  }

  /**
   * REPLAY (#121). A receiver that was down for a day, or an integrator adding
   * a subscription to a system that has been running for months, previously had
   * no way back: the queue only ever held what was emitted while the endpoint
   * existed and was active. Replay re-derives deliveries from the LEDGER — the
   * platform's own record of what happened — for one endpoint, from a sequence
   * number forward, honouring exactly the same subscription filter the live
   * path uses.
   *
   * Replayed deliveries are ordinary deliveries: same envelope shape, same
   * signature, new delivery ids. A receiver that dedupes on the delivery header
   * (as the contract requires) will process each event once per replay, which
   * is why the response states how many were enqueued and from which sequence.
   */
  async enqueueReplay(
    endpoint: EndpointRow,
    input: { fromSeq: number; toSeq?: number | null; limit: number },
  ): Promise<{ enqueued: number; scanned: number; lastSeq: number | null }> {
    const rows = await this.db
      .select({
        seq: ledgerEntries.seq,
        objectType: ledgerEntries.objectType,
        objectId: ledgerEntries.objectId,
        action: ledgerEntries.action,
        actorId: ledgerEntries.actorId,
        payload: ledgerEntries.payload,
        payloadHash: ledgerEntries.payloadHash,
        entryHash: ledgerEntries.entryHash,
        at: ledgerEntries.at,
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, endpoint.companyId),
          gte(ledgerEntries.seq, input.fromSeq),
          input.toSeq != null ? lte(ledgerEntries.seq, input.toSeq) : undefined,
        ),
      )
      .orderBy(asc(ledgerEntries.seq))
      .limit(input.limit);

    const values: (typeof webhookDeliveries.$inferInsert)[] = [];
    let lastSeq: number | null = null;
    for (const row of rows) {
      lastSeq = Number(row.seq);
      const kind = eventKind(row.objectType, row.action);
      if (!matchesEventKind(endpoint.eventKinds ?? [], kind)) continue;
      // ledger_entries carries no project column: the project is recoverable
      // only from a stored payload, so a project-narrowed endpoint replays
      // exactly the entries whose payload names its project and nothing else.
      const payload = (row.payload ?? null) as Record<string, unknown> | null;
      const projectId =
        payload && typeof payload["projectId"] === "string"
          ? (payload["projectId"] as string)
          : null;
      if (endpoint.projectId !== null && endpoint.projectId !== projectId) continue;
      values.push(
        this.buildDelivery(endpoint, kind, row.at, projectId, String(row.seq), {
          action: row.action,
          objectType: row.objectType,
          objectId: row.objectId,
          actorId: row.actorId,
          ledgerSeq: Number(row.seq),
          payloadHash: row.payloadHash,
          entryHash: row.entryHash,
          replay: true,
        }),
      );
    }
    if (values.length > 0) {
      await this.db.insert(webhookDeliveries).values(values);
      this.health.deliveriesEnqueued += values.length;
    }
    return { enqueued: values.length, scanned: rows.length, lastSeq };
  }
}

/**
 * The signed timestamp is derived from the envelope itself, so it is
 * recoverable from the stored delivery for ever — an auditor can re-verify a
 * two-year-old delivery from the row alone.
 */
export function signedTimestamp(envelope: WebhookEnvelope): number {
  const parsed = Date.parse(envelope.occurredAt);
  return Math.floor((Number.isFinite(parsed) ? parsed : 0) / 1000);
}

/* ------------------------------------------------------------------ */
/* Per-database-handle registry                                        */
/* ------------------------------------------------------------------ */

/**
 * One dispatcher per database handle. Registering on the handle rather than on
 * the Fastify instance means the module can reach it through plugin
 * encapsulation and a test can reach it without a decorator, while two apps in
 * one process (which the test helpers create routinely) can never share a
 * queue — the isolation the ledger emit hook relies on.
 */
const registry = new WeakMap<object, WebhookDispatcher>();

export function registerDispatcher(db: Db, dispatcher: WebhookDispatcher): void {
  registry.set(db as object, dispatcher);
}

export function getDispatcher(db: Db): WebhookDispatcher | undefined {
  return registry.get(db as object);
}
