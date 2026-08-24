import {
  doublePrecision,
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
 * Carbon, ESG & social value (spec Vol II Domain I / module M18).
 * Embodied carbon to EN 15978 / RICS WLCA with life-cycle modules, a factor
 * library (ICE database / EPD ingest), carbon budgets with drawdown, waste
 * with diversion-from-landfill, and UK Social Value Model commitments
 * reconciled tender-promise vs delivered.
 */
export const carbonFactors = pgTable(
  "carbon_factors",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    name: text("name").notNull(),
    materialCategory: text("material_category"),
    unit: text("unit").notNull(), // kg | m3 | m2 | t | item
    /** kgCO2e per unit */
    factorKgCo2ePerUnit: doublePrecision("factor_kg_co2e_per_unit").notNull(),
    source: text("source").notNull(), // CarbonFactorSource
    /** product-specific EPDs are preferred over generic factors (#498) */
    isProductSpecific: integer("is_product_specific").default(0).notNull(),
    epdReference: text("epd_reference"),
    validUntil: text("valid_until"),
    createdAt: createdAt(),
  },
  (t) => [index("carbon_factors_company_idx").on(t.companyId)],
);

/** Carbon budget per element with drawdown tracking (#494-495). */
export const carbonBudgets = pgTable(
  "carbon_budgets",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    element: text("element"), // NRM1 element or work package
    /** baseline and target in tCO2e */
    baselineTco2e: doublePrecision("baseline_tco2e").notNull(),
    targetTco2e: doublePrecision("target_tco2e").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("carbon_budgets_project_idx").on(t.projectId)],
);

/**
 * A carbon entry: a quantity × factor calculation attributed to a life-cycle
 * module and GHG-protocol scope. Quantities may reference a BoQ item so the
 * carbon model rides the commercial model.
 */
export const carbonEntries = pgTable(
  "carbon_entries",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    budgetId: text("budget_id"),
    description: text("description").notNull(),
    lifecycleModule: text("lifecycle_module").notNull(), // CarbonModule
    scope: text("scope"), // CarbonScope
    factorId: text("factor_id"),
    quantity: doublePrecision("quantity").notNull(),
    unit: text("unit").notNull(),
    /** persisted at write: quantity × factor ÷ 1000 */
    tco2e: doublePrecision("tco2e").notNull(),
    /** provenance when the quantity came from the BoQ or a delivery record */
    boqItemId: text("boq_item_id"),
    sourceNote: text("source_note"),
    entryDate: text("entry_date").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("carbon_entries_project_idx").on(t.projectId),
    index("carbon_entries_budget_idx").on(t.budgetId),
  ],
);

/** Waste movements with destination — drives diversion-from-landfill (#513-514). */
export const wasteRecords = pgTable(
  "waste_records",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    recordDate: text("record_date").notNull(),
    stream: text("stream").notNull(), // WasteStream
    destination: text("destination").notNull(), // WasteDestination
    tonnes: doublePrecision("tonnes").notNull(),
    carrier: text("carrier"),
    /** duty-of-care consignment note reference */
    consignmentNote: text("consignment_note"),
    cost: doublePrecision("cost"),
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("waste_records_project_idx").on(t.projectId, t.recordDate)],
);

/**
 * Social value commitments made at tender, reconciled against delivery
 * (#527-540) — the shortfall is the number that matters.
 */
export const socialValueCommitments = pgTable(
  "social_value_commitments",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    theme: text("theme").notNull(), // SocialValueTheme
    /** TOMs measure reference where used (#527) */
    measureRef: text("measure_ref"),
    description: text("description").notNull(),
    unit: text("unit").notNull(), // weeks | jobs | £ spend | hours | %
    targetValue: doublePrecision("target_value").notNull(),
    deliveredValue: doublePrecision("delivered_value").default(0).notNull(),
    /** proxy financial value per unit for social-value accounting (#538) */
    proxyValuePerUnit: doublePrecision("proxy_value_per_unit"),
    dueDate: text("due_date"),
    status: text("status").default("committed").notNull(), // CommitmentStatus
    vendorId: text("vendor_id"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("social_value_commitments_uq").on(t.projectId, t.number),
    index("social_value_commitments_project_idx").on(t.projectId),
  ],
);

export const socialValueDeliveries = pgTable(
  "social_value_deliveries",
  {
    id: text("id").primaryKey(),
    commitmentId: text("commitment_id").notNull(),
    companyId: text("company_id").notNull(),
    deliveryDate: text("delivery_date").notNull(),
    value: doublePrecision("value").notNull(),
    note: text("note"),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("social_value_deliveries_commitment_idx").on(t.commitmentId)],
);
