import {
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
 * Vol I §0.7 — Integration & extensibility: webhooks (#121) and OAuth2 for
 * machine callers (#120).
 *
 * The webhook emitter has one natural source: the ledger append path already
 * observes every consequential mutation on the platform, so subscribing to
 * "what happened" means subscribing to ledger entries rather than to a
 * hand-maintained event taxonomy that drifts from the truth.
 *
 * Neither table stores a usable secret. A webhook signing secret is derived
 * from an env-held master key plus the endpoint id (HKDF), shown once at
 * creation and re-derivable at send time; OAuth client secrets and issued
 * access tokens are stored as SHA-256 hashes only.
 */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    /** ledger entry kinds to deliver; empty = every kind */
    eventKinds: jsonb("event_kinds").$type<string[]>().default([]).notNull(),
    /** optional narrowing to one project */
    projectId: text("project_id"),
    isActive: integer("is_active").default(1).notNull(),
    /** sha256 of the derived secret, so the operator can confirm a match */
    secretFingerprint: text("secret_fingerprint").notNull(),
    /** consecutive failures; endpoints auto-disable past the threshold */
    failureCount: integer("failure_count").default(0).notNull(),
    disabledReason: text("disabled_reason"),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true, mode: "string" }),
    lastStatus: text("last_status"),
    /* ------------------ WP-ANALYTICS: the upgrade wave ----------------- */
    /**
     * SECRET ROTATION. The signing secret is HKDF(masterKey, salt=id:vN), so
     * rotating it is an increment of this counter. During the grace window
     * both versions are computed and BOTH signatures are sent, so a receiver
     * can adopt the new secret without dropping a delivery.
     */
    secretVersion: integer("secret_version").default(1).notNull(),
    previousSecretVersion: integer("previous_secret_version"),
    secretGraceUntil: timestamp("secret_grace_until", { withTimezone: true, mode: "string" }),
    /**
     * CIRCUIT BREAKER. Consecutive transport errors (not HTTP failures — a
     * receiver answering 500 is alive) trip the breaker; while it is open the
     * endpoint is skipped by the drain so one dead receiver cannot consume the
     * delivery budget of every other tenant.
     */
    consecutiveErrors: integer("consecutive_errors").default(0).notNull(),
    circuitOpenUntil: timestamp("circuit_open_until", { withTimezone: true, mode: "string" }),
    /** the last resolved address the URL was verified against (SSRF guard) */
    verifiedHost: text("verified_host"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("webhook_endpoints_company_idx").on(t.companyId),
    index("webhook_endpoints_active_idx").on(t.isActive, t.circuitOpenUntil),
  ],
);

/**
 * One delivery attempt record per endpoint per event. Deliveries are queued,
 * signed and retried with backoff; the log is the operator's evidence of what
 * left the platform and what the receiver said.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    endpointId: text("endpoint_id").notNull(),
    /** the ledger entry that produced this event */
    ledgerEntryId: text("ledger_entry_id"),
    eventKind: text("event_kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    /** hex HMAC-SHA256 over the canonical payload, sent as a header */
    signature: text("signature").notNull(),
    status: text("status").default("pending").notNull(), // WebhookDeliveryStatus
    attempts: integer("attempts").default(0).notNull(),
    nextAttemptAt: text("next_attempt_at"),
    responseStatus: integer("response_status"),
    /** truncated server-side — a receiver's body is not a place to store data */
    responseBody: text("response_body"),
    error: text("error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "string" }),
    /**
     * LEASE. A delivery is CLAIMED before it is attempted, with a conditional
     * update that only one process can win. Without it every API replica drains
     * the same rows and every receiver is delivered to N times — the exact
     * duplicate deployment.md called safe.
     */
    leaseUntil: timestamp("lease_until", { withTimezone: true, mode: "string" }),
    leaseOwner: text("lease_owner"),
    /** which secret version signed `signature` (and `signatureNext` during rotation) */
    secretVersion: integer("secret_version").default(1).notNull(),
    signatureNext: text("signature_next"),
    createdAt: createdAt(),
  },
  (t) => [
    index("webhook_deliveries_endpoint_idx").on(t.endpointId),
    index("webhook_deliveries_status_idx").on(t.status),
    /** the drain's query: due rows, oldest first, across endpoints */
    index("webhook_deliveries_due_idx").on(t.status, t.nextAttemptAt),
    /** the operator's query and the retention sweep's */
    index("webhook_deliveries_company_idx").on(t.companyId, t.status, t.createdAt),
  ],
);

/**
 * An ERP mapping profile (#130-133). ConstructOS does not pretend to speak
 * Sage 300 CRE, Viewpoint Vista or QuickBooks natively; it speaks a canonical
 * AP/AR shape and lets an integrator declare, per system, which canonical field
 * lands in which column of that system's import file. The profile is data, so a
 * new ERP is a row rather than a release.
 */
export const integrationExportProfiles = pgTable(
  "integration_export_profiles",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    name: text("name").notNull(),
    /** sage300 | viewpoint | quickbooks | generic */
    system: text("system").notNull(),
    /** ap_invoices | job_cost | payments */
    feed: text("feed").notNull(),
    /** [{ target: "Vendor", source: "vendorReference", constant?: "…" }] */
    fieldMap: jsonb("field_map").$type<unknown[]>().default([]).notNull(),
    /** csv | json */
    format: text("format").default("csv").notNull(),
    /** written verbatim into the export header comment */
    notes: text("notes"),
    isActive: integer("is_active").default(1).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("integration_export_profiles_company_idx").on(t.companyId, t.feed)],
);

/**
 * Developer sandbox tenants (#123). A tenant marked sandbox is a place to
 * exercise the API without consequences, and every surface that could carry the
 * consequence elsewhere says so: exports carry a SANDBOX banner, webhook
 * envelopes carry `sandbox: true`, and a sandbox company may not contribute to
 * the cross-tenant benchmark pool at all.
 */
export const developerSandboxes = pgTable(
  "developer_sandboxes",
  {
    companyId: text("company_id").primaryKey(),
    /** free text: what this sandbox is for */
    purpose: text("purpose"),
    enabledBy: text("enabled_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
);

/** An OAuth2 client-credentials machine caller (#120). */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    name: text("name").notNull(),
    clientId: text("client_id").notNull(),
    /** sha256 only — the secret is shown once at creation and never again */
    clientSecretHash: text("client_secret_hash").notNull(),
    /** tool:level pairs this client may exercise, never more than its creator */
    scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
    grantTypes: jsonb("grant_types").$type<string[]>().default(["client_credentials"]).notNull(),
    /** access token lifetime in seconds */
    tokenTtlSeconds: integer("token_ttl_seconds").default(3600).notNull(),
    isActive: integer("is_active").default(1).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("oauth_clients_client_id_idx").on(t.clientId),
    index("oauth_clients_company_idx").on(t.companyId),
  ],
);

/** An issued access token. Stored hashed; revocable before expiry. */
export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    clientId: text("client_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
    issuedAt: createdAt(),
  },
  (t) => [
    index("oauth_access_tokens_hash_idx").on(t.tokenHash),
    index("oauth_access_tokens_client_idx").on(t.clientId),
  ],
);
