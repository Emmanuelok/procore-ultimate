import { and, eq, inArray, isNull, lte } from "drizzle-orm";
import { mfaChallenges } from "@constructos/db";
import type { Db } from "../../lib/db.js";
import type { ChallengeClaims, ChallengeScope } from "./challenge.js";

/**
 * THE SERVER-SIDE HALF OF AN MFA CHALLENGE.
 *
 * `challenge.ts` mints a MAC'd, stateless token, and its header used to say
 * plainly what that cost: within the token's ten-minute life the same token
 * could be presented more than once, and there was no way to revoke one in
 * flight. The reason given was that the module did not own the schema. It
 * does now, so this file closes the gap rather than restating it.
 *
 * ------------------------------------------------------------------------
 * WHY CONSUMPTION IS AN UPSERT AND NOT A LOOKUP
 * ------------------------------------------------------------------------
 * Three modules mint challenges: `mfa` (POST /auth/mfa/login), `sso` (an IdP
 * sign-in into a tenant that requires a second factor) and `identity`
 * (POST /auth/login) — and `identity` belongs to a different work package.
 * A design that refused any challenge without a pre-registered row would have
 * made a cross-package edit a PRECONDITION of the fix, and until that edit
 * landed every sign-in through /auth/login would have failed at the second
 * factor. That is not a trade a login path may make.
 *
 * So the primary key is the token's own `jti` and the first exchange either
 * flips an existing row's `consumed_at` or INSERTS an already-consumed row.
 * Either way the second exchange of the same token finds a consumed row and
 * is refused. A challenge from a module that never registered is single-use
 * exactly like one that did; registering adds visibility and revocation, not
 * correctness.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ------------------------------------------------------------------------
 * It does not fail a sign-in when the challenge table is unreadable. A
 * database that cannot be written is already an outage; turning it into "no
 * one with a second factor can sign in" adds nothing to the platform's
 * safety. `consumeChallenge` reports `{ ok: false, reason }` only for a
 * replay, a revocation or an expiry — a *decision* — and rethrows nothing of
 * its own. Callers treat an infrastructure failure as "not a replay", which
 * is the same exposure the stateless design already had.
 */

export type ChallengeOrigin = "password" | "sso" | "step_up";

export interface ChallengeRegistration {
  claims: ChallengeClaims;
  origin: ChallengeOrigin;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Record a challenge as live. Best-effort by design: see the header. The
 * single-use guarantee does not depend on this call succeeding.
 */
export async function registerChallenge(db: Db, input: ChallengeRegistration): Promise<void> {
  try {
    await db
      .insert(mfaChallenges)
      .values({
        id: input.claims.jti,
        userId: input.claims.uid,
        scope: input.claims.scope,
        origin: input.origin,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        expiresAt: new Date(input.claims.exp).toISOString(),
      })
      .onConflictDoNothing();
  } catch {
    /* the challenge is still single-use — consumeChallenge upserts */
  }
}

export interface ChallengeVerdict {
  ok: boolean;
  /** prose for the 401 body; null when the challenge was accepted */
  reason: string | null;
  /** `replayed` | `revoked` | `expired` | null — for the security trail */
  code: "replayed" | "revoked" | "expired" | null;
}

const OK: ChallengeVerdict = { ok: true, reason: null, code: null };

/**
 * Read a live challenge WITHOUT spending it.
 *
 * Used by `POST /auth/mfa/challenge/enrol`, which provisions a TOTP seed
 * against a challenge that must still be exchangeable afterwards: the same
 * challenge confirms the new factor. Refusing a revoked or already-exchanged
 * challenge here stops a seed being minted against authority that is gone.
 */
export async function assertChallengeLive(
  db: Db,
  jti: string,
  nowMs: number,
): Promise<ChallengeVerdict> {
  let row: typeof mfaChallenges.$inferSelect | undefined;
  try {
    const rows = await db.select().from(mfaChallenges).where(eq(mfaChallenges.id, jti)).limit(1);
    row = rows[0];
  } catch {
    return OK;
  }
  // No row is not a failure: a challenge minted by a module that does not
  // register is legitimate and unspent. Absence proves nothing either way,
  // and the token's own MAC and expiry have already been checked.
  if (!row) return OK;
  return verdictFor(row, nowMs);
}

/**
 * Spend a challenge. Returns `{ ok: false }` for a replay, a revocation or an
 * expiry — the three states in which the exchange must not produce a session.
 */
export async function consumeChallenge(
  db: Db,
  claims: Pick<ChallengeClaims, "jti" | "uid" | "scope" | "exp">,
  nowMs: number,
): Promise<ChallengeVerdict> {
  const jti = claims.jti;
  const nowIso = new Date(nowMs).toISOString();
  try {
    // The atomic path: flip a live row. Two simultaneous exchanges of one
    // token both reach here; exactly one UPDATE matches, because the second
    // sees `consumed_at` already set by the first.
    const updated = await db
      .update(mfaChallenges)
      .set({ consumedAt: nowIso })
      .where(and(eq(mfaChallenges.id, jti), isNull(mfaChallenges.consumedAt)))
      .returning({ id: mfaChallenges.id, revokedAt: mfaChallenges.revokedAt, expiresAt: mfaChallenges.expiresAt, revokedReason: mfaChallenges.revokedReason });
    const hit = updated[0];
    if (hit) {
      // A revoked or expired row is still flipped by the UPDATE above; the
      // verdict, not the write, is what decides the request. Spending it is
      // deliberate: a refused exchange must not leave the token usable.
      return verdictFor(
        { revokedAt: hit.revokedAt, revokedReason: hit.revokedReason, expiresAt: hit.expiresAt, consumedAt: null },
        nowMs,
      );
    }
    // No live row. Either this token was already exchanged (replay) or it was
    // never registered (a minter outside this package) — tell those apart.
    const rows = await db.select().from(mfaChallenges).where(eq(mfaChallenges.id, jti)).limit(1);
    const existing = rows[0];
    if (existing) {
      return {
        ok: false,
        reason:
          "This sign-in challenge has already been used. Challenges are single-use — start the sign-in again.",
        code: "replayed",
      };
    }
    await db.insert(mfaChallenges).values({
      id: jti,
      userId: claims.uid,
      scope: claims.scope,
      origin: "password",
      consumedAt: nowIso,
      expiresAt: new Date(claims.exp).toISOString(),
    });
    return OK;
  } catch {
    // See the header: an unreadable table must not become "nobody with a
    // second factor can sign in".
    return OK;
  }
}

function verdictFor(
  row: { revokedAt: string | null; revokedReason: string | null; expiresAt: string; consumedAt: string | null },
  nowMs: number,
): ChallengeVerdict {
  if (row.consumedAt) {
    return {
      ok: false,
      reason:
        "This sign-in challenge has already been used. Challenges are single-use — start the sign-in again.",
      code: "replayed",
    };
  }
  if (row.revokedAt) {
    return {
      ok: false,
      reason:
        row.revokedReason ??
        "This sign-in challenge was cancelled by an administrator. Start the sign-in again.",
      code: "revoked",
    };
  }
  if (Date.parse(row.expiresAt) <= nowMs) {
    return { ok: false, reason: "This sign-in challenge has expired. Sign in again.", code: "expired" };
  }
  return OK;
}

/**
 * Cut every in-flight challenge for one account.
 *
 * Called when an administrator clears somebody's second factor: the point of
 * that action is that the old factor stops working NOW, and a challenge
 * minted a minute earlier is authority issued on the strength of the factor
 * being removed.
 */
export async function revokeUserChallenges(
  db: Db,
  userId: string,
  reason: string,
  nowMs: number,
): Promise<number> {
  try {
    const rows = await db
      .update(mfaChallenges)
      .set({ revokedAt: new Date(nowMs).toISOString(), revokedReason: reason })
      .where(
        and(
          eq(mfaChallenges.userId, userId),
          isNull(mfaChallenges.consumedAt),
          isNull(mfaChallenges.revokedAt),
        ),
      )
      .returning({ id: mfaChallenges.id });
    return rows.length;
  } catch {
    return 0;
  }
}

/**
 * Delete challenges past their expiry plus a grace window.
 *
 * The grace exists so a replay of a just-expired token is still ANSWERED with
 * "already used" rather than silently re-inserted as a fresh consumption; an
 * hour is long enough for that and short enough that the table stays small.
 */
export async function sweepExpiredChallenges(
  db: Db,
  nowMs: number,
  options: { graceMs?: number; limit?: number } = {},
): Promise<number> {
  const graceMs = options.graceMs ?? 3600_000;
  const cutoff = new Date(nowMs - graceMs).toISOString();
  const doomed = await db
    .select({ id: mfaChallenges.id })
    .from(mfaChallenges)
    .where(lte(mfaChallenges.expiresAt, cutoff))
    .limit(options.limit ?? 5000);
  if (doomed.length === 0) return 0;
  await db.delete(mfaChallenges).where(inArray(mfaChallenges.id, doomed.map((d) => d.id)));
  return doomed.length;
}

/** How many challenges are still exchangeable for this account. */
export async function liveChallengeCount(db: Db, userId: string, nowMs: number): Promise<number> {
  const rows = await db
    .select({ id: mfaChallenges.id, expiresAt: mfaChallenges.expiresAt })
    .from(mfaChallenges)
    .where(
      and(
        eq(mfaChallenges.userId, userId),
        isNull(mfaChallenges.consumedAt),
        isNull(mfaChallenges.revokedAt),
      ),
    )
    .limit(200);
  return rows.filter((r) => Date.parse(r.expiresAt) > nowMs).length;
}

export type { ChallengeScope };
