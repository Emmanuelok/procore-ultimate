import { createHash } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  authSecurityEvents,
  authSessions,
  companies,
  companyMemberships,
  mfaRecoveryCodes,
  refreshTokens,
  userMfa,
} from "@constructos/db";
import type {
  AuthEventKind,
  AuthEventOutcome,
  AuthMethod,
  LedgerAction,
} from "@constructos/shared";
import { sha256Hex } from "@constructos/ledger";
import { AppError, unauthorized } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { epochMs, isExpired } from "../../lib/time.js";
import type { Db } from "../../lib/db.js";
import { signSessionAccessToken } from "../account/sessions.js";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  deriveKey,
  KEY_PURPOSE,
  openSecret,
} from "./secrets.js";
import { base32Decode, isTotpAlgorithm, verifyTotp, type TotpAlgorithm } from "./totp.js";

/**
 * Everything stateful about a second factor: what is enrolled, whether it is
 * locked, whether the code just presented has already been spent, and what the
 * account-security trail is told about it.
 *
 * The pure arithmetic is in totp.ts and the key handling in secrets.ts; this
 * file is where those meet the database, and it holds the three rules the
 * schema comments insist on:
 *
 *  - a `pending` enrolment is NOT a second factor (`activeFactor` filters on
 *    `status = 'active'`, and nothing else in the module reads a factor for
 *    challenge purposes);
 *  - `last_used_step` advances on every acceptance, so a code observed on the
 *    wire cannot be replayed inside its own step;
 *  - MFA lockout is counted on `user_mfa`, entirely separately from the login
 *    limiter in the identity module, so throttling second-factor guesses never
 *    depends on how the first factor was throttled.
 */

export type MfaFactor = typeof userMfa.$inferSelect;

/** The window the platform accepts either side of the current step: exactly 1. */
export const TOTP_WINDOW = 1;

/* ------------------------------------------------------------------ */
/* The account-security trail                                          */
/* ------------------------------------------------------------------ */

export interface SecurityEventInput {
  kind: AuthEventKind;
  outcome?: AuthEventOutcome;
  userId?: string | null;
  companyId?: string | null;
  email?: string | null;
  sessionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append to `auth_security_events` (NOT `auth_events` — see the schema header:
 * the old thin table is left alone and nothing new writes to it).
 *
 * Never throws into the caller. A security record that cannot be written must
 * not turn a correct sign-in into a 500; the failure surfaces in the request
 * log and the route completes.
 */
export async function recordSecurityEvent(db: Db, input: SecurityEventInput): Promise<void> {
  try {
    await db.insert(authSecurityEvents).values({
      id: newId("ase"),
      companyId: input.companyId ?? null,
      userId: input.userId ?? null,
      email: input.email ?? null,
      kind: input.kind,
      outcome: input.outcome ?? "success",
      sessionId: input.sessionId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      reason: input.reason ?? null,
      // Deliberately no code, no seed, no token: the schema says this column
      // must not carry a credential, and the one place that could break the
      // rule is a well-meant "what did they type" debug field.
      metadata: input.metadata ?? {},
    });
  } catch {
    /* trail write must never fail the request it describes */
  }
}

export function requestContext(req: FastifyRequest): { ip: string | null; userAgent: string | null } {
  const ua = req.headers["user-agent"];
  return { ip: req.ip ?? null, userAgent: typeof ua === "string" ? ua : null };
}

/* ------------------------------------------------------------------ */
/* Reading a factor                                                    */
/* ------------------------------------------------------------------ */

export async function loadFactor(db: Db, userId: string): Promise<MfaFactor | null> {
  const rows = await db
    .select()
    .from(userMfa)
    .where(and(eq(userMfa.userId, userId), eq(userMfa.method, "totp")))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * A factor that can satisfy a challenge. `pending` and `disabled` cannot.
 *
 * Returns a plain boolean rather than a type predicate on purpose: a predicate
 * would narrow the FALSE branch to `null`, and the false branch here is
 * "pending or disabled factor", which callers legitimately need to read.
 */
export function isActive(factor: MfaFactor | null): boolean {
  return factor !== null && factor.status === "active" && factor.secretCiphertext !== null;
}

export async function activeFactor(db: Db, userId: string): Promise<MfaFactor | null> {
  const factor = await loadFactor(db, userId);
  return isActive(factor) ? factor : null;
}

export function factorParams(factor: MfaFactor, config: KeyConfig) {
  if (!factor.secretCiphertext) throw new Error("MFA factor has no stored seed");
  const key = deriveKey(config, KEY_PURPOSE.totpSeed);
  const base32 = openSecret(factor.secretCiphertext, key);
  const algorithm: TotpAlgorithm = isTotpAlgorithm(factor.algorithm) ? factor.algorithm : "SHA1";
  return {
    secret: base32Decode(base32),
    algorithm,
    digits: factor.digits,
    periodSeconds: factor.periodSeconds,
  };
}

export interface KeyConfig {
  AUTH_SECRET: string;
  SSO_ENCRYPTION_KEY?: string | undefined;
}

/* ------------------------------------------------------------------ */
/* Lockout — counted on the factor, independent of the login limiter    */
/* ------------------------------------------------------------------ */

export interface LockState {
  locked: boolean;
  lockedUntil: string | null;
  retryAfterSeconds: number;
}

export function lockState(factor: MfaFactor, nowMs = Date.now()): LockState {
  const until = factor.lockedUntil;
  if (!until || isExpired(until, nowMs)) {
    return { locked: false, lockedUntil: null, retryAfterSeconds: 0 };
  }
  const at = epochMs(until) ?? nowMs;
  return {
    locked: true,
    lockedUntil: new Date(at).toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil((at - nowMs) / 1000)),
  };
}

/**
 * Lazy, idempotent sweep of an elapsed lock (there is no cron on this
 * platform). Called on the status read and before every attempt: once the lock
 * has passed, the row is cleared so the next reader sees an unlocked factor
 * rather than re-deriving "expired, therefore fine" for ever.
 */
export async function sweepExpiredLock(
  db: Db,
  factor: MfaFactor,
  nowMs = Date.now(),
): Promise<MfaFactor> {
  if (!factor.lockedUntil || !isExpired(factor.lockedUntil, nowMs)) return factor;
  await db
    .update(userMfa)
    .set({ lockedUntil: null, failedAttempts: 0, updatedAt: new Date(nowMs).toISOString() })
    .where(and(eq(userMfa.id, factor.id), eq(userMfa.lockedUntil, factor.lockedUntil)));
  return { ...factor, lockedUntil: null, failedAttempts: 0 };
}

export interface LockoutConfig {
  MFA_MAX_FAILED_ATTEMPTS: number;
  MFA_LOCKOUT_MINUTES: number;
}

/** Count one failure and, at the threshold, apply the lock. */
export async function registerFailure(
  db: Db,
  factor: MfaFactor,
  config: LockoutConfig,
  nowMs = Date.now(),
): Promise<LockState> {
  const nowIso = new Date(nowMs).toISOString();
  // Incremented in SQL rather than read-then-write: two concurrent guesses
  // must both be counted, and a read-modify-write loses one of them, which is
  // precisely the race a brute-forcer creates on purpose.
  const updated = await db
    .update(userMfa)
    .set({ failedAttempts: sql`${userMfa.failedAttempts} + 1`, updatedAt: nowIso })
    .where(eq(userMfa.id, factor.id))
    .returning({ failedAttempts: userMfa.failedAttempts });
  const attempts = updated[0]?.failedAttempts ?? factor.failedAttempts + 1;
  if (attempts < Math.max(1, config.MFA_MAX_FAILED_ATTEMPTS)) {
    return { locked: false, lockedUntil: null, retryAfterSeconds: 0 };
  }
  const until = new Date(nowMs + Math.max(1, config.MFA_LOCKOUT_MINUTES) * 60_000).toISOString();
  // The counter resets with the lock so the budget after it expires is a full
  // one; the lock itself is the punishment, not a permanently poisoned count.
  await db
    .update(userMfa)
    .set({ lockedUntil: until, failedAttempts: 0, updatedAt: nowIso })
    .where(eq(userMfa.id, factor.id));
  return {
    locked: true,
    lockedUntil: until,
    retryAfterSeconds: Math.max(1, config.MFA_LOCKOUT_MINUTES) * 60,
  };
}

export async function registerSuccess(
  db: Db,
  factor: MfaFactor,
  step: number | null,
  nowMs = Date.now(),
): Promise<void> {
  const nowIso = new Date(nowMs).toISOString();
  await db
    .update(userMfa)
    .set({
      lastUsedAt: nowIso,
      // The high-water mark only ever moves forward. A code from an earlier
      // step must not be able to lower the bar for the next attempt.
      lastUsedStep:
        step === null ? factor.lastUsedStep : Math.max(step, factor.lastUsedStep ?? -1),
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: nowIso,
    })
    .where(eq(userMfa.id, factor.id));
}

/* ------------------------------------------------------------------ */
/* Recovery codes                                                      */
/* ------------------------------------------------------------------ */

export async function countRecoveryCodes(db: Db, userId: string, mfaId: string): Promise<number> {
  const rows = await db
    .select({ id: mfaRecoveryCodes.id })
    .from(mfaRecoveryCodes)
    .where(
      and(
        eq(mfaRecoveryCodes.userId, userId),
        eq(mfaRecoveryCodes.mfaId, mfaId),
        isNull(mfaRecoveryCodes.usedAt),
        isNull(mfaRecoveryCodes.revokedAt),
      ),
    );
  return rows.length;
}

export interface IssuedRecoveryCodes {
  batchId: string;
  codes: string[];
  remaining: number;
}

/**
 * Issue a batch, revoking every earlier one first.
 *
 * Revocation is a single UPDATE over the user's live codes rather than a
 * per-batch loop: regenerating must invalidate EVERY previously printed code,
 * including any from a batch this process never saw.
 */
export async function issueRecoveryCodes(
  db: Db,
  args: { userId: string; mfaId: string; count: number; nowMs?: number },
): Promise<IssuedRecoveryCodes> {
  const nowIso = new Date(args.nowMs ?? Date.now()).toISOString();
  await db
    .update(mfaRecoveryCodes)
    .set({ revokedAt: nowIso })
    .where(
      and(
        eq(mfaRecoveryCodes.userId, args.userId),
        isNull(mfaRecoveryCodes.usedAt),
        isNull(mfaRecoveryCodes.revokedAt),
      ),
    );
  const batchId = newId("mrb");
  const codes = generateRecoveryCodes(Math.max(1, args.count));
  await db.insert(mfaRecoveryCodes).values(
    codes.map((code) => ({
      id: newId("mrc"),
      userId: args.userId,
      mfaId: args.mfaId,
      codeHash: hashRecoveryCode(code),
      batchId,
    })),
  );
  return { batchId, codes, remaining: codes.length };
}

/** Revoke everything outstanding — used when a factor is disabled. */
export async function revokeAllRecoveryCodes(
  db: Db,
  userId: string,
  nowMs = Date.now(),
): Promise<void> {
  await db
    .update(mfaRecoveryCodes)
    .set({ revokedAt: new Date(nowMs).toISOString() })
    .where(
      and(
        eq(mfaRecoveryCodes.userId, userId),
        isNull(mfaRecoveryCodes.usedAt),
        isNull(mfaRecoveryCodes.revokedAt),
      ),
    );
}

/**
 * Spend one code, atomically.
 *
 * The conditional UPDATE (`… AND used_at IS NULL AND revoked_at IS NULL`) is
 * the whole point: two simultaneous presentations of the same code both match
 * the hash, but only one UPDATE can find the row still unused, so exactly one
 * returns a row and exactly one succeeds. Reading the row and then writing it
 * would let both through — the classic double-spend, and a recovery code is
 * the one credential where a double-spend is worth the most to an attacker.
 */
export async function consumeRecoveryCode(
  db: Db,
  args: { userId: string; mfaId: string; raw: string; ip?: string | null; nowMs?: number },
): Promise<boolean> {
  const normalized = normalizeRecoveryCode(args.raw);
  if (normalized.length === 0) return false;
  const nowIso = new Date(args.nowMs ?? Date.now()).toISOString();
  const updated = await db
    .update(mfaRecoveryCodes)
    .set({ usedAt: nowIso, usedIp: args.ip ?? null })
    .where(
      and(
        eq(mfaRecoveryCodes.codeHash, hashRecoveryCode(normalized)),
        eq(mfaRecoveryCodes.userId, args.userId),
        eq(mfaRecoveryCodes.mfaId, args.mfaId),
        isNull(mfaRecoveryCodes.usedAt),
        isNull(mfaRecoveryCodes.revokedAt),
      ),
    )
    .returning({ id: mfaRecoveryCodes.id });
  return updated.length > 0;
}

/* ------------------------------------------------------------------ */
/* Asserting the factor                                                */
/* ------------------------------------------------------------------ */

export interface AssertionInput {
  /** a TOTP code from the authenticator app */
  code?: string | undefined;
  /** a printed recovery code, used instead of the app */
  recoveryCode?: string | undefined;
}

export interface AssertionOutcome {
  method: "totp" | "recovery_code";
  step: number | null;
  recoveryCodesRemaining: number;
}

export interface AssertConfig extends KeyConfig, LockoutConfig {}

/**
 * Verify one presentation of a second factor and record what happened.
 *
 * Throws rather than returning a flag, because every caller's failure
 * behaviour is identical and a returned flag is the kind of thing a later edit
 * forgets to check. 429 when locked out (with `retryAfterSeconds`), 401
 * otherwise, and the reasons array always names which of the two it was.
 */
export async function assertFactor(
  db: Db,
  config: AssertConfig,
  factor: MfaFactor,
  input: AssertionInput,
  context: { ip?: string | null; userAgent?: string | null; purpose: string; companyId?: string | null },
  nowMs = Date.now(),
): Promise<AssertionOutcome> {
  const swept = await sweepExpiredLock(db, factor, nowMs);
  const lock = lockState(swept, nowMs);
  if (lock.locked) {
    await recordSecurityEvent(db, {
      kind: "mfa_challenge_failure",
      outcome: "blocked",
      userId: swept.userId,
      companyId: context.companyId ?? null,
      ip: context.ip,
      userAgent: context.userAgent,
      reason: `Second factor locked until ${lock.lockedUntil}`,
      metadata: { purpose: context.purpose, mfaId: swept.id },
    });
    throw new AppError(429, "Too many failed second-factor attempts. Try again later.", {
      reasons: ["Second-factor attempts are locked out."],
      lockedUntil: lock.lockedUntil,
      retryAfterSeconds: lock.retryAfterSeconds,
    });
  }

  const hasTotp = typeof input.code === "string" && input.code.trim().length > 0;
  const hasRecovery =
    typeof input.recoveryCode === "string" && input.recoveryCode.trim().length > 0;
  if (hasTotp === hasRecovery) {
    // Both or neither. Never "try the code, then fall back to the recovery
    // code": that would spend a paper code on a mistyped app code.
    throw new AppError(400, "Provide exactly one of `code` or `recoveryCode`.", {
      reasons: ["Exactly one second-factor credential must be presented."],
    });
  }

  if (hasRecovery) {
    const spent = await consumeRecoveryCode(db, {
      userId: swept.userId,
      mfaId: swept.id,
      raw: input.recoveryCode!,
      ip: context.ip ?? null,
      nowMs,
    });
    if (!spent) {
      const after = await registerFailure(db, swept, config, nowMs);
      await recordSecurityEvent(db, {
        kind: "mfa_challenge_failure",
        outcome: "failure",
        userId: swept.userId,
        companyId: context.companyId ?? null,
        ip: context.ip,
        userAgent: context.userAgent,
        reason: "Recovery code not recognised, already used, or revoked",
        metadata: { purpose: context.purpose, method: "recovery_code", mfaId: swept.id },
      });
      throw failure(
        ["Recovery code is not valid, has already been used, or has been revoked."],
        after,
      );
    }
    await registerSuccess(db, swept, null, nowMs);
    const remaining = await countRecoveryCodes(db, swept.userId, swept.id);
    await recordSecurityEvent(db, {
      kind: "mfa_recovery_code_used",
      userId: swept.userId,
      companyId: context.companyId ?? null,
      ip: context.ip,
      userAgent: context.userAgent,
      reason: `${remaining} recovery codes remain`,
      metadata: { purpose: context.purpose, mfaId: swept.id, remaining },
    });
    await recordSecurityEvent(db, {
      kind: "mfa_challenge_success",
      userId: swept.userId,
      companyId: context.companyId ?? null,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { purpose: context.purpose, method: "recovery_code", mfaId: swept.id },
    });
    return { method: "recovery_code", step: null, recoveryCodesRemaining: remaining };
  }

  const verification = verifyTotp(factorParams(swept, config), input.code!, {
    atMs: nowMs,
    window: TOTP_WINDOW,
    lastUsedStep: swept.lastUsedStep,
  });
  if (verification.step === null) {
    const after = await registerFailure(db, swept, config, nowMs);
    await recordSecurityEvent(db, {
      kind: "mfa_challenge_failure",
      outcome: "failure",
      userId: swept.userId,
      companyId: context.companyId ?? null,
      ip: context.ip,
      userAgent: context.userAgent,
      reason: verification.reasons[0] ?? "Code rejected",
      metadata: { purpose: context.purpose, method: "totp", mfaId: swept.id },
    });
    throw failure(verification.reasons, after);
  }
  await registerSuccess(db, swept, verification.step, nowMs);
  await recordSecurityEvent(db, {
    kind: "mfa_challenge_success",
    userId: swept.userId,
    companyId: context.companyId ?? null,
    ip: context.ip,
    userAgent: context.userAgent,
    metadata: { purpose: context.purpose, method: "totp", mfaId: swept.id },
  });
  return {
    method: "totp",
    step: verification.step,
    recoveryCodesRemaining: await countRecoveryCodes(db, swept.userId, swept.id),
  };
}

function failure(reasons: string[], lock: LockState): AppError {
  if (lock.locked) {
    return new AppError(429, "Too many failed second-factor attempts. Try again later.", {
      reasons,
      lockedUntil: lock.lockedUntil,
      retryAfterSeconds: lock.retryAfterSeconds,
    });
  }
  return new AppError(401, "Second factor rejected", { reasons });
}

/* ------------------------------------------------------------------ */
/* Company policy — "this tenant requires MFA"                          */
/* ------------------------------------------------------------------ */

export interface MfaPolicy {
  required: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const NO_POLICY: MfaPolicy = { required: false, updatedAt: null, updatedBy: null };

/**
 * Read the policy out of `companies.settings`.
 *
 * It lives there rather than in a column because this module does not own the
 * schema and a settings blob is exactly what an unowned, tenant-scoped switch
 * belongs in. Anything unparseable reads as "not required": a corrupt settings
 * blob must not lock a whole tenant out of its own platform.
 */
export function readMfaPolicy(settings: unknown): MfaPolicy {
  if (!settings || typeof settings !== "object") return NO_POLICY;
  const mfa = (settings as Record<string, unknown>)["mfa"];
  if (!mfa || typeof mfa !== "object") return NO_POLICY;
  const m = mfa as Record<string, unknown>;
  return {
    required: m["required"] === true,
    updatedAt: typeof m["updatedAt"] === "string" ? m["updatedAt"] : null,
    updatedBy: typeof m["updatedBy"] === "string" ? m["updatedBy"] : null,
  };
}

export interface CompanyPolicyRow {
  companyId: string;
  name: string;
  policy: MfaPolicy;
}

/** Every tenant this user belongs to, with each one's MFA policy. */
export async function userCompanyPolicies(db: Db, userId: string): Promise<CompanyPolicyRow[]> {
  const rows = await db
    .select({
      companyId: companies.id,
      name: companies.name,
      settings: companies.settings,
    })
    .from(companyMemberships)
    .innerJoin(companies, eq(companies.id, companyMemberships.companyId))
    .where(eq(companyMemberships.userId, userId));
  return rows.map((r) => ({
    companyId: r.companyId,
    name: r.name,
    policy: readMfaPolicy(r.settings),
  }));
}

export async function companiesRequiringMfa(db: Db, userId: string): Promise<CompanyPolicyRow[]> {
  return (await userCompanyPolicies(db, userId)).filter((r) => r.policy.required);
}

/* ------------------------------------------------------------------ */
/* The ledger                                                          */
/* ------------------------------------------------------------------ */

/**
 * Append one ledger entry per tenant the user belongs to.
 *
 * A second factor is an account-level thing but its consequences are
 * tenant-level: each company's assurance record has a legitimate interest in
 * "a member of ours enrolled / disabled / re-issued a second factor", and
 * `appendLedger` is company-scoped by construction. The richer account trail is
 * `auth_security_events`, which is written on every path including the ones
 * with no tenant at all.
 *
 * Never carries a seed, a code or a token in the payload.
 */
export async function ledgerAcrossUserCompanies(
  db: Db,
  userId: string,
  write: {
    action: LedgerAction;
    objectType: string;
    objectId: string;
    payload: Record<string, unknown>;
  },
): Promise<string[]> {
  const rows = await db
    .select({ companyId: companyMemberships.companyId })
    .from(companyMemberships)
    .where(eq(companyMemberships.userId, userId));
  for (const row of rows) {
    await appendLedger(db, {
      companyId: row.companyId,
      actorId: userId,
      action: write.action,
      objectType: write.objectType,
      objectId: write.objectId,
      payload: write.payload,
      storePayload: true,
    });
  }
  return rows.map((r) => r.companyId);
}

/* ------------------------------------------------------------------ */
/* Issuing the session the challenge was standing in for               */
/* ------------------------------------------------------------------ */

export interface SessionIssue {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
}

function deviceLabel(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const os = /Windows/i.test(userAgent)
    ? "Windows"
    : /Mac OS X|Macintosh/i.test(userAgent)
      ? "macOS"
      : /Android/i.test(userAgent)
        ? "Android"
        : /iPhone|iPad|iOS/i.test(userAgent)
          ? "iOS"
          : /Linux/i.test(userAgent)
            ? "Linux"
            : null;
  const browser = /Edg\//i.test(userAgent)
    ? "Edge"
    : /Chrome\//i.test(userAgent)
      ? "Chrome"
      : /Safari\//i.test(userAgent)
        ? "Safari"
        : /Firefox\//i.test(userAgent)
          ? "Firefox"
          : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? userAgent.slice(0, 60);
}

/**
 * Mint the real session, after the second factor has actually been satisfied.
 *
 * The refresh token follows the identity module's idiom exactly (random value,
 * sha256 stored, never held in usable form). The `auth_sessions` row is what
 * makes the sign-in a DEVICE rather than a bare token: `mfa_satisfied_at`
 * records when this device cleared its second factor, and `refresh_token_id`
 * is repointed on rotation so the session outlives any one token.
 */
export async function issueSession(
  app: FastifyInstance,
  args: {
    user: { id: string; email: string };
    authMethod: AuthMethod;
    mfaSatisfied: boolean;
    ip?: string | null;
    userAgent?: string | null;
    companyId?: string | null;
    nowMs?: number;
  },
): Promise<SessionIssue> {
  const nowMs = args.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const refreshToken = newId("rt") + newId();
  const refreshId = newId("rtk");
  await app.db.insert(refreshTokens).values({
    id: refreshId,
    userId: args.user.id,
    tokenHash: sha256Hex(refreshToken),
    expiresAt: new Date(
      nowMs + app.appConfig.REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000,
    ).toISOString(),
  });
  const sessionId = newId("sess");
  // The token carries `sid`. Without it plugins/auth.ts has no session to
  // re-read, so an MFA-issued token survived "sign out this device" and a
  // password reset for the rest of its hour — the whole point of the
  // auth_sessions row written two lines below.
  const accessToken = await signSessionAccessToken(app, args.user, sessionId);
  const ua = args.userAgent ?? null;
  await app.db.insert(authSessions).values({
    id: sessionId,
    userId: args.user.id,
    companyId: args.companyId ?? null,
    refreshTokenId: refreshId,
    authMethod: args.authMethod,
    mfaSatisfiedAt: args.mfaSatisfied ? nowIso : null,
    userAgent: ua,
    ip: args.ip ?? null,
    deviceLabel: deviceLabel(ua),
    deviceFingerprint: createHash("sha256")
      .update(`${ua ?? ""}|${args.ip ?? ""}`)
      .digest("hex")
      .slice(0, 32),
    expiresAt: new Date(
      nowMs + app.appConfig.SESSION_ABSOLUTE_TTL_DAYS * 24 * 3600 * 1000,
    ).toISOString(),
  });
  return {
    accessToken,
    refreshToken,
    expiresIn: app.appConfig.ACCESS_TOKEN_TTL_SECONDS,
    sessionId,
  };
}

/* ------------------------------------------------------------------ */
/* Step-up freshness                                                   */
/* ------------------------------------------------------------------ */

export interface AssertionFreshness {
  satisfied: boolean;
  assertedAt: string | null;
  expiresAt: string | null;
  withinMinutes: number;
}

/**
 * When did this user last actually prove their second factor?
 *
 * Read from `auth_security_events` rather than from a claim in the access
 * token, and that is the deliberate part: a JWT is minted once and believed for
 * an hour, so a freshness claim inside it is frozen at issue time and cannot be
 * revoked. The trail is the authority, so an admin resetting a factor or an
 * incident responder acting on the log changes the answer immediately, and a
 * stolen access token gains nothing it did not already have.
 */
export async function lastAssertion(
  db: Db,
  userId: string,
  withinMinutes: number,
  nowMs = Date.now(),
): Promise<AssertionFreshness> {
  const rows = await db
    .select({ at: authSecurityEvents.at })
    .from(authSecurityEvents)
    .where(
      and(
        eq(authSecurityEvents.userId, userId),
        eq(authSecurityEvents.kind, "mfa_challenge_success"),
        eq(authSecurityEvents.outcome, "success"),
      ),
    )
    .orderBy(desc(authSecurityEvents.at))
    .limit(1);
  const at = epochMs(rows[0]?.at);
  if (at === null) {
    return { satisfied: false, assertedAt: null, expiresAt: null, withinMinutes };
  }
  const expiresMs = at + Math.max(1, withinMinutes) * 60_000;
  return {
    satisfied: expiresMs > nowMs,
    assertedAt: new Date(at).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
    withinMinutes,
  };
}

/** Guard for routes that must run after `app.authenticate`. */
export function requireUser(req: FastifyRequest): { id: string; email: string; name: string } {
  if (!req.user) throw unauthorized();
  return req.user;
}
