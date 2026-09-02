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
 * ESTIMATING & TAKEOFF — spec Vol I §1.2 (#184–208).
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF THE PROBLEM
 *
 * An estimate is a chain of claims, and each link is a different kind of
 * claim:
 *
 *   MEASUREMENT   "there are 412 m² of blockwork on sheet A-201"
 *                 → estimate_takeoff_items. The GEOMETRY is stored, not just
 *                   the answer, together with the sheet, the revision and the
 *                   scale it was measured at. A takeoff whose answer survives
 *                   but whose geometry does not cannot be re-measured, and an
 *                   estimate nobody can re-measure is a rumour.
 *
 *   RATE          "blockwork costs £68.40/m², of which £31 is labour"
 *                 → cost_catalogue_items (+ cost_assemblies for composed
 *                   items, estimating_crews and estimating_production_rates
 *                   for the labour half). The rate carries its SOURCE and the
 *                   date it was current, because a 2019 rate applied to a 2026
 *                   project is the single commonest way an estimate is wrong.
 *
 *   COMPOSITION   "412 m² × £68.40 = £28,180.80, plus 6% waste"
 *                 → estimate_line_items. Quantity, rate and the cost-type
 *                   split are all stored per line; every extended figure is
 *                   materialized because the grid is the hottest read here and
 *                   because a stored number can be compared against a later
 *                   version, while a computed one cannot.
 *
 *   MARKUP        "…then 8% overhead on cost, then 5% profit on cost+overhead"
 *                 → estimate_markups. `basis` + `sequence` make the stacking
 *                   order explicit. Profit-on-cost and profit-on-cost-plus-
 *                   overhead differ by real money and no default should decide
 *                   which one a tender used.
 *
 *   POSITION      "and here is what we sent the client"
 *                 → estimate_proposals (issued document, frozen) and the
 *                   conversion to budgets/budget_line_items, which is where an
 *                   estimate stops being an opinion and becomes the plan the
 *                   project is measured against.
 *
 * ---------------------------------------------------------------------------
 * VERSIONS ARE ROWS, NOT AN EDIT LOG
 *
 * `estimates.rootId` + `version` + `parentEstimateId` form a chain: cutting a
 * version deep-copies sections, lines, markups and takeoff assignments into a
 * new estimate row and marks the parent `superseded`. Comparison (#201) is
 * then a diff of two live row sets rather than a replay of edits, which is
 * both cheaper and honest about what each version actually said.
 *
 * CONVENTIONS
 *  · `companyId` on every table, `projectId` on everything project-bound;
 *    both are filter predicates, never joins.
 *  · Money is doublePrecision and always accompanied by the estimate's
 *    `currency`. Nothing here sums across currencies.
 *  · The catalogue, assemblies, crews and production rates are COMPANY-level
 *    libraries with an optional `projectId` for a project-specific override —
 *    the same pattern cost_codes already uses.
 *  · `detail` jsonb on every table: a tenant-specific field without a
 *    migration.
 */

/* ------------------------------------------------------------------ */
/* Estimates                                                           */
/* ------------------------------------------------------------------ */

/**
 * The estimate header. One row per VERSION: `rootId` groups the chain,
 * `version` orders it, and exactly one member of a chain is not `superseded`.
 *
 * The rollup columns are materialized from estimate_line_items and
 * estimate_markups on every write that can move a number, and
 * `totalsCalculatedAt` is stamped so a stale header is detectable rather than
 * quietly wrong.
 */
export const estimates = pgTable(
  "estimates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").default("draft").notNull(), // EstimateStatus
    estimateType: text("estimate_type").default("conceptual").notNull(), // EstimateType
    currency: text("currency").default("USD").notNull(),
    /** the first estimate in this version chain; equals `id` for version 1 */
    rootId: text("root_id").notNull(),
    version: integer("version").default(1).notNull(),
    parentEstimateId: text("parent_estimate_id"),
    /** what this estimate prices, when it is not the whole job: a change event */
    sourceType: text("source_type"), // change_event | bid_package | manual
    sourceId: text("source_id"),
    /** design maturity note the accuracy claim rests on, in the estimator's words */
    basis: text("basis"),
    /** ± accuracy the estimator claims for this maturity, as a fraction (0.15 = ±15%) */
    accuracyRange: doublePrecision("accuracy_range"),
    /** measured gross floor area etc., so a £/m² comparison is possible at all */
    quantityBasis: doublePrecision("quantity_basis"),
    quantityBasisUnit: text("quantity_basis_unit"),
    /* materialized rollups over the lines and markups */
    directCostTotal: doublePrecision("direct_cost_total").default(0).notNull(),
    labourTotal: doublePrecision("labour_total").default(0).notNull(),
    materialTotal: doublePrecision("material_total").default(0).notNull(),
    equipmentTotal: doublePrecision("equipment_total").default(0).notNull(),
    subcontractTotal: doublePrecision("subcontract_total").default(0).notNull(),
    otherTotal: doublePrecision("other_total").default(0).notNull(),
    markupTotal: doublePrecision("markup_total").default(0).notNull(),
    total: doublePrecision("total").default(0).notNull(),
    /** total labour hours implied by the crews and production rates used */
    labourHours: doublePrecision("labour_hours").default(0).notNull(),
    lineCount: integer("line_count").default(0).notNull(),
    /** lines outside the total: alternates and explicit exclusions */
    excludedTotal: doublePrecision("excluded_total").default(0).notNull(),
    alternateTotal: doublePrecision("alternate_total").default(0).notNull(),
    totalsCalculatedAt: timestamp("totals_calculated_at", { withTimezone: true, mode: "string" }),
    /** after lock the lines are frozen; cut a new version to keep working */
    lockedAt: timestamp("locked_at", { withTimezone: true, mode: "string" }),
    lockedBy: text("locked_by"),
    /** MUST NOT equal createdBy — an estimator cannot approve his own number */
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    /** the budget written from this estimate, once one exists (#204) */
    convertedBudgetId: text("converted_budget_id"),
    convertedAt: timestamp("converted_at", { withTimezone: true, mode: "string" }),
    convertedBy: text("converted_by"),
    supersededById: text("superseded_by_id"),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("estimates_uq").on(t.projectId, t.number),
    index("estimates_project_idx").on(t.projectId, t.status),
    index("estimates_company_idx").on(t.companyId, t.status),
    index("estimates_root_idx").on(t.rootId, t.version),
    index("estimates_source_idx").on(t.sourceType, t.sourceId),
  ],
);

/**
 * A grouping band in the estimate grid — a trade package, a building, a CSI
 * division. Sections are a presentation and roll-up device only: the money
 * lives on the lines, and a line with no section is legal.
 */
export const estimateSections = pgTable(
  "estimate_sections",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    estimateId: text("estimate_id").notNull(),
    parentId: text("parent_id"),
    code: text("code"),
    name: text("name").notNull(),
    description: text("description"),
    sortOrder: integer("sort_order").default(0).notNull(),
    /** materialized sum of the section's active lines */
    directCostTotal: doublePrecision("direct_cost_total").default(0).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("estimate_sections_estimate_idx").on(t.estimateId, t.sortOrder),
    index("estimate_sections_project_idx").on(t.projectId),
  ],
);

/**
 * A priced line — the atom of the estimate.
 *
 * QUANTITY. `quantity` is what is priced; `takeoffQuantity` is what was
 * measured; `wastePercent` is the declared difference. Keeping the measured
 * figure separate from the priced one is what lets a reviewer see that
 * somebody added 30% "waste" to make a number fit.
 *
 * RATE. The unit rate is stored BOTH as a total and as its cost-type split,
 * because the split is what a subcontract comparison, a labour-hour forecast
 * and a prelims analysis each need, and re-deriving it from a ratio loses the
 * estimator's intent.
 *
 * PROVENANCE. `source` plus the id columns say where the line came from: a
 * takeoff, an expanded assembly, a catalogue item, an imported sub-quote.
 */
export const estimateLineItems = pgTable(
  "estimate_line_items",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    estimateId: text("estimate_id").notNull(),
    sectionId: text("section_id"),
    /** identity across versions: copied on version cut so a diff can pair lines */
    lineageId: text("lineage_id").notNull(),
    position: integer("position").default(0).notNull(),
    itemCode: text("item_code"),
    description: text("description").notNull(),
    longDescription: text("long_description"),
    costCodeId: text("cost_code_id"),
    /** denormalized so the grid groups and sorts without a join */
    costCode: text("cost_code"),
    costType: text("cost_type").default("other").notNull(), // CostType
    status: text("status").default("active").notNull(), // EstimateLineStatus
    source: text("source").default("manual").notNull(), // EstimateLineSource
    unit: text("unit"),
    /** what was measured, before waste — null when the line was typed */
    takeoffQuantity: doublePrecision("takeoff_quantity"),
    wastePercent: doublePrecision("waste_percent").default(0).notNull(),
    /** the quantity actually priced */
    quantity: doublePrecision("quantity").default(0).notNull(),
    /* the rate, split by cost type; unitRate is their sum */
    unitRate: doublePrecision("unit_rate").default(0).notNull(),
    labourRate: doublePrecision("labour_rate").default(0).notNull(),
    materialRate: doublePrecision("material_rate").default(0).notNull(),
    equipmentRate: doublePrecision("equipment_rate").default(0).notNull(),
    subcontractRate: doublePrecision("subcontract_rate").default(0).notNull(),
    otherRate: doublePrecision("other_rate").default(0).notNull(),
    /* the extension, materialized */
    labourAmount: doublePrecision("labour_amount").default(0).notNull(),
    materialAmount: doublePrecision("material_amount").default(0).notNull(),
    equipmentAmount: doublePrecision("equipment_amount").default(0).notNull(),
    subcontractAmount: doublePrecision("subcontract_amount").default(0).notNull(),
    otherAmount: doublePrecision("other_amount").default(0).notNull(),
    amount: doublePrecision("amount").default(0).notNull(),
    /* the labour half of the rate, when it was built from a crew */
    crewId: text("crew_id"),
    /** ProductionRateBasis value in `productionRateBasis` units */
    productionRate: doublePrecision("production_rate"),
    productionRateBasis: text("production_rate_basis"), // ProductionRateBasis
    labourHours: doublePrecision("labour_hours").default(0).notNull(),
    /* provenance */
    takeoffItemId: text("takeoff_item_id"),
    catalogueItemId: text("catalogue_item_id"),
    assemblyId: text("assembly_id"),
    /** set on lines produced by expanding an assembly, pointing at the parent line */
    assemblyParentLineId: text("assembly_parent_line_id"),
    subQuoteId: text("sub_quote_id"),
    subQuoteLineId: text("sub_quote_line_id"),
    /** the catalogue rate's currency date, copied at pricing time (staleness) */
    rateAsAt: text("rate_as_at"), // ISO date
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("estimate_line_items_estimate_idx").on(t.estimateId, t.position),
    index("estimate_line_items_section_idx").on(t.sectionId),
    index("estimate_line_items_project_idx").on(t.projectId),
    index("estimate_line_items_lineage_idx").on(t.estimateId, t.lineageId),
    index("estimate_line_items_costcode_idx").on(t.estimateId, t.costCode, t.costType),
    index("estimate_line_items_takeoff_idx").on(t.takeoffItemId),
    index("estimate_line_items_catalogue_idx").on(t.catalogueItemId),
  ],
);

/* ------------------------------------------------------------------ */
/* Takeoff                                                             */
/* ------------------------------------------------------------------ */

/**
 * A colour-coded takeoff layer (#189) — "external walls", "ground slab".
 * Layers are per project so a takeoff carries across estimate versions.
 */
export const takeoffLayers = pgTable(
  "estimate_takeoff_layers",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    /** #rrggbb, validated by the API */
    colour: text("colour").default("#2563eb").notNull(),
    description: text("description"),
    /** default cost code every item drawn on this layer inherits (#190) */
    costCodeId: text("cost_code_id"),
    costCode: text("cost_code"),
    measurementType: text("measurement_type"), // TakeoffMeasurementType
    unit: text("unit"),
    visible: integer("visible").default(1).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("estimate_takeoff_layers_project_idx").on(t.projectId, t.sortOrder),
    index("estimate_takeoff_layers_company_idx").on(t.companyId),
  ],
);

/** The geometry a takeoff was measured from, in sheet coordinates. */
export interface TakeoffGeometry {
  kind: string; // TakeoffGeometryKind
  /** ordered vertices in the sheet's own coordinate space */
  points: Array<{ x: number; y: number }>;
  /** circle only */
  radius?: number;
  /** true when a polyline is drawn closed (its perimeter counts the closing leg) */
  closed?: boolean;
}

/**
 * A measured takeoff (#184–188). The RECORD MODEL is the product here: an
 * SVG overlay is a convenience, but the row is what has to survive.
 *
 * `pixelsPerUnit` + `scaleUnit` are the sheet calibration (#188): the number
 * of geometry units that correspond to one `scaleUnit` on the real building.
 * Both the calibration and the geometry are kept, so re-measuring after a
 * calibration correction is arithmetic rather than re-drawing.
 *
 * `quantity` is the computed answer in `unit`; `rawValue` is the geometric
 * measure before depth/height/deduction factors, so the arithmetic is
 * checkable without re-running the engine.
 */
export const takeoffItems = pgTable(
  "estimate_takeoff_items",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    /** the estimate this measurement was taken for; null = a project-level measure */
    estimateId: text("estimate_id"),
    layerId: text("layer_id"),
    name: text("name").notNull(),
    description: text("description"),
    measurementType: text("measurement_type").notNull(), // TakeoffMeasurementType
    status: text("status").default("measured").notNull(), // TakeoffStatus
    /* what it was measured on */
    sheetId: text("sheet_id"),
    sheetNumber: text("sheet_number"),
    revisionId: text("revision_id"),
    pageNumber: integer("page_number").default(1).notNull(),
    /* calibration (#188) */
    pixelsPerUnit: doublePrecision("pixels_per_unit"),
    scaleUnit: text("scale_unit"), // LengthUnit
    scaleLabel: text("scale_label"),
    geometry: jsonb("geometry").$type<TakeoffGeometry | null>(),
    /* the answer */
    rawValue: doublePrecision("raw_value").default(0).notNull(),
    /** applied for volume (depth) or for a linear run raised to an area */
    depth: doublePrecision("depth"),
    height: doublePrecision("height"),
    /** deducted openings etc., in `unit` */
    deduction: doublePrecision("deduction").default(0).notNull(),
    /** repeats of the same measured shape (typical floors) */
    multiplier: doublePrecision("multiplier").default(1).notNull(),
    quantity: doublePrecision("quantity").default(0).notNull(),
    unit: text("unit").notNull(),
    /** the perimeter of an area measure, kept because it prices edge trims */
    perimeter: doublePrecision("perimeter"),
    /* assignment (#190) */
    costCodeId: text("cost_code_id"),
    costCode: text("cost_code"),
    colour: text("colour"),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    measuredBy: text("measured_by").notNull(),
    measuredAt: timestamp("measured_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("estimate_takeoff_items_project_idx").on(t.projectId, t.status),
    index("estimate_takeoff_items_estimate_idx").on(t.estimateId),
    index("estimate_takeoff_items_layer_idx").on(t.layerId),
    index("estimate_takeoff_items_sheet_idx").on(t.sheetId, t.pageNumber),
    index("estimate_takeoff_items_costcode_idx").on(t.projectId, t.costCode),
  ],
);

/* ------------------------------------------------------------------ */
/* Cost catalogue, assemblies, crews, production rates                 */
/* ------------------------------------------------------------------ */

/**
 * The cost catalogue (#192, #195–196) — a company-level rate library with an
 * optional project override (`projectId`), the same shape cost_codes uses.
 *
 * The rate is stored as its cost-type split; `unitRate` is their sum and is
 * materialized so the picker sorts without arithmetic. `source` + `rateAsAt`
 * are the staleness clock the hygiene sweep reads: a rate that was current in
 * 2019 is not a 2026 rate, and the platform says so rather than pricing with
 * it silently.
 */
export const costCatalogueItems = pgTable(
  "cost_catalogue_items",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = the company library; set = a project-specific rate */
    projectId: text("project_id"),
    code: text("code").notNull(),
    description: text("description").notNull(),
    longDescription: text("long_description"),
    unit: text("unit").notNull(),
    costType: text("cost_type").default("other").notNull(), // CostType
    category: text("category"),
    trade: text("trade"),
    currency: text("currency").default("USD").notNull(),
    labourRate: doublePrecision("labour_rate").default(0).notNull(),
    materialRate: doublePrecision("material_rate").default(0).notNull(),
    equipmentRate: doublePrecision("equipment_rate").default(0).notNull(),
    subcontractRate: doublePrecision("subcontract_rate").default(0).notNull(),
    otherRate: doublePrecision("other_rate").default(0).notNull(),
    unitRate: doublePrecision("unit_rate").default(0).notNull(),
    /** the crew and rate that build the labour half (#194, #197) */
    crewId: text("crew_id"),
    productionRate: doublePrecision("production_rate"),
    productionRateBasis: text("production_rate_basis"), // ProductionRateBasis
    wastePercent: doublePrecision("waste_percent").default(0).notNull(),
    costCodeId: text("cost_code_id"),
    costCode: text("cost_code"),
    source: text("source").default("manual").notNull(), // CatalogueItemSource
    sourceReference: text("source_reference"),
    region: text("region"),
    /** the date this price was current — the staleness clock */
    rateAsAt: text("rate_as_at"), // ISO date
    status: text("status").default("active").notNull(), // CatalogueItemStatus
    tags: jsonb("tags").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("cost_catalogue_items_uq").on(t.companyId, t.projectId, t.code),
    index("cost_catalogue_items_company_idx").on(t.companyId, t.status),
    index("cost_catalogue_items_project_idx").on(t.projectId),
    index("cost_catalogue_items_costtype_idx").on(t.companyId, t.costType),
    index("cost_catalogue_items_stale_idx").on(t.companyId, t.rateAsAt),
  ],
);

/**
 * An assembly (#191, #193) — "1 m² of 140mm blockwork" composed of blocks,
 * mortar, labour and scaffold. Expanding an assembly onto an estimate writes
 * one line per component plus a parent line, so the estimate grid shows both
 * the assembly and what it is made of.
 */
export const costAssemblies = pgTable(
  "cost_assemblies",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** the unit the assembly is priced PER (m², m³, each) */
    unit: text("unit").notNull(),
    category: text("category"),
    trade: text("trade"),
    currency: text("currency").default("USD").notNull(),
    costCodeId: text("cost_code_id"),
    costCode: text("cost_code"),
    /** materialized sum of the components, per one assembly unit */
    unitRate: doublePrecision("unit_rate").default(0).notNull(),
    labourRate: doublePrecision("labour_rate").default(0).notNull(),
    materialRate: doublePrecision("material_rate").default(0).notNull(),
    equipmentRate: doublePrecision("equipment_rate").default(0).notNull(),
    subcontractRate: doublePrecision("subcontract_rate").default(0).notNull(),
    otherRate: doublePrecision("other_rate").default(0).notNull(),
    componentCount: integer("component_count").default(0).notNull(),
    status: text("status").default("active").notNull(), // AssemblyStatus
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("cost_assemblies_uq").on(t.companyId, t.projectId, t.code),
    index("cost_assemblies_company_idx").on(t.companyId, t.status),
  ],
);

/**
 * One ingredient of an assembly: a catalogue item (normal) or a free-typed
 * component (rate carried inline). `quantityPer` is per ONE assembly unit —
 * 12.5 blocks per m², 0.35 crew-hours per m².
 */
export const costAssemblyComponents = pgTable(
  "cost_assembly_components",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    assemblyId: text("assembly_id").notNull(),
    position: integer("position").default(0).notNull(),
    catalogueItemId: text("catalogue_item_id"),
    description: text("description").notNull(),
    unit: text("unit"),
    costType: text("cost_type").default("other").notNull(), // CostType
    quantityPer: doublePrecision("quantity_per").default(0).notNull(),
    wastePercent: doublePrecision("waste_percent").default(0).notNull(),
    /* the rate used; copied from the catalogue item at write time so the
       assembly's own price is stable until it is deliberately refreshed */
    labourRate: doublePrecision("labour_rate").default(0).notNull(),
    materialRate: doublePrecision("material_rate").default(0).notNull(),
    equipmentRate: doublePrecision("equipment_rate").default(0).notNull(),
    subcontractRate: doublePrecision("subcontract_rate").default(0).notNull(),
    otherRate: doublePrecision("other_rate").default(0).notNull(),
    unitRate: doublePrecision("unit_rate").default(0).notNull(),
    /** extended per one assembly unit, waste included */
    amountPer: doublePrecision("amount_per").default(0).notNull(),
    costCodeId: text("cost_code_id"),
    costCode: text("cost_code"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("cost_assembly_components_assembly_idx").on(t.assemblyId, t.position),
    index("cost_assembly_components_catalogue_idx").on(t.catalogueItemId),
  ],
);

/** One trade in a crew: how many, at what hourly cost. */
export interface CrewMemberSpec {
  trade: string;
  count: number;
  hourlyRate: number;
}

/** One machine in a crew: how many, at what hourly cost. */
export interface CrewEquipmentSpec {
  description: string;
  count: number;
  hourlyRate: number;
}

/**
 * A crew composition (#197) — the labour half of every production rate.
 * `hourlyCost` is materialized from the members and plant so a rate build-up
 * does not re-sum a jsonb array on every read.
 *
 * Deliberately NOT the same table as timecards.crews: that one is a real crew
 * of named people on a real day. This is an estimating archetype — "a 2+1
 * bricklaying gang" — that exists before anybody is hired.
 */
export const estimatingCrews = pgTable(
  "estimating_crews",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    trade: text("trade"),
    currency: text("currency").default("USD").notNull(),
    members: jsonb("members").$type<CrewMemberSpec[]>().default([]).notNull(),
    equipment: jsonb("equipment").$type<CrewEquipmentSpec[]>().default([]).notNull(),
    /** materialized: Σ members(count × rate) + Σ equipment(count × rate) */
    hourlyCost: doublePrecision("hourly_cost").default(0).notNull(),
    labourHourlyCost: doublePrecision("labour_hourly_cost").default(0).notNull(),
    equipmentHourlyCost: doublePrecision("equipment_hourly_cost").default(0).notNull(),
    headcount: doublePrecision("headcount").default(0).notNull(),
    status: text("status").default("active").notNull(), // CrewDefinitionStatus
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("estimating_crews_uq").on(t.companyId, t.projectId, t.code),
    index("estimating_crews_company_idx").on(t.companyId, t.status),
  ],
);

/**
 * A production rate (#194): how much of a unit a named crew achieves per hour,
 * or how many hours it takes per unit. Both directions are stored as declared
 * — converting silently between them is how estimates acquire factor-of-ten
 * errors — and the engine normalises at the point of use.
 */
export const estimatingProductionRates = pgTable(
  "estimating_production_rates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    code: text("code").notNull(),
    description: text("description").notNull(),
    unit: text("unit").notNull(),
    trade: text("trade"),
    crewId: text("crew_id"),
    basis: text("basis").default("output_per_hour").notNull(), // ProductionRateBasis
    value: doublePrecision("value").default(0).notNull(),
    /** conditions the rate assumes — the reason it is or is not applicable */
    conditions: text("conditions"),
    source: text("source").default("manual").notNull(), // CatalogueItemSource
    sourceReference: text("source_reference"),
    region: text("region"),
    rateAsAt: text("rate_as_at"), // ISO date
    status: text("status").default("active").notNull(), // CatalogueItemStatus
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("estimating_production_rates_uq").on(t.companyId, t.projectId, t.code),
    index("estimating_production_rates_company_idx").on(t.companyId, t.status),
    index("estimating_production_rates_crew_idx").on(t.crewId),
  ],
);

/* ------------------------------------------------------------------ */
/* Markups                                                             */
/* ------------------------------------------------------------------ */

/**
 * A markup tier (#198–199). `sequence` orders application and `basis` says
 * what the percentage is a percentage OF; together they make "5% profit" an
 * unambiguous instruction instead of an argument.
 *
 * `costTypes` narrows a `cost_type` basis to specific families — the tiered
 * markup of #199, where subcontract work carries 5% and self-performed labour
 * carries 15%.
 */
export const estimateMarkups = pgTable(
  "estimate_markups",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    estimateId: text("estimate_id").notNull(),
    sequence: integer("sequence").default(0).notNull(),
    kind: text("kind").default("overhead").notNull(), // EstimateMarkupKind
    name: text("name").notNull(),
    method: text("method").default("percent").notNull(), // EstimateMarkupMethod
    basis: text("basis").default("direct_cost").notNull(), // EstimateMarkupBasis
    /** percent (0..100) for `percent`, an absolute for `fixed`, per-unit otherwise */
    rate: doublePrecision("rate").default(0).notNull(),
    /** cost types the basis is narrowed to; empty = every cost type */
    costTypes: jsonb("cost_types").$type<string[]>().default([]).notNull(),
    /** sections the markup applies to; empty = the whole estimate */
    sectionIds: jsonb("section_ids").$type<string[]>().default([]).notNull(),
    /** the per-unit quantity for `per_unit` (e.g. gross floor area) */
    quantity: doublePrecision("quantity"),
    /** materialized outcome of the cascade */
    baseAmount: doublePrecision("base_amount").default(0).notNull(),
    amount: doublePrecision("amount").default(0).notNull(),
    /** the estimator's reason — a contingency without a reason is a plug */
    rationale: text("rationale"),
    enabled: integer("enabled").default(1).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("estimate_markups_estimate_idx").on(t.estimateId, t.sequence),
    index("estimate_markups_project_idx").on(t.projectId),
  ],
);

/* ------------------------------------------------------------------ */
/* Sub-quotes                                                          */
/* ------------------------------------------------------------------ */

/**
 * A subcontractor or supplier quote imported into the estimate (#202), either
 * typed in or pulled from a bid submission (#203).
 *
 * `validUntil` matters more than it looks: a quote out of validity is not a
 * price, and an estimate resting on one is carrying a risk nobody priced. The
 * validity sweep raises a signal rather than letting the grid keep quoting it.
 */
export const estimateSubQuotes = pgTable(
  "estimate_sub_quotes",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    estimateId: text("estimate_id"),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    vendorId: text("vendor_id"),
    vendorName: text("vendor_name").notNull(),
    tradePackage: text("trade_package").notNull(),
    status: text("status").default("received").notNull(), // SubQuoteStatus
    source: text("source").default("manual").notNull(), // SubQuoteSource
    /** bid_submissions.id when imported from the bid module (#203) */
    sourceId: text("source_id"),
    currency: text("currency").default("USD").notNull(),
    quotedTotal: doublePrecision("quoted_total").default(0).notNull(),
    /** our own adjustment to make the quote comparable (scope added back) */
    adjustmentAmount: doublePrecision("adjustment_amount").default(0).notNull(),
    levelledTotal: doublePrecision("levelled_total").default(0).notNull(),
    quoteDate: text("quote_date"), // ISO date
    validUntil: text("valid_until"), // ISO date
    inclusions: text("inclusions"),
    exclusions: text("exclusions"),
    qualifications: text("qualifications"),
    lineCount: integer("line_count").default(0).notNull(),
    documentIds: jsonb("document_ids").$type<string[]>().default([]).notNull(),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    acceptedBy: text("accepted_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("estimate_sub_quotes_uq").on(t.projectId, t.number),
    index("estimate_sub_quotes_project_idx").on(t.projectId, t.status),
    index("estimate_sub_quotes_estimate_idx").on(t.estimateId),
    index("estimate_sub_quotes_package_idx").on(t.projectId, t.tradePackage),
    index("estimate_sub_quotes_validity_idx").on(t.companyId, t.validUntil),
  ],
);

/** One priced row of a sub-quote, mapped onto an estimate line when accepted. */
export const estimateSubQuoteLines = pgTable(
  "estimate_sub_quote_lines",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    subQuoteId: text("sub_quote_id").notNull(),
    position: integer("position").default(0).notNull(),
    itemCode: text("item_code"),
    description: text("description").notNull(),
    /** the neutral scope key quotes are compared on — free text, normalised */
    scopeKey: text("scope_key"),
    unit: text("unit"),
    quantity: doublePrecision("quantity"),
    unitRate: doublePrecision("unit_rate"),
    amount: doublePrecision("amount").default(0).notNull(),
    costCodeId: text("cost_code_id"),
    costCode: text("cost_code"),
    costType: text("cost_type").default("subcontract").notNull(), // CostType
    /** the bidder says this scope is NOT in the price */
    excluded: integer("excluded").default(0).notNull(),
    note: text("note"),
    /** the estimate line this row was accepted onto */
    estimateLineItemId: text("estimate_line_item_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("estimate_sub_quote_lines_quote_idx").on(t.subQuoteId, t.position),
    index("estimate_sub_quote_lines_project_idx").on(t.projectId),
    index("estimate_sub_quote_lines_scope_idx").on(t.projectId, t.scopeKey),
  ],
);

/* ------------------------------------------------------------------ */
/* Proposals                                                           */
/* ------------------------------------------------------------------ */

/**
 * A proposal generated from an estimate (#205). The document body is FROZEN
 * into jsonb at generation time: what was sent to a client must not change
 * because somebody later edited a rate. Regenerating produces a new version.
 */
export const estimateProposals = pgTable(
  "estimate_proposals",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    estimateId: text("estimate_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    clientName: text("client_name"),
    status: text("status").default("draft").notNull(), // EstimateProposalStatus
    currency: text("currency").default("USD").notNull(),
    total: doublePrecision("total").default(0).notNull(),
    /** the frozen document: { sections, markups, totals, notes, generatedAt } */
    document: jsonb("document").$type<Record<string, unknown>>().default({}).notNull(),
    /** how much detail the client sees: summary | section | line */
    detailLevel: text("detail_level").default("section").notNull(),
    validUntil: text("valid_until"), // ISO date
    coveringNote: text("covering_note"),
    exclusions: text("exclusions"),
    assumptions: text("assumptions"),
    issuedBy: text("issued_by"),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "string" }),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("estimate_proposals_uq").on(t.projectId, t.number),
    index("estimate_proposals_estimate_idx").on(t.estimateId),
    index("estimate_proposals_project_idx").on(t.projectId, t.status),
  ],
);
