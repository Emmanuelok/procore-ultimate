import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { authSecurityEvents } from "@constructos/db";
import type { AuthEventKind } from "@constructos/shared";
import { epochMs } from "../../lib/time.js";
import type { Db } from "../../lib/db.js";

/**
 * Brute-force resistance, derived from the security trail rather than stored.
 *
 * WHY NO COUNTER COLUMN. `users` has no `failed_attempts` / `locked_until`
 * pair and this module does not own that table — but the important reason is
 * that a counter is a second source of truth. `auth_security_events` already
 * records every attempt with its address, its IP and its outcome, so the lock
 * is a FUNCTION of the trail: idempotent, reconstructible after the fact, and
 * impossible to have "reset" without an audit row explaining it.
 *
 * TWO SCOPES, because they defend against different attacks:
 *   - per ACCOUNT: someone guessing one person's password. Success resets the
 *     counter, because a legitimate owner did prove themselves.
 *   - per IP: someone spraying one common password across many accounts. A
 *     success does NOT reset this one — the sprayer owns an account too, and
 *     would otherwise clear their own record every few attempts.
 *
 * WHAT THE CALLER MUST NOT DO with the result: reveal it selectively. A locked
 * account and a locked-out unknown address answer identically, or the lockout
 * becomes the enumeration oracle the login response was careful not to be.
 *
 * THE OPERATIONAL CAVEAT, stated because it bites in production and not in a
 * test: the IP scope is only as meaningful as `req.ip`. Behind a load balancer
 * with TRUST_PROXY unset, every request arrives from the proxy's address, so a
 * spray from anywhere would throttle sign-in for EVERYONE behind it. The
 * threshold is set at four times the per-account limit to make that unlikely
 * rather than routine, and the refusal names its scope (`details.scope: "ip"`,
 * and `scope` in the `login_blocked_locked` event) so an operator can see in
 * one query which of the two rules fired. Deployments behind a proxy should
 * set TRUST_PROXY=true — see config.ts.
 */

/** Events that end a run of failures for an ACCOUNT. */
const RESET_KINDS: AuthEventKind[] = [
  "login_success",
  "account_unlocked",
  "password_changed",
  "password_reset_completed",
];

const FAILURE_KIND: AuthEventKind = "login_failure";

/** How much harder an IP has to work before it is throttled as a whole. */
export const IP_ATTEMPT_MULTIPLIER = 4;

export interface LockoutPolicy {
  maxAttempts: number;
  windowMs: number;
  lockoutMs: number;
}

export interface LockoutState {
  /** consecutive failures counted inside the window */
  failures: number;
  locked: boolean;
  lockedUntil: string | null;
  retryAfterSeconds: number;
  /** delay to apply before answering the NEXT failure, in ms */
  nextDelayMs: number;
}

export const UNLOCKED: LockoutState = {
  failures: 0,
  locked: false,
  lockedUntil: null,
  retryAfterSeconds: 0,
  nextDelayMs: 0,
};

/**
 * Progressive delay before a failed answer is returned.
 *
 * The first two failures answer immediately — real people mistype. From the
 * third the wait doubles, which costs a human nothing and costs a script
 * everything, and it is what makes the hard lock a last resort rather than the
 * only defence. `baseMs` is 0 under test: the delay is arithmetic, tested as
 * arithmetic, and adding real seconds to a test suite proves nothing.
 */
export function progressiveDelayMs(failures: number, baseMs: number, capMs = 4_000): number {
  if (baseMs <= 0 || failures < 3) return 0;
  return Math.min(capMs, baseMs * 2 ** (failures - 3));
}

export interface AttemptEvent {
  kind: string;
  at: string;
}

/**
 * Evaluate a lock from the trail.
 *
 * `events` must be newest-first, as the queries below return them. The pass
 * walks failures oldest-first over a SLIDING window: a lock is armed the
 * moment `maxAttempts` failures fall inside any `windowMs` span, expires
 * `lockoutMs` later, and takes its failures with it — so the attempt after a
 * lapsed lock gets a full allowance instead of being re-locked instantly.
 * Failures recorded while a lock was already active never count twice.
 *
 * The window is a span between failures, not a span before `now`: five
 * failures four seconds apart arm a lock even if the whole run happened
 * fourteen minutes ago, which is precisely the case a "failures in the last N
 * minutes" counter loses at the boundary — and the boundary is where a
 * patient attacker lives.
 */
export function evaluateLockout(
  events: readonly AttemptEvent[],
  policy: LockoutPolicy,
  nowMs: number,
  options: { resetOnSuccess?: boolean; delayBaseMs?: number } = {},
): LockoutState {
  const resetOnSuccess = options.resetOnSuccess ?? true;
  const horizon = nowMs - (policy.windowMs + policy.lockoutMs);

  const failures: number[] = [];
  for (const event of events) {
    // newest-first: a reset event ends the run we are counting
    if (resetOnSuccess && RESET_KINDS.includes(event.kind as AuthEventKind)) break;
    if (event.kind !== FAILURE_KIND) continue;
    const at = epochMs(event.at);
    if (at === null || at < horizon) continue;
    failures.push(at);
  }
  failures.reverse(); // oldest first

  let recent: number[] = [];
  let lockUntil = 0;
  for (const at of failures) {
    if (at <= lockUntil) continue;
    recent.push(at);
    while (recent.length > 0 && at - recent[0]! > policy.windowMs) recent.shift();
    if (recent.length >= policy.maxAttempts) {
      lockUntil = at + policy.lockoutMs;
      recent = [];
    }
  }
  while (recent.length > 0 && nowMs - recent[0]! > policy.windowMs) recent.shift();

  const locked = nowMs < lockUntil;
  const effectiveFailures = locked ? policy.maxAttempts : recent.length;
  return {
    failures: effectiveFailures,
    locked,
    lockedUntil: lockUntil > 0 ? new Date(lockUntil).toISOString() : null,
    retryAfterSeconds: locked ? Math.ceil((lockUntil - nowMs) / 1000) : 0,
    nextDelayMs: progressiveDelayMs(effectiveFailures + 1, options.delayBaseMs ?? 0),
  };
}

async function loadEvents(
  db: Db,
  where: ReturnType<typeof and>,
  limit: number,
): Promise<AttemptEvent[]> {
  const rows = await db
    .select({ kind: authSecurityEvents.kind, at: authSecurityEvents.at })
    .from(authSecurityEvents)
    .where(where)
    .orderBy(desc(authSecurityEvents.at))
    .limit(limit);
  return rows;
}

export interface LockoutConfig {
  LOGIN_MAX_FAILED_ATTEMPTS: number;
  LOGIN_FAILURE_WINDOW_MINUTES: number;
  LOGIN_LOCKOUT_MINUTES: number;
  NODE_ENV: string;
}

export function accountPolicy(config: LockoutConfig): LockoutPolicy {
  return {
    maxAttempts: config.LOGIN_MAX_FAILED_ATTEMPTS,
    windowMs: config.LOGIN_FAILURE_WINDOW_MINUTES * 60_000,
    lockoutMs: config.LOGIN_LOCKOUT_MINUTES * 60_000,
  };
}

export function ipPolicy(config: LockoutConfig): LockoutPolicy {
  const base = accountPolicy(config);
  return { ...base, maxAttempts: base.maxAttempts * IP_ATTEMPT_MULTIPLIER };
}

/** Real deployments wait; the test suite does the arithmetic instead. */
export function delayBaseMs(config: Pick<LockoutConfig, "NODE_ENV">): number {
  return config.NODE_ENV === "test" ? 0 : 250;
}

export async function accountLockout(
  db: Db,
  config: LockoutConfig,
  email: string,
  nowMs = Date.now(),
): Promise<LockoutState> {
  const policy = accountPolicy(config);
  const horizon = new Date(nowMs - (policy.windowMs + policy.lockoutMs + 60_000)).toISOString();
  const events = await loadEvents(
    db,
    and(
      eq(authSecurityEvents.email, email),
      gte(authSecurityEvents.at, horizon),
      inArray(authSecurityEvents.kind, [FAILURE_KIND, ...RESET_KINDS]),
    ),
    100,
  );
  return evaluateLockout(events, policy, nowMs, {
    resetOnSuccess: true,
    delayBaseMs: delayBaseMs(config),
  });
}

export async function ipLockout(
  db: Db,
  config: LockoutConfig,
  ip: string | null,
  nowMs = Date.now(),
): Promise<LockoutState> {
  if (!ip) return UNLOCKED;
  const policy = ipPolicy(config);
  const horizon = new Date(nowMs - (policy.windowMs + policy.lockoutMs + 60_000)).toISOString();
  const events = await loadEvents(
    db,
    and(
      eq(authSecurityEvents.ip, ip),
      gte(authSecurityEvents.at, horizon),
      eq(authSecurityEvents.kind, FAILURE_KIND),
    ),
    400,
  );
  // No reset-on-success: an attacker spraying from one address usually holds a
  // valid account of their own, and would clear the counter with it.
  return evaluateLockout(events, policy, nowMs, {
    resetOnSuccess: false,
    delayBaseMs: delayBaseMs(config),
  });
}

/** The one message both scopes answer with. It names no account. */
export function lockoutMessage(state: LockoutState): string {
  const minutes = Math.max(1, Math.ceil(state.retryAfterSeconds / 60));
  return (
    `Too many failed sign-in attempts. Try again in ${minutes} minute` +
    `${minutes === 1 ? "" : "s"}, or reset your password.`
  );
}
