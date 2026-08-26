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
 * EQUIPMENT, PLANT & MATERIALS (module M23).
 *
 * PLANT COSTS MONEY WHETHER OR NOT IT IS WORKING. A 30-tonne excavator on
 * full hire standing idle for three weeks is not a fleet-management problem,
 * it is a commercial one, and it is invisible in a register that only records
 * what machines exist. `equipment_utilisation` therefore splits every day
 * into working / idle / standby / downtime hours and demands an `idleReason`
 * — because "awaiting materials" and "weather" produce entirely different
 * conversations and only one of them is recoverable from someone.
 *
 * CERTIFICATES EXPIRE. A crane whose thorough examination lapsed yesterday is
 * unlawful to operate today. `equipment_certificates.validTo` is the column
 * the whole table exists for, and `obligationId` binds the renewal to the
 * platform's time-bar machinery (ADR 0012) so the lapse is a Signal before it
 * is an enforcement notice.
 *
 * TELEMATICS IS AN INDEPENDENT EVIDENCE STREAM (ADR 0014). An OEM feed
 * asserting 6.2 engine hours is not the same fact as an operator's timesheet
 * claiming 9 — the difference is the product. `equipment_telematics_readings`
 * is shaped to be PUSHED INTO by the existing ingestion module: it carries
 * `providerKey` + `deviceId` + `externalId` for idempotent replay,
 * `ingestionRunId` and `apiTokenId` for provenance back to the run and the
 * machine credential that pushed it (ingestion.ts), and `raw` so the vendor
 * payload survives whatever the mapper made of it.
 *
 * MATERIALS live in the same file because on site they are the same
 * conversation: what arrived, what was rejected, what is left in the
 * compound. `material_deliveries` records discrepancies per LINE, because a
 * delivery is short on one item and damaged on another and the supplier's
 * invoice will claim all of it.
 *
 * REFERENCES OUT, NOT DUPLICATES: operators are `workers` (workforce.ts),
 * hire is a `commitments` row (financials.ts), cost lands on
 * `budget_line_items`, and a machine handed over to operations becomes an
 * `assets` row (twin.ts) — never a second register here.
 */
export const equipment = pgTable(
  "equipment",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = in the company fleet but not yet assigned to a project */
    projectId: text("project_id"),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    /** the sticker on the machine */
    assetTag: text("asset_tag"),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category").default("other").notNull(), // EquipmentCategory
    equipmentType: text("equipment_type"),
    ownership: text("ownership").default("owned").notNull(), // EquipmentOwnership
    manufacturer: text("manufacturer"),
    model: text("model"),
    serialNumber: text("serial_number"),
    registrationNumber: text("registration_number"),
    yearOfManufacture: integer("year_of_manufacture"),
    capacity: text("capacity"),
    /* --- ownership economics --- */
    purchaseDate: text("purchase_date"),
    purchaseCost: doublePrecision("purchase_cost"),
    bookValue: doublePrecision("book_value"),
    /** internal charge-out rate for owned plant, so owned time still costs */
    internalRateAmount: doublePrecision("internal_rate_amount"),
    /** the hire company */
    supplierVendorId: text("supplier_vendor_id"),
    hireAgreementRef: text("hire_agreement_ref"),
    /** the PO/subcontract the hire sits under (financials.commitments) */
    commitmentId: text("commitment_id"),
    hireRateAmount: doublePrecision("hire_rate_amount"),
    hireRateUnit: text("hire_rate_unit"), // HireRateUnit
    /** standing rate, usually lower than working rate — the idle-cost basis */
    idleRateAmount: doublePrecision("idle_rate_amount"),
    operatorRateAmount: doublePrecision("operator_rate_amount"),
    currency: text("currency").default("USD").notNull(),
    hireStartDate: text("hire_start_date"),
    hireEndDate: text("hire_end_date"),
    /** off-hire is where money leaks: the gap between these two is pure loss */
    offHireRequestedAt: timestamp("off_hire_requested_at", {
      withTimezone: true,
      mode: "string",
    }),
    offHiredAt: timestamp("off_hired_at", { withTimezone: true, mode: "string" }),
    offHireReference: text("off_hire_reference"),
    /* --- current state --- */
    status: text("status").default("available").notNull(), // EquipmentStatus
    condition: text("condition").default("good").notNull(), // EquipmentCondition
    locationId: text("location_id"),
    locationText: text("location_text"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    /** workforce.workers.id — the assigned operator, not a second person table */
    currentOperatorWorkerId: text("current_operator_worker_id"),
    currentAssignmentId: text("current_assignment_id"),
    /* --- metering and fuel --- */
    meterType: text("meter_type").default("hours").notNull(), // MeterType
    currentMeterReading: doublePrecision("current_meter_reading"),
    lastMeterReadingAt: timestamp("last_meter_reading_at", {
      withTimezone: true,
      mode: "string",
    }),
    fuelType: text("fuel_type").default("diesel").notNull(), // FuelType
    fuelCapacityLitres: doublePrecision("fuel_capacity_litres"),
    /** esg.carbon_factors.id — emissions per litre/kWh for this machine */
    carbonFactorId: text("carbon_factor_id"),
    /* --- telematics binding (see the file header) --- */
    telematicsProvider: text("telematics_provider"), // TelematicsProvider
    telematicsDeviceId: text("telematics_device_id"),
    telematicsLastSeenAt: timestamp("telematics_last_seen_at", {
      withTimezone: true,
      mode: "string",
    }),
    /* --- compliance and cost coding --- */
    requiresCertification: integer("requires_certification").default(0).notNull(),
    /** earliest certificate expiry, materialized for the "out of cert" view */
    nextCertificateExpiry: text("next_certificate_expiry"),
    nextMaintenanceDue: text("next_maintenance_due"),
    isCritical: integer("is_critical").default(0).notNull(),
    costCodeId: text("cost_code_id"),
    budgetLineItemId: text("budget_line_item_id"),
    /** twin.assets.id when the machine is handed over as a project asset */
    assetId: text("asset_id"),
    photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    /** acceptance onto site — never the person who requested the hire */
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("equipment_uq").on(t.companyId, t.number),
    index("equipment_project_idx").on(t.projectId, t.status),
    index("equipment_company_idx").on(t.companyId, t.category),
    index("equipment_cert_expiry_idx").on(t.companyId, t.nextCertificateExpiry),
    index("equipment_telematics_idx").on(t.telematicsProvider, t.telematicsDeviceId),
  ],
);

/** A machine's posting to a project, with the mobilisation costs that are
 *  always forgotten until the invoice arrives. */
export const equipmentAssignments = pgTable(
  "equipment_assignments",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    equipmentId: text("equipment_id").notNull(),
    /** where it came from, when moved between projects */
    fromProjectId: text("from_project_id"),
    status: text("status").default("requested").notNull(), // EquipmentAssignmentStatus
    assignedFrom: text("assigned_from").notNull(), // ISO date
    assignedTo: text("assigned_to"),
    mobilisedAt: timestamp("mobilised_at", { withTimezone: true, mode: "string" }),
    returnedAt: timestamp("returned_at", { withTimezone: true, mode: "string" }),
    locationId: text("location_id"),
    /** the programme activity the plant was brought in for */
    scheduleActivityId: text("schedule_activity_id"),
    costCodeId: text("cost_code_id"),
    budgetLineItemId: text("budget_line_item_id"),
    /** workforce.workers.id — the operator assigned with the machine */
    operatorWorkerId: text("operator_worker_id"),
    crewId: text("crew_id"),
    mobilisationCost: doublePrecision("mobilisation_cost"),
    demobilisationCost: doublePrecision("demobilisation_cost"),
    currency: text("currency").default("USD").notNull(),
    transportDocketRef: text("transport_docket_ref"),
    conditionOnArrival: text("condition_on_arrival"), // EquipmentCondition
    conditionOnReturn: text("condition_on_return"), // EquipmentCondition
    arrivalPhotoFileIds: jsonb("arrival_photo_file_ids").$type<string[]>().default([]).notNull(),
    returnPhotoFileIds: jsonb("return_photo_file_ids").$type<string[]>().default([]).notNull(),
    damageOnReturnNote: text("damage_on_return_note"),
    notes: text("notes"),
    requestedBy: text("requested_by"),
    /** approval of the hire spend — never the requester */
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("equipment_assignments_equipment_idx").on(t.equipmentId, t.assignedFrom),
    index("equipment_assignments_project_idx").on(t.projectId, t.status),
  ],
);

/** One machine, one day, one shift: where the hours actually went. See the
 *  file header on why idle time is the reason this table exists. */
export const equipmentUtilisation = pgTable(
  "equipment_utilisation",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    equipmentId: text("equipment_id").notNull(),
    assignmentId: text("assignment_id"),
    utilisationDate: text("utilisation_date").notNull(), // ISO date
    shift: text("shift").default("day").notNull(), // Shift
    /* the split — these are the numbers the commercial team argues over */
    availableHours: doublePrecision("available_hours"),
    workingHours: doublePrecision("working_hours").default(0).notNull(),
    idleHours: doublePrecision("idle_hours").default(0).notNull(),
    standbyHours: doublePrecision("standby_hours").default(0).notNull(),
    downtimeHours: doublePrecision("downtime_hours").default(0).notNull(),
    travelHours: doublePrecision("travel_hours").default(0).notNull(),
    utilisationPercent: doublePrecision("utilisation_percent"),
    /** why it stood — the field that turns a cost into an action */
    idleReason: text("idle_reason"), // IdleReason
    idleNote: text("idle_note"),
    downtimeReason: text("downtime_reason"),
    meterStart: doublePrecision("meter_start"),
    meterEnd: doublePrecision("meter_end"),
    meterDelta: doublePrecision("meter_delta"),
    fuelLitres: doublePrecision("fuel_litres"),
    fuelCost: doublePrecision("fuel_cost"),
    hireCost: doublePrecision("hire_cost"),
    operatorCost: doublePrecision("operator_cost"),
    totalCost: doublePrecision("total_cost"),
    currency: text("currency").default("USD").notNull(),
    /** production achieved, so cost-per-unit is computable */
    productionQuantity: doublePrecision("production_quantity"),
    productionUnit: text("production_unit"),
    /** workforce.workers.id */
    operatorWorkerId: text("operator_worker_id"),
    crewId: text("crew_id"),
    costCodeId: text("cost_code_id"),
    budgetLineItemId: text("budget_line_item_id"),
    locationId: text("location_id"),
    /** whether these hours are rechargeable to the client */
    isBillable: integer("is_billable").default(0).notNull(),
    tmTicketId: text("tm_ticket_id"),
    /** manual vs telematics — see EQUIPMENT_DATA_SOURCES and ADR 0014 */
    source: text("source").default("manual").notNull(), // EquipmentDataSource
    sourceRef: text("source_ref"),
    /** telematics-derived hours for the same day, for reconciliation */
    telematicsWorkingHours: doublePrecision("telematics_working_hours"),
    varianceHours: doublePrecision("variance_hours"),
    notes: text("notes"),
    /** verification of claimed hours — never the operator who claimed them */
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("equipment_utilisation_uq").on(t.equipmentId, t.utilisationDate, t.shift),
    index("equipment_utilisation_project_idx").on(t.projectId, t.utilisationDate),
    index("equipment_utilisation_idle_idx").on(t.projectId, t.idleReason),
  ],
);

/** A recurring maintenance obligation. Calendar and meter intervals race each
 *  other; whichever falls first is the due date. */
export const equipmentMaintenanceSchedules = pgTable(
  "equipment_maintenance_schedules",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    equipmentId: text("equipment_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    maintenanceType: text("maintenance_type").default("preventive").notNull(), // MaintenanceType
    intervalKind: text("interval_kind").default("operating_hours").notNull(), // MaintenanceIntervalKind
    intervalValue: doublePrecision("interval_value").notNull(),
    /** how far ahead to raise the "due soon" warning */
    warnAheadValue: doublePrecision("warn_ahead_value"),
    lastPerformedAt: text("last_performed_at"),
    lastPerformedMeter: doublePrecision("last_performed_meter"),
    nextDueAt: text("next_due_at"),
    nextDueMeter: doublePrecision("next_due_meter"),
    status: text("status").default("active").notNull(), // MaintenanceScheduleStatus
    /** who does it — the hire company, an in-house fitter, a specialist */
    providerVendorId: text("provider_vendor_id"),
    estimatedCost: doublePrecision("estimated_cost"),
    estimatedDowntimeHours: doublePrecision("estimated_downtime_hours"),
    currency: text("currency").default("USD").notNull(),
    instructionsFileId: text("instructions_file_id"),
    /** the maintenance standard the interval comes from, e.g. an SFG20 code */
    standardReference: text("standard_reference"),
    isStatutory: integer("is_statutory").default(0).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("equipment_maintenance_schedules_equipment_idx").on(t.equipmentId, t.status),
    index("equipment_maintenance_schedules_due_idx").on(t.companyId, t.nextDueAt),
  ],
);

/** What was actually done to the machine, and when it went back to work. */
export const equipmentMaintenanceRecords = pgTable(
  "equipment_maintenance_records",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    equipmentId: text("equipment_id").notNull(),
    scheduleId: text("schedule_id"),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    maintenanceType: text("maintenance_type").default("corrective").notNull(), // MaintenanceType
    workOrderRef: text("work_order_ref"),
    description: text("description").notNull(),
    faultDescription: text("fault_description"),
    /** what actually broke, for failure-mode analysis across the fleet */
    failureMode: text("failure_mode"),
    status: text("status").default("draft").notNull(), // MaintenanceRecordStatus
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    performedAt: timestamp("performed_at", { withTimezone: true, mode: "string" }),
    /** workforce.workers.id when done in-house */
    performedByWorkerId: text("performed_by_worker_id"),
    providerVendorId: text("provider_vendor_id"),
    technicianName: text("technician_name"),
    meterReading: doublePrecision("meter_reading"),
    downtimeHours: doublePrecision("downtime_hours"),
    labourHours: doublePrecision("labour_hours"),
    /** [{ partNumber, description, quantity, unitCost }] */
    partsUsed: jsonb("parts_used").$type<unknown[]>().default([]).notNull(),
    partsCost: doublePrecision("parts_cost"),
    labourCost: doublePrecision("labour_cost"),
    totalCost: doublePrecision("total_cost"),
    currency: text("currency").default("USD").notNull(),
    /** recharged under the hire agreement or the warranty, not to us */
    isWarrantyClaim: integer("is_warranty_claim").default(0).notNull(),
    isRechargeable: integer("is_rechargeable").default(0).notNull(),
    commitmentId: text("commitment_id"),
    costCodeId: text("cost_code_id"),
    result: text("result").default("completed").notNull(), // MaintenanceResult
    returnedToServiceAt: timestamp("returned_to_service_at", {
      withTimezone: true,
      mode: "string",
    }),
    /** release back to work — a competent person, never the fitter alone */
    returnedToServiceBy: text("returned_to_service_by"),
    nextDueAt: text("next_due_at"),
    nextDueMeter: doublePrecision("next_due_meter"),
    certificateFileId: text("certificate_file_id"),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    /** verification of the work — never the person who performed it */
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("equipment_maintenance_records_uq").on(t.companyId, t.number),
    index("equipment_maintenance_records_equipment_idx").on(t.equipmentId, t.performedAt),
    index("equipment_maintenance_records_project_idx").on(t.projectId),
  ],
);

/** Statutory and contractual certificates, with the expiry that makes them
 *  matter. See the file header. */
export const equipmentCertificates = pgTable(
  "equipment_certificates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    equipmentId: text("equipment_id").notNull(),
    certificateType: text("certificate_type").notNull(), // EquipmentCertificateType
    certificateNumber: text("certificate_number"),
    title: text("title"),
    /** the competent person or body who issued it */
    issuedByName: text("issued_by_name"),
    issuerVendorId: text("issuer_vendor_id"),
    issuerAccreditation: text("issuer_accreditation"),
    issuedAt: text("issued_at"),
    validFrom: text("valid_from"),
    /** THE column: everything else here supports watching this date */
    validTo: text("valid_to").notNull(),
    inspectionIntervalMonths: integer("inspection_interval_months"),
    nextInspectionDue: text("next_inspection_due"),
    result: text("result").default("pass").notNull(), // CertificateResult
    conditions: text("conditions"),
    /** [{ defect, severity, actionRequired, dueDate }] */
    defectsNoted: jsonb("defects_noted").$type<unknown[]>().default([]).notNull(),
    safeWorkingLoad: text("safe_working_load"),
    status: text("status").default("valid").notNull(), // EquipmentCertificateStatus
    fileId: text("file_id"),
    fileSha256: text("file_sha256"),
    /** verification that the certificate is genuine — never the hire desk */
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    verificationMethod: text("verification_method"),
    supersedesId: text("supersedes_id"),
    supersededById: text("superseded_by_id"),
    /** renewal bound to the obligations register (ADR 0012) */
    obligationId: text("obligation_id"),
    signalId: text("signal_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("equipment_certificates_equipment_idx").on(t.equipmentId, t.certificateType),
    index("equipment_certificates_expiry_idx").on(t.companyId, t.validTo),
    index("equipment_certificates_project_idx").on(t.projectId, t.status),
  ],
);

/**
 * Manually captured meter and fuel readings. Kept at this grain — one row per
 * reading rather than a running total on the machine — because fuel theft is
 * detected in the deltas: a 400-litre fill on a machine with a 250-litre tank
 * is an anomaly no aggregate would ever show.
 */
export const equipmentReadings = pgTable(
  "equipment_readings",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    equipmentId: text("equipment_id").notNull(),
    readingType: text("reading_type").notNull(), // EquipmentReadingType
    readAt: timestamp("read_at", { withTimezone: true, mode: "string" }).notNull(),
    value: doublePrecision("value"),
    unit: text("unit"),
    previousValue: doublePrecision("previous_value"),
    delta: doublePrecision("delta"),
    /* fuel specifics */
    fuelLitres: doublePrecision("fuel_litres"),
    fuelCost: doublePrecision("fuel_cost"),
    currency: text("currency"),
    fuelCardRef: text("fuel_card_ref"),
    supplierVendorId: text("supplier_vendor_id"),
    docketNumber: text("docket_number"),
    /** workforce.workers.id — who took the reading or filled the tank */
    operatorWorkerId: text("operator_worker_id"),
    locationId: text("location_id"),
    locationText: text("location_text"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    source: text("source").default("manual").notNull(), // EquipmentDataSource
    sourceRef: text("source_ref"),
    photoFileId: text("photo_file_id"),
    /** flagged by the anomaly check — the reason for the grain (see above) */
    isAnomalous: integer("is_anomalous").default(0).notNull(),
    anomalyNote: text("anomaly_note"),
    signalId: text("signal_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("equipment_readings_equipment_idx").on(t.equipmentId, t.readAt),
    index("equipment_readings_type_idx").on(t.equipmentId, t.readingType, t.readAt),
    index("equipment_readings_project_idx").on(t.projectId),
  ],
);

/**
 * Machine-pushed telematics. Shaped for the ingestion module: an external
 * feed authenticates with an `api_tokens` credential, its rows land here with
 * `ingestionRunId` provenance, and `(providerKey, deviceId, recordedAt)` is
 * unique so a replayed batch is idempotent rather than doubled. `equipmentId`
 * is nullable — a device may report before anyone has mapped it to a machine,
 * and dropping those rows would lose exactly the data that proves when the
 * mapping was wrong.
 */
export const equipmentTelematicsReadings = pgTable(
  "equipment_telematics_readings",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    /** null until the device is mapped to a machine */
    equipmentId: text("equipment_id"),
    providerKey: text("provider_key").notNull(), // TelematicsProvider
    deviceId: text("device_id").notNull(),
    /** the provider's own row id, for dedupe across overlapping pulls */
    externalId: text("external_id"),
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "string" }).notNull(),
    receivedAt: createdAt(),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    altitudeMetres: doublePrecision("altitude_metres"),
    headingDegrees: doublePrecision("heading_degrees"),
    speedKph: doublePrecision("speed_kph"),
    engineRunning: integer("engine_running"),
    engineHours: doublePrecision("engine_hours"),
    idleHours: doublePrecision("idle_hours"),
    odometerKm: doublePrecision("odometer_km"),
    fuelLevelPercent: doublePrecision("fuel_level_percent"),
    fuelUsedLitres: doublePrecision("fuel_used_litres"),
    engineLoadPercent: doublePrecision("engine_load_percent"),
    coolantTempC: doublePrecision("coolant_temp_c"),
    batteryVoltage: doublePrecision("battery_voltage"),
    defLevelPercent: doublePrecision("def_level_percent"),
    payloadTonnes: doublePrecision("payload_tonnes"),
    /** [{ code, description, severity, activeSince }] */
    faultCodes: jsonb("fault_codes").$type<unknown[]>().default([]).notNull(),
    /** the vendor payload verbatim — evidence survives the mapper */
    raw: jsonb("raw").$type<Record<string, unknown>>().default({}).notNull(),
    /* provenance back into ingestion.ts */
    ingestionRunId: text("ingestion_run_id"),
    apiTokenId: text("api_token_id"),
    sourceSha256: text("source_sha256"),
  },
  (t) => [
    uniqueIndex("equipment_telematics_readings_uq").on(
      t.providerKey,
      t.deviceId,
      t.recordedAt,
    ),
    index("equipment_telematics_readings_equipment_idx").on(t.equipmentId, t.recordedAt),
    index("equipment_telematics_readings_run_idx").on(t.ingestionRunId),
    index("equipment_telematics_readings_company_idx").on(t.companyId, t.recordedAt),
  ],
);

/* ------------------------------------------------------------------ */
/* Materials                                                           */
/* ------------------------------------------------------------------ */

/**
 * A material line — the thing ordered, delivered, stored and installed.
 * `projectId` is nullable so a company catalogue can exist above the
 * projects that draw from it. Quantities are materialized (ordered,
 * delivered, accepted, installed, on hand) because the site's only real
 * question — "have we got enough" — must be one row read, not an aggregate.
 */
export const materialItems = pgTable(
  "material_items",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = company catalogue item */
    projectId: text("project_id"),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    code: text("code"),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category"),
    unit: text("unit").notNull(),
    /* what specifies it — the approved product, not just any product */
    specSectionId: text("spec_section_id"),
    specSectionCode: text("spec_section_code"),
    /** the approved submittal (field.submittals) this product was cleared by */
    submittalId: text("submittal_id"),
    manufacturer: text("manufacturer"),
    modelNumber: text("model_number"),
    /* commercial */
    supplierVendorId: text("supplier_vendor_id"),
    /** the PO it is bought under (financials.commitments) */
    commitmentId: text("commitment_id"),
    costCodeId: text("cost_code_id"),
    budgetLineItemId: text("budget_line_item_id"),
    unitCost: doublePrecision("unit_cost"),
    currency: text("currency").default("USD").notNull(),
    leadTimeDays: integer("lead_time_days"),
    /* materialized quantities */
    quantityRequired: doublePrecision("quantity_required").default(0).notNull(),
    quantityOrdered: doublePrecision("quantity_ordered").default(0).notNull(),
    quantityDelivered: doublePrecision("quantity_delivered").default(0).notNull(),
    quantityAccepted: doublePrecision("quantity_accepted").default(0).notNull(),
    quantityRejected: doublePrecision("quantity_rejected").default(0).notNull(),
    quantityInstalled: doublePrecision("quantity_installed").default(0).notNull(),
    quantityWasted: doublePrecision("quantity_wasted").default(0).notNull(),
    quantityOnHand: doublePrecision("quantity_on_hand").default(0).notNull(),
    quantityReserved: doublePrecision("quantity_reserved").default(0).notNull(),
    reorderLevel: doublePrecision("reorder_level"),
    /** stamped whenever the quantities above are recomputed */
    totalsCalculatedAt: timestamp("totals_calculated_at", {
      withTimezone: true,
      mode: "string",
    }),
    storageLocationId: text("storage_location_id"),
    /* handling and environment */
    isHazardous: integer("is_hazardous").default(0).notNull(),
    coshhFileId: text("coshh_file_id"),
    storageRequirements: text("storage_requirements"),
    shelfLifeDays: integer("shelf_life_days"),
    /** esg.carbon_factors.id — embodied carbon per unit */
    carbonFactorId: text("carbon_factor_id"),
    /** whether stock movements are tracked, or it is a bulk consumable */
    isTracked: integer("is_tracked").default(1).notNull(),
    status: text("status").default("planned").notNull(), // MaterialItemStatus
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("material_items_uq").on(t.companyId, t.number),
    index("material_items_project_idx").on(t.projectId, t.status),
    index("material_items_supplier_idx").on(t.supplierVendorId),
    index("material_items_commitment_idx").on(t.commitmentId),
  ],
);

/** A delivery to site. Discrepancies are recorded per line (see the lines
 *  table) but summarised here so the "problem deliveries" view is one scan. */
export const materialDeliveries = pgTable(
  "material_deliveries",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    deliveryNoteNumber: text("delivery_note_number"),
    supplierVendorId: text("supplier_vendor_id"),
    /** the PO being delivered against */
    commitmentId: text("commitment_id"),
    purchaseOrderRef: text("purchase_order_ref"),
    carrierName: text("carrier_name"),
    vehicleRegistration: text("vehicle_registration"),
    driverName: text("driver_name"),
    status: text("status").default("scheduled").notNull(), // DeliveryStatus
    scheduledFor: timestamp("scheduled_for", { withTimezone: true, mode: "string" }),
    arrivedAt: timestamp("arrived_at", { withTimezone: true, mode: "string" }),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" }),
    /** waiting time on site — a real cost the haulier will charge for */
    waitingMinutes: integer("waiting_minutes"),
    gateEntryRef: text("gate_entry_ref"),
    locationId: text("location_id"),
    offloadLocationText: text("offload_location_text"),
    craneRequired: integer("crane_required").default(0).notNull(),
    /** the person who signed for it */
    receivedBy: text("received_by"),
    receivedByName: text("received_by_name"),
    /* discrepancies */
    hasDiscrepancy: integer("has_discrepancy").default(0).notNull(),
    /** DeliveryDiscrepancyKind[] present across the lines */
    discrepancyKinds: jsonb("discrepancy_kinds").$type<string[]>().default([]).notNull(),
    discrepancyNotes: text("discrepancy_notes"),
    lineCount: integer("line_count").default(0).notNull(),
    /** the receipt inspection (quality.checklists) */
    inspectionChecklistId: text("inspection_checklist_id"),
    /** raised when the delivery was rejected on quality grounds */
    ncrId: text("ncr_id"),
    deliveryNoteFileId: text("delivery_note_file_id"),
    weighbridgeTicketRef: text("weighbridge_ticket_ref"),
    photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
    /** three-way match: PO ↔ delivery ↔ invoice */
    invoiceMatched: integer("invoice_matched").default(0).notNull(),
    invoiceId: text("invoice_id"),
    totalValue: doublePrecision("total_value"),
    currency: text("currency").default("USD").notNull(),
    /** verification of the receipt — never the person who signed for it */
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("material_deliveries_uq").on(t.projectId, t.number),
    index("material_deliveries_project_idx").on(t.projectId, t.status),
    index("material_deliveries_supplier_idx").on(t.supplierVendorId),
    index("material_deliveries_commitment_idx").on(t.commitmentId),
  ],
);

/** One line of a delivery: expected against received against accepted. The
 *  gap between the three is the credit note. */
export const materialDeliveryLines = pgTable(
  "material_delivery_lines",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    deliveryId: text("delivery_id").notNull(),
    materialItemId: text("material_item_id"),
    position: integer("position").default(0).notNull(),
    description: text("description").notNull(),
    unit: text("unit"),
    quantityExpected: doublePrecision("quantity_expected"),
    quantityReceived: doublePrecision("quantity_received").default(0).notNull(),
    quantityAccepted: doublePrecision("quantity_accepted").default(0).notNull(),
    quantityRejected: doublePrecision("quantity_rejected").default(0).notNull(),
    discrepancyKind: text("discrepancy_kind").default("none").notNull(), // DeliveryDiscrepancyKind
    discrepancyNote: text("discrepancy_note"),
    rejectionReason: text("rejection_reason"),
    /* traceability — the paperwork a structural sign-off depends on */
    batchNumber: text("batch_number"),
    heatNumber: text("heat_number"),
    serialNumbers: jsonb("serial_numbers").$type<string[]>().default([]).notNull(),
    /** mill certs, conformity declarations, test certificates */
    certificateFileIds: jsonb("certificate_file_ids").$type<string[]>().default([]).notNull(),
    manufactureDate: text("manufacture_date"),
    expiryDate: text("expiry_date"),
    unitCost: doublePrecision("unit_cost"),
    lineTotal: doublePrecision("line_total"),
    currency: text("currency"),
    storageLocationId: text("storage_location_id"),
    photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("material_delivery_lines_delivery_idx").on(t.deliveryId, t.position),
    index("material_delivery_lines_item_idx").on(t.materialItemId),
    index("material_delivery_lines_project_idx").on(t.projectId),
  ],
);

/**
 * Every movement of stock, signed by `movementType` (see
 * STOCK_MOVEMENT_TYPES). `balanceAfter` is materialized so the compound's
 * running stock is readable without replaying the ledger, and `wastage`,
 * `damage` and `theft` are separate kinds rather than one "adjustment" so
 * material loss is measurable at all.
 */
export const materialStockMovements = pgTable(
  "material_stock_movements",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    materialItemId: text("material_item_id").notNull(),
    movementType: text("movement_type").notNull(), // StockMovementType
    /** positive for receipts and returns, negative for issues and losses */
    quantity: doublePrecision("quantity").notNull(),
    unit: text("unit"),
    movedAt: timestamp("moved_at", { withTimezone: true, mode: "string" }).notNull(),
    fromLocationId: text("from_location_id"),
    toLocationId: text("to_location_id"),
    fromProjectId: text("from_project_id"),
    toProjectId: text("to_project_id"),
    /** workforce.workers.id — who took the material */
    issuedToWorkerId: text("issued_to_worker_id"),
    issuedToVendorId: text("issued_to_vendor_id"),
    crewId: text("crew_id"),
    costCodeId: text("cost_code_id"),
    budgetLineItemId: text("budget_line_item_id"),
    scheduleActivityId: text("schedule_activity_id"),
    deliveryId: text("delivery_id"),
    deliveryLineId: text("delivery_line_id"),
    batchNumber: text("batch_number"),
    reason: text("reason"),
    unitCost: doublePrecision("unit_cost"),
    valueAmount: doublePrecision("value_amount"),
    currency: text("currency").default("USD").notNull(),
    /** running stock after this movement — materialized on write */
    balanceAfter: doublePrecision("balance_after"),
    source: text("source").default("manual").notNull(), // EquipmentDataSource
    sourceRef: text("source_ref"),
    photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
    /** sign-off on losses — never the person who reported them */
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    signalId: text("signal_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("material_stock_movements_item_idx").on(t.materialItemId, t.movedAt),
    index("material_stock_movements_project_idx").on(t.projectId, t.movementType),
    index("material_stock_movements_delivery_idx").on(t.deliveryId),
  ],
);
