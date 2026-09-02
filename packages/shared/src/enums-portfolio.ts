/**
 * Shared enums for the owner / portfolio area (spec Vol I §7 #776–789,
 * Vol II Domain G #423–434 and Domain Z #1053–1066; platform upgrade wave).
 *
 * Two families live here and they are deliberately kept apart:
 *  · the OWNER side — how money is authorised (funding sources, multi-year
 *    appropriations, affordability envelopes) and how projects are ranked
 *    against each other (MCDA);
 *  · the COMMERCIAL STRUCTURES side — how work is bought and shared
 *    (frameworks, call-offs, term contracts, joint ventures, target-cost
 *    pain/gain, open-book verification).
 *
 * Add new `as const` string unions and their types here; never edit enums.ts
 * from a parallel work package.
 */

/* ------------------------------------------------------------------ */
/* Funding, appropriation and affordability (#427–#434)                */
/* ------------------------------------------------------------------ */

/** Where the money comes from (#427). */
export const PORTFOLIO_FUNDING_SOURCE_KINDS = [
  "internal_capital",
  "government_grant",
  "loan",
  "bond",
  "equity",
  "dfi", // development finance institution facility
  "developer_contribution",
  "insurance_proceeds",
  "operating_revenue",
  "other",
] as const;
export type PortfolioFundingSourceKind = (typeof PORTFOLIO_FUNDING_SOURCE_KINDS)[number];

/**
 * A source is only spendable once it is `available`. `committed` means the
 * provider has signed but the money has not been drawn; `exhausted` is a
 * computed end-state the sweeps set when allocations consume the facility.
 */
export const PORTFOLIO_FUNDING_SOURCE_STATUSES = [
  "proposed",
  "committed",
  "available",
  "exhausted",
  "withdrawn",
  "closed",
] as const;
export type PortfolioFundingSourceStatus = (typeof PORTFOLIO_FUNDING_SOURCE_STATUSES)[number];

/** Capital versus revenue expenditure classification (#430–#431). */
export const PORTFOLIO_EXPENDITURE_CLASSES = [
  "capital",
  "revenue",
  "mixed",
  "unclassified",
] as const;
export type PortfolioExpenditureClass = (typeof PORTFOLIO_EXPENDITURE_CLASSES)[number];

/**
 * Appropriation lifecycle (#428–#429, #433). `lapsed` and `carried_forward`
 * are the two possible fates of an unspent balance at a fiscal-year boundary;
 * which one applies is a policy on the appropriation, not a guess.
 */
export const PORTFOLIO_APPROPRIATION_STATUSES = [
  "draft",
  "approved",
  "committed",
  "spent",
  "lapsed",
  "carried_forward",
  "closed",
] as const;
export type PortfolioAppropriationStatus = (typeof PORTFOLIO_APPROPRIATION_STATUSES)[number];

/** What happens to an unspent appropriation balance at year end (#429). */
export const PORTFOLIO_CARRY_FORWARD_POLICIES = [
  "carry_forward", // balance moves into the next year automatically
  "lapse", // balance is lost at the boundary
  "request", // balance may be carried forward only with an approval
] as const;
export type PortfolioCarryForwardPolicy = (typeof PORTFOLIO_CARRY_FORWARD_POLICIES)[number];

/** Allocation of a funding source to a project (#427). */
export const PORTFOLIO_ALLOCATION_STATUSES = [
  "planned",
  "approved",
  "drawn",
  "released",
  "cancelled",
] as const;
export type PortfolioAllocationStatus = (typeof PORTFOLIO_ALLOCATION_STATUSES)[number];

/** Affordability envelope lifecycle (#426). */
export const PORTFOLIO_ENVELOPE_STATUSES = ["draft", "active", "superseded"] as const;
export type PortfolioEnvelopeStatus = (typeof PORTFOLIO_ENVELOPE_STATUSES)[number];

/**
 * A virement moves authorised money between appropriations (#433). It is
 * recorded, never silently applied: the source loses and the target gains,
 * both amounts stay on the appropriation rows.
 */
export const PORTFOLIO_VIREMENT_STATUSES = ["proposed", "approved", "rejected"] as const;
export type PortfolioVirementStatus = (typeof PORTFOLIO_VIREMENT_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Prioritisation / MCDA (#424–#425)                                   */
/* ------------------------------------------------------------------ */

export const PORTFOLIO_SCORING_MODEL_STATUSES = ["draft", "active", "archived"] as const;
export type PortfolioScoringModelStatus = (typeof PORTFOLIO_SCORING_MODEL_STATUSES)[number];

/**
 * Whether a high raw score on a criterion is good (`benefit`, e.g. strategic
 * fit) or bad (`cost`, e.g. delivery risk, whole-life cost). A `cost`
 * criterion is inverted during normalisation rather than requiring the
 * scorer to remember to enter it backwards.
 */
export const PORTFOLIO_CRITERION_DIRECTIONS = ["benefit", "cost"] as const;
export type PortfolioCriterionDirection = (typeof PORTFOLIO_CRITERION_DIRECTIONS)[number];

/**
 * How raw criterion scores become comparable. `fixed_scale` uses the
 * criterion's declared min/max; `relative` normalises against the best and
 * worst actually scored in the run — which is honest about the fact that a
 * relative rank changes when the candidate set changes.
 */
export const PORTFOLIO_NORMALISATION_METHODS = ["fixed_scale", "relative"] as const;
export type PortfolioNormalisationMethod = (typeof PORTFOLIO_NORMALISATION_METHODS)[number];

/* ------------------------------------------------------------------ */
/* Frameworks, call-offs and term contracts (#1053–#1056)              */
/* ------------------------------------------------------------------ */

export const FRAMEWORK_STATUSES = [
  "draft",
  "live",
  "suspended",
  "expired",
  "terminated",
] as const;
export type FrameworkStatus = (typeof FRAMEWORK_STATUSES)[number];

/** How work may be called off a framework lot (#1053–#1054). */
export const FRAMEWORK_AWARD_MODES = [
  "direct_award",
  "mini_competition",
  "ranked_cascade",
  "direct_or_mini", // either route permitted, per the framework rules
] as const;
export type FrameworkAwardMode = (typeof FRAMEWORK_AWARD_MODES)[number];

export const FRAMEWORK_SUPPLIER_STATUSES = ["appointed", "suspended", "removed"] as const;
export type FrameworkSupplierStatus = (typeof FRAMEWORK_SUPPLIER_STATUSES)[number];

export const MINI_COMPETITION_STATUSES = [
  "draft",
  "issued",
  "evaluating",
  "awarded",
  "cancelled",
  "abandoned",
] as const;
export type MiniCompetitionStatus = (typeof MINI_COMPETITION_STATUSES)[number];

/** The contractual route a call-off travelled (#1053, #1055–#1056). */
export const CALL_OFF_ROUTES = [
  "direct_award",
  "mini_competition",
  "term_contract",
  "measured_term",
] as const;
export type CallOffRoute = (typeof CALL_OFF_ROUTES)[number];

export const CALL_OFF_STATUSES = [
  "draft",
  "issued",
  "in_progress",
  "completed",
  "cancelled",
  "disputed",
] as const;
export type CallOffStatus = (typeof CALL_OFF_STATUSES)[number];

export const TERM_CONTRACT_STATUSES = ["draft", "live", "expired", "terminated"] as const;
export type TermContractStatus = (typeof TERM_CONTRACT_STATUSES)[number];

/** How a schedule-of-rates price is adjusted over the term (#1055). */
export const TERM_CONTRACT_ADJUSTMENT_BASES = [
  "none",
  "fixed_percent",
  "index_linked",
  "negotiated",
] as const;
export type TermContractAdjustmentBasis = (typeof TERM_CONTRACT_ADJUSTMENT_BASES)[number];

/* ------------------------------------------------------------------ */
/* Joint ventures, consortia and SPVs (#1057–#1060)                    */
/* ------------------------------------------------------------------ */

export const JV_STRUCTURES = [
  "joint_venture",
  "consortium",
  "spv",
  "alliance",
  "partnership",
] as const;
export type JvStructure = (typeof JV_STRUCTURES)[number];

export const JV_STATUSES = ["forming", "active", "winding_up", "dissolved"] as const;
export type JvStatus = (typeof JV_STATUSES)[number];

export const JV_PARTNER_ROLES = [
  "lead",
  "partner",
  "sponsor",
  "silent",
  "technical",
  "financial",
] as const;
export type JvPartnerRole = (typeof JV_PARTNER_ROLES)[number];

/** How far a partner's exposure runs — the number that matters in a default. */
export const JV_LIABILITY_BASES = ["several", "joint_and_several", "limited"] as const;
export type JvLiabilityBasis = (typeof JV_LIABILITY_BASES)[number];

/** Money moving between a partner and the venture (#1059). */
export const JV_TRANSACTION_KINDS = [
  "capital_contribution",
  "capital_call",
  "working_capital_advance",
  "distribution",
  "profit_share",
  "loss_share",
  "management_fee",
  "expense_reimbursement",
  "guarantee_call",
] as const;
export type JvTransactionKind = (typeof JV_TRANSACTION_KINDS)[number];

export const JV_TRANSACTION_STATUSES = [
  "planned",
  "called",
  "paid",
  "overdue",
  "waived",
  "cancelled",
] as const;
export type JvTransactionStatus = (typeof JV_TRANSACTION_STATUSES)[number];

/** Governance decisions under the JV deed (#1058). */
export const JV_DECISION_TYPES = [
  "reserved_matter",
  "ordinary",
  "board_resolution",
  "written_resolution",
] as const;
export type JvDecisionType = (typeof JV_DECISION_TYPES)[number];

export const JV_DECISION_OUTCOMES = [
  "approved",
  "rejected",
  "deferred",
  "not_quorate",
] as const;
export type JvDecisionOutcome = (typeof JV_DECISION_OUTCOMES)[number];

/* ------------------------------------------------------------------ */
/* Target cost, pain/gain and alliances (#1061–#1062)                  */
/* ------------------------------------------------------------------ */

export const TARGET_COST_STATUSES = [
  "draft",
  "active",
  "final_account",
  "closed",
] as const;
export type TargetCostStatus = (typeof TARGET_COST_STATUSES)[number];

/**
 * How the difference between target and outturn is shared. `banded_share`
 * is the NEC / alliance norm (share percentages step by band of variance);
 * `flat_share` is a single percentage either side; `capped_share` is a flat
 * share bounded by a maximum contractor exposure.
 */
export const PAIN_GAIN_MECHANISMS = ["banded_share", "flat_share", "capped_share"] as const;
export type PainGainMechanism = (typeof PAIN_GAIN_MECHANISMS)[number];

/* ------------------------------------------------------------------ */
/* Open-book verification and audit rights (#1063–#1066)               */
/* ------------------------------------------------------------------ */

export const OPEN_BOOK_STATUSES = [
  "planned",
  "in_progress",
  "reported",
  "disputed",
  "closed",
] as const;
export type OpenBookStatus = (typeof OPEN_BOOK_STATUSES)[number];

/**
 * Schedule of Cost Components headings (#1065). Modelled on the NEC SoCC;
 * a tenant on a different form maps its own headings onto these and records
 * the mapping on the verification.
 */
export const DEFINED_COST_COMPONENTS = [
  "people",
  "equipment",
  "plant_and_materials",
  "subcontractors",
  "charges",
  "manufacture_and_fabrication",
  "design",
  "insurance",
  "overhead_and_profit",
  "other",
] as const;
export type DefinedCostComponent = (typeof DEFINED_COST_COMPONENTS)[number];

/** The verifier's conclusion on one claimed cost item (#1065). */
export const DEFINED_COST_VERDICTS = [
  "pending",
  "verified",
  "queried",
  "partially_disallowed",
  "disallowed",
] as const;
export type DefinedCostVerdict = (typeof DEFINED_COST_VERDICTS)[number];

/** Why a cost is disallowed (#1066) — the ground, not the amount. */
export const DISALLOWED_COST_CATEGORIES = [
  "not_defined_cost",
  "not_reasonably_incurred",
  "outside_accepted_programme",
  "contractor_default",
  "correcting_defect",
  "insufficient_records",
  "plant_not_used",
  "duplicate_claim",
  "rate_not_in_sor",
  "resource_not_on_site",
  "other",
] as const;
export type DisallowedCostCategory = (typeof DISALLOWED_COST_CATEGORIES)[number];

export const DISALLOWED_COST_STATUSES = [
  "raised",
  "under_review",
  "accepted",
  "disputed",
  "withdrawn",
  "deducted",
] as const;
export type DisallowedCostStatus = (typeof DISALLOWED_COST_STATUSES)[number];

/** Execution of a contractual audit right (#1064). */
export const AUDIT_RIGHTS_STATUSES = [
  "notified",
  "scheduled",
  "in_progress",
  "obstructed",
  "completed",
  "closed",
] as const;
export type AuditRightsStatus = (typeof AUDIT_RIGHTS_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Detectors this module raises signals under                          */
/* ------------------------------------------------------------------ */

export const PORTFOLIO_SIGNAL_DETECTORS = [
  "portfolio_envelope_breach", // demand exceeds the affordability envelope (#426)
  "portfolio_appropriation_overcommitted", // allocations exceed the appropriation (#433)
  "portfolio_funding_source_overdrawn", // allocations exceed the facility (#427)
  "framework_ceiling_breach", // call-offs exceed the lot/framework ceiling (#1053)
  "framework_expiring", // framework end date approaching with live call-offs
  "jv_contribution_overdue", // a called partner contribution is late (#1059)
  "target_cost_overrun", // forecast defined cost exceeds the target (#1062)
  "open_book_verification_overdue", // a planned verification has slipped (#1063)
  "disallowed_cost_unresolved", // a disallowed cost has sat unanswered (#1066)
  "audit_rights_obstructed", // access refused or records not produced (#1064)
] as const;
export type PortfolioSignalDetector = (typeof PORTFOLIO_SIGNAL_DETECTORS)[number];
