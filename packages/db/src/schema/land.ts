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
 * Land, resettlement & community (spec Vol II Domain J / module M16).
 * The category of work Procore has no concept of, and frequently the largest
 * single source of delay on internationally financed infrastructure.
 * Compliance frames: IFC Performance Standard 5 / World Bank ESS5.
 */
export const landParcels = pgTable(
  "land_parcels",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    reference: text("reference").notNull(), // cadastral / plot reference
    description: text("description"),
    areaSqm: doublePrecision("area_sqm"),
    tenureType: text("tenure_type").notNull(), // TenureType
    ownerName: text("owner_name"),
    /** entity id when the owner is registered in the entity graph */
    ownerEntityId: text("owner_entity_id"),
    encumbrances: text("encumbrances"),
    status: text("status").default("identified").notNull(), // ParcelStatus
    valuationAmount: doublePrecision("valuation_amount"),
    compensationAmount: doublePrecision("compensation_amount"),
    currency: text("currency").default("USD").notNull(),
    compensationPaidAt: text("compensation_paid_at"), // ISO date
    /** links to the assurance evidence substantiating payment/verification */
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    /** blocks these schedule tasks until acquired (consent-to-programme, #591) */
    blockingTaskIds: jsonb("blocking_task_ids").$type<string[]>().default([]).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("land_parcels_uq").on(t.projectId, t.reference),
    index("land_parcels_project_idx").on(t.projectId),
  ],
);

/**
 * Project Affected Persons census (#555-557). Vulnerability screening drives
 * entitlement enhancement under IFC PS5.
 */
export const affectedPersons = pgTable(
  "affected_persons",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    reference: text("reference").notNull(), // PAP census number
    householdHead: text("household_head").notNull(),
    householdSize: integer("household_size"),
    parcelId: text("parcel_id"),
    displacementType: text("displacement_type").default("none").notNull(), // DisplacementType
    /** vulnerability flags: elderly | disabled | female_headed | landless |
     *  indigenous | below_poverty_line | child_headed */
    vulnerabilities: jsonb("vulnerabilities").$type<string[]>().default([]).notNull(),
    /** socio-economic baseline survey capture (#556) */
    baseline: jsonb("baseline").$type<Record<string, unknown>>().default({}).notNull(),
    /** entitlement matrix application (#566): [{ item, basis, amount, delivered }] */
    entitlements: jsonb("entitlements").$type<unknown[]>().default([]).notNull(),
    compensationTotal: doublePrecision("compensation_total"),
    compensationPaidAt: text("compensation_paid_at"),
    /** livelihood restoration programme tracking (#561) */
    livelihoodProgramme: text("livelihood_programme"),
    livelihoodRestoredAt: text("livelihood_restored_at"),
    status: text("status").default("registered").notNull(), // PapStatus
    /** declared before the cut-off date; later arrivals are encroachment (#564) */
    censusDate: text("census_date"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("affected_persons_uq").on(t.projectId, t.reference),
    index("affected_persons_project_idx").on(t.projectId),
  ],
);

/**
 * Community grievance redress mechanism (#569-574). SLA-driven with
 * anonymous intake and closure verified WITH the complainant.
 */
export const grievances = pgTable(
  "grievances",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    channel: text("channel").notNull(), // GrievanceChannel
    isAnonymous: integer("is_anonymous").default(0).notNull(),
    complainantName: text("complainant_name"),
    complainantContact: text("complainant_contact"),
    papId: text("pap_id"),
    category: text("category").notNull(), // land | noise | dust | access | employment | conduct | compensation | other
    severity: text("severity").default("medium").notNull(), // GrievanceSeverity
    description: text("description").notNull(),
    locationId: text("location_id"),
    receivedAt: text("received_at").notNull(), // ISO date
    /** SLA deadlines computed from severity at intake */
    acknowledgeDueAt: text("acknowledge_due_at"),
    resolveDueAt: text("resolve_due_at"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: "string" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
    resolution: text("resolution"),
    /** closure verified with the complainant (#573) */
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    verifiedBy: text("verified_by"),
    complainantSatisfied: integer("complainant_satisfied"),
    status: text("status").default("received").notNull(), // GrievanceStatus
    assigneeId: text("assignee_id"),
    obligationId: text("obligation_id"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("grievances_uq").on(t.projectId, t.number),
    index("grievances_project_idx").on(t.projectId),
    index("grievances_sla_idx").on(t.status, t.resolveDueAt),
  ],
);

/** Stakeholder register + engagement log (#579-584). */
export const stakeholders = pgTable(
  "stakeholders",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    organisation: text("organisation"),
    category: text("category"), // community | authority | ngo | media | business | indigenous_group
    /** influence/interest mapping (#579): 1-5 each */
    influence: integer("influence").default(3).notNull(),
    interest: integer("interest").default(3).notNull(),
    contact: text("contact"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("stakeholders_project_idx").on(t.projectId)],
);

export const engagements = pgTable(
  "engagements",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    title: text("title").notNull(),
    kind: text("kind").notNull(), // consultation | disclosure | meeting | site_visit | notice
    engagementDate: text("engagement_date").notNull(),
    location: text("location"),
    stakeholderIds: jsonb("stakeholder_ids").$type<string[]>().default([]).notNull(),
    attendeeCount: integer("attendee_count"),
    summary: text("summary"),
    /** feedback capture + disposition (#582): [{ point, raisedBy, disposition }] */
    feedback: jsonb("feedback").$type<unknown[]>().default([]).notNull(),
    /** FPIC process documentation (#575) */
    consentStatus: text("consent_status"), // ConsentStatus
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("engagements_project_idx").on(t.projectId, t.engagementDate)],
);
