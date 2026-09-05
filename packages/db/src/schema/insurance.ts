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
    /*
     * RENEWAL PIPELINE (#775). Renewal status is deliberately separate from
     * `status`: a policy is comfortably `active` right up to the day it is
     * not, and the only useful question 90 days out is whether anyone has
     * started. `not_started` on a policy expiring in three weeks is the whole
     * report.
     */
    renewalStatus: text("renewal_status").default("not_started").notNull(), // PolicyRenewalStatus
    renewalOwnerId: text("renewal_owner_id"),
    renewalTargetDate: text("renewal_target_date"),
    renewalNotes: text("renewal_notes"),
    /** the policy this one renews, and the one that renewed it */
    previousPolicyId: text("previous_policy_id"),
    renewedByPolicyId: text("renewed_by_policy_id"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("insurance_policies_company_idx").on(t.companyId),
    index("insurance_policies_project_idx").on(t.projectId),
    index("insurance_policies_period_idx").on(t.companyId, t.periodEnd),
    index("insurance_policies_renewal_idx").on(t.companyId, t.renewalStatus),
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
    index("insurance_certificates_project_idx").on(t.companyId, t.projectId, t.validTo),
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
    /** the bonding line this bond draws on, when it draws on one (#796) */
    facilityId: text("facility_id"),
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
    index("bonds_facility_idx").on(t.facilityId, t.status),
    index("bonds_status_idx").on(t.companyId, t.status),
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
    /** the adjuster as a directory contact, when they are one (#785) */
    lossAdjusterContactId: text("loss_adjuster_contact_id"),
    /**
     * The assembled claim documentation (#784), content-addressed. An insurer
     * decides a claim on the pack it was given; recording WHICH bytes were
     * given is the difference between "we sent everything" and being able to
     * show it. Regenerating produces a new hash rather than mutating this one.
     */
    packFileId: text("pack_file_id"),
    packSha256: text("pack_sha256"),
    packGeneratedAt: timestamp("pack_generated_at", { withTimezone: true, mode: "string" }),
    packItemCount: integer("pack_item_count").default(0).notNull(),
    /** links to the platform records this claim arises from */
    linkedRecords: jsonb("linked_records").$type<unknown[]>().default([]).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("insurance_claims_company_idx").on(t.companyId),
    index("insurance_claims_policy_idx").on(t.policyId),
    index("insurance_claims_project_idx").on(t.companyId, t.projectId),
    /* The warn-before-the-deadline sweep filters on exactly this: claims with
       a notification deadline that nobody has notified yet. */
    index("insurance_claims_notification_idx").on(
      t.companyId,
      t.notifiedAt,
      t.notificationDueAt,
    ),
  ],
);

/* ================================================================== */
/* WP-MEET upgrade: facilities, requirements, premiums                 */
/* ================================================================== */

/**
 * A BONDING LINE (#796).
 *
 * Bonds are drawn against a facility a surety or bank has agreed, and the
 * only question a contractor actually needs answered before tendering is
 * "how much line is left?". Without the facility record, headroom is not
 * computable at all: you can list the bonds you have issued but not the
 * ceiling they sit under, and a tender is then bid on a hope.
 *
 * Utilisation is DERIVED (sum of live bonds' current exposure against this
 * facility, per currency, never across them) rather than stored, so it cannot
 * drift from the bonds it is meant to summarise.
 */
export const bondFacilities = pgTable(
  "bond_facilities",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** facilities are usually company-level; a project ring-fence is allowed */
    projectId: text("project_id"),
    number: text("number").notNull(),
    name: text("name").notNull(),
    /** the surety, bank or insurer providing the line */
    provider: text("provider").notNull(),
    providerVendorId: text("provider_vendor_id"),
    facilityReference: text("facility_reference"),
    /** the ceiling. Money, so doublePrecision, and one currency per facility. */
    limitAmount: doublePrecision("limit_amount").notNull(),
    currency: text("currency").default("GBP").notNull(),
    /** bond types this line may be drawn for; empty = any */
    permittedBondTypes: jsonb("permitted_bond_types").$type<string[]>().default([]).notNull(),
    /** what the provider charges, for premium analytics */
    commissionRatePct: doublePrecision("commission_rate_pct"),
    /** cash or asset security the provider holds against the line */
    collateralAmount: doublePrecision("collateral_amount"),
    collateralNote: text("collateral_note"),
    effectiveFrom: text("effective_from"),
    effectiveTo: text("effective_to"),
    reviewDate: text("review_date"),
    status: text("status").default("draft").notNull(), // BondFacilityStatus
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("bond_facilities_uq").on(t.companyId, t.number),
    index("bond_facilities_company_idx").on(t.companyId, t.status),
    index("bond_facilities_review_idx").on(t.companyId, t.reviewDate),
  ],
);

/**
 * WHAT COVER THE CONTRACT ACTUALLY DEMANDS.
 *
 * Before this table the platform inferred requirements from its own policy
 * records — "somebody recorded a PI policy with a clause reference, so PI is
 * required" — which produced a company-wide union applied to every project:
 * a PI requirement recorded on project A raised cover-gap signals against
 * every vendor on project B. A requirement is a reading of a contract and
 * belongs to a scope, a clause and a limit, and nothing else may stand in for
 * it.
 */
export const insuranceRequirements = pgTable(
  "insurance_requirements",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = a company standard applied to every project */
    projectId: text("project_id"),
    contractId: text("contract_id"),
    /** null = required of every vendor at work; set = this vendor only */
    vendorId: text("vendor_id"),
    policyType: text("policy_type").notNull(), // PolicyType
    /** the clause that demands it — a requirement with no clause is an opinion */
    requiredByClause: text("required_by_clause").notNull(),
    minimumLimit: doublePrecision("minimum_limit"),
    limitBasis: text("limit_basis"),
    currency: text("currency").default("GBP").notNull(),
    maximumDeductible: doublePrecision("maximum_deductible"),
    /** endorsements the wording must actually contain */
    waiverOfSubrogation: integer("waiver_of_subrogation").default(0).notNull(),
    additionalInsuredRequired: integer("additional_insured_required").default(0).notNull(),
    /** must the cover survive completion, and for how long */
    maintainMonthsAfterCompletion: integer("maintain_months_after_completion"),
    territorialLimits: text("territorial_limits"),
    notes: text("notes"),
    status: text("status").default("required").notNull(), // InsuranceRequirementStatus
    waivedBy: text("waived_by"),
    waivedAt: timestamp("waived_at", { withTimezone: true, mode: "string" }),
    waiverReason: text("waiver_reason"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("insurance_requirements_company_idx").on(t.companyId, t.status),
    index("insurance_requirements_project_idx").on(t.companyId, t.projectId, t.policyType),
    index("insurance_requirements_vendor_idx").on(t.vendorId),
  ],
);

/**
 * PREMIUM AND CLAIMS EXPERIENCE (#782).
 *
 * The loss ratio — claims incurred over premium earned — is the number that
 * decides next year's renewal, and it cannot be computed from the policy
 * record alone because premium is paid in instalments, adjusted at audit and
 * partly returned. One row per money movement, with its own currency, so the
 * ratio is computed per currency and never across.
 */
export const insurancePremiums = pgTable(
  "insurance_premiums",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    policyId: text("policy_id").notNull(),
    kind: text("kind").default("premium").notNull(), // InsurancePremiumKind
    amount: doublePrecision("amount").notNull(),
    currency: text("currency").default("GBP").notNull(),
    /** the period this money buys cover for, for earned-premium arithmetic */
    periodStart: text("period_start"),
    periodEnd: text("period_end"),
    dueDate: text("due_date"),
    paidAt: text("paid_at"),
    reference: text("reference"),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("insurance_premiums_policy_idx").on(t.policyId),
    index("insurance_premiums_company_idx").on(t.companyId, t.currency),
  ],
);

/**
 * THE LOSS ADJUSTER'S TASK LIST (#785).
 *
 * A claim is rarely lost on its merits; it is lost because the adjuster asked
 * for six things and two were never sent. Each request is a dated ask with an
 * owner, carried as an Obligation so it is subject to the same deadline
 * machinery as every other time bar on the platform — an information request
 * that quietly runs past its date is exactly the failure this table exists to
 * make visible.
 *
 * Site visits and interim reports live here too: they are the same shape (a
 * dated event the claim's progress depends on) and separating them would only
 * scatter the adjuster's diary across three registers.
 */
export const insuranceClaimRequests = pgTable(
  "insurance_claim_requests",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    claimId: text("claim_id").notNull(),
    kind: text("kind").default("information_request").notNull(), // ClaimRequestKind
    title: text("title").notNull(),
    description: text("description"),
    /** who asked — the adjuster, the insurer, the broker */
    requestedBy: text("requested_by"),
    requestedAt: text("requested_at"),
    dueDate: text("due_date"),
    /** the deadline carried as a real obligation, when there is one */
    obligationId: text("obligation_id"),
    /** the platform user who owes the answer */
    ownerId: text("owner_id"),
    status: text("status").default("open").notNull(), // ClaimRequestStatus
    respondedAt: timestamp("responded_at", { withTimezone: true, mode: "string" }),
    respondedBy: text("responded_by"),
    responseNote: text("response_note"),
    evidenceFileIds: jsonb("evidence_file_ids").$type<string[]>().default([]).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("insurance_claim_requests_claim_idx").on(t.claimId, t.status),
    index("insurance_claim_requests_company_idx").on(t.companyId, t.status, t.dueDate),
    index("insurance_claim_requests_project_idx").on(t.companyId, t.projectId),
  ],
);
