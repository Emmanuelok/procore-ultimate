import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { webhookDeliveries, webhookEndpoints } from "@constructos/db";
import { sha256Hex } from "@constructos/ledger";
import type { WebhookDeliveryStatus } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import type { LedgerEvent } from "../../lib/ledger.js";
import { newId } from "../../lib/ids.js";
import { eventKind, matchesEventKind } from "./events.js";
import {
  ATTEMPT_HEADER,
  COMPANY_HEADER,
  DELIVERY_HEADER,
  ENDPOINT_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  canonicalBody,
  deriveEndpointSecret,
  signPayload,
  type SigningKey,
  type WebhookEnvelope,
} from "./signing.js";

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

  secretFor(endpointId: string): string {
    return deriveEndpointSecret(this.signingKey, endpointId);
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
      data,
    };
    const body = canonicalBody(envelope);
    const secret = this.secretFor(endpoint.id);
    const signature = signPayload(secret, signedTimestamp(envelope), id, body);
    return {
      id,
      companyId: endpoint.companyId,
      endpointId: endpoint.id,
      ledgerEntryId,
      eventKind: kind,
      payload: envelope as unknown as Record<string, unknown>,
      signature,
      status: "pending" satisfies WebhookDeliveryStatus,
      attempts: 0,
      nextAttemptAt: this.options.now().toISOString(),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Drain                                                             */
  /* ---------------------------------------------------------------- */

  /** Attempt every delivery that is due. Returns what happened. */
  async dispatchDue(): Promise<DispatchSummary> {
    const summary: DispatchSummary = {
      attempted: 0,
      delivered: 0,
      failed: 0,
      exhausted: 0,
      skipped: 0,
    };
    if (this.draining) return summary;
    this.draining = true;
    try {
      const nowIso = this.options.now().toISOString();
      const due = await this.db
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            inArray(webhookDeliveries.status, ["pending", "failed"]),
            or(
              isNull(webhookDeliveries.nextAttemptAt),
              lte(webhookDeliveries.nextAttemptAt, nowIso),
            ),
          ),
        )
        .orderBy(asc(webhookDeliveries.createdAt), asc(webhookDeliveries.id))
        .limit(this.options.batchSize);

      for (const delivery of due) {
        const outcome = await this.attempt(delivery);
        summary.attempted += 1;
        summary[outcome] += 1;
      }
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

  private async attempt(
    delivery: DeliveryRow,
  ): Promise<"delivered" | "failed" | "exhausted" | "skipped"> {
    const [endpoint] = await this.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, delivery.endpointId))
      .limit(1);
    const now = this.options.now();
    const nowIso = now.toISOString();

    if (!endpoint || endpoint.isActive !== 1) {
      await this.db
        .update(webhookDeliveries)
        .set({
          status: "skipped" satisfies WebhookDeliveryStatus,
          error: endpoint
            ? `Endpoint is disabled (${endpoint.disabledReason ?? "deactivated"}) — not delivered.`
            : "Endpoint no longer exists — not delivered.",
          nextAttemptAt: null,
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      return "skipped";
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
      // Re-signed from the stored envelope every attempt; because the signed
      // timestamp comes from the envelope, this is byte-identical to the
      // signature persisted at enqueue. Retries are therefore replays of the
      // same signed message, which is what makes delivery-id dedupe exact.
      [SIGNATURE_HEADER]: delivery.signature,
    };

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
          status: "delivered" satisfies WebhookDeliveryStatus,
          attempts: attempt,
          responseStatus: status,
          responseBody,
          error: null,
          nextAttemptAt: null,
          deliveredAt: nowIso,
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      // A success clears the consecutive-failure run: auto-disable is about a
      // sustained outage, not a lifetime error count.
      await this.db
        .update(webhookEndpoints)
        .set({
          failureCount: 0,
          lastDeliveryAt: nowIso,
          lastStatus: "delivered",
          updatedAt: nowIso,
        })
        .where(eq(webhookEndpoints.id, endpoint.id));
      return "delivered";
    }

    const exhausted = attempt >= this.options.maxAttempts;
    const errorText =
      transportError !== null
        ? `transport error: ${transportError}`
        : `receiver responded ${status}`;
    await this.db
      .update(webhookDeliveries)
      .set({
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

    if (!exhausted) {
      await this.db
        .update(webhookEndpoints)
        .set({ lastDeliveryAt: nowIso, lastStatus: "failed", updatedAt: nowIso })
        .where(eq(webhookEndpoints.id, endpoint.id));
      return "failed";
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
    return "exhausted";
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
