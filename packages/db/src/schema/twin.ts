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
    /* WP-BIM: operations ownership and design intent */
    /** FM owner: alerts escalate here, not to whoever created the row */
    ownerId: text("owner_id"),
    decommissionedAt: text("decommissioned_at"),
    /** design intent used by the performance gap report (#660-661) */
    designBaseline: jsonb("design_baseline")
      .$type<Record<string, number> | null>(),
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
    /* WP-BIM: alerting policy and last-seen cache */
    /** who owns the alert; falls back to the asset owner, then its creator */
    ownerId: text("owner_id"),
    /** minutes without a reading before the sensor is reported stale */
    staleAfterMinutes: doublePrecision("stale_after_minutes"),
    /** minimum minutes between two alerts for the same bound (event-storm guard) */
    cooldownMinutes: doublePrecision("cooldown_minutes").default(60).notNull(),
    /** design setpoint for the performance-gap report */
    designSetpoint: doublePrecision("design_setpoint"),
    lastReadingAt: timestamp("last_reading_at", { withTimezone: true, mode: "string" }),
    lastValue: doublePrecision("last_value"),
    lastAlertAt: timestamp("last_alert_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    index("sensors_project_idx").on(t.projectId),
    index("sensors_asset_idx").on(t.assetId),
    index("sensors_active_idx").on(t.companyId, t.isActive),
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
    /** ingest | manual | simulation — simulated telemetry is never counted as real */
    source: text("source").default("ingest").notNull(),
  },
  (t) => [
    /* one reading per sensor per instant: a retried gateway batch is a no-op */
    uniqueIndex("sensor_readings_uq").on(t.sensorId, t.at),
    index("sensor_readings_sensor_at_idx").on(t.sensorId, t.at),
  ],
);

/**
 * Sensor alerts (#659-661). A breach opens ONE alert per sensor+bound and is
 * acknowledged/cleared explicitly; the cool-down on `sensors` stops a noisy
 * channel from manufacturing an alert per reading.
 */
export const sensorAlerts = pgTable(
  "sensor_alerts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    sensorId: text("sensor_id").notNull(),
    assetId: text("asset_id"),
    kind: text("kind").notNull(), // SensorAlertKind
    status: text("status").default("open").notNull(), // SensorAlertStatus
    value: doublePrecision("value"),
    threshold: doublePrecision("threshold"),
    /** how many readings breached while this alert was open */
    breachCount: integer("breach_count").default(1).notNull(),
    firstBreachAt: timestamp("first_breach_at", { withTimezone: true, mode: "string" }),
    lastBreachAt: timestamp("last_breach_at", { withTimezone: true, mode: "string" }),
    acknowledgedBy: text("acknowledged_by"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: "string" }),
    clearedAt: timestamp("cleared_at", { withTimezone: true, mode: "string" }),
    /** the assurance event and signal raised for this alert */
    eventId: text("event_id"),
    signalId: text("signal_id"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("sensor_alerts_sensor_idx").on(t.sensorId, t.status),
    index("sensor_alerts_project_idx").on(t.projectId, t.status),
  ],
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
    /* WP-BIM: expiry obligations and claims (#642-644) */
    status: text("status").default("active").notNull(), // WarrantyStatus
    /** the obligation raised so expiry is tracked by the platform, not a page */
    obligationId: text("obligation_id"),
    /** largest horizon already notified (90/30/7) so a sweep notifies once */
    notifiedDays: integer("notified_days"),
    createdBy: text("created_by"),
  },
  (t) => [
    index("warranties_asset_idx").on(t.assetId),
    index("warranties_expiry_idx").on(t.companyId, t.status, t.endDate),
  ],
);

/** Warranty claims against a warranty (#643). */
export const warrantyClaims = pgTable(
  "warranty_claims",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    warrantyId: text("warranty_id").notNull(),
    assetId: text("asset_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").default("lodged").notNull(), // WarrantyClaimStatus
    lodgedAt: text("lodged_at"),
    respondedAt: text("responded_at"),
    closedAt: text("closed_at"),
    resolution: text("resolution"),
    /** the punch item / defect this claim was raised from */
    punchItemId: text("punch_item_id"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("warranty_claims_uq").on(t.projectId, t.number),
    index("warranty_claims_warranty_idx").on(t.warrantyId, t.status),
  ],
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
    /* WP-BIM: container linkage + acceptance record (#632-636) */
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "string" }),
    acceptedBy: text("accepted_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
    decisionNote: text("decision_note"),
    createdBy: text("created_by"),
  },
  (t) => [
    index("delivery_milestones_project_idx").on(t.projectId),
    index("delivery_milestones_due_idx").on(t.companyId, t.status, t.dueDate),
  ],
);

/**
 * Information containers a delivery milestone requires (#632-636): the model
 * (or document) that must reach a given CDE state and suitability before the
 * milestone can be reported as delivered.
 */
export const milestoneContainers = pgTable(
  "milestone_containers",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    milestoneId: text("milestone_id").notNull(),
    /** exactly one of modelId / documentFileId identifies the container */
    modelId: text("model_id"),
    documentFileId: text("document_file_id"),
    label: text("label").notNull(),
    requiredState: text("required_state").default("published").notNull(), // CdeState
    requiredSuitability: text("required_suitability"),
    createdAt: createdAt(),
  },
  (t) => [index("milestone_containers_milestone_idx").on(t.milestoneId)],
);
