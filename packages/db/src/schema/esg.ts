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
    /** the BoQ import checks this before re-creating an entry (idempotence) */
    index("carbon_entries_boq_item_idx").on(t.projectId, t.boqItemId),
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

/* ------------------------------------------------------------------ */
/* WP-SAFEG — environment, biodiversity, options, EMS, disclosure      */
/* ------------------------------------------------------------------ */

/**
 * Environmental monitoring points (#505-512). A consent condition sets a
 * limit at a place; the point is that place, carrying the limit, its
 * direction and the clause it comes from — because a reading is only an
 * exceedance relative to a limit somebody can cite.
 */
export const monitoringPoints = pgTable(
  "environmental_monitoring_points",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    medium: text("medium").notNull(), // EnvironmentalMedium
    parameter: text("parameter").notNull(), // PM10 | LAeq,1h | pH | turbidity …
    unit: text("unit").notNull(),
    limitValue: doublePrecision("limit_value"),
    limitDirection: text("limit_direction").default("max").notNull(), // LimitDirection
    /** the consent condition or standard the limit comes from */
    limitBasis: text("limit_basis"),
    /** the permit whose condition this discharges, where there is one */
    permitId: text("permit_id"),
    locationId: text("location_id"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    frequency: text("frequency"), // continuous | daily | weekly | monthly | ad_hoc
    active: integer("active").default(1).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("monitoring_points_project_idx").on(t.projectId),
    index("monitoring_points_medium_idx").on(t.projectId, t.medium),
  ],
);

export const monitoringReadings = pgTable(
  "environmental_readings",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    pointId: text("point_id").notNull(),
    readingAt: text("reading_at").notNull(), // ISO date
    value: doublePrecision("value").notNull(),
    /** computed at write against the point's limit — 1 = exceedance */
    exceedance: integer("exceedance").default(0).notNull(),
    /** how far past the limit, signed in the direction that breaches */
    exceedanceBy: doublePrecision("exceedance_by"),
    method: text("method"),
    instrument: text("instrument"),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    note: text("note"),
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("environmental_readings_point_idx").on(t.pointId, t.readingAt),
    index("environmental_readings_project_idx").on(t.projectId, t.readingAt),
    index("environmental_readings_exceedance_idx").on(t.projectId, t.exceedance),
  ],
);

/** Environmental incidents (#509-512) — the spill, not the near-spill report. */
export const environmentalIncidents = pgTable(
  "environmental_incidents",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    kind: text("kind").notNull(), // EnvironmentalIncidentKind
    severity: text("severity").default("medium").notNull(), // low | medium | high | critical
    occurredAt: text("occurred_at").notNull(),
    discoveredAt: text("discovered_at"),
    locationId: text("location_id"),
    description: text("description").notNull(),
    /** what escaped, and how much of it */
    quantity: doublePrecision("quantity"),
    unit: text("unit"),
    medium: text("medium"), // EnvironmentalMedium the receptor sits in
    /** statutory notification — the clock a regulator measures you on */
    reportableToRegulator: integer("reportable_to_regulator").default(0).notNull(),
    regulatorNotifiedAt: timestamp("regulator_notified_at", {
      withTimezone: true,
      mode: "string",
    }),
    regulator: text("regulator"),
    rootCause: text("root_cause"),
    /** [{ id, text, owner, dueDate, closedAt }] */
    correctiveActions: jsonb("corrective_actions").$type<unknown[]>().default([]).notNull(),
    status: text("status").default("open").notNull(), // EnvironmentalIncidentStatus
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    obligationId: text("obligation_id"),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("environmental_incidents_uq").on(t.projectId, t.number),
    index("environmental_incidents_project_idx").on(t.projectId, t.status),
    index("environmental_incidents_date_idx").on(t.projectId, t.occurredAt),
  ],
);

/**
 * Biodiversity units on the Defra metric shape: area × distinctiveness ×
 * condition × strategic significance. Net gain is baseline vs
 * post-intervention, and a net LOSS is a finding, not a rounding difference.
 */
export const biodiversityUnits = pgTable(
  "biodiversity_units",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    stage: text("stage").notNull(), // BiodiversityStage
    habitatType: text("habitat_type").notNull(),
    areaHectares: doublePrecision("area_hectares").notNull(),
    /** 0..8 on the Defra distinctiveness band scale */
    distinctiveness: doublePrecision("distinctiveness").notNull(),
    condition: text("condition").default("moderate").notNull(), // HabitatCondition
    /** multiplier 1..3 applied for condition */
    conditionScore: doublePrecision("condition_score").notNull(),
    strategicSignificance: doublePrecision("strategic_significance").default(1).notNull(),
    /** computed at write */
    units: doublePrecision("units").notNull(),
    surveyDate: text("survey_date"),
    surveyor: text("surveyor"),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("biodiversity_units_project_idx").on(t.projectId, t.stage),
  ],
);

/**
 * Design option carbon comparison and marginal abatement cost (#502-504).
 * The number that changes a design meeting is £ per tonne avoided, and it
 * is only computable when the option carries both its carbon and its cost.
 */
export const carbonOptions = pgTable(
  "carbon_options",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    studyRef: text("study_ref").notNull(), // groups the options being compared
    name: text("name").notNull(),
    description: text("description"),
    element: text("element"),
    /** the do-nothing / reference case for the study */
    isBaseline: integer("is_baseline").default(0).notNull(),
    tco2e: doublePrecision("tco2e").notNull(),
    /** capital cost of the option in `currency` */
    cost: doublePrecision("cost"),
    currency: text("currency").default("GBP").notNull(),
    /** computed against the study's baseline at read time, stored on decide */
    abatementTco2e: doublePrecision("abatement_tco2e"),
    abatementCostPerTonne: doublePrecision("abatement_cost_per_tonne"),
    decision: text("decision").default("under_review").notNull(), // CarbonOptionDecision
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
    decidedBy: text("decided_by"),
    decisionNote: text("decision_note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("carbon_options_project_idx").on(t.projectId, t.studyRef),
  ],
);

/**
 * Transport carbon (A4 / A5, #493). Distance × payload × mode factor, with
 * the resulting carbon entry recorded so the leg and the footprint line are
 * the same fact rather than two numbers that drift.
 */
export const carbonTransportLegs = pgTable(
  "carbon_transport_legs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    description: text("description").notNull(),
    origin: text("origin"),
    destination: text("destination"),
    mode: text("mode").notNull(), // CarbonTransportMode
    distanceKm: doublePrecision("distance_km").notNull(),
    payloadTonnes: doublePrecision("payload_tonnes").notNull(),
    /** trips over the same leg; the footprint scales with it */
    trips: integer("trips").default(1).notNull(),
    /** kgCO2e per tonne-km actually applied */
    factorKgCo2ePerTonneKm: doublePrecision("factor_kg_co2e_per_tonne_km").notNull(),
    factorSource: text("factor_source").notNull(),
    tco2e: doublePrecision("tco2e").notNull(),
    lifecycleModule: text("lifecycle_module").default("A4").notNull(),
    /** the carbon entry this leg generated */
    entryId: text("entry_id"),
    legDate: text("leg_date").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("carbon_transport_legs_project_idx").on(t.projectId, t.legDate),
    index("carbon_transport_legs_entry_idx").on(t.entryId),
  ],
);

/** ISO 14001:2015 evidence register — clause → what proves it (#515-517). */
export const emsRecords = pgTable(
  "ems_records",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    clause: text("clause").notNull(), // Iso14001Clause
    requirement: text("requirement").notNull(),
    status: text("status").default("not_started").notNull(), // EmsEvidenceStatus
    ownerId: text("owner_id"),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    /** records elsewhere in the platform that evidence the clause */
    linkedRecords: jsonb("linked_records").$type<unknown[]>().default([]).notNull(),
    lastReviewedAt: text("last_reviewed_at"),
    nextReviewDueAt: text("next_review_due_at"),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ems_records_uq").on(t.projectId, t.clause),
    index("ems_records_project_idx").on(t.projectId, t.status),
  ],
);

/**
 * Assembled disclosure return (#541-546): CSRD/ESRS, IFRS S2, TCFD and the
 * modern slavery statement evidence pack. Every datapoint carries its basis
 * and the ledger window it was computed over, and anything without a source
 * is reported as unavailable with the reason — never as zero.
 */
export const esgDisclosures = pgTable(
  "esg_disclosures",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    framework: text("framework").notNull(), // DisclosureFramework
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    /** [{ id, label, value, unit, basis, sources, unavailableReason }] */
    datapoints: jsonb("datapoints").$type<unknown[]>().default([]).notNull(),
    /** product-specific share, unscoped share, unevidenced deliveries … */
    dataQuality: jsonb("data_quality").$type<Record<string, unknown>>().default({}).notNull(),
    ledgerSeqTo: integer("ledger_seq_to"),
    generatedBy: text("generated_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("esg_disclosures_project_idx").on(t.projectId, t.framework, t.periodEnd),
  ],
);
