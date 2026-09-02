import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();

/**
 * Phase 8 — production-grade authentication: SSO, MFA, email verification,
 * password reset, real sessions, real invitations, and the account-security
 * trail. Enums live in packages/shared/src/enums.ts.
 *
 * ------------------------------------------------------------------------
 * DECISION 1 — TWO KINDS OF SECRET, TWO KINDS OF STORAGE
 * ------------------------------------------------------------------------
 * Everywhere else on this platform a credential is stored as a SHA-256 hash
 * and never in usable form: refresh tokens (identity.ts), ingestion API tokens
 * (ingestion.ts), OAuth client secrets and access tokens (integrations.ts).
 * That works because the platform only ever needs to CHECK those values, never
 * to present them to anyone.
 *
 * Two of the secrets here break that assumption:
 *
 *   - an OIDC/OAuth2 CLIENT SECRET must be replayed verbatim to the identity
 *     provider's token endpoint on every login;
 *   - a TOTP SEED must be re-derived on every challenge to compute the
 *     expected six digits.
 *
 * A one-way hash cannot do either. So these two, and only these two, are held
 * reversibly, and the design compensates by moving the key out of the database:
 *
 *   `*_ciphertext`  AES-256-GCM, base64 of `v1.<iv>.<tag>.<ct>`, under a key
 *                   derived (HKDF-SHA256, per-purpose info string) from
 *                   SSO_ENCRYPTION_KEY. When that env var is unset the key
 *                   falls back to AUTH_SECRET — which still defeats a stolen
 *                   database dump, but NOT an attacker who also holds the JWT
 *                   secret. .env.example states that consequence plainly.
 *   `*_key_id`      which key version produced the ciphertext, so rotation is
 *                   a re-encrypt pass and not an outage.
 *   `*_fingerprint` sha256 of the PLAINTEXT, truncated. Lets an operator
 *                   confirm "the secret loaded is the one I pasted" without
 *                   the platform ever displaying it, the same trick
 *                   `webhook_endpoints.secret_fingerprint` uses.
 *
 * `identity_providers.secret_storage` records which route was taken, and the
 * strongest option is the one that stores nothing at all: `reference`, where
 * `client_secret_ref` names an external holder (`env:OKTA_CLIENT_SECRET`,
 * `aws-sm:<arn>`, `vault:<path>`) resolved at request time. A deployment with
 * a secret manager should use it; the encrypted column exists so that a
 * deployment WITHOUT one is not forced into plaintext.
 *
 * Everything else here keeps the hash-only rule, without exception:
 * email_verifications, password_resets, mfa_recovery_codes and
 * user_invitations store `*_hash` and nothing that could be replayed. The raw
 * token exists in exactly two places — the message that was composed, and
 * (for local development, where no transport is configured) the API response
 * that admits it was not dispatched.
 *
 * ------------------------------------------------------------------------
 * DECISION 2 — WHY THIS FILE'S SECURITY LOG IS `auth_security_events`
 * ------------------------------------------------------------------------
 * `auth_events` already exists in identity.ts and is written by the current
 * login routes. It is a thin table — user, email, kind, ip, user agent — with
 * no outcome, no company, no session, no provider and no reason. Widening it
 * would mean editing identity.ts, which this work does not own.
 *
 * So the richer trail is a NEW table, `auth_security_events`, and the old one
 * is left exactly as it is. This is not duplication for its own sake: the two
 * can coexist indefinitely (the old rows stay readable), and a later migration
 * that owns identity.ts can copy the old rows forward and drop it. Every new
 * module in this phase writes `auth_security_events`; nothing new writes
 * `auth_events`. See notes at the foot of this file.
 *
 * ------------------------------------------------------------------------
 * HOUSE RULES THAT APPLY HERE
 * ------------------------------------------------------------------------
 * - Expiry is compared as an INSTANT, never as a string: every timestamp is
 *   `mode: "string"` and Postgres spells it `2026-08-25 23:00:00+00` while the
 *   application spells it `2026-08-25T23:00:00.000Z`. Use lib/time.ts
 *   `isExpired`. A lexicographic test reads a live token as dead.
 * - Expiry sweeps (invitations, sessions, verification tokens) are LAZY and
 *   IDEMPOTENT on list reads. There is no cron on this platform.
 * - Approval is never self-approval: an invitation's `invited_by` and its
 *   `accepted_user_id` are different people by construction, and a session
 *   revoked by an administrator records `revoked_by` alongside
 *   `revoked_by_user` so "the user signed themselves out" and "an admin cut
 *   them off" are never the same row.
 */

/* ------------------------------------------------------------------ */
/* SSO — per-company identity provider connections                     */
/* ------------------------------------------------------------------ */

/**
 * One SSO connection owned by one tenant. A company may hold several (Google
 * for staff, an OIDC connection for a joint-venture partner), which is why
 * this is a table and not a column on `companies`.
 *
 * `allowed_email_domains` is the control that stops a connection from
 * vacuuming up accounts it has no claim to: an assertion whose email falls
 * outside the list is refused before any user is touched. The list is NOT
 * self-certifying — a tenant that could claim `gmail.com` unchecked could
 * hijack every consumer account on the platform — so `domains_verified_at`
 * records that an operator confirmed the tenant controls those domains, and
 * auto-provisioning must refuse to run while it is null.
 *
 * `allow_password_login` is stored per connection because that is where the
 * decision is made: an enterprise that stands up SSO turns passwords off for
 * its own people. Turning it off is a policy that outlives any single session,
 * so the login route checks it and existing sessions are revoked with reason
 * `sso_policy_changed` rather than being quietly grandfathered.
 */
export const identityProviders = pgTable(
  "identity_providers",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** IdentityProviderKind — google | microsoft | oidc | saml */
    kind: text("kind").notNull(),
    /** shown on the login button: "Sign in with Acme SSO" */
    displayName: text("display_name").notNull(),
    /** URL-safe handle; the SSO start route is /auth/sso/:slug */
    slug: text("slug").notNull(),

    /* --- OIDC --- */
    /** the `iss` every id_token must carry; the anchor of trust for this row */
    issuer: text("issuer"),
    /** .well-known/openid-configuration; endpoints below are cached from it */
    discoveryUrl: text("discovery_url"),
    authorizationUrl: text("authorization_url"),
    tokenUrl: text("token_url"),
    userinfoUrl: text("userinfo_url"),
    jwksUri: text("jwks_uri"),
    /** when discovery was last read, so a stale cache is visible not assumed */
    discoveryFetchedAt: timestamp("discovery_fetched_at", {
      withTimezone: true,
      mode: "string",
    }),
    clientId: text("client_id"),
    /** SsoSecretStorageMode — encrypted | reference | none (PKCE public client) */
    secretStorage: text("secret_storage").default("encrypted").notNull(),
    /** AES-256-GCM envelope, base64 `v1.<iv>.<tag>.<ct>` — see file header */
    clientSecretCiphertext: text("client_secret_ciphertext"),
    /** external holder when secretStorage = reference: env: | aws-sm: | vault: */
    clientSecretRef: text("client_secret_ref"),
    /** which key version encrypted it; rotation re-encrypts and bumps this */
    clientSecretKeyId: text("client_secret_key_id"),
    /** sha256 of the plaintext, truncated — confirm a match, never reveal */
    clientSecretFingerprint: text("client_secret_fingerprint"),
    scopes: jsonb("scopes").$type<string[]>().default(["openid", "email", "profile"]).notNull(),

    /* --- SAML --- */
    samlEntityId: text("saml_entity_id"),
    samlSsoUrl: text("saml_sso_url"),
    /** SamlBinding — http_post | http_redirect */
    samlBinding: text("saml_binding"),
    /** the IdP's signing certificate. PUBLIC by definition — stored as-is. */
    samlCertificatePem: text("saml_certificate_pem"),
    samlWantAssertionsSigned: boolean("saml_want_assertions_signed").default(true).notNull(),

    /* --- Provisioning policy --- */
    /** lowercased domains this connection may assert, e.g. ["acme.com"] */
    allowedEmailDomains: jsonb("allowed_email_domains").$type<string[]>().default([]).notNull(),
    /** operator confirmation of domain control; auto-provision refuses while null */
    domainsVerifiedAt: timestamp("domains_verified_at", { withTimezone: true, mode: "string" }),
    /** create a user on first successful assertion instead of refusing */
    autoProvision: boolean("auto_provision").default(false).notNull(),
    /** CompanyRole given to a provisioned user when no group rule matches */
    defaultCompanyRole: text("default_company_role").default("member").notNull(),
    /** permission template key applied to a provisioned user's project access */
    defaultTemplateKey: text("default_template_key"),
    /** the assertion claim carrying group membership (default "groups") */
    groupClaimName: text("group_claim_name").default("groups").notNull(),
    /** JIT mapping: [{ claimValue, companyRole, templateKey? }] — first match wins */
    groupRoleMappings: jsonb("group_role_mappings").$type<unknown[]>().default([]).notNull(),
    /** may a member of this company still sign in with a password? */
    allowPasswordLogin: boolean("allow_password_login").default(true).notNull(),

    isEnabled: boolean("is_enabled").default(false).notNull(),
    disabledReason: text("disabled_reason"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("identity_providers_slug_uq").on(t.slug),
    // Leading column is the tenant: the hot query is "the enabled connections
    // for THIS company", and an index on a bare boolean is near useless.
    index("identity_providers_company_idx").on(t.companyId, t.isEnabled),
  ],
);

/**
 * The link between a platform user and one external subject.
 *
 * UNIQUE on (provider_id, external_subject) is the whole point: one external
 * account maps to exactly one platform user, so a second user cannot claim the
 * same Google account and inherit its sign-ins. The reverse is deliberately
 * open — a user may hold a Google identity AND a Microsoft identity AND a
 * password, and losing one does not lock them out of the others.
 *
 * `external_subject` is the IdP's stable `sub`, never the email: people change
 * surname, employer and address, and matching on email would hand an account
 * to whoever inherits the mailbox. `email_at_link` records the address as it
 * stood when the link was made, so a later divergence is visible rather than
 * silently overwritten.
 *
 * Unlinking DELETES the row. There is no soft-delete flag, because the unique
 * index would then block the user from ever re-linking that same account; the
 * audit trail of the unlink lives in `auth_security_events`, which is the
 * append-only table built for exactly that.
 */
export const userIdentities = pgTable(
  "user_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    providerId: text("provider_id").notNull(),
    /** denormalised from the provider so tenant scoping needs no join */
    companyId: text("company_id").notNull(),
    /** the IdP's stable subject identifier — never the email address */
    externalSubject: text("external_subject").notNull(),
    /** the address the IdP asserted at link time, for divergence detection */
    emailAtLink: text("email_at_link").notNull(),
    displayName: text("display_name"),
    /** the assertion as received, minus tokens — evidence of what was claimed */
    rawProfile: jsonb("raw_profile").$type<Record<string, unknown>>().default({}).notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    uniqueIndex("user_identities_provider_subject_uq").on(t.providerId, t.externalSubject),
    index("user_identities_user_idx").on(t.userId),
    index("user_identities_company_idx").on(t.companyId),
  ],
);

/* ------------------------------------------------------------------ */
/* Sessions — one row per device, which is what makes revocation real  */
/* ------------------------------------------------------------------ */

/**
 * A real session record per device.
 *
 * `refresh_tokens` alone cannot answer the two questions users actually ask —
 * "what is signed in to my account?" and "sign everything else out" — because
 * a rotated token is a new row with no memory of the device that holds it.
 * This table is the continuity: the session survives refresh-token rotation
 * (`refresh_token_id` is repointed each time), so a device keeps one identity
 * from sign-in to sign-out.
 *
 * `device_fingerprint` is a hash of the coarse device signature (user agent
 * family plus IP network), not a tracking identifier: its only job is to
 * decide whether the "new sign-in from a new device" email is warranted. It is
 * deliberately coarse — a false alarm costs one email, a missed alarm costs an
 * undetected account takeover.
 *
 * `mfa_satisfied_at` sits on the SESSION, not the user: clearing a second
 * factor authorises this device, and a new device must clear it again.
 */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** company context this session was opened in; null = none chosen yet */
    companyId: text("company_id"),
    /** current refresh token; repointed on every rotation, null once revoked */
    refreshTokenId: text("refresh_token_id"),
    /** the external identity used to sign in; null for a password sign-in */
    identityId: text("identity_id"),
    providerId: text("provider_id"),
    /** AuthMethod — password | sso | invitation | recovery_code */
    authMethod: text("auth_method").default("password").notNull(),
    /** when this device cleared its second factor; null = not satisfied */
    mfaSatisfiedAt: timestamp("mfa_satisfied_at", { withTimezone: true, mode: "string" }),

    userAgent: text("user_agent"),
    ip: text("ip"),
    /** human-facing label for the device list, e.g. "Chrome on macOS" */
    deviceLabel: text("device_label"),
    /** coarse hash used only to decide "is this a new device?" */
    deviceFingerprint: text("device_fingerprint"),

    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),

    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    /** true when the account holder ended it themselves — distinct from an
     *  admin cutting them off, which an incident review must be able to tell
     *  apart. `revoked_by` names the actor either way. */
    revokedByUser: boolean("revoked_by_user").default(false).notNull(),
    revokedBy: text("revoked_by"),
    /** SessionRevokeReason */
    revokedReason: text("revoked_reason"),
  },
  (t) => [
    index("auth_sessions_user_idx").on(t.userId),
    index("auth_sessions_refresh_token_idx").on(t.refreshTokenId),
    index("auth_sessions_company_idx").on(t.companyId),
    index("auth_sessions_expires_idx").on(t.expiresAt),
  ],
);

/* ------------------------------------------------------------------ */
/* Single-use tokens — stored as a hash, never in usable form          */
/* ------------------------------------------------------------------ */

/**
 * Email ownership proof. The raw token is generated, hashed, and the hash
 * stored; the raw value goes into the message and nowhere else. A lookup is a
 * hash lookup, so a database read yields nothing an attacker can present.
 *
 * `email` is the address BEING PROVED, which during an email change is not
 * `users.email` — the change is applied only when the new address is proved,
 * so a typo cannot lock anyone out of their account.
 *
 * `consumed_at` makes the token single-use; consumption must be a conditional
 * update (`where consumed_at is null`) rather than read-then-write, or two
 * simultaneous clicks both succeed.
 */
export const emailVerifications = pgTable(
  "email_verifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** the address being proved — may differ from users.email mid-change */
    email: text("email").notNull(),
    /** sha256 of the raw token. The raw token is never stored anywhere. */
    tokenHash: text("token_hash").notNull(),
    /** EmailVerificationPurpose — signup | email_change | reverify */
    purpose: text("purpose").default("signup").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "string" }),
    /** where the request came from, and where it was redeemed */
    requestedIp: text("requested_ip"),
    requestedUserAgent: text("requested_user_agent"),
    consumedIp: text("consumed_ip"),
    /** the recorded/sent message, so "did we ever tell them?" has an answer */
    dispatchId: text("dispatch_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("email_verifications_token_uq").on(t.tokenHash),
    index("email_verifications_user_idx").on(t.userId),
    index("email_verifications_email_idx").on(t.email),
  ],
);

/**
 * Password reset. Same hash-only rule as email verification, plus one extra
 * column that matters: `invalidated_at`. Requesting a second reset must kill
 * the first, or an attacker who triggered a reset an hour ago still holds a
 * live token after the victim completes their own.
 *
 * Note what is NOT here and must not be added: any hint of whether the address
 * exists. The route answers identically either way, and the absence of a row
 * is the only difference — enumeration through a reset form is the oldest way
 * to harvest a user list.
 */
export const passwordResets = pgTable(
  "password_resets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    email: text("email").notNull(),
    /** sha256 of the raw token. Never store a usable token. */
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "string" }),
    /** set when a newer request supersedes this one — one live token per user */
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true, mode: "string" }),
    requestedIp: text("requested_ip"),
    requestedUserAgent: text("requested_user_agent"),
    consumedIp: text("consumed_ip"),
    dispatchId: text("dispatch_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("password_resets_token_uq").on(t.tokenHash),
    index("password_resets_user_idx").on(t.userId),
    index("password_resets_email_idx").on(t.email),
  ],
);

/* ------------------------------------------------------------------ */
/* MFA                                                                 */
/* ------------------------------------------------------------------ */

/**
 * A user's second factor.
 *
 * The TOTP seed is the second of the two secrets that cannot be hashed (see
 * the file header): the platform must re-derive the expected digits on every
 * challenge. It is therefore held as an AES-256-GCM envelope under a key
 * outside the database, and `secret_key_id` names the key version so rotation
 * is possible.
 *
 * `status = pending` is load-bearing. Between "we generated a seed and drew a
 * QR code" and "the user typed a code that matched", the enrolment must not
 * count as a second factor — otherwise a user who closed the tab before
 * scanning is locked out of their own account with no way back.
 *
 * `last_used_step` is replay protection: TOTP codes are valid for a whole time
 * step, so a code observed on the wire can be reused within it unless the
 * accepted step is remembered and steps at or below it refused.
 *
 * The algorithm parameters are stored rather than assumed. A seed provisioned
 * as SHA1/6/30 and verified as SHA256/8/30 fails every time, and the resulting
 * bug report ("MFA just doesn't work") is unanswerable without these columns.
 */
export const userMfa = pgTable(
  "user_mfa",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** MfaMethod — totp (recovery_code lives in its own table) */
    method: text("method").default("totp").notNull(),
    /** AES-256-GCM envelope of the base32 TOTP seed — see file header */
    secretCiphertext: text("secret_ciphertext"),
    secretKeyId: text("secret_key_id"),
    /** what the authenticator app shows as the account label */
    label: text("label"),
    /** provisioning parameters, stored because verification must match them */
    algorithm: text("algorithm").default("SHA1").notNull(),
    digits: integer("digits").default(6).notNull(),
    periodSeconds: integer("period_seconds").default(30).notNull(),
    /** MfaStatus — pending | active | disabled */
    status: text("status").default("pending").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "string" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
    /** highest accepted TOTP time step; steps <= this are refused as replays */
    lastUsedStep: integer("last_used_step"),
    failedAttempts: integer("failed_attempts").default(0).notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "string" }),
    disabledAt: timestamp("disabled_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The unique index leads on user_id, so it already serves "this user's
    // enrolments" — a second index on user_id alone would be dead weight.
    uniqueIndex("user_mfa_user_method_uq").on(t.userId, t.method),
  ],
);

/**
 * Recovery codes — one row per code, not a jsonb array on `user_mfa`.
 *
 * A code has to be consumable exactly once, and a conditional UPDATE on a
 * unique-indexed hash is the only way to make that atomic; rewriting a jsonb
 * array read-modify-write loses a race and lets one code be spent twice.
 * It also means a hash lookup finds the code directly instead of scanning
 * every user's array.
 *
 * `batch_id` is how regeneration works: issuing a new set marks the old batch
 * `revoked_at` in one statement, so printed codes from last year stop working
 * the moment the user asks for new ones.
 */
export const mfaRecoveryCodes = pgTable(
  "mfa_recovery_codes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    mfaId: text("mfa_id").notNull(),
    /** sha256 of the raw code. The raw codes are shown once, at generation. */
    codeHash: text("code_hash").notNull(),
    /** the generation this code belongs to; regenerating revokes the old one */
    batchId: text("batch_id").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "string" }),
    usedIp: text("used_ip"),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("mfa_recovery_codes_hash_uq").on(t.codeHash),
    index("mfa_recovery_codes_user_idx").on(t.userId),
    index("mfa_recovery_codes_batch_idx").on(t.batchId),
  ],
);

/* ------------------------------------------------------------------ */
/* Invitations — the table that makes the existing route real          */
/* ------------------------------------------------------------------ */

/**
 * A pending invitation into a tenant.
 *
 * The directory module's POST /company/users/invite today creates a user with
 * a random password and sends NOTHING — the invited person is never told they
 * exist, and the temporary password is returned to the inviter, who then has a
 * credential for somebody else's account. This table replaces that with the
 * ordinary shape: an invitation record, a hashed single-use token, an expiry,
 * and a message whose dispatch is recorded either way.
 *
 * `token_prefix` mirrors the `api_tokens` idiom — the first few characters,
 * enough for support to identify which invitation someone is holding, useless
 * on their own.
 *
 * `last_dispatch_id` is the honesty hook. When no transport is configured the
 * dispatch row exists with status `recorded`, and the API response says the
 * message was recorded and not dispatched, naming EMAIL_PROVIDER. An
 * invitation that nobody could receive must never look like a success.
 *
 * Acceptance carries the segregation rule: `accepted_user_id` may not equal
 * `invited_by`. Nobody invites themselves into a role.
 */
export const userInvitations = pgTable(
  "user_invitations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    email: text("email").notNull(),
    name: text("name"),
    /** CompanyRole the invitee receives on acceptance */
    role: text("role").default("member").notNull(),
    /** permission template key applied to their project access */
    templateKey: text("template_key"),
    /** optional project memberships created on acceptance: string[] of ids */
    projectIds: jsonb("project_ids").$type<string[]>().default([]).notNull(),
    /** a note from the inviter, included in the message body */
    message: text("message"),

    /** sha256 of the raw invitation token; the raw token is never stored */
    tokenHash: text("token_hash").notNull(),
    /** first 8 chars of the raw token — identification without capability */
    tokenPrefix: text("token_prefix"),
    /** InvitationStatus — pending | accepted | revoked | expired */
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
    /** the user who accepted; must not be invited_by */
    acceptedUserId: text("accepted_user_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    revokedBy: text("revoked_by"),

    invitedBy: text("invited_by").notNull(),
    /** how many times the message has been (re)issued, and when last */
    sendCount: integer("send_count").default(0).notNull(),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true, mode: "string" }),
    /** email_dispatches.id of the most recent attempt — recorded or sent */
    lastDispatchId: text("last_dispatch_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("user_invitations_token_uq").on(t.tokenHash),
    index("user_invitations_company_idx").on(t.companyId),
    index("user_invitations_email_idx").on(t.email),
    index("user_invitations_status_idx").on(t.status),
  ],
);

/* ------------------------------------------------------------------ */
/* Outbound email — the record that keeps the platform honest          */
/* ------------------------------------------------------------------ */

/**
 * Every message the platform composed, whether or not anything left the
 * building.
 *
 * WHAT IS NOT STORED HERE: a usable token. A password-reset body contains a
 * link with a live token in it, and persisting that would undo the entire
 * hash-only design one table over — a database reader could simply read the
 * reset link out of the log and use it. So `body_preview` is the rendered text
 * with token-bearing URLs REDACTED by the transport before the row is written,
 * and `variables` is redacted the same way. The raw link exists in the
 * composed message and, in development where no transport is configured, in
 * the transient API response — never at rest.
 *
 * `status = recorded` means composed and NOT delivered. That is the state the
 * platform is in until EMAIL_PROVIDER is set, and reporting it as `sent` would
 * be the fabrication this codebase refuses everywhere else.
 */
export const emailDispatches = pgTable(
  "email_dispatches",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id"),
    /** the recipient as a platform user, when they are one */
    userId: text("user_id"),
    /** EmailTemplateKey */
    template: text("template").notNull(),
    toEmail: text("to_email").notNull(),
    toName: text("to_name"),
    subject: text("subject").notNull(),
    /** rendered text body with token-bearing URLs redacted — see above */
    bodyPreview: text("body_preview"),
    /** template variables, redacted the same way */
    variables: jsonb("variables").$type<Record<string, unknown>>().default({}).notNull(),

    /** EmailDispatchStatus — recorded | sent | failed | suppressed */
    status: text("status").default("recorded").notNull(),
    /** EmailTransportKind — noop | http | smtp */
    transport: text("transport").default("noop").notNull(),
    /** which provider adapter, when transport = http: resend | postmark */
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    /** why nothing was dispatched, or why it failed — never empty when
     *  status is recorded/failed. Mirrors the metrics `reasons` discipline:
     *  an absent result is explained, not silently zeroed. */
    reasons: jsonb("reasons").$type<string[]>().default([]).notNull(),
    error: text("error"),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true, mode: "string" }),

    /** what this message was about: "user_invitation" / inv id, etc. */
    relatedType: text("related_type"),
    relatedId: text("related_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("email_dispatches_company_idx").on(t.companyId),
    index("email_dispatches_to_idx").on(t.toEmail),
    index("email_dispatches_status_idx").on(t.status),
    index("email_dispatches_related_idx").on(t.relatedType, t.relatedId),
  ],
);

/* ------------------------------------------------------------------ */
/* The account-security trail                                          */
/* ------------------------------------------------------------------ */

/**
 * Append-only security log for accounts.
 *
 * DISTINCT FROM THE ASSURANCE LEDGER, and deliberately so. The ledger records
 * consequential mutations to PROJECT records, is hash-chained and anchored,
 * and exists to settle disputes about the works. This records what happened to
 * ACCOUNTS: who signed in, from where, what failed, what was locked, who
 * linked an identity, who revoked whose session. It is the trail an ISO 27001
 * or SOC 2 auditor asks for, and it is the only one that CAN hold the most
 * important rows of all — a failed login against an address that does not
 * exist has no company and no actor, so it could never be a ledger entry, yet
 * it is exactly what an intrusion investigation needs.
 *
 * Nothing here is ever updated or deleted. `outcome` is separate from `kind`
 * so "every failure in the last hour" is one query across every kind, and
 * `blocked` is kept apart from `failure` because a correct password refused by
 * lockout or by a tenant's password-login policy is a policy event, not a
 * brute-force signal — conflating them turns the security dashboard into
 * noise.
 *
 * See the file header for why this is not the existing `auth_events` table.
 */
export const authSecurityEvents = pgTable(
  "auth_security_events",
  {
    id: text("id").primaryKey(),
    /** null for events with no tenant context (an unknown-email login) */
    companyId: text("company_id"),
    /** null when the attempt named no account we recognise */
    userId: text("user_id"),
    /** the address as typed, so failed attempts are still attributable */
    email: text("email"),
    /** AuthEventKind */
    kind: text("kind").notNull(),
    /** AuthEventOutcome — success | failure | blocked | pending */
    outcome: text("outcome").default("success").notNull(),
    sessionId: text("session_id"),
    providerId: text("provider_id"),
    identityId: text("identity_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    /** why, in prose: "5 failures in 15 minutes", "password login disabled" */
    reason: text("reason"),
    /** structured detail; must not carry a credential or a usable token */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    at: createdAt(),
  },
  (t) => [
    index("auth_security_events_user_idx").on(t.userId, t.at),
    index("auth_security_events_company_idx").on(t.companyId, t.at),
    index("auth_security_events_email_idx").on(t.email),
    index("auth_security_events_kind_idx").on(t.kind, t.outcome),
  ],
);
