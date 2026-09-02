/**
 * SUPPLY CHAIN, LOGISTICS & OFFSITE MANUFACTURE — schema (spec Vol II Domain U
 * #913–947; Vol I §5.4 #719–730).
 *
 * Six registers, one chain:
 *
 *   supply chain map      nodes (who) and links (who feeds whom), tiered
 *    └ long-lead items    what must be ordered by when, against the programme
 *        └ offsite units  what is being built in a factory, stage by stage
 *            └ delivery slots   when it comes through which gate on what vehicle
 *                └ trace records  heat/batch → certificate → installed location
 *   supplier risk snapshots   what the engine concluded about each node, and why
 *
 * Every table is company-scoped; every project record carries project_id.
 * What this schema deliberately does NOT duplicate: the materials catalogue,
 * deliveries-with-lines and stock movements (equipment.material_*), vendors
 * (directory.vendors), screened legal entities (assurance.entities), carbon
 * entries (esg.carbon_entries) and schedule tasks — it links to them by id.
 */
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
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

/* ------------------------------------------------------------------ */
/* Supply chain map (#913–916)                                         */
/* ------------------------------------------------------------------ */

/**
 * A party on the project's supply chain map. Tier 1 is contracted directly;
 * tier 2 supplies tier 1; and so on. `vendorId` links the directory record
 * when there is one, `entityId` the screened legal entity when the assurance
 * layer holds it — a tier-3 mill is often known only by name and country.
 */
export const supplyChainNodes = pgTable(
  "supply_chain_nodes",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").default("vendor").notNull(), // SupplyNodeKind
    tier: integer("tier").default(1).notNull(),
    /** ISO 3166-1 alpha-2 where known */
    country: text("country"),
    city: text("city"),
    criticality: text("criticality").default("medium").notNull(), // SupplyCriticality
    /** what they supply: trade codes or commodity categories */
    categories: jsonb("categories").$type<string[]>().default([]).notNull(),
    /** directory.vendors.id */
    vendorId: text("vendor_id"),
    /** assurance.entities.id — sanctions/PEP screening lives there */
    entityId: text("entity_id"),
    /** financials.commitments.id where the node holds a PO/subcontract */
    commitmentId: text("commitment_id"),
    annualValue: doublePrecision("annual_value"),
    currency: text("currency").default("USD").notNull(),
    leadTimeDays: integer("lead_time_days"),
    status: text("status").default("active").notNull(), // SupplyNodeStatus
    notes: text("notes"),
    /* the latest risk assessment, denormalised for the map read */
    riskLevel: text("risk_level"), // SupplierRiskLevel
    riskScore: doublePrecision("risk_score"),
    riskAssessedAt: ts("risk_assessed_at"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("supply_chain_nodes_project_idx").on(t.projectId, t.status),
    index("supply_chain_nodes_company_idx").on(t.companyId),
    index("supply_chain_nodes_vendor_idx").on(t.vendorId),
    index("supply_chain_nodes_tier_idx").on(t.projectId, t.tier),
  ],
);

/** An edge: `fromNodeId` (upstream) supplies `toNodeId` (downstream). */
export const supplyChainLinks = pgTable(
  "supply_chain_links",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    fromNodeId: text("from_node_id").notNull(),
    toNodeId: text("to_node_id").notNull(),
    kind: text("kind").default("supplies").notNull(), // SupplyLinkKind
    /** what flows along the edge */
    description: text("description"),
    category: text("category"),
    /** declared by the buyer: no alternative source exists for this flow */
    isSoleSource: integer("is_sole_source").default(0).notNull(),
    leadTimeDays: integer("lead_time_days"),
    value: doublePrecision("value"),
    currency: text("currency"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("supply_chain_links_uq").on(t.fromNodeId, t.toNodeId, t.kind),
    index("supply_chain_links_project_idx").on(t.projectId),
    index("supply_chain_links_to_idx").on(t.toNodeId),
  ],
);

/* ------------------------------------------------------------------ */
/* Long-lead procurement (#918–921, #727–728)                          */
/* ------------------------------------------------------------------ */

/**
 * A long-lead item: the thing that must be ORDERED BY a date the programme
 * dictates. `requiredOnSite` is copied from the linked schedule task's start
 * (and refreshed on recompute) so the order-by date follows the programme;
 * `orderByDate`, `floatDays`, `riskLevel` and `riskReasons` are engine
 * outputs persisted at write so the register is one scan.
 */
export const longLeadItems = pgTable(
  "long_lead_items",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category"),
    /* who */
    supplierNodeId: text("supplier_node_id"),
    vendorId: text("vendor_id"),
    commitmentId: text("commitment_id"),
    purchaseOrderRef: text("purchase_order_ref"),
    /** equipment.material_items.id — the catalogue line it becomes on site */
    materialItemId: text("material_item_id"),
    /* programme linkage */
    scheduleTaskId: text("schedule_task_id"),
    scheduleTaskName: text("schedule_task_name"),
    requiredOnSite: text("required_on_site"), // ISO date
    /** true when requiredOnSite is copied from the task rather than typed */
    requiredFromSchedule: integer("required_from_schedule").default(0).notNull(),
    leadTimeDays: integer("lead_time_days").default(0).notNull(),
    /** contingency between arrival and need */
    bufferDays: integer("buffer_days").default(0).notNull(),
    /* engine outputs */
    orderByDate: text("order_by_date"),
    floatDays: integer("float_days"),
    riskLevel: text("risk_level").default("not_assessable").notNull(), // LongLeadRiskLevel
    riskReasons: jsonb("risk_reasons").$type<string[]>().default([]).notNull(),
    riskAssessedAt: ts("risk_assessed_at"),
    /* milestones: planned and actual */
    plannedOrderDate: text("planned_order_date"),
    actualOrderDate: text("actual_order_date"),
    plannedProductionStart: text("planned_production_start"),
    actualProductionStart: text("actual_production_start"),
    plannedShipDate: text("planned_ship_date"),
    actualShipDate: text("actual_ship_date"),
    plannedArrivalDate: text("planned_arrival_date"),
    /** the supplier's latest promise, which the engine tests against need */
    forecastArrivalDate: text("forecast_arrival_date"),
    actualArrivalDate: text("actual_arrival_date"),
    customsRequired: integer("customs_required").default(0).notNull(),
    customsClearedAt: text("customs_cleared_at"),
    installedAt: text("installed_at"),
    status: text("status").default("identified").notNull(), // LongLeadStatus
    /* commercial */
    quantity: doublePrecision("quantity"),
    unit: text("unit"),
    value: doublePrecision("value"),
    currency: text("currency").default("USD").notNull(),
    incoterms: text("incoterms"),
    originCountry: text("origin_country"),
    /* expediting */
    expeditingOwnerId: text("expediting_owner_id"),
    lastExpeditedAt: ts("last_expedited_at"),
    expeditingCount: integer("expediting_count").default(0).notNull(),
    /** the open signal for this item, so a repeat sweep is idempotent */
    signalId: text("signal_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("long_lead_items_uq").on(t.projectId, t.number),
    index("long_lead_items_project_idx").on(t.projectId, t.status),
    index("long_lead_items_risk_idx").on(t.projectId, t.riskLevel),
    index("long_lead_items_task_idx").on(t.scheduleTaskId),
    index("long_lead_items_order_by_idx").on(t.companyId, t.orderByDate),
  ],
);

/** The expediting log: every chase, visit and promise, in order. */
export const longLeadExpeditingLog = pgTable(
  "long_lead_expediting_log",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    itemId: text("item_id").notNull(),
    action: text("action").notNull(), // ExpeditingAction
    note: text("note"),
    contactName: text("contact_name"),
    /** the date the supplier promised, if this entry recorded one */
    promisedDate: text("promised_date"),
    loggedBy: text("logged_by").notNull(),
    loggedAt: ts("logged_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("long_lead_expediting_item_idx").on(t.itemId, t.loggedAt)],
);

/* ------------------------------------------------------------------ */
/* Offsite / modular production (#922–929)                             */
/* ------------------------------------------------------------------ */

/**
 * A unit manufactured off site with a unique identifier that survives from
 * design to installation (#927–928). Stage counts and percent complete are
 * materialised from the stages table; `percentVerifiedForPayment` is what
 * an inspector has actually witnessed, which is what a valuation may rely on
 * (#924), never the factory's self-reported percent.
 */
export const offsiteUnits = pgTable(
  "offsite_units",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    name: text("name").notNull(),
    unitType: text("unit_type").default("volumetric_module").notNull(), // OffsiteUnitType
    /** the manufacturer's serial / the DfMA unique identifier */
    serialNumber: text("serial_number"),
    designReference: text("design_reference"),
    factoryNodeId: text("factory_node_id"),
    vendorId: text("vendor_id"),
    longLeadItemId: text("long_lead_item_id"),
    /** where it is installed (core.locations) */
    locationId: text("location_id"),
    scheduleTaskId: text("schedule_task_id"),
    status: text("status").default("planned").notNull(), // OffsiteUnitStatus
    /* materialised from stages */
    stagesTotal: integer("stages_total").default(0).notNull(),
    stagesComplete: integer("stages_complete").default(0).notNull(),
    percentComplete: doublePrecision("percent_complete").default(0).notNull(),
    qaGatesTotal: integer("qa_gates_total").default(0).notNull(),
    qaGatesPassed: integer("qa_gates_passed").default(0).notNull(),
    qaGatesFailed: integer("qa_gates_failed").default(0).notNull(),
    /* dates */
    plannedProductionStart: text("planned_production_start"),
    plannedProductionEnd: text("planned_production_end"),
    actualProductionStart: text("actual_production_start"),
    actualProductionEnd: text("actual_production_end"),
    plannedDeliveryDate: text("planned_delivery_date"),
    actualDeliveryDate: text("actual_delivery_date"),
    installedAt: text("installed_at"),
    /* title, storage and insurance while it sits in the factory (#925–926) */
    vestingCertificateFileId: text("vesting_certificate_file_id"),
    vestingCertifiedAt: text("vesting_certified_at"),
    titleTransferredAt: text("title_transferred_at"),
    storageLocationText: text("storage_location_text"),
    storageInsuredUntil: text("storage_insured_until"),
    storageInspectedAt: text("storage_inspected_at"),
    /* payment verification (#924) */
    value: doublePrecision("value"),
    currency: text("currency").default("USD").notNull(),
    percentVerifiedForPayment: doublePrecision("percent_verified_for_payment"),
    verifiedForPaymentBy: text("verified_for_payment_by"),
    verifiedForPaymentAt: ts("verified_for_payment_at"),
    /* transport */
    deliverySlotId: text("delivery_slot_id"),
    transportKm: doublePrecision("transport_km"),
    weightTonnes: doublePrecision("weight_tonnes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("offsite_units_uq").on(t.projectId, t.number),
    index("offsite_units_project_idx").on(t.projectId, t.status),
    index("offsite_units_factory_idx").on(t.factoryNodeId),
    index("offsite_units_task_idx").on(t.scheduleTaskId),
  ],
);

/**
 * One production stage of a unit. A stage marked `isQaGate` blocks the unit
 * from advancing until a verifier other than the person who completed the
 * stage records the gate result.
 */
export const offsiteProductionStages = pgTable(
  "offsite_production_stages",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    unitId: text("unit_id").notNull(),
    position: integer("position").default(0).notNull(),
    name: text("name").notNull(),
    status: text("status").default("not_started").notNull(), // ProductionStageStatus
    plannedStart: text("planned_start"),
    plannedEnd: text("planned_end"),
    actualStart: text("actual_start"),
    actualEnd: text("actual_end"),
    completedBy: text("completed_by"),
    isQaGate: integer("is_qa_gate").default(0).notNull(),
    qaResult: text("qa_result").default("pending").notNull(), // QaGateResult
    qaVerifiedBy: text("qa_verified_by"),
    qaVerifiedAt: ts("qa_verified_at"),
    qaNotes: text("qa_notes"),
    evidenceFileIds: jsonb("evidence_file_ids").$type<string[]>().default([]).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("offsite_stages_unit_idx").on(t.unitId, t.position)],
);

/** Factory acceptance tests, witness visits, storage and insurance inspections (#923, #926). */
export const factoryInspections = pgTable(
  "factory_inspections",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    unitId: text("unit_id"),
    longLeadItemId: text("long_lead_item_id"),
    nodeId: text("node_id"),
    kind: text("kind").default("factory_acceptance_test").notNull(), // FactoryInspectionKind
    title: text("title").notNull(),
    scheduledFor: text("scheduled_for"), // ISO date
    performedAt: text("performed_at"),
    inspectorId: text("inspector_id"),
    inspectorName: text("inspector_name"),
    result: text("result").default("scheduled").notNull(), // FactoryInspectionResult
    findings: text("findings"),
    /** percent of the unit's value the inspector verified as complete */
    percentVerified: doublePrecision("percent_verified"),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("factory_inspections_project_idx").on(t.projectId, t.result),
    index("factory_inspections_unit_idx").on(t.unitId),
  ],
);

/* ------------------------------------------------------------------ */
/* Logistics: gates and delivery slots (#930–939, #720–722)            */
/* ------------------------------------------------------------------ */

/** A site gate with its operating window and capacity per slot. */
export const siteGates = pgTable(
  "site_gates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    code: text("code"),
    description: text("description"),
    /** HH:MM local — outside this window no slot may be booked */
    opensAt: text("opens_at").default("07:00").notNull(),
    closesAt: text("closes_at").default("18:00").notNull(),
    /** vehicles that can be handled at once */
    concurrentSlots: integer("concurrent_slots").default(1).notNull(),
    slotMinutes: integer("slot_minutes").default(30).notNull(),
    /** the largest vehicle the approach can take */
    maxVehicleType: text("max_vehicle_type"),
    craneAvailable: integer("crane_available").default(0).notNull(),
    laydownAreas: jsonb("laydown_areas").$type<string[]>().default([]).notNull(),
    status: text("status").default("open").notNull(), // SiteGateStatus
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("site_gates_project_idx").on(t.projectId, t.status)],
);

/**
 * A booked delivery slot: which gate, when, what vehicle, whether it needs the
 * crane. `wasOnTime`/`lateMinutes` are stamped on completion, and the
 * transport carbon is written to esg.carbon_entries (module A4) when km are
 * known — `carbonEntryId` is the link back.
 */
export const deliverySlots = pgTable(
  "delivery_slots",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    gateId: text("gate_id").notNull(),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    status: text("status").default("requested").notNull(), // DeliverySlotStatus
    /* what and who */
    description: text("description").notNull(),
    supplierNodeId: text("supplier_node_id"),
    vendorId: text("vendor_id"),
    longLeadItemId: text("long_lead_item_id"),
    offsiteUnitId: text("offsite_unit_id"),
    /** equipment.material_deliveries.id — the receipt with its lines */
    materialDeliveryId: text("material_delivery_id"),
    scheduleTaskId: text("schedule_task_id"),
    /* vehicle */
    vehicleType: text("vehicle_type").default("rigid_18t").notNull(), // VehicleType
    vehicleRegistration: text("vehicle_registration"),
    haulierName: text("haulier_name"),
    driverName: text("driver_name"),
    driverPhone: text("driver_phone"),
    craneRequired: integer("crane_required").default(0).notNull(),
    craneMinutes: integer("crane_minutes"),
    laydownArea: text("laydown_area"),
    /* actuals */
    arrivedAt: ts("arrived_at"),
    unloadingStartedAt: ts("unloading_started_at"),
    completedAt: ts("completed_at"),
    waitingMinutes: integer("waiting_minutes"),
    wasOnTime: integer("was_on_time"),
    lateMinutes: integer("late_minutes"),
    issueKind: text("issue_kind").default("none").notNull(), // DeliveryIssueKind
    issueNotes: text("issue_notes"),
    /* transport carbon hook (#945) */
    transportMode: text("transport_mode").default("road").notNull(), // TransportMode
    originText: text("origin_text"),
    originCountry: text("origin_country"),
    transportKm: doublePrecision("transport_km"),
    loadTonnes: doublePrecision("load_tonnes"),
    carbonKgCo2e: doublePrecision("carbon_kg_co2e"),
    carbonBasis: text("carbon_basis"),
    carbonEntryId: text("carbon_entry_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    bookedBy: text("booked_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("delivery_slots_uq").on(t.projectId, t.number),
    index("delivery_slots_gate_idx").on(t.gateId, t.startsAt),
    index("delivery_slots_project_idx").on(t.projectId, t.status, t.startsAt),
    index("delivery_slots_task_idx").on(t.scheduleTaskId),
    index("delivery_slots_item_idx").on(t.longLeadItemId),
  ],
);

/* ------------------------------------------------------------------ */
/* Material traceability (#945–947, #721–725)                          */
/* ------------------------------------------------------------------ */

/**
 * One traceable lot: heat/batch/serial → the certificates that vouch for it →
 * the location it went into. `certificates` is the chain itself, so a
 * structural sign-off can be answered from one row.
 * Certificate: { id, kind, reference, fileId?, issuedBy?, issuedAt?, verifiedBy?, verifiedAt? }
 */
export const materialTraceRecords = pgTable(
  "material_trace_records",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    description: text("description").notNull(),
    materialType: text("material_type"),
    heatNumber: text("heat_number"),
    batchNumber: text("batch_number"),
    lotNumber: text("lot_number"),
    serialNumber: text("serial_number"),
    quantity: doublePrecision("quantity"),
    unit: text("unit"),
    /* provenance */
    supplierNodeId: text("supplier_node_id"),
    vendorId: text("vendor_id"),
    manufacturer: text("manufacturer"),
    originCountry: text("origin_country"),
    /* links into the platform's other registers */
    materialItemId: text("material_item_id"),
    materialDeliveryLineId: text("material_delivery_line_id"),
    deliverySlotId: text("delivery_slot_id"),
    longLeadItemId: text("long_lead_item_id"),
    offsiteUnitId: text("offsite_unit_id"),
    /* the chain */
    certificates: jsonb("certificates").$type<unknown[]>().default([]).notNull(),
    certificateCount: integer("certificate_count").default(0).notNull(),
    /** CE / UKCA marking reference where the product needs one (#947) */
    conformityMarking: text("conformity_marking"),
    responsibleSourcingScheme: text("responsible_sourcing_scheme"),
    status: text("status").default("received").notNull(), // TraceStatus
    receivedAt: text("received_at"),
    installedAt: text("installed_at"),
    installedLocationId: text("installed_location_id"),
    installedRef: text("installed_ref"),
    installedBy: text("installed_by"),
    /* engine output: is the chain complete and why not */
    chainComplete: integer("chain_complete").default(0).notNull(),
    chainGaps: jsonb("chain_gaps").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("material_trace_records_uq").on(t.projectId, t.number),
    index("material_trace_project_idx").on(t.projectId, t.status),
    index("material_trace_heat_idx").on(t.companyId, t.heatNumber),
    index("material_trace_batch_idx").on(t.companyId, t.batchNumber),
    index("material_trace_location_idx").on(t.installedLocationId),
    index("material_trace_item_idx").on(t.materialItemId),
  ],
);

/* ------------------------------------------------------------------ */
/* Supplier risk snapshots (#915–917, #946)                            */
/* ------------------------------------------------------------------ */

/**
 * What the supplier risk engine concluded about one node on one run: the
 * score, the level, every flag with its basis, and the inputs it saw. A
 * snapshot is never edited — the next run writes a new one — so a change in
 * risk is a comparison of two rows, not a lost overwrite.
 * Flag: { code: SupplyRiskFlag, severity, detail, basis }
 */
export const supplierRiskAssessments = pgTable(
  "supplier_risk_assessments",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    nodeId: text("node_id").notNull(),
    vendorId: text("vendor_id"),
    assessedAt: ts("assessed_at").notNull(),
    score: doublePrecision("score"),
    level: text("level").notNull(), // SupplierRiskLevel
    flags: jsonb("flags").$type<unknown[]>().default([]).notNull(),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().default({}).notNull(),
    basis: text("basis").notNull(),
    /** signals raised by this assessment, for idempotent re-runs */
    signalIds: jsonb("signal_ids").$type<string[]>().default([]).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("supplier_risk_node_idx").on(t.nodeId, t.assessedAt),
    index("supplier_risk_project_idx").on(t.projectId, t.assessedAt),
  ],
);
