import type { FastifyInstance } from "fastify";
import { emailDispatches } from "@constructos/db";
import type { EmailTemplateKey } from "@constructos/shared";
import {
  deliveryReport,
  dispatchRow,
  redactForStorage,
  resolveEmailTransport,
  type EmailDeliveryReport,
  type EmailMessage,
  type EmailSendResult,
  type EmailTransport,
} from "../../lib/email.js";
import { newId } from "../../lib/ids.js";
import { recordAuthEvent } from "./events.js";

/**
 * One transport per app instance, and the record that keeps it honest.
 *
 * `resolveEmailTransport` builds a NEW transport each call, and the default one
 * records into memory — so calling it per request would throw away the log the
 * no-op transport exists to keep. It is therefore memoised in a WeakMap keyed
 * on the DATABASE HANDLE, the same idiom lib/ledger.ts uses for its emit hook
 * and for the same two reasons: a test file holds several apps at once and one
 * app's outbox must never be visible to another, and `app.db` is the one
 * object shared by every module of a single app. Keying on the Fastify
 * instance would NOT do that — each `register()` creates an encapsulated child
 * instance, so the account module and the directory module would end up
 * composing into two different outboxes.
 *
 * `useEmailTransport` is the injection point tests need: the API is registered
 * by `buildApp` with no options, so there is nowhere else to hand a stub in.
 * It is what lets the SENDING path — a provider that accepts, and a provider
 * that rejects — be tested through the real routes rather than only in a unit
 * test of the adapter.
 */
const transports = new WeakMap<object, EmailTransport>();

export function emailTransportFor(app: FastifyInstance): EmailTransport {
  const key = app.db as object;
  let transport = transports.get(key);
  if (!transport) {
    transport = resolveEmailTransport(app.appConfig);
    transports.set(key, transport);
  }
  return transport;
}

/** Override the transport for one app instance (tests). `null` restores it. */
export function useEmailTransport(app: FastifyInstance, transport: EmailTransport | null): void {
  const key = app.db as object;
  if (transport) transports.set(key, transport);
  else transports.delete(key);
}

export interface DispatchInput {
  message: Omit<EmailMessage, "template"> & { template: EmailTemplateKey };
  /** raw values that must never reach `email_dispatches` — tokens, links */
  secrets?: readonly string[];
  companyId?: string | null;
  userId?: string | null;
  variables?: Record<string, unknown>;
  relatedType?: string | null;
  relatedId?: string | null;
}

export interface DispatchOutcome {
  /** `email_dispatches.id`, or null if even the record could not be written */
  dispatchId: string | null;
  result: EmailSendResult;
  /** what the API response says about delivery — always include it */
  report: EmailDeliveryReport;
}

/** Redact template variables with the same rules as the body. */
function redactVariables(
  variables: Record<string, unknown>,
  secrets: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(variables)) {
    out[key] = typeof value === "string" ? redactForStorage(value, secrets) : value;
  }
  return out;
}

/**
 * Compose → send → record, in that order, and never throw on a delivery
 * failure: `EmailTransport.send` reports `dispatched:false` instead, and the
 * row is written either way. "We composed it and nothing left the building" is
 * a state the platform must be able to state, not one it may hide.
 */
export async function dispatchEmail(
  app: FastifyInstance,
  input: DispatchInput,
): Promise<DispatchOutcome> {
  const transport = emailTransportFor(app);
  const secrets = input.secrets ?? [];
  const result = await transport.send(input.message, secrets);
  const row = dispatchRow(input.message, result);

  let dispatchId: string | null = newId("edp");
  try {
    await app.db.insert(emailDispatches).values({
      id: dispatchId,
      companyId: input.companyId ?? null,
      userId: input.userId ?? null,
      template: input.message.template,
      toEmail: row.toEmail,
      toName: row.toName,
      subject: row.subject,
      bodyPreview: row.bodyPreview,
      variables: redactVariables(input.variables ?? {}, secrets),
      status: row.status,
      transport: row.transport,
      provider: row.provider,
      providerMessageId: row.providerMessageId,
      reasons: row.reasons,
      error: row.error,
      dispatchedAt: row.dispatchedAt,
      relatedType: input.relatedType ?? null,
      relatedId: input.relatedId ?? null,
    });
  } catch {
    // A message that went out but could not be recorded is still a message
    // that went out; the caller gets a null id rather than a failed request.
    dispatchId = null;
  }

  if (result.status === "failed") {
    await recordAuthEvent(app.db, {
      kind: "email_dispatch_failed",
      outcome: "failure",
      userId: input.userId ?? null,
      companyId: input.companyId ?? null,
      email: row.toEmail,
      reason: result.error ?? result.reasons[0] ?? null,
      metadata: { template: input.message.template, dispatchId },
    });
  } else if (!result.dispatched) {
    await recordAuthEvent(app.db, {
      kind: "email_dispatch_recorded",
      outcome: "pending",
      userId: input.userId ?? null,
      companyId: input.companyId ?? null,
      email: row.toEmail,
      reason: result.reasons[0] ?? null,
      metadata: { template: input.message.template, dispatchId },
    });
  }

  return { dispatchId, result, report: deliveryReport(result) };
}
