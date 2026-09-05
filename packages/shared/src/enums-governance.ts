/**
 * Shared enums for the governance area (platform upgrade wave).
 *
 * Covers the four owner-side disciplines that decide whether a capital
 * programme is defensible: quantified risk (Domain H), capital governance
 * (Domain G), lender/DFI project finance (Domain O) and dispute resolution
 * (Domain E).
 *
 * The vocabularies here are the ones the relevant authority uses, not
 * invented labels: HM Treasury Green Book optimism-bias categories, the
 * statutory adjudication regimes' own step names, IFI eligibility
 * classifications, and the dispute root-cause taxonomy a claims analyst
 * would recognise.
 *
 * Add new `as const` string unions and their types here; never edit
 * enums.ts from a parallel work package.
 */

/* ------------------------------------------------------------------ */
/* Quantified risk (Domain H) — simulation jobs, contingency discipline */
/* ------------------------------------------------------------------ */

/**
 * Lifecycle of an asynchronous Monte Carlo run (#464, #475-476). A job is
 * the durable record; the simulation row it produces is the result. `failed`
 * carries the error text so the UI never shows a spinner forever.
 */
export const SIMULATION_JOB_STATUSES = ["queued", "running", "done", "failed"] as const;
export type SimulationJobStatus = (typeof SIMULATION_JOB_STATUSES)[number];

/**
 * Contingency release authority workflow (#471-472). A drawdown is money
 * leaving the risk pot, so it is requested and approved by different people
 * exactly like a payment — `withdrawn` is the requester's own retraction.
 */
export const CONTINGENCY_RELEASE_STATUSES = [
  "requested",
  "approved",
  "rejected",
  "withdrawn",
] as const;
export type ContingencyReleaseStatus = (typeof CONTINGENCY_RELEASE_STATUSES)[number];

/** Shape used to generate a planned drawdown curve when none is entered by hand (#451). */
export const CONTINGENCY_CURVE_SHAPES = [
  "linear",
  "s_curve",
  "front_loaded",
  "back_loaded",
] as const;
export type ContingencyCurveShape = (typeof CONTINGENCY_CURVE_SHAPES)[number];

/**
 * HM Treasury Green Book optimism-bias project categories (#402-404). The
 * upper/lower bounds attached to each live in code
 * (modules/risk/optimism.ts) because they are published guidance, not
 * tenant data.
 */
export const OPTIMISM_BIAS_CATEGORIES = [
  "standard_building",
  "non_standard_building",
  "standard_civil_engineering",
  "non_standard_civil_engineering",
  "equipment_development",
  "outsourcing",
] as const;
export type OptimismBiasCategory = (typeof OPTIMISM_BIAS_CATEGORIES)[number];

/**
 * Departing from the published uplift is allowed, but only on the record
 * (#405): the deviation is proposed with a justification and approved by
 * someone other than the proposer.
 */
export const UPLIFT_CHALLENGE_STATUSES = ["proposed", "approved", "rejected"] as const;
export type UpliftChallengeStatus = (typeof UPLIFT_CHALLENGE_STATUSES)[number];

/** Which view of an estimate a figure came from — the honesty label on RCF output. */
export const ESTIMATE_VIEWS = ["inside", "outside"] as const;
export type EstimateView = (typeof ESTIMATE_VIEWS)[number];

/** Risk appetite/tolerance thresholds are set per category or for the whole project. */
export const RISK_APPETITE_SCOPES = ["project", "category"] as const;
export type RiskAppetiteScope = (typeof RISK_APPETITE_SCOPES)[number];

/* ------------------------------------------------------------------ */
/* Capital governance (Domain G) — benefits, assurance actions          */
/* ------------------------------------------------------------------ */

/**
 * Benefit dependency edge semantics (#418-419). `enables` is a hard
 * precondition — if the upstream node fails the downstream benefit cannot
 * be realised at all; `contributes` is partial, so risk propagates but does
 * not doom the successor.
 */
export const BENEFIT_DEPENDENCY_TYPES = ["enables", "contributes"] as const;
export type BenefitDependencyType = (typeof BENEFIT_DEPENDENCY_TYPES)[number];

/** Node kinds in the per-business-case logic model (inputs → outputs → outcomes → impacts). */
export const LOGIC_MODEL_LEVELS = ["input", "output", "outcome", "impact"] as const;
export type LogicModelLevel = (typeof LOGIC_MODEL_LEVELS)[number];

/**
 * Assurance action lifecycle (#415). Distinct from a gate condition: a
 * condition gates the decision, an action is a named person's follow-up work
 * with a due date on the obligation register.
 */
export const ASSURANCE_ACTION_STATUSES = [
  "open",
  "in_progress",
  "done",
  "overdue",
  "cancelled",
] as const;
export type AssuranceActionStatus = (typeof ASSURANCE_ACTION_STATUSES)[number];

/** Priority of an assurance action, mirroring IPA review recommendation grading. */
export const ASSURANCE_ACTION_PRIORITIES = ["critical", "essential", "recommended"] as const;
export type AssuranceActionPriority = (typeof ASSURANCE_ACTION_PRIORITIES)[number];

/* ------------------------------------------------------------------ */
/* Project finance (Domain O) — eligibility, certification, covenants   */
/* ------------------------------------------------------------------ */

/**
 * IFI expenditure eligibility classification (#736-737). An item attached
 * to a withdrawal application is either eligible for financing, ineligible
 * (and therefore recoverable if it was ever paid), or not yet assessed.
 */
export const EXPENDITURE_ELIGIBILITY = ["eligible", "ineligible", "unassessed"] as const;
export type ExpenditureEligibility = (typeof EXPENDITURE_ELIGIBILITY)[number];

/** Why an item is ineligible — the categories a DFI audit report actually uses. */
export const INELIGIBILITY_REASONS = [
  "outside_scope",
  "outside_period",
  "prohibited_practice",
  "procurement_non_compliance",
  "insufficient_evidence",
  "taxes_and_duties",
  "already_financed",
  "other",
] as const;
export type IneligibilityReason = (typeof INELIGIBILITY_REASONS)[number];

/** Recovery of an ineligible amount already disbursed (#744). */
export const INELIGIBLE_RECOVERY_STATUSES = [
  "open",
  "recovered",
  "offset",
  "written_off",
] as const;
export type IneligibleRecoveryStatus = (typeof INELIGIBLE_RECOVERY_STATUSES)[number];

/**
 * Named covenant formulas computable from period cashflow inputs (#743).
 * `custom` keeps the manual-reading path for anything the library does not
 * express.
 */
export const COVENANT_FORMULAS = [
  "dscr",
  "llcr",
  "gearing",
  "interest_cover",
  "current_ratio",
  "debt_to_ebitda",
  "custom",
] as const;
export type CovenantFormula = (typeof COVENANT_FORMULAS)[number];

/** Named period inputs a computed covenant may reference (facility_cashflows.inputs keys). */
export const FACILITY_CASHFLOW_INPUTS = [
  "cfads",
  "debtService",
  "principalRepayment",
  "interestPaid",
  "ebitda",
  "revenue",
  "operatingCosts",
  "totalDebt",
  "totalEquity",
  "currentAssets",
  "currentLiabilities",
  "npvOfCfads",
] as const;
export type FacilityCashflowInput = (typeof FACILITY_CASHFLOW_INPUTS)[number];

/** Interest and fee accrual basis on a facility (#748-751). */
export const DAY_COUNT_CONVENTIONS = ["actual_365", "actual_360", "thirty_360"] as const;
export type DayCountConvention = (typeof DAY_COUNT_CONVENTIONS)[number];

/* ------------------------------------------------------------------ */
/* Disputes (Domain E) — regimes, boards, costs, outcomes               */
/* ------------------------------------------------------------------ */

/**
 * Statutory/contractual adjudication regimes whose timetables are encoded
 * as data in modules/disputes/regimes.ts (#322-333). Each carries its own
 * step offsets and business-day conventions.
 */
export const DISPUTE_JURISDICTIONS = [
  "uk_hgcra",
  "singapore_sopa",
  "nsw_sopa",
  "qld_boif",
  "malaysia_cipaa",
  "nz_cca",
  "fidic_daab",
  "custom",
] as const;
export type DisputeJurisdiction = (typeof DISPUTE_JURISDICTIONS)[number];

/** Role on a standing dispute board (FIDIC DAAB, NEC Dispute Avoidance Board). */
export const DISPUTE_BOARD_ROLES = ["chair", "member"] as const;
export type DisputeBoardRole = (typeof DISPUTE_BOARD_ROLES)[number];

/** What happens to a decision after it is given (#333). */
export const ENFORCEMENT_STATUSES = [
  "not_applicable",
  "awaiting_compliance",
  "complied",
  "notice_of_dissatisfaction",
  "enforcement_sought",
  "enforced",
] as const;
export type EnforcementStatus = (typeof ENFORCEMENT_STATUSES)[number];

/** Cost lines on a dispute — the cost of recovery, tracked against budget (#354). */
export const DISPUTE_COST_CATEGORIES = [
  "legal",
  "expert",
  "tribunal",
  "counsel",
  "internal",
  "other",
] as const;
export type DisputeCostCategory = (typeof DISPUTE_COST_CATEGORIES)[number];

/**
 * Outcome branch of a settlement decision tree (#351-353). Each branch
 * carries its own probability and award; the branch set must sum to 1.
 */
export const SETTLEMENT_BRANCH_KINDS = [
  "win_full",
  "win_partial",
  "lose",
  "discontinue",
] as const;
export type SettlementBranchKind = (typeof SETTLEMENT_BRANCH_KINDS)[number];

/**
 * Root-cause taxonomy for the dispute outcome database (#356-357). Chosen
 * so the analytics answer "which clause keeps costing us money" rather than
 * "who was angry".
 */
export const DISPUTE_ROOT_CAUSES = [
  "design_change",
  "late_information",
  "ground_conditions",
  "variation_valuation",
  "extension_of_time",
  "payment_default",
  "defective_work",
  "termination",
  "scope_ambiguity",
  "third_party_delay",
  "force_majeure",
  "other",
] as const;
export type DisputeRootCause = (typeof DISPUTE_ROOT_CAUSES)[number];

/** Privilege classification on a bundle item — privileged items are not produced (#340-342). */
export const BUNDLE_ITEM_PRIVILEGE = [
  "none",
  "legal_advice",
  "litigation",
  "without_prejudice",
  "commercially_confidential",
] as const;
export type BundleItemPrivilege = (typeof BUNDLE_ITEM_PRIVILEGE)[number];
