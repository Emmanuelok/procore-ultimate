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
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("webhook_endpoints_company_idx").on(t.companyId)],
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
    createdAt: createdAt(),
  },
  (t) => [
    index("webhook_deliveries_endpoint_idx").on(t.endpointId),
    index("webhook_deliveries_status_idx").on(t.status),
  ],
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
