import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { passwordResets, users } from "@constructos/db";
import { buildAppUrl, renderPasswordReset } from "../../lib/email.js";
import { newId } from "../../lib/ids.js";
import { badRequest } from "../../lib/errors.js";
import { isExpired } from "../../lib/time.js";
import { dispatchEmail } from "./mailer.js";
import { recordAuthEvent, recordLegacyAuthEvent } from "./events.js";
import { assessPassword, hashPassword } from "./password.js";
import { revokeAllUserSessions, type RequestContext } from "./sessions.js";
import { hashToken, mintToken } from "./tokens.js";

/**
 * Password reset — the flow an attacker attacks.
 *
 * FOUR RULES, all of them load-bearing:
 *
 *  1. THE ANSWER NEVER DEPENDS ON WHETHER THE ACCOUNT EXISTS. Same status,
 *     same body, same fields, whether the address is a customer, a typo or a
 *     probe. Everything that could differ — "we sent it", a delivery report
 *     for this particular message, a rate-limit refusal — is therefore kept
 *     out of the response. What the response DOES say is whether this
 *     deployment has a mail transport at all, which is a property of the
 *     server and identical for every address.
 *
 *  2. THE LINK IS NEVER RETURNED. Unlike an invitation, which an administrator
 *     may legitimately pass to a colleague by hand, a reset link is a
 *     take-over of somebody else's account. In a deployment with no transport,
 *     reset is honestly UNAVAILABLE rather than quietly handing the link to
 *     whoever asked. `email_dispatches.body_preview` stores the body with the
 *     token redacted, so it is not recoverable from the database either.
 *
 *  3. ONE LIVE TOKEN. A new request sets `invalidated_at` on the old rows, so
 *     an old link mailed to an old inbox cannot be used later.
 *
 *  4. COMPLETION DESTROYS EVERY SESSION AND EVERY REFRESH TOKEN. A reset is
 *     the moment at which you must assume the attacker already holds one.
 */

/** How many reset messages one address may cause in an hour. */
export const RESET_MAX_PER_HOUR = 3;

export interface ResetRequestOutcome {
  /** what actually happened — for the trail and tests, never for the response */
  outcome: "sent" | "throttled" | "unknown_address" | "inactive";
  dispatchId: string | null;
}

export async function requestPasswordReset(
  app: FastifyInstance,
  ctx: RequestContext,
  email: string,
  nowMs = Date.now(),
): Promise<ResetRequestOutcome> {
  const [user] = await app.db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || !user.isActive) {
    // Recorded, because "someone asked to reset an address that has no
    // account" is exactly the kind of probing an investigation looks for.
    await recordAuthEvent(app.db, {
      kind: "password_reset_requested",
      outcome: "failure",
      email,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      reason: user ? "account_inactive" : "unknown_address",
    });
    return { outcome: user ? "inactive" : "unknown_address", dispatchId: null };
  }

  const hourAgo = new Date(nowMs - 3_600_000).toISOString();
  const recent = await app.db
    .select({ id: passwordResets.id })
    .from(passwordResets)
    .where(and(eq(passwordResets.email, email), gte(passwordResets.createdAt, hourAgo)))
    .orderBy(desc(passwordResets.createdAt));
  if (recent.length >= RESET_MAX_PER_HOUR) {
    // Silently: a 429 here would tell an attacker which addresses are worth
    // hammering. The trail records it; the caller answers as it always does.
    await recordAuthEvent(app.db, {
      kind: "password_reset_requested",
      outcome: "blocked",
      userId: user.id,
      email,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      reason: "rate_limited",
      metadata: { perHour: RESET_MAX_PER_HOUR },
    });
    return { outcome: "throttled", dispatchId: null };
  }

  await app.db
    .update(passwordResets)
    .set({ invalidatedAt: new Date(nowMs).toISOString() })
    .where(
      and(
        eq(passwordResets.userId, user.id),
        isNull(passwordResets.consumedAt),
        isNull(passwordResets.invalidatedAt),
      ),
    );

  const token = mintToken();
  const expiresAt = new Date(
    nowMs + app.appConfig.PASSWORD_RESET_TTL_MINUTES * 60_000,
  ).toISOString();
  const id = newId("pwr");
  await app.db.insert(passwordResets).values({
    id,
    userId: user.id,
    email,
    tokenHash: token.hash,
    expiresAt,
    requestedIp: ctx.ip,
    requestedUserAgent: ctx.userAgent,
  });

  const resetUrl = buildAppUrl(app.appConfig.APP_BASE_URL, "/reset-password", {
    token: token.raw,
  });
  const rendered = renderPasswordReset({
    name: user.name,
    resetUrl,
    expiresInMinutes: app.appConfig.PASSWORD_RESET_TTL_MINUTES,
    requestIp: ctx.ip,
  });
  const dispatched = await dispatchEmail(app, {
    message: { to: { email: user.email, name: user.name }, ...rendered },
    secrets: [token.raw],
    userId: user.id,
    variables: { expiresAt, requestIp: ctx.ip },
    relatedType: "password_reset",
    relatedId: id,
  });
  await app.db
    .update(passwordResets)
    .set({ dispatchId: dispatched.dispatchId })
    .where(eq(passwordResets.id, id));

  await recordAuthEvent(app.db, {
    kind: "password_reset_requested",
    outcome: dispatched.result.dispatched ? "success" : "pending",
    userId: user.id,
    email,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    reason: dispatched.result.reasons[0] ?? null,
    metadata: { dispatchId: dispatched.dispatchId },
  });
  return { outcome: "sent", dispatchId: dispatched.dispatchId };
}

export interface ResetCompletion {
  userId: string;
  email: string;
  sessionsRevoked: number;
}

export async function completePasswordReset(
  app: FastifyInstance,
  ctx: RequestContext,
  input: { token: string; password: string },
  nowMs = Date.now(),
): Promise<ResetCompletion> {
  const invalid = () =>
    badRequest("This password reset link is not valid, has expired, or has already been used.");

  const [row] = await app.db
    .select()
    .from(passwordResets)
    .where(eq(passwordResets.tokenHash, hashToken(input.token)))
    .limit(1);
  if (!row || row.consumedAt || row.invalidatedAt || isExpired(row.expiresAt, nowMs)) {
    await recordAuthEvent(app.db, {
      kind: "password_reset_completed",
      outcome: "failure",
      userId: row?.userId ?? null,
      email: row?.email ?? null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      reason: !row
        ? "unknown_token"
        : row.consumedAt
          ? "token_already_used"
          : row.invalidatedAt
            ? "token_superseded"
            : "token_expired",
    });
    throw invalid();
  }

  const [user] = await app.db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!user || !user.isActive) throw invalid();

  const assessment = assessPassword(input.password, { email: user.email, name: user.name });
  if (!assessment.ok) {
    // Checked BEFORE the token is spent: a rejected password must not cost the
    // user their only link.
    throw badRequest("Password does not meet the password policy.", {
      reasons: assessment.reasons,
    });
  }

  const claimed = await app.db
    .update(passwordResets)
    .set({ consumedAt: new Date(nowMs).toISOString(), consumedIp: ctx.ip })
    .where(
      and(
        eq(passwordResets.id, row.id),
        isNull(passwordResets.consumedAt),
        isNull(passwordResets.invalidatedAt),
      ),
    )
    .returning({ id: passwordResets.id });
  if (claimed.length === 0) throw invalid();

  await app.db
    .update(users)
    .set({
      passwordHash: await hashPassword(app.appConfig, input.password),
      updatedAt: new Date(nowMs).toISOString(),
    })
    .where(eq(users.id, user.id));

  const sessionsRevoked = await revokeAllUserSessions(app.db, user.id, {
    reason: "password_changed",
    byUser: true,
    actorId: user.id,
    includeOrphanTokens: true,
    nowMs,
  });

  await recordAuthEvent(app.db, {
    kind: "password_reset_completed",
    userId: user.id,
    email: user.email,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { sessionsRevoked },
  });
  await recordLegacyAuthEvent(app.db, {
    userId: user.id,
    email: user.email,
    kind: "password_change",
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  return { userId: user.id, email: user.email, sessionsRevoked };
}
