import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("vendors_company_idx").on(t.companyId)],
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("contacts_company_idx").on(t.companyId),
    index("contacts_vendor_idx").on(t.vendorId),
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
  (t) => [uniqueIndex("distribution_groups_uq").on(t.companyId, t.projectId, t.name)],
);

export const distributionGroupMembers = pgTable(
  "distribution_group_members",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id").notNull(),
    userId: text("user_id"),
    contactId: text("contact_id"),
    email: text("email"),
  },
  (t) => [index("distribution_group_members_group_idx").on(t.groupId)],
);
