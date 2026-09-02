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

/** Tenant: the top-level container. */
export const companies = pgTable("companies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    title: text("title"),
    phone: text("phone"),
    isActive: boolean("is_active").default(true).notNull(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
);

/** User membership in a tenant, with a company-level role. */
export const companyMemberships = pgTable(
  "company_memberships",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(), // CompanyRole
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("company_memberships_uq").on(t.companyId, t.userId),
    index("company_memberships_user_idx").on(t.userId),
  ],
);

/**
 * Project membership. `templateKey` points at a permission template;
 * `overrides` holds per-tool overrides (ToolPermissionMap).
 */
export const projectMemberships = pgTable(
  "project_memberships",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    userId: text("user_id").notNull(),
    templateKey: text("template_key").notNull(),
    overrides: jsonb("overrides").$type<Record<string, string>>().default({}).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("project_memberships_uq").on(t.projectId, t.userId),
    index("project_memberships_user_idx").on(t.userId),
    index("project_memberships_company_idx").on(t.companyId),
  ],
);

/** Tenant-defined permission templates (built-ins are seeded from shared). */
export const permissionTemplates = pgTable(
  "permission_templates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").default("").notNull(),
    tools: jsonb("tools").$type<Record<string, string>>().notNull(),
    isBuiltin: boolean("is_builtin").default(false).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("permission_templates_uq").on(t.companyId, t.key)],
);

/**
 * Assurance-role grants (integrity reviewer / auditor / regulator).
 * Kept apart from tool permissions: these are the segregation-of-duties roles
 * and may be time-boxed (regulator access).
 */
export const assuranceGrants = pgTable(
  "assurance_grants",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"), // null = whole tenant
    userId: text("user_id").notNull(),
    role: text("role").notNull(), // AssuranceRole
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    grantedBy: text("granted_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("assurance_grants_user_idx").on(t.userId, t.companyId),
    index("assurance_grants_company_idx").on(t.companyId, t.role),
  ],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("refresh_tokens_user_idx").on(t.userId),
    // Every /auth/refresh and /auth/logout looks a token up by its hash, and
    // rotation inserts a row per hour per active session without deleting the
    // old ones — so the hot path was a sequential scan that grew with the
    // total history of the deployment. Unique because a hash collision would
    // be a second credential for the same secret.
    uniqueIndex("refresh_tokens_hash_uq").on(t.tokenHash),
    index("refresh_tokens_expiry_idx").on(t.expiresAt),
  ],
);

/** Login and security-relevant events (successful or not). */
export const authEvents = pgTable(
  "auth_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    email: text("email"),
    kind: text("kind").notNull(), // login_success | login_failure | logout | refresh | password_change
    /**
     * The tenant the event happened in, when there was one. Without it the
     * admin register had to join through company_memberships, which showed an
     * admin of company A every sign-in a shared user made while working in
     * company B — their IPs and devices included.
     */
    companyId: text("company_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    at: createdAt(),
  },
  (t) => [
    index("auth_events_user_idx").on(t.userId),
    index("auth_events_at_idx").on(t.at),
    index("auth_events_company_idx").on(t.companyId, t.at),
  ],
);

/* ================================================================== */
/* Platform upgrade wave — WP-SUBSTRATE tenant governance              */
/* ================================================================== */

/**
 * Retention policy per record class (Vol I #46).
 *
 * A policy says how long a class of record is kept after it closes and what
 * happens then. It is deliberately advisory over most of the platform — the
 * substrate enforces it on the objects it owns (projects, vendors, contacts)
 * and reports what WOULD be purged elsewhere, because destroying another
 * module's evidentiary record on a schedule this module cannot reason about
 * is worse than reporting it.
 */
export const retentionPolicies = pgTable(
  "retention_policies",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** the object class this governs, e.g. "project", "vendor", "document" */
    objectType: text("object_type").notNull(),
    retainMonths: integer("retain_months").notNull(),
    action: text("action").default("retain").notNull(), // RetentionAction
    /** why this period — the regulation or contract that sets it */
    basis: text("basis"),
    isActive: integer("is_active").default(1).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("retention_policies_uq").on(t.companyId, t.objectType)],
);

/**
 * Legal hold (Vol I #47).
 *
 * A hold freezes deletion for everything it covers: a whole project, one
 * object class, or one record. While an active hold covers a record, both the
 * soft delete and the hard purge refuse and say which hold refused them.
 */
export const legalHolds = pgTable(
  "legal_holds",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = every project in the tenant */
    projectId: text("project_id"),
    /** null = every object type in scope */
    objectType: text("object_type"),
    /** null = every record of that type in scope */
    objectId: text("object_id"),
    name: text("name").notNull(),
    reason: text("reason").notNull(),
    matter: text("matter"),
    status: text("status").default("active").notNull(), // LegalHoldStatus
    custodianIds: jsonb("custodian_ids").$type<string[]>().default([]).notNull(),
    placedBy: text("placed_by").notNull(),
    releasedBy: text("released_by"),
    releasedAt: timestamp("released_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("legal_holds_company_idx").on(t.companyId, t.status),
    index("legal_holds_scope_idx").on(t.companyId, t.objectType, t.objectId),
  ],
);

/** Company data export bundles (Vol I #45). */
export const exportJobs = pgTable(
  "export_jobs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    status: text("status").default("pending").notNull(), // ExportJobStatus
    /** which datasets were requested */
    datasets: jsonb("datasets").$type<string[]>().default([]).notNull(),
    format: text("format").default("json").notNull(), // json | csv
    /** per-dataset row counts, and any dataset that could not be read */
    manifest: jsonb("manifest").$type<Record<string, unknown>>().default({}).notNull(),
    rowCount: integer("row_count").default(0).notNull(),
    error: text("error"),
    requestedBy: text("requested_by").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (t) => [index("export_jobs_company_idx").on(t.companyId, t.status)],
);

/**
 * Delegated administration (Vol I #27).
 *
 * A tenant-wide admin role is too much authority to hand a regional lead who
 * only needs to manage their own projects' memberships. A delegation names
 * the capabilities and the projects, and expires.
 */
export const adminDelegations = pgTable(
  "admin_delegations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    userId: text("user_id").notNull(),
    /** empty = every project in the tenant */
    projectIds: jsonb("project_ids").$type<string[]>().default([]).notNull(),
    capabilities: jsonb("capabilities").$type<string[]>().default([]).notNull(),
    note: text("note"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    grantedBy: text("granted_by").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (t) => [index("admin_delegations_user_idx").on(t.companyId, t.userId)],
);
