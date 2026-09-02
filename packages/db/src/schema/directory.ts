import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();

/** Vendor / company directory with trade classification. */
export const vendors = pgTable(
  "vendors",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    name: text("name").notNull(),
    tradeCodes: jsonb("trade_codes").$type<string[]>().default([]).notNull(),
    address: text("address"),
    city: text("city"),
    country: text("country"),
    phone: text("phone"),
    email: text("email"),
    website: text("website"),
    taxId: text("tax_id"),
    registrationNumber: text("registration_number"),
    /** Assurance-layer entity mirror; set when the vendor is screened */
    entityId: text("entity_id"),
    status: text("status").default("active").notNull(), // active | inactive | merged
    mergedIntoId: text("merged_into_id"),
    notes: text("notes"),
    /**
     * Vol I #78 — soft delete, so a vendor that commitments, bids, insurance
     * and prequalification rows still point at is never destroyed by a
     * mis-click. Restorable from the recycle bin; a hard purge refuses while
     * any reference exists.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }),
    deletedBy: text("deleted_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("vendors_company_idx").on(t.companyId),
    index("vendors_company_status_idx").on(t.companyId, t.status),
    index("vendors_company_deleted_idx").on(t.companyId, t.deletedAt),
  ],
);

/** Contact records distinct from user records (non-login contacts). */
export const contacts = pgTable(
  "contacts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    vendorId: text("vendor_id"),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    title: text("title"),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }),
    deletedBy: text("deleted_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("contacts_company_idx").on(t.companyId),
    index("contacts_vendor_idx").on(t.vendorId),
    index("contacts_company_deleted_idx").on(t.companyId, t.deletedAt),
  ],
);

/** Named recipient lists reusable across tools. */
export const distributionGroups = pgTable(
  "distribution_groups",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // NULLS NOT DISTINCT — see cost_codes_uq in core.ts: project_id is null
    // for a company-wide group, and a plain unique index does not constrain
    // those rows at all.
    unique("distribution_groups_uq").on(t.companyId, t.projectId, t.name).nullsNotDistinct(),
    index("distribution_groups_company_idx").on(t.companyId),
  ],
);

export const distributionGroupMembers = pgTable(
  "distribution_group_members",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id").notNull(),
    userId: text("user_id"),
    contactId: text("contact_id"),
    email: text("email"),
    /**
     * Normalised recipient key — `u:<userId>` / `c:<contactId>` /
     * `e:<lowercased email>` — computed on write. Three nullable columns
     * cannot be made unique together in Postgres, so the identity of a
     * recipient is materialised into one column that can be.
     */
    memberKey: text("member_key").notNull().default(""),
  },
  (t) => [
    index("distribution_group_members_group_idx").on(t.groupId),
    uniqueIndex("distribution_group_members_uq").on(t.groupId, t.memberKey),
  ],
);

/**
 * Vendor merge journal (Vol I #11 / directory intelligence).
 *
 * A merge re-points every vendorId column across the platform in one
 * transaction. This row records exactly which tables and how many rows were
 * touched so the operation can be explained afterwards and undone within the
 * grace window without guessing.
 */
export const vendorMerges = pgTable(
  "vendor_merges",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    sourceVendorId: text("source_vendor_id").notNull(),
    targetVendorId: text("target_vendor_id").notNull(),
    /** [{ table, column, rows, ids }] — enough to reverse the re-pointing */
    movements: jsonb("movements").$type<unknown[]>().default([]).notNull(),
    undoneAt: timestamp("undone_at", { withTimezone: true, mode: "string" }),
    undoneBy: text("undone_by"),
    performedBy: text("performed_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("vendor_merges_company_idx").on(t.companyId),
    index("vendor_merges_source_idx").on(t.sourceVendorId),
  ],
);
