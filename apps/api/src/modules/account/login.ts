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
  type LockoutOverrides,
  type LockoutState,
} from "./lockout.js";
import {
  effectivePolicyForEmail,
  evaluateIpAccess,
  loadUserPolicies,
  PLATFORM_DEFAULT_POLICY,
  type ResolvedSecurityPolicy,
} from "./policy.js";
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
  overrides?: LockoutOverrides,
): Promise<LoginGate> {
  const ctx = requestContext(req);
  const account = await accountLockout(app.db, app.appConfig, email, nowMs, overrides);
  const ip = await ipLockout(app.db, app.appConfig, ctx.ip, nowMs, overrides);
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
  input: {
    email: string;
    userId?: string | null;
    reason?: string;
    overrides?: LockoutOverrides;
  },
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
  const state = await accountLockout(app.db, app.appConfig, input.email, nowMs, input.overrides);
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
    /** resolved tenant policy; its absolute lifetime bounds the session */
    policy?: ResolvedSecurityPolicy;
    mfaSatisfied?: boolean;
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
    // #23 — the tenant's absolute session lifetime, not only the platform's.
    absoluteTtlHours: input.policy?.sessionAbsoluteTimeoutHours,
    mfaSatisfied: input.mfaSatisfied ?? false,
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

/* ------------------------------------------------------------------ */
/* #24 — the tenant IP allowlist, applied at sign-in                   */
/* ------------------------------------------------------------------ */

export interface LoginIpVerdict {
  allowed: boolean;
  /** companies whose allowlist refused this address, for the trail */
  refusedBy: string[];
  /** companies that would have refused it but are only monitoring */
  monitoredBy: string[];
  reason: string | null;
}

/**
 * Would this address be refused by EVERY company the account belongs to?
 *
 * The allowlist is a per-tenant control, so the authoritative enforcement
 * point is `requireCompany` — that is where a request names the tenant whose
 * data it wants. But a sign-in that cannot reach a single one of the holder's
 * tenants is not a sign-in, and letting it mint a session so that every
 * subsequent request can be refused individually is a worse experience and a
 * worse trail: one `login_blocked_ip` row says what happened; forty 403s do
 * not.
 *
 * So: refuse the LOGIN only when every membership refuses. Where one tenant
 * allows the address and another does not, the session is issued and the
 * strict tenant refuses at `requireCompany`. An account with no memberships is
 * never refused here — there is no tenant to have an opinion.
 */
export async function evaluateLoginIpAccess(
  app: FastifyInstance,
  req: FastifyRequest,
  userId: string,
): Promise<LoginIpVerdict> {
  const ctx = requestContext(req);
  const policies = await loadUserPolicies(app.db, userId);
  if (policies.length === 0) {
    return { allowed: true, refusedBy: [], monitoredBy: [], reason: null };
  }
  const refusedBy: string[] = [];
  const monitoredBy: string[] = [];
  let allowedSomewhere = false;
  for (const policy of policies) {
    const verdict = evaluateIpAccess(policy, ctx.ip, userId);
    if (verdict.outside && verdict.mode === "enforce" && !verdict.breakGlass) {
      refusedBy.push(policy.companyId);
      continue;
    }
    if (verdict.outside && verdict.mode === "monitor") monitoredBy.push(policy.companyId);
    allowedSomewhere = true;
  }
  return {
    allowed: allowedSomewhere,
    refusedBy,
    monitoredBy,
    reason:
      allowedSomewhere || refusedBy.length === 0
        ? null
        : `Address ${ctx.ip ?? "(unknown)"} is outside the allowed ranges of every organisation this account belongs to.`,
  };
}

/**
 * Refuse a sign-in from an address no tenant of this account permits, and
 * record it. Returns silently when the address is acceptable somewhere.
 *
 * The refusal is a 403 with an explicit message rather than the uniform 401
 * every other refusal answers with, and that is deliberate: this one is not an
 * enumeration risk (it is only reachable AFTER a correct password) and a user
 * told "invalid credentials" when their password was right will reset it,
 * fail again, and call support. Naming the real reason is the kinder and the
 * cheaper answer.
 */
export async function guardLoginIpAllowlist(
  app: FastifyInstance,
  req: FastifyRequest,
  user: { id: string; email: string },
): Promise<void> {
  const verdict = await evaluateLoginIpAccess(app, req, user.id);
  const ctx = requestContext(req);
  if (verdict.monitoredBy.length > 0) {
    await recordAuthEvent(app.db, {
      kind: "login_blocked_ip",
      outcome: "pending",
      userId: user.id,
      email: user.email,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      reason: "Address outside the allowlist; the policy is in monitor mode so the sign-in was allowed.",
      metadata: { mode: "monitor", companies: verdict.monitoredBy },
    });
  }
  if (verdict.allowed) return;
  await recordAuthEvent(app.db, {
    kind: "login_blocked_ip",
    outcome: "blocked",
    userId: user.id,
    email: user.email,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    reason: verdict.reason,
    metadata: { mode: "enforce", companies: verdict.refusedBy },
  });
  throw new AppError(
    403,
    "Your organisation only permits sign-in from approved networks, and this address is not one " +
      "of them. Connect through the corporate network or VPN, or ask an administrator to add " +
      "this address to the allowlist.",
    { code: "ip_not_allowed", ip: ctx.ip },
  );
}

/** The resolved policy for an address, used by the login routes before the
 *  password is compared so that lockout thresholds are the tenant's own. */
export async function loginPolicyFor(
  app: FastifyInstance,
  email: string,
): Promise<ResolvedSecurityPolicy> {
  try {
    return await effectivePolicyForEmail(app.db, email);
  } catch {
    return { ...PLATFORM_DEFAULT_POLICY };
  }
}
