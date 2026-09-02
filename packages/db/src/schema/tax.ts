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
 * Tax & statutory deduction (spec Vol II Domain Q, #798–820).
 *
 * Regime rules (rates, reverse-charge conditions, deduction schemes, return
 * cadences, PE thresholds) are code-resident in
 * apps/api/src/modules/tax/regimes.ts. Rows here record what a tenant holds
 * (registrations), what the engine decided and why (determinations, with the
 * inputs and rule citations frozen), what was deducted (withholding
 * certificates), the periods/returns that follow and the day-count exposure
 * register. Every table is company-scoped; project-scoped where the record
 * belongs to a project.
 */

/**
 * Which regime a project sits under and how the paying party (the tenant)
 * stands in it — the customer side of every determination. One row per
 * project; absent means "derive from the project country, assume nothing
 * about our own registrations".
 */
export const taxProjectProfiles = pgTable(
  "tax_project_profiles",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    regime: text("regime").notNull(), // TaxRegime
    /** ISO-3166 alpha-2 of the place of supply (where the works are) */
    placeOfSupplyCountry: text("place_of_supply_country"),
    /** the tenant is VAT/GST-registered in the regime */
    customerVatRegistered: integer("customer_vat_registered").default(0).notNull(),
    /** UK: tenant is a CIS contractor; IE: tenant is an RCT principal */
    customerDeductionRegistered: integer("customer_deduction_registered").default(0).notNull(),
    /** UK DRC: the tenant is an end user (no reverse charge upstream) */
    endUser: integer("end_user").default(0).notNull(),
    defaultSupplyType: text("default_supply_type").default("construction_services").notNull(),
    defaultContractType: text("default_contract_type").default("subcontract").notNull(),
    currency: text("currency").default("GBP").notNull(),
    /** regime = custom: the tenant's own parameters, cited by the tenant */
    customRules: jsonb("custom_rules").$type<Record<string, unknown>>().default({}).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tax_project_profiles_uq").on(t.projectId),
    index("tax_project_profiles_company_idx").on(t.companyId),
  ],
);

/** Registrations held by the tenant, a vendor or an entity (#800–801). */
export const taxRegistrations = pgTable(
  "tax_registrations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    holderType: text("holder_type").notNull(), // TaxHolderType
    /** vendor / entity id; null when the holder is the tenant itself */
    holderId: text("holder_id"),
    holderName: text("holder_name").notNull(),
    regime: text("regime").notNull(), // TaxRegime
    kind: text("kind").notNull(), // TaxRegistrationKind
    number: text("number"),
    status: text("status").default("active").notNull(), // TaxRegistrationStatus
    verificationStatus: text("verification_status").default("unverified").notNull(), // TaxVerificationStatus
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    verifiedBy: text("verified_by"),
    verificationReference: text("verification_reference"),
    /** authority-assigned deduction rate (CIS 0/20/30, RCT 0/20/35), % */
    deductionRate: doublePrecision("deduction_rate"),
    validFrom: text("valid_from"), // ISO date
    validTo: text("valid_to"),
    country: text("country"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tax_registrations_holder_idx").on(t.companyId, t.holderType, t.holderId),
    index("tax_registrations_regime_idx").on(t.companyId, t.regime, t.kind, t.status),
    index("tax_registrations_verified_idx").on(t.verificationStatus, t.verifiedAt),
  ],
);

/**
 * One determination = inputs frozen, outputs frozen, the rules cited (#798,
 * #799, #802, #804). A human override never edits a row: it writes a new row
 * and points the old one at it.
 */
export const taxDeterminations = pgTable(
  "tax_determinations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    sourceType: text("source_type").default("manual").notNull(), // TaxDeterminationSource
    sourceId: text("source_id"),
    /** invoice line / commitment SOV line the determination is for */
    sourceLineId: text("source_line_id"),
    vendorId: text("vendor_id"),
    vendorName: text("vendor_name"),
    regime: text("regime").notNull(),
    supplyType: text("supply_type").notNull(),
    contractType: text("contract_type").notNull(),
    amount: doublePrecision("amount").notNull(),
    currency: text("currency").notNull(),
    /** the full engine input, as run */
    inputs: jsonb("inputs").$type<Record<string, unknown>>().default({}).notNull(),
    /* headline outputs, denormalised for the register */
    vatTreatment: text("vat_treatment").notNull(), // TaxVatTreatment
    vatRate: doublePrecision("vat_rate").default(0).notNull(),
    vatAmount: doublePrecision("vat_amount").default(0).notNull(),
    /** tax the customer must self-account for under a reverse charge */
    selfAccountedVat: doublePrecision("self_accounted_vat").default(0).notNull(),
    reverseCharge: integer("reverse_charge").default(0).notNull(),
    withholdingScheme: text("withholding_scheme").default("none").notNull(), // TaxWithholdingScheme
    withholdingBase: text("withholding_base").default("none").notNull(), // TaxWithholdingBase
    withholdingBaseAmount: doublePrecision("withholding_base_amount").default(0).notNull(),
    withholdingRate: doublePrecision("withholding_rate").default(0).notNull(),
    withholdingAmount: doublePrecision("withholding_amount").default(0).notNull(),
    leviesAmount: doublePrecision("levies_amount").default(0).notNull(),
    netPayable: doublePrecision("net_payable").notNull(),
    /** the full engine output: levies, citations, warnings, assumptions */
    outputs: jsonb("outputs").$type<Record<string, unknown>>().default({}).notNull(),
    citations: jsonb("citations").$type<unknown[]>().default([]).notNull(),
    warnings: jsonb("warnings").$type<string[]>().default([]).notNull(),
    assumptions: jsonb("assumptions").$type<string[]>().default([]).notNull(),
    confidence: doublePrecision("confidence").default(1).notNull(),
    status: text("status").default("determined").notNull(), // TaxDeterminationStatus
    /** set on the ORIGINAL when a human overrides it */
    overriddenById: text("overridden_by_id"),
    /** set on the OVERRIDE: which record it replaced and why */
    overridesId: text("overrides_id"),
    overrideReason: text("override_reason"),
    /** set on the older record when a re-run for the same source produced a newer one */
    supersededById: text("superseded_by_id"),
    determinedBy: text("determined_by"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("tax_determinations_uq").on(t.projectId, t.number),
    index("tax_determinations_project_idx").on(t.projectId, t.status),
    index("tax_determinations_source_idx").on(t.sourceType, t.sourceId, t.sourceLineId),
    index("tax_determinations_vendor_idx").on(t.vendorId),
    index("tax_determinations_company_idx").on(t.companyId, t.createdAt),
  ],
);

/** A deduction statement issued per payment (#800, #802, #804). */
export const withholdingCertificates = pgTable(
  "withholding_certificates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    /** printed reference, assigned on issue (e.g. CIS-2026-09-0004) */
    reference: text("reference"),
    determinationId: text("determination_id"),
    /** commitment_payments id, when the certificate follows a recorded payment */
    paymentId: text("payment_id"),
    invoiceId: text("invoice_id"),
    vendorId: text("vendor_id"),
    vendorName: text("vendor_name").notNull(),
    regime: text("regime").notNull(),
    scheme: text("scheme").notNull(), // TaxWithholdingScheme
    paymentDate: text("payment_date").notNull(), // ISO date
    /** the statutory period the deduction falls in (ISO dates) */
    periodStart: text("period_start"),
    periodEnd: text("period_end"),
    currency: text("currency").notNull(),
    grossAmount: doublePrecision("gross_amount").notNull(),
    materialsAmount: doublePrecision("materials_amount").default(0).notNull(),
    baseAmount: doublePrecision("base_amount").notNull(),
    rate: doublePrecision("rate").notNull(),
    withheldAmount: doublePrecision("withheld_amount").notNull(),
    netPaid: doublePrecision("net_paid").notNull(),
    status: text("status").default("draft").notNull(), // TaxCertificateStatus
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "string" }),
    issuedBy: text("issued_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "string" }),
    cancelledBy: text("cancelled_by"),
    cancelReason: text("cancel_reason"),
    /** what the tax authority needs printed: verification number, UTR, etc. */
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("withholding_certificates_uq").on(t.projectId, t.number),
    index("withholding_certificates_project_idx").on(t.projectId, t.status),
    index("withholding_certificates_vendor_idx").on(t.vendorId),
    index("withholding_certificates_payment_idx").on(t.paymentId),
    index("withholding_certificates_period_idx").on(t.companyId, t.paymentDate),
  ],
);

/**
 * Tax periods and the returns due for them (#803, #798). Due dates come from
 * the regime library and materialise as assurance Obligations so the return
 * clock and the obligation register agree.
 */
export const taxPeriods = pgTable(
  "tax_periods",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    regime: text("regime").notNull(),
    returnKind: text("return_kind").notNull(), // TaxReturnKind
    periodStart: text("period_start").notNull(), // ISO date
    periodEnd: text("period_end").notNull(),
    dueDate: text("due_date").notNull(),
    paymentDueDate: text("payment_due_date"),
    currency: text("currency").notNull(),
    status: text("status").default("open").notNull(), // TaxPeriodStatus
    /* aggregates — null until computed; never 0 by default */
    outputTax: doublePrecision("output_tax"),
    inputTax: doublePrecision("input_tax"),
    selfAccountedTax: doublePrecision("self_accounted_tax"),
    withheldTotal: doublePrecision("withheld_total"),
    netPayable: doublePrecision("net_payable"),
    determinationCount: integer("determination_count").default(0).notNull(),
    certificateCount: integer("certificate_count").default(0).notNull(),
    /** determinations/certificates in another currency, excluded from the aggregates */
    excludedCount: integer("excluded_count").default(0).notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "string" }),
    computeBasis: jsonb("compute_basis").$type<Record<string, unknown>>().default({}).notNull(),
    obligationId: text("obligation_id"),
    filedAt: timestamp("filed_at", { withTimezone: true, mode: "string" }),
    filedBy: text("filed_by"),
    filingReference: text("filing_reference"),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "string" }),
    paidBy: text("paid_by"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tax_periods_uq").on(t.projectId, t.regime, t.returnKind, t.periodStart),
    index("tax_periods_project_idx").on(t.projectId, t.status),
    index("tax_periods_due_idx").on(t.status, t.dueDate),
    index("tax_periods_company_idx").on(t.companyId),
  ],
);

/**
 * Permanent-establishment exposure register (#806–807): days in the host
 * country per entity per project against the regime's threshold, over a
 * rolling window. Presence is recorded as date ranges so the count is
 * recomputable and auditable, never a hand-typed number.
 */
export const peExposures = pgTable(
  "pe_exposures",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    entityType: text("entity_type").notNull(), // PeEntityType
    entityId: text("entity_id"),
    entityName: text("entity_name").notNull(),
    homeCountry: text("home_country").notNull(),
    hostCountry: text("host_country").notNull(),
    regime: text("regime").notNull(),
    thresholdDays: integer("threshold_days").notNull(),
    /** rolling window the threshold is measured over; 0 = whole project life */
    windowMonths: integer("window_months").default(12).notNull(),
    /** fraction of the threshold that flips the status to `approaching` */
    warnFraction: doublePrecision("warn_fraction").default(0.75).notNull(),
    thresholdBasis: text("threshold_basis").notNull(),
    daysInWindow: integer("days_in_window").default(0).notNull(),
    daysTotal: integer("days_total").default(0).notNull(),
    firstPresenceDate: text("first_presence_date"),
    lastPresenceDate: text("last_presence_date"),
    /** projected date the threshold is crossed at the current run-rate; null when not projectable */
    projectedBreachDate: text("projected_breach_date"),
    status: text("status").default("monitoring").notNull(), // PeExposureStatus
    mitigationNote: text("mitigation_note"),
    lastComputedAt: timestamp("last_computed_at", { withTimezone: true, mode: "string" }),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("pe_exposures_project_idx").on(t.projectId, t.status),
    index("pe_exposures_company_idx").on(t.companyId, t.status),
    index("pe_exposures_entity_idx").on(t.entityType, t.entityId),
  ],
);

export const pePresenceEntries = pgTable(
  "pe_presence_entries",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    exposureId: text("exposure_id").notNull(),
    startDate: text("start_date").notNull(), // ISO date, inclusive
    endDate: text("end_date").notNull(), // ISO date, inclusive
    days: integer("days").notNull(),
    purpose: text("purpose"),
    source: text("source").default("manual").notNull(), // PePresenceSource
    sourceRef: text("source_ref"),
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("pe_presence_entries_exposure_idx").on(t.exposureId, t.startDate),
    index("pe_presence_entries_project_idx").on(t.projectId),
  ],
);
