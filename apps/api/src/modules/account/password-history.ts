import bcrypt from "bcryptjs";
import { and, desc, eq, inArray } from "drizzle-orm";
import { passwordHistory } from "@constructos/db";
import type { PasswordHistoryReason } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import type { Db } from "../../lib/db.js";

/**
 * Password reuse refusal (spec #25).
 *
 * WHY A TABLE. `users.password_hash` holds one hash, so "you have used this
 * before" is unanswerable without retaining the ones it replaced. The row
 * holds a HASH, never a password, so the retention adds no plaintext to the
 * platform and a reuse check is N bcrypt comparisons — which is why N is a
 * tenant setting with a hard ceiling rather than "all of them".
 *
 * WHAT IS DELIBERATELY NOT DONE: comparing the new password against other
 * users' hashes, or storing a fast digest to make the check cheap. A fast
 * digest of a password is a password cracker's dream, and the whole point of
 * bcrypt is that this check is slow.
 */

/** Comparing against more than this many old hashes is a denial of service on
 *  ourselves: each one is a full bcrypt verification. */
export const MAX_HISTORY_DEPTH = 24;

export function clampDepth(depth: number | null | undefined): number {
  if (!depth || depth <= 0) return 0;
  return Math.min(MAX_HISTORY_DEPTH, Math.floor(depth));
}

/**
 * Retain the hash that is being replaced.
 *
 * Called with the OLD hash, at the moment it stops being current. Trimming
 * happens here too: a tenant that lowers its depth stops retaining what it no
 * longer needs, on the next change rather than never.
 */
export async function recordPasswordHistory(
  db: Db,
  userId: string,
  previousHash: string,
  reason: PasswordHistoryReason,
  keepDepth: number,
): Promise<void> {
  const depth = clampDepth(keepDepth);
  if (depth === 0) {
    // Nothing to enforce, so nothing to retain: keeping hashes a tenant has
    // asked nobody to check would be retention for its own sake.
    await db.delete(passwordHistory).where(eq(passwordHistory.userId, userId));
    return;
  }
  try {
    await db.insert(passwordHistory).values({
      id: newId("pwh"),
      userId,
      passwordHash: previousHash,
      reason,
    });
  } catch {
    /* history is a policy aid, never the reason a password change fails */
    return;
  }
  const rows = await db
    .select({ id: passwordHistory.id })
    .from(passwordHistory)
    .where(eq(passwordHistory.userId, userId))
    .orderBy(desc(passwordHistory.createdAt));
  const surplus = rows.slice(depth).map((r) => r.id);
  if (surplus.length > 0) {
    await db.delete(passwordHistory).where(inArray(passwordHistory.id, surplus));
  }
}

export interface ReuseVerdict {
  reused: boolean;
  /** how many old hashes were actually compared */
  checked: number;
  reason: string | null;
}

/**
 * Was this password one of the last `depth`?
 *
 * The CURRENT hash is passed separately and always checked when a depth is
 * set: "my new password is my old password" is the case users actually try,
 * and it never reaches the history table because the current hash has not
 * been retired yet.
 */
export async function isPasswordReused(
  db: Db,
  userId: string,
  candidate: string,
  depth: number,
  currentHash?: string | null,
): Promise<ReuseVerdict> {
  const keep = clampDepth(depth);
  if (keep === 0) return { reused: false, checked: 0, reason: null };
  let checked = 0;
  if (currentHash) {
    checked += 1;
    if (await compare(candidate, currentHash)) {
      return {
        reused: true,
        checked,
        reason: "That is your current password.",
      };
    }
  }
  const rows = await db
    .select({ hash: passwordHistory.passwordHash })
    .from(passwordHistory)
    .where(eq(passwordHistory.userId, userId))
    .orderBy(desc(passwordHistory.createdAt))
    .limit(keep);
  for (const row of rows) {
    checked += 1;
    if (await compare(candidate, row.hash)) {
      return {
        reused: true,
        checked,
        reason: `Your organisation refuses the last ${keep} password${keep === 1 ? "" : "s"} you have used.`,
      };
    }
  }
  return { reused: false, checked, reason: null };
}

/** How many hashes are retained for this user right now. */
export async function historyDepthFor(db: Db, userId: string): Promise<number> {
  const rows = await db
    .select({ id: passwordHistory.id })
    .from(passwordHistory)
    .where(eq(passwordHistory.userId, userId));
  return rows.length;
}

/** Purge one user's retained hashes — used when an account is erased. */
export async function clearPasswordHistory(db: Db, userId: string): Promise<void> {
  await db.delete(passwordHistory).where(and(eq(passwordHistory.userId, userId)));
}

async function compare(candidate: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(candidate, hash);
  } catch {
    // An SSO-only sentinel, or a hash from a cost bcryptjs cannot parse. It is
    // not a match, and it is not an error either.
    return false;
  }
}
