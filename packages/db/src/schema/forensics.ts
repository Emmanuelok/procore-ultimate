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
 * Delay & disruption forensics (spec Vol II Domain D / module M9).
 * Delay events are the atoms; claims assemble events into a
 * cause → effect → entitlement → quantum chain (#305) with evidence links.
 */
export const delayEvents = pgTable(
  "delay_events",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    cause: text("cause").notNull(), // DelayCause
    /** entitlement classification (#267) */
    excusable: integer("excusable").default(0).notNull(),
    compensable: integer("compensable").default(0).notNull(),
    status: text("status").default("open").notNull(), // DelayEventStatus
    /** the schedule task the delay strikes (fragnet insertion point) */
    taskId: text("task_id"),
    scheduleId: text("schedule_id"),
    startDate: text("start_date").notNull(), // ISO date
    durationDays: integer("duration_days").notNull(),
    /** contract event (notice) raised for this delay, when any */
    contractEventId: text("contract_event_id"),
    /** assurance evidence ids substantiating the event (#306) */
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    /** last TIA result for this event: { completionDeltaDays, computedAt } */
    tiaResult: jsonb("tia_result").$type<Record<string, unknown>>(),
    raisedBy: text("raised_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("delay_events_uq").on(t.projectId, t.number),
    index("delay_events_project_idx").on(t.projectId),
  ],
);

/**
 * Claims workspace (#304-320). `chain` holds the four narrative limbs
 * { cause, effect, entitlement, quantum }; chronology is assembled on demand
 * from platform records (#318) and cached here with its generation time.
 */
export const forensicClaims = pgTable(
  "forensic_claims",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    kind: text("kind").notNull(), // ClaimKind
    status: text("status").default("draft").notNull(), // ClaimStatus
    contractId: text("contract_id"),
    clauseRef: text("clause_ref"),
    delayEventIds: jsonb("delay_event_ids").$type<string[]>().default([]).notNull(),
    chain: jsonb("chain")
      .$type<{ cause?: string; effect?: string; entitlement?: string; quantum?: string }>()
      .default({})
      .notNull(),
    daysClaimed: integer("days_claimed"),
    amountClaimed: doublePrecision("amount_claimed"),
    daysAssessed: integer("days_assessed"),
    amountAssessed: doublePrecision("amount_assessed"),
    /** prolongation build-up: { prelimsRatePerDay, compensableDays, amount } */
    prolongation: jsonb("prolongation").$type<Record<string, unknown>>(),
    chronology: jsonb("chronology").$type<unknown[]>(),
    chronologyAt: timestamp("chronology_at", { withTimezone: true, mode: "string" }),
    assessedBy: text("assessed_by"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("forensic_claims_uq").on(t.projectId, t.number),
    index("forensic_claims_project_idx").on(t.projectId),
  ],
);
