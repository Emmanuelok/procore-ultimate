/**
 * ESTIMATING & TAKEOFF — shared vocabulary (spec Vol I §1.2, #184–208).
 *
 * The estimate is the first number anyone puts on a project, and every later
 * number — the budget, the bid, the change order — is measured against it.
 * The enums below encode the three things that make an estimate defensible
 * rather than a spreadsheet:
 *
 *   PROVENANCE   Where a quantity came from (`EstimateLineSource`): a
 *                measured takeoff, an expanded assembly, a catalogue rate, an
 *                imported sub-quote, or a person typing. A line whose source
 *                is "manual" is not wrong — it is simply not evidenced, and
 *                the register must be able to say which is which.
 *
 *   COMPOSITION  How a rate is built (`CostType` split + crew + production
 *                rate). "£42/m²" is an opinion; "0.35 crew-hours/m² at a
 *                £68/hr four-man crew plus £18.20 of material" is a position
 *                that can be argued.
 *
 *   ORDER        How markups stack (`EstimateMarkupBasis` + sequence). The
 *                difference between profit-on-cost and profit-on-cost-plus-
 *                overhead is real money, so the basis is recorded per markup
 *                and applied in an explicit order rather than assumed.
 *
 * Never edit enums.ts from here; the `estimating` tool key and the `estimate`
 * notification kind already exist there.
 */

/* ------------------------------------------------------------------ */
/* Estimates                                                           */
/* ------------------------------------------------------------------ */

/**
 * Estimate lifecycle. `superseded` is set on the parent when a new version is
 * cut, so a version chain reads as one live head plus its history; `converted`
 * records that budget lines were written from it (the conversion is the point
 * of no return, and it must be visible without opening the budget).
 */
export const ESTIMATE_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "converted",
  "superseded",
  "archived",
  "void",
] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

/** Design maturity the estimate was produced at — it bounds the accuracy claim. */
export const ESTIMATE_TYPES = [
  "conceptual",
  "schematic",
  "design_development",
  "construction_document",
  "gmp",
  "bid",
  "change_order",
  "budget_check",
  "other",
] as const;
export type EstimateType = (typeof ESTIMATE_TYPES)[number];

/**
 * Where a priced line's quantity came from. This is the provenance column the
 * whole module exists to keep honest: a takeoff-sourced quantity carries a
 * measurement that can be re-measured, a manual one carries a person.
 */
export const ESTIMATE_LINE_SOURCES = [
  "manual",
  "takeoff",
  "assembly",
  "catalogue",
  "sub_quote",
  "benchmark",
  "imported",
] as const;
export type EstimateLineSource = (typeof ESTIMATE_LINE_SOURCES)[number];

/**
 * Whether a line is in the number. `alternate` and `excluded` lines stay in
 * the estimate (deleting them destroys the reasoning) but are outside the
 * totals; `provisional` is in the total and flagged as an allowance.
 */
export const ESTIMATE_LINE_STATUSES = [
  "active",
  "provisional",
  "alternate",
  "excluded",
] as const;
export type EstimateLineStatus = (typeof ESTIMATE_LINE_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Takeoff                                                             */
/* ------------------------------------------------------------------ */

/** What a takeoff measures (#185–187). Drives which geometry is legal. */
export const TAKEOFF_MEASUREMENT_TYPES = ["linear", "area", "volume", "count"] as const;
export type TakeoffMeasurementType = (typeof TAKEOFF_MEASUREMENT_TYPES)[number];

/** The drawn shape. `points` is a scatter of marks for a count. */
export const TAKEOFF_GEOMETRY_KINDS = [
  "polyline",
  "polygon",
  "rectangle",
  "circle",
  "points",
] as const;
export type TakeoffGeometryKind = (typeof TAKEOFF_GEOMETRY_KINDS)[number];

/** Takeoff lifecycle: measured → assigned to a cost code → priced onto a line. */
export const TAKEOFF_STATUSES = ["draft", "measured", "assigned", "priced", "void"] as const;
export type TakeoffStatus = (typeof TAKEOFF_STATUSES)[number];

/**
 * Length units a sheet may be calibrated in (#188). Everything is converted to
 * metres internally and back out for display, so a project may mix a metric
 * structural set with an imperial services set without the totals lying.
 */
export const LENGTH_UNITS = ["mm", "cm", "m", "km", "in", "ft", "yd"] as const;
export type LengthUnit = (typeof LENGTH_UNITS)[number];

/** Measurement systems the workspace presents quantities in. */
export const MEASUREMENT_SYSTEMS = ["metric", "imperial"] as const;
export type MeasurementSystem = (typeof MEASUREMENT_SYSTEMS)[number];

/* ------------------------------------------------------------------ */
/* Rates, assemblies, crews                                            */
/* ------------------------------------------------------------------ */

/** Where a catalogue rate came from — its authority, and its staleness clock. */
export const CATALOGUE_ITEM_SOURCES = [
  "manual",
  "historical",
  "supplier_quote",
  "published_index",
  "benchmark",
] as const;
export type CatalogueItemSource = (typeof CATALOGUE_ITEM_SOURCES)[number];

/** Catalogue item lifecycle. `review` is set by the staleness sweep. */
export const CATALOGUE_ITEM_STATUSES = ["active", "review", "retired"] as const;
export type CatalogueItemStatus = (typeof CATALOGUE_ITEM_STATUSES)[number];

/** Assembly lifecycle (#193). */
export const ASSEMBLY_STATUSES = ["active", "draft", "retired"] as const;
export type AssemblyStatus = (typeof ASSEMBLY_STATUSES)[number];

/** Crew definition lifecycle (#197). */
export const CREW_DEFINITION_STATUSES = ["active", "retired"] as const;
export type CrewDefinitionStatus = (typeof CREW_DEFINITION_STATUSES)[number];

/**
 * How a production rate is expressed (#194). Both directions are in use in
 * the trade — bricklayers quote output per hour, M&E quote hours per unit —
 * and converting one into the other silently is how estimates acquire
 * order-of-magnitude errors.
 */
export const PRODUCTION_RATE_BASES = ["output_per_hour", "hours_per_unit"] as const;
export type ProductionRateBasis = (typeof PRODUCTION_RATE_BASES)[number];

/* ------------------------------------------------------------------ */
/* Markups                                                             */
/* ------------------------------------------------------------------ */

/** Tiered markup families (#198–199). */
export const ESTIMATE_MARKUP_KINDS = [
  "overhead",
  "profit",
  "contingency",
  "escalation",
  "general_conditions",
  "bond",
  "insurance",
  "fee",
  "tax",
  "other",
] as const;
export type EstimateMarkupKind = (typeof ESTIMATE_MARKUP_KINDS)[number];

/** How the markup amount is arrived at. */
export const ESTIMATE_MARKUP_METHODS = ["percent", "fixed", "per_unit"] as const;
export type EstimateMarkupMethod = (typeof ESTIMATE_MARKUP_METHODS)[number];

/**
 * What a percentage markup is a percentage OF:
 *  · `direct_cost`   — the priced lines only, ignoring every other markup
 *  · `cost_type`     — the priced lines of the selected cost types (#199)
 *  · `running_total` — direct cost plus every markup sequenced before it
 *  · `estimate_total`— the full estimate as at this point, i.e. the same as
 *                      running_total but explicit about intent for taxes
 */
export const ESTIMATE_MARKUP_BASES = [
  "direct_cost",
  "cost_type",
  "running_total",
  "estimate_total",
] as const;
export type EstimateMarkupBasis = (typeof ESTIMATE_MARKUP_BASES)[number];

/* ------------------------------------------------------------------ */
/* Sub-quotes and proposals                                            */
/* ------------------------------------------------------------------ */

/** Sub-quote lifecycle (#202–203). `expired` is set by the validity sweep. */
export const SUB_QUOTE_STATUSES = [
  "received",
  "under_review",
  "levelled",
  "accepted",
  "rejected",
  "expired",
  "withdrawn",
] as const;
export type SubQuoteStatus = (typeof SUB_QUOTE_STATUSES)[number];

/** How a sub-quote entered the estimate — manual entry or the bid module. */
export const SUB_QUOTE_SOURCES = ["manual", "bid_submission", "csv", "email"] as const;
export type SubQuoteSource = (typeof SUB_QUOTE_SOURCES)[number];

/** Proposal lifecycle (#205). */
export const ESTIMATE_PROPOSAL_STATUSES = [
  "draft",
  "issued",
  "accepted",
  "declined",
  "superseded",
] as const;
export type EstimateProposalStatus = (typeof ESTIMATE_PROPOSAL_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Comparison and assurance                                            */
/* ------------------------------------------------------------------ */

/** How one line differs between two estimate versions (#201). */
export const ESTIMATE_COMPARISON_CHANGES = [
  "added",
  "removed",
  "quantity",
  "rate",
  "quantity_and_rate",
  "scope",
  "unchanged",
] as const;
export type EstimateComparisonChange = (typeof ESTIMATE_COMPARISON_CHANGES)[number];

/**
 * Detectors this module contributes to the assurance signal register. Each is
 * raised at most once per condition (fingerprinted) and closed when the
 * condition clears.
 */
export const ESTIMATING_DETECTORS = [
  /** priced lines resting on catalogue rates older than the staleness window */
  "estimate_stale_rates",
  /** approved estimate never converted to a budget */
  "estimate_unconverted",
  /** an accepted or live sub-quote whose validity runs out shortly */
  "sub_quote_expiring",
  /** validity already gone; the price is no longer a price */
  "sub_quote_expired",
  /** a measured takeoff nobody ever priced onto a line */
  "takeoff_unpriced",
  /** one bidder's rate is a long way from the pack on the same scope row */
  "quote_outlier",
] as const;
export type EstimatingDetector = (typeof ESTIMATING_DETECTORS)[number];
