import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { users } from "@constructos/db";
import { AppError } from "../../lib/errors.js";
import { buildAppUrl, renderNewDeviceSignIn } from "../../lib/email.js";
import { dispatchEmail } from "./mailer.js";
import { recordAuthEvent } from "./events.js";
import {
  accountLockout,
  delayBaseMs,
  ipLockout,
  lockoutMessage,
  progressiveDelayMs,
  type LockoutState,
} from "./lockout.js";
import { hashPassword, needsRehash, passwordHashCost } from "./password.js";
import { issueUserSession, requestContext, type IssuedSession } from "./sessions.js";

/**
 * What the identity module's `POST /auth/login` needs in order to be a
 * defensible sign-in, kept OUT of that module so the change there stays three
 * calls wide.
 *
 * Everything here is written so that the two branches — this address exists,
 * this address does not — are indistinguishable from outside: the same lock,
 * the same message, the same status code, and (via `equalizeVerifyTiming` in
 * password.ts) roughly the same amount of time spent.
 */

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export function tooManyRequests(message: string, details?: unknown): AppError {
  return new AppError(429, message, details);
}

export interface LoginGate {
  account: LockoutState;
  ip: LockoutState;
}

/**
 * Refuse an attempt that is already locked out, before the password is even
 * looked at.
 *
 * Deliberately identical for an address with an account and an address
 * without: the counter is keyed on what was TYPED, so a locked-out attacker
 * learns only that they are locked out. Recording `login_blocked_locked`
 * separately from `login_failure` keeps the security dashboard honest — a
 * refusal by policy is not evidence of another guess.
 */
export async function guardLoginAttempt(
  app: FastifyInstance,
  req: FastifyRequest,
  email: string,
  nowMs = Date.now(),
): Promise<LoginGate> {
  const ctx = requestContext(req);
  const account = await accountLockout(app.db, app.appConfig, email, nowMs);
  const ip = await ipLockout(app.db, app.appConfig, ctx.ip, nowMs);
  const blocked = account.locked ? account : ip.locked ? ip : null;
  if (blocked) {
    await recordAuthEvent(app.db, {
      kind: "login_blocked_locked",
      outcome: "blocked",
      email,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      reason: account.locked ? "account_locked" : "ip_locked",
      metadata: {
        scope: account.locked ? "account" : "ip",
        lockedUntil: blocked.lockedUntil,
      },
    });
    throw tooManyRequests(lockoutMessage(blocked), {
      retryAfterSeconds: blocked.retryAfterSeconds,
      scope: account.locked ? "account" : "ip",
    });
  }
  return { account, ip };
}

/**
 * Record a failed attempt, arm the lock if this was the one that crossed the
 * threshold, and pay the progressive delay before the caller answers 401.
 */
export async function noteLoginFailure(
  app: FastifyInstance,
  req: FastifyRequest,
  input: { email: string; userId?: string | null; reason?: string },
  nowMs = Date.now(),
): Promise<LockoutState> {
  const ctx = requestContext(req);
  await recordAuthEvent(app.db, {
    kind: "login_failure",
    outcome: "failure",
    userId: input.userId ?? null,
    email: input.email,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    reason: input.reason ?? "invalid_credentials",
  });
  const state = await accountLockout(app.db, app.appConfig, input.email, nowMs);
  if (state.locked) {
    await recordAuthEvent(app.db, {
      kind: "account_locked",
      outcome: "blocked",
      userId: input.userId ?? null,
      email: input.email,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      reason: "too_many_failed_attempts",
      metadata: { lockedUntil: state.lockedUntil, attempts: state.failures },
    });
  }
  await sleep(progressiveDelayMs(state.failures, delayBaseMs(app.appConfig)));
  return state;
}

export interface LoginCompletion extends IssuedSession {
  /** true when the stored hash was upgraded to the current work factor */
  rehashed: boolean;
}

/**
 * Everything that happens AFTER the password checked out.
 *
 * 1. TRANSPARENT REHASH. The work factor is encoded in each hash, so raising
 *    the platform's factor upgrades nobody by itself. Here — the one moment
 *    the plaintext is legitimately in hand — an old hash is rewritten at the
 *    current cost. Existing users are upgraded silently; nobody is forced to
 *    reset. A failed rehash is swallowed: a slow disk must not cost a correct
 *    sign-in.
 * 2. THE SESSION ROW, so the sign-in is a device that can be listed and
 *    revoked rather than an anonymous token.
 * 3. THE TRAIL, and a message to the account holder when the device is one
 *    this account has not been seen on before.
 */
export async function completeLogin(
  app: FastifyInstance,
  req: FastifyRequest,
  input: {
    user: { id: string; email: string; name: string; passwordHash: string };
    password: string;
    companyId?: string | null;
    authMethod?: "password" | "invitation";
  },
): Promise<LoginCompletion> {
  const ctx = requestContext(req);
  const cost = passwordHashCost(app.appConfig);
  let rehashed = false;
  if (needsRehash(input.user.passwordHash, cost)) {
    try {
      const upgraded = await hashPassword(app.appConfig, input.password);
      await app.db
        .update(users)
        .set({ passwordHash: upgraded, updatedAt: new Date().toISOString() })
        .where(eq(users.id, input.user.id));
      rehashed = true;
    } catch {
      /* an upgrade that fails leaves a working, older hash in place */
    }
  }

  const issued = await issueUserSession(app, ctx, {
    user: input.user,
    authMethod: input.authMethod ?? "password",
    companyId: input.companyId ?? null,
  });

  await recordAuthEvent(app.db, {
    kind: "login_success",
    userId: input.user.id,
    email: input.user.email,
    sessionId: issued.sessionId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { rehashed, newDevice: issued.isNewDevice, authMethod: issued.session.authMethod },
  });

  if (issued.isNewDevice) {
    await notifyNewDevice(app, {
      user: input.user,
      sessionId: issued.sessionId,
      deviceLabel: issued.session.deviceLabel,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  return { ...issued, rehashed };
}

/**
 * Tell the account holder about a sign-in from a device this account has not
 * been seen on. Best effort by design: a message that cannot be sent is
 * recorded as not dispatched, and the sign-in still succeeds — refusing a
 * correct login because the mail provider is down would be the wrong trade.
 */
export async function notifyNewDevice(
  app: FastifyInstance,
  input: {
    user: { id: string; email: string; name: string };
    sessionId: string;
    deviceLabel: string | null;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<void> {
  const at = new Date().toISOString();
  const securityUrl = buildAppUrl(app.appConfig.APP_BASE_URL, "/account/security");
  const rendered = renderNewDeviceSignIn({
    name: input.user.name,
    deviceLabel: input.deviceLabel ?? "an unrecognised device",
    ip: input.ip ?? "an unknown address",
    at,
    // location is never guessed — see the template.
    location: null,
    securityUrl,
  });
  const outcome = await dispatchEmail(app, {
    message: { to: { email: input.user.email, name: input.user.name }, ...rendered },
    userId: input.user.id,
    variables: { deviceLabel: input.deviceLabel, ip: input.ip, at },
    relatedType: "auth_session",
    relatedId: input.sessionId,
  });
  await recordAuthEvent(app.db, {
    kind: "new_device_sign_in",
    outcome: outcome.result.dispatched ? "success" : "pending",
    userId: input.user.id,
    email: input.user.email,
    sessionId: input.sessionId,
    ip: input.ip,
    userAgent: input.userAgent,
    reason: outcome.result.reasons[0] ?? null,
    metadata: { dispatchId: outcome.dispatchId, deviceLabel: input.deviceLabel },
  });
}
