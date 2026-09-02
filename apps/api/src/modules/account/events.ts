import { authEvents, authSecurityEvents } from "@constructos/db";
import type { AuthEventKind, AuthEventOutcome } from "@constructos/shared";
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

export interface SecurityEventInput {
  kind: AuthEventKind;
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

export async function recordAuthEvent(db: Db, input: SecurityEventInput): Promise<void> {
  try {
    await db.insert(authSecurityEvents).values({
      id: newId("ase"),
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
