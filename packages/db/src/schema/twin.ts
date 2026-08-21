import {
  doublePrecision,
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

/**
 * Digital twin asset register, created during construction (spec Domain L).
 * `tagCode` is the unique persistent identifier used on site; classification
 * follows Uniclass/Omniclass/SFG20.
 */
export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    tagCode: text("tag_code").notNull(),
    name: text("name").notNull(),
    category: text("category"),
    classificationSystem: text("classification_system"), // uniclass | omniclass | sfg20 | masterformat
    classificationCode: text("classification_code"),
    parentId: text("parent_id"),
    locationId: text("location_id"),
    manufacturer: text("manufacturer"),
    modelNumber: text("model_number"),
    serialNumber: text("serial_number"),
    installedAt: text("installed_at"), // ISO date
    commissionedAt: text("commissioned_at"),
    warrantyStart: text("warranty_start"),
    warrantyMonths: doublePrecision("warranty_months"),
    expectedLifeYears: doublePrecision("expected_life_years"),
    criticality: text("criticality").default("medium").notNull(), // AssetCriticality
    status: text("status").default("planned").notNull(), // planned | installed | commissioned | operational | decommissioned
    /** COBie-aligned attribute bag */
    attributes: jsonb("attributes").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("assets_tag_uq").on(t.projectId, t.tagCode),
    index("assets_project_idx").on(t.projectId),
    index("assets_parent_idx").on(t.parentId),
  ],
);

/** Bind an asset to BIM element(s) by IFC GUID — the twin's geometry link. */
export const assetElementLinks = pgTable(
  "asset_element_links",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id").notNull(),
    projectId: text("project_id").notNull(),
    globalId: text("global_id").notNull(),
    modelVersionId: text("model_version_id"),
  },
  (t) => [
    uniqueIndex("asset_element_links_uq").on(t.assetId, t.globalId),
    index("asset_element_links_global_idx").on(t.projectId, t.globalId),
  ],
);

/** Sensor / IoT channels associated to assets or locations. */
export const sensors = pgTable(
  "sensors",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    assetId: text("asset_id"),
    locationId: text("location_id"),
    externalId: text("external_id"),
    name: text("name").notNull(),
    kind: text("kind").notNull(), // SensorKind
    unit: text("unit").notNull(),
    /** alerting thresholds */
    minValue: doublePrecision("min_value"),
    maxValue: doublePrecision("max_value"),
    isActive: text("is_active").default("true").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("sensors_project_idx").on(t.projectId),
    index("sensors_asset_idx").on(t.assetId),
  ],
);

export const sensorReadings = pgTable(
  "sensor_readings",
  {
    id: text("id").primaryKey(),
    sensorId: text("sensor_id").notNull(),
    value: doublePrecision("value").notNull(),
    at: timestamp("at", { withTimezone: true, mode: "string" }).notNull(),
    ingestedAt: createdAt(),
  },
  (t) => [index("sensor_readings_sensor_at_idx").on(t.sensorId, t.at)],
);

/** Warranty register per asset (spec Domain L #642-644). */
export const warranties = pgTable(
  "warranties",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    assetId: text("asset_id").notNull(),
    provider: text("provider").notNull(),
    description: text("description"),
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    documentFileId: text("document_file_id"),
    createdAt: createdAt(),
  },
  (t) => [index("warranties_asset_idx").on(t.assetId)],
);

/**
 * ISO 19650 information delivery milestones (MIDP/TIDP tracking, Domain L
 * #632-636) — which information containers are due, when, at what LOIN.
 */
export const deliveryMilestones = pgTable(
  "delivery_milestones",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    dueDate: text("due_date"),
    requiredState: text("required_state").default("published").notNull(), // CdeState
    requiredSuitability: text("required_suitability"),
    description: text("description"),
    status: text("status").default("open").notNull(), // open | delivered | accepted | rejected
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("delivery_milestones_project_idx").on(t.projectId)],
);
