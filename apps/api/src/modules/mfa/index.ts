import type { FastifyPluginAsync } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { companies, companyMemberships, userMfa, users } from "@constructos/db";
import { AppError, badRequest, conflict, unauthorized } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { equalizeVerifyTiming, verifyPassword } from "../account/password.js";
import {
  completeLogin,
  guardLoginAttempt,
  guardLoginIpAllowlist,
  loginPolicyFor,
  noteLoginFailure,
} from "../account/login.js";
import { recordLegacyAuthEvent } from "../account/events.js";
import { dispatchEmail } from "../account/mailer.js";
import { buildAppUrl, renderMfaEnrolled } from "../../lib/email.js";
import { isPasswordLoginAllowedForUser } from "../sso/index.js";
import {
  challengeEnvelope,
  mintChallengeToken,
  verifyChallengeToken,
  type ChallengeScope,
} from "./challenge.js";
import {
  assertChallengeLive,
  consumeChallenge,
  liveChallengeCount,
  registerChallenge,
  sweepExpiredChallenges,
} from "./challenge-store.js";
import { deriveKey, KEY_PURPOSE, keyId, sealSecret } from "./secrets.js";
import {
  assertFactor,
  activeFactor,
  companiesRequiringMfa,
  countRecoveryCodes,
  isActive,
  issueRecoveryCodes,
  issueSession,
  lastAssertion,
  ledgerAcrossUserCompanies,
  loadFactor,
  lockState,
  readMfaPolicy,
  recordSecurityEvent,
  requestContext,
  requireUser,
  revokeAllRecoveryCodes,
  sweepExpiredLock,
  userCompanyPolicies,
} from "./service.js";
import { generateTotpSecret, otpauthUri } from "./totp.js";

/**
 * Multi-factor authentication — TOTP enrolment, challenge, recovery codes,
 * per-action step-up, and the tenant policy that makes any of it mandatory.
 *
 * ROUTE OWNERSHIP. Everything here is under `/auth/mfa/*`, which is this
 * module's namespace. In particular `POST /auth/mfa/login` is an
 * MFA-AWARE PASSWORD LOGIN and does not touch the identity module's
 * `/auth/login`: that route belongs to another owner, and quietly changing
 * what a platform's login returns from outside its own module is how an auth
 * change takes a platform down. See the notes at the foot of this file for
 * exactly what the identity module must adopt for MFA to be unavoidable.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: a password alone never produces a session
 * for an account with a confirmed second factor. It produces a CHALLENGE — a
 * short-lived, purpose-separated token that is not an access token and cannot
 * reach a single authenticated route — and only a correct TOTP code or a
 * recovery code turns that into a session.
 *
 * A `pending` enrolment is not a second factor. It is a seed that has been
 * shown and never proved, and treating it as satisfied would lock out every
 * user who scanned a QR code into an app they then deleted.
 */

/** What authenticator apps display as the account issuer. */
const ISSUER = "ConstructOS";

const codeSchema = z.object({
  code: z.string().min(1).max(32).optional(),
  recoveryCode: z.string().min(1).max(64).optional(),
});

const enrolConfirmSchema = z.object({ code: z.string().min(1).max(32) });

const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1).max(256),
});

const challengeSchema = z.object({
  challengeToken: z.string().min(20).max(4096),
  code: z.string().min(1).max(32).optional(),
  recoveryCode: z.string().min(1).max(64).optional(),
});

const challengeEnrolSchema = z.object({ challengeToken: z.string().min(20).max(4096) });

const policySchema = z.object({ required: z.boolean() });

/**
 * Timing equalisation for an unknown address, shared with the identity
 * module's own login route. A LITERAL cost-10 hash used to live here; real
 * hashes are written at `passwordHashCost`, which floors production at 12, so
 * the literal made this route answer in ~95ms for an address with no account
 * and ~350ms for one with — a single-request enumeration oracle that identical
 * response bodies cannot hide. `equalizeVerifyTiming` derives the cost from
 * the same config the real hashes were written under.
 */

export const mfaModule: FastifyPluginAsync = async (app) => {
  const cfg = app.appConfig;

  /** Same per-IP credential throttle the identity module puts on its own
   *  credential endpoints. This is the NETWORK limiter; the per-factor lockout
   *  in service.ts is a separate, account-scoped one, and neither substitutes
   *  for the other. */
  const authLimited =
    cfg.RATE_LIMIT_ENABLED && cfg.NODE_ENV !== "test"
      ? {
          config: {
            rateLimit: {
              max: cfg.AUTH_RATE_LIMIT_MAX_PER_MINUTE,
              timeWindow: "1 minute",
            },
          },
        }
      : {};

  /* ---------------------------------------------------------------- */
  /* Provisioning a seed                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Create or replace the PENDING factor for a user and return the
   * provisioning material. Called from two places — self-service enrolment and
   * the enrol-now path of a policy challenge — which is why it is a function
   * and not inlined into either.
   *
   * Re-enrolling replaces the seed and resets `last_used_step`, because the
   * replay high-water mark belongs to the old seed and carrying it forward
   * would refuse perfectly good codes from the new one.
   */
  async function provisionFactor(user: { id: string; email: string }) {
    const existing = await loadFactor(app.db, user.id);
    if (isActive(existing)) {
      throw conflict(
        "A confirmed second factor is already enrolled. Disable it before enrolling another.",
      );
    }
    const base32 = generateTotpSecret();
    const key = deriveKey(cfg, KEY_PURPOSE.totpSeed);
    const nowIso = new Date().toISOString();
    const values = {
      method: "totp" as const,
      secretCiphertext: sealSecret(base32, key),
      secretKeyId: keyId(key),
      label: user.email,
      algorithm: "SHA1",
      digits: 6,
      periodSeconds: 30,
      status: "pending" as const,
      confirmedAt: null,
      lastUsedAt: null,
      lastUsedStep: null,
      failedAttempts: 0,
      lockedUntil: null,
      disabledAt: null,
      updatedAt: nowIso,
    };
    let mfaId: string;
    if (existing) {
      mfaId = existing.id;
      await app.db.update(userMfa).set(values).where(eq(userMfa.id, existing.id));
    } else {
      mfaId = newId("mfa");
      await app.db.insert(userMfa).values({ id: mfaId, userId: user.id, ...values });
    }
    const uri = otpauthUri({
      issuer: ISSUER,
      account: user.email,
      secret: base32,
      algorithm: "SHA1",
      digits: 6,
      periodSeconds: 30,
    });
    return {
      mfaId,
      // The seed leaves the platform exactly once, here, at the single moment
      // of creation. It is never in a log line, never in a later read, and
      // never in the row in usable form.
      secret: base32,
      otpauthUri: uri,
      /**
       * The parameters a client needs to draw the QR itself. No QR encoder
       * ships in this API on purpose: it would be a dependency for a picture
       * only a browser looks at, and would mean rendering the seed into a
       * bitmap the server could cache or log.
       */
      otpauth: {
        uri,
        secret: base32,
        issuer: ISSUER,
        account: user.email,
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      },
    };
  }

  /** Confirm a pending factor and hand over its one and only recovery batch. */
  async function confirmFactor(
    user: { id: string; email: string; name?: string },
    code: string,
    context: { ip: string | null; userAgent: string | null; purpose: string },
  ) {
    const factor = await loadFactor(app.db, user.id);
    if (!factor || !factor.secretCiphertext) {
      throw badRequest("No enrolment in progress. Start one first.", {
        reasons: ["No TOTP seed has been provisioned for this account."],
      });
    }
    if (factor.status === "active") {
      throw conflict("This second factor is already confirmed.");
    }
    await assertFactor(
      app.db,
      cfg,
      factor,
      { code },
      { ip: context.ip, userAgent: context.userAgent, purpose: context.purpose },
    );
    const nowIso = new Date().toISOString();
    await app.db
      .update(userMfa)
      .set({ status: "active", confirmedAt: nowIso, disabledAt: null, updatedAt: nowIso })
      .where(eq(userMfa.id, factor.id));
    const issued = await issueRecoveryCodes(app.db, {
      userId: user.id,
      mfaId: factor.id,
      count: cfg.MFA_RECOVERY_CODE_COUNT,
    });
    await recordSecurityEvent(app.db, {
      kind: "mfa_enrolled",
      userId: user.id,
      email: user.email,
      ip: context.ip,
      userAgent: context.userAgent,
      reason: `TOTP confirmed with ${issued.codes.length} recovery codes`,
      metadata: { mfaId: factor.id, method: "totp", recoveryCodeCount: issued.codes.length },
    });
    await ledgerAcrossUserCompanies(app.db, user.id, {
      action: "state_change",
      objectType: "user_mfa",
      objectId: factor.id,
      payload: { event: "mfa_enrolled", method: "totp", status: "active", at: nowIso },
    });
    // TELL THE ACCOUNT HOLDER. `renderMfaEnrolled` has existed in lib/email.ts
    // since the module was written and nothing ever dispatched it, so the one
    // change that most needs to reach a human — "a second factor now guards
    // your account, and if it was not you, someone else holds your password"
    // — was recorded and never sent. The message never fails the enrolment:
    // dispatchEmail records `dispatched:false` with a reason when no provider
    // is configured, exactly as the invitation and reset paths do.
    const rendered = renderMfaEnrolled({
      name: user.name ?? user.email,
      method: "authenticator app (TOTP)",
      recoveryCodeCount: issued.codes.length,
      at: nowIso,
      securityUrl: buildAppUrl(cfg.APP_BASE_URL, "/account/security"),
    });
    await dispatchEmail(app, {
      message: { to: { email: user.email, name: user.name ?? user.email }, ...rendered },
      userId: user.id,
      variables: { method: "totp", recoveryCodeCount: issued.codes.length, at: nowIso },
      relatedType: "user_mfa",
      relatedId: factor.id,
    });
    return { factorId: factor.id, confirmedAt: nowIso, issued };
  }

  /* ---------------------------------------------------------------- */
  /* Self-service: status                                              */
  /* ---------------------------------------------------------------- */

  app.get("/auth/mfa", { preHandler: [app.authenticate] }, async (req) => {
    const user = requireUser(req);
    let factor = await loadFactor(app.db, user.id);
    // Lazy, idempotent sweep on a read: an elapsed lock is cleared here rather
    // than by a cron, so the next attempt sees an unlocked row instead of
    // re-deriving "expired, therefore fine" for ever.
    if (factor) factor = await sweepExpiredLock(app.db, factor);

    const policies = await userCompanyPolicies(app.db, user.id);
    const requiredBy = policies.filter((p) => p.policy.required);
    const lock = factor ? lockState(factor) : { locked: false, lockedUntil: null, retryAfterSeconds: 0 };
    const freshness = await lastAssertion(app.db, user.id, cfg.MFA_CHALLENGE_TTL_MINUTES);

    // No factor means no count exists to report. The platform's rule is that a
    // missing input yields null and a reason, never a comforting zero that
    // reads as "you have used them all".
    const reasons: string[] = [];
    if (!factor) reasons.push("No second factor has been enrolled on this account.");
    else if (factor.status === "pending") {
      reasons.push("Enrolment started but never confirmed — this factor cannot satisfy a challenge.");
    } else if (factor.status === "disabled") reasons.push("The second factor was disabled.");
    if (requiredBy.length > 0 && (!factor || factor.status !== "active")) {
      reasons.push(
        `Second-factor enrolment is required by: ${requiredBy.map((r) => r.name).join(", ")}.`,
      );
    }

    return {
      enrolled: isActive(factor),
      status: factor?.status ?? "none",
      method: "totp",
      label: factor?.label ?? null,
      confirmedAt: factor?.confirmedAt ?? null,
      lastUsedAt: factor?.lastUsedAt ?? null,
      locked: lock.locked,
      lockedUntil: lock.lockedUntil,
      retryAfterSeconds: lock.retryAfterSeconds,
      failedAttempts: factor?.failedAttempts ?? 0,
      recoveryCodesRemaining:
        factor && factor.status === "active"
          ? await countRecoveryCodes(app.db, user.id, factor.id)
          : null,
      stepUp: freshness,
      // Half-finished sign-ins: a password was accepted and the second factor
      // was never produced. Usually one, from the tab the user is looking at.
      // More than one is the signal worth seeing — somebody else has this
      // account's password — which is why it is reported rather than hidden.
      challengesInFlight: await liveChallengeCount(app.db, user.id, Date.now()),
      policy: {
        required: requiredBy.length > 0,
        requiredBy: requiredBy.map((r) => ({ companyId: r.companyId, name: r.name })),
      },
      reasons,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Self-service: enrol                                               */
  /* ---------------------------------------------------------------- */

  app.post("/auth/mfa/enrol", { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = requireUser(req);
    const context = requestContext(req);
    const provisioned = await provisionFactor(user);
    await recordSecurityEvent(app.db, {
      kind: "mfa_enrol_started",
      outcome: "pending",
      userId: user.id,
      email: user.email,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { mfaId: provisioned.mfaId, method: "totp" },
    });
    return reply.status(201).send({
      ...provisioned,
      status: "pending",
      confirmWith: "POST /api/v1/auth/mfa/enrol/confirm",
      reasons: [
        "This factor is pending and cannot satisfy a challenge until a code from it is verified.",
      ],
    });
  });

  app.post("/auth/mfa/enrol/confirm", { preHandler: [app.authenticate] }, async (req) => {
    const user = requireUser(req);
    const body = enrolConfirmSchema.parse(req.body);
    const context = requestContext(req);
    const result = await confirmFactor(user, body.code, { ...context, purpose: "enrol_confirm" });
    return {
      status: "active",
      confirmedAt: result.confirmedAt,
      // Shown once. There is no route that will ever show them again, because
      // only their hashes are kept.
      recoveryCodes: result.issued.codes,
      recoveryCodesRemaining: result.issued.remaining,
      batchId: result.issued.batchId,
      warning:
        "These recovery codes are shown once. Store them somewhere safe — they cannot be retrieved again.",
    };
  });

  /* ---------------------------------------------------------------- */
  /* Self-service: disable                                             */
  /* ---------------------------------------------------------------- */

  app.post("/auth/mfa/disable", { preHandler: [app.authenticate] }, async (req) => {
    const user = requireUser(req);
    const body = codeSchema.parse(req.body ?? {});
    const context = requestContext(req);

    const factor = await loadFactor(app.db, user.id);
    if (!factor || factor.status === "disabled") {
      throw conflict("No second factor is enrolled on this account.");
    }

    // Tenant policy outranks personal preference. A user who could switch MFA
    // off would make "this company requires MFA" a suggestion.
    const requiredBy = await companiesRequiringMfa(app.db, user.id);
    if (requiredBy.length > 0) {
      throw new AppError(403, "Your organisation requires a second factor.", {
        code: "mfa_required_by_policy",
        reasons: requiredBy.map((r) => `${r.name} requires MFA for all members.`),
        requiredBy: requiredBy.map((r) => ({ companyId: r.companyId, name: r.name })),
      });
    }

    if (factor.status === "active") {
      // A password is NOT enough, and neither is a live session: the whole
      // point of the factor is that a stolen session cannot remove it. Proof
      // of possession — a current code, or a printed recovery code — or
      // nothing happens.
      await assertFactor(app.db, cfg, factor, body, {
        ip: context.ip,
        userAgent: context.userAgent,
        purpose: "disable",
      });
    }
    // A `pending` factor has never satisfied anything and protects nothing, so
    // abandoning one needs no proof of possession — there is nothing to prove.

    const nowIso = new Date().toISOString();
    await app.db
      .update(userMfa)
      .set({
        status: "disabled",
        disabledAt: nowIso,
        // The seed is destroyed, not merely flagged. A disabled row that still
        // holds decryptable key material is a seed waiting to be re-enabled by
        // whoever next gets write access to the table.
        secretCiphertext: null,
        secretKeyId: null,
        lastUsedStep: null,
        failedAttempts: 0,
        lockedUntil: null,
        confirmedAt: null,
        updatedAt: nowIso,
      })
      .where(eq(userMfa.id, factor.id));
    await revokeAllRecoveryCodes(app.db, user.id);
    await recordSecurityEvent(app.db, {
      kind: "mfa_disabled",
      userId: user.id,
      email: user.email,
      ip: context.ip,
      userAgent: context.userAgent,
      reason: factor.status === "active" ? "Disabled after a valid assertion" : "Pending enrolment abandoned",
      metadata: { mfaId: factor.id, previousStatus: factor.status },
    });
    await ledgerAcrossUserCompanies(app.db, user.id, {
      action: "state_change",
      objectType: "user_mfa",
      objectId: factor.id,
      payload: { event: "mfa_disabled", previousStatus: factor.status, at: nowIso },
    });
    return { status: "disabled", disabledAt: nowIso, recoveryCodesRemaining: 0 };
  });

  /* ---------------------------------------------------------------- */
  /* Recovery codes                                                    */
  /* ---------------------------------------------------------------- */

  app.get("/auth/mfa/recovery-codes", { preHandler: [app.authenticate] }, async (req) => {
    const user = requireUser(req);
    const factor = await activeFactor(app.db, user.id);
    if (!factor) {
      return {
        remaining: null,
        reasons: ["No confirmed second factor is enrolled, so no recovery codes exist."],
      };
    }
    const remaining = await countRecoveryCodes(app.db, user.id, factor.id);
    return {
      remaining,
      reasons:
        remaining === 0
          ? ["Every recovery code has been used or revoked. Generate a new set."]
          : [],
    };
  });

  app.post("/auth/mfa/recovery-codes", { preHandler: [app.authenticate] }, async (req) => {
    const user = requireUser(req);
    const body = codeSchema.parse(req.body ?? {});
    const context = requestContext(req);
    const factor = await activeFactor(app.db, user.id);
    if (!factor) throw conflict("No confirmed second factor is enrolled on this account.");

    // Regeneration is a credential-issuing action, so it is gated the same way
    // disabling is: proof of possession, never a bare session.
    await assertFactor(app.db, cfg, factor, body, {
      ip: context.ip,
      userAgent: context.userAgent,
      purpose: "recovery_codes_regenerate",
    });
    const issued = await issueRecoveryCodes(app.db, {
      userId: user.id,
      mfaId: factor.id,
      count: cfg.MFA_RECOVERY_CODE_COUNT,
    });
    await recordSecurityEvent(app.db, {
      kind: "mfa_recovery_codes_regenerated",
      userId: user.id,
      email: user.email,
      ip: context.ip,
      userAgent: context.userAgent,
      reason: "Every previously issued recovery code was revoked",
      metadata: { mfaId: factor.id, batchId: issued.batchId, count: issued.codes.length },
    });
    await ledgerAcrossUserCompanies(app.db, user.id, {
      action: "state_change",
      objectType: "user_mfa",
      objectId: factor.id,
      payload: { event: "mfa_recovery_codes_regenerated", count: issued.codes.length },
    });
    return {
      recoveryCodes: issued.codes,
      recoveryCodesRemaining: issued.remaining,
      batchId: issued.batchId,
      warning:
        "Every code issued before now has been revoked. These are shown once and cannot be retrieved again.",
    };
  });

  /* ---------------------------------------------------------------- */
  /* Step-up                                                           */
  /* ---------------------------------------------------------------- */

  app.get("/auth/mfa/step-up", { preHandler: [app.authenticate] }, async (req) => {
    const user = requireUser(req);
    const factor = await activeFactor(app.db, user.id);
    const freshness = await lastAssertion(app.db, user.id, cfg.MFA_CHALLENGE_TTL_MINUTES);
    return {
      ...freshness,
      enrolled: factor !== null,
      reasons: factor
        ? freshness.satisfied
          ? []
          : ["No second-factor assertion inside the freshness window."]
        : ["No confirmed second factor is enrolled, so step-up cannot be satisfied."],
    };
  });

  app.post("/auth/mfa/step-up", { preHandler: [app.authenticate] }, async (req) => {
    const user = requireUser(req);
    const body = codeSchema.parse(req.body ?? {});
    const context = requestContext(req);
    const factor = await activeFactor(app.db, user.id);
    if (!factor) {
      throw new AppError(403, "Step-up requires a confirmed second factor.", {
        code: "mfa_enrolment_required",
        enrolPath: "/api/v1/auth/mfa/enrol",
        reasons: ["No confirmed TOTP factor is enrolled on this account."],
      });
    }
    const outcome = await assertFactor(app.db, cfg, factor, body, {
      ip: context.ip,
      userAgent: context.userAgent,
      purpose: "step_up",
      companyId: req.companyId ?? null,
    });
    const freshness = await lastAssertion(app.db, user.id, cfg.MFA_CHALLENGE_TTL_MINUTES);
    return {
      ...freshness,
      satisfied: true,
      method: outcome.method,
      recoveryCodesRemaining: outcome.recoveryCodesRemaining,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Login and challenge                                               */
  /* ---------------------------------------------------------------- */

  /**
   * MFA-aware password sign-in — the route the SPA actually calls.
   *
   * ------------------------------------------------------------------------
   * WHAT WAS WRONG HERE, and why the fix is this shape
   * ------------------------------------------------------------------------
   * This handler used to run `bcrypt.compare` and record a `login_failure`
   * row, and nothing else. It never called `guardLoginAttempt` or
   * `noteLoginFailure` (modules/account/login.ts), so an attacker could guess
   * passwords against one address indefinitely: no account lockout, no per-IP
   * lockout, no doubling delay, no `account_locked` event. Only the per-IP
   * network limiter applied, and that one is per-replica and off under test.
   * Meanwhile `POST /auth/login` — the route nobody's browser used — had every
   * one of those defences. The lockout engine was real and unreachable.
   *
   * It also skipped `completeLogin`, so a sign-in through the SPA got no
   * transparent bcrypt rehash, no new-device message and no `isNewDevice`
   * metadata in the trail. Three features that existed and never ran.
   *
   * So this route now runs exactly the same gauntlet as identity's
   * `/auth/login`, in the same order, and calls the same helpers:
   *
   *   1. the tenant's resolved policy (lockout thresholds come from it, #25)
   *   2. guardLoginAttempt  — refuse a locked address BEFORE the compare
   *   3. the password, with `equalizeVerifyTiming` for an unknown address
   *   4. noteLoginFailure   — count it, arm the lock, pay the delay
   *   5. the tenant SSO policy (`allowPasswordLogin`)
   *   6. the tenant IP allowlist (#24)
   *   7. the MFA branch — challenge, never a session
   *   8. completeLogin      — rehash, session row, trail, new-device message
   */
  app.post("/auth/mfa/login", authLimited, async (req) => {
    const body = loginSchema.parse(req.body);
    const context = requestContext(req);
    const policy = await loginPolicyFor(app, body.email);
    // BEFORE the password is looked at, and identical for an address with an
    // account and one without: the counter is keyed on what was typed.
    await guardLoginAttempt(app, req, body.email, Date.now(), policy);

    const rows = await app.db.select().from(users).where(eq(users.email, body.email)).limit(1);
    const user = rows[0];
    // Always run a comparison, even when there is no account: an early return
    // makes the response time an account-enumeration oracle.
    const ok = user
      ? await verifyPassword(body.password, user.passwordHash)
      : await equalizeVerifyTiming(body.password, cfg);
    if (!user || !ok || !user.isActive) {
      const reason = !user
        ? "No account with this address"
        : !ok
          ? "Password did not match"
          : "Account is deactivated";
      await recordSecurityEvent(app.db, {
        kind: user && ok ? "login_blocked_inactive" : "login_failure",
        outcome: user && ok ? "blocked" : "failure",
        userId: user?.id ?? null,
        email: body.email,
        ip: context.ip,
        userAgent: context.userAgent,
        reason,
      });
      await recordLegacyAuthEvent(app.db, {
        userId: user?.id ?? null,
        email: body.email,
        kind: user && ok ? "login_blocked_inactive" : "login_failure",
        ip: context.ip,
        userAgent: context.userAgent,
      });
      // The lock, the doubling delay and the `account_locked` row. This single
      // call is the difference between a rate limit and a lockout.
      await noteLoginFailure(
        app,
        req,
        {
          email: body.email,
          userId: user?.id ?? null,
          reason: !user ? "unknown_address" : !ok ? "invalid_password" : "account_inactive",
          overrides: policy,
        },
      );
      throw unauthorized("Invalid credentials");
    }

    // Tenant policy: a company that requires SSO must not be reachable with a
    // password here either. The same uniform 401, with the real reason in the
    // trail rather than in the body.
    if (!(await isPasswordLoginAllowedForUser(app.db, user.id))) {
      await recordSecurityEvent(app.db, {
        kind: "login_blocked_password_disabled",
        outcome: "blocked",
        userId: user.id,
        email: user.email,
        ip: context.ip,
        userAgent: context.userAgent,
        reason: "A company this account belongs to requires single sign-on",
      });
      throw unauthorized("Invalid credentials");
    }

    // #24 — the tenant IP allowlist. After the password, so it is not an
    // enumeration oracle, and before any token exists.
    await guardLoginIpAllowlist(app, req, user);

    const factor = await activeFactor(app.db, user.id);
    const requiredBy = await companiesRequiringMfa(app.db, user.id);

    if (factor || requiredBy.length > 0) {
      const scope: ChallengeScope = factor ? "verify" : "enrol";
      const minted = mintChallengeToken(cfg, {
        userId: user.id,
        scope,
        ttlMinutes: cfg.MFA_CHALLENGE_TTL_MINUTES,
      });
      // The server-side half. A challenge is now a row that can be spent once
      // and revoked in flight; see challenge-store.ts for why registration is
      // best-effort and the single-use guarantee is not.
      await registerChallenge(app.db, {
        claims: minted.claims,
        origin: "password",
        ip: context.ip,
        userAgent: context.userAgent,
      });
      await recordSecurityEvent(app.db, {
        kind: "login_success",
        outcome: "pending",
        userId: user.id,
        email: user.email,
        ip: context.ip,
        userAgent: context.userAgent,
        reason:
          scope === "enrol"
            ? "Password accepted; tenant policy requires enrolling a second factor"
            : "Password accepted; awaiting second factor",
        metadata: { challengeId: minted.claims.jti, scope },
      });
      // 200, not 401: the password WAS correct. The absence of tokens in this
      // body is the whole answer — there is no session yet.
      return {
        mfaRequired: true,
        ...challengeEnvelope(minted),
        // No user id, no email, no name: a half-authenticated response is
        // still a response to somebody who has not finished proving they are
        // the account holder.
        policy:
          requiredBy.length > 0
            ? { required: true, companies: requiredBy.map((r) => ({ companyId: r.companyId, name: r.name })) }
            : { required: false, companies: [] },
        reasons:
          scope === "enrol"
            ? ["Your organisation requires a second factor and this account has none enrolled."]
            : ["This account has a confirmed second factor."],
      };
    }

    await app.db
      .update(users)
      .set({ lastLoginAt: new Date().toISOString() })
      .where(eq(users.id, user.id));
    await recordLegacyAuthEvent(app.db, {
      userId: user.id,
      email: user.email,
      kind: "login_success",
      ip: context.ip,
      userAgent: context.userAgent,
    });
    // completeLogin, not a bare issueSession: the transparent rehash to the
    // current bcrypt cost, the `login_success` trail row with `newDevice`, and
    // the "someone signed in from a new device" message all live in there, and
    // this route silently did without all three.
    const completed = await completeLogin(app, req, {
      user,
      password: body.password,
      policy,
    });
    return {
      mfaRequired: false,
      user: { id: user.id, email: user.email, name: user.name },
      accessToken: completed.accessToken,
      refreshToken: completed.refreshToken,
      expiresIn: completed.expiresIn,
      sessionId: completed.sessionId,
      session: completed.session,
    };
  });

  /**
   * Provision a seed for a holder of an ENROL-scope challenge.
   *
   * This is the one route that hands out a TOTP seed without a session, and it
   * is the direct consequence of refusing to answer a policy-blocked login with
   * a bare 403: the user gave the right password, their tenant requires MFA,
   * and they must be able to get from there to a working account. The authority
   * is the challenge token — signed, ten minutes old at most, and scoped so a
   * `verify` challenge cannot be redeemed here.
   */
  app.post("/auth/mfa/challenge/enrol", authLimited, async (req, reply) => {
    const body = challengeEnrolSchema.parse(req.body);
    const context = requestContext(req);
    const verified = verifyChallengeToken(cfg, body.challengeToken);
    if (!verified.claims) throw unauthorized("Challenge is not valid");
    if (verified.claims.scope !== "enrol") {
      throw badRequest("This challenge does not carry enrolment authority.", {
        reasons: ["Only an `enrol` challenge may provision a new second factor."],
      });
    }
    // A seed must not be minted against authority that has already been spent
    // or cut. The challenge is READ here, never consumed: the same challenge
    // has to survive to confirm the factor it is about to provision.
    const live = await assertChallengeLive(app.db, verified.claims.jti, Date.now());
    if (!live.ok) {
      await recordSecurityEvent(app.db, {
        kind: "mfa_challenge_failure",
        outcome: "failure",
        userId: verified.claims.uid,
        ip: context.ip,
        userAgent: context.userAgent,
        reason: live.reason ?? "Challenge is no longer live",
        metadata: { challengeId: verified.claims.jti, verdict: live.code },
      });
      throw unauthorized(live.reason ?? "Challenge is not valid");
    }
    const user = await loadActiveUser(verified.claims.uid);
    const provisioned = await provisionFactor(user);
    await recordSecurityEvent(app.db, {
      kind: "mfa_enrol_started",
      outcome: "pending",
      userId: user.id,
      email: user.email,
      ip: context.ip,
      userAgent: context.userAgent,
      reason: "Enrolment forced by tenant policy during sign-in",
      metadata: { mfaId: provisioned.mfaId, challengeId: verified.claims.jti },
    });
    return reply.status(201).send({
      ...provisioned,
      status: "pending",
      confirmWith: "POST /api/v1/auth/mfa/challenge",
      reasons: ["Confirm a code from this seed to finish signing in."],
    });
  });

  /**
   * Exchange a challenge for a session.
   *
   * `verify` — prove the confirmed factor with a TOTP code or a recovery code.
   * `enrol`  — prove the seed just provisioned; confirming it both activates
   *            the factor and completes the sign-in, so a policy-forced
   *            enrolment is one round trip rather than a sign-in that fails
   *            and has to be repeated.
   */
  app.post("/auth/mfa/challenge", authLimited, async (req) => {
    const body = challengeSchema.parse(req.body);
    const context = requestContext(req);
    const verified = verifyChallengeToken(cfg, body.challengeToken);
    if (!verified.claims) {
      await recordSecurityEvent(app.db, {
        kind: "mfa_challenge_failure",
        outcome: "failure",
        ip: context.ip,
        userAgent: context.userAgent,
        reason: verified.reasons[0] ?? "Challenge rejected",
      });
      throw unauthorized("Challenge is not valid");
    }
    const claims = verified.claims;
    const user = await loadActiveUser(claims.uid);
    const existing = await activeFactor(app.db, user.id);

    // An `enrol` challenge whose factor has since been confirmed elsewhere —
    // another tab, another device — is redeemed as a `verify`, not refused.
    // The holder did exactly what was asked of them; a 409 here would strand a
    // legitimate sign-in on a race the user cannot see.
    if (claims.scope === "enrol" && !existing) {
      if (body.recoveryCode) {
        throw badRequest("A new enrolment has no recovery codes yet.", {
          reasons: ["Confirm the seed with a code from the authenticator app."],
        });
      }
      if (!body.code) {
        throw badRequest("Provide the six-digit code from your authenticator app.", {
          reasons: ["An `enrol` challenge is completed with `code`."],
        });
      }
      const result = await confirmFactor(user, body.code, {
        ...context,
        purpose: "challenge_enrol",
      });
      const session = await completeSignIn(user, "password", claims, context);
      return {
        ...session,
        mfa: {
          status: "active",
          confirmedAt: result.confirmedAt,
          method: "totp",
          recoveryCodes: result.issued.codes,
          recoveryCodesRemaining: result.issued.remaining,
          warning:
            "These recovery codes are shown once. Store them somewhere safe — they cannot be retrieved again.",
        },
      };
    }

    const factor = existing;
    if (!factor) {
      // The factor was disabled between minting the challenge and redeeming
      // it. Refusing rather than falling through to a session is the point:
      // the challenge was issued on the strength of a factor that no longer
      // exists, so it entitles the holder to nothing.
      throw unauthorized("This challenge no longer matches an enrolled second factor");
    }
    const outcome = await assertFactor(
      app.db,
      cfg,
      factor,
      { code: body.code, recoveryCode: body.recoveryCode },
      { ip: context.ip, userAgent: context.userAgent, purpose: "login_challenge" },
    );
    const session = await completeSignIn(
      user,
      outcome.method === "recovery_code" ? "recovery_code" : "password",
      claims,
      context,
    );
    return {
      ...session,
      mfa: {
        status: "active",
        method: outcome.method,
        recoveryCodesRemaining: outcome.recoveryCodesRemaining,
        reasons:
          outcome.method === "recovery_code" && outcome.recoveryCodesRemaining === 0
            ? ["That was your last recovery code. Generate a new set."]
            : [],
      },
    };
  });

  async function loadActiveUser(userId: string) {
    const rows = await app.db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];
    if (!user || !user.isActive) throw unauthorized("Unknown or deactivated user");
    return user;
  }

  async function completeSignIn(
    user: { id: string; email: string; name: string },
    authMethod: "password" | "recovery_code",
    challenge: { jti: string; uid: string; scope: ChallengeScope; exp: number },
    context: { ip: string | null; userAgent: string | null },
  ) {
    const challengeId = challenge.jti;
    // SPEND THE CHALLENGE, and do it here — after the factor was proved and
    // before any token exists. Consuming earlier would burn the challenge on
    // a mistyped digit and strand a legitimate user; consuming later would
    // leave a window in which two concurrent exchanges of one challenge both
    // produce a session.
    const spent = await consumeChallenge(app.db, challenge, Date.now());
    if (!spent.ok) {
      await recordSecurityEvent(app.db, {
        kind: "mfa_challenge_failure",
        outcome: "failure",
        userId: user.id,
        email: user.email,
        ip: context.ip,
        userAgent: context.userAgent,
        reason: spent.reason ?? "Challenge could not be spent",
        metadata: { challengeId, verdict: spent.code },
      });
      throw unauthorized(spent.reason ?? "Challenge is not valid");
    }
    const session = await issueSession(app, {
      user: { id: user.id, email: user.email },
      authMethod,
      mfaSatisfied: true,
      ip: context.ip,
      userAgent: context.userAgent,
    });
    await app.db
      .update(users)
      .set({ lastLoginAt: new Date().toISOString() })
      .where(eq(users.id, user.id));
    await recordSecurityEvent(app.db, {
      kind: "login_success",
      userId: user.id,
      email: user.email,
      sessionId: session.sessionId,
      ip: context.ip,
      userAgent: context.userAgent,
      reason: `Second factor satisfied (${authMethod})`,
      metadata: { challengeId, authMethod },
    });
    return {
      user: { id: user.id, email: user.email, name: user.name },
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: session.expiresIn,
      sessionId: session.sessionId,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Tenant policy                                                     */
  /* ---------------------------------------------------------------- */

  app.get(
    "/auth/mfa/policy",
    { preHandler: [app.authenticate, app.requireCompany] },
    async (req) => {
      const companyId = req.companyId!;
      const row = await app.db
        .select({ settings: companies.settings, name: companies.name })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      const policy = readMfaPolicy(row[0]?.settings);
      // Every member may read the POLICY — they are subject to it. Only an
      // owner or admin sees the COVERAGE: "four of us have no second factor"
      // is a target list, and an ordinary member has no reason to hold it.
      const privileged = req.companyRole === "owner" || req.companyRole === "admin";
      return {
        companyId,
        companyName: row[0]?.name ?? null,
        ...policy,
        coverage: privileged ? await enrolmentCoverage(companyId) : null,
        reasons: privileged ? [] : ["Enrolment coverage is visible to owners and admins only."],
      };
    },
  );

  app.put(
    "/auth/mfa/policy",
    {
      preHandler: [
        app.authenticate,
        app.requireCompany,
        app.requireCompanyRole(["owner", "admin"]),
      ],
    },
    async (req) => {
      const user = requireUser(req);
      const companyId = req.companyId!;
      const body = policySchema.parse(req.body);
      const context = requestContext(req);
      const rows = await app.db
        .select({ settings: companies.settings, name: companies.name })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      const current = rows[0];
      if (!current) throw conflict("Company not found");
      const previous = readMfaPolicy(current.settings);
      const nowIso = new Date().toISOString();
      const next = { required: body.required, updatedAt: nowIso, updatedBy: user.id };
      await app.db
        .update(companies)
        .set({
          // Merge, never replace: `settings` is a shared blob and other
          // modules keep their own keys in it.
          settings: { ...(current.settings ?? {}), mfa: next },
          updatedAt: nowIso,
        })
        .where(eq(companies.id, companyId));

      await appendLedger(app.db, {
        companyId,
        actorId: user.id,
        action: "state_change",
        objectType: "company_mfa_policy",
        objectId: companyId,
        payload: { required: body.required, previous: previous.required, at: nowIso },
        storePayload: true,
      });
      // AND a security-trail row, under its OWN name. This used to be a note
      // explaining why the change could not be recorded here: AUTH_EVENT_KINDS
      // had no `mfa_policy_changed` member, `enums.ts` is frozen, and
      // borrowing a neighbouring kind would have put a false statement into
      // the one log an auditor reads literally. `enums-auth.ts` now carries
      // the kind and `recordSecurityEvent` accepts the widened union, so the
      // gap is closed rather than described. The ledger entry above remains
      // the stronger record; this one is what the tenant's SIEM receives.
      const policyCtx = requestContext(req);
      await recordSecurityEvent(app.db, {
        kind: "mfa_policy_changed",
        companyId,
        userId: user.id,
        email: user.email,
        ip: policyCtx.ip,
        userAgent: policyCtx.userAgent,
        reason: body.required
          ? "Second factor is now required for every member of this company"
          : "Second factor is no longer required for this company",
        metadata: { required: body.required, previous: previous.required },
      });

      const coverage = await enrolmentCoverage(companyId);
      return {
        companyId,
        companyName: current.name,
        ...next,
        coverage,
        reasons:
          body.required && coverage.enrolled < coverage.members
            ? [
                `${coverage.members - coverage.enrolled} of ${coverage.members} members have no confirmed second factor; they will be required to enrol at their next sign-in.`,
              ]
            : [],
      };
    },
  );

  /** How much of the tenant actually holds a confirmed factor. Counted, never
   *  estimated: an admin turning the policy on deserves the real number, and a
   *  guess here would be a fabricated figure in a security decision. */
  async function enrolmentCoverage(companyId: string) {
    const members = await app.db
      .select({ userId: companyMemberships.userId })
      .from(companyMemberships)
      .where(eq(companyMemberships.companyId, companyId));
    if (members.length === 0) return { members: 0, enrolled: 0, notEnrolled: 0 };
    const enrolledRows = await app.db
      .select({ userId: userMfa.userId })
      .from(userMfa)
      .where(
        and(
          inArray(
            userMfa.userId,
            members.map((m) => m.userId),
          ),
          eq(userMfa.status, "active"),
        ),
      );
    const enrolled = new Set(enrolledRows.map((r) => r.userId)).size;
    return { members: members.length, enrolled, notEnrolled: members.length - enrolled };
  }

  /* ---------------------------------------------------------------- */
  /* Scheduled work                                                    */
  /* ---------------------------------------------------------------- */

  // `mfa_challenges` gains a row per sign-in into a tenant that requires a
  // second factor, and every one of them is dead within ten minutes. Deleting
  // them on a read would put an unbounded DELETE on the login path; this is
  // the job that keeps the table the size of the last hour.
  app.scheduler.register({
    name: "mfa.challenge-sweep",
    description: "Delete spent and expired MFA challenges past their grace window",
    everyMs: 15 * 60_000,
    run: async ({ db, now }) => ({ deleted: await sweepExpiredChallenges(db, now.getTime()) }),
  });
};

/* ------------------------------------------------------------------ */
/* The public surface other modules build against                      */
/* ------------------------------------------------------------------ */

/**
 * `requireStepUp` is exported and wired to nothing. Adoption is the route
 * owner's decision, taken in the route owner's file; see STEP_UP_ACTIONS for
 * the six candidates and the argument for each.
 */
export {
  requireStepUp,
  STEP_UP_ACTIONS,
  STEP_UP_HEADER,
  STEP_UP_RECOVERY_HEADER,
  STEP_UP_PATH,
  MFA_ENROL_PATH,
  type StepUpAction,
  type StepUpOptions,
} from "./step-up.js";

/**
 * For the identity module, if and when it adopts MFA on its own
 * `POST /auth/login`: `activeFactor` answers "does this account have a
 * confirmed second factor", `companiesRequiringMfa` answers "does policy
 * demand one", and `mintChallengeToken`/`challengeEnvelope` produce the exact
 * body `POST /auth/mfa/login` returns, so both routes speak one protocol.
 */
export { activeFactor, companiesRequiringMfa, lastAssertion, TOTP_WINDOW } from "./service.js";
export { challengeEnvelope, mintChallengeToken, verifyChallengeToken } from "./challenge.js";
export type { ChallengeEnvelope, ChallengeScope } from "./challenge.js";

/* ------------------------------------------------------------------ */
/* NOTES — what this module does not own, and what it therefore leaves  */
/*         to the owners of the files around it                         */
/* ------------------------------------------------------------------ */

/**
 * 1. `POST /auth/login` (modules/identity/index.ts) STILL RETURNS A SESSION
 *    for an account with a confirmed second factor. This module cannot change
 *    it — the route is another owner's — so MFA is enforced on
 *    `POST /auth/mfa/login`, which is byte-for-byte the same request and
 *    returns a challenge instead. Until the identity module adopts the same
 *    branch, a client that keeps calling the old route bypasses MFA. The
 *    adoption is four lines and everything it needs is exported below:
 *
 *      const factor = await activeFactor(app.db, user.id);
 *      const requiredBy = await companiesRequiringMfa(app.db, user.id);
 *      if (factor || requiredBy.length > 0) {
 *        return { mfaRequired: true, ...challengeEnvelope(
 *          mintChallengeToken(app.appConfig, {
 *            userId: user.id,
 *            scope: factor ? "verify" : "enrol",
 *            ttlMinutes: app.appConfig.MFA_CHALLENGE_TTL_MINUTES,
 *          })) };
 *      }
 *
 *    Both routes then speak one protocol and redeem at the same
 *    `POST /auth/mfa/challenge`.
 *
 * 2. RESOLVED. `mfa_policy_changed` is now a member of EXTRA_AUTH_EVENT_KINDS
 *    (packages/shared/src/enums-auth.ts, which this package owns) and
 *    `SecurityEventInput.kind` accepts the widened union, so the tenant policy
 *    change is recorded in `auth_security_events` under its own name AND in
 *    the hash-chained ledger. Nothing is written under a borrowed kind.
 *
 * 3. RESOLVED. The challenge token is still a stateless MAC — that is what
 *    lets three modules mint one without coordinating — but it now names a row
 *    in `mfa_challenges` (packages/db/src/schema/auth.ts). Consumption is an
 *    upsert on the token's own `jti`, so a challenge is SINGLE-USE even when
 *    the minting module never registered it, and an administrator can revoke
 *    one in flight (`admin_mfa_reset` does). See challenge-store.ts for why
 *    the store fails open on an infrastructure error and closed on a replay.
 *
 * 4. `requireStepUp` is wired to NOTHING here. The six routes that should
 *    adopt it live in modules this one does not own; STEP_UP_ACTIONS carries
 *    the catalogue and the argument for each.
 */
