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
 * Statutory payment security (spec Vol II Domain F / module M10).
 * Regime rules (deadlines, consequences) live in code
 * (apps/api/src/modules/payments/regimes.ts); rows record served claims and
 * responses with their computed statutory timelines. Deadlines materialize
 * as assurance Obligations; missed responses raise signals and flip the
 * claim to `deemed`.
 */
export const paymentClaims = pgTable(
  "payment_claims",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    contractId: text("contract_id"),
    valuationId: text("valuation_id"),
    number: integer("number").notNull(),
    regime: text("regime").notNull(), // PaymentRegime
    /** statutory reference date the timeline is computed from */
    referenceDate: text("reference_date").notNull(), // ISO date
    claimedAmount: doublePrecision("claimed_amount").notNull(),
    currency: text("currency").default("GBP").notNull(),
    description: text("description"),
    servedAt: timestamp("served_at", { withTimezone: true, mode: "string" }),
    serviceMethod: text("service_method"), // email | portal | registered_post | letter
    serviceReference: text("service_reference"),
    /* computed statutory timeline (ISO dates) */
    responseDeadline: text("response_deadline"),
    finalPaymentDate: text("final_payment_date"),
    status: text("status").default("draft").notNull(), // PaymentClaimStatus
    /** obligation tracking the response deadline */
    obligationId: text("obligation_id"),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "string" }),
    paidAmount: doublePrecision("paid_amount"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("payment_claims_uq").on(t.projectId, t.number),
    index("payment_claims_project_idx").on(t.projectId),
    index("payment_claims_deadline_idx").on(t.status, t.responseDeadline),
  ],
);

export const paymentResponses = pgTable(
  "payment_responses",
  {
    id: text("id").primaryKey(),
    paymentClaimId: text("payment_claim_id").notNull(),
    companyId: text("company_id").notNull(),
    kind: text("kind").notNull(), // PaymentResponseKind
    amount: doublePrecision("amount").notNull(),
    reasons: text("reasons"),
    /** valuation basis lines for the lower amount, free-form */
    breakdown: jsonb("breakdown").$type<unknown[]>(),
    servedAt: timestamp("served_at", { withTimezone: true, mode: "string" }).notNull(),
    /** served after the statutory deadline */
    late: integer("late").default(0).notNull(),
    servedBy: text("served_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("payment_responses_claim_idx").on(t.paymentClaimId)],
);

/** Right-to-suspend notices (#362). */
export const suspensionNotices = pgTable(
  "suspension_notices",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    paymentClaimId: text("payment_claim_id").notNull(),
    servedAt: timestamp("served_at", { withTimezone: true, mode: "string" }).notNull(),
    /** statutory notice period means suspension may begin on this date */
    effectiveFrom: text("effective_from").notNull(),
    liftedAt: timestamp("lifted_at", { withTimezone: true, mode: "string" }),
    servedBy: text("served_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("suspension_notices_project_idx").on(t.projectId)],
);
