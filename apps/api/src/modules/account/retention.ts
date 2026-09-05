import { and, eq, inArray, isNotNull, lte, ne, or } from "drizzle-orm";
import { authSecurityEvents, emailDispatches } from "@constructos/db";
import type { Db } from "../../lib/db.js";
import { loadCompanyPolicy } from "./policy.js";

/**
 * DATA LIFECYCLE FOR THE AUTHENTICATION RECORD (spec Vol I §0.2 #46, #47).
 *
 * Two logs on this platform accumulate personal data as a side effect of
 * working correctly: `auth_security_events` (an address, an IP and a user
 * agent for every sign-in, failure, lockout and provisioning call) and
 * `email_dispatches` (a recipient, a subject and a preview of every message
 * composed). Both are evidence. Neither may be kept for ever by default, and
 * neither may be deleted because a sweep found it convenient.
 *
 * THE THREE RULES THIS FILE KEEPS
 * ------------------------------------------------------------------------
 * 1. A TENANT THAT HAS CHOSEN NOTHING IS NOT SWEPT. `null` retention means
 *    "keep", which is what the platform did before the policy existed. Opting
 *    a customer into deletion by shipping a default would destroy records
 *    nobody agreed to lose.
 *
 * 2. THE TRAIL IS PSEUDONYMISED, NOT DELETED. The kind, the outcome and the
 *    timestamp survive; the email, the IP and the user agent go. That keeps
 *    "how many failed sign-ins last quarter" answerable — a question a tenant
 *    is entitled to ask about its own security — while removing what makes a
 *    row about a person. Deleting the rows outright would also corrupt the
 *    lockout engine's view of history mid-window; pseudonymising cannot,
 *    because the lockout query filters on `email`/`ip` and a pseudonymised row
 *    simply stops matching, exactly as an expired row does.
 *
 *    The message log IS deleted, because a redacted preview of a message
 *    nobody can now identify is not evidence of anything.
 *
 * 3. A LEGAL HOLD BEATS A RETENTION POLICY, ALWAYS. `legalHold` skips the
 *    tenant entirely and the sweep SAYS SO in what it returns, rather than
 *    reporting zero rows and letting an operator conclude there was nothing
 *    to do.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not touch `auth_events` (the
 * legacy thin table), the ledger, or anything a company cannot already read
 * through /company/security-events. Erasure of a whole tenant is a different
 * operation with a different authorisation, and it is not this.
 */

/** The value written over a pseudonymised column, so the state is legible. */
export const PSEUDONYM = "[redacted:retention]";

export interface RetentionOutcome {
  companyId: string;
  /** true when nothing ran because the tenant is on legal hold */
  skipped: boolean;
  reason: string | null;
  securityEventsPseudonymised: number;
  emailDispatchesDeleted: number;
}

export interface RetentionOptions {
  nowMs?: number;
  /** ceiling per sweep, so one enormous tenant cannot monopolise a tick */
  limit?: number;
}

/**
 * Apply one tenant's retention policy. Idempotent: a row already
 * pseudonymised no longer matches the predicate, so running twice in a minute
 * does the work once.
 */
export async function applyRetention(
  db: Db,
  companyId: string,
  options: RetentionOptions = {},
): Promise<RetentionOutcome> {
  const nowMs = options.nowMs ?? Date.now();
  const limit = options.limit ?? 2000;
  const policy = await loadCompanyPolicy(db, companyId);

  if (policy.legalHold) {
    return {
      companyId,
      skipped: true,
      reason:
        policy.legalHoldReason ??
        "This organisation is under a legal hold; no authentication record was removed.",
      securityEventsPseudonymised: 0,
      emailDispatchesDeleted: 0,
    };
  }
  if (policy.securityEventRetentionDays === null && policy.emailDispatchRetentionDays === null) {
    return {
      companyId,
      skipped: true,
      reason: "This organisation has set no retention period, so nothing is removed.",
      securityEventsPseudonymised: 0,
      emailDispatchesDeleted: 0,
    };
  }

  let pseudonymised = 0;
  if (policy.securityEventRetentionDays !== null) {
    const cutoff = new Date(nowMs - policy.securityEventRetentionDays * 86_400_000).toISOString();
    // Selected first, then written by id, so the `limit` is a real ceiling on
    // one sweep's work rather than a hint.
    const doomed = await db
      .select({ id: authSecurityEvents.id })
      .from(authSecurityEvents)
      .where(
        and(
          eq(authSecurityEvents.companyId, companyId),
          lte(authSecurityEvents.at, cutoff),
          // ALREADY-PSEUDONYMISED ROWS MUST NOT MATCH, or the sweep is not
          // idempotent: `email` is overwritten with a sentinel rather than
          // nulled (so the state is legible in the table), and a bare
          // `email IS NOT NULL` therefore keeps selecting the same rows every
          // run — which reports work that did not happen and re-writes rows
          // for ever. Caught by the "is idempotent" test.
          or(
            and(isNotNull(authSecurityEvents.email), ne(authSecurityEvents.email, PSEUDONYM)),
            isNotNull(authSecurityEvents.ip),
            isNotNull(authSecurityEvents.userAgent),
          ),
        ),
      )
      .limit(limit);
    if (doomed.length > 0) {
      await db
        .update(authSecurityEvents)
        .set({ email: PSEUDONYM, ip: null, userAgent: null })
        .where(
          inArray(
            authSecurityEvents.id,
            doomed.map((d) => d.id),
          ),
        );
      pseudonymised = doomed.length;
    }
  }

  let deleted = 0;
  if (policy.emailDispatchRetentionDays !== null) {
    const cutoff = new Date(nowMs - policy.emailDispatchRetentionDays * 86_400_000).toISOString();
    const doomed = await db
      .select({ id: emailDispatches.id })
      .from(emailDispatches)
      .where(and(eq(emailDispatches.companyId, companyId), lte(emailDispatches.createdAt, cutoff)))
      .limit(limit);
    if (doomed.length > 0) {
      await db.delete(emailDispatches).where(
        inArray(
          emailDispatches.id,
          doomed.map((d) => d.id),
        ),
      );
      deleted = doomed.length;
    }
  }

  return {
    companyId,
    skipped: false,
    reason: null,
    securityEventsPseudonymised: pseudonymised,
    emailDispatchesDeleted: deleted,
  };
}
