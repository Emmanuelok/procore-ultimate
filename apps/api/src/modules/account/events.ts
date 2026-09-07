import { authEvents, authSecurityEvents } from "@constructos/db";
import type {
  AuthEventKind,
  AuthEventOutcome,
  ExtraAuthEventKind,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import type { Db } from "../../lib/db.js";

/**
 * The account-security trail.
 *
 * Two tables, deliberately: `auth_security_events` is the rich append-only log
 * (outcome, session, provider, ip, reason, metadata) that an ISO 27001 or SOC 2
 * auditor asks for, and `auth_events` is the thin table the identity module has
 * written to since day one. Login keeps writing both — the old table is what
 * existing code and dashboards read, and silently orphaning it would be a
 * regression disguised as a refactor.
 *
 * NOTHING HERE EVER FAILS A REQUEST. A trail write that throws must not turn a
 * correct sign-in into a 500, and must never be the reason a lockout is not
 * applied. The failure surfaces in the request log; the route completes.
 *
 * WHAT MUST NEVER APPEAR IN `metadata`: a password, a raw token, a TOTP code, a
 * recovery code. The one place that rule gets broken is a well-meant "what did
 * they actually type" debug field, so it is stated here as well as in the
 * schema.
 */

/**
 * The kinds a writer may record. `AUTH_EVENT_KINDS` lives in the frozen
 * enums.ts; `EXTRA_AUTH_EVENT_KINDS` (enums-auth.ts) adds the ones this wave
 * needed — a tenant policy change, an IP refusal, a SCIM deprovision — which
 * previously had to go unrecorded because borrowing a neighbouring kind would
 * have put a false statement in the log an auditor reads literally. The column
 * is `text`, so the union is the only thing that had to widen.
 */
export type AnyAuthEventKind = AuthEventKind | ExtraAuthEventKind;

export interface SecurityEventInput {
  kind: AnyAuthEventKind;
  outcome?: AuthEventOutcome;
  userId?: string | null;
  companyId?: string | null;
  email?: string | null;
  sessionId?: string | null;
  providerId?: string | null;
  identityId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * SUBSCRIBERS TO THE TRAIL.
 *
 * Security event webhooks (docs/security.md §"Security event webhooks") need
 * to see every row this function writes, and the alternative — every caller
 * remembering to also enqueue a delivery — is the kind of coupling that is
 * correct on the day it is written and wrong a month later. The hook list is
 * the same pattern lib/ledger.ts uses for ledger emits.
 *
 * A HOOK MAY NOT FAIL THE REQUEST. It is invoked inside the same try/catch
 * that already guarantees the trail never breaks a sign-in, and its own
 * rejection is swallowed. A webhook subscriber that throws must not be able to
 * stop people logging in.
 */
export type SecurityEventHook = (
  db: Db,
  event: SecurityEventInput & { id: string; at: string },
) => void | Promise<void>;

const securityEventHooks: SecurityEventHook[] = [];

export function addSecurityEventHook(hook: SecurityEventHook): () => void {
  securityEventHooks.push(hook);
  return () => {
    const idx = securityEventHooks.indexOf(hook);
    if (idx !== -1) securityEventHooks.splice(idx, 1);
  };
}

/** Test seam: drop every registered subscriber. */
export function clearSecurityEventHooks(): void {
  securityEventHooks.length = 0;
}

export async function recordAuthEvent(db: Db, input: SecurityEventInput): Promise<void> {
  const id = newId("ase");
  const at = new Date().toISOString();
  try {
    await db.insert(authSecurityEvents).values({
      id,
      companyId: input.companyId ?? null,
      userId: input.userId ?? null,
      email: input.email ?? null,
      kind: input.kind,
      outcome: input.outcome ?? "success",
      sessionId: input.sessionId ?? null,
      providerId: input.providerId ?? null,
      identityId: input.identityId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      reason: input.reason ?? null,
      metadata: input.metadata ?? {},
    });
  } catch {
    /* the trail must never fail the request it describes */
    return;
  }
  for (const hook of securityEventHooks) {
    try {
      await hook(db, { ...input, id, at });
    } catch {
      /* a subscriber must never fail the request either */
    }
  }
}

/** The legacy thin row the identity module has always written. */
export async function recordLegacyAuthEvent(
  db: Db,
  input: { userId?: string | null; email?: string | null; kind: string; ip?: string | null; userAgent?: string | null },
): Promise<void> {
  try {
    await db.insert(authEvents).values({
      id: newId("ae"),
      userId: input.userId ?? null,
      email: input.email ?? null,
      kind: input.kind,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
  } catch {
    /* as above */
  }
}
