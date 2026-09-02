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

/* ================================================================== */
/* WP-FIN2 — statutory payments depth (spec Vol II Domain F #373–393)  */
/* ================================================================== */

/**
 * Statutory liens and lien notices (#373–380): preliminary notices, notices
 * of intent, filed liens, stop notices and payment-bond claims against the
 * project. Each carries the statutory deadline that governs it — the date a
 * lien must be filed or enforced by — which materialises as an Obligation.
 */
export const statutoryLiens = pgTable(
  "statutory_liens",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    kind: text("kind").notNull(), // StatutoryLienKind
    status: text("status").default("noticed").notNull(), // StatutoryLienStatus
    claimantName: text("claimant_name").notNull(),
    claimantVendorId: text("claimant_vendor_id"),
    /** 1 = direct sub, 2 = their supplier — the tier that liens paid-in-full projects */
    tier: integer("tier").default(1).notNull(),
    amount: doublePrecision("amount").default(0).notNull(),
    currency: text("currency").default("USD").notNull(),
    jurisdiction: text("jurisdiction"),
    /** ISO dates */
    servedAt: text("served_at"),
    filedAt: text("filed_at"),
    lastFurnishedAt: text("last_furnished_at"),
    deadlineAt: text("deadline_at"),
    deadlineBasis: text("deadline_basis"),
    propertyDescription: text("property_description"),
    relatedCommitmentId: text("related_commitment_id"),
    relatedInvoiceId: text("related_invoice_id"),
    obligationId: text("obligation_id"),
    releaseDocumentId: text("release_document_id"),
    releasedAt: text("released_at"),
    bondReference: text("bond_reference"),
    disputeReason: text("dispute_reason"),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("statutory_liens_uq").on(t.projectId, t.number),
    index("statutory_liens_project_idx").on(t.projectId, t.status),
    index("statutory_liens_deadline_idx").on(t.status, t.deadlineAt),
    index("statutory_liens_company_idx").on(t.companyId),
  ],
);

/**
 * Retention trusts, project bank accounts and escrow (#381–385). The balance
 * is DERIVED from movements, never typed, and reconciled against the
 * retainage the commitments say is being held — an under-funded trust is a
 * signal, not a footnote.
 */
export const paymentSecurityAccounts = pgTable(
  "payment_security_accounts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    kind: text("kind").notNull(), // PaymentSecurityAccountKind
    name: text("name").notNull(),
    status: text("status").default("active").notNull(), // active | closed
    bankReference: text("bank_reference"),
    trustee: text("trustee"),
    currency: text("currency").default("USD").notNull(),
    /** vendors whose retention the account secures; empty = whole project */
    beneficiaryVendorIds: jsonb("beneficiary_vendor_ids").$type<string[]>().default([]).notNull(),
    openedAt: text("opened_at"),
    closedAt: text("closed_at"),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("payment_security_accounts_project_idx").on(t.projectId, t.status),
    index("payment_security_accounts_company_idx").on(t.companyId),
  ],
);

export const paymentSecurityMovements = pgTable(
  "payment_security_movements",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    accountId: text("account_id").notNull(),
    kind: text("kind").notNull(), // PaymentSecurityMovementKind
    /** signed: deposits and interest positive, releases and withdrawals negative */
    amount: doublePrecision("amount").notNull(),
    beneficiaryVendorId: text("beneficiary_vendor_id"),
    relatedPaymentId: text("related_payment_id"),
    relatedInvoiceId: text("related_invoice_id"),
    reference: text("reference"),
    occurredAt: text("occurred_at").notNull(), // ISO date
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("payment_security_movements_account_idx").on(t.accountId, t.occurredAt),
    index("payment_security_movements_project_idx").on(t.projectId),
  ],
);

/**
 * Statutory payment adjudication cases (#386–390): the fast-track dispute
 * path every security-of-payment regime provides. The timetable is computed
 * from the regime at referral and each deadline is an Obligation.
 */
export const paymentAdjudications = pgTable(
  "payment_adjudications",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    paymentClaimId: text("payment_claim_id"),
    regime: text("regime").notNull(), // PaymentRegime
    status: text("status").default("notice").notNull(), // PaymentAdjudicationStatus
    referringParty: text("referring_party").default("claimant").notNull(), // claimant | respondent
    disputedAmount: doublePrecision("disputed_amount").default(0).notNull(),
    currency: text("currency").default("GBP").notNull(),
    adjudicatorName: text("adjudicator_name"),
    nominatingBody: text("nominating_body"),
    /** ISO dates */
    noticeAt: text("notice_at"),
    referralAt: text("referral_at"),
    responseDueAt: text("response_due_at"),
    responseAt: text("response_at"),
    decisionDueAt: text("decision_due_at"),
    decisionAt: text("decision_at"),
    decisionAmount: doublePrecision("decision_amount"),
    decisionSummary: text("decision_summary"),
    enforcedAt: text("enforced_at"),
    /** [{ step, dueAt, basis, obligationId }] */
    timetable: jsonb("timetable").$type<unknown[]>().default([]).notNull(),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("payment_adjudications_uq").on(t.projectId, t.number),
    index("payment_adjudications_project_idx").on(t.projectId, t.status),
    index("payment_adjudications_claim_idx").on(t.paymentClaimId),
    index("payment_adjudications_deadline_idx").on(t.status, t.decisionDueAt),
  ],
);

/**
 * Supply-chain payment practice reports (#391–393): the company's own
 * performance as a payer over a reporting period, computed from the invoice
 * and payment registers and published as a fact rather than a claim.
 */
export const supplyChainPaymentReports = pgTable(
  "supply_chain_payment_reports",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    regime: text("regime").default("generic").notNull(), // SupplyChainReportRegime
    status: text("status").default("draft").notNull(), // SupplyChainReportStatus
    periodStart: text("period_start").notNull(), // ISO date
    periodEnd: text("period_end").notNull(), // ISO date
    /** per-currency metrics, computed */
    metrics: jsonb("metrics").$type<unknown>().default({}).notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true, mode: "string" }).notNull(),
    generatedBy: text("generated_by").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }),
    publishedBy: text("published_by"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("supply_chain_payment_reports_company_idx").on(t.companyId, t.periodStart)],
);
