import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();

/**
 * Domain P — Insurance & bonding lifecycle (spec #771-797).
 *
 * The domain fits the primitives already in the platform and is built on them
 * rather than beside them: a policy's claim-notification period is an
 * Obligation with a hard date (ADR 0012, the same machinery as contractual
 * time bars), a certificate that expires while the works continue is a
 * Signal, and a bond call is a ledgered event with evidence.
 */
export const insurancePolicies = pgTable(
  "insurance_policies",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    number: text("number").notNull(),
    policyType: text("policy_type").notNull(), // PolicyType
    insurer: text("insurer").notNull(),
    /** placing broker, when one exists, as a directory vendor */
    brokerVendorId: text("broker_vendor_id"),
    policyNumber: text("policy_number").notNull(),
    /** named insureds and their capacity: [{ name, capacity, vendorId? }] */
    insuredParties: jsonb("insured_parties").$type<unknown[]>().default([]).notNull(),
    limitOfIndemnity: doublePrecision("limit_of_indemnity"),
    /** per occurrence | in the aggregate — materially different cover */
    limitBasis: text("limit_basis"),
    currency: text("currency").default("GBP").notNull(),
    deductible: doublePrecision("deductible"),
    deductibleBasis: text("deductible_basis"),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    /** days from becoming aware within which a claim must be notified */
    notificationDays: integer("notification_days"),
    territorialLimits: text("territorial_limits"),
    /** conditions precedent to liability: [{ ref, text, isConditionPrecedent }] */
    conditions: jsonb("conditions").$type<unknown[]>().default([]).notNull(),
    /** contractual requirement this policy satisfies (e.g. FIDIC 18.2) */
    requiredByClause: text("required_by_clause"),
    contractId: text("contract_id"),
    status: text("status").default("draft").notNull(), // PolicyStatus
    documentId: text("document_id"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("insurance_policies_company_idx").on(t.companyId),
    index("insurance_policies_project_idx").on(t.projectId),
  ],
);

/**
 * Evidence that cover actually exists — collected from the party who must
 * carry it, not asserted by the party who requires it (ADR 0004: the
 * certificate is Evidence, the policy record is the Assertion it tests).
 */
export const insuranceCertificates = pgTable(
  "insurance_certificates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    policyId: text("policy_id"),
    /** the party whose cover this evidences */
    vendorId: text("vendor_id"),
    subjectName: text("subject_name").notNull(),
    policyType: text("policy_type").notNull(),
    certificateNumber: text("certificate_number"),
    insurer: text("insurer"),
    limitOfIndemnity: doublePrecision("limit_of_indemnity"),
    currency: text("currency").default("GBP").notNull(),
    validFrom: text("valid_from").notNull(),
    validTo: text("valid_to").notNull(),
    /** the uploaded certificate, content-addressed */
    fileId: text("file_id"),
    fileSha256: text("file_sha256"),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    /** how verification was done — insurer confirmation beats a PDF */
    verificationMethod: text("verification_method"),
    status: text("status").default("active").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("insurance_certificates_company_idx").on(t.companyId),
    index("insurance_certificates_vendor_idx").on(t.vendorId),
    index("insurance_certificates_valid_to_idx").on(t.validTo),
  ],
);

/** Bonds and guarantees held or given, with call tracking (#786-793). */
export const bonds = pgTable(
  "bonds",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    contractId: text("contract_id"),
    number: text("number").notNull(),
    bondType: text("bond_type").notNull(), // BondType
    guarantor: text("guarantor").notNull(),
    bondNumber: text("bond_number"),
    /** the party whose performance is secured */
    principalVendorId: text("principal_vendor_id"),
    beneficiary: text("beneficiary"),
    amount: doublePrecision("amount").notNull(),
    currency: text("currency").default("GBP").notNull(),
    percentOfContract: doublePrecision("percent_of_contract"),
    /** on-demand bonds pay against a compliant demand; conditional ones do not */
    isOnDemand: integer("is_on_demand").default(0).notNull(),
    issuedAt: text("issued_at"),
    expiryAt: text("expiry_at"),
    /** last date a demand can be made — often before expiry */
    demandDeadline: text("demand_deadline"),
    /** reduces on milestones: [{ trigger, reducesToPercent, occurredAt? }] */
    reductionSchedule: jsonb("reduction_schedule").$type<unknown[]>().default([]).notNull(),
    status: text("status").default("draft").notNull(), // BondStatus
    documentId: text("document_id"),
    releasedAt: text("released_at"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("bonds_company_idx").on(t.companyId),
    index("bonds_project_idx").on(t.projectId),
  ],
);

/** A demand made under a bond, and what came of it. */
export const bondCalls = pgTable(
  "bond_calls",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    bondId: text("bond_id").notNull(),
    calledAt: text("called_at").notNull(),
    amount: doublePrecision("amount").notNull(),
    reason: text("reason").notNull(),
    /** the records relied on to justify the demand */
    evidenceRefs: jsonb("evidence_refs").$type<Record<string, unknown>>().default({}).notNull(),
    outcome: text("outcome"),
    proceedsReceivedAt: text("proceeds_received_at"),
    proceedsAmount: doublePrecision("proceeds_amount"),
    calledBy: text("called_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("bond_calls_bond_idx").on(t.bondId)],
);

/**
 * A claim notified under a policy. The notification deadline computed from
 * the policy's notificationDays becomes an Obligation; missing it is the
 * insurance analogue of a time bar and is raised as a Signal.
 */
export const insuranceClaims = pgTable(
  "insurance_claims",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    policyId: text("policy_id").notNull(),
    number: text("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    /** when the insured event happened */
    incidentDate: text("incident_date").notNull(),
    /** when the insured became aware — the clock that notificationDays runs from */
    awareDate: text("aware_date").notNull(),
    notifiedAt: text("notified_at"),
    notificationDueAt: text("notification_due_at"),
    /** obligation carrying the notification deadline */
    obligationId: text("obligation_id"),
    quantum: doublePrecision("quantum"),
    reserve: doublePrecision("reserve"),
    currency: text("currency").default("GBP").notNull(),
    status: text("status").default("notified").notNull(), // InsuranceClaimStatus
    insurerRef: text("insurer_ref"),
    lossAdjuster: text("loss_adjuster"),
    repudiationReason: text("repudiation_reason"),
    settledAmount: doublePrecision("settled_amount"),
    settledAt: text("settled_at"),
    /** links to the platform records this claim arises from */
    linkedRecords: jsonb("linked_records").$type<unknown[]>().default([]).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("insurance_claims_company_idx").on(t.companyId),
    index("insurance_claims_policy_idx").on(t.policyId),
  ],
);
