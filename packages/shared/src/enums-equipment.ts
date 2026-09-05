/**
 * Shared enums for the equipment / timecards / workforce area (WP-EQUIP).
 *
 * Everything here is a code-resident vocabulary that both the API and the web
 * workspace read. Wage and working-time limits are NOT in this file: they are
 * a jurisdiction library with citations (apps/api/src/modules/timecards/
 * jurisdictions.ts), because a limit without the instrument it comes from is
 * an opinion.
 */

/* ------------------------------------------------------------------ */
/* Worker voice (#689-691)                                             */
/* ------------------------------------------------------------------ */

/** What a worker is reporting. Drives severity and the risk indicator. */
export const WORKER_GRIEVANCE_CATEGORIES = [
  "wages_unpaid",
  "wages_underpaid",
  "excessive_hours",
  "no_rest_day",
  "recruitment_fee",
  "document_retention",
  "accommodation",
  "food_water",
  "health_safety",
  "harassment",
  "discrimination",
  "forced_labour",
  "child_labour",
  "freedom_of_association",
  "contract_substitution",
  "other",
] as const;
export type WorkerGrievanceCategory = (typeof WORKER_GRIEVANCE_CATEGORIES)[number];

export const WORKER_GRIEVANCE_STATUSES = [
  "received",
  "acknowledged",
  "investigating",
  "escalated",
  "resolved",
  "closed_no_action",
  "withdrawn",
] as const;
export type WorkerGrievanceStatus = (typeof WORKER_GRIEVANCE_STATUSES)[number];

export const WORKER_GRIEVANCE_UPDATE_KINDS = [
  "acknowledgement",
  "response",
  "note",
  "escalation",
  "outcome",
] as const;
export type WorkerGrievanceUpdateKind = (typeof WORKER_GRIEVANCE_UPDATE_KINDS)[number];

/* ------------------------------------------------------------------ */
/* Labour compliance detectors (Domain M #678-682)                     */
/* ------------------------------------------------------------------ */

/**
 * Working-time and wage detectors. Each is keyed idempotently on
 * (detector, workerId, period) so a re-run of the same window never
 * accuses the same person twice.
 */
export const LABOUR_COMPLIANCE_DETECTORS = [
  "labour_no_rest_day",
  "labour_excessive_weekly_hours",
  "labour_excessive_daily_hours",
  "labour_wage_below_minimum",
  "labour_wage_paid_late",
  "labour_wage_unpaid",
  "labour_excessive_deductions",
  "labour_recruitment_fee_deduction",
  "labour_hours_paid_never_approved",
  "labour_approved_never_paid",
  "labour_pay_rate_below_crew_rate",
  "labour_productivity_deviation",
] as const;
export type LabourComplianceDetector = (typeof LABOUR_COMPLIANCE_DETECTORS)[number];

/* ------------------------------------------------------------------ */
/* Payroll export (#615, certified payroll)                            */
/* ------------------------------------------------------------------ */

export const PAYROLL_EXPORT_FORMATS = [
  /** neutral column-per-bucket CSV, the one every system can read */
  "generic_csv",
  /** one row per worker per day, for systems that price the day themselves */
  "daily_csv",
  /** US Department of Labor WH-347 style certified payroll */
  "certified_payroll",
  /** JSON, for an integration that wants the provenance too */
  "json",
] as const;
export type PayrollExportFormat = (typeof PAYROLL_EXPORT_FORMATS)[number];

/* ------------------------------------------------------------------ */
/* Equipment additions                                                 */
/* ------------------------------------------------------------------ */

/** Telematics-derived detectors added on top of the hours reconciliation. */
export const TELEMATICS_DETECTORS = [
  "equipment_off_site_use",
  "equipment_fuel_unaccounted",
  "equipment_fault_active",
] as const;
export type TelematicsDetector = (typeof TELEMATICS_DETECTORS)[number];

/** Materials supply-chain detectors (#719-720, #918-919). */
export const MATERIAL_SUPPLY_DETECTORS = [
  "material_order_by_date_missed",
  "material_shortage_forecast",
  "material_delivery_delayed",
] as const;
export type MaterialSupplyDetector = (typeof MATERIAL_SUPPLY_DETECTORS)[number];

/** How an assignment ended, when it did not end by demobilisation. */
export const ASSIGNMENT_CANCEL_REASONS = [
  "hire_not_required",
  "machine_unavailable",
  "raised_in_error",
  "transferred",
  "off_hired",
] as const;
export type AssignmentCancelReason = (typeof ASSIGNMENT_CANCEL_REASONS)[number];
