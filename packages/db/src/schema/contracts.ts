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
 * Contract intelligence (spec Vol II Domain C / module M8).
 * A contract instantiates a standard form (FIDIC/NEC/JCT) whose clause
 * library lives in code (apps/api/src/modules/contracts/clause-library.ts);
 * `particularConditions` records clause-level amendments against the
 * standard form (#201-202). Time-barred clauses drive notice deadlines on
 * contract events, materialized as assurance Obligations.
 */
export const contracts = pgTable(
  "contracts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    form: text("form").notNull(), // ContractForm
    necOption: text("nec_option"), // NecOption, NEC forms only
    /** { employer, contractor, administrator } — administrator is the
     *  Engineer (FIDIC) / Project Manager (NEC) / CA (JCT) */
    parties: jsonb("parties").$type<Record<string, string>>().default({}).notNull(),
    baseDate: text("base_date"),
    commencementDate: text("commencement_date"),
    completionDate: text("completion_date"),
    currency: text("currency").default("USD").notNull(),
    contractSum: doublePrecision("contract_sum"),
    retentionPercent: doublePrecision("retention_percent").default(0).notNull(),
    retentionCap: doublePrecision("retention_cap"),
    defectsPeriodMonths: integer("defects_period_months"),
    ldRatePerDay: doublePrecision("ld_rate_per_day"),
    ldCap: doublePrecision("ld_cap"),
    /** [{ clauseRef, amendment }] — Particular Conditions overlay */
    particularConditions: jsonb("particular_conditions").$type<unknown[]>().default([]).notNull(),
    status: text("status").default("draft").notNull(), // ContractStatus
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("contracts_project_idx").on(t.projectId)],
);

/**
 * Contract event / notice register (#225-236): early warnings, compensation
 * events, claim notices, payment notices. `noticeDeadline` is computed from
 * the clause's time bar at creation; `obligationId` links the materialized
 * assurance Obligation that tracks the deadline.
 */
export const contractEvents = pgTable(
  "contract_events",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    contractId: text("contract_id").notNull(),
    number: integer("number").notNull(),
    kind: text("kind").notNull(), // ContractEventKind
    clauseRef: text("clause_ref"),
    title: text("title").notNull(),
    description: text("description"),
    eventDate: text("event_date").notNull(), // ISO date the event occurred / awareness date
    noticeDeadline: text("notice_deadline"), // ISO date, from clause time bar
    noticeServedAt: timestamp("notice_served_at", { withTimezone: true, mode: "string" }),
    noticeMethod: text("notice_method"), // email | letter | portal | registered_post
    noticeReference: text("notice_reference"),
    status: text("status").default("open").notNull(), // ContractEventStatus
    obligationId: text("obligation_id"),
    costImpactEstimate: doublePrecision("cost_impact_estimate"),
    timeImpactDaysEstimate: integer("time_impact_days_estimate"),
    raisedBy: text("raised_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("contract_events_uq").on(t.contractId, t.number),
    index("contract_events_project_idx").on(t.projectId),
    index("contract_events_deadline_idx").on(t.status, t.noticeDeadline),
  ],
);

/** Extension of time claims (#237-240). */
export const eotClaims = pgTable(
  "eot_claims",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    contractId: text("contract_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    clauseRef: text("clause_ref"),
    /** contract event ids supporting the claim */
    eventIds: jsonb("event_ids").$type<string[]>().default([]).notNull(),
    daysClaimed: integer("days_claimed").notNull(),
    daysAwarded: integer("days_awarded"),
    status: text("status").default("notified").notNull(), // EotStatus
    narrative: text("narrative"),
    assessedBy: text("assessed_by"),
    assessedAt: timestamp("assessed_at", { withTimezone: true, mode: "string" }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("eot_claims_uq").on(t.contractId, t.number),
    index("eot_claims_project_idx").on(t.projectId),
  ],
);
