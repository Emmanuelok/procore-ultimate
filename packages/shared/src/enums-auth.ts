/**
 * Shared enums for the auth area (platform upgrade wave, WP-AUTH).
 *
 * WHY THERE IS A SECOND AUTH ENUM FILE. `enums.ts` owns AUTH_EVENT_KINDS,
 * MFA_METHODS and the rest, and it is frozen for the duration of this wave —
 * a parallel package editing it would conflict with every other package's
 * edit of the same file. The unions below are therefore ADDITIVE: the columns
 * they describe are `text`, and every reader accepts the union of both files.
 *
 * The one that matters is EXTRA_AUTH_EVENT_KINDS. `auth_security_events.kind`
 * is the log an auditor reads literally, so a new kind of event must not be
 * recorded under a neighbouring kind's name to make it fit the existing enum —
 * that is a false statement in the one place false statements are unrecoverable.
 * The MFA module said exactly this in a code comment and then wrote nothing at
 * all for a tenant policy change. These kinds close that gap.
 */

/**
 * Security events this wave records that `AUTH_EVENT_KINDS` has no member for.
 * Read together with it: `AnyAuthEventKind` is the type every writer accepts.
 */
export const EXTRA_AUTH_EVENT_KINDS = [
  /** #24 — a sign-in refused because the address is outside the tenant allowlist */
  "login_blocked_ip",
  /** #23/#24/#25 — an administrator changed the tenant security policy */
  "security_policy_changed",
  /** the tenant MFA requirement was turned on or off */
  "mfa_policy_changed",
  /** a session ended because it sat idle longer than the tenant permits */
  "session_idle_timeout",
  /** #25 — a password change refused because the password had been used before */
  "password_reuse_refused",
  /** #21 — SCIM created or updated a user */
  "scim_user_provisioned",
  /** #21 — SCIM set active:false, or removed the member */
  "scim_user_deactivated",
  /** #21 — SCIM changed a user's group membership / role */
  "scim_group_changed",
  /** a SCIM bearer token was minted or revoked */
  "scim_token_changed",
  /** an administrator deactivated or reactivated an account */
  "account_deactivated",
  "account_reactivated",
  /** an administrator revoked someone else's sessions */
  "admin_sessions_revoked",
  /** an administrator cleared someone's second factor, forcing re-enrolment */
  "admin_mfa_reset",
  /** a security webhook endpoint was created, changed or removed */
  "security_webhook_changed",
  /** consecutive delivery failures took a security webhook out of service */
  "security_webhook_disabled",
  /** an email-address change was applied after the new address was proved */
  "email_changed",
] as const;
export type ExtraAuthEventKind = (typeof EXTRA_AUTH_EVENT_KINDS)[number];

/**
 * How a tenant's IP allowlist behaves. `monitor` exists because an allowlist
 * typed from memory locks people out, and the honest way to introduce one is
 * to record what WOULD have been refused for a week before refusing it.
 */
export const IP_ALLOWLIST_MODES = ["off", "monitor", "enforce"] as const;
export type IpAllowlistMode = (typeof IP_ALLOWLIST_MODES)[number];

/** Lifecycle of one security-webhook delivery attempt. */
export const SECURITY_WEBHOOK_STATUSES = [
  "pending",
  "delivered",
  "failed",
  /** never left the platform: the destination failed the SSRF policy */
  "refused",
] as const;
export type SecurityWebhookStatus = (typeof SECURITY_WEBHOOK_STATUSES)[number];

/** Why a password hash was retired into `password_history`. */
export const PASSWORD_HISTORY_REASONS = [
  "changed",
  "reset",
  "invitation",
  "admin",
] as const;
export type PasswordHistoryReason = (typeof PASSWORD_HISTORY_REASONS)[number];

/** SCIM 2.0 resources this platform implements. */
export const SCIM_RESOURCE_TYPES = ["User", "Group"] as const;
export type ScimResourceType = (typeof SCIM_RESOURCE_TYPES)[number];

/**
 * The platform's own defaults, published so the policy page can show what a
 * tenant that has chosen nothing is actually subject to. Every one of these is
 * a number the code applies today, not an aspiration.
 */
export const SECURITY_POLICY_DEFAULTS = {
  sessionIdleTimeoutMinutes: null,
  sessionAbsoluteTimeoutHours: 30 * 24,
  rememberDeviceDays: 0,
  passwordMinLength: 12,
  passwordRequireComplexity: false,
  passwordHistoryDepth: 0,
  passwordMaxAgeDays: null,
  lockoutMaxAttempts: 5,
  lockoutWindowMinutes: 15,
  lockoutDurationMinutes: 15,
  ipAllowlistMode: "off",
} as const;
