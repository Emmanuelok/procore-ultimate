import {
  boolean,
  index,
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
  (t) => [index("assurance_grants_user_idx").on(t.userId, t.companyId)],
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
  (t) => [index("refresh_tokens_user_idx").on(t.userId)],
);

/** Login and security-relevant events (successful or not). */
export const authEvents = pgTable(
  "auth_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    email: text("email"),
    kind: text("kind").notNull(), // login_success | login_failure | logout | refresh | password_change
    ip: text("ip"),
    userAgent: text("user_agent"),
    at: createdAt(),
  },
  (t) => [index("auth_events_user_idx").on(t.userId)],
);
