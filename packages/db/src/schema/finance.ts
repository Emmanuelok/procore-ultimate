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
 * Project finance & disbursement (spec Vol II Domain O / module M14).
 * The core discipline: money moves only when conditions are verifiably
 * satisfied. Facility conditions materialize as assurance Obligations;
 * disbursement requests are gated on open condition precedents; covenant
 * breaches raise integrity signals.
 */
export const fundingFacilities = pgTable(
  "funding_facilities",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    lender: text("lender").notNull(),
    instrument: text("instrument").notNull(), // FacilityInstrument
    currency: text("currency").default("GBP").notNull(),
    committedAmount: doublePrecision("committed_amount").notNull(),
    availabilityEndDate: text("availability_end_date"), // closing date (#741)
    /** allocation categories with limits (#739): [{ id, name, limit }] */
    categories: jsonb("categories").$type<unknown[]>().default([]).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("funding_facilities_project_idx").on(t.projectId)],
);

/** Conditions precedent / subsequent (#730-731) — obligation-backed. */
export const facilityConditions = pgTable(
  "facility_conditions",
  {
    id: text("id").primaryKey(),
    facilityId: text("facility_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    kind: text("kind").notNull(), // FacilityConditionKind
    reference: text("reference"),
    description: text("description").notNull(),
    dueDate: text("due_date"),
    status: text("status").default("open").notNull(), // FacilityConditionStatus
    /** evidence substantiating satisfaction */
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    obligationId: text("obligation_id"),
    satisfiedAt: timestamp("satisfied_at", { withTimezone: true, mode: "string" }),
    satisfiedBy: text("satisfied_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("facility_conditions_facility_idx").on(t.facilityId)],
);

/** Withdrawal applications / disbursement requests (#732-734, #740). */
export const disbursements = pgTable(
  "disbursements",
  {
    id: text("id").primaryKey(),
    facilityId: text("facility_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    amount: doublePrecision("amount").notNull(),
    categoryId: text("category_id"),
    purpose: text("purpose").notNull(),
    status: text("status").default("draft").notNull(), // DisbursementStatus
    /** expenditure evidence assembled with the request (#732, #735) */
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    /** conditionality verification snapshot at submission (#733):
     *  { verifiedAt, openConditions: [{id, reference, description}] } */
    conditionality: jsonb("conditionality").$type<Record<string, unknown>>(),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    submittedBy: text("submitted_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    approvedBy: text("approved_by"),
    disbursedAt: timestamp("disbursed_at", { withTimezone: true, mode: "string" }),
    rejectionReason: text("rejection_reason"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("disbursements_uq").on(t.facilityId, t.number),
    index("disbursements_project_idx").on(t.projectId),
  ],
);

/** Financial covenant definitions + periodic readings (#742-743). */
export const covenants = pgTable(
  "covenants",
  {
    id: text("id").primaryKey(),
    facilityId: text("facility_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** threshold test: reading value must be `operator` threshold */
    operator: text("operator").notNull(), // CovenantOperator
    threshold: doublePrecision("threshold").notNull(),
    unit: text("unit"),
    createdAt: createdAt(),
  },
  (t) => [index("covenants_facility_idx").on(t.facilityId)],
);

export const covenantReadings = pgTable(
  "covenant_readings",
  {
    id: text("id").primaryKey(),
    covenantId: text("covenant_id").notNull(),
    companyId: text("company_id").notNull(),
    readingDate: text("reading_date").notNull(),
    value: doublePrecision("value").notNull(),
    /** computed at write: value vs threshold */
    compliant: integer("compliant").notNull(),
    headroom: doublePrecision("headroom").notNull(),
    note: text("note"),
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("covenant_readings_covenant_idx").on(t.covenantId)],
);
