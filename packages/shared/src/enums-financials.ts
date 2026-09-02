/**
 * Shared enums for the financials area (platform upgrade wave).
 * Add new `as const` string unions and their types here; never edit
 * enums.ts from a parallel work package.
 */
export {};

/* ================================================================== */
/* WP-FIN1 — Budget intelligence & prime contract lifecycle           */
/* (append-only; WP-FIN2 appends its own block below this one)        */
/* ================================================================== */

/** The cost-report columns the budget module rebuilds from source tables. */
export const BUDGET_POSTING_COMPONENTS = [
  "committedCost",
  "pendingCommitments",
  "invoicedToDate",
  "paidToDate",
  "directCosts",
  "jobToDateCosts",
  "budgetModifications",
  "approvedChanges",
  "pendingBudgetChanges",
  "forecastToComplete",
] as const;
export type BudgetPostingComponent = (typeof BUDGET_POSTING_COMPONENTS)[number];

/** Where a posted figure came from — the provenance stamp on every posting. */
export const BUDGET_POSTING_SOURCE_TYPES = [
  "commitment_sov_line",
  "invoice_line",
  "commitment_payment",
  "budget_change",
  "budget_forecast",
  "direct_cost",
  "erp_import",
  "unattributed",
] as const;
export type BudgetPostingSourceType = (typeof BUDGET_POSTING_SOURCE_TYPES)[number];

/** Why a reconciliation ran. */
export const BUDGET_RECONCILIATION_TRIGGERS = ["manual", "scheduled"] as const;
export type BudgetReconciliationTrigger = (typeof BUDGET_RECONCILIATION_TRIGGERS)[number];

/** How a calculated field on a budget view is rendered. */
export const BUDGET_VIEW_FIELD_FORMATS = ["currency", "number", "percent"] as const;
export type BudgetViewFieldFormat = (typeof BUDGET_VIEW_FIELD_FORMATS)[number];

/** The anomaly detectors the budget insights engine runs, by id. */
export const BUDGET_INSIGHT_KINDS = [
  "committed_exceeds_revised",
  "jtd_exceeds_forecast",
  "contingency_burn",
  "cost_without_progress",
  "allowance_exceeded",
  "forecast_swing",
  "cost_drift",
  "cpi_below_threshold",
  "spi_below_threshold",
] as const;
export type BudgetInsightKind = (typeof BUDGET_INSIGHT_KINDS)[number];

/** Severity bands for insights — the same vocabulary the attention feed uses. */
export const BUDGET_INSIGHT_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type BudgetInsightSeverity = (typeof BUDGET_INSIGHT_SEVERITIES)[number];

/** ERP systems the GL → cost-code map knows the export dialect of. */
export const ERP_SYSTEMS = [
  "sage",
  "quickbooks",
  "viewpoint",
  "xero",
  "oracle",
  "sap",
  "other",
] as const;
export type ErpSystem = (typeof ERP_SYSTEMS)[number];

/** Compliance documents an owner requires before an application is payable. */
export const PRIME_COMPLIANCE_DOCUMENT_KINDS = [
  "insurance_certificate",
  "performance_bond",
  "payment_bond",
  "permit",
  "tax_form",
  "notice_to_proceed",
  "lien_waiver",
  "warranty",
  "other",
] as const;
export type PrimeComplianceDocumentKind = (typeof PRIME_COMPLIANCE_DOCUMENT_KINDS)[number];

export const PRIME_COMPLIANCE_DOCUMENT_STATUSES = [
  "missing",
  "received",
  "verified",
  "expired",
  "waived",
] as const;
export type PrimeComplianceDocumentStatus = (typeof PRIME_COMPLIANCE_DOCUMENT_STATUSES)[number];

/** How the owner paid. */
export const OWNER_PAYMENT_RECEIPT_METHODS = ["ach", "wire", "check", "card", "other"] as const;
export type OwnerPaymentReceiptMethod = (typeof OWNER_PAYMENT_RECEIPT_METHODS)[number];

export const OWNER_PAYMENT_RECEIPT_STATUSES = ["recorded", "void"] as const;
export type OwnerPaymentReceiptStatus = (typeof OWNER_PAYMENT_RECEIPT_STATUSES)[number];

/** Derived settlement position of a certified application. */
export const PAYMENT_SETTLEMENT_STATES = ["unpaid", "partially_paid", "paid"] as const;
export type PaymentSettlementState = (typeof PAYMENT_SETTLEMENT_STATES)[number];

/** Stored-material register lifecycle (G703 column F must be supported). */
export const STORED_MATERIAL_STATUSES = [
  "stored",
  "partially_incorporated",
  "incorporated",
  "removed",
] as const;
export type StoredMaterialStatus = (typeof STORED_MATERIAL_STATUSES)[number];

export const STORED_MATERIAL_LOCATIONS = ["on_site", "off_site_bonded", "off_site_insured"] as const;
export type StoredMaterialLocation = (typeof STORED_MATERIAL_LOCATIONS)[number];

/* ------------------------------------------------------------------ */
/* WP-FIN2 — commitments, change management, invoicing, statutory      */
/* payments (spec Vol I §3.3–3.5, Vol II F #373–393).                  */
/* ------------------------------------------------------------------ */

/** Backcharge lifecycle (#538). Issued = a negative CCO is pending on the sub. */
export const BACKCHARGE_STATUSES = ["draft", "issued", "disputed", "settled", "void"] as const;
export type BackchargeStatus = (typeof BACKCHARGE_STATUSES)[number];

/** Why a backcharge is raised — drives the assurance detectors, not free text. */
export const BACKCHARGE_REASON_CODES = [
  "defective_work",
  "damage_to_others_work",
  "cleanup",
  "safety_violation",
  "schedule_delay",
  "supplied_materials",
  "equipment_use",
  "other",
] as const;
export type BackchargeReasonCode = (typeof BACKCHARGE_REASON_CODES)[number];

/** Generated contract documents and their signature routing (#525–527). */
export const CONTRACT_DOCUMENT_KINDS = ["subcontract", "purchase_order", "change_order", "closeout"] as const;
export type ContractDocumentKind = (typeof CONTRACT_DOCUMENT_KINDS)[number];

export const CONTRACT_DOCUMENT_STATUSES = ["draft", "out_for_signature", "signed", "void"] as const;
export type ContractDocumentStatus = (typeof CONTRACT_DOCUMENT_STATUSES)[number];

/** Closeout checklist items a commitment must clear before final release (#539). */
export const CLOSEOUT_ITEM_KEYS = [
  "final_unconditional_waiver",
  "consent_of_surety",
  "warranties",
  "as_builts",
  "om_manuals",
  "punch_complete",
  "backcharges_settled",
] as const;
export type CloseoutItemKey = (typeof CLOSEOUT_ITEM_KEYS)[number];

export const CLOSEOUT_STATUSES = ["open", "passed", "overridden", "closed"] as const;
export type CloseoutStatus = (typeof CLOSEOUT_STATUSES)[number];

/** Payment runs: scheduling and remittance (#586–594). */
export const PAYMENT_RUN_STATUSES = ["draft", "approved", "issued", "cancelled"] as const;
export type PaymentRunStatus = (typeof PAYMENT_RUN_STATUSES)[number];

/** Line-level invoice approval (#573). */
export const INVOICE_LINE_APPROVAL_STATUSES = ["approved", "reduced", "rejected"] as const;
export type InvoiceLineApprovalStatus = (typeof INVOICE_LINE_APPROVAL_STATUSES)[number];

/** What a subcontractor may do through a vendor portal token (#567–568). */
export const VENDOR_PORTAL_SCOPES = ["invoices", "rfqs", "documents"] as const;
export type VendorPortalScope = (typeof VENDOR_PORTAL_SCOPES)[number];

/** Change-management tier stage vocabulary (#563). */
export const CHANGE_STAGES = ["event", "pco", "rfq", "cor", "package"] as const;
export type ChangeStage = (typeof CHANGE_STAGES)[number];

/** Statutory liens and lien notices (Vol II F #373–380). */
export const STATUTORY_LIEN_KINDS = [
  "preliminary_notice",
  "notice_of_intent",
  "lien_filed",
  "stop_notice",
  "bond_claim",
] as const;
export type StatutoryLienKind = (typeof STATUTORY_LIEN_KINDS)[number];

export const STATUTORY_LIEN_STATUSES = [
  "noticed",
  "filed",
  "disputed",
  "bonded_off",
  "released",
  "expired",
  "void",
] as const;
export type StatutoryLienStatus = (typeof STATUTORY_LIEN_STATUSES)[number];

/** Retention trusts, project bank accounts and escrow (Vol II F #381–385). */
export const PAYMENT_SECURITY_ACCOUNT_KINDS = ["project_bank_account", "retention_trust", "escrow"] as const;
export type PaymentSecurityAccountKind = (typeof PAYMENT_SECURITY_ACCOUNT_KINDS)[number];

export const PAYMENT_SECURITY_MOVEMENT_KINDS = ["deposit", "release", "withdrawal", "interest", "adjustment"] as const;
export type PaymentSecurityMovementKind = (typeof PAYMENT_SECURITY_MOVEMENT_KINDS)[number];

/** Statutory payment adjudication case lifecycle (Vol II F #386–390). */
export const PAYMENT_ADJUDICATION_STATUSES = [
  "notice",
  "referred",
  "responded",
  "decided",
  "enforced",
  "withdrawn",
  "settled",
] as const;
export type PaymentAdjudicationStatus = (typeof PAYMENT_ADJUDICATION_STATUSES)[number];

/** Supply-chain payment practice reports (Vol II F #391–393). */
export const SUPPLY_CHAIN_REPORT_STATUSES = ["draft", "published"] as const;
export type SupplyChainReportStatus = (typeof SUPPLY_CHAIN_REPORT_STATUSES)[number];

export const SUPPLY_CHAIN_REPORT_REGIMES = ["uk_ppr_2017", "generic"] as const;
export type SupplyChainReportRegime = (typeof SUPPLY_CHAIN_REPORT_REGIMES)[number];
