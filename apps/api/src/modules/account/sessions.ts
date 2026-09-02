import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SignJWT, decodeJwt } from "jose";
import { and, desc, eq, inArray, isNull, lte, ne } from "drizzle-orm";
import { authSessions, refreshTokens } from "@constructos/db";
import type { AuthMethod, SessionRevokeReason } from "@constructos/shared";
import { sha256Hex } from "@constructos/ledger";
import { newId } from "../../lib/ids.js";
import { unauthorized } from "../../lib/errors.js";
import { isExpired } from "../../lib/time.js";
import type { Db } from "../../lib/db.js";
import type { PreHandler } from "../../types.js";

/**
 * Sessions as DEVICES, not as tokens.
 *
 * THE PROBLEM THIS SOLVES. An access token here is a stateless JWT: signed,
 * one hour long, and verified without touching the database. That is fast and
 * it is also the classic hole — "sign out this device" that revokes a refresh
 * token leaves the access token working for up to an hour, which is exactly
 * the hour that matters after a laptop is stolen. Revocation has to be
 * enforced on the ACCESS path or it is theatre.
 *
 * HOW. Every access token this module mints carries a `sid` claim naming its
 * `auth_sessions` row, and every route that can act on the account re-reads
 * that row (`requireLiveSession`). A revoked session is refused on its very
 * next request, not at the next refresh.
 *
 * The claim is additive: `plugins/auth.ts` verifies the signature and reads
 * `sub`, and ignores everything else, so a token minted here works exactly as
 * before everywhere else. A token minted WITHOUT a `sid` (the SSO and MFA
 * modules issue their own, and older tokens exist) is not rejected — it simply
 * has no session to check, which is stated rather than assumed in the guard
 * below.
 */

declare module "fastify" {
  interface FastifyRequest {
    /** the `auth_sessions` row this request's access token names, if any */
    accountSessionId?: string;
  }
}

export type SessionRow = typeof authSessions.$inferSelect;

/* ------------------------------------------------------------------ */
/* Device identity                                                     */
/* ------------------------------------------------------------------ */

/** A human-facing label for the device list. Never invented when unknown. */
export function deviceLabelFor(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const os = /Windows/i.test(userAgent)
    ? "Windows"
    : /Mac OS X|Macintosh/i.test(userAgent)
      ? "macOS"
      : /Android/i.test(userAgent)
        ? "Android"
        : /iPhone|iPad|iPod|iOS/i.test(userAgent)
          ? "iOS"
          : /Linux/i.test(userAgent)
            ? "Linux"
            : null;
  const browser = /Edg\//i.test(userAgent)
    ? "Edge"
    : /OPR\//i.test(userAgent)
      ? "Opera"
      : /Chrome\//i.test(userAgent)
        ? "Chrome"
        : /Firefox\//i.test(userAgent)
          ? "Firefox"
          : /Safari\//i.test(userAgent)
            ? "Safari"
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? userAgent.slice(0, 60);
}

/**
 * A coarse hash used only to answer "have we seen this device before?".
 * User agent plus IP, hashed — never stored in the clear, never precise enough
 * to be a tracking identifier, and good enough that a sign-in from a new
 * machine is noticed.
 */
export function deviceFingerprintOf(
  userAgent: string | null | undefined,
  ip: string | null | undefined,
): string {
  return createHash("sha256")
    .update(`${userAgent ?? ""}|${ip ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export function requestContext(req: FastifyRequest): RequestContext {
  const ua = req.headers["user-agent"];
  return { ip: req.ip ?? null, userAgent: typeof ua === "string" ? ua : null };
}

/* ------------------------------------------------------------------ */
/* Minting                                                             */
/* ------------------------------------------------------------------ */

/**
 * Sign an access token bound to a session.
 *
 * Deliberately mirrors `app.signAccessToken` (HS256, `sub`, `email`, the same
 * TTL and the same secret) and adds `sid`. It is a separate function rather
 * than a change to the auth plugin because that plugin is not this module's to
 * edit — see the notes in the module header.
 */
export async function signSessionAccessToken(
  app: FastifyInstance,
  user: { id: string; email: string },
  sessionId: string,
): Promise<string> {
  const secret = new TextEncoder().encode(app.appConfig.AUTH_SECRET);
  return new SignJWT({ email: user.email, sid: sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${app.appConfig.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secret);
}

export interface IssueSessionOptions {
  user: { id: string; email: string; name?: string | null };
  authMethod: AuthMethod;
  companyId?: string | null;
  /** rotate within this existing session instead of opening a new one */
  sessionId?: string | null;
  mfaSatisfied?: boolean;
  identityId?: string | null;
  providerId?: string | null;
  nowMs?: number;
  /**
   * #23 — the tenant's absolute session lifetime in hours, from the resolved
   * security policy (modules/account/policy.ts). Unset falls back to
   * SESSION_ABSOLUTE_TTL_DAYS, which is what every caller did before tenant
   * policy existed.
   */
  absoluteTtlHours?: number | null;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
  refreshTokenId: string;
  isNewDevice: boolean;
  session: {
    id: string;
    authMethod: AuthMethod;
    deviceLabel: string | null;
    expiresAt: string;
  };
}

/**
 * Mint a refresh token, and either open a session or repoint an existing one.
 *
 * Repointing is the point of `auth_sessions.refresh_token_id`: rotation
 * replaces the token, and the DEVICE — its name in the list, when it first
 * appeared, whether it ever cleared MFA — survives it. A session that died on
 * every rotation would make the device list useless within the hour.
 */
export async function issueUserSession(
  app: FastifyInstance,
  ctx: RequestContext,
  options: IssueSessionOptions,
): Promise<IssuedSession> {
  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const refreshToken = newId("rt") + newId();
  const refreshTokenId = newId("rtk");
  await app.db.insert(refreshTokens).values({
    id: refreshTokenId,
    userId: options.user.id,
    tokenHash: sha256Hex(refreshToken),
    expiresAt: new Date(
      nowMs + app.appConfig.REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000,
    ).toISOString(),
  });

  const deviceLabel = deviceLabelFor(ctx.userAgent);
  const fingerprint = deviceFingerprintOf(ctx.userAgent, ctx.ip);
  const ttlHours =
    options.absoluteTtlHours && options.absoluteTtlHours > 0
      ? Math.min(options.absoluteTtlHours, app.appConfig.SESSION_ABSOLUTE_TTL_DAYS * 24)
      : app.appConfig.SESSION_ABSOLUTE_TTL_DAYS * 24;
  const expiresAt = new Date(nowMs + ttlHours * 3600 * 1000).toISOString();

  if (options.sessionId) {
    const [existing] = await app.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, options.sessionId))
      .limit(1);
    if (existing && !existing.revokedAt && existing.userId === options.user.id) {
      await app.db
        .update(authSessions)
        .set({
          refreshTokenId,
          lastSeenAt: nowIso,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          ...(options.companyId ? { companyId: options.companyId } : {}),
        })
        .where(eq(authSessions.id, existing.id));
      return {
        accessToken: await signSessionAccessToken(app, options.user, existing.id),
        refreshToken,
        expiresIn: app.appConfig.ACCESS_TOKEN_TTL_SECONDS,
        sessionId: existing.id,
        refreshTokenId,
        isNewDevice: false,
        session: {
          id: existing.id,
          authMethod: existing.authMethod as AuthMethod,
          deviceLabel: existing.deviceLabel,
          expiresAt: existing.expiresAt,
        },
      };
    }
  }

  // "Have we seen this device?" is asked BEFORE the new row exists, or the
  // answer is always yes.
  const seen = await app.db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.userId, options.user.id),
        eq(authSessions.deviceFingerprint, fingerprint),
      ),
    )
    .limit(1);

  const sessionId = newId("sess");
  await app.db.insert(authSessions).values({
    id: sessionId,
    userId: options.user.id,
    companyId: options.companyId ?? null,
    refreshTokenId,
    identityId: options.identityId ?? null,
    providerId: options.providerId ?? null,
    authMethod: options.authMethod,
    mfaSatisfiedAt: options.mfaSatisfied ? nowIso : null,
    userAgent: ctx.userAgent,
    ip: ctx.ip,
    deviceLabel,
    deviceFingerprint: fingerprint,
    lastSeenAt: nowIso,
    expiresAt,
  });

  return {
    accessToken: await signSessionAccessToken(app, options.user, sessionId),
    refreshToken,
    expiresIn: app.appConfig.ACCESS_TOKEN_TTL_SECONDS,
    sessionId,
    refreshTokenId,
    isNewDevice: seen.length === 0,
    session: { id: sessionId, authMethod: options.authMethod, deviceLabel, expiresAt },
  };
}

/* ------------------------------------------------------------------ */
/* Reading the session behind a request                                */
/* ------------------------------------------------------------------ */

/**
 * The `sid` claim of the presented bearer token, or null.
 *
 * Decoded WITHOUT verifying, deliberately: `app.authenticate` has already
 * verified the signature on this exact header before any route preHandler that
 * uses this runs, so re-verifying buys nothing. Never call this before
 * authentication.
 */
export function sessionIdFromRequest(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  try {
    const sid = decodeJwt(header.slice(7))["sid"];
    return typeof sid === "string" && sid.length > 0 ? sid : null;
  } catch {
    return null;
  }
}

export async function loadSession(db: Db, sessionId: string): Promise<SessionRow | null> {
  const [row] = await db
    .select()
    .from(authSessions)
    .where(eq(authSessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

/**
 * Refuse a request whose session has been revoked or has expired.
 *
 * Run it after `app.authenticate` on every route that can act on the account.
 * The three-way answer matters:
 *   - no `sid` at all  → nothing to check (a token from another module, or one
 *     minted before sessions existed). Allowed, and said so out loud.
 *   - `sid` present, session gone/revoked/expired → 401 immediately.
 *   - `sid` present and live → `req.accountSessionId` is set, and `last_seen_at`
 *     is refreshed at most once a minute so the device list is truthful without
 *     writing on every request.
 */
export function requireLiveSession(app: FastifyInstance): PreHandler {
  return async (req) => {
    const sid = sessionIdFromRequest(req);
    if (!sid) return;
    const session = await loadSession(app.db, sid);
    if (!session || (req.user && session.userId !== req.user.id)) {
      throw unauthorized("Session is no longer valid");
    }
    if (session.revokedAt) {
      throw unauthorized(
        session.revokedReason === "password_changed" || session.revokedReason === "mfa_reset"
          ? "Session ended because the account credentials changed"
          : "Session has been signed out",
      );
    }
    const nowMs = Date.now();
    if (isExpired(session.expiresAt, nowMs)) {
      // Lazy, idempotent sweep: the row is marked on the read that noticed it.
      await revokeSessions(app.db, [session.id], {
        reason: "expired",
        byUser: false,
        actorId: null,
        nowMs,
      });
      throw unauthorized("Session has expired");
    }
    req.accountSessionId = session.id;
    const lastSeen = Date.parse(session.lastSeenAt);
    if (!Number.isFinite(lastSeen) || nowMs - lastSeen > 60_000) {
      await app.db
        .update(authSessions)
        .set({ lastSeenAt: new Date(nowMs).toISOString() })
        .where(eq(authSessions.id, session.id));
    }
  };
}

/* ------------------------------------------------------------------ */
/* Revocation                                                          */
/* ------------------------------------------------------------------ */

export interface RevokeOptions {
  reason: SessionRevokeReason;
  /** true when the account holder ended it, false when someone else did */
  byUser: boolean;
  actorId: string | null;
  nowMs?: number;
}

/**
 * Revoke specific sessions AND the refresh tokens they point at.
 *
 * Both halves matter: the session row is what the access path checks, and the
 * refresh token is what would otherwise mint a fresh access token five minutes
 * later. Revoking one without the other is the bug in each direction.
 */
export async function revokeSessions(
  db: Db,
  sessionIds: readonly string[],
  options: RevokeOptions,
): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const nowIso = new Date(options.nowMs ?? Date.now()).toISOString();
  const ids = [...sessionIds];
  const rows = await db
    .select({ id: authSessions.id, refreshTokenId: authSessions.refreshTokenId })
    .from(authSessions)
    .where(and(inArray(authSessions.id, ids), isNull(authSessions.revokedAt)));
  if (rows.length === 0) return 0;

  await db
    .update(authSessions)
    .set({
      revokedAt: nowIso,
      revokedBy: options.actorId,
      revokedByUser: options.byUser,
      revokedReason: options.reason,
      refreshTokenId: null,
    })
    .where(inArray(authSessions.id, rows.map((r) => r.id)));

  const tokenIds = rows.map((r) => r.refreshTokenId).filter((id): id is string => Boolean(id));
  if (tokenIds.length > 0) {
    await db
      .update(refreshTokens)
      .set({ revokedAt: nowIso })
      .where(and(inArray(refreshTokens.id, tokenIds), isNull(refreshTokens.revokedAt)));
  }
  return rows.length;
}

export interface RevokeAllOptions extends RevokeOptions {
  /** the session doing the revoking, kept alive ("other devices") */
  exceptSessionId?: string | null;
  /**
   * Also revoke refresh tokens that belong to no session at all. A password
   * reset must do this: tokens minted before sessions existed, or by another
   * module, are exactly what an attacker who is already inside would be
   * holding.
   */
  includeOrphanTokens?: boolean;
}

export async function revokeAllUserSessions(
  db: Db,
  userId: string,
  options: RevokeAllOptions,
): Promise<number> {
  const nowIso = new Date(options.nowMs ?? Date.now()).toISOString();
  const live = await db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.userId, userId),
        isNull(authSessions.revokedAt),
        options.exceptSessionId ? ne(authSessions.id, options.exceptSessionId) : undefined,
      ),
    );
  const revoked = await revokeSessions(
    db,
    live.map((s) => s.id),
    options,
  );

  if (options.includeOrphanTokens) {
    let keepTokenId: string | null = null;
    if (options.exceptSessionId) {
      const kept = await loadSession(db, options.exceptSessionId);
      keepTokenId = kept?.refreshTokenId ?? null;
    }
    await db
      .update(refreshTokens)
      .set({ revokedAt: nowIso })
      .where(
        and(
          eq(refreshTokens.userId, userId),
          isNull(refreshTokens.revokedAt),
          keepTokenId ? ne(refreshTokens.id, keepTokenId) : undefined,
        ),
      );
  }
  return revoked;
}

/**
 * Mark every session of this user whose absolute lifetime has run out.
 *
 * Lazy and idempotent, run on the device-list read — the house rule. A cron
 * would be a second source of truth that disagrees with the reader for up to
 * an hour, and the reader is the one a user is looking at.
 */
export async function sweepExpiredSessions(db: Db, userId: string, nowMs = Date.now()): Promise<number> {
  const nowIso = new Date(nowMs).toISOString();
  const stale = await db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.userId, userId),
        isNull(authSessions.revokedAt),
        lte(authSessions.expiresAt, nowIso),
      ),
    );
  return revokeSessions(db, stale.map((s) => s.id), {
    reason: "expired",
    byUser: false,
    actorId: null,
    nowMs,
  });
}

export interface SessionView {
  id: string;
  current: boolean;
  authMethod: string;
  companyId: string | null;
  deviceLabel: string | null;
  userAgent: string | null;
  ip: string | null;
  mfaSatisfiedAt: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

/** Live sessions, newest first, with the caller's own marked. */
export async function listLiveSessions(
  db: Db,
  userId: string,
  currentSessionId: string | null,
): Promise<SessionView[]> {
  const rows = await db
    .select()
    .from(authSessions)
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
    .orderBy(desc(authSessions.lastSeenAt));
  return rows.map((row) => ({
    id: row.id,
    current: row.id === currentSessionId,
    authMethod: row.authMethod,
    companyId: row.companyId,
    deviceLabel: row.deviceLabel,
    userAgent: row.userAgent,
    ip: row.ip,
    mfaSatisfiedAt: row.mfaSatisfiedAt,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
  }));
}

/**
 * The session a refresh token currently belongs to.
 *
 * Refresh rotation looks this up so the NEW token is repointed into the same
 * session row rather than opening a second device for the same browser. The
 * revocation check stays where it is (a revoked session's refresh token is
 * revoked with it), so this cannot resurrect anything.
 */
export async function sessionIdForRefreshToken(
  db: Db,
  refreshTokenId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(and(eq(authSessions.refreshTokenId, refreshTokenId), isNull(authSessions.revokedAt)))
    .limit(1);
  return row?.id ?? null;
}
