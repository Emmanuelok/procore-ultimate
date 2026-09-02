/**
 * Shared enums for the tax & statutory deduction area (spec Vol II Domain Q,
 * #798–820; platform upgrade wave). Add new `as const` string unions and their
 * types here; never edit enums.ts from a parallel work package.
 */

/** Code-resident tax regimes (apps/api/src/modules/tax/regimes.ts). */
export const TAX_REGIMES = [
  "uk", // VAT + domestic reverse charge for construction + CIS
  "ie", // VAT + RCT + construction reverse charge
  "sg", // GST
  "au", // GST + no-ABN / foreign-resident works withholding
  "nz", // GST + schedular payments
  "my", // SST + s107A non-resident contractor withholding
  "za", // VAT
  "ng", // VAT + WHT
  "ke", // VAT + WHT
  "gh", // VAT + NHIL/GETFund levies + WHT
  "in", // GST + TDS s194C
  "ae", // VAT (no withholding)
  "sa", // VAT + non-resident WHT
  "us", // no VAT; sales & use tax note; backup / Chapter 3 withholding
  "custom", // tenant-supplied parameters, nothing assumed
] as const;
export type TaxRegime = (typeof TAX_REGIMES)[number];

/** What is being supplied — drives VAT treatment and deduction scope. */
export const TAX_SUPPLY_TYPES = [
  "construction_services",
  "labour_only",
  "professional_services",
  "plant_hire",
  "materials_only",
  "goods",
  "mixed",
] as const;
export type TaxSupplyType = (typeof TAX_SUPPLY_TYPES)[number];

/** The contractual relationship the payment is made under. */
export const TAX_CONTRACT_TYPES = [
  "main_contract",
  "subcontract",
  "supply_only",
  "consultancy",
  "intercompany",
] as const;
export type TaxContractType = (typeof TAX_CONTRACT_TYPES)[number];

/** Who holds a registration: the tenant itself, a directory vendor, or an entity. */
export const TAX_HOLDER_TYPES = ["company", "vendor", "entity"] as const;
export type TaxHolderType = (typeof TAX_HOLDER_TYPES)[number];

/** Kinds of registration a party can hold under a regime. */
export const TAX_REGISTRATION_KINDS = [
  "vat", // VAT / GST / SST registration
  "cis", // UK CIS (contractor or subcontractor)
  "rct", // IE Relevant Contracts Tax
  "wht", // withholding-tax agent / deductor registration (TDS TAN, etc.)
  "tin", // tax identification number (TIN / ABN / IRD / PAN / EIN / W-9 on file)
  "other",
] as const;
export type TaxRegistrationKind = (typeof TAX_REGISTRATION_KINDS)[number];

export const TAX_REGISTRATION_STATUSES = [
  "active",
  "pending",
  "lapsed",
  "deregistered",
] as const;
export type TaxRegistrationStatus = (typeof TAX_REGISTRATION_STATUSES)[number];

/** Whether the registration has been checked with the authority (#801). */
export const TAX_VERIFICATION_STATUSES = ["unverified", "verified", "failed", "expired"] as const;
export type TaxVerificationStatus = (typeof TAX_VERIFICATION_STATUSES)[number];

/** What a determination was run for. */
export const TAX_DETERMINATION_SOURCES = [
  "invoice_line",
  "invoice",
  "valuation",
  "commitment_line",
  "commitment",
  "payment",
  "manual",
] as const;
export type TaxDeterminationSource = (typeof TAX_DETERMINATION_SOURCES)[number];

export const TAX_DETERMINATION_STATUSES = [
  "determined", // current, engine-produced
  "overridden", // replaced by a human override (points to the replacement)
  "superseded", // re-run for the same source line produced a newer record
] as const;
export type TaxDeterminationStatus = (typeof TAX_DETERMINATION_STATUSES)[number];

/** How the indirect tax on a supply is treated. */
export const TAX_VAT_TREATMENTS = [
  "standard",
  "reduced",
  "zero",
  "exempt",
  "out_of_scope",
  "reverse_charge", // domestic reverse charge — customer accounts
  "reverse_charge_import", // imported services — customer self-accounts
  "not_registered", // supplier not registered: no tax may be charged
  "not_applicable", // regime has no VAT/GST (US)
] as const;
export type TaxVatTreatment = (typeof TAX_VAT_TREATMENTS)[number];

/** The statutory deduction scheme a withholding was computed under. */
export const TAX_WITHHOLDING_SCHEMES = ["none", "cis", "rct", "wht", "tds", "backup", "custom"] as const;
export type TaxWithholdingScheme = (typeof TAX_WITHHOLDING_SCHEMES)[number];

/** What the withholding rate is applied to. */
export const TAX_WITHHOLDING_BASES = [
  "gross_excl_vat",
  "gross_excl_materials",
  "labour_only",
  "none",
] as const;
export type TaxWithholdingBase = (typeof TAX_WITHHOLDING_BASES)[number];

export const TAX_CERTIFICATE_STATUSES = ["draft", "issued", "cancelled"] as const;
export type TaxCertificateStatus = (typeof TAX_CERTIFICATE_STATUSES)[number];

/** Return / period kinds the period register tracks (#803, #798). */
export const TAX_RETURN_KINDS = [
  "vat", // VAT / GST / SST return
  "cis_monthly", // UK CIS300
  "rct_monthly", // IE RCT deduction summary
  "wht", // withholding-tax remittance return
  "tds", // IN TDS deposit + quarterly 26Q
  "other",
] as const;
export type TaxReturnKind = (typeof TAX_RETURN_KINDS)[number];

export const TAX_PERIOD_STATUSES = ["open", "closed", "filed", "paid", "overdue"] as const;
export type TaxPeriodStatus = (typeof TAX_PERIOD_STATUSES)[number];

/** Permanent-establishment exposure lifecycle (#806–807). */
export const PE_EXPOSURE_STATUSES = [
  "monitoring",
  "approaching", // ≥ warn fraction of the threshold
  "breached", // ≥ threshold days inside the window
  "mitigated", // advice taken / structure changed; still tracked
  "closed",
] as const;
export type PeExposureStatus = (typeof PE_EXPOSURE_STATUSES)[number];

export const PE_ENTITY_TYPES = ["company", "vendor", "entity", "person"] as const;
export type PeEntityType = (typeof PE_ENTITY_TYPES)[number];

export const PE_PRESENCE_SOURCES = ["manual", "timecards", "site_access", "travel"] as const;
export type PePresenceSource = (typeof PE_PRESENCE_SOURCES)[number];

/** Detectors the tax module raises assurance signals under. */
export const TAX_RISK_DETECTORS = [
  "tax_missing_registration",
  "tax_wht_not_deducted",
  "tax_reverse_charge_misapplied",
  "tax_pe_threshold",
  "tax_return_overdue",
  "tax_verification_expired",
] as const;
export type TaxRiskDetector = (typeof TAX_RISK_DETECTORS)[number];
