import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, isNotNull, isNull } from "drizzle-orm";
import { emailVerifications, users } from "@constructos/db";
import type { EmailVerificationPurpose } from "@constructos/shared";
import { buildAppUrl, renderVerifyEmail, type EmailDeliveryReport } from "../../lib/email.js";
import { newId } from "../../lib/ids.js";
import { badRequest, forbidden, unauthorized } from "../../lib/errors.js";
import { isExpired } from "../../lib/time.js";
import type { Db } from "../../lib/db.js";
import type { PreHandler } from "../../types.js";
import { dispatchEmail, emailTransportFor } from "./mailer.js";
import { recordAuthEvent } from "./events.js";
import { hashToken, mintToken } from "./tokens.js";
import type { RequestContext } from "./sessions.js";

/**
 * Proving an address, and what an unproven one may do.
 *
 * THE POLICY, stated once so it can be argued with. An unverified account may
 * READ everything its permissions allow and may change its own credentials. It
 * may NOT do the two things that reach outside the account:
 *
 *   1. send mail to other people (inviting a colleague), because an attacker
 *      who registers `accounts@yourclient.example` and immediately invites
 *      forty people has just used this platform as a spam relay with the
 *      customer's branding on it; and
 *   2. create an external obligation in someone else's name.
 *
 * WHEN THE GATE IS ACTIVE. Only when a transport is actually configured. A
 * verification wall in a deployment that cannot send verification email locks
 * every user out permanently, including the administrator who would fix it —
 * so the gate follows `transport.dispatches`, and says so in
 * `GET /account/verification` rather than failing mysteriously.
 *
 * There is no `users.email_verified_at` column (that table is not this
 * module's to change), so "verified" is derived: a consumed row in
 * `email_verifications` for the address the account currently holds. That is
 * also the more honest definition — it points at the evidence.
 */

/** How many verification messages one account may ask for per hour. */
export const VERIFICATION_MAX_PER_HOUR = 3;

export interface VerificationStatus {
  email: string;
  verified: boolean;
  verifiedAt: string | null;
  pending: { expiresAt: string; sentAt: string } | null;
}

export async function verificationStatus(
  db: Db,
  userId: string,
  email: string,
  nowMs = Date.now(),
): Promise<VerificationStatus> {
  const [consumed] = await db
    .select({ consumedAt: emailVerifications.consumedAt })
    .from(emailVerifications)
    .where(
      and(
        eq(emailVerifications.userId, userId),
        eq(emailVerifications.email, email),
        isNotNull(emailVerifications.consumedAt),
      ),
    )
    .orderBy(desc(emailVerifications.consumedAt))
    .limit(1);
  if (consumed?.consumedAt) {
    return { email, verified: true, verifiedAt: consumed.consumedAt, pending: null };
  }
  const [live] = await db
    .select({ expiresAt: emailVerifications.expiresAt, createdAt: emailVerifications.createdAt })
    .from(emailVerifications)
    .where(
      and(
        eq(emailVerifications.userId, userId),
        eq(emailVerifications.email, email),
        isNull(emailVerifications.consumedAt),
      ),
    )
    .orderBy(desc(emailVerifications.createdAt))
    .limit(1);
  const pending =
    live && !isExpired(live.expiresAt, nowMs)
      ? { expiresAt: live.expiresAt, sentAt: live.createdAt }
      : null;
  return { email, verified: false, verifiedAt: null, pending };
}

export interface VerificationSend {
  status: "sent" | "throttled";
  expiresAt: string | null;
  delivery: EmailDeliveryReport | null;
  /** returned ONLY when nothing was dispatched — never in a mailing deployment */
  verifyUrl: string | null;
  reasons: string[];
  retryAfterSeconds: number;
}

/**
 * Mint a verification token and send it.
 *
 * The raw token exists in the returned link and in the message; the row stores
 * `sha256(raw)` and `email_dispatches.body_preview` stores the body with the
 * link redacted. Nothing that can verify an address survives at rest.
 */
export async function startEmailVerification(
  app: FastifyInstance,
  ctx: RequestContext,
  input: {
    userId: string;
    email: string;
    name: string;
    purpose?: EmailVerificationPurpose;
    companyId?: string | null;
    nowMs?: number;
  },
): Promise<VerificationSend> {
  const nowMs = input.nowMs ?? Date.now();
  const hourAgo = new Date(nowMs - 3_600_000).toISOString();
  const recent = await app.db
    .select({ id: emailVerifications.id, createdAt: emailVerifications.createdAt })
    .from(emailVerifications)
    .where(
      and(
        eq(emailVerifications.userId, input.userId),
        gte(emailVerifications.createdAt, hourAgo),
      ),
    )
    .orderBy(desc(emailVerifications.createdAt));
  if (recent.length >= VERIFICATION_MAX_PER_HOUR) {
    const oldest = recent[recent.length - 1];
    const retryAt = oldest ? Date.parse(oldest.createdAt) + 3_600_000 : nowMs + 3_600_000;
    return {
      status: "throttled",
      expiresAt: null,
      delivery: null,
      verifyUrl: null,
      reasons: [
        `At most ${VERIFICATION_MAX_PER_HOUR} verification messages an hour. ` +
          "Check the address for an earlier one before asking again.",
      ],
      retryAfterSeconds: Math.max(1, Math.ceil((retryAt - nowMs) / 1000)),
    };
  }

  const token = mintToken();
  const expiresAt = new Date(
    nowMs + app.appConfig.EMAIL_VERIFICATION_TTL_HOURS * 3_600_000,
  ).toISOString();
  const id = newId("evf");
  await app.db.insert(emailVerifications).values({
    id,
    userId: input.userId,
    email: input.email,
    tokenHash: token.hash,
    purpose: input.purpose ?? "signup",
    expiresAt,
    requestedIp: ctx.ip,
    requestedUserAgent: ctx.userAgent,
  });

  const verifyUrl = buildAppUrl(app.appConfig.APP_BASE_URL, "/verify-email", {
    token: token.raw,
  });
  const rendered = renderVerifyEmail({
    name: input.name,
    verifyUrl,
    expiresInHours: app.appConfig.EMAIL_VERIFICATION_TTL_HOURS,
  });
  const outcome = await dispatchEmail(app, {
    message: { to: { email: input.email, name: input.name }, ...rendered },
    secrets: [token.raw],
    userId: input.userId,
    companyId: input.companyId ?? null,
    variables: { verifyUrl, expiresAt },
    relatedType: "email_verification",
    relatedId: id,
  });
  await app.db
    .update(emailVerifications)
    .set({ dispatchId: outcome.dispatchId })
    .where(eq(emailVerifications.id, id));
  await recordAuthEvent(app.db, {
    kind: "email_verification_sent",
    outcome: outcome.result.dispatched ? "success" : "pending",
    userId: input.userId,
    companyId: input.companyId ?? null,
    email: input.email,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    reason: outcome.result.reasons[0] ?? null,
    metadata: { dispatchId: outcome.dispatchId, purpose: input.purpose ?? "signup" },
  });

  return {
    status: "sent",
    expiresAt,
    delivery: outcome.report,
    // The link is handed back only when nothing was dispatched: without it a
    // no-transport deployment could never verify anybody. It goes to the
    // account holder's own response, and never once mail is really sent.
    verifyUrl: outcome.result.dispatched ? null : verifyUrl,
    reasons: outcome.result.reasons,
    retryAfterSeconds: 0,
  };
}

export interface VerificationConsumed {
  userId: string;
  email: string;
  purpose: string;
  /** true when this consumption actually moved `users.email` */
  emailChanged: boolean;
}

/**
 * Spend a verification token.
 *
 * Single use is enforced by a CONDITIONAL UPDATE (`where consumed_at is null`)
 * that returns the row it changed — not a read followed by a write, which lets
 * two simultaneous clicks both succeed.
 */
export async function consumeVerificationToken(
  app: FastifyInstance,
  rawToken: string,
  ctx: RequestContext,
  nowMs = Date.now(),
): Promise<VerificationConsumed> {
  const [row] = await app.db
    .select()
    .from(emailVerifications)
    .where(eq(emailVerifications.tokenHash, hashToken(rawToken)))
    .limit(1);
  if (!row) throw badRequest("This verification link is not valid.");
  if (row.consumedAt) throw badRequest("This verification link has already been used.");
  if (isExpired(row.expiresAt, nowMs)) {
    throw badRequest("This verification link has expired. Request a new one.");
  }

  const claimed = await app.db
    .update(emailVerifications)
    .set({ consumedAt: new Date(nowMs).toISOString(), consumedIp: ctx.ip })
    .where(and(eq(emailVerifications.id, row.id), isNull(emailVerifications.consumedAt)))
    .returning({ id: emailVerifications.id });
  if (claimed.length === 0) {
    throw badRequest("This verification link has already been used.");
  }

  await recordAuthEvent(app.db, {
    kind: "email_verified",
    userId: row.userId,
    email: row.email,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { purpose: row.purpose },
  });

  /*
   * `email_change` — the half that was missing.
   *
   * `EMAIL_VERIFICATION_PURPOSES` has carried this value since the table was
   * written, and the web page told the user "the address change on this
   * account is now in force" while this function only marked the row consumed.
   * Nothing minted such a token, so nothing broke; the moment one existed the
   * UI would have asserted a change that never happened. POST /account/email
   * now mints them, so this applies them.
   *
   * The uniqueness re-check is NOT redundant with the one in that route: an
   * address is free when the change is requested and can be taken before the
   * link is opened. Losing that race must not fail with a database constraint
   * — the token is already spent, and the user is entitled to be told why.
   */
  let emailChanged = false;
  if (row.purpose === "email_change") {
    const [taken] = await app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, row.email))
      .limit(1);
    if (taken && taken.id !== row.userId) {
      throw badRequest(
        "Another account claimed that address while this link was waiting to be opened. " +
          "The address on this account is unchanged; request the change again with a different address.",
      );
    }
    if (!taken) {
      const [before] = await app.db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, row.userId))
        .limit(1);
      await app.db
        .update(users)
        .set({ email: row.email, updatedAt: new Date(nowMs).toISOString() })
        .where(eq(users.id, row.userId));
      emailChanged = true;
      await recordAuthEvent(app.db, {
        kind: "email_changed",
        userId: row.userId,
        email: row.email,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        reason: `Address changed from ${before?.email ?? "(unknown)"} to ${row.email}`,
        metadata: { previousEmail: before?.email ?? null },
      });
      // Every other device keeps working — the credential did not change — but
      // the account holder is told, in the trail they can read, that the
      // recovery channel moved.
    }
  }
  return { userId: row.userId, email: row.email, purpose: row.purpose, emailChanged };
}

/**
 * The gate. Read the module header before changing what it refuses — the point
 * is that it refuses OUTBOUND actions, not the whole application.
 */
export function requireVerifiedEmail(app: FastifyInstance, action = "invite people"): PreHandler {
  return async (req) => {
    if (!req.user) throw unauthorized();
    if (!emailTransportFor(app).dispatches) return;
    const [row] = await app.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, req.user.id))
      .limit(1);
    if (!row) throw unauthorized("Unknown user");
    const status = await verificationStatus(app.db, req.user.id, row.email);
    if (!status.verified) {
      throw forbidden(
        `Confirm your email address before you ${action}. ` +
          "Ask for a new confirmation link at POST /api/v1/account/verification/resend.",
      );
    }
  };
}
