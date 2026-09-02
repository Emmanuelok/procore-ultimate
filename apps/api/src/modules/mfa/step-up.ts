import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError, unauthorized } from "../../lib/errors.js";
import type { PreHandler } from "../../types.js";
import {
  activeFactor,
  assertFactor,
  lastAssertion,
  recordSecurityEvent,
  requestContext,
  type AssertionFreshness,
} from "./service.js";

/**
 * STEP-UP AUTHENTICATION — a fresh second-factor assertion in front of the
 * actions that cannot be undone.
 *
 * A session is a claim about who you were when you signed in, hours ago, on a
 * device that may since have been left unlocked in a site office. That is
 * ample for reading a drawing and far too weak for sealing a ledger. Step-up
 * closes the gap by asking, at the moment of the dangerous action, for proof
 * that the person holding the session is still the account holder.
 *
 * WHAT COUNTS AS FRESH. Any successful second-factor assertion within
 * `withinMinutes` — signing in with MFA a minute ago counts, so a user is not
 * asked twice in a row for no reason. The freshness is read from
 * `auth_security_events` rather than from a claim inside the access token: see
 * `lastAssertion` in service.ts for why a token claim cannot be revoked and a
 * trail read can.
 *
 * TWO WAYS TO SATISFY IT, both handled here:
 *   1. Ahead of time — `POST /api/v1/auth/mfa/step-up` with a code, then make
 *      the request. Suits a client that wants one prompt covering a short
 *      sequence of dangerous operations.
 *   2. Inline — send `x-mfa-code` (or `x-mfa-recovery-code`) on the dangerous
 *      request itself. Suits a single irreversible click, and means adopting
 *      step-up on a route costs the client one header rather than a new flow.
 *
 * WHAT IT REFUSES, and why each is a distinct answer rather than a flat 403:
 *   - a MACHINE caller (OAuth2 client credentials). A machine has no second
 *     factor and never will; if an action is dangerous enough to need step-up
 *     it is too dangerous to be driven by a client-credentials token. 403,
 *     `machine_caller_cannot_step_up`.
 *   - a user with NO active factor. 403, `mfa_enrolment_required`, naming the
 *     enrolment route — a user who has never enrolled needs a way forward, not
 *     a dead end.
 *   - a user whose last assertion is stale. 403, `step_up_required`, naming
 *     the step-up route and the window.
 *
 * ADOPTION. This module deliberately wires it to NOTHING. It is exported for
 * the owners of the routes below to adopt, because bolting a new refusal onto
 * someone else's route from outside is how an auth change takes down a
 * platform. `STEP_UP_ACTIONS` is the catalogue, with the argument for each.
 */

/**
 * The actions this platform should put behind a fresh second factor.
 *
 * The test each one passes: it is either IRREVERSIBLE, or it MOVES MONEY, or
 * it MINTS AN AUTHORITY THAT OUTLIVES THE SESSION. Nothing else belongs here —
 * a step-up prompt on an ordinary action trains people to approve prompts.
 */
export const STEP_UP_ACTIONS = {
  /**
   * Sealing a period of the hash-chained ledger. The seal is the artefact the
   * whole assurance product rests on and it is anchored externally: once
   * published it cannot be withdrawn, only contradicted. An attacker who can
   * seal can freeze a record they have just falsified.
   */
  "ledger.seal": "Seal a ledger period",
  /**
   * Issuing an escrow receipt. It is a financial instrument a third party
   * relies on; a fraudulent one is money out of the door with a document
   * saying it was owed.
   */
  "escrow.receipt.issue": "Issue an escrow receipt",
  /**
   * Minting an API token or an OAuth client. This is the action that converts
   * a stolen session into PERSISTENT access: the session expires, the token
   * does not, and the token is not tied to the device that made it.
   */
  "credential.mint": "Mint an API token or OAuth client",
  /**
   * Executing a change order. It changes the contract sum and the programme —
   * the two numbers every downstream claim, valuation and dispute is computed
   * from — and executing it is the point of no return.
   */
  "change_order.execute": "Execute a change order",
  /**
   * Approving a payment. Money leaves. There is no second control between the
   * approval and the transfer that the approver does not also hold.
   */
  "payment.approve": "Approve a payment",
  /**
   * Revoking a user, or removing them from a tenant. The classic attacker move
   * after taking one account is to cut off the people who would notice, so the
   * action that silences the alarm must itself be the hardest one.
   */
  "user.revoke": "Revoke a user or a membership",
} as const;

export type StepUpAction = keyof typeof STEP_UP_ACTIONS;

export interface StepUpOptions {
  /** catalogue key, or any string for an action not yet catalogued */
  action: StepUpAction | (string & {});
  /**
   * How fresh the assertion must be. Defaults to MFA_CHALLENGE_TTL_MINUTES,
   * which is the same window the platform already considers "just proved it".
   */
  withinMinutes?: number;
  /** allow `x-mfa-code` / `x-mfa-recovery-code` on the request itself */
  allowInlineCode?: boolean;
}

export const STEP_UP_HEADER = "x-mfa-code";
export const STEP_UP_RECOVERY_HEADER = "x-mfa-recovery-code";
export const STEP_UP_PATH = "/api/v1/auth/mfa/step-up";
export const MFA_ENROL_PATH = "/api/v1/auth/mfa/enrol";

declare module "fastify" {
  interface FastifyRequest {
    /** set by `requireStepUp` once a fresh assertion has been established */
    stepUp?: {
      action: string;
      assertedAt: string;
      withinMinutes: number;
      method: "totp" | "recovery_code" | "recent_assertion";
    };
  }
}

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build the preHandler. Must run AFTER `app.authenticate` — it reads
 * `req.user`, and a step-up gate in front of the authentication gate would be
 * asking an anonymous caller to prove a second factor.
 */
export function requireStepUp(app: FastifyInstance, options: StepUpOptions): PreHandler {
  const withinMinutes = options.withinMinutes ?? app.appConfig.MFA_CHALLENGE_TTL_MINUTES;
  const allowInline = options.allowInlineCode ?? true;
  const action = options.action;

  return async (req: FastifyRequest) => {
    if (!req.user) throw unauthorized("Step-up requires an authenticated user");

    if (req.machineClient) {
      throw new AppError(
        403,
        "This action requires a fresh second-factor assertion, which a machine caller cannot provide.",
        {
          code: "machine_caller_cannot_step_up",
          action,
          reasons: [
            "OAuth2 client-credentials callers hold no second factor.",
            "Perform this action as a human user with MFA enrolled.",
          ],
        },
      );
    }

    const context = requestContext(req);
    const factor = await activeFactor(app.db, req.user.id);
    if (!factor) {
      await recordSecurityEvent(app.db, {
        kind: "mfa_challenge_failure",
        outcome: "blocked",
        userId: req.user.id,
        companyId: req.companyId ?? null,
        email: req.user.email,
        ip: context.ip,
        userAgent: context.userAgent,
        reason: `Step-up refused for ${action}: no active second factor`,
        metadata: { purpose: "step_up", action },
      });
      throw new AppError(
        403,
        "This action requires a second factor, and this account has none enrolled.",
        {
          code: "mfa_enrolment_required",
          action,
          enrolPath: MFA_ENROL_PATH,
          reasons: [
            "No confirmed TOTP factor is enrolled on this account.",
            `Enrol one at ${MFA_ENROL_PATH} before performing this action.`,
          ],
        },
      );
    }

    const inlineCode = allowInline ? headerValue(req, STEP_UP_HEADER) : undefined;
    const inlineRecovery = allowInline ? headerValue(req, STEP_UP_RECOVERY_HEADER) : undefined;
    if (inlineCode || inlineRecovery) {
      const outcome = await assertFactor(
        app.db,
        app.appConfig,
        factor,
        { code: inlineCode, recoveryCode: inlineRecovery },
        {
          ip: context.ip,
          userAgent: context.userAgent,
          purpose: "step_up",
          companyId: req.companyId ?? null,
        },
      );
      req.stepUp = {
        action: String(action),
        assertedAt: new Date().toISOString(),
        withinMinutes,
        method: outcome.method,
      };
      return;
    }

    const freshness = await lastAssertion(app.db, req.user.id, withinMinutes);
    if (!freshness.satisfied) {
      await recordSecurityEvent(app.db, {
        kind: "mfa_challenge_failure",
        outcome: "blocked",
        userId: req.user.id,
        companyId: req.companyId ?? null,
        email: req.user.email,
        ip: context.ip,
        userAgent: context.userAgent,
        reason: `Step-up refused for ${action}: last assertion is not within ${withinMinutes} minutes`,
        metadata: { purpose: "step_up", action, lastAssertedAt: freshness.assertedAt },
      });
      throw stepUpRequired(action, freshness);
    }

    req.stepUp = {
      action: String(action),
      assertedAt: freshness.assertedAt ?? new Date().toISOString(),
      withinMinutes,
      method: "recent_assertion",
    };
  };
}

function stepUpRequired(action: string, freshness: AssertionFreshness): AppError {
  return new AppError(403, "This action requires a fresh second-factor assertion.", {
    code: "step_up_required",
    action,
    withinMinutes: freshness.withinMinutes,
    lastAssertedAt: freshness.assertedAt,
    stepUpPath: STEP_UP_PATH,
    inlineHeader: STEP_UP_HEADER,
    reasons: [
      freshness.assertedAt === null
        ? "No second-factor assertion has been recorded for this account."
        : `Last second-factor assertion was at ${freshness.assertedAt}, outside the ${freshness.withinMinutes}-minute window.`,
    ],
  });
}
