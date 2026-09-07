import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, lte, or, isNull } from "drizzle-orm";
import {
  securityWebhookDeliveries,
  securityWebhooks,
} from "@constructos/db";
import type { SecurityWebhookStatus } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import type { Db } from "../../lib/db.js";
import { checkWebhookUrl, policyFor } from "../integrations/ssrf.js";
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
  resolveSigningKey,
  secretFingerprint,
  signPayload,
  type WebhookEnvelope,
} from "../integrations/signing.js";

/**
 * SECURITY EVENT WEBHOOKS (Vol I §0.2).
 *
 * What this is: a push of `auth_security_events` rows to a tenant's SIEM.
 * Sign-ins, failures, lockouts, policy changes, provider changes, SCIM
 * provisioning — the events a security team is expected to correlate with the
 * rest of its estate, delivered rather than waiting to be polled.
 *
 * WHY IT IS NOT `webhook_endpoints` (modules/integrations). That subscription
 * carries LEDGER events about the works, and its subscribers are
 * line-of-business systems: an ERP that receives "an invoice was approved"
 * has no business receiving "someone failed to sign in from 203.0.113.4", and
 * a security team should not have to filter a project feed to find its own.
 * The two share the wire format and the signing scheme (modules/integrations/
 * signing.ts) deliberately — one integrator implementation verifies both — and
 * share the SSRF policy (modules/integrations/ssrf.ts) so a webhook can never
 * be pointed at the platform's own network.
 *
 * WHAT IS NEVER SENT: an IP is sent, an email address is sent, a user id is
 * sent. A token, a password, a TOTP code or a recovery code is not, because
 * `auth_security_events.metadata` is forbidden from holding one in the first
 * place (see the schema) and the payload is built from that row.
 *
 * DELIVERY IS AT-LEAST-ONCE, and the receiver's dedupe key is the delivery id
 * in `x-constructos-delivery`. A delivery is retried with backoff up to
 * MAX_ATTEMPTS; an endpoint that fails MAX_CONSECUTIVE_FAILURES times in a row
 * is disabled with a stated reason, because a webhook that has been silently
 * failing for a month is worse than one that is visibly off.
 */

export const MAX_ATTEMPTS = 5;
export const MAX_CONSECUTIVE_FAILURES = 20;
const TIMEOUT_MS = 8_000;

/** Exponential backoff with a ceiling: 1m, 4m, 9m, 16m… capped at 30m. */
export function backoffMs(attempt: number): number {
  return Math.min(30 * 60_000, attempt * attempt * 60_000);
}

export interface SecurityEventPayload {
  id: string;
  kind: string;
  outcome: string;
  at: string;
  companyId: string | null;
  userId: string | null;
  email: string | null;
  sessionId: string | null;
  providerId: string | null;
  ip: string | null;
  userAgent: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
}

/** Does this endpoint want this kind? An empty subscription means "all". */
export function subscribes(eventKinds: readonly string[], kind: string): boolean {
  return eventKinds.length === 0 || eventKinds.includes(kind);
}

/* ------------------------------------------------------------------ */
/* Enqueue                                                             */
/* ------------------------------------------------------------------ */

/**
 * Write one pending delivery per subscribed endpoint.
 *
 * Enqueue only — nothing is sent on the request thread. A sign-in must not
 * wait on somebody's SIEM, and a SIEM that is down must not slow sign-ins
 * down. The sweep (below) does the sending.
 *
 * An event with NO company (a failed login against an address that belongs to
 * nobody) reaches no endpoint: there is no tenant whose webhook it is. That is
 * a real gap for a platform-wide security team and it is stated rather than
 * papered over — the company-less rows are in `auth_security_events` and the
 * operator reads them there.
 */
export async function enqueueSecurityEvent(
  db: Db,
  event: SecurityEventPayload,
): Promise<number> {
  if (!event.companyId) return 0;
  const endpoints = await db
    .select()
    .from(securityWebhooks)
    .where(
      and(eq(securityWebhooks.companyId, event.companyId), eq(securityWebhooks.isEnabled, true)),
    );
  const wanted = endpoints.filter((e) => subscribes(e.eventKinds ?? [], event.kind));
  if (wanted.length === 0) return 0;
  const nowIso = new Date().toISOString();
  await db.insert(securityWebhookDeliveries).values(
    wanted.map((endpoint) => ({
      id: newId("swd"),
      companyId: event.companyId!,
      webhookId: endpoint.id,
      eventKind: event.kind,
      eventId: event.id,
      payload: event as unknown as Record<string, unknown>,
      status: "pending" as SecurityWebhookStatus,
      nextAttemptAt: nowIso,
    })),
  );
  return wanted.length;
}

/* ------------------------------------------------------------------ */
/* Delivery                                                            */
/* ------------------------------------------------------------------ */

export interface DeliveryOutcome {
  deliveryId: string;
  status: SecurityWebhookStatus;
  statusCode: number | null;
  error: string | null;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Attempt one delivery.
 *
 * The SSRF check runs on EVERY attempt, not only at registration: DNS moves,
 * and a hostname that resolved to a public address last week can resolve to
 * 169.254.169.254 today. A refusal is terminal (`refused`) rather than
 * retried — retrying a request the policy will refuse again is a loop.
 */
export async function attemptDelivery(
  app: FastifyInstance,
  deliveryId: string,
  options: { fetcher?: Fetcher; nowMs?: number } = {},
): Promise<DeliveryOutcome> {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const nowMs = options.nowMs ?? Date.now();
  const [delivery] = await app.db
    .select()
    .from(securityWebhookDeliveries)
    .where(eq(securityWebhookDeliveries.id, deliveryId))
    .limit(1);
  if (!delivery) {
    return { deliveryId, status: "failed", statusCode: null, error: "delivery not found" };
  }
  const [endpoint] = await app.db
    .select()
    .from(securityWebhooks)
    .where(eq(securityWebhooks.id, delivery.webhookId))
    .limit(1);
  if (!endpoint) {
    await finish(app.db, delivery.id, {
      status: "failed",
      statusCode: null,
      error: "endpoint no longer exists",
      attempts: delivery.attempts + 1,
      nowMs,
    });
    return { deliveryId, status: "failed", statusCode: null, error: "endpoint no longer exists" };
  }

  const verdict = await checkWebhookUrl(
    endpoint.url,
    policyFor({
      NODE_ENV: app.appConfig.NODE_ENV,
      ...(process.env["WEBHOOK_ALLOW_HOSTS"]
        ? { WEBHOOK_ALLOW_HOSTS: process.env["WEBHOOK_ALLOW_HOSTS"] }
        : {}),
    }),
  );
  if (!verdict.ok) {
    await finish(app.db, delivery.id, {
      status: "refused",
      statusCode: null,
      error: verdict.reason,
      attempts: delivery.attempts + 1,
      nowMs,
    });
    return { deliveryId, status: "refused", statusCode: null, error: verdict.reason };
  }

  const key = resolveSigningKey(app.appConfig.AUTH_SECRET);
  const secret = deriveEndpointSecret(key, endpoint.id);
  const envelope: WebhookEnvelope = {
    id: delivery.id,
    type: `security.${delivery.eventKind}`,
    companyId: delivery.companyId,
    projectId: null,
    occurredAt: delivery.createdAt,
    endpointId: endpoint.id,
    data: delivery.payload ?? {},
  };
  const body = canonicalBody(envelope);
  const timestamp = Math.floor(nowMs / 1000);
  const attempt = delivery.attempts + 1;

  let statusCode: number | null = null;
  let error: string | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetcher(verdict.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "user-agent": "ConstructOS-SecurityWebhooks/1",
        [EVENT_HEADER]: envelope.type,
        [DELIVERY_HEADER]: delivery.id,
        [ENDPOINT_HEADER]: endpoint.id,
        [COMPANY_HEADER]: delivery.companyId,
        [ATTEMPT_HEADER]: String(attempt),
        [TIMESTAMP_HEADER]: String(timestamp),
        [SIGNATURE_HEADER]: signPayload(secret, timestamp, delivery.id, body),
      },
      body,
    });
    statusCode = res.status;
    if (!res.ok) error = `endpoint answered ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }

  const delivered = statusCode !== null && statusCode >= 200 && statusCode < 300;
  const exhausted = attempt >= MAX_ATTEMPTS;
  const status: SecurityWebhookStatus = delivered ? "delivered" : exhausted ? "failed" : "pending";
  await finish(app.db, delivery.id, { status, statusCode, error, attempts: attempt, nowMs });
  await noteEndpointOutcome(app.db, endpoint.id, delivered, statusCode, error, nowMs);
  return { deliveryId, status, statusCode, error };
}

async function finish(
  db: Db,
  deliveryId: string,
  input: {
    status: SecurityWebhookStatus;
    statusCode: number | null;
    error: string | null;
    attempts: number;
    nowMs: number;
  },
): Promise<void> {
  await db
    .update(securityWebhookDeliveries)
    .set({
      status: input.status,
      statusCode: input.statusCode,
      error: input.error,
      attempts: input.attempts,
      deliveredAt: input.status === "delivered" ? new Date(input.nowMs).toISOString() : null,
      nextAttemptAt:
        input.status === "pending"
          ? new Date(input.nowMs + backoffMs(input.attempts)).toISOString()
          : null,
    })
    .where(eq(securityWebhookDeliveries.id, deliveryId));
}

async function noteEndpointOutcome(
  db: Db,
  webhookId: string,
  delivered: boolean,
  statusCode: number | null,
  error: string | null,
  nowMs: number,
): Promise<void> {
  const [endpoint] = await db
    .select()
    .from(securityWebhooks)
    .where(eq(securityWebhooks.id, webhookId))
    .limit(1);
  if (!endpoint) return;
  const consecutive = delivered ? 0 : endpoint.consecutiveFailures + 1;
  const disable = !delivered && consecutive >= MAX_CONSECUTIVE_FAILURES;
  await db
    .update(securityWebhooks)
    .set({
      consecutiveFailures: consecutive,
      lastDeliveryAt: new Date(nowMs).toISOString(),
      lastStatus: delivered ? `${statusCode ?? 200}` : (error ?? "failed"),
      ...(disable
        ? {
            isEnabled: false,
            disabledReason:
              `Disabled automatically after ${consecutive} consecutive delivery failures. ` +
              "Fix the destination and re-enable; nothing was delivered in the meantime.",
          }
        : {}),
      updatedAt: new Date(nowMs).toISOString(),
    })
    .where(eq(securityWebhooks.id, webhookId));
}

/* ------------------------------------------------------------------ */
/* The sweep                                                           */
/* ------------------------------------------------------------------ */

export interface SweepResult {
  attempted: number;
  delivered: number;
  failed: number;
  refused: number;
  stillPending: number;
}

/**
 * Send every delivery that is due. Registered with `app.scheduler` as
 * `account.security-webhooks`, and reachable manually so an operator can
 * flush the queue after fixing a destination.
 *
 * BOUNDED: at most `limit` deliveries per cycle, oldest first. A tenant whose
 * SIEM has been down for a day must not be able to make one sweep run for
 * twenty minutes.
 */
export async function sweepSecurityWebhooks(
  app: FastifyInstance,
  options: { limit?: number; fetcher?: Fetcher; nowMs?: number; companyId?: string } = {},
): Promise<SweepResult> {
  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const due = await app.db
    .select({ id: securityWebhookDeliveries.id })
    .from(securityWebhookDeliveries)
    .where(
      and(
        eq(securityWebhookDeliveries.status, "pending"),
        or(
          isNull(securityWebhookDeliveries.nextAttemptAt),
          lte(securityWebhookDeliveries.nextAttemptAt, nowIso),
        ),
        options.companyId ? eq(securityWebhookDeliveries.companyId, options.companyId) : undefined,
      ),
    )
    .orderBy(asc(securityWebhookDeliveries.createdAt))
    .limit(options.limit ?? 100);

  const result: SweepResult = {
    attempted: 0,
    delivered: 0,
    failed: 0,
    refused: 0,
    stillPending: 0,
  };
  for (const row of due) {
    const outcome = await attemptDelivery(app, row.id, {
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      nowMs,
    });
    result.attempted += 1;
    if (outcome.status === "delivered") result.delivered += 1;
    else if (outcome.status === "failed") result.failed += 1;
    else if (outcome.status === "refused") result.refused += 1;
    else result.stillPending += 1;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Endpoint helpers used by the routes                                 */
/* ------------------------------------------------------------------ */

/** The fingerprint of the secret this endpoint's deliveries are signed with. */
export function fingerprintFor(app: FastifyInstance, endpointId: string): string {
  const key = resolveSigningKey(app.appConfig.AUTH_SECRET);
  return secretFingerprint(deriveEndpointSecret(key, endpointId));
}

/** The secret itself — returned exactly once, at creation. */
export function secretFor(app: FastifyInstance, endpointId: string): string {
  return deriveEndpointSecret(resolveSigningKey(app.appConfig.AUTH_SECRET), endpointId);
}

export async function recentDeliveries(
  db: Db,
  companyId: string,
  options: { webhookId?: string; limit?: number } = {},
) {
  return db
    .select()
    .from(securityWebhookDeliveries)
    .where(
      and(
        eq(securityWebhookDeliveries.companyId, companyId),
        options.webhookId
          ? eq(securityWebhookDeliveries.webhookId, options.webhookId)
          : undefined,
      ),
    )
    .orderBy(desc(securityWebhookDeliveries.createdAt))
    .limit(options.limit ?? 50);
}

/** Delete a company's endpoints and their delivery log (tenant erasure). */
export async function purgeCompanyWebhooks(db: Db, companyId: string): Promise<void> {
  const rows = await db
    .select({ id: securityWebhooks.id })
    .from(securityWebhooks)
    .where(eq(securityWebhooks.companyId, companyId));
  if (rows.length > 0) {
    await db
      .delete(securityWebhookDeliveries)
      .where(inArray(securityWebhookDeliveries.webhookId, rows.map((r) => r.id)));
  }
  await db.delete(securityWebhooks).where(eq(securityWebhooks.companyId, companyId));
}
