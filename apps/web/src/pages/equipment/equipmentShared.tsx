/**
 * EQUIPMENT workspace — the shared vocabulary.
 *
 * Types mirror `apps/api/src/modules/equipment/*` exactly. Nothing here
 * reshapes a server response: the API already decided what it can and cannot
 * state, and the whole value of this module is that the screen repeats that
 * decision rather than smoothing it over.
 *
 * THE THREE RULES THIS FILE ENFORCES FOR EVERY TAB
 *
 *  1. A null figure is rendered as "Not available" WITH ITS REASONS. The
 *     engine returns `{ value: null, reasons: [...] }` shapes all over this
 *     module — utilisation with no denominator, hire cost with no rate,
 *     engine hours from a counter that reset. Every one of those is a
 *     different management fact from zero, and `<FigureCell>` prints the
 *     server's own sentence instead of a dash.
 *
 *  2. MONEY IS NEVER SUMMED ACROSS CURRENCIES. Plant is hired in whatever
 *     currency the hire desk agreed. `<CurrencyRail>` prints one total per
 *     currency and says out loud that it will not add them.
 *
 *  3. AN EXPIRED STATUTORY CERTIFICATE ON ASSIGNED PLANT IS CRITICAL. That
 *     is uninsured, unlawful operation, not overdue paperwork, and
 *     `certificateTone` / `<UnlawfulOperationBanner>` make it impossible to
 *     scroll past.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, Badge, Card, CardBody, Tooltip } from "../../ui";
import { cx } from "../../ui/cx";
import type { Tone } from "../../ui/tokens";
import { IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";

/* ========================================================================== */
/* Wire types — mirrors of the API                                             */
/* ========================================================================== */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** `utilisation.ts` → UtilisationResult. */
export interface UtilisationResult {
  utilisationPercent: number | null;
  accountedHours: number;
  denominatorHours: number | null;
  basis: "available_hours" | "accounted_hours" | null;
  unproductiveHours: number;
  reasons: string[];
}

/** `utilisation.ts` → DayCostResult. */
export interface DayCostResult {
  hireCost: number | null;
  fuelCost: number | null;
  operatorCost: number | null;
  totalCost: number | null;
  totalIsComplete: boolean;
  currency: string;
  basis: { hire: string | null; operator: string | null };
  reasons: string[];
}

/** `utilisation.ts` → IdlePlantAssessment. */
export interface IdlePlantAssessment {
  equipmentId: string;
  reference: string;
  name: string;
  ownership: string;
  currency: string;
  windowStart: string;
  windowEnd: string;
  utilisationPercent: number | null;
  daysRecorded: number;
  lowDays: number;
  consecutiveLowDays: number;
  workingHours: number;
  idleHours: number;
  idleCost: number | null;
  windowCost: number | null;
  isIdleOnHire: boolean;
  idleReasons: string[];
  offHireRequestedAt: string | null;
  reasons: string[];
}

export interface IdleReport {
  from: string;
  to: string;
  days: number;
  thresholdPercent: number;
  sustainedDays: number;
  criteria: string;
  flaggedCount: number;
  idleCostByCurrency: Record<string, number>;
  currencyNote: string | null;
  items: IdlePlantAssessment[];
}

export interface EquipmentDerived {
  asOf: string;
  outOfCertificate: boolean;
  onHire: boolean;
  hireRunning: boolean;
  offHireRequestedNotCollected: boolean;
  hireOverrun: string | null;
  maintenanceOverdue: boolean;
}

export interface EquipmentRecord {
  id: string;
  companyId: string;
  projectId: string | null;
  number: number;
  reference: string;
  assetTag: string | null;
  name: string;
  description: string | null;
  category: string;
  equipmentType: string | null;
  ownership: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  registrationNumber: string | null;
  capacity: string | null;
  purchaseDate: string | null;
  purchaseCost: number | null;
  bookValue: number | null;
  internalRateAmount: number | null;
  supplierVendorId: string | null;
  hireAgreementRef: string | null;
  commitmentId: string | null;
  hireRateAmount: number | null;
  hireRateUnit: string | null;
  idleRateAmount: number | null;
  operatorRateAmount: number | null;
  currency: string;
  hireStartDate: string | null;
  hireEndDate: string | null;
  offHireRequestedAt: string | null;
  offHiredAt: string | null;
  offHireReference: string | null;
  status: string;
  condition: string;
  locationText: string | null;
  currentOperatorWorkerId: string | null;
  meterType: string;
  currentMeterReading: number | null;
  lastMeterReadingAt: string | null;
  fuelType: string;
  telematicsProvider: string | null;
  telematicsDeviceId: string | null;
  telematicsLastSeenAt: string | null;
  requiresCertification: boolean;
  nextCertificateExpiry: string | null;
  nextMaintenanceDue: string | null;
  isCritical: boolean;
  verifiedBy: string | null;
  verifiedAt: string | null;
  createdBy: string;
  derived: EquipmentDerived;
}

export interface AssignmentRef {
  equipmentId: string;
  assignmentId: string;
  status: string;
  assignedFrom: string;
  assignedTo: string | null;
}

export interface ProjectEquipmentRow extends EquipmentRecord {
  assignment: AssignmentRef | null;
}

export interface ProjectEquipmentResponse extends ListResponse<ProjectEquipmentRow> {
  asOf: string;
  outOfCertificateCount: number;
  outOfCertificateNote: string | null;
}

/** `signals.ts` → CertificateVerdict. */
export interface CertificateVerdict {
  status: "pending" | "valid" | "expiring" | "expired";
  daysToExpiry: number;
  severity: "critical" | "high" | null;
  detector:
    | "equipment_certificate_expired_in_service"
    | "equipment_certificate_expired"
    | null;
}

export interface CertificateRow {
  id: string;
  equipmentId: string;
  certificateType: string;
  certificateNumber: string | null;
  title: string | null;
  issuedByName: string | null;
  issuerAccreditation: string | null;
  issuedAt: string | null;
  validFrom: string | null;
  validTo: string;
  result: string;
  conditions: string | null;
  safeWorkingLoad: string | null;
  status: string;
  fileId: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  obligationId: string | null;
  createdBy: string;
  statutory: boolean;
  equipmentReference?: string | null;
  equipmentName?: string | null;
  inServiceProjectId?: string | null;
  verdict: CertificateVerdict;
}

export interface CertificateRegister extends ListResponse<CertificateRow> {
  asOf: string;
  summary: {
    expired: number;
    expiredInServiceStatutory: number;
    expiring: number;
    unverified: number;
  };
}

/** `maintenance.ts` → NextDueResult. */
export interface NextDueResult {
  nextDueAt: string | null;
  nextDueMeter: number | null;
  basis: "calendar" | "meter" | null;
  status: "not_scheduled" | "scheduled" | "due_soon" | "overdue";
  meterRemaining: number | null;
  daysRemaining: number | null;
  projectedDueAt: string | null;
  overdueBy: { value: number; unit: string } | null;
  reasons: string[];
}

export interface ScheduleDue extends NextDueResult {
  scheduleId: string;
  name: string;
  intervalKind: string;
  isStatutory: boolean;
}

export interface MaintenanceRow {
  id: string;
  equipmentId: string;
  name: string;
  description: string | null;
  maintenanceType: string;
  intervalKind: string;
  intervalValue: number;
  warnAheadValue: number | null;
  lastPerformedAt: string | null;
  lastPerformedMeter: number | null;
  status: string;
  providerVendorId: string | null;
  estimatedCost: number | null;
  estimatedDowntimeHours: number | null;
  currency: string;
  standardReference: string | null;
  isStatutory: boolean;
  equipmentReference: string | null;
  equipmentName: string | null;
  isCriticalPlant: boolean;
  due: NextDueResult | null;
}

export interface MaintenanceRegister {
  asOf: string;
  total: number;
  summary: {
    overdue: number;
    overdueOnCriticalPlant: number;
    dueSoon: number;
    notScheduled: number;
  };
  items: MaintenanceRow[];
}

export interface UtilisationRow {
  id: string;
  equipmentId: string;
  assignmentId: string | null;
  utilisationDate: string;
  shift: string;
  availableHours: number | null;
  workingHours: number;
  idleHours: number;
  standbyHours: number;
  downtimeHours: number;
  travelHours: number;
  utilisationPercent: number | null;
  idleReason: string | null;
  idleNote: string | null;
  downtimeReason: string | null;
  meterStart: number | null;
  meterEnd: number | null;
  fuelLitres: number | null;
  fuelCost: number | null;
  hireCost: number | null;
  operatorCost: number | null;
  totalCost: number | null;
  currency: string;
  isBillable: boolean;
  source: string;
  telematicsWorkingHours: number | null;
  varianceHours: number | null;
  notes: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  createdBy: string;
  equipmentReference?: string;
  equipmentName?: string;
  utilisation?: UtilisationResult;
  cost?: DayCostResult;
  carbon?: { tco2e: number | null; factorId: string | null; reasons: string[] };
  costCoding?: { costCodeId: string | null; budgetLineItemId: string | null; note: string | null };
}

export interface UtilisationSummaryItem {
  equipmentId: string;
  reference: string | null;
  name: string | null;
  ownership: string | null;
  days: number;
  hours: {
    availableHours: number | null;
    workingHours: number;
    idleHours: number;
    standbyHours: number;
    downtimeHours: number;
    travelHours: number;
  };
  utilisation: UtilisationResult;
  idleByReason: Record<string, number>;
  currency: string;
  cost: {
    total: number | null;
    daysPriced: number;
    daysUnpriced: number;
    complete: boolean;
    note: string | null;
  };
  verification: { verified: number; unverified: number };
}

export interface UtilisationSummary {
  from: string;
  to: string;
  days: number;
  machines: number;
  items: UtilisationSummaryItem[];
  costByCurrency: Record<string, number>;
  currencyNote: string | null;
}

/** `telematics.ts` → DayVariance. */
export interface DayVariance {
  date: string;
  manualWorkingHours: number | null;
  telematicsEngineHours: number | null;
  telematicsReasons?: string[];
  varianceHours: number | null;
  ratio: number | null;
  /**
   * `ok` is the API's word for "the two streams agree" (telematics.ts
   * VarianceClassification). The web used to call it "comparable", so every
   * agreeing day rendered a blank badge and the classification filter offered
   * a value that matched nothing.
   */
  classification:
    | "ok"
    | "unsupported_hours"
    | "under_reported"
    | "no_manual_record"
    | "no_telematics";
  reason: string;
}

export interface EquipmentReconciliation {
  equipmentId: string;
  reference: string;
  name: string;
  currency: string;
  daysCompared: number;
  daysUnsupported: number;
  daysWithoutTelematics: number;
  daysWithoutManual: number;
  manualHours: number;
  telematicsHours: number;
  varianceHours: number | null;
  ratio: number | null;
  persistent: boolean;
  valueAtRisk: number | null;
  days: DayVariance[];
  reasons: string[];
}

export interface TelematicsReport {
  periodStart?: string;
  periodEnd?: string;
  from?: string;
  to?: string;
  machines: number;
  machinesWithVariance: number;
  machinesPersistent: number;
  valueAtRiskByCurrency: Record<string, number>;
  totals: {
    manualHours: number;
    telematicsHours: number;
    varianceHours: number;
    daysCompared: number;
  };
  rows: EquipmentReconciliation[];
  method: string;
  currencyNote?: string | null;
}

export interface DeliveryRow {
  id: string;
  number: number;
  reference: string;
  deliveryNoteNumber: string | null;
  supplierVendorId: string | null;
  commitmentId: string | null;
  purchaseOrderRef: string | null;
  carrierName: string | null;
  vehicleRegistration: string | null;
  status: string;
  scheduledFor: string | null;
  arrivedAt: string | null;
  receivedAt: string | null;
  waitingMinutes: number | null;
  receivedByName: string | null;
  hasDiscrepancy: boolean;
  discrepancyKinds: string[];
  discrepancyNotes: string | null;
  lineCount: number;
  ncrId: string | null;
  invoiceMatched: boolean;
  invoiceId: string | null;
  totalValue: number | null;
  currency: string;
  verifiedBy: string | null;
  createdBy: string;
}

export interface DeliveryLine {
  id: string;
  deliveryId: string;
  materialItemId: string | null;
  position: number;
  description: string;
  unit: string | null;
  quantityExpected: number | null;
  quantityReceived: number;
  quantityAccepted: number;
  quantityRejected: number;
  discrepancyKind: string;
  discrepancyNote: string | null;
  rejectionReason: string | null;
  batchNumber: string | null;
  heatNumber: string | null;
  certificateFileIds: string[];
  unitCost: number | null;
  lineTotal: number | null;
  currency: string | null;
}

export interface DeliveryDetail extends DeliveryRow {
  lines: DeliveryLine[];
  derived: {
    discrepantLineCount: number;
    discrepancyKinds: string[];
    ncrLinked: boolean;
    ncrCandidate: string | null;
    invoiceMatchNote: string | null;
    certificateCoverage: {
      linesWithCertificates: number;
      linesWithBatchOrHeat: number;
      totalLines: number;
      note: string | null;
    };
  };
}

export interface InvoiceMatchReport {
  asOf: string;
  total: number;
  matchedCount: number;
  unmatchedCount: number;
  matchedByCurrency: Record<string, { value: number; deliveries: number; unpriced: number }>;
  unmatchedByCurrency: Record<string, { value: number; deliveries: number; unpriced: number }>;
  unmatched: Array<{
    id: string;
    reference: string;
    deliveryNoteNumber: string | null;
    supplierVendorId: string | null;
    purchaseOrderRef: string | null;
    receivedAt: string | null;
    totalValue: number | null;
    currency: string;
    hasDiscrepancy: boolean;
    ageDays: number | null;
    valueNote: string | null;
  }>;
  interpretation: string;
}

export interface MaterialRow {
  id: string;
  /** null = a COMPANY CATALOGUE item: the product as specified, with no stock */
  projectId: string | null;
  number: number;
  reference: string;
  code: string | null;
  name: string;
  category: string | null;
  unit: string;
  supplierVendorId: string | null;
  unitCost: number | null;
  currency: string;
  quantityRequired: number;
  quantityOrdered: number;
  quantityDelivered: number;
  quantityAccepted: number;
  quantityRejected: number;
  quantityInstalled: number;
  quantityWasted: number;
  quantityOnHand: number;
  quantityReserved: number;
  reorderLevel: number | null;
  isHazardous: boolean;
  isTracked: boolean;
  status: string;
  derived: {
    outstandingToOrder: number;
    outstandingToDeliver: number;
    availableToIssue: number;
    belowReorderLevel: boolean;
    wastagePercent: number | null;
    wastagePercentReason: string | null;
    rejectionPercent: number | null;
    specControlled: boolean;
    specNote: string | null;
  };
}

export interface ReplayedMovement {
  id: string;
  movementType: string;
  quantity: number;
  movedAt: string;
  balanceAfter: number | null;
  computedBalanceAfter: number;
  drift: number | null;
}

export interface StockReconciliation {
  openingBalance: number;
  computedBalance: number;
  recordedBalance: number;
  difference: number;
  reconciles: boolean;
  movements: number;
  driftedMovements: ReplayedMovement[];
  byType: Record<string, number>;
  reasons: string[];
}

export interface StockLedger {
  materialItemId: string;
  reference: string;
  name: string;
  unit: string;
  quantityOnHand: number;
  quantityReserved: number;
  availableToIssue: number;
  reconciliation: StockReconciliation;
  method: string;
  verdict: string;
}

export interface StockMovementRow {
  id: string;
  materialItemId: string;
  movementType: string;
  quantity: number;
  unit: string | null;
  movedAt: string;
  balanceAfter: number | null;
  issuedToWorkerId: string | null;
  costCodeId: string | null;
  deliveryId: string | null;
  notes?: string | null;
  verifiedBy?: string | null;
  createdBy: string;
}

export interface EquipmentSummary {
  asOf: string;
  plant: { assignedMachines: number };
  deliveries: {
    total: number;
    withDiscrepancy: number;
    discrepancyWithoutNcr: number;
    unmatchedToInvoice: number;
  };
  signals: { total: number; open: number; critical: number; byDetector: Record<string, number> };
  detectors: string[];
}

export interface EquipmentDetail extends EquipmentRecord {
  inServiceProjectId: string | null;
  certificates: CertificateRow[];
  assignments: Array<{
    id: string;
    projectId: string;
    equipmentId: string;
    status: string;
    assignedFrom: string;
    assignedTo: string | null;
    mobilisedAt: string | null;
    returnedAt: string | null;
    mobilisationCost: number | null;
    demobilisationCost: number | null;
    currency: string;
    conditionOnArrival: string | null;
    conditionOnReturn: string | null;
    damageOnReturnNote: string | null;
    approvedBy: string | null;
    requestedBy: string | null;
  }>;
  maintenance: { schedules: ScheduleDue[]; governing: ScheduleDue | null };
}

/* ========================================================================== */
/* Vocabulary                                                                  */
/* ========================================================================== */

export const EM_DASH = "—";
export const NOT_AVAILABLE = "Not available";
export const NOT_COMPARABLE = "Not comparable";

export const OWNERSHIP_LABEL: Record<string, string> = {
  owned: "Owned",
  hired: "Hired",
  leased: "Leased",
  operator_hired: "Operator-hired",
  subcontractor: "Subcontractor",
  client_supplied: "Client-supplied",
};

export const HIRED_OWNERSHIPS = new Set(["hired", "operator_hired", "leased"]);

export const CERTIFICATE_TYPE_LABEL: Record<string, string> = {
  thorough_examination: "Thorough examination",
  statutory_inspection: "Statutory inspection",
  puwer_inspection: "PUWER inspection",
  crane_test_certificate: "Crane test certificate",
  pressure_vessel: "Pressure vessel",
  electrical_pat: "Electrical PAT",
  calibration: "Calibration",
  emissions: "Emissions",
  road_worthiness: "Road worthiness",
  insurance: "Insurance",
  conformity_declaration: "Conformity declaration",
  operator_licence: "Operator licence",
  lifting_plan_approval: "Lifting plan approval",
  other: "Other",
};

export const INTERVAL_KIND_LABEL: Record<string, string> = {
  calendar_days: "Calendar days",
  calendar_months: "Calendar months",
  operating_hours: "Operating hours",
  distance: "Distance",
  cycles: "Cycles",
  condition_based: "Condition-based",
};

export const IDLE_REASON_LABEL: Record<string, string> = {
  no_work_available: "No work available",
  awaiting_materials: "Awaiting materials",
  awaiting_operator: "Awaiting operator",
  awaiting_permit: "Awaiting permit",
  awaiting_instruction: "Awaiting instruction",
  access_blocked: "Access blocked",
  weather: "Weather",
  breakdown: "Breakdown",
  planned_maintenance: "Planned maintenance",
  shift_end: "Shift end",
  standby_contractual: "Contractual standby",
  other: "Other",
};

export const DISCREPANCY_LABEL: Record<string, string> = {
  none: "None",
  short_delivery: "Short delivery",
  over_delivery: "Over delivery",
  damaged: "Damaged",
  wrong_item: "Wrong item",
  wrong_specification: "Wrong specification",
  missing_documentation: "Missing documentation",
  expired: "Expired",
  contaminated: "Contaminated",
  late: "Late",
  failed_inspection: "Failed inspection",
};

export const VARIANCE_CLASS_LABEL: Record<DayVariance["classification"], string> = {
  ok: "Comparable",
  unsupported_hours: "Unsupported hours",
  under_reported: "Under-reported",
  no_manual_record: "No plant sheet",
  no_telematics: "No telematics",
};

/** The two classifications that are ABSENCE OF EVIDENCE, not evidence. */
export const NOT_COMPARABLE_CLASSES = new Set<DayVariance["classification"]>([
  "no_manual_record",
  "no_telematics",
]);

export const EQUIPMENT_STATUS_TONE: Record<string, Tone> = {
  available: "neutral",
  in_use: "success",
  idle: "warning",
  in_transit: "info",
  under_maintenance: "warning",
  breakdown: "danger",
  quarantined: "danger",
  off_hire_requested: "info",
  off_hired: "neutral",
  disposed: "neutral",
  lost_or_stolen: "danger",
};

export function labelize(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word, index) =>
      index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word.toLowerCase(),
    )
    .join(" ");
}

/* ========================================================================== */
/* Formatting                                                                  */
/* ========================================================================== */

const currencyFormats = new Map<string, Intl.NumberFormat>();

function currencyFormat(currency: string, fractionDigits: number): Intl.NumberFormat {
  const key = `${currency}:${fractionDigits}`;
  let format = currencyFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
      currencyDisplay: "narrowSymbol",
    });
    currencyFormats.set(key, format);
  }
  return format;
}

/** Money, always with its currency. `null` is NOT rendered as zero. */
export function money(
  value: number | null | undefined,
  currency: string,
  options: { fractionDigits?: number } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_AVAILABLE;
  try {
    return currencyFormat(currency, options.fractionDigits ?? 0).format(value);
  } catch {
    return `${currency} ${value.toFixed(options.fractionDigits ?? 0)}`;
  }
}

export function hours(value: number | null | undefined, precision = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_AVAILABLE;
  return `${value.toFixed(precision)} h`;
}

export function percent(value: number | null | undefined, precision = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_AVAILABLE;
  return `${value.toFixed(precision)}%`;
}

export function quantity(value: number | null | undefined, unit: string | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_AVAILABLE;
  const digits = Number.isInteger(value) ? 0 : 2;
  return `${value.toFixed(digits)}${unit ? ` ${unit}` : ""}`;
}

export function isoDate(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  return value.slice(0, 10);
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const today = (): string => new Date().toISOString().slice(0, 10);

export function daysAgo(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  return Math.round((Date.parse(`${today()}T00:00:00Z`) - then) / 86_400_000);
}

export function shiftDays(iso: string, delta: number): string {
  const base = Date.parse(`${iso}T00:00:00Z`);
  return new Date(base + delta * 86_400_000).toISOString().slice(0, 10);
}

/* ========================================================================== */
/* Errors and refusals                                                         */
/* ========================================================================== */

interface ErrorBody {
  message?: unknown;
  details?: unknown;
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function detailsOf(err: unknown): Record<string, unknown> | null {
  const body = (err as { details?: unknown } | null)?.details as ErrorBody | undefined;
  const inner = body && typeof body === "object" ? body.details : undefined;
  return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : null;
}

const SUPPRESSED_DETAIL_KEYS = new Set(["control", "reasons"]);

/**
 * The server's refusal, kept in the server's own words. A deliberate refusal
 * (400 / 403 / 409) is the control working; it is never dressed up as a fault.
 */
export interface Refusal {
  status: number;
  deliberate: boolean;
  message: string;
  control: string | null;
  reasons: string[];
}

export function refusalFrom(err: unknown): Refusal {
  const status = Number((err as { status?: unknown } | null)?.status ?? 0);
  const details = detailsOf(err);
  const reasons: string[] = [];
  const rawReasons = details?.["reasons"];
  if (Array.isArray(rawReasons)) {
    for (const reason of rawReasons) if (typeof reason === "string") reasons.push(reason);
  }
  if (details) {
    for (const [key, value] of Object.entries(details)) {
      if (SUPPRESSED_DETAIL_KEYS.has(key)) continue;
      if (value === null || value === undefined) continue;
      if (typeof value === "object") continue;
      reasons.push(`${labelize(key)}: ${String(value)}`);
    }
  }
  const control = typeof details?.["control"] === "string" ? (details["control"] as string) : null;
  return {
    status,
    deliberate: status === 400 || status === 403 || status === 409,
    message: errorMessage(err, "The platform refused this action."),
    control,
    reasons,
  };
}

/* ========================================================================== */
/* Data loading                                                                */
/* ========================================================================== */

export interface Loadable<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * One GET, reloadable, aborting on unmount. `path === null` means "not yet".
 *
 * A failed load is never rendered as an empty result: "there is no idle plant"
 * and "we could not ask" are different statements about a project's money.
 */
export function useResource<T>(path: string | null): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (path === null) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .get<T>(path, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        setData(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(err, "This view could not be loaded."));
        setLoading(false);
      });
    return () => controller.abort();
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}

/** A mutation with its refusal held next to it, so the panel can quote it. */
export function useAction(): {
  busy: string | null;
  refusal: Refusal | null;
  clear: () => void;
  run: <T>(key: string, fn: () => Promise<T>) => Promise<T | null>;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(key);
    setRefusal(null);
    try {
      return await fn();
    } catch (err) {
      if (alive.current) setRefusal(refusalFrom(err));
      return null;
    } finally {
      if (alive.current) setBusy(null);
    }
  }, []);
  const clear = useCallback(() => setRefusal(null), []);
  return { busy, refusal, clear, run };
}

/* ========================================================================== */
/* Currency bucketing — never one cross-currency number                        */
/* ========================================================================== */

export interface CurrencyBucket {
  currency: string;
  value: number;
}

export function bucketsOf(map: Record<string, number> | undefined | null): CurrencyBucket[] {
  if (!map) return [];
  return Object.entries(map)
    .map(([currency, value]) => ({ currency, value }))
    .sort((a, b) => b.value - a.value);
}

/* ========================================================================== */
/* Honesty components                                                          */
/* ========================================================================== */

/** The server's reasons, quoted verbatim. Paraphrasing costs the reader the
 *  only thing that makes the gap actionable. */
export function ReasonList({
  reasons,
  className,
  tone = "muted",
}: {
  reasons: readonly string[];
  className?: string;
  tone?: "muted" | "danger";
}) {
  if (reasons.length === 0) return null;
  return (
    <ul className={cx("space-y-1", className)}>
      {reasons.map((reason, index) => (
        <li
          key={index}
          className={cx(
            "flex items-start gap-1.5 text-meta",
            tone === "danger" ? "text-danger-fg" : "text-content-muted",
          )}
        >
          <span aria-hidden className="mt-0.5 shrink-0 text-content-disabled">
            ▪
          </span>
          <span>{reason}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A figure the platform could not compute. Rendered as "Not available" with
 * the reasons behind it — never as a dash, and never as zero.
 */
export function FigureCell({
  value,
  reasons,
  render,
  label = NOT_AVAILABLE,
  reasonsBelow = false,
  className,
}: {
  value: number | null | undefined;
  reasons: readonly string[];
  render: (value: number) => ReactNode;
  label?: string;
  reasonsBelow?: boolean;
  className?: string;
}) {
  if (value !== null && value !== undefined && Number.isFinite(value)) {
    return <span className={cx("tabular-nums", className)}>{render(value)}</span>;
  }
  const chip = (
    <span className={cx("inline-flex items-center gap-1 text-content-muted", className)}>
      <span className="font-medium">{label}</span>
      <Badge tone="warning" size="xs">
        why
      </Badge>
    </span>
  );
  if (reasonsBelow) {
    return (
      <span className="block">
        {chip}
        <ReasonList reasons={reasons} className="mt-1.5" />
      </span>
    );
  }
  return (
    <Tooltip
      content={
        reasons.length > 0 ? (
          <span className="block max-w-xs space-y-1">
            {reasons.map((reason, index) => (
              <span key={index} className="block">
                {reason}
              </span>
            ))}
          </span>
        ) : (
          "The platform holds no inputs for this figure."
        )
      }
    >
      {chip}
    </Tooltip>
  );
}

/** A failed load, named and retryable. Never rendered as "no data". */
export function LoadError({
  message,
  onRetry,
  title = "This view could not be loaded",
}: {
  message: string;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <Alert
      tone="danger"
      title={title}
      actions={
        onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-danger-border bg-surface-raised px-2.5 py-1 text-meta font-medium text-content hover:bg-surface-hover"
          >
            Retry
          </button>
        ) : undefined
      }
    >
      {message}
    </Alert>
  );
}

/** A refusal the platform is SUPPOSED to make, framed as the rule it is. */
export function RefusalNotice({
  refusal,
  onDismiss,
  title,
}: {
  refusal: Refusal;
  onDismiss?: () => void;
  title?: string;
}) {
  return (
    <Alert
      tone={refusal.deliberate ? "warning" : "danger"}
      title={
        title ??
        (refusal.deliberate ? "The platform refused this — deliberately" : "That did not complete")
      }
      onDismiss={onDismiss}
    >
      <p>{refusal.message}</p>
      {refusal.control ? (
        <p className="mt-1 text-meta text-content-muted">
          Control: <span className="font-mono">{refusal.control}</span>
        </p>
      ) : null}
      <ReasonList reasons={refusal.reasons} className="mt-2" />
    </Alert>
  );
}

/** Section heading shared by every tab, so the workspace reads as one screen. */
export function SectionHeading({
  title,
  hint,
  actions,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("mb-3 flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 className="text-body font-semibold text-content">{title}</h2>
        {hint ? <p className="mt-0.5 max-w-3xl text-meta text-content-muted">{hint}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * Per-currency totals, side by side, with the refusal to add them stated.
 * A single cross-currency number would need an FX rate and a date, and
 * neither belongs in an operational register.
 */
export function CurrencyRail({
  buckets,
  label,
  note,
  tone = "neutral",
  format = (value, currency) => money(value, currency),
}: {
  buckets: readonly CurrencyBucket[];
  label: string;
  note?: string | null;
  tone?: Tone;
  format?: (value: number, currency: string) => string;
}) {
  if (buckets.length === 0) return null;
  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-3">
          <span className="text-label uppercase tracking-wide text-content-subtle">{label}</span>
          {buckets.map((bucket) => (
            <div key={bucket.currency} className="min-w-0">
              <div
                className={cx(
                  "text-display-xs font-semibold tabular-nums",
                  tone === "danger" ? "text-danger-fg" : "text-content",
                )}
              >
                {format(bucket.value, bucket.currency)}
              </div>
              <div className="text-2xs uppercase tracking-wide text-content-subtle">
                {bucket.currency}
              </div>
            </div>
          ))}
        </div>
        <p className="text-2xs text-content-muted">
          {note ??
            (buckets.length > 1
              ? "Reported per currency and never added. A single total across currencies would need an FX rate and a date, and this is a decision list, not a financial statement."
              : "Reported in the currency the plant is hired in. Nothing on this screen adds one currency to another.")}
        </p>
      </CardBody>
    </Card>
  );
}

/**
 * THE banner. An expired statutory certificate on plant currently assigned to
 * a project is uninsured, unlawful operation — not overdue paperwork.
 */
export function UnlawfulOperationBanner({
  count,
  asOf,
  onOpen,
}: {
  count: number;
  asOf?: string;
  onOpen?: () => void;
}) {
  if (count <= 0) return null;
  return (
    <Alert
      tone="danger"
      variant="solid"
      icon={IconWarning}
      title={`${count} machine${count === 1 ? " is" : "s are"} operating on an expired statutory certificate`}
      actions={
        onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="rounded-md bg-surface-raised px-2.5 py-1 text-meta font-medium text-content hover:bg-surface-hover"
          >
            Open the certificate register
          </button>
        ) : undefined
      }
    >
      A statutory examination that has lapsed on plant still in service is not late paperwork. The
      machine is uninsured, its operation is unlawful, and every lift it makes today is a criminal
      exposure for the person who let it run{asOf ? ` (assessed ${asOf})` : ""}. Stop the machine or
      produce a current certificate; there is no third option.
    </Alert>
  );
}

/**
 * A comparison that cannot be made, said out loud. Used wherever the engine
 * returns null — a day with no telematics, a counter that reset, a machine
 * with no hire rate. NEVER shown as a zero variance.
 */
export function NotComparable({
  reason,
  label = NOT_COMPARABLE,
}: {
  reason: string;
  label?: string;
}) {
  return (
    <Tooltip content={<span className="block max-w-xs">{reason}</span>}>
      <span className="inline-flex items-center gap-1 text-content-muted">
        <Badge tone="neutral" size="xs" variant="outline">
          {label}
        </Badge>
      </span>
    </Tooltip>
  );
}

/* ========================================================================== */
/* Tone helpers                                                                */
/* ========================================================================== */

export function certificateTone(verdict: CertificateVerdict): Tone {
  if (verdict.severity === "critical") return "danger";
  if (verdict.status === "expired") return "danger";
  if (verdict.status === "expiring") return "warning";
  if (verdict.status === "pending") return "info";
  return "success";
}

export function certificateLabel(verdict: CertificateVerdict): string {
  if (verdict.status === "expired") {
    return `Expired ${Math.abs(verdict.daysToExpiry)}d ago`;
  }
  if (verdict.status === "expiring") return `Expires in ${verdict.daysToExpiry}d`;
  if (verdict.status === "pending") return "Not yet in force";
  return "Valid";
}

export function maintenanceTone(status: NextDueResult["status"] | undefined): Tone {
  switch (status) {
    case "overdue":
      return "danger";
    case "due_soon":
      return "warning";
    case "scheduled":
      return "success";
    default:
      return "neutral";
  }
}

export const MAINTENANCE_STATUS_LABEL: Record<NextDueResult["status"], string> = {
  overdue: "Overdue",
  due_soon: "Due soon",
  scheduled: "Scheduled",
  not_scheduled: "Not scheduled",
};

export function utilisationTone(value: number | null): Tone | undefined {
  if (value === null) return undefined;
  if (value <= 20) return "danger";
  if (value <= 45) return "warning";
  return undefined;
}

/* ========================================================================== */
/* Resource hooks, one per API surface                                         */
/* ========================================================================== */

export type Scope = "project" | "company";

export interface IdleQuery {
  days: number;
  thresholdPercent: number;
  sustainedDays: number;
  includeAll: boolean;
}

export const DEFAULT_IDLE_QUERY: IdleQuery = {
  days: 14,
  thresholdPercent: 20,
  sustainedDays: 5,
  includeAll: false,
};

export function useIdleReport(
  projectId: string | undefined,
  scope: Scope,
  query: IdleQuery,
): Loadable<IdleReport> {
  const path = useMemo(() => {
    if (scope === "project" && !projectId) return null;
    const params = new URLSearchParams({
      days: String(query.days),
      thresholdPercent: String(query.thresholdPercent),
      sustainedDays: String(query.sustainedDays),
    });
    if (query.includeAll) params.set("includeAll", "true");
    const base =
      scope === "project"
        ? `/api/v1/projects/${projectId}/equipment-idle`
        : `/api/v1/companies/current/equipment-idle`;
    return `${base}?${params.toString()}`;
  }, [projectId, scope, query.days, query.thresholdPercent, query.sustainedDays, query.includeAll]);
  return useResource<IdleReport>(path);
}

export function useProjectPlant(projectId: string | undefined): Loadable<ProjectEquipmentResponse> {
  return useResource<ProjectEquipmentResponse>(
    projectId ? `/api/v1/projects/${projectId}/equipment?page=1&pageSize=200` : null,
  );
}

export function useCompanyFleet(enabled: boolean): Loadable<ListResponse<EquipmentRecord>> {
  return useResource<ListResponse<EquipmentRecord>>(
    enabled ? `/api/v1/companies/current/equipment?page=1&pageSize=200` : null,
  );
}

export function useCertificates(
  inServiceOnly: boolean,
  enabled: boolean,
): Loadable<CertificateRegister> {
  const path = useMemo(() => {
    if (!enabled) return null;
    const params = new URLSearchParams({ page: "1", pageSize: "200" });
    if (inServiceOnly) params.set("inServiceOnly", "true");
    return `/api/v1/companies/current/equipment-certificates?${params.toString()}`;
  }, [inServiceOnly, enabled]);
  return useResource<CertificateRegister>(path);
}

export function useMaintenance(enabled: boolean, criticalOnly: boolean): Loadable<MaintenanceRegister> {
  const path = useMemo(() => {
    if (!enabled) return null;
    const params = new URLSearchParams();
    if (criticalOnly) params.set("criticalOnly", "true");
    const qs = params.toString();
    return `/api/v1/companies/current/equipment-maintenance${qs ? `?${qs}` : ""}`;
  }, [enabled, criticalOnly]);
  return useResource<MaintenanceRegister>(path);
}

export function useUtilisationSummary(
  projectId: string | undefined,
  from: string,
  to: string,
  enabled: boolean,
): Loadable<UtilisationSummary> {
  return useResource<UtilisationSummary>(
    enabled && projectId
      ? `/api/v1/projects/${projectId}/equipment-utilisation/summary?from=${from}&to=${to}`
      : null,
  );
}

export function useUtilisationRows(
  projectId: string | undefined,
  from: string,
  to: string,
  enabled: boolean,
): Loadable<ListResponse<UtilisationRow>> {
  return useResource<ListResponse<UtilisationRow>>(
    enabled && projectId
      ? `/api/v1/projects/${projectId}/equipment-utilisation?page=1&pageSize=200&from=${from}&to=${to}`
      : null,
  );
}

export function useTelematics(
  projectId: string | undefined,
  days: number,
  enabled: boolean,
): Loadable<TelematicsReport> {
  return useResource<TelematicsReport>(
    enabled && projectId
      ? `/api/v1/projects/${projectId}/equipment-telematics/reconciliation?days=${days}`
      : null,
  );
}

export function useDeliveries(
  projectId: string | undefined,
  enabled: boolean,
): Loadable<ListResponse<DeliveryRow>> {
  return useResource<ListResponse<DeliveryRow>>(
    enabled && projectId
      ? `/api/v1/projects/${projectId}/material-deliveries?page=1&pageSize=200`
      : null,
  );
}

export function useInvoiceMatch(
  projectId: string | undefined,
  enabled: boolean,
): Loadable<InvoiceMatchReport> {
  return useResource<InvoiceMatchReport>(
    enabled && projectId
      ? `/api/v1/projects/${projectId}/material-deliveries/invoice-match`
      : null,
  );
}

export function useMaterials(
  projectId: string | undefined,
  enabled: boolean,
): Loadable<ListResponse<MaterialRow>> {
  return useResource<ListResponse<MaterialRow>>(
    enabled && projectId
      ? `/api/v1/projects/${projectId}/materials?page=1&pageSize=200&includeCatalogue=true`
      : null,
  );
}

export function useStockLedger(
  projectId: string | undefined,
  itemId: string | null,
): Loadable<StockLedger> {
  return useResource<StockLedger>(
    projectId && itemId ? `/api/v1/projects/${projectId}/materials/${itemId}/stock` : null,
  );
}

export function useStockMovements(
  projectId: string | undefined,
  itemId: string | null,
): Loadable<ListResponse<StockMovementRow>> {
  return useResource<ListResponse<StockMovementRow>>(
    projectId && itemId
      ? `/api/v1/projects/${projectId}/material-stock-movements?page=1&pageSize=200&materialItemId=${itemId}`
      : null,
  );
}

export function useEquipmentDetail(equipmentId: string | null): Loadable<EquipmentDetail> {
  return useResource<EquipmentDetail>(
    equipmentId ? `/api/v1/companies/current/equipment/${equipmentId}` : null,
  );
}

export function useDeliveryDetail(
  projectId: string | undefined,
  deliveryId: string | null,
): Loadable<DeliveryDetail> {
  return useResource<DeliveryDetail>(
    projectId && deliveryId
      ? `/api/v1/projects/${projectId}/material-deliveries/${deliveryId}`
      : null,
  );
}

export function useEquipmentSummary(projectId: string | undefined): Loadable<EquipmentSummary> {
  return useResource<EquipmentSummary>(
    projectId ? `/api/v1/projects/${projectId}/equipment-summary` : null,
  );
}

/* ========================================================================== */
/* Write-side reads: unmapped devices, and the projects a machine can go to    */
/* ========================================================================== */

export interface TelematicsDeviceRow {
  providerKey: string;
  deviceId: string;
  readings: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

/** Devices reporting into the company that nobody has said belong to a
 *  machine. Their readings are kept, not dropped, which is why this list is
 *  actionable rather than a log. */
export function useTelematicsDevices(enabled: boolean): Loadable<
  ListResponse<TelematicsDeviceRow> & { note?: string | null }
> {
  return useResource<ListResponse<TelematicsDeviceRow> & { note?: string | null }>(
    enabled ? "/api/v1/companies/current/telematics/devices" : null,
  );
}

export interface ProjectRef {
  id: string;
  name: string;
}

/** The company's projects, for a plant transfer. */
export function useCompanyProjects(enabled: boolean): Loadable<ListResponse<ProjectRef>> {
  return useResource<ListResponse<ProjectRef>>(
    enabled ? "/api/v1/projects?page=1&pageSize=200" : null,
  );
}

/* ========================================================================== */
/* Materials supply, telematics intelligence and fleet availability            */
/* ========================================================================== */

export type SupplyRisk =
  | "ok"
  | "order_now"
  | "order_by_date_missed"
  | "shortage"
  | "unknown";

export const SUPPLY_RISK_LABEL: Record<SupplyRisk, string> = {
  ok: "On track",
  order_now: "Order now",
  order_by_date_missed: "Order-by date missed",
  shortage: "Shortage forecast",
  unknown: "No order-by date",
};

export const SUPPLY_RISK_TONE: Record<SupplyRisk, Tone> = {
  ok: "success",
  order_now: "warning",
  order_by_date_missed: "danger",
  shortage: "danger",
  unknown: "neutral",
};

export interface SupplyItemAssessment {
  id: string;
  reference: string;
  name: string;
  unit: string;
  orderByDate: string | null;
  daysUntilOrderBy: number | null;
  shortfall: number | null;
  earliestArrivalIfOrderedToday: string | null;
  risk: SupplyRisk;
  exposure: number | null;
  currency: string;
  activityAtRisk: { id: string; name: string | null; start: string | null } | null;
  reasons: string[];
}

export interface DeliveryDelay {
  id: string;
  reference: string;
  scheduledFor: string | null;
  daysLate: number;
  status: string;
  supplierVendorId: string | null;
  itemIds: string[];
  reasons: string[];
}

export interface InventoryValuation {
  byCurrency: Array<{
    currency: string;
    onHandValue: number;
    wasteValue: number;
    items: number;
  }>;
  unpricedItems: Array<{ id: string; reference: string; quantityOnHand: number }>;
  wasteRatePercent: number | null;
  totals: {
    itemsWithStock: number;
    quantityWasted: number;
    quantityDelivered: number;
  };
  reasons: string[];
}

export interface SupplyReport {
  asOf: string;
  items: SupplyItemAssessment[];
  atRisk: SupplyItemAssessment[];
  delayedDeliveries: DeliveryDelay[];
  valuation: InventoryValuation;
  summary: {
    items: number;
    orderByDateMissed: number;
    orderNow: number;
    shortages: number;
    unknown: number;
    delayedDeliveries: number;
  };
  method: string;
}

export function useMaterialSupply(
  projectId: string | undefined,
  enabled: boolean,
): Loadable<SupplyReport> {
  return useResource<SupplyReport>(
    enabled && projectId ? `/api/v1/projects/${projectId}/materials/supply` : null,
  );
}

export interface SupplierScore {
  vendorId: string;
  vendorName: string | null;
  deliveries: number;
  onTimePercent: number | null;
  onTimeBasis: number;
  discrepancyPercent: number | null;
  rejectionPercent: number | null;
  averageWaitingMinutes: number | null;
  invoiceMatchPercent: number | null;
  invoiceVarianceByCurrency: Array<{ currency: string; amount: number }>;
  score: number | null;
  reasons: string[];
}

export function useSupplierScorecard(enabled: boolean): Loadable<{
  items: SupplierScore[];
  total: number;
  method: string;
}> {
  return useResource(enabled ? "/api/v1/companies/current/materials/supplier-scorecard" : null);
}

export interface GeofenceVerdict {
  breaches: Array<{ recordedAt: string; distanceMetres: number }>;
  maxDistanceMetres: number | null;
  spanHours: number | null;
  reasons: string[];
}

export interface FuelReconciliation {
  burnLitres: number | null;
  filledLitres: number;
  differenceLitres: number | null;
  ratio: number | null;
  unexplained: boolean;
  reasons: string[];
}

export interface TelematicsFault {
  code: string;
  description?: string | null;
  severity?: string | null;
  activeSince?: string | null;
}

export interface FaultVerdict {
  actionable: TelematicsFault[];
  worst: string | null;
  stopWork: boolean;
  reason: string | null;
}

export interface TelematicsIntelligence {
  from: string;
  to: string;
  site: { latitude: number; longitude: number } | null;
  machines: Array<{
    equipmentId: string;
    reference: string;
    name: string;
    readings: number;
    geofence: GeofenceVerdict;
    fuel: FuelReconciliation;
    faults: FaultVerdict;
  }>;
  reasons: string[];
}

export function useTelematicsIntelligence(
  projectId: string | undefined,
  days: number,
  enabled: boolean,
): Loadable<TelematicsIntelligence> {
  return useResource<TelematicsIntelligence>(
    enabled && projectId
      ? `/api/v1/projects/${projectId}/equipment-telematics/intelligence?days=${days}`
      : null,
  );
}

export interface AvailabilityRow {
  id: string;
  reference: string;
  name: string;
  category: string;
  ownership: string;
  status: string;
  currency: string;
  hireRateAmount: number | null;
  hireRateUnit: string | null;
  internalRateAmount: number | null;
  outOfCertificate: boolean;
  nextCertificateExpiry: string | null;
  clashes: Array<{
    assignmentId: string;
    projectId: string;
    status: string;
    assignedFrom: string;
    assignedTo: string | null;
  }>;
  serviceDue: Array<{ scheduleId: string; name: string; nextDueAt: string | null }>;
  caveats: string[];
}

export function useAvailability(
  from: string,
  to: string,
  enabled: boolean,
): Loadable<{ from: string; to: string; available: AvailabilityRow[]; busy: AvailabilityRow[]; note?: string }> {
  return useResource(
    enabled
      ? `/api/v1/companies/current/equipment-availability?from=${from}&to=${to}`
      : null,
  );
}

/* ========================================================================== */
/* Rental against owned                                                        */
/* ========================================================================== */

export interface OwnershipSide {
  machines: number;
  days: number;
  workingHours: number;
  paidHours: number;
  cost: number | null;
  costPerWorkingHour: number | null;
  utilisationPercent: number | null;
  uncostedDays: number;
  partiallyCostedDays: number;
}

export interface OwnershipBucket {
  category: string;
  currency: string;
  hired: OwnershipSide;
  owned: OwnershipSide;
  ratio: number | null;
  verdict: "hired_dearer" | "owned_dearer" | "comparable" | "not_comparable";
  differenceOnHiredHours: number | null;
  reasons: string[];
}

export interface OwnershipComparison {
  from: string;
  to: string;
  projectId?: string | null;
  buckets: OwnershipBucket[];
  totals: {
    machineDays: number;
    hiredDays: number;
    ownedDays: number;
    uncostedDays: number;
    bucketsCompared: number;
  };
  reasons: string[];
  method?: string;
}

export const OWNERSHIP_VERDICT_LABEL: Record<OwnershipBucket["verdict"], string> = {
  hired_dearer: "Hiring costs more",
  owned_dearer: "Our own costs more",
  comparable: "The same, within 10%",
  not_comparable: "Not comparable",
};

export const OWNERSHIP_VERDICT_TONE: Record<OwnershipBucket["verdict"], Tone> = {
  hired_dearer: "warning",
  owned_dearer: "warning",
  comparable: "neutral",
  not_comparable: "neutral",
};

export function useOwnershipComparison(
  from: string,
  to: string,
  projectId: string | undefined,
  enabled: boolean,
): Loadable<OwnershipComparison> {
  return useResource<OwnershipComparison>(
    enabled
      ? `/api/v1/companies/current/equipment-ownership-comparison?from=${from}&to=${to}` +
          (projectId ? `&projectId=${projectId}` : "")
      : null,
  );
}
